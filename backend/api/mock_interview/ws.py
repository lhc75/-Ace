"""AI 模拟面试专用麦克风实时转写 WebSocket。"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Optional

import numpy as np
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from api.realtime.ws import _ws_authorized
from core.config import get_config
from core.logger import get_logger
from services.audio import AudioCapture, VADBuffer
from services.stt import transcribe_with_fallback
from services.storage import mock_interview as store

router = APIRouter()
_log = get_logger("mock_interview.ws")


@router.websocket("/ws/mock-interview/audio")
async def mock_interview_audio(ws: WebSocket):
    if not _ws_authorized(ws):
        await ws.close(code=1008)
        return
    try:
        session_id = int(ws.query_params.get("session_id") or 0)
        question_id = (ws.query_params.get("question_id") or "").strip()
    except (TypeError, ValueError):
        await ws.close(code=1008)
        return
    detail = store.get_session_detail(session_id)
    question = store.get_question(session_id, question_id)
    if not detail or not question or question.get("phase") != "answering":
        await ws.close(code=1008)
        return

    cfg = get_config()
    vad = VADBuffer(
        sample_rate=AudioCapture.SAMPLE_RATE,
        silence_threshold=float(getattr(cfg, "silence_threshold", 0.01) or 0.01),
        silence_duration=max(0.7, min(2.0, float(getattr(cfg, "silence_duration", 1.2) or 1.2))),
        min_speech_duration=0.25,
        max_speech_duration=20.0,
        preroll_duration=0.24,
        rollover_duration=0.24,
    )
    segment_queue: asyncio.Queue = asyncio.Queue(maxsize=8)
    finished = object()
    send_lock = asyncio.Lock()

    async def send(payload: dict) -> None:
        try:
            async with send_lock:
                await ws.send_json(payload)
        except Exception:
            pass

    async def transcribe_worker() -> None:
        while True:
            audio = await segment_queue.get()
            try:
                if audio is finished:
                    return
                await send({"type": "transcribing", "value": True})
                text = await asyncio.to_thread(
                    transcribe_with_fallback,
                    audio,
                    AudioCapture.SAMPLE_RATE,
                    cfg.position,
                    cfg.whisper_language or cfg.language,
                    scope="mock_interview",
                )
                cleaned = " ".join(str(text or "").split()).strip()
                if cleaned:
                    await send(
                        {
                            "type": "segment_final",
                            "segment_id": f"seg_{uuid.uuid4().hex}",
                            "text": cleaned,
                            "duration_seconds": round(len(audio) / AudioCapture.SAMPLE_RATE, 2),
                            "timestamp": time.time(),
                        }
                    )
            except Exception as exc:
                _log.warning("mock interview ASR segment failed: %s", exc, exc_info=True)
                await send({"type": "asr_error", "message": str(exc)[:240]})
            finally:
                await send({"type": "transcribing", "value": False})
                segment_queue.task_done()

    await ws.accept()
    await send({"type": "ready", "sample_rate": AudioCapture.SAMPLE_RATE})
    worker = asyncio.create_task(transcribe_worker())
    try:
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                break
            chunk = message.get("bytes")
            if chunk:
                audio = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0
                if len(audio):
                    segment = vad.feed(audio)
                    if segment is not None:
                        try:
                            segment_queue.put_nowait(segment)
                        except asyncio.QueueFull:
                            try:
                                segment_queue.get_nowait()
                                segment_queue.task_done()
                            except asyncio.QueueEmpty:
                                pass
                            await send({"type": "asr_error", "message": "语音处理积压，已丢弃最旧片段"})
                            segment_queue.put_nowait(segment)
                continue
            raw = message.get("text")
            if not raw:
                continue
            try:
                payload = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
            if payload.get("type") == "stop":
                tail = vad.flush()
                if tail is not None:
                    await segment_queue.put(tail)
                break
    except WebSocketDisconnect:
        pass
    finally:
        tail = vad.flush()
        if tail is not None:
            try:
                segment_queue.put_nowait(tail)
            except asyncio.QueueFull:
                pass
        try:
            await segment_queue.put(finished)
        except asyncio.CancelledError:
            worker.cancel()
        await segment_queue.join()
        await worker
        await send({"type": "flushed"})
