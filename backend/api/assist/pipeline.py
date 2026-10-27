"""Interview assist pipeline: ASR buffering, task dispatch, parallel answer workers."""

import copy
import gc
import numpy as np
import queue
import time
import threading
from collections import deque
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Callable, Literal, Optional

from core.background import BoundedTaskWorker
from core.config import get_config, REMOTE_STT_PROVIDERS
from core.logger import get_interview_logger, get_logger
from core.session import get_session, reset_session, conversation_lock
from services import review_integration

_ilog = get_interview_logger()
_elog = get_logger("pipeline")
from services.audio import AudioCapture, VADBuffer, audio_capture
from services.stt import (
    build_asr_question_group_text,
    get_stt_engine,
    transcribe_with_fallback,
    transcription_for_publish,
    postprocess_interview_transcription,
)
from services.stt.aliyun import AliyunSTTError
from services.stt.aliyun_streaming import AliyunInterviewerStream
from services.stt.engines import GenericHTTPSTT, _audio_to_pcm_int16
from services.stt.generic_streaming import GenericInterimTranscriber
from api.common import get_model_health
from api.realtime.ws import broadcast
from api.assist.answer_worker import (
    AnswerWorkerDeps,
    process_question_parallel,
    prompt_server_screen_code,  # noqa: F401  # re-export：routes.py 经此处取用
)
from api.assist.asr_state import (
    AssistAsrStateMachine,
    PendingASRGroup,  # noqa: F401  # re-export：测试经此处构造分组
)
from api.assist.scheduler import (
    TaskPayload,
    begin_asr_turn as scheduler_begin_asr_turn,
    claim_next_dispatch,
    drain_commit_queue,
    is_asr_task,
    is_stale_inflight_asr_task,
    max_parallel_slots as scheduler_max_parallel_slots,
    pick_model_index as scheduler_pick_model_index,
    task_meta,
)

# ---------------------------------------------------------------------------
# Module state
# ---------------------------------------------------------------------------

_interview_thread: Optional[threading.Thread] = None
_interviewer_asr_thread: Optional[threading.Thread] = None
_candidate_thread: Optional[threading.Thread] = None
_candidate_audio_capture = AudioCapture()
_stop_event = threading.Event()
_pause_event = threading.Event()
_candidate_flush_event = threading.Event()
_candidate_whisper_preload_lock = threading.Lock()
_candidate_whisper_preload_inflight: set[tuple[str, str]] = set()
_interview_control_lock = threading.RLock()
_recording_generation_lock = threading.RLock()
_recording_generation = 0

# H4: 添加独立 flush 线程，避免阻塞音频采集主循环
_flush_thread: Optional[threading.Thread] = None
_flush_queue: queue.Queue = queue.Queue(maxsize=10)
_flush_stop_event = threading.Event()
_interviewer_segment_queue_maxsize = 12
_interviewer_segment_drain_timeout_sec = 1.5
_interviewer_vad_preroll_sec = 0.24
_interviewer_vad_rollover_sec = 0.28
_vad_feed_chunk_samples = 320

_answer_generation = 0
_gen_lock = threading.Lock()
_qa_replacement_versions: dict[str, int] = {}

_pending: list[tuple[TaskPayload, int, int]] = []
_dispatch_lock = threading.Lock()
_asr_state_lock = threading.RLock()
_in_flight_tasks: dict[int, tuple[int, TaskPayload]] = {}
_task_session_version = 0
_latest_asr_turn_id = 0

_commit_buffer: dict[int, Callable[[], None]] = {}
_skipped_commit_seqs: set[int] = set()
_next_commit_seq = 0
_next_submit_seq = 0
_commit_lock = threading.Lock()

_recent_asr_turn_monos: list[float] = []
_knowledge_worker: Optional[BoundedTaskWorker] = None
_asr_state = AssistAsrStateMachine(
    broadcast=lambda data: broadcast(data),
    submit_answer_task=lambda task: submit_answer_task(task),
    begin_asr_turn=lambda: _begin_asr_turn(),
    record_asr_turn=lambda now_mono: _record_asr_turn(now_mono),
    is_high_churn_submission=lambda cfg, now_mono: _is_high_churn_asr_submission(cfg, now_mono),
    append_late_constraint_tail=lambda text, source, now_mono: _append_late_asr_constraint_tail(text, source, now_mono),
    is_input_active=lambda: _is_interviewer_audio_active(),
    input_idle_sec=lambda: _input_idle_sec(),
    logger=_ilog,
)


@dataclass
class InterviewerSegment:
    audio: Any
    sample_rate: int
    started_mono: float
    ended_mono: float
    audio_sec: float
    flush_reason: Literal["silence", "max_speech", "pause_flush", "stop_flush"]
    capture_is_loopback: bool


class _InterviewerRuntime:
    def __init__(self):
        self.segment_queue: queue.Queue[InterviewerSegment] = queue.Queue(
            maxsize=_interviewer_segment_queue_maxsize
        )
        self.drain_event = threading.Event()
        self.raw_queue_drop_count = 0
        self.segment_emitted = 0
        self.segment_dropped = 0
        self.last_chunk_mono: Optional[float] = None
        self.last_chunk_audio_sec = 0.0
        self.last_speech_mono: Optional[float] = None
        self.vad_active = False
        self.asr_busy = False
        self.max_observed_segment_queue_depth = 0
        self.loopback_discontinuity_count = 0
        self.max_raw_chunk_samples = 0


_interviewer_runtime: Optional[_InterviewerRuntime] = None
_last_interviewer_runtime_snapshot: Optional[dict[str, Any]] = None


# 断线重连追平限速：每轮主循环在实时块之外最多额外补发的块数
# （8 块 × 64ms ≈ 512ms/轮，约 5 倍速追平；避免瞬间打爆流内部 50 块发送队列）。
_STREAM_BACKLOG_CATCHUP_CHUNKS = 8


class _InterviewerStreamBacklog:
    """千问流式断线重连期间的待上行音频缓冲（16kHz int16 PCM bytes）。

    音频一律先入队、再从头部泵出喂流：流不可用时只进不出，重连成功后按序
    追平，断线窗口内采集的音频不丢失且全局顺序不变。容量按字节封顶，超出时
    丢最旧块并计数（宁可丢旧音频也要保住实时性）。
    """

    def __init__(self, max_bytes: int):
        self._max_bytes = max(0, int(max_bytes))
        self._chunks: "deque[bytes]" = deque()
        self._bytes = 0
        self.dropped_chunks = 0
        self.dropped_bytes = 0
        self.pumped_chunks = 0

    def __len__(self) -> int:
        return len(self._chunks)

    @property
    def pending_bytes(self) -> int:
        return self._bytes

    def _trim_to_capacity(self) -> None:
        while self._chunks and self._bytes > self._max_bytes:
            old = self._chunks.popleft()
            self._bytes -= len(old)
            self.dropped_chunks += 1
            self.dropped_bytes += len(old)

    def append_many(self, chunks) -> None:
        for pcm in chunks:
            if not pcm:
                continue
            self._chunks.append(pcm)
            self._bytes += len(pcm)
        self._trim_to_capacity()

    def prepend_many(self, chunks) -> None:
        """死流退还的未发块时间最老，必须排在缓冲最前面。"""
        for pcm in reversed(list(chunks)):
            if not pcm:
                continue
            self._chunks.appendleft(pcm)
            self._bytes += len(pcm)
        self._trim_to_capacity()

    def pump(self, stream, max_chunks: int) -> int:
        """把缓冲头部的块按序喂给流；喂不进去（流终结）就停，块留在缓冲里。"""
        sent = 0
        while sent < max_chunks and self._chunks and stream.healthy:
            pcm = self._chunks[0]
            if not stream.feed(pcm):
                break
            self._chunks.popleft()
            self._bytes -= len(pcm)
            sent += 1
        self.pumped_chunks += sent
        return sent

    def clear(self) -> None:
        self._chunks.clear()
        self._bytes = 0


def _new_stream_backlog(cfg) -> Optional[_InterviewerStreamBacklog]:
    """按配置创建回补缓冲；assist_stream_reconnect_buffer_sec<=0 时返回 None（旧行为）。"""
    sec = float(getattr(cfg, "assist_stream_reconnect_buffer_sec", 30.0) or 0.0)
    if sec <= 0:
        return None
    # 16kHz × 16bit 单声道 = 32KB/s
    return _InterviewerStreamBacklog(max_bytes=int(sec * 16000 * 2))



def _is_interviewer_audio_active() -> bool:
    runtime = _interviewer_runtime
    if runtime is None:
        return False
    return bool(
        runtime.vad_active
        or runtime.asr_busy
        or _interviewer_segment_backlog(runtime) > 0
    )


def _input_idle_sec() -> float:
    """Seconds since the interviewer audio last carried speech energy."""
    runtime = _interviewer_runtime
    if runtime is None or runtime.last_speech_mono is None:
        return float("inf")
    return max(0.0, time.monotonic() - runtime.last_speech_mono)


def _capture_recording_generation() -> int:
    with _recording_generation_lock:
        return _recording_generation


def _recording_generation_is_current(generation: int) -> bool:
    with _recording_generation_lock:
        return generation == _recording_generation


# ---------------------------------------------------------------------------
# ASR merge / question grouping
# ---------------------------------------------------------------------------

def _reset_asr_merge_buffer_locked():
    _asr_state.reset_merge_buffer()


def _reset_asr_merge_buffer():
    with _asr_state_lock:
        _reset_asr_merge_buffer_locked()


def _reset_pending_asr_group_locked():
    _asr_state.reset_pending_group()


def _reset_pending_asr_group():
    with _asr_state_lock:
        _reset_pending_asr_group_locked()


def _prune_recent_asr_turns_locked(now_mono: float, window_sec: float = 6.0):
    global _recent_asr_turn_monos
    _recent_asr_turn_monos = [
        ts for ts in _recent_asr_turn_monos
        if now_mono - ts <= window_sec
    ]


def _is_high_churn_asr_submission(cfg, now_mono: float) -> bool:
    if not bool(getattr(cfg, "assist_high_churn_short_answer", False)):
        return False
    with _dispatch_lock:
        _prune_recent_asr_turns_locked(now_mono)
        has_active_asr = any(
            _is_asr_task(task) and not _is_stale_inflight_asr_task(task)
            for _model_idx, task in _in_flight_tasks.values()
        )
        has_recent_turn = bool(_recent_asr_turn_monos)
    return has_active_asr or has_recent_turn


def _record_asr_turn(now_mono: float):
    with _dispatch_lock:
        _prune_recent_asr_turns_locked(now_mono)
        _recent_asr_turn_monos.append(now_mono)


def _task_meta(task: TaskPayload) -> dict[str, Any]:
    return task_meta(task)


def _is_asr_task(task: TaskPayload) -> bool:
    return is_asr_task(task)


def _is_stale_inflight_asr_task(task: TaskPayload) -> bool:
    return is_stale_inflight_asr_task(task, _latest_asr_turn_id)


def _assist_vad_min_speech_sec(cfg) -> float:
    return max(0.1, float(getattr(cfg, "assist_vad_min_speech_sec", 0.3) or 0.3))


def _assist_vad_min_samples(cfg) -> int:
    return int(AudioCapture.SAMPLE_RATE * _assist_vad_min_speech_sec(cfg))


def _new_interviewer_runtime() -> _InterviewerRuntime:
    return _InterviewerRuntime()


def _set_interviewer_runtime(runtime: Optional[_InterviewerRuntime]) -> None:
    global _interviewer_runtime
    _interviewer_runtime = runtime


def _set_last_interviewer_runtime_snapshot(snapshot: Optional[dict[str, Any]]) -> None:
    global _last_interviewer_runtime_snapshot
    _last_interviewer_runtime_snapshot = dict(snapshot) if snapshot is not None else None


