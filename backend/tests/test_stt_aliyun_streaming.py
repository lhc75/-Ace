"""面试官实时流式识别（AliyunInterviewerStream）单元测试。

用 FakeWebSocket 模拟阿里千问的双工协议，覆盖：建连与音频上行、中间结果节流、
定稿顺序（先补发再清行再发布）、心跳/错误任务号/畸形事件忽略、任务失败分类、
finish 超时不挂死、发送队列丢最旧、abort 后不再回调、finish 幂等。
"""

from __future__ import annotations

import json
from pathlib import Path
import queue
import sys
import threading
import time
from types import SimpleNamespace

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.stt import aliyun_streaming
from services.stt.aliyun import (
    AliyunSTTAuthError,
    AliyunSTTConnectionError,
    AliyunSTTProviderError,
    AliyunSTTTimeoutError,
)
from services.stt.aliyun_streaming import AliyunInterviewerStream


def _sentence(sentence_id: int, text: str, final: bool = True, **extra):
    return {
        "header": {"event": "result-generated"},
        "payload": {"output": {"sentence": {
            "sentence_id": sentence_id, "text": text, "sentence_end": final, **extra,
        }}},
    }


def _failed(code: str, detail: str):
    return {"header": {"event": "task-failed", "error_code": code, "error_message": detail}}


FINISHED = {"header": {"event": "task-finished"}}


class FakeWebSocket:
    """按需回放事件的假 WebSocket。

    ``on_binary`` 在第一块音频后回放（模拟边说边出字），
    ``on_finish`` 在 finish-task 后回放（模拟收尾定稿），
    ``startup`` 在 run-task 后回放（默认直接回 task-started）。
    """

    def __init__(self, on_finish=(), on_binary=(), startup=None):
        self.responses = queue.Queue()
        self.on_finish = list(on_finish)
        self.on_binary = list(on_binary)
        self.startup = startup
        self.sent = []
        self.binary_count = 0
        self.timeout = 0.05
        self.started = False
        self.closed = False
        self.task_id = ""

    def emit(self, message):
        if isinstance(message, dict):
            message = {**message, "header": {"task_id": self.task_id, **message.get("header", {})}}
            message = json.dumps(message)
        self.responses.put(message)

    def send(self, raw):
        message = json.loads(raw)
        self.sent.append(message)
        action = message["header"]["action"]
        if action == "run-task":
            self.task_id = message["header"]["task_id"]
            if self.startup is None:
                self.emit({"header": {"event": "task-started"}})
            else:
                for event in self.startup:
                    self.emit(event)
        elif action == "finish-task":
            for event in self.on_finish:
                self.emit(event)

    def send_binary(self, pcm):
        assert self.started, "Audio sent before task-started was received"
        self.binary_count += 1
        if self.binary_count == 1:
            for event in self.on_binary:
                self.emit(event)

    def settimeout(self, seconds):
        self.timeout = seconds

    def recv(self):
        try:
            raw = self.responses.get(timeout=self.timeout)
        except queue.Empty:
            raise TimeoutError("timed out") from None
        if isinstance(raw, Exception):
            raise raw
        if raw:
            try:
                message = json.loads(raw)
            except ValueError:
                message = {}
            if isinstance(message, dict) and message.get("header", {}).get("event") == "task-started":
                self.started = True
        return raw

    def abort(self):
        self.closed = True
        self.responses.put("")

    def close(self, **_kwargs):
        self.closed = True


def _patch_ws(monkeypatch, ws):
    monkeypatch.setattr(
        aliyun_streaming, "websocket",
        SimpleNamespace(create_connection=lambda *_args, **_kwargs: ws),
    )


def _collect():
    return {"interim": [], "final": [], "state": []}


def _make_stream(events, **kwargs):
    kwargs.setdefault("api_key", "key")
    kwargs.setdefault("model", "qwen-audio-3.1-asr-flash-streaming")
    return AliyunInterviewerStream(
        on_interim=lambda sid, text: events["interim"].append((sid, text)),
        on_final=lambda sid, text: events["final"].append((sid, text)),
        on_state_change=lambda state: events["state"].append(state),
        **kwargs,
    )


def _wait_for(predicate, timeout=2.0, interval=0.01):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def test_start_sends_run_task_and_feed_uploads_audio(monkeypatch):
    ws = FakeWebSocket()
    _patch_ws(monkeypatch, ws)
    events = _collect()
    stream = _make_stream(events)
    stream.start()
    assert events["state"] == ["started"]
    assert stream.healthy
    assert ws.sent[0]["header"]["action"] == "run-task"
    assert ws.sent[0]["header"]["streaming"] == "duplex"
    assert ws.sent[0]["payload"]["parameters"] == {"format": "pcm", "sample_rate": 16000}
    stream.feed(b"\x01\x02")
    assert _wait_for(lambda: ws.binary_count == 1)
    stream.finish(drain_timeout_sec=0.5)
    assert ws.closed
    finish_tasks = [m for m in ws.sent if isinstance(m, dict) and m["header"]["action"] == "finish-task"]
    assert len(finish_tasks) == 1
    assert not any(t.name.startswith("aliyun-stream-") for t in threading.enumerate())


