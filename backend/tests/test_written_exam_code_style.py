"""笔试模式代码风格约束测试：编程题要求朴素易读、少用包。"""
from __future__ import annotations

from services.llm import build_system_prompt


def test_written_exam_prompt_requires_simple_readable_code():
    prompt = build_system_prompt(mode="written_exam")
    # 可读性第一 + 尽量少导入包，是本次新增的核心约束
    assert "可读性第一" in prompt
    assert "尽量少导入包" in prompt
    assert "代码长一点没关系" in prompt
    # 明确禁止花哨一行流 / 冷门库炫技
    assert "一行流" in prompt


def test_other_modes_do_not_carry_exam_code_style_rule():
    """该约束只加在笔试模式，不影响实时面试/手动文本模式。"""
    for mode in ("asr_realtime", "manual_text"):
        prompt = build_system_prompt(mode=mode)
        assert "尽量少导入包" not in prompt