def _snapshot_interviewer_runtime(
    runtime: _InterviewerRuntime,
    *,
    live: bool,
    drained: Optional[bool] = None,
    remaining_after_drain: Optional[int] = None,
) -> dict[str, Any]:
    snapshot = {
        "live": bool(live),
        "raw_queue_drop_count": int(runtime.raw_queue_drop_count),
        "loopback_discontinuity_count": int(runtime.loopback_discontinuity_count),
        "segment_emitted": int(runtime.segment_emitted),
        "segment_dropped": int(runtime.segment_dropped),
        "segment_queue_depth": int(runtime.segment_queue.qsize()),
        "segment_backlog": int(_interviewer_segment_backlog(runtime)),
        "max_observed_segment_queue_depth": int(runtime.max_observed_segment_queue_depth),
        "max_raw_chunk_samples": int(runtime.max_raw_chunk_samples),
    }
    if drained is not None:
        snapshot["drained"] = bool(drained)
        snapshot["drain_timed_out"] = not bool(drained)
    if remaining_after_drain is not None:
        snapshot["remaining_after_drain"] = int(remaining_after_drain)
    return snapshot


def get_interviewer_runtime_snapshot() -> Optional[dict[str, Any]]:
    runtime = _interviewer_runtime
    if runtime is not None:
        return _snapshot_interviewer_runtime(runtime, live=True)
    if _last_interviewer_runtime_snapshot is None:
        return None
    return dict(_last_interviewer_runtime_snapshot)


def is_transcribing() -> bool:
    runtime = _interviewer_runtime
    return bool(runtime is not None and runtime.asr_busy)


def _log_interviewer_chunk_gap(
    runtime: _InterviewerRuntime,
    batch_started_mono: float,
    batch_audio_sec: float,
) -> None:
    if runtime.last_chunk_mono is not None:
        expected_next_started = runtime.last_chunk_mono + max(0.0, runtime.last_chunk_audio_sec)
        gap_ms = (batch_started_mono - expected_next_started) * 1000.0
        if gap_ms >= 250:
            _ilog.warning("INTERVIEWER_CHUNK_GAP gap_ms=%.0f", gap_ms)
    runtime.last_chunk_mono = batch_started_mono
    runtime.last_chunk_audio_sec = max(0.0, float(batch_audio_sec or 0.0))


def _refresh_interviewer_raw_drop_count(runtime: _InterviewerRuntime) -> None:
    snapshot_fn = getattr(audio_capture, "capture_stats_snapshot", None)
    if callable(snapshot_fn):
        try:
            capture_stats = snapshot_fn()
        except Exception:
            capture_stats = None
        if isinstance(capture_stats, dict):
            runtime.raw_queue_drop_count = int(
                capture_stats.get("dropped_chunks_count", runtime.raw_queue_drop_count)
            )
            runtime.loopback_discontinuity_count = int(
                capture_stats.get("loopback_discontinuity_count", runtime.loopback_discontinuity_count)
            )
            runtime.max_raw_chunk_samples = int(
                capture_stats.get("max_queue_chunk_samples", runtime.max_raw_chunk_samples)
            )
            return
    dropped = getattr(audio_capture, "dropped_chunks_count", None)
    if dropped is None:
        return
    runtime.raw_queue_drop_count = int(dropped)


def _interviewer_segment_backlog(runtime: _InterviewerRuntime) -> int:
    unfinished = getattr(runtime.segment_queue, "unfinished_tasks", None)
    if unfinished is None:
        return runtime.segment_queue.qsize()
    return max(0, int(unfinished))


def _emit_interviewer_segment(
    runtime: _InterviewerRuntime,
    segment: InterviewerSegment,
) -> None:
    try:
        runtime.segment_queue.put_nowait(segment)
        runtime.segment_emitted += 1
        depth = runtime.segment_queue.qsize()
        runtime.max_observed_segment_queue_depth = max(
            runtime.max_observed_segment_queue_depth, depth
        )
        _ilog.info(
            "INTERVIEWER_SEGMENT_EMITTED flush_reason=%s audio_sec=%.2f queue_depth=%d",
            segment.flush_reason,
            segment.audio_sec,
            depth,
        )
    except queue.Full:
        dropped = None
        try:
            dropped = runtime.segment_queue.get_nowait()
            runtime.segment_queue.task_done()
        except queue.Empty:
            dropped = None
        if dropped is not None:
            runtime.segment_dropped += 1
        try:
            runtime.segment_queue.put_nowait(segment)
            runtime.segment_emitted += 1
            depth = runtime.segment_queue.qsize()
            runtime.max_observed_segment_queue_depth = max(
                runtime.max_observed_segment_queue_depth, depth
            )
        except queue.Full:
            runtime.segment_dropped += 1
            depth = runtime.segment_queue.qsize()
        _elog.warning(
            "INTERVIEWER_SEGMENT_QUEUE_FULL flush_reason=%s audio_sec=%.2f dropped_total=%d queue_depth=%d",
            segment.flush_reason,
            segment.audio_sec,
            runtime.segment_dropped,
            depth,
        )


def _maybe_build_interviewer_segment(
    cfg,
    runtime: _InterviewerRuntime,
    session,
    speech_audio,
    *,
    flush_reason: Literal["silence", "max_speech", "pause_flush", "stop_flush"],
    segment_started_mono: float,
    segment_ended_mono: float,
    streaming_active: bool = False,
) -> bool:
    if speech_audio is None:
        return False
    if streaming_active:
        # 实时流已经在采集时收到这段音频，流健康时跳过逐段上传，避免重复识别与重复计费。
        return False
    min_interviewer_samples = _assist_vad_min_samples(cfg)
    if len(speech_audio) < min_interviewer_samples:
        return False
    audio_sec = len(speech_audio) / AudioCapture.SAMPLE_RATE
    ended_mono = max(0.0, float(segment_ended_mono))
    started_mono = max(0.0, min(float(segment_started_mono), ended_mono))
    if ended_mono - started_mono + 1e-6 < audio_sec:
        started_mono = max(0.0, ended_mono - audio_sec)
    segment = InterviewerSegment(
        audio=speech_audio,
        sample_rate=AudioCapture.SAMPLE_RATE,
        started_mono=started_mono,
        ended_mono=ended_mono,
        audio_sec=audio_sec,
        flush_reason=flush_reason,
        capture_is_loopback=bool(getattr(session, "capture_is_loopback", False)),
    )
    _emit_interviewer_segment(runtime, segment)
    return True


def _drain_interviewer_segments(timeout_sec: float) -> tuple[bool, int]:
    runtime = _interviewer_runtime
    if runtime is None:
        return True, 0
    deadline = time.monotonic() + max(0.0, timeout_sec)
    while time.monotonic() < deadline:
        if _interviewer_segment_backlog(runtime) == 0:
            return True, 0
        time.sleep(0.02)
    remaining = _interviewer_segment_backlog(runtime)
    return remaining == 0, remaining


def _interviewer_segment_drain_timeout() -> float:
    return max(
        0.5,
        min(
            30.0,
            float(
                getattr(
                    get_config(),
                    "assist_interviewer_asr_drain_timeout_sec",
                    _interviewer_segment_drain_timeout_sec,
                )
                or _interviewer_segment_drain_timeout_sec
            ),
        ),
    )


def _stop_capture_compat(capture, *, owner: str, clear_queue: bool) -> None:
    try:
        capture.stop(owner=owner, clear_queue=clear_queue)
    except TypeError:
        capture.stop(owner=owner)


def _start_interview_worker_thread_if_needed() -> None:
    global _interview_thread
    if _interview_thread and _interview_thread.is_alive():
        return
    _interview_thread = threading.Thread(
        target=_interview_worker,
        args=(_capture_recording_generation(),),
        daemon=True,
    )
    _interview_thread.start()


def _publishable_transcription(text: str, cfg, *, min_sig: Optional[int] = None) -> str:
    """清洗 + 有效字符过滤，返回可发布的转写文本（不达标返回空串）。"""
    sig = min_sig if min_sig is not None else getattr(cfg, "transcription_min_sig_chars", 2)
    return transcription_for_publish(postprocess_interview_transcription(text), sig)


def _candidate_min_sig(cfg) -> int:
    """候选人口述的有效字符下限比面试官高: 过滤语气词/碎句, 避免噪音进入复盘。"""
    return max(3, int(getattr(cfg, "transcription_min_sig_chars", 2) or 2))


def _signal_flush_tick(session, now_mono: float) -> None:
    """通知 flush worker 跑一次合并缓冲检查；队列满则说明已有待处理 tick，直接跳过。"""
    try:
        _flush_queue.put_nowait((get_config(), session, now_mono))
    except queue.Full:
        pass


def _flush_vad_remainder(
    runtime: _InterviewerRuntime,
    vad: VADBuffer,
    cfg,
    session,
    recording_generation: int,
    stream: Optional[AliyunInterviewerStream],
    generic_interim: Optional[GenericInterimTranscriber],
    flush_reason: Literal["pause_flush", "stop_flush"],
) -> None:
    """暂停/停止时排空 VAD 尾段：刷新丢包统计、排空采集缓冲、把剩余语音切成最后一个 segment。"""
    _refresh_interviewer_raw_drop_count(runtime)
    _drain_remaining_interviewer_audio_chunks(
        runtime, vad, cfg, session, recording_generation, stream=stream,
        interim_transcriber=generic_interim,
    )
    remaining = vad.flush()
    if remaining is not None:
        if generic_interim is not None and generic_interim.healthy:
            generic_interim.finalize(remaining)
        remaining_end_mono = time.monotonic()
        _maybe_build_interviewer_segment(
            cfg,
            runtime,
            session,
            remaining,
            flush_reason=flush_reason,
            segment_started_mono=max(
                0.0,
                remaining_end_mono - (len(remaining) / AudioCapture.SAMPLE_RATE),
            ),
            segment_ended_mono=remaining_end_mono,
            streaming_active=(
                (stream is not None and stream.healthy)
                or (generic_interim is not None and generic_interim.healthy)
            ),
        )
    runtime.vad_active = False


def _drain_remaining_interviewer_audio_chunks(
    runtime: _InterviewerRuntime,
    vad: VADBuffer,
    cfg,
    session,
    recording_generation: Optional[int] = None,
    stream: Optional[AliyunInterviewerStream] = None,
    interim_transcriber: Optional[GenericInterimTranscriber] = None,
) -> None:
    while True:
        with _recording_generation_lock:
            if recording_generation is not None and not _recording_generation_is_current(recording_generation):
                return
            chunks = audio_capture.drain_audio_chunks(timeout=0.0, max_chunks=6)
        if not chunks:
            break
        streaming_active = (
            (stream is not None and stream.healthy)
            or (interim_transcriber is not None and interim_transcriber.healthy)
        )
        if stream is not None and stream.healthy:
            for raw_chunk in chunks:
                stream.feed(_audio_to_pcm_int16(raw_chunk).astype("<i2", copy=False).tobytes())
        now = time.monotonic()
        offset_samples = 0
        total_samples = sum(len(chunk) for chunk in chunks)
        batch_end_mono = now
        batch_start_mono = max(0.0, batch_end_mono - (total_samples / AudioCapture.SAMPLE_RATE))
        _log_interviewer_chunk_gap(
            runtime,
            batch_start_mono,
            total_samples / AudioCapture.SAMPLE_RATE,
        )
        for chunk in chunks:
            offset_samples += len(chunk)
            chunk_ended_mono = batch_start_mono + (offset_samples / AudioCapture.SAMPLE_RATE)
            speech_audio = vad.feed(chunk)
            runtime.vad_active = bool(getattr(vad, "has_pending_audio", False))
            if speech_audio is None:
                continue
            if interim_transcriber is not None and interim_transcriber.healthy:
                interim_transcriber.finalize(speech_audio)
            flush_reason = getattr(vad, "last_flush_reason", None) or "silence"
            segment_ended_mono = chunk_ended_mono
            segment_started_mono = max(
                0.0,
                segment_ended_mono - (len(speech_audio) / AudioCapture.SAMPLE_RATE),
            )
            _maybe_build_interviewer_segment(
                cfg,
                runtime,
                session,
                speech_audio,
                flush_reason=(
                    "max_speech"
                    if flush_reason == "max_speech"
                    else "silence"
                ),
                segment_started_mono=segment_started_mono,
                segment_ended_mono=segment_ended_mono,
                streaming_active=streaming_active,
            )


