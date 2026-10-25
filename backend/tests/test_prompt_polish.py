"""Prompt polish (2026-04-17): intent ladder + resume two-mode + 首句硬约束 + 高 churn 追问."""
from __future__ import annotations

import pytest
from core.config import get_config
from services.llm import (
    build_system_prompt,
    create_answer_stream_sanitizer,
    is_incomplete_intent_answer,
    postprocess_answer_for_mode,
)


@pytest.fixture
def reset_resume():
    cfg = get_config()
    old = cfg.resume_text
    try:
        yield cfg
    finally:
        cfg.resume_text = old


def _asr_prompt(high_churn: bool = False) -> str:
    return build_system_prompt(
        mode="asr_realtime", high_churn_short_answer=high_churn
    )


def _manual_prompt() -> str:
    return build_system_prompt(mode="manual_text")


# ---- 4.1 intent ladder ---------------------------------------------------

def test_asr_realtime_has_intent_ladder_three_tiers():
    p = _asr_prompt(high_churn=False)
    assert "输入判定三档 ladder" in p
    assert "A. 完整" in p
    assert "B. 可猜意图" in p
    assert "C. 纯寒暄" in p
    assert "clarifier" in p or "我可以换个方向" in p


def test_asr_realtime_high_churn_also_has_intent_ladder():
    p = _asr_prompt(high_churn=True)
    assert "输入判定三档 ladder" in p
    assert "B. 可猜意图" in p
    assert "~80" in p or "80 字" in p


def test_asr_realtime_no_longer_uses_information_insufficient_halt():
    p = _asr_prompt(high_churn=False)
    assert "信息不足，先等待更完整的问题" not in p


def test_asr_prompt_does_not_treat_a_term_correction_as_a_complete_answer():
    p = _asr_prompt(high_churn=False)
    assert "即使其中有一个疑似 ASR 错词，也按 A 档处理" in p
    assert "绝不能作为唯一输出或作为回复结尾" in p


def test_incomplete_intent_answer_detector_only_matches_ladder_preface():
    assert is_incomplete_intent_answer("先按大概率问 RabbitMQ 的配置理解")
    assert is_incomplete_intent_answer("先按大概率问 RabbitMQ 的配置理解。")
    assert not is_incomplete_intent_answer(
        "先按大概率问 RabbitMQ 的配置理解。连接配置要包含地址、端口和虚拟主机。"
    )
    assert not is_incomplete_intent_answer("RabbitMQ 配置主要包括连接、交换机和队列。")


# ---- 4.2 resume two-mode color ------------------------------------------

def test_prompt_has_resume_two_mode_rule_when_resume_present(reset_resume):
    cfg = reset_resume
    cfg.resume_text = "项目A: 后端重构，Kafka, Redis；2022 字节实习。"
    p = _manual_prompt()
    assert "简历使用规则" in p
    assert "简历深挖题" in p
    assert "简历相关题" in p
    assert "简历无关题" in p


def test_no_resume_rule_when_resume_missing(reset_resume):
    cfg = reset_resume
    cfg.resume_text = None
    p = _manual_prompt()
    assert "简历使用规则" not in p


def test_written_exam_prompt_never_includes_resume(reset_resume):
    cfg = reset_resume
    cfg.resume_text = "项目A: 后端重构，Kafka, Redis；2022 字节实习。"
    p = build_system_prompt(mode="written_exam")
    assert "项目A" not in p
    assert "Kafka" not in p
    assert "简历使用规则" not in p
    assert "<resume_context>" not in p


def test_prompt_can_explicitly_disable_resume_context(reset_resume):
    cfg = reset_resume
    cfg.resume_text = "项目A: 后端重构，Kafka, Redis；2022 字节实习。"
    p = build_system_prompt(mode="asr_realtime", include_resume=False)
    assert "项目A" not in p
    assert "Kafka" not in p
    assert "简历使用规则" not in p
    assert "<resume_context>" not in p


