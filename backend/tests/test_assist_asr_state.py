from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import sys

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import pytest  # noqa: E402

from core.session import reset_session  # noqa: E402
from api.assist.asr_state import AssistAsrStateMachine  # noqa: E402


class _Logger:
    def info(self, *args, **kwargs):
        pass


def _cfg(**overrides):
    base = dict(
        auto_detect=True,
        transcription_min_sig_chars=2,
        assist_asr_confirm_window_sec=0.4,
        assist_asr_fast_confirm_sec=0.2,
        assist_asr_group_max_wait_sec=1.0,
        assist_transcription_merge_gap_sec=0,
        assist_transcription_merge_max_sec=12.0,
        # 默认关闭即时派发：门控/窗口类用例测的是受控路径；即时路径有专门用例显式打开
        assist_stream_asr_instant_dispatch=False,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def test_question_group_flush_submits_asr_task_with_turn_metadata():
    submitted: list[tuple] = []
    recorded: list[float] = []
    turn_ids = iter([7])
    state = AssistAsrStateMachine(
        broadcast=lambda _data: None,
        submit_answer_task=lambda task: submitted.append(task) or True,
        begin_asr_turn=lambda: next(turn_ids),
        record_asr_turn=recorded.append,
        is_high_churn_submission=lambda _cfg, _now: False,
        logger=_Logger(),
        clock=lambda: 10.0,
    )
    session = reset_session()

    state.handle_auto_detect_asr_text(
        _cfg(),
        session,
        "Redis 持久化讲一下",
        "conversation_mic",
        now_mono=0.0,
    )
    state.try_flush_question_group(_cfg(), session, now_mono=0.45)

    assert len(submitted) == 1
    question_text, image, manual_input, source, meta = submitted[0]
    assert "Redis 持久化讲一下" in question_text
    assert image is None
    assert manual_input is False
    assert source == "conversation_mic"
    assert meta["origin"] == "asr"
    assert meta["asr_turn_id"] == 7
    assert meta["utterances"] == ["Redis 持久化讲一下"]
    assert meta["high_churn_short_answer"] is False
    assert recorded == [10.0]
    assert state.pending_group is None


def test_cost_where_question_is_submitted_as_an_asr_task():
    submitted: list[tuple] = []
    state = AssistAsrStateMachine(
        broadcast=lambda _data: None,
        submit_answer_task=lambda task: submitted.append(task) or True,
        begin_asr_turn=lambda: 1,
        record_asr_turn=lambda _now: None,
        is_high_churn_submission=lambda _cfg, _now: False,
        logger=_Logger(),
        clock=lambda: 10.0,
    )
    session = reset_session()
    cfg = _cfg()

    state.handle_auto_detect_asr_text(
        cfg,
        session,
        "线程切换的成本主要来自哪里",
        "conversation_mic",
        now_mono=0.0,
    )
    state.try_flush_question_group(cfg, session, now_mono=0.45)

    assert len(submitted) == 1
    assert submitted[0][0] == "线程切换的成本主要来自哪里"
    assert submitted[0][3] == "conversation_mic"


def test_statement_question_waits_for_group_window_instead_of_fast_confirm():
    submitted: list[tuple] = []
    state = AssistAsrStateMachine(
        broadcast=lambda _data: None,
        submit_answer_task=lambda task: submitted.append(task) or True,
        begin_asr_turn=lambda: 1,
        record_asr_turn=lambda _now: None,
        is_high_churn_submission=lambda _cfg, _now: False,
        logger=_Logger(),
        clock=lambda: 10.0,
    )
    session = reset_session()
    cfg = _cfg(
        assist_asr_fast_confirm_sec=0.2,
        assist_asr_group_max_wait_sec=1.0,
    )

    state.handle_auto_detect_asr_text(
        cfg,
        session,
        "redis速度快的原因",
        "conversation_mic",
        now_mono=0.0,
    )
    state.try_flush_question_group(cfg, session, now_mono=0.3)
    assert submitted == []

    state.try_flush_question_group(cfg, session, now_mono=1.01)
    assert len(submitted) == 1
    assert submitted[0][0] == "redis速度快的原因"


def test_active_vad_defers_question_confirmation_until_speech_is_idle():
    submitted: list[tuple] = []
    active = True
    state = AssistAsrStateMachine(
        broadcast=lambda _data: None,
        submit_answer_task=lambda task: submitted.append(task) or True,
        begin_asr_turn=lambda: 1,
        record_asr_turn=lambda _now: None,
        is_high_churn_submission=lambda _cfg, _now: False,
        is_input_active=lambda: active,
        logger=_Logger(),
        clock=lambda: 10.0,
    )
    session = reset_session()
    cfg = _cfg()

    state.handle_auto_detect_asr_text(
        cfg,
        session,
        "和我简要的解释",
        "conversation_mic",
        now_mono=0.0,
    )
    state.try_flush_question_group(cfg, session, now_mono=2.0)
    assert submitted == []

    active = False
    state.try_flush_question_group(cfg, session, now_mono=2.0)
    assert len(submitted) == 1


def test_active_asr_queue_defers_question_confirmation():
    submitted: list[tuple] = []
    state = AssistAsrStateMachine(
        broadcast=lambda _data: None,
        submit_answer_task=lambda task: submitted.append(task) or True,
        begin_asr_turn=lambda: 1,
        record_asr_turn=lambda _now: None,
        is_high_churn_submission=lambda _cfg, _now: False,
        is_input_active=lambda: True,
        logger=_Logger(),
        clock=lambda: 10.0,
    )
    session = reset_session()
    cfg = _cfg()

    state.handle_auto_detect_asr_text(
        cfg,
        session,
        "线程切换的成本主要来自哪里",
        "conversation_mic",
        now_mono=0.0,
    )
    state.try_flush_question_group(cfg, session, now_mono=2.0)

    assert submitted == []


def test_candidate_group_waits_from_latest_fragment_not_first_fragment():
    submitted: list[tuple] = []
    state = AssistAsrStateMachine(
        broadcast=lambda _data: None,
        submit_answer_task=lambda task: submitted.append(task) or True,
        begin_asr_turn=lambda: 1,
        record_asr_turn=lambda _now: None,
        is_high_churn_submission=lambda _cfg, _now: False,
        logger=_Logger(),
        clock=lambda: 10.0,
    )
    session = reset_session()
    cfg = _cfg(
        assist_asr_confirm_window_sec=0.4,
        assist_asr_fast_confirm_sec=0.2,
        assist_asr_group_max_wait_sec=1.0,
        assist_transcription_merge_gap_sec=2.0,
    )

    state.handle_auto_detect_asr_text(
        cfg,
        session,
        "那关键字可以把数",
        "conversation_mic",
        now_mono=0.0,
    )
    state.try_flush_question_group(cfg, session, now_mono=2.0)
    assert submitted == []

    state.handle_auto_detect_asr_text(
        cfg,
        session,
        "数据变化立马刷新的",
        "conversation_mic",
        now_mono=2.0,
    )
    state.try_flush_question_group(cfg, session, now_mono=3.0)
    assert submitted == []

    state.try_flush_question_group(cfg, session, now_mono=4.5)
    assert len(submitted) == 1
    assert "那关键字可以把数" in submitted[0][0]
    assert "数据变化立马刷新的" in submitted[0][0]


def test_same_question_in_separate_confirmed_asr_groups_is_submitted_twice():
    submitted: list[tuple] = []
    turn_ids = iter([1, 2])
    state = AssistAsrStateMachine(
        broadcast=lambda _data: None,
        submit_answer_task=lambda task: submitted.append(task) or True,
        begin_asr_turn=lambda: next(turn_ids),
        record_asr_turn=lambda _now: None,
        is_high_churn_submission=lambda _cfg, _now: False,
        logger=_Logger(),
        clock=lambda: 10.0,
    )
    session = reset_session()
    cfg = _cfg()
    text = "线程切换的成本主要来自哪里"

    state.handle_auto_detect_asr_text(cfg, session, text, "conversation_mic", 0.0)
    state.try_flush_question_group(cfg, session, 0.45)
    state.handle_auto_detect_asr_text(cfg, session, text, "conversation_mic", 1.0)
    state.try_flush_question_group(cfg, session, 1.45)

    assert len(submitted) == 2
    assert [task[0] for task in submitted] == [text, text]
    assert [task[4]["asr_turn_id"] for task in submitted] == [1, 2]


def test_append_transcription_fragment_broadcasts_and_feeds_auto_detect_when_unmerged():
    broadcasts: list[dict] = []
    state = AssistAsrStateMachine(
        broadcast=broadcasts.append,
        submit_answer_task=lambda _task: True,
        begin_asr_turn=lambda: 1,
        record_asr_turn=lambda _now: None,
        is_high_churn_submission=lambda _cfg, _now: False,
        logger=_Logger(),
        clock=lambda: 10.0,
    )
    session = reset_session()
    session.capture_is_loopback = False

    state.append_transcription_fragment(
        _cfg(assist_transcription_merge_gap_sec=0),
        session,
        "Kafka 如何保证顺序",
        now_mono=3.0,
    )

    assert session.transcription_history[0].text == "Kafka 如何保证顺序"
    assert session.transcription_history[0].id
    assert broadcasts[0]["type"] == "transcription"
    assert broadcasts[0]["text"] == "Kafka 如何保证顺序"
    assert broadcasts[0]["id"] == session.transcription_history[0].id
    assert state.pending_group is not None
    assert state.pending_group.source == "conversation_mic"
    assert state.pending_group.utterances == ["Kafka 如何保证顺序"]


def test_constraint_tail_is_merged_with_previous_question_before_fast_confirm():
    submitted: list[tuple] = []
    state = AssistAsrStateMachine(
        broadcast=lambda _data: None,
        submit_answer_task=lambda task: submitted.append(task) or True,
        begin_asr_turn=lambda: 8,
        record_asr_turn=lambda _now: None,
        is_high_churn_submission=lambda _cfg, _now: False,
        logger=_Logger(),
        clock=lambda: 2.0,
    )
    session = reset_session()
    cfg = SimpleNamespace(
        auto_detect=True,
        transcription_min_sig_chars=2,
        assist_asr_confirm_window_sec=0.4,
        assist_asr_group_max_wait_sec=1.2,
        assist_transcription_merge_gap_sec=0,
        assist_transcription_merge_max_sec=12.0,
    )

    state.handle_auto_detect_asr_text(
        cfg,
        session,
        "rules 和 skills 的区别是什么",
        "conversation_loopback",
        now_mono=0.0,
    )
    state.handle_auto_detect_asr_text(
        cfg,
        session,
        "不要结合项目",
        "conversation_loopback",
        now_mono=0.3,
    )
    state.try_flush_question_group(cfg, session, now_mono=0.9)

    assert len(submitted) == 1
    question_text = submitted[0][0]
    assert "rules 和 skills 的区别是什么" in question_text
    assert "不要结合项目" in question_text


def test_late_constraint_tail_is_merged_before_question_flush():
    submitted: list[tuple] = []
    state = AssistAsrStateMachine(
        broadcast=lambda _data: None,
        submit_answer_task=lambda task: submitted.append(task) or True,
        begin_asr_turn=lambda: len(submitted) + 1,
        record_asr_turn=lambda _now: None,
        is_high_churn_submission=lambda _cfg, _now: False,
        logger=_Logger(),
        clock=lambda: 5.0,
    )
    session = reset_session()
    cfg = _cfg(
        assist_asr_confirm_window_sec=0.4,
        assist_asr_fast_confirm_sec=0.8,
        assist_asr_group_max_wait_sec=3.0,
    )

    state.handle_auto_detect_asr_text(
        cfg,
        session,
        "rules 和 skills 的区别是什么",
        "conversation_loopback",
        now_mono=0.0,
    )
    state.handle_auto_detect_asr_text(
        cfg,
        session,
        "不要结合项目",
        "conversation_loopback",
        now_mono=0.95,
    )
    assert submitted == []

    state.handle_auto_detect_asr_text(
        cfg,
        session,
        "pipeline 里怎么做 retry 和 timeout",
        "conversation_loopback",
        now_mono=1.6,
    )

    assert len(submitted) == 1
    question_text = submitted[0][0]
    assert "rules 和 skills 的区别是什么" in question_text
    assert "不要结合项目" in question_text
    assert state.pending_group is not None
    assert state.pending_group.utterances == ["pipeline 里怎么做 retry 和 timeout"]


def _make_stream_state(submitted, broadcasts, *, stream_mode=True, clock_value=10.0):
    state = AssistAsrStateMachine(
        broadcast=broadcasts.append,
        submit_answer_task=lambda task: submitted.append(task) or True,
        begin_asr_turn=lambda: 1,
        record_asr_turn=lambda _now: None,
        is_high_churn_submission=lambda _cfg, _now: False,
        logger=_Logger(),
        clock=lambda: clock_value,
    )
    state.stream_mode = stream_mode
    return state


def test_publish_stream_fragment_broadcasts_immediately_without_merge_buffer():
    submitted: list[tuple] = []
    broadcasts: list[dict] = []
    state = _make_stream_state(submitted, broadcasts)
    session = reset_session()
    cfg = _cfg()

    state.publish_stream_fragment(cfg, session, "Redis 持久化讲一下", now_mono=0.0)

    assert len(broadcasts) == 1
    assert broadcasts[0]["type"] == "transcription"
    assert broadcasts[0]["text"] == "Redis 持久化讲一下"
    assert state.merge_parts == []
    assert state.pending_group is not None
    assert state.pending_group.utterances == ["Redis 持久化讲一下"]


def test_stream_mode_promote_flushes_at_fast_stream_window():
    submitted: list[tuple] = []
    broadcasts: list[dict] = []
    state = _make_stream_state(submitted, broadcasts, stream_mode=True)
    session = reset_session()
    cfg = _cfg(assist_transcription_merge_gap_sec=2.0)

    state.publish_stream_fragment(cfg, session, "Redis 持久化讲一下", now_mono=0.0)
    state.try_flush_question_group(cfg, session, now_mono=0.39)
    assert submitted == []
    state.try_flush_question_group(cfg, session, now_mono=0.41)
    assert len(submitted) == 1
    assert submitted[0][4]["dispatch_after_mono"] == pytest.approx(10.0 + 0.5)
    assert submitted[0][4]["asr_tail_grace_until_mono"] == pytest.approx(10.0 + 0.5)


def test_non_stream_mode_keeps_slow_windows():
    submitted: list[tuple] = []
    broadcasts: list[dict] = []
    now = [0.0]
    state = _make_stream_state(submitted, broadcasts, stream_mode=False, clock_value=0.0)
    state.clock = lambda: now[0]
    session = reset_session()
    cfg = _cfg(assist_transcription_merge_gap_sec=2.0)

    state.append_transcription_fragment(cfg, session, "Redis 持久化讲一下", now_mono=0.0)
    assert broadcasts == []  # 非流式：先进合并缓冲
    now[0] = 2.01
    state.try_flush_merge_buffer(cfg, session, now_mono=2.01)
    assert broadcasts and broadcasts[0]["type"] == "transcription"

    # 定稿后 promote 单句按非流式 fast_confirm=0.2s（测试 cfg）确认
    state.try_flush_question_group(cfg, session, now_mono=2.01 + 0.19)
    assert submitted == []
    now[0] = 2.01 + 0.21
    state.try_flush_question_group(cfg, session, now_mono=2.01 + 0.21)
    assert len(submitted) == 1
    assert submitted[0][4]["dispatch_after_mono"] == pytest.approx(now[0] + 1.2)


def test_stream_mode_candidate_waits_1_5s_instead_of_2_45s():
    submitted: list[tuple] = []
    broadcasts: list[dict] = []
    state = _make_stream_state(submitted, broadcasts, stream_mode=True)
    session = reset_session()
    cfg = _cfg(assist_transcription_merge_gap_sec=2.0)

    state.publish_stream_fragment(cfg, session, "redis速度快的原因", now_mono=0.0)
    state.try_flush_question_group(cfg, session, now_mono=1.4)
    assert submitted == []
    state.try_flush_question_group(cfg, session, now_mono=1.51)
    assert len(submitted) == 1


def test_non_stream_candidate_keeps_longer_wait():
    submitted: list[tuple] = []
    broadcasts: list[dict] = []
    state = _make_stream_state(submitted, broadcasts, stream_mode=False)
    session = reset_session()
    cfg = _cfg(assist_transcription_merge_gap_sec=2.0)

    state.handle_auto_detect_asr_text(cfg, session, "redis速度快的原因", "conversation_mic", now_mono=0.0)
    state.try_flush_question_group(cfg, session, now_mono=1.6)
    assert submitted == []
    state.try_flush_question_group(cfg, session, now_mono=2.46)
    assert len(submitted) == 1


def test_stream_mode_still_never_flushes_while_input_active():
    submitted: list[tuple] = []
    broadcasts: list[dict] = []
    active = {"value": True}
    state = AssistAsrStateMachine(
        broadcast=broadcasts.append,
        submit_answer_task=lambda task: submitted.append(task) or True,
        begin_asr_turn=lambda: 1,
        record_asr_turn=lambda _now: None,
        is_high_churn_submission=lambda _cfg, _now: False,
        is_input_active=lambda: active["value"],
        logger=_Logger(),
        clock=lambda: 10.0,
    )
    state.stream_mode = True
    session = reset_session()
    cfg = _cfg()

    state.publish_stream_fragment(cfg, session, "Redis 持久化讲一下", now_mono=0.0)
    state.try_flush_question_group(cfg, session, now_mono=5.0)
    assert submitted == []  # 面试官还在说（VAD 活跃）时绝不派发
    active["value"] = False
    state.try_flush_question_group(cfg, session, now_mono=5.0)
    assert len(submitted) == 1


def test_stream_mode_groups_question_across_mid_question_pause():
    submitted: list[tuple] = []
    broadcasts: list[dict] = []
    idle = {"sec": 0.0}
    state = AssistAsrStateMachine(
        broadcast=broadcasts.append,
        submit_answer_task=lambda task: submitted.append(task) or True,
        begin_asr_turn=lambda: 1,
        record_asr_turn=lambda _now: None,
        is_high_churn_submission=lambda _cfg, _now: False,
        is_input_active=lambda: False,
        input_idle_sec=lambda: idle["sec"],
        logger=_Logger(),
        clock=lambda: 10.0,
    )
    state.stream_mode = True
    session = reset_session()
    cfg = _cfg()

    # sentence_end #1 落地即发布并入组
    state.publish_stream_fragment(cfg, session, "我们先聊聊 Redis 的持久化", now_mono=0.0)
    # 面试官句中停顿 0.8s：确认窗口已过，但静默门控（1.2s）拦住派发
    idle["sec"] = 0.8
    state.try_flush_question_group(cfg, session, now_mono=0.8)
    assert submitted == []
    # 停顿结束、下半句到来：重置静默计时并追加
    idle["sec"] = 0.0
    state.publish_stream_fragment(cfg, session, "它的持久化机制是什么", now_mono=1.0)
    # 下半句说完后静默满 1.2s：整组一次派发
    idle["sec"] = 1.25
    state.try_flush_question_group(cfg, session, now_mono=2.5)
    assert len(submitted) == 1
    question_text = submitted[0][0]
    assert "我们先聊聊 Redis 的持久化" in question_text
    assert "它的持久化机制是什么" in question_text
    assert submitted[0][4]["dispatch_after_mono"] == pytest.approx(10.0 + 0.5)


def test_non_stream_mode_ignores_silence_gate():
    submitted: list[tuple] = []
    broadcasts: list[dict] = []
    state = AssistAsrStateMachine(
        broadcast=broadcasts.append,
        submit_answer_task=lambda task: submitted.append(task) or True,
        begin_asr_turn=lambda: 1,
        record_asr_turn=lambda _now: None,
        is_high_churn_submission=lambda _cfg, _now: False,
        input_idle_sec=lambda: 0.0,  # 即使刚有语音，非流式也不应被门控
        logger=_Logger(),
        clock=lambda: 10.0,
    )
    state.stream_mode = False
    session = reset_session()
    cfg = _cfg()

    state.handle_auto_detect_asr_text(cfg, session, "Redis 持久化讲一下", "conversation_mic", now_mono=0.0)
    state.try_flush_question_group(cfg, session, now_mono=0.45)
    assert len(submitted) == 1


def test_instant_dispatch_flushes_even_while_vad_active():
    submitted: list[tuple] = []
    broadcasts: list[dict] = []
    state = AssistAsrStateMachine(
        broadcast=broadcasts.append,
        submit_answer_task=lambda task: submitted.append(task) or True,
        begin_asr_turn=lambda: 1,
        record_asr_turn=lambda _now: None,
        is_high_churn_submission=lambda _cfg, _now: False,
        is_input_active=lambda: True,   # 本地 VAD 还在拖尾
        input_idle_sec=lambda: 0.0,     # 且刚有语音能量
        logger=_Logger(),
        clock=lambda: 10.0,
    )
    state.stream_mode = True
    session = reset_session()
    cfg = _cfg(assist_stream_asr_instant_dispatch=True)

    state.publish_stream_fragment(cfg, session, "Redis 持久化讲一下", now_mono=0.0)
    state.try_flush_question_group(cfg, session, now_mono=0.11)
    assert len(submitted) == 1  # 两道门都被即时派发跳过
    assert submitted[0][4]["dispatch_after_mono"] == pytest.approx(10.0 + 0.1)


def test_instant_dispatch_windows_at_floor():
    submitted: list[tuple] = []
    broadcasts: list[dict] = []
    state = _make_stream_state(submitted, broadcasts, stream_mode=True)
    session = reset_session()
    cfg = _cfg(assist_stream_asr_instant_dispatch=True)

    state.publish_stream_fragment(cfg, session, "Redis 持久化讲一下", now_mono=0.0)
    state.try_flush_question_group(cfg, session, now_mono=0.09)
    assert submitted == []
    state.try_flush_question_group(cfg, session, now_mono=0.11)
    assert len(submitted) == 1


def test_instant_dispatch_ignores_orphan_constraint_tail():
    submitted: list[tuple] = []
    broadcasts: list[dict] = []
    state = _make_stream_state(submitted, broadcasts, stream_mode=True)
    session = reset_session()
    # append_late_constraint_tail 找不到可挂的任务（已即时派发）→ 返回 False
    state.append_late_constraint_tail = lambda *_args: False
    cfg = _cfg(assist_stream_asr_instant_dispatch=True)

    state.publish_stream_fragment(cfg, session, "Redis 持久化讲一下", now_mono=0.0)
    state.try_flush_question_group(cfg, session, now_mono=0.11)
    assert len(submitted) == 1

    state.handle_auto_detect_asr_text(
        cfg, session, "不要结合项目", "conversation_mic", now_mono=0.5,
    )
    state.try_flush_question_group(cfg, session, now_mono=0.61)
    # 裸约束尾巴被忽略：不产生第二次提交、不建组
    assert len(submitted) == 1
    assert state.pending_group is None


def test_instant_disabled_keeps_silence_gate():
    submitted: list[tuple] = []
    broadcasts: list[dict] = []
    state = AssistAsrStateMachine(
        broadcast=broadcasts.append,
        submit_answer_task=lambda task: submitted.append(task) or True,
        begin_asr_turn=lambda: 1,
        record_asr_turn=lambda _now: None,
        is_high_churn_submission=lambda _cfg, _now: False,
        is_input_active=lambda: False,
        input_idle_sec=lambda: 0.5,
        logger=_Logger(),
        clock=lambda: 10.0,
    )
    state.stream_mode = True
    session = reset_session()
    cfg = _cfg(assist_stream_asr_instant_dispatch=False)

    state.publish_stream_fragment(cfg, session, "Redis 持久化讲一下", now_mono=0.0)
    state.try_flush_question_group(cfg, session, now_mono=1.0)
    assert submitted == []  # 静默门控恢复生效（1.2s）
    state.input_idle_sec = lambda: 1.3
    state.try_flush_question_group(cfg, session, now_mono=2.0)
    assert len(submitted) == 1