def _iter_vad_feed_chunks(audio_chunk: np.ndarray):
    frame = max(1, int(_vad_feed_chunk_samples))
    total = len(audio_chunk)
    for start in range(0, total, frame):
        yield audio_chunk[start:start + frame]


# ---------------------------------------------------------------------------
# Generation control
# ---------------------------------------------------------------------------

def _bump_generation():
    global _answer_generation
    with _gen_lock:
        _answer_generation += 1


def _capture_generation() -> int:
    with _gen_lock:
        return _answer_generation


def _reset_answer_state():
    global _pending, _in_flight_tasks, _commit_buffer, _skipped_commit_seqs, _next_commit_seq, _task_session_version, _latest_asr_turn_id, _recent_asr_turn_monos, _qa_replacement_versions
    with _asr_state_lock:
        with _dispatch_lock:
            _pending.clear()
            _in_flight_tasks.clear()
            _qa_replacement_versions.clear()
            _latest_asr_turn_id = 0
            _recent_asr_turn_monos = []
            _task_session_version += 1
            next_commit_seq = _next_submit_seq
        _reset_asr_merge_buffer_locked()
        _reset_pending_asr_group_locked()
    # commit 相关操作单独处理
    with _commit_lock:
        _commit_buffer.clear()
        _skipped_commit_seqs.clear()
        _next_commit_seq = next_commit_seq


def cancel_answer_work(reset_session_data: bool = False):
    _bump_generation()
    _reset_answer_state()
    if reset_session_data:
        with conversation_lock:
            reset_session()


def _qa_replacement_version(qa_id: str) -> int:
    with _dispatch_lock:
        return int(_qa_replacement_versions.get((qa_id or "").strip(), 0))


def prepare_answer_replacement(qa_id: str) -> int:
    """Invalidate queued/in-flight work for one QA pair without global cancel."""
    target = (qa_id or "").strip()
    if not target:
        return 0
    skipped: list[int] = []
    with _dispatch_lock:
        version = int(_qa_replacement_versions.get(target, 0)) + 1
        _qa_replacement_versions[target] = version
        kept: list[tuple[TaskPayload, int, int]] = []
        for task, seq, session_version in _pending:
            task_qa_id = str(_task_meta(task).get("qa_id") or "").strip()
            if task_qa_id == target:
                skipped.append(seq)
                continue
            kept.append((task, seq, session_version))
        _pending[:] = kept
    for seq in skipped:
        _mark_seq_skipped(seq)
    _try_dispatch()
    return version


def init_background_workers():
    global _knowledge_worker
    if _knowledge_worker is None:
        _knowledge_worker = BoundedTaskWorker(
            "assist.knowledge_worker",
            _save_knowledge_record,
            maxsize=64,
        )
    _knowledge_worker.start()


def shutdown_background_workers():
    global _knowledge_worker
    if _knowledge_worker is None:
        return
    _knowledge_worker.stop()


def _submit_knowledge_record(
    question: str,
    answer: str,
    qa_id: str = "",
    candidate_answer: str = "",
) -> bool:
    worker = _knowledge_worker
    if worker is None:
        _save_knowledge_record("save", question, answer, qa_id, candidate_answer)
        return True
    return worker.submit("save", question, answer, qa_id, candidate_answer)


def _submit_candidate_knowledge_update(qa_id: str, candidate_answer: str) -> bool:
    if not (qa_id or "").strip() or not (candidate_answer or "").strip():
        return False
    worker = _knowledge_worker
    if worker is None:
        _save_knowledge_record("candidate_update", qa_id, candidate_answer)
        return True
    return worker.submit("candidate_update", qa_id, candidate_answer)


# ---------------------------------------------------------------------------
# Model dispatch
# ---------------------------------------------------------------------------

def _drain_commit_queue_locked():
    global _next_commit_seq
    _next_commit_seq = drain_commit_queue(
        _commit_buffer,
        _skipped_commit_seqs,
        _next_commit_seq,
    )


def _mark_seq_skipped(seq: int):
    with _commit_lock:
        if seq < _next_commit_seq:
            return
        _skipped_commit_seqs.add(seq)
        _drain_commit_queue_locked()


def _answer_work_idle() -> bool:
    with _dispatch_lock:
        pending = bool(_pending)
        in_flight = bool(_in_flight_tasks)
    with _commit_lock:
        commits = bool(_commit_buffer)
    return not pending and not in_flight and not commits


def _wait_for_answer_work_idle(timeout_sec: float) -> bool:
    deadline = time.monotonic() + max(0.0, timeout_sec)
    while time.monotonic() < deadline:
        if _answer_work_idle():
            return True
        time.sleep(0.05)
    return _answer_work_idle()


def _begin_asr_turn() -> int:
    global _latest_asr_turn_id
    with _dispatch_lock:
        _latest_asr_turn_id, skipped = scheduler_begin_asr_turn(
            _pending,
            _latest_asr_turn_id,
            interrupt_pending_asr=False,
        )
        turn_id = _latest_asr_turn_id
    for seq in skipped:
        _mark_seq_skipped(seq)
    return turn_id


def pick_model_index(
    task: TaskPayload,
    busy: set[int],
    avoid_models: Optional[set[int]] = None,
) -> Optional[int]:
    return scheduler_pick_model_index(
        task,
        busy,
        get_config(),
        get_model_health,
        avoid_models=avoid_models,
    )


def submit_answer_task(task: TaskPayload) -> bool:
    global _next_submit_seq
    if pick_model_index(task, set()) is None:
        broadcast(
            {
                "type": "error",
                "message": "\u6ca1\u6709\u53ef\u7528\u7684\u7b54\u9898\u6a21\u578b\uff1a\u8bf7\u81f3\u5c11\u542f\u7528\u4e00\u4e2a\u5df2\u914d\u7f6e API Key \u7684\u6a21\u578b\uff08\u8bc6\u56fe\u9898\u9700\u8bc6\u56fe\u6a21\u578b\uff09\u3002",
            }
        )
        return False
    with _dispatch_lock:
        seq = _next_submit_seq
        _next_submit_seq += 1
        tv = _task_session_version
        raw_meta = dict(_task_meta(task) or {})
        replace_qa_id = str(raw_meta.get("replace_qa_id") or "").strip()
        qa_id = replace_qa_id or str(raw_meta.get("qa_id") or "").strip()
        if not qa_id:
            qa_id = f"qa-{seq}-{int(time.time() * 1000)}"
        replacement_version = (
            int(_qa_replacement_versions.get(qa_id, 0))
            if replace_qa_id
            else int(raw_meta.get("replacement_generation", 0) or 0)
        )
        raw_meta.update({
            "qa_id": qa_id,
            "replacement_generation": replacement_version,
        })
        queued_task: TaskPayload = (
            task[0],
            task[1],
            task[2],
            task[3],
            raw_meta,
        )
        _pending.append((queued_task, seq, tv))
        delay = max(0.0, float(raw_meta.get("dispatch_after_mono", 0.0) or 0.0) - time.monotonic())
    _try_dispatch()
    if delay > 0:
        timer = threading.Timer(delay, _try_dispatch)
        timer.daemon = True
        timer.start()
    return True


# ---------------------------------------------------------------------------
# ASR question group handling
# ---------------------------------------------------------------------------

def _flush_asr_question_group_now(cfg, session) -> None:
    with _asr_state_lock:
        _asr_state.flush_question_group_now(cfg, session)


def _try_flush_asr_question_group(cfg, session, now_mono: float, force: bool = False) -> None:
    with _asr_state_lock:
        _asr_state.try_flush_question_group(cfg, session, now_mono, force)


def _handle_auto_detect_asr_text(cfg, session, pub: str, source: str, now_mono: float) -> None:
    with _asr_state_lock:
        _asr_state.handle_auto_detect_asr_text(cfg, session, pub, source, now_mono)


def _append_late_asr_constraint_tail(text: str, source: str, now_mono: float) -> bool:
    cleaned = (text or "").strip()
    if not cleaned:
        return False
    with _dispatch_lock:
        for idx in range(len(_pending) - 1, -1, -1):
            task, seq, session_version = _pending[idx]
            question, image, manual_input, task_source, meta = task
            if not _is_asr_task(task) or task_source != source:
                continue
            grace_until = float(meta.get("asr_tail_grace_until_mono", 0.0) or 0.0)
            if grace_until and now_mono > grace_until:
                continue
            utterances = [str(item).strip() for item in (meta.get("utterances") or []) if str(item).strip()]
            if not utterances:
                utterances = [str(question or "").strip()]
            if cleaned in utterances:
                return True
            utterances.append(cleaned)
            updated_question = build_asr_question_group_text(utterances) or f"{question}\n{cleaned}".strip()
            updated_meta = {**meta, "utterances": utterances, "late_constraint_tail": True}
            _pending[idx] = (
                (updated_question, image, manual_input, task_source, updated_meta),
                seq,
                session_version,
            )
            _ilog.info(
                "ASR_LATE_CONSTRAINT_MERGED seq=%d text=%r question=%r",
                seq,
                cleaned[:80],
                updated_question[:150],
            )
            return True
    return False


# ---------------------------------------------------------------------------
# ASR merge buffer
# ---------------------------------------------------------------------------

def _try_flush_asr_merge_buffer(cfg, session, now_mono: float, force: bool = False) -> None:
    with _asr_state_lock:
        _asr_state.try_flush_merge_buffer(cfg, session, now_mono, force)


def _append_transcription_fragment(cfg, session, pub: str, now_mono: float, force_flush_tail: bool = False) -> None:
    with _asr_state_lock:
        _asr_state.append_transcription_fragment(cfg, session, pub, now_mono, force_flush_tail)


def _publish_stream_fragment(cfg, session, pub: str, now_mono: float) -> None:
    with _asr_state_lock:
        _asr_state.publish_stream_fragment(cfg, session, pub, now_mono)


def _set_stream_mode(enabled: bool) -> None:
    with _asr_state_lock:
        _asr_state.stream_mode = enabled


# ---------------------------------------------------------------------------
# Dispatch / worker
# ---------------------------------------------------------------------------

def _try_dispatch():
    while True:
        # Keep model selection and the model object passed to the worker tied
        # to one immutable configuration snapshot. Settings updates replace
        # the global config while a worker may still be waiting to start.
        cfg = get_config()

        def _pick_from_snapshot(
            task: TaskPayload,
            busy: set[int],
            avoid_models: Optional[set[int]] = None,
            cfg_snapshot=cfg,
        ) -> Optional[int]:
            return scheduler_pick_model_index(
                task,
                busy,
                cfg_snapshot,
                get_model_health,
                avoid_models=avoid_models,
            )

        with _dispatch_lock:
            step = claim_next_dispatch(
                _pending,
                _in_flight_tasks,
                _latest_asr_turn_id,
                scheduler_max_parallel_slots(cfg, get_model_health),
                _pick_from_snapshot,
                interrupt_stale_asr=False,
                now_mono=time.monotonic(),
            )
            model_cfg_snapshot = None
            config_snapshot = None
            if step.claim is not None:
                selected_idx = step.claim.model_idx
                if 0 <= selected_idx < len(cfg.models):
                    # Keep model selection and every prompt/generation option
                    # tied to the same immutable configuration generation.
                    # update_config() replaces the global object while a
                    # worker may be queued; copying only the model used to
                    # let written-exam/KB/token settings drift underneath it.
                    config_snapshot = copy.deepcopy(cfg)
                    model_cfg_snapshot = copy.deepcopy(config_snapshot.models[selected_idx])
        if step.skipped_seq is not None:
            _mark_seq_skipped(step.skipped_seq)
            continue
        if step.claim is None:
            return
        threading.Thread(
            target=_run_answer_worker,
            args=(
                step.claim.task,
                step.claim.seq,
                step.claim.model_idx,
                step.claim.session_version,
                model_cfg_snapshot,
                config_snapshot,
            ),
            daemon=True,
        ).start()


def _run_answer_worker(
    task: TaskPayload,
    seq: int,
    model_idx: int,
    sess_v: int,
    model_cfg_snapshot=None,
    config_snapshot=None,
):
    try:
        _process_question_parallel(
            task,
            seq,
            model_idx,
            sess_v,
            model_cfg_snapshot,
            config_snapshot,
        )
    finally:
        with _dispatch_lock:
            _in_flight_tasks.pop(seq, None)
        _try_dispatch()


