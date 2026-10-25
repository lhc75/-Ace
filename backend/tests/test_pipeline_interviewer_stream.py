"""流水线里面试官实时流式识别的接线测试。

覆盖：中间结果广播结构与过期代次丢弃、定稿走完整发布链路（含最小字数门槛）、
流式期间跳过逐段入队、建流失败降级广播、收尾时清空进行中行。
"""

from __future__ import annotations

import importlib
import sys
import time
from pathlib import Path

import numpy as np
import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

pipeline = importlib.import_module("api.assist.pipeline")
from core.config import AppConfig
from services.stt.aliyun import AliyunSTTAuthError


@pytest.fixture
def broadcast_spy(monkeypatch):
    events = []
    monkeypatch.setattr(pipeline, "broadcast", events.append)
    return events


@pytest.fixture
def current_generation(monkeypatch):
    generation = pipeline._capture_recording_generation()
    monkeypatch.setattr(pipeline, "_recording_generation_is_current", lambda gen: gen == generation)
    return generation


class _Session:
    capture_is_loopback = True


def test_on_stream_interim_broadcasts_schema_and_skips_stale_generation(broadcast_spy, current_generation):
    pipeline._on_stream_interim(current_generation, 3, "你好")
    assert broadcast_spy == [{"type": "transcription_interim", "text": "你好", "sentence_id": 3}]
    pipeline._on_stream_interim(current_generation + 1, 3, "过期")
    assert len(broadcast_spy) == 1


def test_on_stream_final_clears_interim_and_publishes_immediately(monkeypatch, broadcast_spy, current_generation):
    published = []
    merged = []
    monkeypatch.setattr(pipeline, "_publish_stream_fragment", lambda *args: published.append(args))
    monkeypatch.setattr(pipeline, "_append_transcription_fragment", lambda *args: merged.append(args))
    cfg = AppConfig()
    monkeypatch.setattr(pipeline, "get_config", lambda: cfg)
    session = _Session()
    pipeline._on_stream_final(current_generation, session, 1, "请介绍一下 Redis 的持久化机制")
    assert broadcast_spy == [{"type": "transcription_interim", "text": "", "sentence_id": 1}]
    assert len(published) == 1
    assert merged == []  # 流式定稿跳过合并缓冲，立即发布
    args = published[0]
    assert args[0] is cfg and args[1] is session
    assert "Redis" in args[2]

    pipeline._on_stream_final(current_generation, session, 2, "嗯")
    assert len(published) == 1  # below transcription_min_sig_chars → dropped

    pipeline._on_stream_final(current_generation + 1, session, 3, "过期的问题")
    assert len(published) == 1  # stale generation → no-op


def test_set_stream_mode_flips_state_machine_flag():
    pipeline._set_stream_mode(True)
    assert pipeline._asr_state.stream_mode is True
    pipeline._set_stream_mode(False)
    assert pipeline._asr_state.stream_mode is False


def test_streaming_active_segment_is_not_enqueued():
    runtime = pipeline._new_interviewer_runtime()
    cfg = AppConfig()
    speech = np.zeros(16000, dtype=np.float32)
    kwargs = dict(
        flush_reason="silence", segment_started_mono=0.0, segment_ended_mono=1.0,
    )
    assert pipeline._maybe_build_interviewer_segment(cfg, runtime, _Session(), speech, streaming_active=True, **kwargs) is False
    assert pipeline._interviewer_segment_backlog(runtime) == 0
    assert pipeline._maybe_build_interviewer_segment(cfg, runtime, _Session(), speech, streaming_active=False, **kwargs) is True
    assert pipeline._interviewer_segment_backlog(runtime) == 1


def test_start_interviewer_stream_failure_broadcasts_fallback(monkeypatch, broadcast_spy, current_generation):
    def fail_start(self):
        raise AliyunSTTAuthError("bad key")

    monkeypatch.setattr(pipeline.AliyunInterviewerStream, "start", fail_start)
    cfg = AppConfig(stt_provider="aliyun", aliyun_stt_api_key="bad")
    assert pipeline._start_interviewer_stream(cfg, current_generation, _Session()) is None
    assert broadcast_spy == [{
        "type": "stt_fallback", "scope": "interviewer",
        "from": "aliyun-stream", "to": "aliyun-segment", "reason": "stream_start_failed",
    }]


