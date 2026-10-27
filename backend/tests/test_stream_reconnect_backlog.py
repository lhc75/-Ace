"""断线重连音频回补缓冲 + 死流未发音频回收的单元测试。

覆盖 plan 的核心承诺：断线窗口内采集的音频不丢失，重连成功后按序补发；
死流发送队列里未发出的块回收后排在最前；追平限速不打爆流内部发送队列。
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

pipeline = importlib.import_module("api.assist.pipeline")
from core.config import AppConfig  # noqa: E402
from services.stt.aliyun_streaming import AliyunInterviewerStream  # noqa: E402


def _pcm(tag: int, size: int = 3200) -> bytes:
    """一块可辨识顺序的 100ms PCM。"""
    return tag.to_bytes(2, "little") * (size // 2)


class _FakeStream:
    """记录收到的字节序的假流；healthy 可在外部翻掉模拟断流。"""

    def __init__(self):
        self.healthy = True
        self.received: list[bytes] = []
        self.fail_feed = False

    def feed(self, pcm: bytes) -> bool:
        if not self.healthy or self.fail_feed:
            return False
        self.received.append(pcm)
        return True


# ---------------------------------------------------------------------------
# _InterviewerStreamBacklog
# ---------------------------------------------------------------------------

def test_backlog_disabled_when_config_zero():
    assert pipeline._new_stream_backlog(AppConfig(assist_stream_reconnect_buffer_sec=0)) is None
    backlog = pipeline._new_stream_backlog(AppConfig(assist_stream_reconnect_buffer_sec=30.0))
    assert backlog is not None


def test_reconnect_window_audio_is_replayed_in_order():
    """断线窗口只进不出；重连成功后按原序追平，一块不丢。"""
    backlog = pipeline._InterviewerStreamBacklog(max_bytes=10 * 3200)
    stream = _FakeStream()

    # 正常期：3 块入队即泵出
    live = [_pcm(i) for i in range(3)]
    backlog.append_many(live)
    assert backlog.pump(stream, max_chunks=len(live) + 8) == 3
    assert len(backlog) == 0

    # 断流窗口：feed 失败，块留在缓冲里
    stream.healthy = False
    window = [_pcm(100 + i) for i in range(5)]
    backlog.append_many(window)
    assert backlog.pump(stream, max_chunks=99) == 0
    assert len(backlog) == 5

    # 重连成功：按序补发，先窗口后新块
    new_stream = _FakeStream()
    pumped = backlog.pump(new_stream, max_chunks=1 + 8)
    assert pumped == 5
    assert new_stream.received == window  # 顺序完整
    assert len(backlog) == 0


def test_backlog_overflow_drops_oldest_and_counts():
    backlog = pipeline._InterviewerStreamBacklog(max_bytes=3 * 3200)
    backlog.append_many([_pcm(i) for i in range(5)])
    assert len(backlog) == 3
    assert backlog.dropped_chunks == 2
    assert backlog.dropped_bytes == 2 * 3200
    stream = _FakeStream()
    backlog.pump(stream, max_chunks=99)
    assert stream.received == [_pcm(2), _pcm(3), _pcm(4)]  # 最旧的 0/1 被丢


def test_prepend_many_keeps_unsent_ahead_of_window_audio():
    backlog = pipeline._InterviewerStreamBacklog(max_bytes=10 * 3200)
    backlog.append_many([_pcm(10), _pcm(11)])  # 断线窗口缓冲
    backlog.prepend_many([_pcm(1), _pcm(2)])   # 死流退还的未发块（更老）
    stream = _FakeStream()
    backlog.pump(stream, max_chunks=99)
    assert stream.received == [_pcm(1), _pcm(2), _pcm(10), _pcm(11)]


def test_pump_respects_catchup_limit():
    """限速：每轮最多补发 max_chunks 块，防止打爆流内部 50 块发送队列。"""
    backlog = pipeline._InterviewerStreamBacklog(max_bytes=100 * 3200)
    backlog.append_many([_pcm(i) for i in range(50)])
    stream = _FakeStream()
    assert backlog.pump(stream, max_chunks=9) == 9  # 1 实时 + 8 追平
    assert len(backlog) == 41


def test_pump_stops_when_feed_fails_midway():
    backlog = pipeline._InterviewerStreamBacklog(max_bytes=10 * 3200)
    backlog.append_many([_pcm(i) for i in range(4)])
    stream = _FakeStream()
    stream.fail_feed = True
    assert backlog.pump(stream, max_chunks=99) == 0
    assert len(backlog) == 4  # 喂不进去的块留在缓冲里


def test_clear_drops_pending_audio():
    backlog = pipeline._InterviewerStreamBacklog(max_bytes=10 * 3200)
    backlog.append_many([_pcm(1), _pcm(2)])
    backlog.clear()
    assert len(backlog) == 0
    assert backlog.pending_bytes == 0


# ---------------------------------------------------------------------------
# AliyunInterviewerStream.feed / drain_unsent
# ---------------------------------------------------------------------------

def _make_stream() -> AliyunInterviewerStream:
    return AliyunInterviewerStream(
        api_key="k", model="m",
        on_interim=lambda sid, text: None,
        on_final=lambda sid, text: None,
        on_state_change=lambda state: None,
    )


def test_feed_returns_false_when_not_healthy():
    stream = _make_stream()
    assert stream.feed(_pcm(1)) is False       # 未 start，不吞音频
    assert len(stream.drain_unsent()) == 0

    stream._started.set()                       # 白盒：模拟已启动
    assert stream.feed(_pcm(1)) is True
    stream._finishing.set()
    assert stream.feed(_pcm(2)) is False        # 收尾中拒收
    assert stream.feed(b"") is False            # 空块拒收


def test_drain_unsent_returns_fifo_and_skips_sentinel():
    stream = _make_stream()
    stream._started.set()
    stream.feed(_pcm(1))
    stream.feed(_pcm(2))
    stream._send_q.put_nowait(None)             # finish 哨兵
    stream.feed(_pcm(3))
    unsent = stream.drain_unsent()
    assert unsent == [_pcm(1), _pcm(2), _pcm(3)]  # FIFO，哨兵被跳过
    assert stream.drain_unsent() == []            # 取空后幂等


# ---------------------------------------------------------------------------
# vad_model 透传（run-task 线路报文）
# ---------------------------------------------------------------------------

class _FakeWs:
    def __init__(self):
        self.sent: list[str] = []

    def send(self, data):
        self.sent.append(data)

    def settimeout(self, _t):
        pass

    def recv(self):
        task_id = json.loads(self.sent[0])["header"]["task_id"]
        return json.dumps({"header": {"task_id": task_id, "event": "task-started"}})

    def ping(self):
        pass

    def abort(self):
        pass

    def close(self, timeout=1):
        pass


@pytest.mark.parametrize("vad_model,expected", [("near_meeting_16k", "near_meeting_16k"), ("", None)])
def test_vad_model_in_run_task_parameters(monkeypatch, vad_model, expected):
    fake_ws = _FakeWs()
    monkeypatch.setattr(
        "services.stt.aliyun_streaming.websocket.create_connection",
        lambda *args, **kwargs: fake_ws,
    )
    stream = AliyunInterviewerStream(
        api_key="k", model="qwen-audio-3.1-asr-flash-streaming", vad_model=vad_model,
        on_interim=lambda sid, text: None,
        on_final=lambda sid, text: None,
        on_state_change=lambda state: None,
    )
    stream.start()
    try:
        params = json.loads(fake_ws.sent[0])["payload"]["parameters"]
        if expected is None:
            assert "vad_model" not in params
        else:
            assert params["vad_model"] == expected
    finally:
        stream.abort()