def test_run_task_includes_max_sentence_silence_when_configured(monkeypatch):
    ws = FakeWebSocket()
    _patch_ws(monkeypatch, ws)
    events = _collect()
    stream = _make_stream(events, max_sentence_silence_ms=600)
    stream.start()
    assert ws.sent[0]["payload"]["parameters"] == {
        "format": "pcm",
        "sample_rate": 16000,
        "max_sentence_silence": 600,
    }
    stream.finish(drain_timeout_sec=0.5)


def test_interim_events_are_throttled_and_finals_clear_then_publish(monkeypatch):
    ws = FakeWebSocket(on_finish=[
        _sentence(1, "你", final=False),
        _sentence(1, "你好", final=False),
        _sentence(1, "你好，我们", final=False),
        _sentence(1, "你好，我们开始吧", final=False),
        _sentence(1, "你好，我们开始吧。"),
        FINISHED,
    ])
    _patch_ws(monkeypatch, ws)
    events = _collect()
    stream = _make_stream(events)
    stream.start()
    stream.feed(b"\x00" * 3200)
    stream.finish(drain_timeout_sec=2.0)
    # Throttle collapses the interim burst to a leading emit, but the latest
    # text is flushed before the clear.
    assert events["interim"][0] == (1, "你")
    assert (1, "你好，我们开始吧") in events["interim"]
    assert events["interim"][-1] == (1, "")
    assert events["final"] == [(1, "你好，我们开始吧。")]
    assert ws.closed


def test_throttle_window_allows_subsequent_updates(monkeypatch):
    ws = FakeWebSocket(on_finish=[
        _sentence(1, "你", final=False),
        FINISHED,
    ])
    _patch_ws(monkeypatch, ws)
    events = _collect()
    stream = _make_stream(events)
    monkeypatch.setattr(AliyunInterviewerStream, "INTERIM_THROTTLE_MS", 1)
    stream.start()
    stream._handle_sentence({"output": {"sentence": {"sentence_id": 1, "text": "你", "sentence_end": False}}})
    time.sleep(0.005)
    stream._handle_sentence({"output": {"sentence": {"sentence_id": 1, "text": "你好", "sentence_end": False}}})
    assert events["interim"] == [(1, "你"), (1, "你好")]
    stream.finish(drain_timeout_sec=1.0)


def test_heartbeat_and_wrong_task_and_malformed_events_are_ignored(monkeypatch):
    wrong_task = _sentence(2, "别的任务", final=False)
    wrong_task["header"]["task_id"] = "another-task"
    no_id = {"header": {"event": "result-generated"}, "payload": {"output": {"sentence": {"text": "无 id", "sentence_end": False}}}}
    ws = FakeWebSocket(on_finish=[
        _sentence(0, "heartbeat", final=False, heartbeat=True),
        no_id,
        _sentence(1, "有效", final=False),
        FINISHED,
    ])
    _patch_ws(monkeypatch, ws)
    events = _collect()
    stream = _make_stream(events)
    stream.start()
    stream.feed(b"\x00" * 3200)
    stream.finish(drain_timeout_sec=2.0)
    assert events["interim"] == [(1, "有效")]
    assert events["final"] == []
    # Wrong-task events are dropped inside _receive before sentence handling.
    stream._handle_sentence(wrong_task["payload"])
    assert events["interim"] == [(1, "有效")]


def test_task_failed_marks_unhealthy_and_reports_state(monkeypatch):
    ws = FakeWebSocket(on_binary=[_failed("InvalidParameter", "bad model")])
    _patch_ws(monkeypatch, ws)
    events = _collect()
    stream = _make_stream(events)
    stream.start()
    stream.feed(b"\x00" * 3200)
    assert _wait_for(lambda: not stream.healthy)
    assert isinstance(stream.failure, AliyunSTTProviderError)
    assert _wait_for(lambda: events["state"] == ["started", "failed:AliyunSTTProviderError"])
    stream.abort()
    assert ws.closed


def test_auth_task_failed_classified_as_auth_error(monkeypatch):
    ws = FakeWebSocket(on_binary=[_failed("InvalidApiKey", "bad key")])
    _patch_ws(monkeypatch, ws)
    events = _collect()
    stream = _make_stream(events)
    stream.start()
    stream.feed(b"\x00" * 3200)
    assert _wait_for(lambda: not stream.healthy)
    assert isinstance(stream.failure, AliyunSTTAuthError)
    stream.abort()