def _flush_commit(seq: int, apply_fn: Callable[[], None]):
    with _commit_lock:
        if seq < _next_commit_seq:
            return
        _commit_buffer[seq] = apply_fn
        _drain_commit_queue_locked()


# ---------------------------------------------------------------------------
# Interview loop
# ---------------------------------------------------------------------------

# PortAudio device indices are 0-based. Never reuse 0 as "unset".
_UNSET_DEVICE_ID = -1


def _device_is_loopback(device_id: Optional[int]) -> bool:
    if device_id is None:
        return False
    for d in AudioCapture.list_devices():
        if d["id"] == device_id:
            return bool(d["is_loopback"])
    return False


def _normalize_stored_device_id(value: Any, *, fallback: int = _UNSET_DEVICE_ID) -> int:
    """Coerce session/API device ids; negative or invalid → unset sentinel."""
    if value is None:
        return fallback
    try:
        device_id = int(value)
    except (TypeError, ValueError):
        return fallback
    return device_id if device_id >= 0 else fallback


def _is_valid_device_id(value: Any) -> bool:
    try:
        return value is not None and int(value) >= 0
    except (TypeError, ValueError):
        return False


def start_nonblocking(device_id: Optional[int] = None, candidate_mic_device_id: Optional[int] = None):
    with _interview_control_lock:
        return _start_nonblocking_locked(device_id, candidate_mic_device_id)


def _start_nonblocking_locked(device_id: Optional[int], candidate_mic_device_id: Optional[int]):
    global _recording_generation
    global _interview_thread, _candidate_thread
    stop_interview_loop()
    _set_last_interviewer_runtime_snapshot(None)
    with _recording_generation_lock:
        _recording_generation += 1
        recording_generation = _recording_generation
        _stop_event.clear()
        _pause_event.clear()
        _candidate_flush_event.clear()

    session = get_session()
    capture_is_loopback = bool(getattr(session, "capture_is_loopback", False))
    review_candidate_device_id: Optional[int] = None

    if device_id is not None:
        capture_is_loopback = _device_is_loopback(device_id)

        # mic_agc 只对麦克风路径生效（loopback 路径本来就有 AGC）；默认 False 不改变旧行为。
        audio_capture.start(
            device_id,
            owner="assist",
            mic_agc=bool(getattr(get_config(), "mic_agc_enabled", False)),
        )

        with conversation_lock:
            session.last_device_id = int(device_id)
            session.capture_is_loopback = capture_is_loopback
        _ilog.info("INTERVIEW_START device=%s loopback=%s", device_id, capture_is_loopback)
    else:
        with conversation_lock:
            session.last_device_id = _UNSET_DEVICE_ID
            session.last_candidate_mic_device_id = _UNSET_DEVICE_ID
            session.capture_is_loopback = False
        _ilog.info("INTERVIEW_START no_device (written_exam_mode)")

    with conversation_lock:
        session.is_recording = True
        session.is_paused = False

    broadcast({"type": "recording", "value": True})
    broadcast({"type": "paused", "value": False})

    if device_id is not None:
        _start_interview_worker_thread_if_needed()

    cfg = get_config()
    if (
        device_id is not None
        and candidate_mic_device_id is not None
        and bool(getattr(cfg, "candidate_asr_enabled", False))
        and int(candidate_mic_device_id) != int(device_id)
    ):
        try:
            _candidate_audio_capture.start(
                int(candidate_mic_device_id),
                owner="assist-candidate",
                mic_compatibility_mode=bool(getattr(cfg, "candidate_mic_compatibility_mode", True)),
                mic_agc=bool(getattr(cfg, "mic_agc_enabled", False)),
            )
            with conversation_lock:
                session.last_candidate_mic_device_id = int(candidate_mic_device_id)
            _candidate_thread = threading.Thread(
                target=_candidate_worker, args=(recording_generation,), daemon=True
            )
            _candidate_thread.start()
            review_candidate_device_id = int(candidate_mic_device_id)
            _ilog.info("CANDIDATE_ASR_START device=%s", candidate_mic_device_id)
        except Exception as exc:
            with conversation_lock:
                session.last_candidate_mic_device_id = _UNSET_DEVICE_ID
            _elog.warning("CANDIDATE_ASR_START_FAIL device=%s err=%s", candidate_mic_device_id, exc)
            _broadcast_candidate_asr_error(str(exc)[:160])
    elif device_id is not None:
        with conversation_lock:
            session.last_candidate_mic_device_id = _UNSET_DEVICE_ID
        reason = "disabled" if not bool(getattr(cfg, "candidate_asr_enabled", False)) else "missing_or_same_device"
        _broadcast_candidate_asr_off(reason)

    # 创建 review session（如果满足条件）
    review_integration.on_assist_start(
        interviewer_device_id=device_id,
        candidate_device_id=review_candidate_device_id,
        candidate_asr_enabled=bool(getattr(cfg, "candidate_asr_enabled", False)),
        written_exam_mode=bool(getattr(cfg, "written_exam_mode", False)),
    )


def stop_interview_loop():
    with _interview_control_lock:
        return _stop_interview_loop_locked()


def _stop_interview_loop_locked():
    global _recording_generation
    global _interview_thread, _interviewer_asr_thread, _candidate_thread, _flush_thread
    _stop_event.set()
    _pause_event.clear()
    _candidate_flush_event.set()
    _stop_capture_compat(audio_capture, owner="assist", clear_queue=False)
    _stop_capture_compat(_candidate_audio_capture, owner="assist-candidate", clear_queue=True)
    session = get_session()
    runtime = _interviewer_runtime
    runtime_snapshot: Optional[dict[str, Any]] = None

    current_thread = threading.current_thread()
    if _interview_thread and _interview_thread.is_alive() and _interview_thread is not current_thread:
        _interview_thread.join(timeout=5)
    _interview_thread = None
    if runtime is not None:
        try:
            _refresh_interviewer_raw_drop_count(runtime)
            runtime.drain_event.set()
            drain_timeout_sec = _interviewer_segment_drain_timeout()
            drained, remaining = _drain_interviewer_segments(drain_timeout_sec)
            if _interviewer_asr_thread and _interviewer_asr_thread.is_alive() and _interviewer_asr_thread is not current_thread:
                _interviewer_asr_thread.join(timeout=drain_timeout_sec)
                drained = _interviewer_segment_backlog(runtime) == 0
                remaining = _interviewer_segment_backlog(runtime)
            _ilog.info(
                "INTERVIEWER_ASR_DRAIN drained=%s remaining=%d segment_emitted=%d segment_dropped=%d raw_queue_drop_count=%d loopback_discontinuity_count=%d max_raw_chunk_samples=%d max_segment_queue_depth=%d",
                drained,
                remaining,
                runtime.segment_emitted,
                runtime.segment_dropped,
                runtime.raw_queue_drop_count,
                runtime.loopback_discontinuity_count,
                runtime.max_raw_chunk_samples,
                runtime.max_observed_segment_queue_depth,
            )
            if not drained:
                _elog.warning("INTERVIEWER_ASR_DRAIN_TIMEOUT remaining=%d", remaining)
            runtime_snapshot = _snapshot_interviewer_runtime(
                runtime,
                live=False,
                drained=drained,
                remaining_after_drain=remaining,
            )
        except Exception:
            _elog.error("interviewer ASR drain failed", exc_info=True)
        if runtime_snapshot is None:
            runtime_snapshot = _snapshot_interviewer_runtime(runtime, live=False)
        _set_last_interviewer_runtime_snapshot(runtime_snapshot)
    if _interviewer_asr_thread and _interviewer_asr_thread.is_alive() and _interviewer_asr_thread is not current_thread:
        _interviewer_asr_thread.join(timeout=0.2)
    _interviewer_asr_thread = None
    if _flush_thread and _flush_thread.is_alive() and _flush_thread is not current_thread:
        _flush_thread.join(timeout=1)
    _flush_thread = None
    if _candidate_thread and _candidate_thread.is_alive() and _candidate_thread is not current_thread:
        _candidate_thread.join(timeout=5)
    _candidate_thread = None

    # A timed-out native/model call can outlive stop. Retire its results and
    # cleanup before closing the review or allowing the next recording.
    with _recording_generation_lock:
        _recording_generation += 1
        _flush_stop_event.set()
        while True:
            try:
                _flush_queue.get_nowait()
            except queue.Empty:
                break

    try:
        _try_flush_asr_merge_buffer(
            get_config(), session, time.monotonic(), True
        )
        _try_flush_asr_question_group(
            get_config(), session, time.monotonic(), True
        )
    except Exception:
        _elog.debug("final ASR flush during stop skipped", exc_info=True)

    wait_sec = float(getattr(get_config(), "assist_stop_answer_wait_sec", 3.0))
    if wait_sec > 0 and not _wait_for_answer_work_idle(min(wait_sec, 20.0)):
        _elog.warning("ANSWER_STOP_WAIT_TIMEOUT pending/inflight work will be cancelled")
    cancel_answer_work(reset_session_data=False)

    # 结束 review session（如果存在）。必须在音频 worker 最后 flush、候选人 ASR final、
    # 以及可等待的答案 commit 之后执行，否则关闭应用时复盘会漏掉末尾问题。
    review_session_id = review_integration.on_assist_stop(session)

    with conversation_lock:
        session.is_recording = False
        session.is_paused = False
        if hasattr(session, "close_candidate_answer_window"):
            session.close_candidate_answer_window()
        if len(session.transcription_history) > 30:
            session.transcription_history = session.transcription_history[-30:]
        if hasattr(session, "candidate_transcription_history") and len(session.candidate_transcription_history) > 30:
            session.candidate_transcription_history = session.candidate_transcription_history[-30:]
    broadcast({"type": "recording", "value": False})
    broadcast({"type": "paused", "value": False})
    _candidate_flush_event.clear()
    _set_interviewer_runtime(None)
    gc.collect()
    _ilog.info("INTERVIEW_STOP qa_count=%d", len(session.qa_pairs))
    return review_session_id


def pause_interview():
    with _interview_control_lock:
        return _pause_interview_locked()


def _pause_interview_locked():
    _pause_event.set()
    _candidate_flush_event.set()
    _reset_asr_merge_buffer()
    _reset_pending_asr_group()
    runtime = _interviewer_runtime
    if runtime is not None:
        while True:
            try:
                runtime.segment_queue.get_nowait()
                runtime.segment_queue.task_done()
            except queue.Empty:
                break
    _stop_capture_compat(audio_capture, owner="assist", clear_queue=False)
    _stop_capture_compat(_candidate_audio_capture, owner="assist-candidate", clear_queue=False)
    session = get_session()
    with conversation_lock:
        session.is_paused = True
    broadcast({"type": "paused", "value": True})


def unpause_interview(device_id: Optional[int] = None, candidate_mic_device_id: Optional[int] = None):
    with _interview_control_lock:
        return _unpause_interview_locked(device_id, candidate_mic_device_id)