def test_long_resume_is_fully_included_in_prompt(reset_resume):
    """多段实习的简历不得在进 prompt 时被截断（回归：之前只保留前 1800 字）。"""
    cfg = reset_resume
    cfg.resume_text = "张三 本科 计算机科学\n技能: Java, MySQL, Redis\n" + "\n".join(
        f"实习经历{i}: 公司{i} 后端实习，负责订单系统，Kafka/Redis，QPS 提升 3 倍。"
        for i in range(1, 7)
    )
    for mode in ("asr_realtime", "manual_text", "server_screen_code"):
        p = build_system_prompt(mode=mode)
        assert "实习经历6" in p
        assert "[简历内容过长" not in p
    p = _manual_prompt()
    assert "逐段介绍" in p  # 列举型问题必须覆盖所有经历


def test_resume_over_limit_truncates_at_line_boundary(reset_resume):
    cfg = reset_resume
    cfg.resume_text = "一段经历描述文字\n" * 1500
    p = _manual_prompt()
    assert "[简历内容过长" in p
    cut_pos = p.index("[简历内容过长")
    assert p[cut_pos - 1] == "\n"  # 不拦腰截断句子


def test_written_exam_prompt_handles_incremental_screenshots_and_failures(reset_resume):
    p = build_system_prompt(mode="written_exam")
    assert "连续截图/失败反馈规则" in p
    assert "当前截图优先于上一版答案" in p
    assert "新增约束" in p
    assert "失败用例" in p
    assert "修正后的完整可提交代码" in p


def test_written_exam_prompt_handles_aptitude_and_figure_reasoning(reset_resume):
    p = build_system_prompt(mode="written_exam")
    assert "图形推理" in p
    assert "旋转翻转" in p
    assert "逐一核对所有选项" in p
    assert "无法确认：缺少/看不清" in p
    assert "数量关系" in p
    assert "逻辑判断" in p


# ---- 4.3 first-sentence hard constraint ---------------------------------

def test_first_sentence_hard_constraint_in_asr():
    p = _asr_prompt(high_churn=False)
    assert "首句硬约束" in p
    assert "第一句直接给结论" in p
    assert "我理解你问的是" in p


def test_first_sentence_hard_constraint_in_manual_text():
    p = _manual_prompt()
    assert "首句硬约束" in p


# ---- 4.4 high-churn follow-up coherence ---------------------------------

def test_high_churn_branch_has_followup_coherence_rule():
    p = _asr_prompt(high_churn=True)
    assert "追问连贯" in p
    assert "[追问上下文]" in p


def test_normal_asr_still_has_followup_rule():
    p = _asr_prompt(high_churn=False)
    assert "[追问上下文]" in p


# ---- 4.5 candidate voice / anti-template polish -------------------------

def test_asr_prompt_asks_for_candidate_voice_not_template_headings():
    p = _asr_prompt(high_churn=False)
    assert "真人候选人口吻" in p
    assert "结论先行" in p
    assert "专注面板输出协议" in p
    assert "## 标题" in p
    assert "普通场景题 280-520 字" in p
    assert "项目深挖/复杂排障/系统设计题 420-780 字" in p


def test_asr_prompt_keeps_concept_comparison_from_forced_project_story():
    p = _asr_prompt(high_churn=False)
    assert "概念对比题" in p
    assert "rules 和 skills" in p
    assert "不要为了显得丰富而硬凑项目经历" in p
    assert "只有明确问“你的项目/你做过/简历里的 X”" in p
    assert "项目/经历使用硬规则" in p
    assert "不要把例子伪装成候选人亲历" in p
    assert "匿名工程例子" in p


