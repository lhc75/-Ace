"""STT engine implementations: Whisper (local), Doubao, and generic HTTP ASR."""

import io
import gzip
import json
import struct
import time
import uuid
import wave
import numpy as np
import threading
from typing import Optional, Any

import requests

from core.logger import get_logger
from .text_utils import TECH_VOCAB, _postprocess, _build_initial_prompt

_log = get_logger("stt.engines")

try:
    import websocket
except ImportError:
    websocket = None


# ---------------------------------------------------------------------------
# Shared audio helpers
# ---------------------------------------------------------------------------

def _audio_to_pcm_int16(audio: np.ndarray) -> np.ndarray:
    if audio.dtype == np.float32 or audio.dtype == np.float64:
        if audio.max() <= 1.0 and audio.min() >= -1.0:
            return (audio * 32767).astype(np.int16)
        return np.clip(audio, -32768, 32767).astype(np.int16)
    if audio.dtype != np.int16:
        return audio.astype(np.int16)
    return audio


def _audio_to_wav_bytes(audio: np.ndarray, sample_rate: int = 16000) -> bytes:
    pcm = _audio_to_pcm_int16(audio)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate or 16000))
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


# ---------------------------------------------------------------------------
# DoubaoSTT – Volcengine streaming ASR
# ---------------------------------------------------------------------------

DOUBAO_ASR_WS_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
MSG_FULL_CLIENT_REQUEST = 0x01
MSG_AUDIO_ONLY = 0x02
MSG_FULL_SERVER_RESPONSE = 0x09
MSG_ERROR = 0x0F
FLAG_LAST_AUDIO = 0x02
COMPRESSION_GZIP = 0x01
CHUNK_MS = 200
CHUNK_SAMPLES = 16000 * CHUNK_MS // 1000


class RemoteSTTEmptyResultError(RuntimeError):
    """A remote ASR request completed without any transcript text."""


class DoubaoSTTError(RuntimeError):
    """Base class for failures returned by the Doubao ASR transport."""


class DoubaoSTTTimeoutError(DoubaoSTTError, TimeoutError):
    """The Doubao ASR connection or response timed out."""


class DoubaoSTTConnectionError(DoubaoSTTError, ConnectionError):
    """The Doubao ASR WebSocket connection closed or failed."""


class DoubaoSTTProviderError(DoubaoSTTError):
    """Doubao sent an explicit error response."""


class DoubaoSTTEmptyResultError(DoubaoSTTError, RemoteSTTEmptyResultError):
    """Doubao completed normally but did not return recognized text."""


def _build_ws_frame_full_request(
    app_key: str,
    boosting_table_id: str,
    language: str = "zh-CN",
) -> bytes:
    req: dict[str, Any] = {
        "user": {"uid": app_key},
        "audio": {
            "format": "pcm",
            "rate": 16000,
            "bits": 16,
            "channel": 1,
            "language": language if language and language != "auto" else "zh-CN",
        },
        "request": {
            "model_name": "bigmodel",
            "enable_itn": True,
            "enable_punc": True,
        },
    }
    if boosting_table_id and boosting_table_id.strip():
        req["request"]["corpus"] = {"boosting_table_id": boosting_table_id.strip()}
    payload_raw = json.dumps(req, ensure_ascii=False).encode("utf-8")
    payload = gzip.compress(payload_raw)
    header = bytes([0x11, 0x10, 0x11, 0x00])
    return header + struct.pack(">I", len(payload)) + payload


def _build_ws_frame_audio(pcm_chunk: bytes, is_last: bool = False) -> bytes:
    payload = gzip.compress(pcm_chunk)
    header = bytes([0x11, 0x22 if is_last else 0x20, 0x01, 0x00])
    return header + struct.pack(">I", len(payload)) + payload


def _parse_ws_payload(data: bytes, header_size: int) -> Optional[bytes]:
    """Read a JSON payload from either supported server-response layout.

    Most v3 responses store ``payload_size`` immediately after the four-byte
    header. Some async frames include a four-byte sequence before it. Keeping
    both layouts prevents an intermediate packet from being mistaken for the
    terminal result.
    """
    for size_offset in (header_size, header_size + 4):
        if len(data) < size_offset + 4:
            continue
        payload_size = struct.unpack(">I", data[size_offset : size_offset + 4])[0]
        payload_start = size_offset + 4
        if payload_start + payload_size == len(data):
            return data[payload_start:]
    return None


