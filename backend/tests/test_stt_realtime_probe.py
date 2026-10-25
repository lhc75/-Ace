from __future__ import annotations

from pathlib import Path
import sys

import numpy as np
import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.stt.realtime_probe import probe_aliyun_realtime, probe_generic_realtime

AUDIO_3S = np.zeros(3 * 16000, dtype=np.float32)


class _FakeStream:
    """模拟 AliyunInterviewerStream：可配置 start 失败 / 定稿文本 / failure。"""

    start_error: Exception | None = None
    final_text: str = "好的，收到"
    failure_after_finish: Exception | None = None
    instances: list["_FakeStream"] = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.failure = None
        self.fed_bytes = 0
        self.aborted = False
        _FakeStream.instances.append(self)

    def start(self):
        if _FakeStream.start_error is not None:
            raise _FakeStream.start_error

    def feed(self, pcm: bytes):
        self.fed_bytes += len(pcm)

    def finish(self, drain_timeout_sec: float):
        if _FakeStream.final_text:
            self.kwargs["on_final"](1, _FakeStream.final_text)
        if _FakeStream.failure_after_finish is not None:
            self.failure = _FakeStream.failure_after_finish

    def abort(self):
        self.aborted = True


@pytest.fixture
def fake_stream(monkeypatch):
    _FakeStream.instances = []
    _FakeStream.start_error = None
    _FakeStream.final_text = "好的，收到"
    _FakeStream.failure_after_finish = None
    # realtime_probe 在函数内部 import，patch 模块属性即可生效
    monkeypatch.setattr(
        "services.stt.aliyun_streaming.AliyunInterviewerStream",
        _FakeStream,
    )
    return _FakeStream


def test_probe_aliyun_realtime_ok(fake_stream):
    ok, detail = probe_aliyun_realtime("key", "model", AUDIO_3S, 16000)
    assert ok is True
    assert detail == ""
    assert fake_stream.instances[0].fed_bytes > 0


def test_probe_aliyun_realtime_start_failure(fake_stream):
    fake_stream.start_error = RuntimeError("鉴权失败")
    ok, detail = probe_aliyun_realtime("key", "model", AUDIO_3S, 16000)
    assert ok is False
    assert "鉴权失败" in detail


def test_probe_aliyun_realtime_task_failure(fake_stream):
    fake_stream.failure_after_finish = RuntimeError("任务失败: 模型不支持")
    ok, detail = probe_aliyun_realtime("key", "model", AUDIO_3S, 16000)
    assert ok is False
    assert "模型不支持" in detail


def test_probe_aliyun_realtime_no_text(fake_stream):
    fake_stream.final_text = ""
    ok, detail = probe_aliyun_realtime("key", "model", AUDIO_3S, 16000)
    assert ok is False
    assert "没有返回任何实时识别结果" in detail


class _FakeGenericEngine:
    def __init__(self, result="前面半句", error: Exception | None = None):
        self.result = result
        self.error = error
        self.calls = 0

    def transcribe(self, audio, sample_rate=16000, **_kwargs):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.result


def test_probe_generic_realtime_ok():
    ok, _ = probe_generic_realtime(_FakeGenericEngine(), AUDIO_3S, 16000)
    assert ok is True


def test_probe_generic_realtime_error():
    engine = _FakeGenericEngine(error=RuntimeError("HTTP 400: model unsupported"))
    ok, detail = probe_generic_realtime(engine, AUDIO_3S, 16000)
    assert ok is False
    assert "model unsupported" in detail


def test_probe_generic_realtime_empty_prefix():
    ok, detail = probe_generic_realtime(_FakeGenericEngine(result=""), AUDIO_3S, 16000)
    assert ok is False
    assert "没有返回文本" in detail


def test_probe_generic_realtime_skips_too_short_audio():
    engine = _FakeGenericEngine(error=RuntimeError("不应被调用"))
    ok, _ = probe_generic_realtime(engine, np.zeros(1000, dtype=np.float32), 16000)
    assert ok is True
    assert engine.calls == 0
