"""千问流式即时派发的分级等待：用 2026-10-29 真实面试的定稿语句回放。

当天面试官换气停顿 0.6 秒就被定稿成一句并立刻送答题，一道题被拆成 3～5 次提问。
这里锁定修复后的行为：完整问句照旧即发；停在半句上的等下文拼回同一句；
无疑问线索的陈述句短暂静默后再发；任何挂起都有上限。
"""

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
from services.stt import is_dangling_asr_utterance  # noqa: E402


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
        assist_stream_asr_instant_dispatch=True,
        assist_stream_asr_dangling_wait_sec=2.0,
        assist_stream_asr_ambiguous_wait_sec=0.8,
        assist_stream_asr_hold_max_sec=30.0,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


class _Harness:
    """模拟流式链路：定稿回调 + 说话期间的中间结果 + flush worker 的 0.1 秒 tick。"""

    def __init__(self, **cfg_overrides):
        self.now = 0.0
        self.submitted: list[tuple] = []
        self.state = AssistAsrStateMachine(
            broadcast=lambda _data: None,
            submit_answer_task=lambda task: self.submitted.append(task) or True,
            begin_asr_turn=lambda: len(self.submitted) + 1,
            record_asr_turn=lambda _now: None,
            is_high_churn_submission=lambda _cfg, _now: False,
            logger=_Logger(),
            clock=lambda: self.now,
        )
        self.state.stream_mode = True
        self.session = reset_session()
        self.cfg = _cfg(**cfg_overrides)

    def final(self, t: float, text: str) -> None:
        self.now = t
        self.state.publish_stream_fragment(self.cfg, self.session, text, now_mono=t)
        self.state.dispatch_stream_final(self.cfg, self.session)

    def speaking(self, start: float, end: float, step: float = 0.3) -> None:
        t = start
        while t <= end + 1e-9:
            self.now = t
            self.state.note_stream_interim(t)
            self.state.try_flush_question_group(self.cfg, self.session, now_mono=t)
            t += step

    def silence(self, start: float, end: float, step: float = 0.1) -> None:
        t = start
        while t <= end + 1e-9:
            self.now = t
            self.state.try_flush_question_group(self.cfg, self.session, now_mono=t)
            t += step

    @property
    def questions(self) -> list[str]:
        return [task[0] for task in self.submitted]


# 当天被定稿成独立一句、其实话没说完的片段
TODAY_HALF_SENTENCES = [
    "嗯，结合你实我看简历上写写的实习的一些经历和项目，还不少。咱们结合这。",
    "嗯，好的啊，先聊一聊。就是我看里面写到了有一个在那个。",
    "啊，我再聊一下，就是。",
    "在做的另外一个项目啊，就是那个。",
    "可以提到的就是说，用了一呃，做了一些关于AI相关的一些工作哈。那我简单的聊一下，就是说。",
    "问现场的那种压测优化20万级的那种。",
    "就是做需求调研的时候，当你的用户或者是你的客户，他自己就是说没有一个清晰的呃表述自己的需求的时候啊，"
    "像遇到你你说的，像你去去了对方，他们不知道自己到底要个什么，像这种你觉得。",
    "第二方面的话，就是说我们会借助一些通用大模型的能力啊，做一些呃agent啊、数字呃暖身的一些机器人啊，"
    "或者是一些数字员工啊，啊做一些工具类的东西来助力我们整个。",
]

# 当天完整说完的问句/陈述：不能被当成半句挂起
TODAY_COMPLETE_UTTERANCES = [
    "有没有遇到过那种缓存击穿，或者是数据库不一致的情况？",
    "那局限性呢。",
    "你们是怎么做的？",
    "需求比较模糊的话，你参与过需求这一块没有呢？",
    "你说他也不知道自己要什么，那你们这个需求文档是怎么依据什么写出来的呀？",
    "对，就是这种、这种级别的这种压测优化，能具体说一说是怎么定位这种性能瓶颈的？怎么做的？",
    "哦，那我想问你，你你怎么看待这个问题啊？",
    "嗯，你在校专业成绩怎么样啊？",
    "好，最后我想了解一下，就是说呃自己啊就是自己对自己的一个职业规划是怎么打算的？"
    "就是未来比如说未来三五年希望自己啊在哪个行业哪方面去发展。",
    "嗯，好的，行。那我这边的话，就是关于你的那个情况，我大概了解这么多。",
]


@pytest.mark.parametrize("text", TODAY_HALF_SENTENCES)
def test_today_half_sentences_are_detected_as_dangling(text):
    assert is_dangling_asr_utterance(text)


@pytest.mark.parametrize("text", TODAY_COMPLETE_UTTERANCES)
def test_today_complete_utterances_are_not_dangling(text):
    assert not is_dangling_asr_utterance(text)