def _parse_ws_response(data: bytes) -> tuple[int, Optional[dict]]:
    if len(data) < 4:
        return 0, None
    header_size = max(1, data[0] & 0x0F) * 4
    if len(data) < header_size:
        return 0, None
    msg_type = (data[1] >> 4) & 0x0F
    compression = data[2] & 0x0F
    if msg_type == MSG_ERROR:
        return MSG_ERROR, None
    if msg_type == MSG_FULL_SERVER_RESPONSE:
        raw = _parse_ws_payload(data, header_size)
        if raw is None:
            return msg_type, None
        if compression == COMPRESSION_GZIP:
            try:
                raw = gzip.decompress(raw)
            except Exception:
                _log.warning("_parse_ws_response gzip decompress failed")
                return msg_type, None
        try:
            payload = json.loads(raw.decode("utf-8"))
            return msg_type, payload
        except Exception:
            _log.warning("_parse_ws_response invalid JSON at offset %d", len(raw))
            return msg_type, None
    return msg_type, None


def _parse_ws_error(data: bytes) -> tuple[int, str]:
    """Decode the error-code/message part of a Doubao error frame."""
    if len(data) < 8:
        return 0, ""
    header_size = max(1, data[0] & 0x0F) * 4
    if len(data) < header_size + 4:
        return 0, ""
    code = struct.unpack(">I", data[header_size : header_size + 4])[0]
    for size_offset in (header_size + 4, header_size + 8):
        if len(data) < size_offset + 4:
            continue
        message_size = struct.unpack(">I", data[size_offset : size_offset + 4])[0]
        message_start = size_offset + 4
        if message_start + message_size == len(data):
            return code, data[message_start:].decode("utf-8", errors="replace")
    return code, ""


def _response_status(payload: dict) -> str:
    result = payload.get("result")
    for source in (payload, result if isinstance(result, dict) else {}):
        for key in ("status", "state", "message_type"):
            value = source.get(key)
            if value is not None:
                return str(value)[:80]
        code = source.get("code")
        if code is not None:
            return f"code={code}"
    return ""


def _response_is_final(payload: dict) -> bool:
    result = payload.get("result")
    result = result if isinstance(result, dict) else {}
    for source in (payload, result):
        if any(bool(source.get(key)) for key in ("is_final", "is_last", "completed", "final")):
            return True
        status = str(source.get("status") or source.get("state") or "").strip().lower()
        if status in {"completed", "complete", "final", "finished", "done"}:
            return True
    sequence = payload.get("sequence")
    return isinstance(sequence, int) and sequence < 0


def _is_websocket_timeout(exc: Exception) -> bool:
    return isinstance(exc, TimeoutError) or "timeout" in type(exc).__name__.lower()


