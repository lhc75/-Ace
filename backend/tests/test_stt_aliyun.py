from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import queue
import sys
import threading
from types import SimpleNamespace

import numpy as np
import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core.config import ALIYUN_STT_MODEL_OPTIONS, AppConfig
from services.stt import aliyun, factory
from services.stt.aliyun import (
    AliyunSTT, AliyunSTTAuthError, AliyunSTTConnectionError,
    AliyunSTTEmptyResultError, AliyunSTTProviderError, AliyunSTTTimeoutError,
)


def _sentence(sentence_id: int, text: str, final: bool = True, **extra):
    return {
        "header": {"event": "result-generated"},
        "payload": {"output": {"sentence": {
            "sentence_id": sentence_id, "text": text, "sentence_end": final, **extra,
        }}},
    }


def _failed(code: str, detail: str):
    return {"header": {"event": "task-failed", "error_code": code, "error_message": detail}}


class FakeWebSocket:
    def __init__(self, results=(), startup=None):
        self.responses = queue.Queue()
        self.results = list(results)
        self.startup = startup
        self.sent = []
        self.timeout = 1.0
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
            for event in self.results:
                self.emit(event)

    def send_binary(self, pcm):
        assert self.started, "Audio sent before task-started was received"
        self.sent.append(pcm)

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


FINISHED = {"header": {"event": "task-finished"}}


def _patch_ws(monkeypatch, ws):
    connections = []

    def connect(url, **kwargs):
        connections.append((url, kwargs))
        return ws

    monkeypatch.setattr(aliyun, "websocket", SimpleNamespace(create_connection=connect))
    return connections


@pytest.mark.parametrize("model", [*ALIYUN_STT_MODEL_OPTIONS, "custom-qwen-asr-model"])
def test_task_protocol_auth_pcm_and_complete_result(monkeypatch, model):
    ws = FakeWebSocket([_sentence(1, "Redis"), FINISHED])
    connections = _patch_ws(monkeypatch, ws)
    audio = np.full(2400, 0.5, dtype=np.float32)
    assert AliyunSTT(" sk-test ", model).transcribe(audio, 8000) == "Redis"
    url, connection = connections[0]
    assert url == aliyun.ALIYUN_ASR_WS_URL
    assert connection["header"] == {"Authorization": "Bearer sk-test"}
    assert connection["timeout"] == 10
    assert connection["enable_multithread"] is True
    assert ws.sent[0]["payload"] == {
        "task_group": "audio", "task": "asr", "function": "recognition",
        "model": model, "parameters": {"format": "pcm", "sample_rate": 8000}, "input": {},
    }
    assert ws.sent[0]["header"]["streaming"] == "duplex"
    pcm = [frame for frame in ws.sent if isinstance(frame, bytes)]
    assert [len(frame) for frame in pcm] == [1600, 1600, 1600]
    assert np.all(np.frombuffer(b"".join(pcm), dtype="<i2") == 16383)
    assert ws.sent[-1]["header"] == {
        "action": "finish-task", "task_id": ws.task_id, "streaming": "duplex",
    }
    assert ws.closed
    assert not any(t.name == "aliyun-asr-send" for t in threading.enumerate())


def test_only_finals_are_combined_in_order_and_deduplicated(monkeypatch):
    ws = FakeWebSocket([
        _sentence(1, "partial", False), _sentence(0, "heartbeat", heartbeat=True),
        _sentence(2, "two."), _sentence(1, "one."), _sentence(1, "first."),
        _sentence(3, "unfinished", False), FINISHED,
    ])
    _patch_ws(monkeypatch, ws)
    assert AliyunSTT("key").transcribe(np.zeros(1600)) == "first.two."


@pytest.mark.parametrize("events,error", [
    ([FINISHED], AliyunSTTEmptyResultError),
    ([_sentence(1, "partial", False), FINISHED], AliyunSTTEmptyResultError),
    ([""], AliyunSTTConnectionError),
    ([_sentence(1, "final"), ""], AliyunSTTConnectionError),
    ([_failed("InvalidParameter", "bad model")], AliyunSTTProviderError),
    ([_failed("InvalidApiKey", "bad key")], AliyunSTTAuthError),
    ([_failed("CLIENT_ERROR", "request timeout")], AliyunSTTTimeoutError),
    (["invalid-json"], AliyunSTTProviderError),
])
def test_failed_task_never_returns_partial_or_final_without_completion(monkeypatch, events, error):
    ws = FakeWebSocket(events)
    _patch_ws(monkeypatch, ws)
    with pytest.raises(error):
        AliyunSTT("key").transcribe(np.zeros(1600))
    assert ws.closed


