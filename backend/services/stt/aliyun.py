"""Qwen Audio streaming ASR over the Aliyun task-based WebSocket protocol."""

import json
import threading
import time
import uuid

import numpy as np

from core.config import ALIYUN_STT_MODEL_OPTIONS
from .engines import RemoteSTTEmptyResultError, _audio_to_pcm_int16, _is_websocket_timeout, websocket
from .text_utils import _postprocess


ALIYUN_ASR_WS_URL = "wss://maas.qianwenaiapi.com/api-ws/v1/inference"


class AliyunSTTError(RuntimeError):
    """Base class for sanitized Aliyun ASR failures."""


class AliyunSTTAuthError(AliyunSTTError):
    """The API key or model access was rejected."""


class AliyunSTTTimeoutError(AliyunSTTError, TimeoutError):
    """Connection, task startup, upload, or completion timed out."""


class AliyunSTTConnectionError(AliyunSTTError, ConnectionError):
    """The WebSocket closed before the task completed."""


class AliyunSTTProviderError(AliyunSTTError):
    """The server rejected a task or returned an invalid event."""


class AliyunSTTEmptyResultError(AliyunSTTError, RemoteSTTEmptyResultError):
    """A completed task did not produce a final sentence."""


def _redact(message: object, api_key: str) -> str:
    """日志与异常里统一抹掉 API Key，避免密钥随错误信息泄露到前端或日志文件。"""
    text = str(message)
    if api_key:
        text = text.replace(api_key, "[REDACTED]")
    return text[:200]


def _transport_error(error: Exception, api_key: str) -> AliyunSTTError:
    detail = _redact(error, api_key)
    if _is_websocket_timeout(error):
        return AliyunSTTTimeoutError(f"阿里千问 ASR 连接或传输超时: {detail}")
    if getattr(error, "status_code", None) in (401, 403):
        return AliyunSTTAuthError(f"阿里千问 ASR 鉴权失败: {detail}")
    return AliyunSTTConnectionError(f"阿里千问 ASR 连接异常: {detail}")


def _classify_task_failed(header: dict, api_key: str, *, timeout_is_terminal: bool) -> AliyunSTTError:
    """task-failed 错误分类。

    timeout_is_terminal=False (双工流) 时一律不映射为 AliyunSTTTimeoutError:
    接收循环会把超时异常当轮空继续等, 会把一次服务端任务失败吞掉。
    """
    code = str(header.get("error_code") or "UNKNOWN")
    detail = _redact(f"{code}: {header.get('error_message') or '任务失败'}", api_key)
    normalized_code = code.lower().replace("_", "").replace("-", "")
    if normalized_code in {"invalidapikey", "unauthorized", "forbidden", "accessdenied", "401", "403"}:
        return AliyunSTTAuthError(f"阿里千问 ASR 鉴权失败: {detail}")
    if timeout_is_terminal and ("timeout" in detail.lower() or "timed out" in detail.lower()):
        return AliyunSTTTimeoutError(f"阿里千问 ASR 任务超时: {detail}")
    return AliyunSTTProviderError(f"阿里千问 ASR 任务失败: {detail}")