def _unpause_interview_locked(device_id: Optional[int], candidate_mic_device_id: Optional[int]):
    global _interview_thread, _candidate_thread
    session = get_session()
    cfg = get_config()
    written_exam = bool(getattr(cfg, "written_exam_mode", False))
    if written_exam:
        # A written exam has no audio workers. Ignore stale device IDs from a
        # previous interview and requests from older clients.
        device_id = None
        candidate_mic_device_id = None
    capture_is_loopback = bool(getattr(session, "capture_is_loopback", False))
    last_id = (
        _UNSET_DEVICE_ID
        if written_exam
        else _normalize_stored_device_id(getattr(session, "last_device_id", _UNSET_DEVICE_ID))
    )
    next_device_id = last_id
    if device_id is not None:
        next_device_id = int(device_id)
        capture_is_loopback = _device_is_loopback(next_device_id)
    # Mirror candidate resume: prefer last_device_id when the worker/capture died.
    # Valid capture targets are PortAudio indices >= 0 (including device 0).
    should_resume_interviewer = bool(
        not written_exam
        and _is_valid_device_id(next_device_id)
        and (
            device_id is not None
            or _is_valid_device_id(last_id)
            or (_interview_thread and _interview_thread.is_alive())
            or bool(getattr(audio_capture, "is_running", False))
        )
    )
    if should_resume_interviewer:
        audio_capture.start(
            next_device_id,
            owner="assist",
            mic_agc=bool(getattr(cfg, "mic_agc_enabled", False)),
        )
        _start_interview_worker_thread_if_needed()
    last_candidate_id = (
        _UNSET_DEVICE_ID
        if written_exam
        else _normalize_stored_device_id(
            getattr(session, "last_candidate_mic_device_id", _UNSET_DEVICE_ID)
        )
    )
    next_candidate_id = last_candidate_id
    should_resume_candidate = bool(
        candidate_mic_device_id is not None
        or _is_valid_device_id(last_candidate_id)
        or (_candidate_thread and _candidate_thread.is_alive())
        or bool(getattr(_candidate_audio_capture, "is_running", False))
    )
    if candidate_mic_device_id is not None:
        next_candidate_id = int(candidate_mic_device_id)
    candidate_enabled = bool(getattr(cfg, "candidate_asr_enabled", False))
    candidate_device_valid = bool(
        _is_valid_device_id(next_candidate_id)
        and candidate_enabled
        and int(next_candidate_id) != int(next_device_id)
    )
    if (
        should_resume_candidate
        and candidate_device_valid
    ):
        try:
            _candidate_audio_capture.start(
                next_candidate_id,
                owner="assist-candidate",
                mic_compatibility_mode=bool(getattr(cfg, "candidate_mic_compatibility_mode", True)),
                mic_agc=bool(getattr(cfg, "mic_agc_enabled", False)),
            )
            if not _candidate_thread or not _candidate_thread.is_alive():
                _candidate_thread = threading.Thread(
                    target=_candidate_worker,
                    args=(_capture_recording_generation(),),
                    daemon=True,
                )
                _candidate_thread.start()
        except Exception as exc:
            next_candidate_id = _UNSET_DEVICE_ID
            _elog.warning("CANDIDATE_ASR_RESUME_FAIL err=%s", exc)
            _broadcast_candidate_asr_error(str(exc)[:160])
    elif _is_valid_device_id(next_candidate_id) and not candidate_device_valid:
        reason = "disabled" if not candidate_enabled else "missing_or_same_device"
        next_candidate_id = _UNSET_DEVICE_ID
        if should_resume_candidate or candidate_mic_device_id is not None:
            _broadcast_candidate_asr_off(reason)
    _candidate_flush_event.clear()
    _pause_event.clear()
    with conversation_lock:
        session.last_device_id = (
            _UNSET_DEVICE_ID if written_exam else _normalize_stored_device_id(next_device_id)
        )
        session.last_candidate_mic_device_id = (
            _UNSET_DEVICE_ID if written_exam else _normalize_stored_device_id(next_candidate_id)
        )
        session.capture_is_loopback = False if written_exam else capture_is_loopback
        session.is_paused = False
    broadcast({"type": "paused", "value": False})


def is_paused() -> bool:
    return _pause_event.is_set()


# H4: 独立 flush worker 线程，避免阻塞音频采集主循环
def _flush_worker(recording_generation: Optional[int] = None):
    """独立线程处理 ASR buffer flush，避免阻塞音频采集"""
    generation = _capture_recording_generation() if recording_generation is None else recording_generation
    while not _flush_stop_event.is_set() and _recording_generation_is_current(generation):
        try:
            flush_signal = _flush_queue.get(timeout=0.1)
            if flush_signal:
                cfg, session, now = flush_signal
                with _recording_generation_lock:
                    if not _recording_generation_is_current(generation):
                        return
                    _try_flush_asr_merge_buffer(cfg, session, now, False)
                    _try_flush_asr_question_group(cfg, session, now, False)
        except queue.Empty:
            continue
        except Exception as e:
            _elog.error("flush_worker error: %s", e, exc_info=True)


def _interviewer_asr_worker(
    runtime: _InterviewerRuntime, session, recording_generation: Optional[int] = None
) -> None:
    generation = _capture_recording_generation() if recording_generation is None else recording_generation
    while _recording_generation_is_current(generation):
        if runtime.drain_event.is_set() and _interviewer_segment_backlog(runtime) == 0:
            break
        try:
            segment = runtime.segment_queue.get(timeout=0.1)
        except queue.Empty:
            continue
        runtime.asr_busy = True
        try:
            queue_delay_ms = max(0.0, (time.monotonic() - segment.ended_mono) * 1000.0)
            with _recording_generation_lock:
                if not _recording_generation_is_current(generation):
                    return
                broadcast({"type": "transcribing", "value": True})
            t0 = time.monotonic()
            current_cfg = get_config()
            text = transcribe_with_fallback(
                segment.audio,
                segment.sample_rate,
                position=current_cfg.position,
                language=current_cfg.language,
                scope="interviewer",
            )
            stt_ms = (time.monotonic() - t0) * 1000
            pub = _publishable_transcription(text, current_cfg)
            _ilog.info(
                "INTERVIEWER_ASR_SEGMENT flush_reason=%s queue_delay_ms=%.0f raw=%.1fs stt=%.0fms ratio=%.2f publish_chars=%d",
                segment.flush_reason,
                queue_delay_ms,
                segment.audio_sec,
                stt_ms,
                (stt_ms / 1000.0 / segment.audio_sec) if segment.audio_sec > 0 else 0.0,
                len(pub) if pub else 0,
            )
            if pub:
                with _recording_generation_lock:
                    if _recording_generation_is_current(generation):
                        _ilog.info("ASR publish=%r", pub[:120])
                        _append_transcription_fragment(
                            current_cfg, session, pub, time.monotonic(), False
                        )
        except Exception as e:
            _elog.error("interviewer ASR segment error: %s", e, exc_info=True)
        finally:
            runtime.asr_busy = False
            runtime.segment_queue.task_done()
            with _recording_generation_lock:
                if _recording_generation_is_current(generation):
                    broadcast({"type": "transcribing", "value": False})


def _on_stream_interim(recording_generation: int, sentence_id: int, text: str) -> None:
    """流式中间结果回调：只推给前端做“进行中”展示，不进合并缓冲、不触发自动答题。"""
    with _recording_generation_lock:
        if not _recording_generation_is_current(recording_generation):
            return
        broadcast({"type": "transcription_interim", "text": text, "sentence_id": sentence_id})


def _on_stream_final(recording_generation: int, session, sentence_id: int, text: str) -> None:
    """流式定稿回调：清掉进行中行，然后立即发布成行并喂问题组。

    服务端 sentence_end 已是完整句子边界，因此跳过合并缓冲；确认窗口
    由 stream_mode 切换为流式短窗口，消除"识别完成→触发答题"的秒级延迟。
    """
    with _recording_generation_lock:
        if not _recording_generation_is_current(recording_generation):
            return
        broadcast({"type": "transcription_interim", "text": "", "sentence_id": sentence_id})
        current_cfg = get_config()
        pub = _publishable_transcription(text, current_cfg)
        if pub:
            _ilog.info("ASR publish(stream)=%r", pub[:120])
            _publish_stream_fragment(current_cfg, session, pub, time.monotonic())
            if _stream_instant_dispatch_active(current_cfg):
                # 即时派发：该句即完整问题，同一线程内立刻提交，不等
                # flush worker 的 tick 与任何确认窗口。
                _flush_asr_question_group_now(current_cfg, session)


def _stream_instant_dispatch_active(cfg) -> bool:
    return bool(
        getattr(cfg, "assist_stream_asr_instant_dispatch", True)
        and _asr_state.stream_mode
    )


def _on_stream_state(recording_generation: int, state: str) -> None:
    """记录流状态（started / closed / failed:xxx），便于排查现场问题。"""
    _ilog.info("INTERVIEWER_STREAM_STATE gen=%d state=%s", recording_generation, state)


def _start_interviewer_stream(cfg, recording_generation: int, session, notify: bool = True) -> Optional[AliyunInterviewerStream]:
    """建立面试官专用流式会话；失败返回 None，由主循环按退避自动重连（不回落逐段识别）。"""
    stream = AliyunInterviewerStream(
        api_key=getattr(cfg, "aliyun_stt_api_key", ""),
        model=getattr(cfg, "aliyun_stt_model", ""),
        sample_rate=AudioCapture.SAMPLE_RATE,
        max_sentence_silence_ms=int(getattr(cfg, "aliyun_stt_max_sentence_silence_ms", 0) or 0),
        vad_model=getattr(cfg, "aliyun_stt_vad_model", "") or "",
        on_interim=lambda sid, text: _on_stream_interim(recording_generation, sid, text),
        on_final=lambda sid, text: _on_stream_final(recording_generation, session, sid, text),
        on_state_change=lambda state: _on_stream_state(recording_generation, state),
        logger=_ilog,
    )
    try:
        stream.start()
    except AliyunSTTError as exc:
        _elog.warning("interviewer stream start failed, will retry in-loop: %s", exc)
        if notify:
            with _recording_generation_lock:
                if _recording_generation_is_current(recording_generation):
                    broadcast({
                        "type": "stt_stream_state", "scope": "interviewer",
                        "provider": "aliyun", "state": "reconnecting",
                        "reason": str(exc)[:120],
                    })
        return None
    _ilog.info(
        "INTERVIEWER_STREAM_START model=%s max_sentence_silence_ms=%d",
        getattr(cfg, "aliyun_stt_model", ""),
        int(getattr(cfg, "aliyun_stt_max_sentence_silence_ms", 0) or 0),
    )
    return stream


def _stop_streaming_session(
    obj: Optional[AliyunInterviewerStream] | Optional[GenericInterimTranscriber],
    recording_generation: int,
    drain_timeout_sec: float,
) -> None:
    """结束流式/伪流式会话：限时收完剩余定稿，失败则强制断开，并通知前端清空进行中行。"""
    if obj is None:
        return
    try:
        obj.finish(drain_timeout_sec=drain_timeout_sec)
    except Exception:
        try:
            obj.abort()
        except Exception:
            pass
    with _recording_generation_lock:
        if _recording_generation_is_current(recording_generation):
            broadcast({"type": "transcription_interim", "text": "", "sentence_id": 0})
def _on_generic_final(recording_generation: int, session, sentence_id: int, text: str) -> None:
    """通用 ASR 定稿回调：与千问 sentence_end 一样立即发布成行并喂问题组。

    与 _on_stream_final 的顺序差异：这里先发布正式转写、再清“进行中”行。
    千问的定稿是服务端事件，清行与发布同刻完成；通用 ASR 的定稿要走一次
    HTTP 重转写，若先清行，进行中行会先消失一两秒再出现正式行（看起来在闪）。
    先发布再清行，进行中行直接“变成”正式行，没有空窗。
    """
    with _recording_generation_lock:
        if not _recording_generation_is_current(recording_generation):
            return
        current_cfg = get_config()
        pub = _publishable_transcription(text, current_cfg)
        if pub:
            _ilog.info("ASR publish(stream)=%r", pub[:120])
            _publish_stream_fragment(current_cfg, session, pub, time.monotonic())
        broadcast({"type": "transcription_interim", "text": "", "sentence_id": sentence_id})
        if pub and _stream_instant_dispatch_active(current_cfg):
            # 即时派发：该句即完整问题，同一线程内立刻提交，不等
            # flush worker 的 tick 与任何确认窗口。
            _flush_asr_question_group_now(current_cfg, session)