class DoubaoSTT:
    """豆包流式语音识别模型，WebSocket 双流式。

    支持两种鉴权方式（自动选择）：
    - 新版控制台：X-Api-Key（api_key 非空时优先使用）
    - 旧版控制台：X-Api-App-Key + X-Api-Access-Key
    """

    RESPONSE_TIMEOUT_SEC = 20.0

    def __init__(
        self,
        app_id: str = "",
        access_token: str = "",
        api_key: str = "",
        resource_id: str = "volc.seedasr.sauc.duration",
        boosting_table_id: str = "",
    ):
        self.app_id = app_id or ""
        self.access_token = access_token or ""
        self.api_key = api_key or ""
        self.resource_id = resource_id or "volc.seedasr.sauc.duration"
        self.boosting_table_id = boosting_table_id or ""

    @property
    def model_size(self) -> str:
        return "doubao"

    @property
    def is_loaded(self) -> bool:
        return bool(self.api_key or self.access_token)

    @property
    def is_loading(self) -> bool:
        return False

    def load_model(self) -> None:
        pass

    def change_model(self, _model_size: str) -> None:
        pass

    def _build_headers(self) -> dict:
        if self.api_key:
            return {
                "X-Api-Key": self.api_key,
                "X-Api-Resource-Id": self.resource_id,
                "X-Api-Connect-Id": str(uuid.uuid4()),
            }
        app_key = self.app_id or self.access_token
        return {
            "X-Api-App-Key": app_key,
            "X-Api-Access-Key": self.access_token,
            "X-Api-Resource-Id": self.resource_id,
            "X-Api-Connect-Id": str(uuid.uuid4()),
        }

    def transcribe(self, audio: np.ndarray, sample_rate: int = 16000,
                   position: str = "后端开发", language: str = "Python") -> str:
        if not self.api_key and not self.access_token:
            raise DoubaoSTTError("豆包 ASR API Key 或 Access Token 未配置")
        if websocket is None:
            raise DoubaoSTTError("豆包 ASR 缺少 websocket-client 依赖")
        app_key = self.app_id or self.access_token or self.api_key
        pcm = _audio_to_pcm_int16(audio)
        if sample_rate != 16000:
            n_orig = len(pcm)
            n_new = int(round(n_orig * 16000 / sample_rate))
            if n_new < 1:
                n_new = 1
            indices = np.linspace(0, n_orig - 1, n_new).astype(np.int32)
            pcm = pcm[indices]

        first_frame = _build_ws_frame_full_request(
            app_key, self.boosting_table_id, language="zh-CN"
        )
        n_samples = len(pcm)
        chunks = []
        offset = 0
        while offset < n_samples:
            take = min(CHUNK_SAMPLES, n_samples - offset)
            chunk_bytes = pcm[offset : offset + take].tobytes()
            is_last = offset + take >= n_samples
            chunks.append(_build_ws_frame_audio(chunk_bytes, is_last=is_last))
            offset += take
        if not chunks:
            pad = np.zeros(CHUNK_SAMPLES, dtype=np.int16)
            chunks = [_build_ws_frame_audio(pad.tobytes(), is_last=True)]

        audio_sec = len(pcm) / 16000.0
        packets_received = 0
        response_frames = 0
        response_status = ""
        final_text = ""
        try:
            ws = websocket.create_connection(
                DOUBAO_ASR_WS_URL,
                header=[f"{k}: {v}" for k, v in self._build_headers().items()],
                timeout=10,
            )
            try:
                ws.send_binary(first_frame)
                time.sleep(0.05)
                for i, frame in enumerate(chunks):
                    ws.send_binary(frame)
                    if i % 10 == 9:
                        time.sleep(0.02)
                ws.settimeout(5)
                first_packet = True
                response_deadline = time.monotonic() + self.RESPONSE_TIMEOUT_SEC
                while True:
                    remaining = response_deadline - time.monotonic()
                    if remaining <= 0:
                        raise DoubaoSTTTimeoutError(f"豆包 ASR 响应总时限已到（音频 {audio_sec:.1f}s）")
                    ws.settimeout(min(5 if first_packet else 15, remaining))
                    try:
                        raw = ws.recv()
                    except Exception as e:
                        if _is_websocket_timeout(e):
                            if final_text:
                                _log.info(
                                    "Doubao ASR response timeout after text audio=%.2fs chunks=%d packets=%d frames=%d status=%s",
                                    audio_sec, len(chunks), packets_received, response_frames, response_status or "-",
                                )
                                break
                            if packets_received:
                                raise DoubaoSTTEmptyResultError(
                                    f"豆包返回空文本（音频 {audio_sec:.1f}s，响应状态 {response_status or '无文本'}）"
                                ) from e
                            raise DoubaoSTTTimeoutError(
                                f"豆包 ASR 响应超时（音频 {audio_sec:.1f}s）"
                            ) from e
                        if final_text:
                            _log.info(
                                "Doubao ASR connection closed after text audio=%.2fs chunks=%d packets=%d frames=%d status=%s",
                                audio_sec, len(chunks), packets_received, response_frames, response_status or "-",
                            )
                            break
                        raise DoubaoSTTConnectionError(
                            f"豆包 ASR 连接异常（音频 {audio_sec:.1f}s）: {e}"
                        ) from e
                    if first_packet:
                        ws.settimeout(15)
                        first_packet = False
                    if not raw:
                        if not final_text:
                            raise DoubaoSTTConnectionError(
                                f"豆包 ASR 在返回文本前断开连接（音频 {audio_sec:.1f}s）"
                            )
                        break
                    if isinstance(raw, str):
                        raw = raw.encode("utf-8")
                    packets_received += 1
                    msg_type, payload = _parse_ws_response(raw)
                    if msg_type == MSG_ERROR:
                        code, err_msg = _parse_ws_error(raw)
                        raise DoubaoSTTProviderError(
                            f"豆包 ASR 明确错误: {code}{f' {err_msg}' if err_msg else ''}"
                        )
                    if msg_type == MSG_FULL_SERVER_RESPONSE and payload:
                        response_frames += 1
                        response_status = _response_status(payload) or response_status
                        res = payload.get("result") or {}
                        text = (res.get("text") or payload.get("text") or "").strip()
                        if text:
                            final_text = text
                        # The binary protocol marks the final packet in its
                        # flags even when the JSON has no completion field.
                        if raw[1] & FLAG_LAST_AUDIO or _response_is_final(payload):
                            break
                if final_text:
                    result = _postprocess(final_text)
                    _log.info(
                        "Doubao ASR completed audio=%.2fs chunks=%d packets=%d frames=%d status=%s text_chars=%d",
                        audio_sec, len(chunks), packets_received, response_frames, response_status or "-", len(result),
                    )
                    return result
                raise DoubaoSTTEmptyResultError(
                    f"豆包返回空文本（音频 {audio_sec:.1f}s，响应包 {response_frames}，状态 {response_status or '无'}）"
                )
            finally:
                try:
                    ws.close()
                except Exception:
                    pass
        except DoubaoSTTEmptyResultError as e:
            _log.warning(
                "Doubao ASR empty result audio=%.2fs chunks=%d packets=%d frames=%d status=%s reason=%s",
                audio_sec, len(chunks), packets_received, response_frames, response_status or "-", e,
            )
            raise
        except DoubaoSTTError as e:
            _log.warning(
                "Doubao ASR failed audio=%.2fs chunks=%d packets=%d frames=%d status=%s reason=%s",
                audio_sec, len(chunks), packets_received, response_frames, response_status or "-", e,
            )
            raise
        except Exception as e:
            _log.warning(
                "Doubao ASR unexpected error audio=%.2fs chunks=%d packets=%d frames=%d status=%s reason=%s",
                audio_sec, len(chunks), packets_received, response_frames, response_status or "-", e,
                exc_info=True,
            )
            if _is_websocket_timeout(e):
                raise DoubaoSTTTimeoutError(f"豆包 ASR 连接超时（音频 {audio_sec:.1f}s）: {e}") from e
            raise DoubaoSTTConnectionError(f"豆包 ASR 连接异常（音频 {audio_sec:.1f}s）: {e}") from e


