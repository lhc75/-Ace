import asyncio
import json
import time
from typing import Optional

import numpy as np
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status

from core.auth import is_auth_disabled, loopback_bypass_allowed, verify_token
from core.config import get_config
from core.logger import get_logger
from core.session import snapshot_session
from services.audio import AudioCapture, VADBuffer
from services.stt import get_stt_engine
from services.stt import transcribe_with_fallback

_log = get_logger("ws")

router = APIRouter()

ws_clients: set[WebSocket] = set()
_loop: Optional[asyncio.AbstractEventLoop] = None
_msg_queue: Optional[asyncio.Queue] = None
_broadcast_drop_count = 0

# 心跳/超时配置（秒）。25s 间隔可穿透多数代理 60s 空闲断连阈值。
HEARTBEAT_INTERVAL = 25
HEARTBEAT_TIMEOUT = 60
# 单条 send 的硬超时，避免某个客户端把整个并行 gather 拖慢过久。
SEND_TIMEOUT = 5.0


def init_broadcast(loop: asyncio.AbstractEventLoop, queue: asyncio.Queue):
    global _loop, _msg_queue, _broadcast_drop_count
    _loop = loop
    _msg_queue = queue
    _broadcast_drop_count = 0


async def _safe_send(ws: WebSocket, data: dict) -> bool:
    try:
        await asyncio.wait_for(ws.send_json(data), timeout=SEND_TIMEOUT)
        return True
    except asyncio.TimeoutError:
        _log.warning("WS send timeout, dropping client")
        return False
    except Exception:
        return False


async def ws_dispatcher():
    if _msg_queue is None:
        return
    _crash_backoff = 1
    while True:
        try:
            data = await _msg_queue.get()
            clients = list(ws_clients)
            if not clients:
                continue
            results = await asyncio.gather(
                *[_safe_send(ws, data) for ws in clients],
                return_exceptions=False,
            )
            dead = [ws for ws, ok in zip(clients, results) if not ok]
            if dead:
                for ws in dead:
                    ws_clients.discard(ws)
                    try:
                        await ws.close(code=status.WS_1011_INTERNAL_ERROR)
                    except Exception:
                        pass
            _crash_backoff = 1
        except Exception as e:
            _log.error("ws_dispatcher crashed (retry in %ds): %s", _crash_backoff, e, exc_info=True)
            await asyncio.sleep(_crash_backoff)
            _crash_backoff = min(_crash_backoff * 2, 60)


async def ws_heartbeat():
    """服务端主动心跳：定期 ping 客户端，长时间无 pong 视为僵尸连接并关闭。"""
    _crash_backoff = 1
    _crash_sleep = 0.0
    while True:
        try:
            await asyncio.sleep(HEARTBEAT_INTERVAL)
            now = time.monotonic()
            clients = list(ws_clients)
            if not clients:
                _crash_sleep = 0.0
                continue
            ping_msg = {"type": "ping", "ts": now}
            results = await asyncio.gather(
                *[_safe_send(ws, ping_msg) for ws in clients],
                return_exceptions=False,
            )
            effective_timeout = HEARTBEAT_TIMEOUT + _crash_sleep
            _crash_sleep = 0.0
            for ws, ok in zip(clients, results):
                if not ok:
                    ws_clients.discard(ws)
                    try:
                        await ws.close(code=status.WS_1011_INTERNAL_ERROR)
                    except Exception:
                        pass
                    continue
                last = getattr(ws, "_ia_last_pong", None) or getattr(ws, "_ia_connected_at", now)
                if now - last > effective_timeout:
                    _log.info("WS heartbeat timeout, closing stale client")
                    ws_clients.discard(ws)
                    try:
                        await ws.close(code=status.WS_1001_GOING_AWAY)
                    except Exception:
                        pass
            _crash_backoff = 1
        except Exception as e:
            _log.error("ws_heartbeat crashed (retry in %ds): %s", _crash_backoff, e, exc_info=True)
            _crash_sleep = _crash_backoff
            await asyncio.sleep(_crash_backoff)
            _crash_backoff = min(_crash_backoff * 2, 60)


def broadcast(data: dict):
    """Thread-safe broadcast to all connected WebSocket clients."""
    if _loop is None or _msg_queue is None:
        return
    _loop.call_soon_threadsafe(_enqueue_broadcast, data)


def _enqueue_broadcast(data: dict):
    global _broadcast_drop_count
    if _msg_queue is None:
        return
    try:
        _msg_queue.put_nowait(data)
    except asyncio.QueueFull:
        _broadcast_drop_count += 1
        if _broadcast_drop_count == 1 or _broadcast_drop_count % 25 == 0:
            _log.warning(
                "WS broadcast queue full; dropped=%d type=%s",
                _broadcast_drop_count,
                data.get("type"),
            )


