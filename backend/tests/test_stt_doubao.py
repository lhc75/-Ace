from __future__ import annotations

import gzip
import json
import struct
from pathlib import Path
import sys
from types import SimpleNamespace

import numpy as np
import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.stt import engines  # noqa: E402
from services.stt.engines import (  # noqa: E402
    DoubaoSTT,
    DoubaoSTTConnectionError,
    DoubaoSTTEmptyResultError,
    DoubaoSTTProviderError,
    DoubaoSTTTimeoutError,
)


def _server_text_frame(text: str) -> bytes:
    payload = gzip.compress(
        json.dumps({"result": {"text": text}}, ensure_ascii=False).encode("utf-8")
    )
    return (
        bytes([0x00, engines.MSG_FULL_SERVER_RESPONSE << 4, engines.COMPRESSION_GZIP, 0x00])
        + b"\x00\x00\x00\x00"
        + struct.pack(">I", len(payload))
        + payload
    )


def _server_result_frame(
    text: str = "",
    *,
    status: str = "",
    final: bool = False,
) -> bytes:
    result: dict[str, object] = {"text": text}
    if status:
        result["status"] = status
    if final:
        result["is_final"] = True
    payload = gzip.compress(
        json.dumps({"result": result}, ensure_ascii=False).encode("utf-8")
    )
    return (
        bytes([0x11, engines.MSG_FULL_SERVER_RESPONSE << 4, engines.COMPRESSION_GZIP, 0x00])
        + struct.pack(">I", len(payload))
        + payload
    )


def _server_error_frame(code: int, message: str) -> bytes:
    payload = message.encode("utf-8")
    return (
        bytes([0x11, engines.MSG_ERROR << 4, 0x00, 0x00])
        + struct.pack(">I", code)
        + struct.pack(">I", len(payload))
        + payload
    )


class _FakeWebSocket:
    def __init__(self, responses: list[object]):
        self.responses = list(responses)
        self.sent: list[bytes] = []
        self.timeouts: list[float] = []
        self.closed = False
        self.recv_calls = 0

    def send_binary(self, frame: bytes):
        self.sent.append(frame)

    def settimeout(self, timeout: float):
        self.timeouts.append(timeout)

    def recv(self):
        self.recv_calls += 1
        if not self.responses:
            raise TimeoutError("timed out")
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    def close(self):
        self.closed = True


def _patch_websocket(monkeypatch, ws: _FakeWebSocket):
    monkeypatch.setattr(
        engines,
        "websocket",
        SimpleNamespace(create_connection=lambda *_args, **_kwargs: ws),
    )
    monkeypatch.setattr(engines.time, "sleep", lambda _seconds: None)


def test_doubao_stt_returns_final_response_text(monkeypatch):
    ws = _FakeWebSocket([_server_result_frame("你好，世界。", final=True)])
    _patch_websocket(monkeypatch, ws)

    result = DoubaoSTT(api_key="sk-test").transcribe(
        np.zeros(16000, dtype=np.float32),
        sample_rate=16000,
    )

    assert result == "你好世界。"
    # One request frame plus five 200ms audio frames for one second of PCM.
    assert len(ws.sent) == 6
    assert ws.closed is True


def test_doubao_stt_accepts_binary_final_without_json_completion(monkeypatch):
    payload = gzip.compress(json.dumps({"result": {"text": "最终文本"}}).encode())
    frame = bytes([0x11, 0x93, 0x11, 0x00]) + struct.pack(">iI", -1, len(payload)) + payload
    ws = _FakeWebSocket([frame])
    _patch_websocket(monkeypatch, ws)

    assert DoubaoSTT(api_key="test").transcribe(np.zeros(1600, dtype=np.float32)) == "最终文本"
    # A completed packet must return immediately, without another recv timeout.
    assert ws.recv_calls == 1
    assert ws.closed is True


@pytest.mark.parametrize("closed_frame", ["", b"", None])
def test_doubao_stt_detects_closed_socket_without_spinning(monkeypatch, closed_frame):
    ws = _FakeWebSocket([closed_frame])
    _patch_websocket(monkeypatch, ws)

    with pytest.raises(DoubaoSTTConnectionError, match="断开连接"):
        DoubaoSTT(api_key="test").transcribe(np.zeros(1600, dtype=np.float32))
    assert ws.closed is True