class AliyunSTT:
    CONNECT_TIMEOUT_SEC = 10.0
    START_TIMEOUT_SEC = 10.0
    FINISH_TIMEOUT_SEC = 15.0
    CHUNK_MS = 100

    def __init__(self, api_key: str = "", model: str = ALIYUN_STT_MODEL_OPTIONS[0]):
        self.api_key = (api_key or "").strip()
        self.model = (model or "").strip()

    @property
    def model_size(self) -> str:
        return "aliyun"

    @property
    def is_loaded(self) -> bool:
        return bool(self.api_key and self.model)

    @property
    def is_loading(self) -> bool:
        return False

    def load_model(self) -> None:
        pass

    def change_model(self, _model_size: str) -> None:
        pass

    def _transport_error(self, error: Exception) -> AliyunSTTError:
        return _transport_error(error, self.api_key)

    def _receive(self, ws, task_id: str, deadline: float) -> dict | None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AliyunSTTTimeoutError("阿里千问 ASR 等待任务响应超时")
        ws.settimeout(min(1.0, remaining))
        try:
            raw = ws.recv()
        except Exception as error:
            if _is_websocket_timeout(error) and time.monotonic() < deadline:
                return None
            raise self._transport_error(error) from None
        if not raw:
            raise AliyunSTTConnectionError("阿里千问 ASR 在任务完成前断开连接")
        try:
            message = json.loads(raw)
        except (TypeError, ValueError):
            raise AliyunSTTProviderError("阿里千问 ASR 返回无效 JSON 事件") from None
        if not isinstance(message, dict) or not isinstance(message.get("header"), dict):
            raise AliyunSTTProviderError("阿里千问 ASR 返回无效事件结构")
        header = message["header"]
        if header.get("task_id") != task_id:
            return None
        if header.get("event") == "task-failed":
            raise _classify_task_failed(header, self.api_key, timeout_is_terminal=True)
        return message

    def transcribe(self, audio: np.ndarray, sample_rate: int = 16000,
                   position: str = "后端开发", language: str = "Python") -> str:
        if not self.api_key:
            raise AliyunSTTAuthError("阿里千问 ASR API Key 未配置")
        if not self.model:
            raise AliyunSTTProviderError("阿里千问 ASR 模型名称未配置")
        if websocket is None:
            raise AliyunSTTError("阿里千问 ASR 缺少 websocket-client 依赖")
        if audio.ndim != 1 or sample_rate <= 0:
            raise AliyunSTTError("阿里千问 ASR 需要单声道音频及有效采样率")
        if not len(audio):
            raise AliyunSTTEmptyResultError("阿里千问 ASR 音频为空")
        pcm = _audio_to_pcm_int16(audio).astype("<i2", copy=False)
        chunk_samples = max(1, int(sample_rate * self.CHUNK_MS / 1000))
        task_id = uuid.uuid4().hex
        header = {"task_id": task_id, "streaming": "duplex"}
        run_task = {
            "header": {**header, "action": "run-task"},
            "payload": {
                "task_group": "audio", "task": "asr", "function": "recognition",
                "model": self.model,
                "parameters": {"format": "pcm", "sample_rate": int(sample_rate)},
                "input": {},
            },
        }
        stop = threading.Event()
        uploaded = threading.Event()
        send_errors: list[AliyunSTTError] = []
        finish_sent_at: list[float] = []
        sentences: dict[int, str] = {}
        sender = None
        ws = None
        try:
            ws = websocket.create_connection(
                ALIYUN_ASR_WS_URL,
                header={"Authorization": f"Bearer {self.api_key}"},
                timeout=self.CONNECT_TIMEOUT_SEC,
                enable_multithread=True,
            )
            ws.send(json.dumps(run_task))
            startup_deadline = time.monotonic() + self.START_TIMEOUT_SEC
            while True:
                message = self._receive(ws, task_id, startup_deadline)
                if message and message["header"].get("event") == "task-started":
                    break

            upload_deadline = time.monotonic() + max(self.CONNECT_TIMEOUT_SEC, len(pcm) / sample_rate)

            # Upload and receive concurrently so server errors and finals are
            # consumed even while a long local VAD segment is being sent.
            def send_audio() -> None:
                try:
                    for offset in range(0, len(pcm), chunk_samples):
                        if stop.is_set():
                            return
                        if time.monotonic() >= upload_deadline:
                            raise AliyunSTTTimeoutError("阿里千问 ASR 音频发送超时")
                        ws.send_binary(pcm[offset:offset + chunk_samples].tobytes())
                    if not stop.is_set():
                        ws.send(json.dumps({
                            "header": {**header, "action": "finish-task"},
                            "payload": {"input": {}},
                        }))
                        finish_sent_at.append(time.monotonic())
                except Exception as error:
                    send_errors.append(error if isinstance(error, AliyunSTTError) else self._transport_error(error))
                finally:
                    uploaded.set()

            sender = threading.Thread(target=send_audio, name="aliyun-asr-send")
            sender.start()
            while True:
                if send_errors:
                    raise send_errors[0]
                deadline = finish_sent_at[0] + self.FINISH_TIMEOUT_SEC if finish_sent_at else upload_deadline
                message = self._receive(ws, task_id, deadline)
                if not message:
                    continue
                event = message["header"].get("event")
                if event == "task-finished":
                    if not uploaded.wait(timeout=max(0.0, upload_deadline - time.monotonic())):
                        raise AliyunSTTTimeoutError("阿里千问 ASR 音频发送超时")
                    if send_errors:
                        raise send_errors[0]
                    break
                if event == "result-generated":
                    sentence = message.get("payload", {}).get("output", {}).get("sentence", {})
                    if sentence.get("heartbeat") or not sentence.get("sentence_end"):
                        continue
                    sentence_id = sentence.get("sentence_id")
                    text = (sentence.get("text") or "").strip()
                    if not isinstance(sentence_id, int) or sentence_id < 1:
                        raise AliyunSTTProviderError("阿里千问 ASR 最终句子缺少有效 sentence_id")
                    if text:
                        sentences[sentence_id] = text
            result = _postprocess("".join(sentences[key] for key in sorted(sentences)))
            if not result.strip():
                raise AliyunSTTEmptyResultError("阿里千问 ASR 任务完成但返回空文本")
            return result
        except AliyunSTTError:
            raise
        except Exception as error:
            raise self._transport_error(error) from None
        finally:
            stop.set()
            if ws is not None:
                # Abort first to unblock a concurrent send before close waits
                # for the WebSocket write lock.
                try:
                    ws.abort()
                except Exception:
                    pass
                try:
                    ws.close(timeout=1)
                except Exception:
                    pass
            if sender is not None:
                sender.join()