def _ws_authorized(ws: WebSocket) -> bool:
    if is_auth_disabled():
        return True
    _client = getattr(ws, "client", None)
    client_host = _client.host if _client else None
    request_url = getattr(ws, "url", None)
    if loopback_bypass_allowed(
        client_host,
        ws.headers.get("origin"),
        getattr(request_url, "hostname", None),
        getattr(request_url, "scheme", "ws"),
        getattr(request_url, "port", None),
    ):
        return True
    token = ws.query_params.get("token")
    if not token:
        auth = ws.headers.get("authorization") or ""
        if auth.lower().startswith("bearer "):
            token = auth.split(None, 1)[1].strip()
    return verify_token(token)


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    if not _ws_authorized(ws):
        await ws.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    await ws.accept()
    now = time.monotonic()
    ws._ia_connected_at = now  # type: ignore[attr-defined]
    ws._ia_last_pong = now  # type: ignore[attr-defined]
    ws_clients.add(ws)
    _log.info("WS connect clients=%d", len(ws_clients))
    try:
        from api.assist.pipeline import is_transcribing

        snapshot = snapshot_session()
        try:
            engine = get_stt_engine()
            stt_state = {
                "stt_loaded": engine.is_loaded,
                "stt_loading": getattr(engine, "is_loading", False),
                "stt_provider": getattr(engine, "model_size", get_config().stt_provider),
            }
        except Exception as e:
            _log.warning("STT state unavailable during WS init: %s", e)
            stt_state = {"stt_loaded": False, "stt_loading": False, "stt_provider": get_config().stt_provider}
        await ws.send_json({
            "type": "init",
            "is_recording": snapshot["is_recording"],
            "is_paused": snapshot["is_paused"],
            **stt_state,
            "is_transcribing": is_transcribing(),
            "transcriptions": snapshot["transcriptions"],
            "candidate_transcriptions": snapshot.get("candidate_transcriptions", []),
            "candidate_answer_segments": snapshot.get("candidate_answer_segments", []),
            "qa_pairs": snapshot["qa_pairs"],
        })
        while True:
            data = await ws.receive_text()
            try:
                msg = json.loads(data)
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(msg, dict):
                mtype = msg.get("type")
                if mtype == "ping":
                    ws._ia_last_pong = time.monotonic()  # type: ignore[attr-defined]
                    await ws.send_json({"type": "pong"})
                elif mtype == "pong":
                    ws._ia_last_pong = time.monotonic()  # type: ignore[attr-defined]
    except WebSocketDisconnect:
        pass
    finally:
        ws_clients.discard(ws)
        _log.info("WS disconnect clients=%d", len(ws_clients))


@router.websocket("/ws/mobile-audio")
async def websocket_mobile_audio(ws: WebSocket):
    """Accept 16 kHz mono PCM16 from the phone microphone.

    The phone captures both its own speaker and the surrounding interviewer
    audio. Segments are transcribed locally by the desktop backend and fed
    into the same answer pipeline used by realtime assist.
    """
    if not _ws_authorized(ws):
        await ws.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    cfg = get_config()
    vad = VADBuffer(
        sample_rate=AudioCapture.SAMPLE_RATE,
        silence_threshold=float(getattr(cfg, "silence_threshold", 0.01) or 0.01),
        silence_duration=float(getattr(cfg, "silence_duration", 1.2) or 1.2),
        min_speech_duration=float(getattr(cfg, "assist_vad_min_speech_sec", 0.3) or 0.3),
        max_speech_duration=float(getattr(cfg, "assist_vad_max_speech_sec", 18.0) or 18.0),
        preroll_duration=0.24,
        rollover_duration=0.28,
    )
    segment_queue: asyncio.Queue = asyncio.Queue(maxsize=6)
    finished = object()

    async def transcribe_worker():
        from api.assist.pipeline import ingest_mobile_transcription

        while True:
            audio = await segment_queue.get()
            try:
                if audio is finished:
                    return
                broadcast({"type": "transcribing", "value": True})
                try:
                    text = await asyncio.to_thread(
                        transcribe_with_fallback,
                        audio,
                        AudioCapture.SAMPLE_RATE,
                        cfg.position,
                        cfg.language,
                        scope="interviewer",
                    )
                    if text.strip():
                        await asyncio.to_thread(ingest_mobile_transcription, text)
                except Exception as exc:
                    _log.error("mobile audio transcription failed: %s", exc, exc_info=True)
                    await ws.send_json({
                        "type": "mobile_audio_error",
                        "message": str(exc)[:200],
                    })
                finally:
                    broadcast({"type": "transcribing", "value": False})
            finally:
                segment_queue.task_done()

    worker = asyncio.create_task(transcribe_worker())
    await ws.accept()
    await ws.send_json({
        "type": "mobile_audio_ready",
        "sample_rate": AudioCapture.SAMPLE_RATE,
    })

    try:
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                break
            chunk = message.get("bytes")
            if chunk:
                audio = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0
                if len(audio) == 0:
                    continue
                level = float(np.sqrt(np.mean(audio ** 2)))
                await ws.send_json({"type": "mobile_audio_level", "value": level})
                segment = vad.feed(audio)
                if segment is not None:
                    try:
                        segment_queue.put_nowait(segment)
                    except asyncio.QueueFull:
                        await ws.send_json({
                            "type": "mobile_audio_error",
                            "message": "手机音频处理积压，已丢弃最旧片段",
                        })
                        _ = segment_queue.get_nowait()
                        segment_queue.task_done()
                        segment_queue.put_nowait(segment)
                continue

            text = message.get("text")
            if not text:
                continue
            try:
                payload = json.loads(text)
            except (json.JSONDecodeError, TypeError):
                continue
            if payload.get("type") == "stop":
                tail = vad.flush()
                if tail is not None:
                    await segment_queue.put(tail)
                break
    except WebSocketDisconnect:
        tail = vad.flush()
        if tail is not None:
            await segment_queue.put(tail)
    finally:
        await segment_queue.put(finished)
        await segment_queue.join()
        worker.cancel()
        await asyncio.gather(worker, return_exceptions=True)