def test_start_timeout_sends_no_audio_and_closes_connection(monkeypatch):
    ws = FakeWebSocket(startup=[])
    _patch_ws(monkeypatch, ws)
    monkeypatch.setattr(AliyunSTT, "START_TIMEOUT_SEC", 0.02)
    with pytest.raises(AliyunSTTTimeoutError):
        AliyunSTT("key").transcribe(np.zeros(1600))
    assert len(ws.sent) == 1
    assert ws.closed


def test_finish_timeout_is_bounded_even_with_intermediate_results(monkeypatch):
    ws = FakeWebSocket([_sentence(1, "partial", False)])
    _patch_ws(monkeypatch, ws)
    monkeypatch.setattr(AliyunSTT, "FINISH_TIMEOUT_SEC", 0.02)
    with pytest.raises(AliyunSTTTimeoutError):
        AliyunSTT("key").transcribe(np.zeros(1600))
    assert ws.closed


def test_task_failure_during_upload_unblocks_sender(monkeypatch):
    class BlockedUpload(FakeWebSocket):
        def __init__(self):
            super().__init__()
            self.release = threading.Event()

        def send_binary(self, pcm):
            super().send_binary(pcm)
            self.emit(_failed("InvalidParameter", "rejected audio"))
            assert self.release.wait(2), "Sender did not unblock on abort"

        def abort(self):
            self.release.set()
            super().abort()

    ws = BlockedUpload()
    _patch_ws(monkeypatch, ws)
    with pytest.raises(AliyunSTTProviderError):
        AliyunSTT("key").transcribe(np.zeros(16000))
    assert ws.closed
    assert not any(t.name == "aliyun-asr-send" for t in threading.enumerate())


def test_sender_failure_is_propagated_and_cleaned_up(monkeypatch):
    ws = FakeWebSocket()
    _patch_ws(monkeypatch, ws)
    monkeypatch.setattr(ws, "send_binary", lambda _pcm: (_ for _ in ()).throw(ConnectionError("closed")))
    with pytest.raises(AliyunSTTConnectionError):
        AliyunSTT("key").transcribe(np.zeros(1600))
    assert ws.closed


def test_other_task_events_are_ignored(monkeypatch):
    wrong_task = _sentence(1, "wrong")
    wrong_task["header"]["task_id"] = "another-task"
    ws = FakeWebSocket([wrong_task, _sentence(1, "right"), FINISHED])
    _patch_ws(monkeypatch, ws)
    assert AliyunSTT("key").transcribe(np.zeros(1600)) == "right"


def test_errors_redact_key_from_server_response(monkeypatch):
    ws = FakeWebSocket(startup=[_failed("InvalidApiKey", "rejected secret-key")])
    _patch_ws(monkeypatch, ws)
    with pytest.raises(AliyunSTTAuthError) as error:
        AliyunSTT("secret-key").transcribe(np.zeros(1600))
    assert "secret-key" not in str(error.value)
    assert "[REDACTED]" in str(error.value)


@pytest.mark.parametrize("status", [401, 403])
def test_handshake_auth_errors_are_sanitized(monkeypatch, status):
    class HandshakeError(Exception):
        status_code = status

    def connect(*_args, **_kwargs):
        raise HandshakeError("secret-key denied")

    monkeypatch.setattr(aliyun, "websocket", SimpleNamespace(create_connection=connect))
    with pytest.raises(AliyunSTTAuthError) as error:
        AliyunSTT("secret-key").transcribe(np.zeros(1600))
    assert "secret-key" not in str(error.value)


def test_parallel_calls_use_independent_tasks_and_connections(monkeypatch):
    sockets = []

    def connect(*_args, **_kwargs):
        ws = FakeWebSocket([_sentence(1, "ok"), FINISHED])
        sockets.append(ws)
        return ws

    monkeypatch.setattr(aliyun, "websocket", SimpleNamespace(create_connection=connect))
    engine = AliyunSTT("key")
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: engine.transcribe(np.zeros(1600)), range(2)))
    assert results == ["ok", "ok"]
    assert len({ws.task_id for ws in sockets}) == 2
    assert all(ws.closed for ws in sockets)


def test_local_credential_validation_does_not_open_a_socket(monkeypatch):
    monkeypatch.setattr(aliyun, "websocket", SimpleNamespace(create_connection=lambda *_args, **_kwargs: pytest.fail("Unexpected connection")))
    with pytest.raises(AliyunSTTAuthError):
        AliyunSTT().transcribe(np.zeros(1600))
    with pytest.raises(AliyunSTTProviderError):
        AliyunSTT("key", "  ").transcribe(np.zeros(1600))
    with pytest.raises(AliyunSTTEmptyResultError):
        AliyunSTT("key").transcribe(np.zeros(0))


def test_custom_model_readiness_and_trimming():
    engine = AliyunSTT("key", "  custom-qwen-asr-model  ")
    assert engine.model == "custom-qwen-asr-model"
    assert engine.is_loaded
    assert not AliyunSTT("key", "  ").is_loaded