def test_asr_prompt_uses_density_by_question_type_not_fixed_long_answer():
    p = _asr_prompt(high_churn=False)
    assert "概念/优缺点/区别题 180-320 字" in p
    assert "普通场景题 280-520 字" in p
    assert "项目深挖/复杂排障/系统设计题 420-780 字" in p
    assert "详细模式只增加机制、取舍、验证和边界密度" in p
    assert "不等于自动进入个人项目叙述" in p
    assert "不为凑字数扩展" in p
    assert "普通题 360-700 字" not in p


def test_asr_prompt_contains_recent_asr_term_repairs():
    p = _asr_prompt(high_churn=False)
    assert "健身测试→兼容性测试" in p
    assert "is 登录→iOS 登录" in p
    assert "街舞综合框架→接口自动化/自动化测试框架" in p
    assert "scale→skills" in p


def test_followup_prompt_inherits_context_for_fragments():
    p = _asr_prompt(high_churn=False)
    assert "优先继承上一轮的业务场景和技术对象" in p
    assert "当前追问已经把对象、条件和要问点说完整了" in p
    assert "题干续句" in p
    assert "安卓能登录但 iOS 不行" in p


def test_asr_high_churn_keeps_oral_short_answer_shape():
    p = _asr_prompt(high_churn=True)
    assert "像现场接一句话" in p
    assert "默认 80-180 字" in p


def test_manual_prompt_warns_not_to_emit_template_labels():
    p = _manual_prompt()
    assert "真人候选人口吻" in p
    assert "贴合本题的 `##` section 标题" in p
    assert "不要输出固定模板" in p
    assert "给代码时固定三段" not in p
    assert "普通题 500-900 字" in p
    assert "复杂设计/排障/治理题 900-1500 字" in p
    assert "题型模板" in p
    assert "普通技术题不要强行改写成个人项目故事" in p
    assert "详细模式只代表讲清机制、方案取舍、验证和风险" in p
    assert "不代表要编个人项目经历" in p
    assert "只有题干明确问" in p


def test_stream_sanitizer_removes_split_think_tags():
    s = create_answer_stream_sanitizer("manual_text")
    chunks = ["<thi", "nking>内部思考</thinking>用 AOF", " 和 RDB。"]
    out = "".join(s.push(c) for c in chunks) + s.finish()
    assert out == "用 AOF 和 RDB。"


def test_stream_sanitizer_cleans_manual_markdown_and_meta_preface():
    s = create_answer_stream_sanitizer("manual_text")
    out = s.push("这是一个经典问题。\n# 回答\n**核心**是先止血。") + s.finish()
    assert "这是一个经典问题" not in out
    assert "#" not in out
    assert "回答" not in out
    assert "**" not in out
    assert "核心是先止血。" in out


def test_postprocess_removes_internal_web_citation_markers():
    answer = "核心师资包括谢晓尧教授、刘志杰教授等 [W1][W3][W4]。\n\n研究方向 [W2, W5] 包括大数据。"

    cleaned = postprocess_answer_for_mode(answer, "manual_text")

    assert "[W" not in cleaned
    assert "等。" in cleaned
    assert "研究方向 包括大数据。" in cleaned


def test_stream_sanitizer_removes_split_web_citation_markers():
    sanitizer = create_answer_stream_sanitizer("manual_text")

    output = (
        sanitizer.push("结论来自公开资料 [W")
        + sanitizer.push("1][W3]。")
        + sanitizer.finish()
    )

    assert "[W" not in output
    assert output == "结论来自公开资料。"


def test_stream_sanitizer_keeps_focus_tab_headings_for_manual_text():
    s = create_answer_stream_sanitizer("manual_text")
    out = s.push("## 多元答案\n核心是先止血。") + s.finish()
    assert "## 多元答案" in out
    assert "核心是先止血。" in out


def test_stream_sanitizer_keeps_screen_markdown_but_removes_think():
    s = create_answer_stream_sanitizer("server_screen_code")
    out = s.push("<analysis>草稿</analysis># 题目理解\n正文") + s.finish()
    assert "草稿" not in out
    assert "# 题目理解" in out