def test_task_failed_with_timeout_message_is_terminal_not_poll_miss(monkeypatch):
    """错误详情带 "timeout" 的 task-failed 必须进终态；若被当作 recv 轮空吞掉，
    流会一直 healthy，面试官转写静默消失（回归）。"""
    ws = FakeWebSocket(on_binary=[_failed("Throttling", "request timeout, please retry")])
    _patch_ws(monkeypatch, ws)
    events = _collect()
    stream = _make_stream(events)
    stream.start()
    stream.feed(b"\x00" * 3200)
    assert _wait_for(lambda: not stream.healthy)
    assert isinstance(stream.failure, AliyunSTTProviderError)
    stream.abort()


def test_connection_drop_marks_unhealthy(monkeypatch):
    ws = FakeWebSocket(on_binary=[""])
    _patch_ws(monkeypatch, ws)
    events = _collect()
    stream = _make_stream(events)
    stream.start()
    stream.feed(b"\x00" * 3200)
    assert _wait_for(lambda: not stream.healthy)
    assert isinstance(stream.failure, AliyunSTTConnectionError)
    stream.abort()


def test_start_failures_close_connection_and_raise(monkeypatch):
    ws = FakeWebSocket(startup=[])
    _patch_ws(monkeypatch, ws)
    monkeypatch.setattr(AliyunInterviewerStream, "START_TIMEOUT_SEC", 0.02)
    stream = _make_stream(_collect())
    with pytest.raises(AliyunSTTTimeoutError):
        stream.start()
    assert ws.closed
    assert not any(t.name.startswith("aliyun-stream-") for t in threading.enumerate())

    ws2 = FakeWebSocket(startup=[_failed("InvalidApiKey", "rejected secret-key")])
    _patch_ws(monkeypatch, ws2)
    stream2 = _make_stream(_collect(), api_key="secret-key")
    with pytest.raises(AliyunSTTAuthError) as error:
        stream2.start()
    assert "secret-key" not in str(error.value)
    assert ws2.closed


def test_finish_timeout_does_not_hang(monkeypatch):
    ws = FakeWebSocket()  # never emits task-finished
    _patch_ws(monkeypatch, ws)
    events = _collect()
    stream = _make_stream(events)
    stream.start()
    started = time.monotonic()
    stream.finish(drain_timeout_sec=0.05)
    assert time.monotonic() - started < 5.0
    assert ws.closed
    assert events["state"][-1] == "closed"
    assert not any(t.name.startswith("aliyun-stream-") for t in threading.enumerate())


def test_feed_queue_full_drops_oldest(monkeypatch):
    ws = FakeWebSocket()
    _patch_ws(monkeypatch, ws)
    events = _collect()
    stream = _make_stream(events)
    stream.start()
    # Park the sender inside send_binary so the queue stays full.
    release = threading.Event()
    original_send_binary = ws.send_binary

    def parked_send_binary(pcm):
        release.wait(2)
        return original_send_binary(pcm)

    ws.send_binary = parked_send_binary
    try:
        for index in range(AliyunInterviewerStream.SEND_QUEUE_MAX + 20):
            stream.feed(bytes([index % 256]) * 4)
        assert stream.dropped_chunks >= 10
        assert stream._send_q.qsize() <= AliyunInterviewerStream.SEND_QUEUE_MAX
    finally:
        release.set()
        stream.finish(drain_timeout_sec=0.5)


def test_feed_after_finish_is_ignored_and_abort_suppresses_callbacks(monkeypatch):
    ws = FakeWebSocket()
    _patch_ws(monkeypatch, ws)
    events = _collect()
    stream = _make_stream(events)
    stream.start()
    stream.abort()
    stream.feed(b"\x00" * 3200)
    stream._handle_sentence({"output": {"sentence": {"sentence_id": 1, "text": "迟到", "sentence_end": False}}})
    stream._handle_sentence({"output": {"sentence": {"sentence_id": 1, "text": "迟到。", "sentence_end": True}}})
    assert ws.binary_count == 0
    assert events["interim"] == []
    assert events["final"] == []
    assert not any(t.name.startswith("aliyun-stream-") for t in threading.enumerate())


def test_finish_is_idempotent(monkeypatch):
    ws = FakeWebSocket()
    _patch_ws(monkeypatch, ws)
    events = _collect()
    stream = _make_stream(events)
    stream.start()
    stream.finish(drain_timeout_sec=0.05)
    stream.finish(drain_timeout_sec=0.05)
    finish_tasks = [m for m in ws.sent if isinstance(m, dict) and m["header"]["action"] == "finish-task"]
    assert len(finish_tasks) == 1
    assert events["state"].count("closed") == 1