def test_stop_interviewer_stream_finishes_and_clears_interim(broadcast_spy, current_generation):
    class _Stream:
        def __init__(self):
            self.finished_with = None

        def finish(self, drain_timeout_sec):
            self.finished_with = drain_timeout_sec

    stream = _Stream()
    pipeline._stop_streaming_session(stream, current_generation, 1.5)
    assert stream.finished_with == 1.5
    assert broadcast_spy == [{"type": "transcription_interim", "text": "", "sentence_id": 0}]
    # None stream and stale generation are safe no-ops.
    pipeline._stop_streaming_session(None, current_generation, 1.5)
    pipeline._stop_streaming_session(_Stream(), current_generation + 1, 1.5)
    assert len(broadcast_spy) == 1


def test_stop_interviewer_stream_aborts_on_finish_error(broadcast_spy, current_generation):
    class _Stream:
        def __init__(self):
            self.aborted = False

        def finish(self, drain_timeout_sec):
            raise RuntimeError("boom")

        def abort(self):
            self.aborted = True

    stream = _Stream()
    pipeline._stop_streaming_session(stream, current_generation, 1.0)
    assert stream.aborted


def test_on_stream_final_flushes_immediately_in_instant_mode(monkeypatch, broadcast_spy, current_generation):
    flushed = []
    monkeypatch.setattr(pipeline, "_flush_asr_question_group_now", lambda *args: flushed.append(args))
    monkeypatch.setattr(pipeline, "_publish_stream_fragment", lambda *args: None)
    cfg = AppConfig()  # assist_stream_asr_instant_dispatch 默认 True
    monkeypatch.setattr(pipeline, "get_config", lambda: cfg)
    pipeline._set_stream_mode(True)
    try:
        pipeline._on_stream_final(current_generation, _Session(), 1, "请介绍一下 Redis 的持久化机制")
        assert len(flushed) == 1  # 即时派发：同线程立即 flush 问题组

        instant_off = AppConfig(assist_stream_asr_instant_dispatch=False)
        monkeypatch.setattr(pipeline, "get_config", lambda: instant_off)
        pipeline._on_stream_final(current_generation, _Session(), 2, "另一个问题")
        assert len(flushed) == 1  # 关闭即时派发则不立即 flush（走窗口/门控）

        instant_on = AppConfig(assist_stream_asr_instant_dispatch=True)
        monkeypatch.setattr(pipeline, "get_config", lambda: instant_on)
        pipeline._set_stream_mode(False)
        pipeline._on_stream_final(current_generation, _Session(), 3, "第三个问题")
        assert len(flushed) == 1  # 非流式模式同样不立即 flush
    finally:
        pipeline._set_stream_mode(False)




# ---------------------------------------------------------------------------
# 通用 ASR 伪流式（GenericInterimTranscriber）接线
# ---------------------------------------------------------------------------


def test_on_generic_final_publishes_then_clears_and_dispatches(monkeypatch, broadcast_spy, current_generation):
    published = []
    flushed = []
    monkeypatch.setattr(pipeline, "_publish_stream_fragment", lambda *args: published.append(args))
    monkeypatch.setattr(pipeline, "_flush_asr_question_group_now", lambda *args: flushed.append(args))
    cfg = AppConfig()  # assist_stream_asr_instant_dispatch 默认 True
    monkeypatch.setattr(pipeline, "get_config", lambda: cfg)
    pipeline._set_stream_mode(True)
    session = _Session()
    try:
        pipeline._on_generic_final(current_generation, session, 1, "请介绍一下 Redis 的持久化机制")
        # 先发布正式转写，再清进行中行（避免“先消失再出现”的空窗闪烁）
        assert len(published) == 1
        assert published[0][0] is cfg and published[0][1] is session
        assert "Redis" in published[0][2]
        assert broadcast_spy == [{"type": "transcription_interim", "text": "", "sentence_id": 1}]
        assert len(flushed) == 1  # 即时派发：与千问 sentence_end 一致
        # 过期代次丢弃
        pipeline._on_generic_final(current_generation + 1, session, 2, "过期")
        assert len(published) == 1 and len(flushed) == 1
    finally:
        pipeline._set_stream_mode(False)