def _start_generic_interim_transcriber(
    cfg, recording_generation: int, session
) -> Optional[GenericInterimTranscriber]:
    """为通用 ASR 建立伪流式转写器；配置缺失或引擎不可用时返回 None。

    失败返回 None，由主循环按退避自动重建（不回落逐段识别）。
    """
    try:
        engine = get_stt_engine(provider="generic")
    except Exception as exc:
        _elog.warning("generic interim transcriber init failed, will retry in-loop: %s", exc)
        return None
    if not isinstance(engine, GenericHTTPSTT) or not engine.is_loaded:
        return None

    def _final_transcribe(audio: np.ndarray, sample_rate: int) -> str:
        # 定稿走与逐段路径相同的韧性链路（同引擎重试/熔断，不切引擎）。
        current_cfg = get_config()
        return transcribe_with_fallback(
            audio,
            sample_rate,
            position=current_cfg.position,
            language=current_cfg.language,
            provider="generic",
            scope="interviewer",
        )

    interval_ms = max(
        800, min(10000, int(getattr(cfg, "generic_stt_streaming_interval_ms", 2000) or 2000))
    )
    transcriber = GenericInterimTranscriber(
        engine=engine,
        transcribe_final=_final_transcribe,
        sample_rate=AudioCapture.SAMPLE_RATE,
        interval_ms=interval_ms,
        min_final_samples=_assist_vad_min_samples(cfg),
        on_interim=lambda sid, text: _on_stream_interim(recording_generation, sid, text),
        on_final=lambda sid, text: _on_generic_final(recording_generation, session, sid, text),
        on_state_change=lambda state: _on_stream_state(recording_generation, state),
        logger=_ilog,
    )
    transcriber.start()
    _ilog.info(
        "GENERIC_INTERIM_START interval_ms=%d model=%s",
        interval_ms,
        getattr(engine, "model", ""),
    )
    return transcriber


def _interview_worker(recording_generation: Optional[int] = None):
    generation = _capture_recording_generation() if recording_generation is None else recording_generation
    if not _recording_generation_is_current(generation):
        return
    try:
        _run_interview_worker(generation)
    except Exception as exc:
        _elog.error("Interview worker initialization failed: %s", exc, exc_info=True)
        with _recording_generation_lock:
            if _recording_generation_is_current(generation):
                provider = getattr(get_config(), "stt_provider", "whisper")
                broadcast({"type": "stt_status", "loaded": False, "loading": False, "provider": provider})
                broadcast({"type": "error", "message": f"语音识别模型初始化失败: {exc}"})
                _stop_event.set()
                with conversation_lock:
                    get_session().is_recording = False
                broadcast({"type": "recording", "value": False})
    finally:
        with _recording_generation_lock:
            if _recording_generation_is_current(generation):
                try:
                    _stop_capture_compat(audio_capture, owner="assist", clear_queue=True)
                except Exception:
                    _elog.error("audio_capture.stop in worker finally failed", exc_info=True)


def _run_interview_worker(recording_generation: int):
    cfg = get_config()
    engine = get_stt_engine()

    if not engine.is_loaded:
        with _recording_generation_lock:
            if not _recording_generation_is_current(recording_generation):
                return
            broadcast({"type": "stt_status", "loaded": False, "loading": True, "provider": getattr(cfg, "stt_provider", "whisper")})
        try:
            engine.load_model()
        except Exception as e:
            raise RuntimeError(f"语音识别模型加载失败: {e}") from e
    with _recording_generation_lock:
        if not _recording_generation_is_current(recording_generation):
            return
        runtime = _interviewer_runtime or _new_interviewer_runtime()
        _set_interviewer_runtime(runtime)
        broadcast({"type": "stt_status", "loaded": bool(engine.is_loaded), "loading": False, "provider": getattr(cfg, "stt_provider", "whisper")})

    vad = VADBuffer(
        sample_rate=AudioCapture.SAMPLE_RATE,
        silence_threshold=getattr(cfg, "silence_threshold", 0.01),
        silence_duration=getattr(cfg, "silence_duration", 1.2),
        max_speech_duration=getattr(cfg, "assist_vad_max_speech_sec", 18.0),
        min_speech_duration=getattr(cfg, "assist_vad_min_speech_sec", 0.3),
        preroll_duration=_interviewer_vad_preroll_sec,
        rollover_duration=_interviewer_vad_rollover_sec,
    )
    with _recording_generation_lock:
        if not _recording_generation_is_current(recording_generation):
            return
        session = get_session()
        _reset_asr_merge_buffer()
        _reset_pending_asr_group()
        _set_stream_mode(False)
    pause_flushed = False

    # 面试官实时流式识别（仅阿里千问）：一场录音一条双工会话，音频采集后实时上行。
    # 不满足条件或流式不可用时，继续走原有的 VAD 逐段识别路径。
    stream: Optional[AliyunInterviewerStream] = None
    use_stream = False
    stream_retry_attempt = 0
    next_stream_retry_mono = 0.0
    if (
        bool(getattr(cfg, "interviewer_streaming_asr_enabled", False))
        and (getattr(cfg, "stt_provider", "") or "").strip() == "aliyun"
        and (getattr(cfg, "aliyun_stt_api_key", "") or "").strip()
    ):
        # 坚持流式：建流失败不回落逐段识别，置重试状态由主循环自动重连。
        use_stream = True
        _set_stream_mode(True)
        stream = _start_interviewer_stream(cfg, recording_generation, session)
        if stream is None:
            next_stream_retry_mono = time.monotonic() + 1.0

    # 千问流式专属：断线重连期间的待上行回补缓冲（None = 关闭回补，保持旧行为）。
    stream_backlog = _new_stream_backlog(cfg) if use_stream else None
    backlog_dropped_logged = 0  # 已告警过的丢块数，避免溢出告警刷屏

    # 通用 ASR 伪流式（对齐千问流式体验）：说话期间按间隔整体重转写 VAD 缓存
    # 出“进行中”行（前缀稳定化，只增不跳），VAD 切段即定稿并即时派发答题；
    # 生效期间跳过逐段入队，行为与千问流式一致。
    generic_interim: Optional[GenericInterimTranscriber] = None
    generic_wanted = False
    next_generic_retry_mono = 0.0
    if (
        not use_stream
        and bool(getattr(cfg, "interviewer_streaming_asr_enabled", False))
        and (getattr(cfg, "stt_provider", "") or "").strip() == "generic"
    ):
        # 坚持伪流式：建不起来就按退避自动重建，不回落逐段识别。
        generic_wanted = True
        _set_stream_mode(True)
        generic_interim = _start_generic_interim_transcriber(cfg, recording_generation, session)
        if generic_interim is None:
            next_generic_retry_mono = time.monotonic() + 1.0

    # gc.collect() 之前直接放在主 ASR 循环里 (每 60s 同步执行),
    # 大堆下单次 50~500ms, 期间无法读音频可能丢块。改成独立 daemon 线程,
    # 主循环零阻塞; 线程靠 _stop_event 退出, 与 worker 生命周期对齐。
    _gc_stop = threading.Event()

    def _gc_periodic_worker() -> None:
        while not _gc_stop.wait(60.0):
            try:
                gc.collect()
            except Exception:
                pass

    _gc_thread = threading.Thread(
        target=_gc_periodic_worker, daemon=True, name="assist-gc"
    )
    global _flush_thread
    flush_thread = threading.Thread(
        target=_flush_worker,
        args=(recording_generation,),
        daemon=True,
        name="assist-flush",
    )
    global _interviewer_asr_thread
    asr_thread = threading.Thread(
        target=_interviewer_asr_worker,
        args=(runtime, session, recording_generation),
        daemon=True,
        name="assist-interviewer-asr",
    )
    with _recording_generation_lock:
        if not _recording_generation_is_current(recording_generation):
            return
        _gc_thread.start()
        _flush_thread = flush_thread
        _flush_stop_event.clear()
        flush_thread.start()
        _interviewer_asr_thread = asr_thread
        asr_thread.start()

    try:
        while not _stop_event.is_set() and _recording_generation_is_current(recording_generation):
            if _pause_event.is_set():
                if not pause_flushed:
                    _flush_vad_remainder(
                        runtime, vad, cfg, session, recording_generation, stream, generic_interim,
                        flush_reason="pause_flush",
                    )
                    if stream is not None:
                        # 暂停期间采集完全停止，挂着空连接有服务端空闲超时风险：
                        # 关闭并在恢复时重新开一条任务。
                        _stop_streaming_session(
                            stream, recording_generation, min(2.0, _interviewer_segment_drain_timeout())
                        )
                        stream = None
                    if stream_backlog is not None:
                        # 暂停语义 = 该时段不识别：缓冲随流一并清空，恢复后不补发。
                        stream_backlog.clear()
                    pause_flushed = True
                now = time.monotonic()
                with _recording_generation_lock:
                    if not _recording_generation_is_current(recording_generation):
                        return
                    _signal_flush_tick(session, now)
                time.sleep(0.1)
                continue
            if pause_flushed:
                pause_flushed = False
                if use_stream and stream is None:
                    next_stream_retry_mono = 0.0  # 恢复后立即重连流
            if not audio_capture.is_running:
                _elog.error("Interview worker: audio capture stopped unexpectedly, exiting loop")
                with _recording_generation_lock:
                    if not _recording_generation_is_current(recording_generation):
                        return
                    _stop_event.set()
                    with conversation_lock:
                        session.is_recording = False
                    broadcast({"type": "error", "message": "音频采集异常中断，面试录音已停止"})
                    broadcast({"type": "recording", "value": False})
                break
            now = time.monotonic()
            _refresh_interviewer_raw_drop_count(runtime)
            # H4: 将 flush 逻辑移到独立线程，避免阻塞音频采集
            with _recording_generation_lock:
                if not _recording_generation_is_current(recording_generation):
                    return
                _signal_flush_tick(session, now)
                chunks = audio_capture.drain_audio_chunks(timeout=0.1, max_chunks=6)
            if not chunks:
                time.sleep(0.05)
                continue
            if use_stream:
                if stream is not None and not stream.healthy:
                    # 流中途断开：坚持流式，自动重连（指数退避，不限次数），
                    # 断线期间音频入回补缓冲，绝不回落为非实时路径。
                    failure_reason = str(stream.failure)[:120] if stream.failure else "stream_lost"
                    _elog.warning("interviewer stream lost: %s", failure_reason)
                    if stream_backlog is not None:
                        # 回收死流发送队列里已 feed 未发出的音频：它们时间最老，
                        # 排在回补缓冲头部，重连后先于断线窗口的音频补发。
                        unsent = stream.drain_unsent()
                        if unsent:
                            stream_backlog.prepend_many(unsent)
                            _ilog.info(
                                "INTERVIEWER_STREAM_REQUEUE unsent=%d pending_bytes=%d",
                                len(unsent), stream_backlog.pending_bytes,
                            )
                    stream.abort()
                    stream = None
                    next_stream_retry_mono = now  # 立即发起第一次重连
                    with _recording_generation_lock:
                        if _recording_generation_is_current(recording_generation):
                            broadcast({
                                "type": "stt_stream_state", "scope": "interviewer",
                                "provider": "aliyun", "state": "reconnecting",
                                "reason": failure_reason,
                            })
                if stream is None and now >= next_stream_retry_mono:
                    stream_retry_attempt += 1
                    stream = _start_interviewer_stream(
                        get_config(), recording_generation, session, notify=False
                    )
                    if stream is not None:
                        _ilog.info("INTERVIEWER_STREAM_RECONNECT ok attempts=%d", stream_retry_attempt)
                        stream_retry_attempt = 0
                        if stream_backlog is not None and len(stream_backlog):
                            _ilog.info(
                                "INTERVIEWER_STREAM_BACKLOG catchup pending_bytes=%d",
                                stream_backlog.pending_bytes,
                            )
                        with _recording_generation_lock:
                            if _recording_generation_is_current(recording_generation):
                                broadcast({
                                    "type": "stt_stream_state", "scope": "interviewer",
                                    "provider": "aliyun", "state": "recovered",
                                })
                    else:
                        next_stream_retry_mono = now + min(8.0, 2.0 ** min(stream_retry_attempt, 3))
                streaming_active = True  # 意图级开关：重连期间同样禁止逐段识别
                # 先喂流再喂 VAD：VAD 的计算耗时不能拖慢音频上行。
                # 回补开启：音频先入缓冲再从头部泵出，断线窗口不丢、重连后按序追平；
                # 回补关闭（assist_stream_reconnect_buffer_sec=0）：保持旧的直接 feed。
                pcm_chunks = [
                    _audio_to_pcm_int16(raw_chunk).astype("<i2", copy=False).tobytes()
                    for raw_chunk in chunks
                ]
                if stream_backlog is not None:
                    stream_backlog.append_many(pcm_chunks)
                    if stream is not None and stream.healthy:
                        stream_backlog.pump(
                            stream, len(pcm_chunks) + _STREAM_BACKLOG_CATCHUP_CHUNKS
                        )
                    if stream_backlog.dropped_chunks > backlog_dropped_logged:
                        backlog_dropped_logged = stream_backlog.dropped_chunks
                        _elog.warning(
                            "interviewer stream backlog overflow, dropped_oldest=%d bytes=%d",
                            stream_backlog.dropped_chunks, stream_backlog.dropped_bytes,
                        )
                elif stream is not None and stream.healthy:
                    for pcm in pcm_chunks:
                        stream.feed(pcm)
            else:
                streaming_active = False
            if generic_wanted:
                # 坚持伪流式：线程意外死亡时自动重建（退避），不回落逐段识别。
                if generic_interim is not None and not generic_interim.healthy:
                    _elog.warning("generic interim transcriber lost, restarting")
                    _stop_streaming_session(generic_interim, recording_generation, 0.5)
                    generic_interim = None
                    next_generic_retry_mono = now
                    with _recording_generation_lock:
                        if _recording_generation_is_current(recording_generation):
                            broadcast({
                                "type": "stt_stream_state", "scope": "interviewer",
                                "provider": "generic", "state": "reconnecting",
                            })
                if generic_interim is None and now >= next_generic_retry_mono:
                    generic_interim = _start_generic_interim_transcriber(
                        get_config(), recording_generation, session
                    )
                    if generic_interim is not None:
                        with _recording_generation_lock:
                            if _recording_generation_is_current(recording_generation):
                                broadcast({
                                    "type": "stt_stream_state", "scope": "interviewer",
                                    "provider": "generic", "state": "recovered",
                                })
                    else:
                        next_generic_retry_mono = now + 2.0
                streaming_active = True
            energy = AudioCapture.compute_energy(np.concatenate(chunks))
            if energy > float(getattr(cfg, "silence_threshold", 0.01) or 0.01):
                runtime.last_speech_mono = now
            with _recording_generation_lock:
                if not _recording_generation_is_current(recording_generation):
                    return
                broadcast({"type": "audio_level", "value": round(energy, 4)})

            offset_samples = 0
            total_samples = sum(len(chunk) for chunk in chunks)
            batch_end_mono = now
            batch_start_mono = max(0.0, batch_end_mono - (total_samples / AudioCapture.SAMPLE_RATE))
            _log_interviewer_chunk_gap(
                runtime,
                batch_start_mono,
                total_samples / AudioCapture.SAMPLE_RATE,
            )
            for chunk in chunks:
                for vad_chunk in _iter_vad_feed_chunks(chunk):
                    offset_samples += len(vad_chunk)
                    sub_ended_mono = batch_start_mono + (offset_samples / AudioCapture.SAMPLE_RATE)
                    speech_audio = vad.feed(vad_chunk)
                    runtime.vad_active = bool(getattr(vad, "has_pending_audio", False))
                    if speech_audio is None:
                        continue
                    if generic_interim is not None and generic_interim.healthy:
                        # VAD 切段 = 伪流式的 sentence_end：定稿重转写并即时派发。
                        generic_interim.finalize(speech_audio)
                    flush_reason = getattr(vad, "last_flush_reason", None) or "silence"
                    segment_ended_mono = sub_ended_mono
                    segment_started_mono = max(
                        0.0,
                        segment_ended_mono - (len(speech_audio) / AudioCapture.SAMPLE_RATE),
                    )
                    _maybe_build_interviewer_segment(
                        cfg,
                        runtime,
                        session,
                        speech_audio,
                        flush_reason=(
                            "max_speech"
                            if flush_reason == "max_speech"
                            else "silence"
                        ),
                        segment_started_mono=segment_started_mono,
                        segment_ended_mono=segment_ended_mono,
                        streaming_active=streaming_active,
                    )
            if generic_interim is not None:
                # 伪流式 interim：把 VAD 当前缓存的整段语音交给后台重转写出字。
                generic_interim.submit(vad.pending_audio())

        if not _recording_generation_is_current(recording_generation):
            return
        _flush_vad_remainder(
            runtime, vad, cfg, session, recording_generation, stream, generic_interim,
            flush_reason="stop_flush",
        )
    except Exception as e:
        _elog.error("Interview worker crashed: %s", e, exc_info=True)
        with _recording_generation_lock:
            if _recording_generation_is_current(recording_generation):
                broadcast({"type": "error", "message": f"\u9762\u8bd5\u5faa\u73af\u5f02\u5e38: {e}"})
                _stop_event.set()
                with conversation_lock:
                    get_session().is_recording = False
                broadcast({"type": "recording", "value": False})
    finally:
        # Drain stream finals before the merge buffer's forced flush at stop
        # (the stop path joins this worker thread first), so the last spoken
        # words still land as transcriptions.
        if stream is not None:
            # 在合并缓冲被强制 flush 之前先把流里的最后一句收完（停止流程会先 join
            # 本线程），这样“停止前最后说的话”仍能作为正式转写落库。
            # 收尾时间设上限，保证一定能在停止流程的 join 超时内退出。
            _stop_streaming_session(
                stream, recording_generation, min(3.0, _interviewer_segment_drain_timeout())
            )
            stream = None
        if generic_interim is not None:
            # 与千问流式收尾同理：限时等定稿发完（停止流程会先 join 本线程），
            # “停止前最后说的话”仍能作为正式转写落库并触发答题。
            _stop_streaming_session(
                generic_interim, recording_generation, min(3.0, _interviewer_segment_drain_timeout())
            )
            generic_interim = None
        _set_stream_mode(False)
        # 通知 GC daemon 退出并 join, 让 worker 生命周期完全确定 (避免测试需要
        # sleep 等收敛, 也不让旧 daemon 与下一轮 worker 的 daemon 短暂并存)。
        # threading.Event.set() 不会抛, 不需要 try; join(timeout) 只兜个上限。
        _gc_stop.set()
        try:
            _gc_thread.join(timeout=0.5)
        except Exception:
            pass
        with _recording_generation_lock:
            if _recording_generation_is_current(recording_generation):
                _flush_stop_event.set()
        try:
            if flush_thread.is_alive():
                flush_thread.join(timeout=0.5)
        except Exception:
            pass
        try:
            if asr_thread.is_alive():
                runtime.drain_event.set()
                asr_thread.join(timeout=_interviewer_segment_drain_timeout())
        except Exception:
            pass
        _refresh_interviewer_raw_drop_count(runtime)


