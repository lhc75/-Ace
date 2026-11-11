#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证真人面试辅助prompt的修改"""

import sys
sys.path.insert(0, 'backend')

from services.llm.prompts import build_system_prompt

def test_prompt_changes():
    """测试真人面试辅助模式的prompt修改"""

    # 生成真人面试辅助模式的prompt
    prompt = build_system_prompt(
        manual_input=False,  # ASR实时模式
        high_churn_short_answer=False
    )

    print("=" * 80)
    print("真人面试辅助模式 Prompt 验证")
    print("=" * 80)

    # 检查关键修改点
    checks = [
        ("✓ 角色定位明确（辅助AI）", "候选人的实时面试辅助AI" in prompt),
        ("✓ 强调幕后助手角色", "幕后助手" in prompt),
        ("✓ 明确输出是建议而非完整答案", "提供简洁实用的回答建议" in prompt),
        ("✓ 强调候选人会用自己的话表达", "用自己的话向面试官表达" in prompt),
        ("✓ 明确2-3秒理解时间约束", "2-3秒内理解核心思路" in prompt),
        ("✓ 输出原则：结构化要点和关键词", "结构化要点和关键词" in prompt),
        ("✓ 强调优先级", "核心观点 > 支撑论据 > 注意事项" in prompt),
        ("✓ 明确真人面试场景", "真人面试场景下" in prompt and "面试官看不到你的输出" in prompt),
        ("✓ 输出是面向候选人的建议", "输出面向候选人的回答建议" in prompt),
        ("✓ 不是面向面试官的完整答案", "不是面向面试官的完整答案" in prompt),
    ]

    all_passed = True
    for desc, result in checks:
        status = "✓" if result else "✗"
        print(f"{status} {desc}")
        if not result:
            all_passed = False

    print("\n" + "=" * 80)
    print("Prompt 预览（前1500字符）：")
    print("=" * 80)
    print(prompt[:1500])
    print("\n...")
    print("=" * 80)

    if all_passed:
        print("\n✓ 所有检查项通过！真人面试辅助prompt已成功优化。")
        return 0
    else:
        print("\n✗ 部分检查项未通过，请检查修改。")
        return 1

if __name__ == "__main__":
    sys.exit(test_prompt_changes())