def test_on_generic_final_empty_text_only_clears(monkeypatch, broadcast_spy, current_generation):
    published = []
    monkeypatch.setattr(pipeline, "_publish_stream_fragment", lambda *args: published.append(args))
    monkeypatch.setattr(pipeline, "get_config", lambda: AppConfig())
    pipeline._on_generic_final(current_generation, _Session(), 3, "")
    assert published == []
    assert broadcast_spy == [{"type": "transcription_interim", "text": "", "sentence_id": 3}]


def test_start_generic_interim_transcriber_returns_none_when_engine_unusable(monkeypatch, current_generation):
    from services.stt.engines import DoubaoSTT, GenericHTTPSTT

    cfg = AppConfig(stt_provider="generic")
    monkeypatch.setattr(pipeline, "get_stt_engine", lambda **kw: (_ for _ in ()).throw(RuntimeError("no cfg")))
    assert pipeline._start_generic_interim_transcriber(cfg, current_generation, _Session()) is None

    # 非通用引擎（例如豆包）或配置不全（缺 Base URL）都不建转写器
    monkeypatch.setattr(pipeline, "get_stt_engine", lambda **kw: DoubaoSTT())
    assert pipeline._start_generic_interim_transcriber(cfg, current_generation, _Session()) is None
    monkeypatch.setattr(
        pipeline, "get_stt_engine",
        lambda **kw: GenericHTTPSTT(api_base_url="", api_key="", model="m"),
    )
    assert pipeline._start_generic_interim_transcriber(cfg, current_generation, _Session()) is None


def test_start_generic_interim_transcriber_full_flow(monkeypatch, broadcast_spy, current_generation):
    """interim 走广播、finalize 定稿走发布链路、stop 清行收尾。"""
    from services.stt.engines import GenericHTTPSTT

    engine = GenericHTTPSTT(api_base_url="http://asr.local/v1", api_key="", model="whisper-1")
    monkeypatch.setattr(pipeline, "get_stt_engine", lambda **kw: engine)
    monkeypatch.setattr(
        GenericHTTPSTT, "transcribe",
        lambda self, audio, sample_rate=16000, **kw: "中间结果",
    )
    monkeypatch.setattr(pipeline, "transcribe_with_fallback", lambda *a, **kw: "完整定稿")
    published = []
    monkeypatch.setattr(pipeline, "_publish_stream_fragment", lambda *args: published.append(args))
    monkeypatch.setattr(pipeline, "_flush_asr_question_group_now", lambda *args: None)
    cfg = AppConfig(stt_provider="generic", generic_stt_streaming_interval_ms=800)
    session = _Session()
    pipeline._set_stream_mode(True)
    transcriber = pipeline._start_generic_interim_transcriber(cfg, current_generation, session)
    assert transcriber is not None
    try:
        transcriber.submit(np.zeros(16000, dtype=np.float32))
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and not broadcast_spy:
            time.sleep(0.02)
        assert broadcast_spy == [
            {"type": "transcription_interim", "text": "中间结果", "sentence_id": 1}
        ]
        transcriber.finalize(np.zeros(16000, dtype=np.float32))
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and not published:
            time.sleep(0.02)
        assert published and published[0][2] == "完整定稿"
    finally:
        pipeline._stop_streaming_session(transcriber, current_generation, 2.0)
        pipeline._set_stream_mode(False)
    # 收尾时兜底清行；None 与重复停止都是安全 no-op
    pipeline._stop_streaming_session(None, current_generation, 0.1)