def _candidate_provider_config(cfg) -> tuple[str, str, str, bool]:
    provider = (getattr(cfg, "candidate_stt_provider", "whisper") or "whisper").strip()
    allow_remote = bool(getattr(cfg, "candidate_remote_stt_enabled", False))
    if provider in REMOTE_STT_PROVIDERS and not allow_remote:
        provider = "whisper"
    model = (getattr(cfg, "candidate_whisper_model", "") or getattr(cfg, "whisper_model", "base") or "base").strip()
    candidate_lang_raw = (getattr(cfg, "candidate_whisper_language", "") or "").strip()
    language = candidate_lang_raw or (getattr(cfg, "whisper_language", "auto") or "auto").strip() or "auto"
    return provider, model, language, allow_remote


def _candidate_streaming_config(cfg, provider: str) -> tuple[bool, int]:
    enabled = bool(getattr(cfg, "candidate_streaming_asr_enabled", True)) and provider == "whisper"
    interval_ms = max(800, min(5000, int(getattr(cfg, "candidate_streaming_asr_interval_ms", 1500) or 1500)))
    return enabled, interval_ms


def _preload_candidate_whisper_async(provider: str, model: str, language: str) -> None:
    if provider != "whisper":
        return
    preload_key = (model or "base", language or "auto")
    with _candidate_whisper_preload_lock:
        if preload_key in _candidate_whisper_preload_inflight:
            return
        _candidate_whisper_preload_inflight.add(preload_key)

    def _load() -> None:
        try:
            try:
                engine = get_stt_engine(
                    provider="whisper",
                    model_size=model,
                    language=language,
                )
            except TypeError:
                engine = get_stt_engine(model_size=model, language=language)
            if not engine.is_loaded:
                engine.load_model()
            broadcast(
                {
                    "type": "candidate_asr_status",
                    "loaded": bool(engine.is_loaded),
                    "loading": False,
                    "provider": "whisper",
                }
            )
        except Exception as exc:
            _elog.warning(
                "CANDIDATE_ASR_PRELOAD_FAIL model=%s language=%s err=%s",
                model,
                language,
                exc,
            )
            broadcast(
                {
                    "type": "candidate_asr_status",
                    "loaded": False,
                    "loading": False,
                    "provider": "whisper",
                    "error": str(exc)[:160],
                }
            )
        finally:
            with _candidate_whisper_preload_lock:
                _candidate_whisper_preload_inflight.discard(preload_key)

    threading.Thread(target=_load, daemon=True, name="candidate-whisper-preload").start()


def preload_candidate_asr_if_enabled() -> None:
    cfg = get_config()
    if not bool(getattr(cfg, "candidate_asr_enabled", False)):
        return
    provider, model, language, _allow_remote = _candidate_provider_config(cfg)
    if provider != "whisper":
        return
    broadcast({"type": "candidate_asr_status", "loaded": False, "loading": True, "provider": "whisper"})
    _preload_candidate_whisper_async(provider, model, language)


def _publish_candidate_transcription(
    session,
    text: str,
    provider: str,
    qa_id: str = "",
    *,
    segment_id: str = "",
    is_final: bool = True,
) -> None:
    cleaned = (text or "").strip()
    if not cleaned:
        return
    recent_interviewer = session.transcription_history[-3:]
    for item in recent_interviewer:
        interviewer_text = (
            item.text if hasattr(item, "text") else str(item or "")
        ).strip()
        if len(cleaned) < 12 or len(interviewer_text) < 12:
            continue
        threshold = 0.95 if len(cleaned) < 30 else 0.88
        similarity = SequenceMatcher(None, cleaned, interviewer_text).ratio()
        if similarity >= threshold:
            _ilog.info("CANDIDATE_ASR_SKIP_ECHO ratio=%.2f text=%r", similarity, cleaned[:80])
            return
    with conversation_lock:
        segment = session.add_candidate_transcription(
            cleaned,
            qa_id=qa_id or None,
            provider=provider,
            segment_id=segment_id,
            is_final=is_final,
        )
    if segment is None:
        return
    if segment.is_final and segment.qa_id:
        with conversation_lock:
            candidate_answer = session.get_candidate_answer_for_qa(segment.qa_id, max_chars=2400)
        if candidate_answer:
            _submit_candidate_knowledge_update(segment.qa_id, candidate_answer)
    _ilog.info(
        "CANDIDATE_ASR_PUBLISH segment=%s qa_id=%s final=%s provider=%s chars=%d",
        segment.segment_id,
        segment.qa_id,
        segment.is_final,
        provider,
        len(cleaned),
    )
    broadcast(
        {
            "type": "candidate_transcription",
            "scope": "assist",
            "text": cleaned,
            "qa_id": segment.qa_id,
            "provider": provider,
            "segment_id": segment.segment_id,
            "is_final": segment.is_final,
        }
    )


def _broadcast_candidate_asr_error(error: str) -> None:
    broadcast({
        "type": "candidate_asr_status",
        "loaded": False,
        "loading": False,
        "provider": "off",
        "error": error,
        "reason": "mic_unavailable",
        "safe_degraded": True,
    })


def _broadcast_candidate_asr_off(reason: str) -> None:
    broadcast({"type": "candidate_asr_status", "loaded": False, "loading": False, "provider": "off", "reason": reason})