# ---------------------------------------------------------------------------
# GenericHTTPSTT – OpenAI-compatible multipart ASR
# ---------------------------------------------------------------------------

class GenericHTTPSTT:
    """通用 HTTP ASR: POST {base_url}/audio/transcriptions with multipart file."""

    def __init__(self, api_base_url: str, api_key: str, model: str,
                 custom_headers: str = ""):
        self.api_base_url = (api_base_url or "").rstrip("/")
        self.api_key = api_key or ""
        self.model = model or ""
        self.custom_headers = custom_headers or ""

    @property
    def model_size(self) -> str:
        return "generic"

    @property
    def is_loaded(self) -> bool:
        # Local OpenAI-compatible ASR servers such as FunASR commonly do not
        # require authentication; hosted providers can still supply a key.
        return bool(self.api_base_url and self.model)

    @property
    def is_loading(self) -> bool:
        return False

    def load_model(self) -> None:
        pass

    def change_model(self, _model_size: str) -> None:
        pass

    def _extract_text(self, data: Any) -> str:
        if isinstance(data, str):
            return data.strip()
        if not isinstance(data, dict):
            return ""
        for key in ("text", "transcript", "result", "content"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        result = data.get("result")
        if isinstance(result, dict):
            for key in ("text", "transcript", "content"):
                value = result.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        return ""

    def transcribe(self, audio: np.ndarray, sample_rate: int = 16000,
                   position: str = "后端开发", language: str = "Python") -> str:
        if not self.api_base_url:
            raise RuntimeError("通用 ASR Base URL 未配置")
        if not self.model:
            raise RuntimeError("通用 ASR Model 未配置")

        url = f"{self.api_base_url}/audio/transcriptions"
        wav_bytes = _audio_to_wav_bytes(audio, sample_rate=sample_rate)
        headers = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if self.custom_headers.strip():
            try:
                extra = json.loads(self.custom_headers)
                if isinstance(extra, dict):
                    headers.update({k: str(v) for k, v in extra.items()})
            except (json.JSONDecodeError, ValueError):
                for line in self.custom_headers.strip().splitlines():
                    line = line.strip()
                    if ":" in line:
                        k, v = line.split(":", 1)
                        headers[k.strip()] = v.strip()
        files = {"file": ("audio.wav", wav_bytes, "audio/wav")}
        data = {"model": self.model, "response_format": "json"}
        try:
            resp = requests.post(url, headers=headers, files=files, data=data, timeout=(10, 60))
            if resp.status_code >= 400:
                raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:300]}")
            ctype = resp.headers.get("content-type", "")
            if "json" in ctype.lower():
                payload = resp.json()
            else:
                try:
                    payload = resp.json()
                except Exception:
                    payload = resp.text
            text = self._extract_text(payload)
            return _postprocess(text) if text else ""
        except requests.exceptions.Timeout as e:
            raise RuntimeError(f"通用 ASR 请求超时: {e}") from e
        except requests.exceptions.RequestException as e:
            raise RuntimeError(f"通用 ASR 请求失败: {e}") from e