def test_doubao_stt_bounds_nonfinal_response_stream(monkeypatch):
    class StreamingWS(_FakeWebSocket):
        def recv(self):
            clock[0] += 1.0
            return _server_result_frame("", status="processing")

    clock = [0.0]
    ws = StreamingWS([])
    _patch_websocket(monkeypatch, ws)
    monkeypatch.setattr(engines.time, "monotonic", lambda: clock[0])
    engine = DoubaoSTT(api_key="test")
    engine.RESPONSE_TIMEOUT_SEC = 3.0

    with pytest.raises(DoubaoSTTTimeoutError, match="总时限"):
        engine.transcribe(np.zeros(1600, dtype=np.float32))
    assert clock[0] == 3.0
    assert ws.closed is True


def test_doubao_stt_uses_latest_non_empty_text_from_multiple_packets(monkeypatch):
    ws = _FakeWebSocket([
        _server_result_frame("第一部分"),
        _server_result_frame("完整问题是什么？", status="completed"),
    ])
    _patch_websocket(monkeypatch, ws)

    result = DoubaoSTT(api_key="sk-test").transcribe(
        np.zeros(16000 * 2, dtype=np.float32),
        sample_rate=16000,
    )

    assert result == "完整问题是什么？"


def test_doubao_stt_raises_explicit_provider_error(monkeypatch):
    ws = _FakeWebSocket([_server_error_frame(45000001, "invalid resource")])
    _patch_websocket(monkeypatch, ws)

    with pytest.raises(DoubaoSTTProviderError, match="45000001.*invalid resource"):
        DoubaoSTT(api_key="sk-test").transcribe(
            np.zeros(1600, dtype=np.float32),
            sample_rate=16000,
        )


def test_doubao_stt_raises_empty_result_after_normal_completion(monkeypatch):
    ws = _FakeWebSocket([_server_result_frame("", status="completed")])
    _patch_websocket(monkeypatch, ws)

    with pytest.raises(DoubaoSTTEmptyResultError, match="返回空文本"):
        DoubaoSTT(api_key="sk-test").transcribe(
            np.zeros(16000 * 2, dtype=np.float32),
            sample_rate=16000,
        )


def test_doubao_stt_raises_response_timeout_before_any_packet(monkeypatch):
    ws = _FakeWebSocket([TimeoutError("timed out")])
    _patch_websocket(monkeypatch, ws)

    with pytest.raises(DoubaoSTTTimeoutError, match="响应超时"):
        DoubaoSTT(api_key="sk-test").transcribe(
            np.zeros(16000, dtype=np.float32),
            sample_rate=16000,
        )


def test_doubao_stt_does_not_retry_timeout_before_factory_fallback(monkeypatch):
    calls = {"connect": 0, "sleep": []}

    def fake_create_connection(*_args, **_kwargs):
        calls["connect"] += 1
        raise TimeoutError("timed out")

    monkeypatch.setattr(
        engines,
        "websocket",
        SimpleNamespace(create_connection=fake_create_connection),
    )
    monkeypatch.setattr(engines.time, "sleep", lambda seconds: calls["sleep"].append(seconds))

    engine = DoubaoSTT(api_key="sk-test")

    with pytest.raises(TimeoutError):
        engine.transcribe(np.zeros(1600, dtype=np.float32), sample_rate=16000)

    assert calls["connect"] == 1
    assert calls["sleep"] == []


def test_doubao_stt_leaves_transient_retry_to_factory_fallback(monkeypatch):
    calls = {"connect": 0, "sleep": []}

    class FakeWebSocket:
        def __init__(self):
            self.recv_count = 0

        def send_binary(self, _frame):
            pass

        def settimeout(self, _timeout):
            pass

        def recv(self):
            self.recv_count += 1
            if self.recv_count == 1:
                return _server_text_frame("你好")
            raise TimeoutError("done")

        def close(self):
            pass

    def fake_create_connection(*_args, **_kwargs):
        calls["connect"] += 1
        if calls["connect"] == 1:
            raise ConnectionError("connection reset")
        return FakeWebSocket()

    monkeypatch.setattr(
        engines,
        "websocket",
        SimpleNamespace(create_connection=fake_create_connection),
    )
    monkeypatch.setattr(engines.time, "sleep", lambda seconds: calls["sleep"].append(seconds))

    engine = DoubaoSTT(api_key="sk-test")

    with pytest.raises(ConnectionError):
        engine.transcribe(np.zeros(1600, dtype=np.float32), sample_rate=16000)

    assert calls["connect"] == 1
    assert calls["sleep"] == []