def _candidate_worker(recording_generation: Optional[int] = None):
    generation = _capture_recording_generation() if recording_generation is None else recording_generation
    if not _recording_generation_is_current(generation):
        return
    try:
        _run_candidate_worker(generation)
    except Exception as exc:
        _elog.error("Candidate ASR worker initialization failed: %s", exc, exc_info=True)
        with _recording_generation_lock:
            if _recording_generation_is_current(generation):
                broadcast({
                    "type": "candidate_asr_status",
                    "loaded": False,
                    "loading": False,
                    "provider": "off",
                    "error": str(exc)[:160],
                })
    finally:
        with _recording_generation_lock:
            if _recording_generation_is_current(generation):
                with conversation_lock:
                    session = get_session()
                    if hasattr(session, "mark_candidate_asr_idle"):
                        session.mark_candidate_asr_idle()
                try:
                    _stop_capture_compat(_candidate_audio_capture, owner="assist-candidate", clear_queue=True)
                except Exception:
                    _elog.error("candidate audio_capture.stop failed", exc_info=True)


def _run_candidate_worker(generation: int):
    cfg = get_config()
    provider, model, language, allow_remote = _candidate_provider_config(cfg)
    streaming_enabled, streaming_interval_ms = _candidate_streaming_config(cfg, provider)
    _ilog.info(
        "CANDIDATE_ASR_WORKER_START provider=%s model=%s language=%s remote=%s streaming=%s interval_ms=%d",
        provider,
        model,
        language,
        allow_remote,
        streaming_enabled,
        streaming_interval_ms,
    )
    with _recording_generation_lock:
        if not _recording_generation_is_current(generation):
            return
        broadcast({"type": "candidate_asr_status", "loaded": False, "loading": provider == "whisper", "provider": provider})
        _preload_candidate_whisper_async(provider, model, language)

    vad = VADBuffer(
        sample_rate=AudioCapture.SAMPLE_RATE,
        silence_threshold=getattr(cfg, "silence_threshold", 0.01),
        silence_duration=getattr(cfg, "silence_duration", 1.2),
        max_speech_duration=30.0,
    )
    session = get_session()
    current_segment_id = ""
    last_partial_at = 0.0
    last_partial_text = ""

    def _mark_idle_if_current() -> None:
        with _recording_generation_lock:
            if _recording_generation_is_current(generation):
                with conversation_lock:
                    if hasattr(session, "mark_candidate_asr_idle"):
                        session.mark_candidate_asr_idle()

    def _publish_if_current(text: str, provider_name: str, **kwargs) -> bool:
        with _recording_generation_lock:
            if not _recording_generation_is_current(generation):
                return False
            _publish_candidate_transcription(session, text, provider_name, **kwargs)
            return True

    def _finalize_candidate_audio(final_audio, log_kind: str) -> None:
        nonlocal current_segment_id, last_partial_text, last_partial_at
        if final_audio is None or len(final_audio) <= AudioCapture.SAMPLE_RATE * 0.3:
            current_segment_id = ""
            last_partial_text = ""
            last_partial_at = 0.0
            _mark_idle_if_current()
            return
        local_cfg = get_config()
        final_provider, final_model, final_language, final_allow_remote = _candidate_provider_config(local_cfg)
        try:
            with _recording_generation_lock:
                if not _recording_generation_is_current(generation):
                    return
                with conversation_lock:
                    target_qa_id = (
                        getattr(session, "candidate_asr_active_qa_id", "")
                        or getattr(session, "current_candidate_qa_id", "")
                    )
                    if hasattr(session, "mark_candidate_asr_busy"):
                        session.mark_candidate_asr_busy(target_qa_id)
            t0 = time.monotonic()
            text = transcribe_with_fallback(
                final_audio,
                AudioCapture.SAMPLE_RATE,
                position=local_cfg.position,
                language=final_language,
                provider=final_provider,
                whisper_model=final_model,
                whisper_language=final_language,
                allow_remote=final_allow_remote,
                status_event_type="candidate_asr_status",
                scope="candidate",
                whisper_lock_timeout_sec=0.0,
            )
            pub = _publishable_transcription(
                text, local_cfg,
                min_sig=_candidate_min_sig(local_cfg),
            )
            if pub:
                replaced_partial = bool(current_segment_id and last_partial_text)
                _ilog.info(
                    "CANDIDATE_ASR_%s segment=%s qa_id=%s provider=%s raw=%.1fs stt=%.0fms chars=%d replaced_partial=%s text=%r",
                    log_kind,
                    current_segment_id,
                    target_qa_id,
                    final_provider,
                    len(final_audio) / AudioCapture.SAMPLE_RATE,
                    (time.monotonic() - t0) * 1000,
                    len(pub),
                    replaced_partial,
                    pub[:120],
                )
                _publish_if_current(
                    pub,
                    final_provider,
                    qa_id=target_qa_id,
                    segment_id=current_segment_id,
                    is_final=True,
                )
                with _recording_generation_lock:
                    if _recording_generation_is_current(generation):
                        broadcast({"type": "candidate_asr_status", "loaded": True, "loading": False, "provider": final_provider})
        except Exception as e:
            _elog.error("Candidate ASR transcribe error: %s", e, exc_info=True)
            with _recording_generation_lock:
                if _recording_generation_is_current(generation):
                    broadcast({"type": "candidate_asr_status", "loaded": False, "loading": False, "provider": final_provider, "error": str(e)[:160]})
        finally:
            _mark_idle_if_current()
            current_segment_id = ""
            last_partial_text = ""
            last_partial_at = 0.0

    try:
        while not _stop_event.is_set() and _recording_generation_is_current(generation):
            if _pause_event.is_set():
                if _candidate_flush_event.is_set():
                    _candidate_flush_event.clear()
                    _finalize_candidate_audio(vad.flush(), "PAUSE_FINAL")
                time.sleep(0.1)
                continue
            with _recording_generation_lock:
                if not _recording_generation_is_current(generation):
                    return
                chunks = _candidate_audio_capture.drain_audio_chunks(timeout=0.1, max_chunks=6)
            if not chunks:
                time.sleep(0.05)
                continue

            cfg = get_config()
            if not bool(getattr(cfg, "candidate_asr_enabled", False)):
                _mark_idle_if_current()
                continue

            pending_audio = None
            for chunk in chunks:
                for vad_chunk in _iter_vad_feed_chunks(chunk):
                    flushed = vad.feed(vad_chunk)
                    if flushed is not None:
                        # Commit the completed segment before starting a partial
                        # for speech that follows the 30-second boundary.
                        _finalize_candidate_audio(flushed, "FINAL")
            if getattr(vad, "has_pending_audio", False):
                with _recording_generation_lock:
                    if not _recording_generation_is_current(generation):
                        return
                    with conversation_lock:
                        if hasattr(session, "mark_candidate_asr_busy"):
                            session.mark_candidate_asr_busy()
                        target_qa_id = (
                            getattr(session, "candidate_asr_active_qa_id", "")
                            or getattr(session, "current_candidate_qa_id", "")
                        )
                if not current_segment_id:
                    current_segment_id = f"cand-{int(time.time() * 1000)}"
                    last_partial_text = ""
                    last_partial_at = 0.0
                    _ilog.info("CANDIDATE_ASR_SEGMENT_START segment=%s qa_id=%s", current_segment_id, target_qa_id)
                provider, model, language, allow_remote = _candidate_provider_config(cfg)
                streaming_enabled, streaming_interval_ms = _candidate_streaming_config(cfg, provider)
                now_mono = time.monotonic()
                pending_audio = vad.pending_audio() if hasattr(vad, "pending_audio") else None
                if (
                    streaming_enabled
                    and pending_audio is not None
                    and len(pending_audio) >= AudioCapture.SAMPLE_RATE * 1.0
                    and now_mono - last_partial_at >= streaming_interval_ms / 1000.0
                ):
                    last_partial_at = now_mono
                    try:
                        partial_t0 = time.monotonic()
                        partial_text = transcribe_with_fallback(
                            pending_audio,
                            AudioCapture.SAMPLE_RATE,
                            position=cfg.position,
                            language=language,
                            provider=provider,
                            whisper_model=model,
                            whisper_language=language,
                            allow_remote=False,
                            status_event_type="candidate_asr_status",
                            scope="candidate",
                            whisper_lock_timeout_sec=0.0,
                            whisper_require_loaded=True,
                        )
                        partial_pub = _publishable_transcription(
                            partial_text, cfg,
                            min_sig=_candidate_min_sig(cfg),
                        )
                        if partial_pub and partial_pub != last_partial_text:
                            last_partial_text = partial_pub
                            _ilog.info(
                                "CANDIDATE_ASR_PARTIAL segment=%s qa_id=%s provider=%s raw=%.1fs stt=%.0fms chars=%d text=%r",
                                current_segment_id,
                                target_qa_id,
                                provider,
                                len(pending_audio) / AudioCapture.SAMPLE_RATE,
                                (time.monotonic() - partial_t0) * 1000,
                                len(partial_pub),
                                partial_pub[:120],
                            )
                            _publish_if_current(
                                partial_pub,
                                provider,
                                qa_id=target_qa_id,
                                segment_id=current_segment_id,
                                is_final=False,
                            )
                        elif partial_pub:
                            _ilog.debug(
                                "CANDIDATE_ASR_PARTIAL_DUP segment=%s qa_id=%s chars=%d",
                                current_segment_id,
                                target_qa_id,
                                len(partial_pub),
                            )
                        else:
                            _ilog.debug(
                                "CANDIDATE_ASR_PARTIAL_EMPTY segment=%s qa_id=%s raw=%.1fs",
                                current_segment_id,
                                target_qa_id,
                                len(pending_audio) / AudioCapture.SAMPLE_RATE,
                            )
                    except Exception as exc:
                        _elog.debug("Candidate streaming ASR partial failed: %s", exc)
        if not _recording_generation_is_current(generation):
            return
        remaining = vad.flush()
        if remaining is not None:
            _finalize_candidate_audio(remaining, "FLUSH_FINAL")
    except Exception as e:
        _elog.error("Candidate ASR worker crashed: %s", e, exc_info=True)
        with _recording_generation_lock:
            if _recording_generation_is_current(generation):
                broadcast({"type": "candidate_asr_status", "loaded": False, "loading": False, "provider": provider, "error": str(e)[:160]})


# ---------------------------------------------------------------------------
# Answer generation worker
# ---------------------------------------------------------------------------

def _process_question_parallel(
    task: TaskPayload,
    seq: int,
    model_idx: int,
    sess_v: int,
    model_cfg_snapshot=None,
    config_snapshot=None,
):
    my_gen = _capture_generation()
    task_qa_id = str(_task_meta(task).get("qa_id") or "").strip()
    task_replacement_version = int(_task_meta(task).get("replacement_generation", 0) or 0)

    def session_stale() -> bool:
        return sess_v != _task_session_version

    def replacement_stale() -> bool:
        return bool(
            task_qa_id
            and _qa_replacement_version(task_qa_id) != task_replacement_version
        )

    def aborted() -> bool:
        if session_stale():
            return True
        if replacement_stale():
            return True
        if my_gen != _answer_generation:
            return True
        return False

    return process_question_parallel(
        task,
        seq,
        model_idx,
        sess_v,
        AnswerWorkerDeps(
            abort_check=aborted,
            is_session_current=lambda version: version == _task_session_version,
            replacement_stale_check=replacement_stale,
            flush_commit=_flush_commit,
            mark_seq_skipped=_mark_seq_skipped,
            submit_knowledge_record=_submit_knowledge_record,
            broadcast=broadcast,
            logger=_ilog,
            error_logger=_elog,
            model_cfg_snapshot=model_cfg_snapshot,
            config_snapshot=config_snapshot,
        ),
    )


def _save_knowledge_record(action: str, *args: object):
    try:
        from services.storage.knowledge import save_record, update_candidate_answer_for_qa

        if action == "candidate_update":
            qa_id = str(args[0] if len(args) > 0 else "")
            candidate_answer = str(args[1] if len(args) > 1 else "")
            update_candidate_answer_for_qa(qa_id, candidate_answer)
            return

        question = str(args[0] if len(args) > 0 else "")
        answer = str(args[1] if len(args) > 1 else "")
        qa_id = str(args[2] if len(args) > 2 else "")
        candidate_answer = str(args[3] if len(args) > 3 else "")
        save_record("assist", question, answer, qa_id=qa_id, candidate_answer=candidate_answer)
    except Exception as exc:
        _elog.warning("_save_knowledge_record failed: %s", exc)