# ---------------------------------------------------------------------------
# STTEngine – Whisper (local)
# ---------------------------------------------------------------------------

class STTEngine:
    """Speech-to-text engine using faster-whisper."""

    TEMPERATURE_FALLBACK = [0.0, 0.2]

    def __init__(self, model_size: str = "base", language: str = "zh"):
        self.model_size = model_size
        self.language = language
        self._model = None
        self._lock = threading.Lock()
        self._loading = False

    @staticmethod
    def _best_device() -> tuple[str, str]:
        try:
            import torch
            if torch.cuda.is_available():
                return "cuda", "float16"
        except ImportError:
            pass
        return "cpu", "int8"

    def load_model(self):
        with self._lock:
            if self._model is not None:
                return
            self._loading = True
            try:
                from faster_whisper import WhisperModel
                device, compute_type = self._best_device()
                self._model = WhisperModel(
                    self.model_size,
                    device=device,
                    compute_type=compute_type,
                )
            finally:
                self._loading = False

    def change_model(self, model_size: str):
        if model_size == self.model_size and self._model is not None:
            return
        with self._lock:
            self._model = None
            self.model_size = model_size
        self.load_model()

    def transcribe(self, audio: np.ndarray, sample_rate: int = 16000,
                   position: str = "后端开发", language: str = "Python") -> str:
        if self._model is None:
            self.load_model()

        audio_f = audio.astype(np.float32)
        if audio_f.max() > 1.0:
            audio_f = audio_f / 32768.0

        whisper_lang: Optional[str] = None if self.language in ("auto", "zh-en") else self.language
        initial_prompt = _build_initial_prompt(position, language)

        hotwords_list = []
        for key in ["通用", language, position]:
            v = TECH_VOCAB.get(key)
            if v:
                for w in v.split():
                    if w and any(c.isascii() and c.isalpha() for c in w):
                        hotwords_list.append(w)
        hotwords_str = " ".join(dict.fromkeys(hotwords_list))[:900]

        kwargs = dict(
            language=whisper_lang,
            beam_size=3,
            temperature=self.TEMPERATURE_FALLBACK,
            initial_prompt=initial_prompt,
            condition_on_previous_text=False,
            vad_filter=True,
            vad_parameters=dict(
                min_silence_duration_ms=300,
                speech_pad_ms=200,
            ),
            word_timestamps=False,
            no_speech_threshold=0.6,
            log_prob_threshold=-1.0,
        )

        try:
            segments, _ = self._model.transcribe(audio_f, hotwords=hotwords_str, **kwargs)
        except TypeError:
            segments, _ = self._model.transcribe(audio_f, **kwargs)

        texts = []
        for seg in segments:
            text = seg.text.strip()
            if not text:
                continue
            if hasattr(seg, "no_speech_prob") and seg.no_speech_prob > 0.5:
                continue
            texts.append(text)

        return _postprocess(" ".join(texts))

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    @property
    def is_loading(self) -> bool:
        return self._loading