def test_complete_question_still_dispatches_at_once():
    h = _Harness()
    h.final(0.0, "有没有遇到过那种缓存击穿，或者是数据库不一致的情况？")
    assert len(h.submitted) == 1  # 定稿当场派发，不等任何 tick
    assert h.submitted[0][4]["dispatch_after_mono"] == pytest.approx(0.1)


def test_half_sentence_waits_for_followup_and_merges_into_one_question():
    # 14:02:30 停在“在那个。”，18 秒后才说出完整问题
    h = _Harness()
    h.final(0.0, "嗯，好的啊，先聊一聊。就是我看里面写到了有一个在那个。")
    h.speaking(0.3, 17.7)
    assert h.submitted == []
    h.final(
        18.0,
        "贵州省中小学平台项目哈，在这个项目里你提到了就是处理过那种百万级的并发，那么提到了那个Redis用于缓存和分布式锁。"
        "那结合这个场景，你说啊，请你这边就是啊分享一下，就是在高并发下那个缓存与数据库一致性你是怎么保障的？",
    )
    assert len(h.submitted) == 1
    question, _image, _manual, _source, meta = h.submitted[0]
    assert "在那个贵州省中小学平台项目" in question  # 拼回同一句，不是“连续追问”
    assert "缓存与数据库一致性" in question
    assert len(meta["utterances"]) == 1
    # 两条转写行都要挂到这道题上，删除/重发转写才能找到它
    history_ids = [item.id for item in h.session.transcription_history]
    assert meta["source_transcription_ids"] == history_ids[-2:]


def test_three_piece_question_from_today_becomes_one_dispatch():
    # 14:05:48 / 14:05:51 / 14:06:05：当天被发了 3 次
    h = _Harness()
    h.final(0.0, "啊，我再聊一下，就是。")
    h.speaking(0.3, 2.7)
    h.final(3.0, "在做的另外一个项目啊，就是那个。")
    h.speaking(3.3, 16.7)
    assert h.submitted == []
    h.final(
        17.0,
        "呃，全新保劳动用品大数据平台，这、这、这个是做这个项目的时候，你具体在这个项目中是负责哪个板块？"
        "然后整个这个项目的一个参与的一个完整度是怎么样的？",
    )
    assert len(h.submitted) == 1
    assert "我再聊一下" in h.questions[0]
    assert "另外一个项目" in h.questions[0]
    assert "负责哪个板块" in h.questions[0]


def test_dangling_without_followup_is_sent_after_dangling_wait():
    # 14:08:43 停在“那种。”后面试官没有立刻接着说
    h = _Harness()
    h.final(0.0, "问现场的那种压测优化20万级的那种。")
    h.silence(0.1, 1.9)
    assert h.submitted == []
    h.silence(2.0, 2.1)
    assert len(h.submitted) == 1


def test_statement_is_sent_after_short_silence():
    h = _Harness()
    h.final(0.0, "嗯，好的，行。那我这边的话，就是关于你的那个情况，我大概了解这么多。")
    h.silence(0.1, 0.7)
    assert h.submitted == []
    h.silence(0.8, 0.9)
    assert len(h.submitted) == 1


def test_statement_is_held_while_interviewer_keeps_talking():
    # 14:18:50 → 14:18:55：陈述句后面试官马上接着说，合并成一次提问
    h = _Harness()
    h.final(0.0, "嗯，好的，行。那我这边的话，就是关于你的那个情况，我大概了解这么多。")
    h.speaking(0.3, 4.7)
    assert h.submitted == []
    h.final(5.0, "呃，然后我也简单的介绍一下，就是你今天面试的这个岗位。")
    assert len(h.submitted) == 1
    assert "我大概了解这么多" in h.questions[0]
    assert "你今天面试的这个岗位" in h.questions[0]


def test_backchannel_during_hold_is_not_merged():
    h = _Harness()
    h.final(0.0, "啊，我再聊一下，就是。")
    h.final(0.5, "嗯，好。")
    assert h.submitted == []
    h.final(
        1.0,
        "全新保劳动用品大数据平台，你具体在这个项目中是负责哪个板块？",
    )
    assert len(h.submitted) == 1
    assert h.submitted[0][4]["utterances"] == [
        "我再聊一下，就是全新保劳动用品大数据平台，你具体在这个项目中是负责哪个板块",
    ]


def test_hold_is_bounded_even_if_interim_noise_never_stops():
    h = _Harness()
    h.final(0.0, "啊，我再聊一下，就是。")
    h.speaking(0.3, 29.7)
    assert h.submitted == []
    h.speaking(30.0, 31.0)
    assert len(h.submitted) == 1  # 到 hold_max 强制发出，且只发一次
