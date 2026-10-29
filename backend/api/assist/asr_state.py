"""ASR merge and question-group state machine for interview assist."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from services.stt import (
    build_asr_question_group_text,
    classify_asr_question_candidate,
    is_asr_question_constraint_tail,
    is_dangling_asr_utterance,
    is_viable_asr_question_group,
    join_transcription_fragments,
    transcription_for_publish,
)
from api.assist.scheduler import TaskPayload


@dataclass
class PendingASRGroup:
    source: str
    utterances: list[str] = field(default_factory=list)
    first_mono: float = 0.0
    last_mono: float = 0.0
    has_promote: bool = False
    # 最后一句定稿的分类与是否停在半句上：即时派发据此决定立刻发、稍等还是挂起等下文
    tail_kind: str = "candidate"
    tail_dangling: bool = False
    # 组内各句对应的转写行 id；半句与下文拼接后句数会少于转写行数，不能再按句数从尾部截取
    transcription_ids: list[str] = field(default_factory=list)


class AssistAsrStateMachine:
    def __init__(
        self,
        *,
        broadcast: Callable[[dict], None],
        submit_answer_task: Callable[[TaskPayload], bool],
        begin_asr_turn: Callable[[], int],
        record_asr_turn: Callable[[float], None],
        is_high_churn_submission: Callable[[Any, float], bool],
        logger,
        append_late_constraint_tail: Callable[[str, str, float], bool] | None = None,
        is_input_active: Callable[[], bool] | None = None,
        input_idle_sec: Callable[[], float] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.broadcast = broadcast
        self.submit_answer_task = submit_answer_task
        self.begin_asr_turn = begin_asr_turn
        self.record_asr_turn = record_asr_turn
        self.is_high_churn_submission = is_high_churn_submission
        self.append_late_constraint_tail = append_late_constraint_tail or (lambda _text, _source, _now: False)
        self.is_input_active = is_input_active or (lambda: False)
        self.input_idle_sec = input_idle_sec or (lambda: float("inf"))
        self.logger = logger
        self.clock = clock
        # True while the Aliyun streaming ASR path is active: server-side
        # sentence_end already marks complete sentences, so the question-group
        # windows can be much shorter than the VAD-segment defaults.
        self.stream_mode = False
        self.merge_parts: list[str] = []
        self.merge_mono_first: Optional[float] = None
        self.merge_mono_last: Optional[float] = None
        self.pending_group: Optional[PendingASRGroup] = None
        # 最近一次收到非空流式中间结果的时刻：晚于挂起组最后定稿，说明面试官又开口了
        self.last_interim_mono: Optional[float] = None

    def note_stream_interim(self, now_mono: float) -> None:
        self.last_interim_mono = now_mono

    def reset_merge_buffer(self):
        self.merge_parts = []
        self.merge_mono_first = None
        self.merge_mono_last = None

    def reset_pending_group(self):
        self.pending_group = None

    def flush_question_group_now(self, cfg, session) -> None:
        group = self.pending_group
        if group is None:
            return
        self.pending_group = None
        if not is_viable_asr_question_group(
            group.utterances,
            getattr(cfg, "transcription_min_sig_chars", 2),
        ):
            return
        question_text = build_asr_question_group_text(group.utterances)
        if not question_text:
            return
        now_mono = self.clock()
        high_churn_short = self.is_high_churn_submission(cfg, now_mono)
        turn_id = self.begin_asr_turn()
        self.record_asr_turn(now_mono)
        dispatch_grace = _asr_dispatch_grace_sec(cfg, self.stream_mode)
        self.logger.info(
            "ASR_QUESTION turn=%d utterances=%d churn=%s text=%r",
            turn_id, len(group.utterances), high_churn_short,
            question_text[:150],
        )
        self.submit_answer_task(
            (
                question_text,
                None,
                False,
                group.source,
                {
                    "origin": "asr",
                    "source_transcription_ids": list(group.transcription_ids) or [
                        item.id for item in session.transcription_history[-len(group.utterances):]
                        if hasattr(item, "id")
                    ],
                    "asr_turn_id": turn_id,
                    "utterances": list(group.utterances),
                    "high_churn_short_answer": high_churn_short,
                    "dispatch_after_mono": now_mono + dispatch_grace,
                    "asr_tail_grace_until_mono": now_mono + dispatch_grace,
                },
            )
        )

    def try_flush_question_group(self, cfg, session, now_mono: float, force: bool = False) -> None:
        group = self.pending_group
        if group is None:
            return
        instant = _stream_instant(cfg, self.stream_mode)
        if instant and not force:
            if self._instant_group_ready(cfg, group, now_mono):
                self.flush_question_group_now(cfg, session)
            return
        # VAD and the confirmation worker run independently. If VAD has
        # already started collecting the next speech burst, wait for that
        # burst to finish instead of answering only its first segment.
        # Instant dispatch skips this: the server already endpointed the
        # sentence, so the local VAD hangover must not delay the answer.
        if not force and not instant and self.is_input_active():
            return
        # Stream mode: finals are published at sentence_end, so the window
        # anchors at speech end — a mid-question pause must not split the
        # group. Gate on speech being idle long enough (not just on the time
        # since the last appended utterance). Instant dispatch skips this too.
        if (
            self.stream_mode
            and not force
            and not instant
            and self.input_idle_sec() < _asr_stream_silence_flush_sec(cfg)
        ):
            return
        confirm = _asr_confirm_window_sec(cfg, self.stream_mode)
        fast_confirm = _asr_fast_confirm_sec(cfg, self.stream_mode)
        max_wait = _asr_group_max_wait_sec(cfg)
        candidate_wait = _asr_candidate_wait_sec(cfg, self.stream_mode)
        if group.has_promote and len(group.utterances) == 1:
            max_wait = max(max_wait, fast_confirm + confirm)
        elif not group.has_promote:
            max_wait = max(max_wait, candidate_wait)
        since_last = now_mono - group.last_mono
        age = now_mono - group.first_mono
        if force:
            self.flush_question_group_now(cfg, session)
        elif group.has_promote and len(group.utterances) == 1 and since_last >= fast_confirm:
            self.flush_question_group_now(cfg, session)
        elif group.has_promote and since_last >= confirm:
            self.flush_question_group_now(cfg, session)
        elif not group.has_promote and since_last >= candidate_wait:
            self.flush_question_group_now(cfg, session)
        elif (
            age >= max_wait
            and len(group.utterances) == 1
            and since_last >= candidate_wait
        ):
            # For a single candidate, keep a hard upper bound. Once another
            # ASR fragment has joined the group, the silence since the latest
            # fragment is the meaningful boundary; using the age of the first
            # fragment would cut a continued sentence in the middle.
            self.flush_question_group_now(cfg, session)

    def _instant_group_ready(self, cfg, group: PendingASRGroup, now_mono: float) -> bool:
        """即时派发下挂起组是否该发出。

        - 完整问句（promote 且不停在半句）：沿用最短确认窗口，基本即发；
        - 停在半句，或定稿后面试官又开口（收到新的中间结果）：等下文定稿并入，
          静默满 dangling_wait 仍无下文才按现有文本发出；
        - 无疑问线索的陈述句：静默满 ambiguous_wait 且没再开口才发。
        无论哪种，距最后定稿超过 hold_max 都强制发出，防止噪声中间结果让问题一直挂着。
        """
        since_final = now_mono - group.last_mono
        if since_final >= _stream_hold_max_sec(cfg):
            return True
        interim = self.last_interim_mono
        resumed = interim is not None and interim > group.last_mono
        idle = now_mono - (interim if resumed else group.last_mono)
        if group.tail_dangling or resumed:
            return idle >= _stream_dangling_wait_sec(cfg)
        if group.tail_kind == "promote":
            return since_final >= _asr_fast_confirm_sec(cfg, True)
        return idle >= _stream_ambiguous_wait_sec(cfg)

    def dispatch_stream_final(self, cfg, session) -> None:
        """流式定稿刚并入问题组时调用：只有完整问句当场派发，其余交给 flush tick 判定。"""
        group = self.pending_group
        if group is None:
            return
        if group.tail_kind == "promote" and not group.tail_dangling:
            self.flush_question_group_now(cfg, session)

    def handle_auto_detect_asr_text(
        self,
        cfg,
        session,
        pub: str,
        source: str,
        now_mono: float,
        transcription_id: Optional[str] = None,
    ) -> None:
        kind, cleaned = classify_asr_question_candidate(
            pub,
            getattr(cfg, "transcription_min_sig_chars", 2),
        )
        if not cleaned:
            return
        if (
            self.pending_group is None
            and kind == "candidate"
            and is_asr_question_constraint_tail(cleaned)
        ):
            if self.append_late_constraint_tail(cleaned, source, now_mono):
                return
            if _stream_instant(cfg, self.stream_mode):
                # Instant dispatch already sent the question; an orphan
                # constraint tail must never become a standalone question.
                return
        if (
            self.pending_group is not None
            and kind == "candidate"
            and is_asr_question_constraint_tail(cleaned)
        ):
            self.pending_group.utterances.append(cleaned)
            self.pending_group.last_mono = now_mono
            self.pending_group.source = source
            return
        self.try_flush_question_group(cfg, session, now_mono, False)
        if kind == "ignore" and self.pending_group is None:
            return
        instant = _stream_instant(cfg, self.stream_mode)
        dangling = is_dangling_asr_utterance(pub)
        if self.pending_group is None:
            self.pending_group = PendingASRGroup(
                source=source,
                utterances=[cleaned],
                first_mono=now_mono,
                last_mono=now_mono,
                # Keep "can be answered" separate from "safe to confirm
                # quickly".  A statement such as "Redis 速度快的原因" is a
                # valid question for the answer queue, but a short pause
                # must not submit it as quickly as an explicit, completed
                # question.
                has_promote=(kind == "promote"),
                tail_kind=kind,
                tail_dangling=dangling,
                transcription_ids=[transcription_id] if transcription_id else [],
            )
        elif instant and kind == "ignore":
            # 挂起期间的“嗯/好的/hmm”不是下文：不并入、也不改变组的尾巴。
            return
        else:
            group = self.pending_group
            if instant and group.tail_dangling:
                # 上一句停在半句上，这句是它的后半截：拼回同一句，而不是当成“连续追问”。
                group.utterances[-1] = join_transcription_fragments([group.utterances[-1], cleaned])
            else:
                group.utterances.append(cleaned)
            group.last_mono = now_mono
            group.source = source
            group.has_promote = group.has_promote or kind == "promote"
            group.tail_kind = kind
            group.tail_dangling = dangling
            if transcription_id:
                group.transcription_ids.append(transcription_id)

    def _publish_and_detect(self, cfg, session, pub: str, now_mono: float) -> None:
        """发布一条转写到前端，并在 auto_detect 开启时送入问题检测。"""
        entry = session.add_transcription(pub)
        self.broadcast({"type": "transcription", "id": entry.id, "text": pub, "timestamp": entry.timestamp})
        if cfg.auto_detect:
            source = (
                "conversation_loopback"
                if session.capture_is_loopback
                else "conversation_mic"
            )
            self.handle_auto_detect_asr_text(
                cfg, session, pub, source, now_mono,
                transcription_id=getattr(entry, "id", None),
            )

    def flush_merge_buffer_now(self, cfg, session) -> None:
        if not self.merge_parts:
            return
        parts = list(self.merge_parts)
        self.merge_parts.clear()
        self.merge_mono_first = None
        self.merge_mono_last = None
        merged_raw = join_transcription_fragments(parts)
        min_sig = getattr(cfg, "transcription_min_sig_chars", 2)
        pub = transcription_for_publish(merged_raw, min_sig)
        if not pub:
            return
        self._publish_and_detect(cfg, session, pub, self.clock())

    def try_flush_merge_buffer(self, cfg, session, now_mono: float, force: bool = False) -> None:
        if not self.merge_parts:
            return
        if not force and self.is_input_active():
            return
        gap = float(getattr(cfg, "assist_transcription_merge_gap_sec", 2.0) or 0.0)
        max_wait = float(getattr(cfg, "assist_transcription_merge_max_sec", 12.0) or 12.0)
        if max_wait < 1.0:
            max_wait = 12.0
        if force:
            self.flush_merge_buffer_now(cfg, session)
            return
        if gap <= 0:
            return
        if self.merge_mono_last is None:
            return
        since_last = now_mono - self.merge_mono_last
        burst_age = (now_mono - self.merge_mono_first) if self.merge_mono_first is not None else 0.0
        if since_last >= gap or burst_age >= max_wait:
            self.flush_merge_buffer_now(cfg, session)

    def publish_stream_fragment(
        self,
        cfg,
        session,
        pub: str,
        now_mono: float,
    ) -> None:
        """Publish a streaming sentence_end final immediately: its own
        transcription row now (no merge-buffer wait) and the question group is
        fed at once; grouping still applies its confirmation windows."""
        self._publish_and_detect(cfg, session, pub, now_mono)

    def append_transcription_fragment(
        self,
        cfg,
        session,
        pub: str,
        now_mono: float,
        force_flush_tail: bool = False,
    ) -> None:
        gap = float(getattr(cfg, "assist_transcription_merge_gap_sec", 2.0) or 0.0)
        if gap <= 0:
            self._publish_and_detect(cfg, session, pub, now_mono)
            return
        if not self.merge_parts:
            self.merge_mono_first = now_mono
        self.merge_parts.append(pub)
        self.merge_mono_last = now_mono
        if force_flush_tail:
            self.flush_merge_buffer_now(cfg, session)
        else:
            self.try_flush_merge_buffer(cfg, session, now_mono, False)


def _asr_confirm_window_sec(cfg, stream_mode: bool = False) -> float:
    if stream_mode:
        if _stream_instant(cfg, stream_mode):
            return 0.1
        stream = float(getattr(cfg, "assist_stream_asr_confirm_window_sec", 0.4) or 0.0)
        return max(0.1, min(2.0, stream))
    confirm = float(getattr(cfg, "assist_asr_confirm_window_sec", 0.45) or 0.0)
    return max(0.0, min(5.0, confirm))


def _asr_group_max_wait_sec(cfg) -> float:
    max_wait = float(getattr(cfg, "assist_asr_group_max_wait_sec", 1.2) or 0.0)
    return max(0.2, min(8.0, max_wait))


def _asr_fast_confirm_sec(cfg, stream_mode: bool = False) -> float:
    if stream_mode:
        if _stream_instant(cfg, stream_mode):
            return 0.1
        stream = float(getattr(cfg, "assist_stream_asr_fast_confirm_sec", 0.8) or 0.0)
        return max(0.1, min(2.0, stream))
    fast = float(getattr(cfg, "assist_asr_fast_confirm_sec", 1.15) or 0.0)
    return max(0.1, min(2.0, fast))


def _asr_candidate_wait_sec(cfg, stream_mode: bool = False) -> float:
    """Wait long enough for a paused sentence to reach the merge buffer."""
    max_wait = _asr_group_max_wait_sec(cfg)
    if stream_mode:
        if _stream_instant(cfg, stream_mode):
            return max_wait
        stream = float(getattr(cfg, "assist_stream_asr_candidate_wait_sec", 1.5) or 0.0)
        return max(max_wait, max(0.3, min(5.0, stream)))
    merge_gap = float(getattr(cfg, "assist_transcription_merge_gap_sec", 0.0) or 0.0)
    return max(max_wait, merge_gap + _asr_confirm_window_sec(cfg))


def _asr_late_constraint_grace_sec(cfg) -> float:
    grace = float(getattr(cfg, "assist_asr_late_constraint_grace_sec", 1.2) or 0.0)
    return max(0.0, min(3.0, grace))


def _asr_dispatch_grace_sec(cfg, stream_mode: bool = False) -> float:
    if stream_mode:
        if _stream_instant(cfg, stream_mode):
            return 0.1
        stream = float(getattr(cfg, "assist_stream_asr_dispatch_grace_sec", 0.5) or 0.0)
        return max(0.0, min(3.0, stream))
    return _asr_late_constraint_grace_sec(cfg)


def _asr_stream_silence_flush_sec(cfg) -> float:
    gate = float(getattr(cfg, "assist_stream_asr_silence_flush_sec", 1.2) or 0.0)
    return max(0.3, min(3.0, gate))


def _stream_dangling_wait_sec(cfg) -> float:
    wait = float(getattr(cfg, "assist_stream_asr_dangling_wait_sec", 2.0) or 0.0)
    return max(0.5, min(6.0, wait))


def _stream_ambiguous_wait_sec(cfg) -> float:
    wait = float(getattr(cfg, "assist_stream_asr_ambiguous_wait_sec", 0.8) or 0.0)
    return max(0.1, min(3.0, wait))


def _stream_hold_max_sec(cfg) -> float:
    wait = float(getattr(cfg, "assist_stream_asr_hold_max_sec", 30.0) or 0.0)
    return max(5.0, min(60.0, wait))


def _stream_instant(cfg, stream_mode: bool = False) -> bool:
    """True when the qwen streaming path dispatches every sentence_end at once.

    The interviewer's question is assumed to be spoken in one breath, so the
    silence gate / confirmation windows are bypassed entirely."""
    return bool(stream_mode) and bool(getattr(cfg, "assist_stream_asr_instant_dispatch", True))