@pytest.mark.parametrize("scope,event_type,fallback_type", [
    ("interviewer", "stt_status", "stt_fallback"),
    ("candidate", "candidate_asr_status", "candidate_stt_fallback"),
])
def test_auth_failure_falls_back_once_and_keeps_scope(monkeypatch, scope, event_type, fallback_type):
    import core.config as config_module
    from api.realtime import ws as broadcast_module

    cfg = AppConfig(stt_provider="aliyun", aliyun_stt_api_key="key")
    monkeypatch.setattr(config_module, "get_config", lambda: cfg)
    calls = []
    attempts = []

    def fail(*_args, **_kwargs):
        attempts.append(1)
        raise AliyunSTTAuthError("InvalidApiKey")

    monkeypatch.setattr(factory, "get_stt_engine", lambda **_kwargs: SimpleNamespace(transcribe=fail))
    monkeypatch.setattr(factory, "_call_circuit_open", lambda _scope: False)
    monkeypatch.setattr(factory, "_call_circuit_record_failure", lambda *_args, **kwargs: calls.append(kwargs))
    monkeypatch.setattr(factory, "_is_whisper_engine_loaded", lambda *_args: True)
    monkeypatch.setattr(factory, "_call_whisper_transcribe", lambda *_args, **_kwargs: "local")
    monkeypatch.setattr(broadcast_module, "broadcast", calls.append)
    assert factory.transcribe_with_fallback(
        np.zeros(1600), 16000, provider="aliyun", scope=scope, status_event_type=event_type,
    ) == "local"
    assert len(attempts) == 1
    assert any(c.get("is_auth") is True for c in calls)
    assert any(c.get("type") == fallback_type and c.get("from") == "aliyun" for c in calls)
    assert not any(c.get("type") == ("stt_fallback" if scope == "candidate" else "candidate_stt_fallback") for c in calls)


def test_remote_disabled_never_uses_aliyun(monkeypatch):
    from api.realtime import ws as broadcast_module

    providers = []
    events = []

    def engine(**kwargs):
        providers.append(kwargs["provider"])
        return SimpleNamespace(is_loaded=True, transcribe=lambda *_args, **_kwargs: "local")

    monkeypatch.setattr(factory, "get_stt_engine", engine)
    monkeypatch.setattr(broadcast_module, "broadcast", events.append)
    assert factory.transcribe_with_fallback(np.zeros(1600), 16000, provider="aliyun", allow_remote=False) == "local"
    assert providers == ["whisper"]
    assert events == []


@pytest.mark.parametrize("scope,event_type", [("interviewer", "stt_status"), ("candidate", "candidate_asr_status")])
def test_success_resets_only_own_circuit_and_emits_own_status(monkeypatch, scope, event_type):
    from api.realtime import ws as broadcast_module

    reset_scopes = []
    events = []
    monkeypatch.setattr(factory, "get_stt_engine", lambda **_kwargs: SimpleNamespace(
        is_loaded=True, transcribe=lambda *_args, **_kwargs: "Redis",
    ))
    monkeypatch.setattr(factory, "_call_circuit_open", lambda _scope: False)
    monkeypatch.setattr(factory, "_call_circuit_reset", reset_scopes.append)
    monkeypatch.setattr(broadcast_module, "broadcast", events.append)
    assert factory.transcribe_with_fallback(
        np.zeros(1600), 16000, provider="aliyun", scope=scope, status_event_type=event_type,
    ) == "Redis"
    assert reset_scopes == [scope]
    assert events == [{"type": event_type, "loaded": True, "loading": False, "provider": "aliyun"}]


def test_aliyun_preloads_whisper_fallback(monkeypatch):
    import core.config as config_module
    from api.realtime import ws as broadcast_module

    cfg = AppConfig(stt_provider="aliyun", whisper_preload=True)
    monkeypatch.setattr(config_module, "get_config", lambda: cfg)
    loaded = threading.Event()
    events = []
    threads = []
    real_thread = threading.Thread

    def create_thread(*args, **kwargs):
        thread = real_thread(*args, **kwargs)
        threads.append(thread)
        return thread

    monkeypatch.setattr(factory.threading, "Thread", create_thread)
    monkeypatch.setattr(factory, "_get_whisper_fallback", lambda: loaded.set())
    monkeypatch.setattr(broadcast_module, "broadcast", events.append)
    factory.preload_whisper_fallback()
    assert loaded.wait(timeout=1)
    assert len(threads) == 1
    threads[0].join(timeout=1)
    assert not threads[0].is_alive()
    assert all(event["provider"] == "whisper-preload" for event in events)
    assert any(event["loaded"] for event in events)
