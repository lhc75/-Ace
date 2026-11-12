"""AI 模拟面试：出题、追问决策和最终报告生成。"""
from __future__ import annotations

import json
import re
from types import SimpleNamespace
from typing import Any, Optional

from core.config import get_config, has_valid_api_key
from core.logger import get_logger
from services.llm.streaming import (
    _build_think_params,
    _completion_token_kwargs,
    get_client_for_model,
)

_log = get_logger("mock_interview.service")

PREP_SECONDS = 15
MAX_FOLLOW_UPS = 3
FOLLOW_UP_SCORE_THRESHOLD = 65.0
MAX_RESUME_CHARS = 12_000
MAX_JD_CHARS = 6_000

CATEGORY_LABELS = {
    "resume_project": "简历/项目深挖",
    "technical": "专业技术",
    "behavioral": "行为协作",
    "scenario": "情景应变",
    "motivation": "动机匹配",
}

DIMENSION_WEIGHTS = {
    "professional_accuracy": 0.25,
    "project_depth": 0.20,
    "logical_structure": 0.20,
    "communication": 0.15,
    "adaptability": 0.10,
    "role_motivation": 0.10,
}

DIMENSION_LABELS = {
    "professional_accuracy": "专业准确度",
    "project_depth": "项目深度与真实性",
    "logical_structure": "逻辑与结构",
    "communication": "沟通表达",
    "adaptability": "应变与追问",
    "role_motivation": "岗位动机与匹配",
}

_DEFAULT_LIMITS = {
    "resume_project": 180,
    "technical": 150,
    "behavioral": 150,
    "scenario": 120,
    "motivation": 120,
}


def _get_model():
    cfg = get_config()
    candidates = [cfg.get_review_model(), cfg.get_active_model()]
    for model in candidates:
        if has_valid_api_key(getattr(model, "api_key", "")):
            return model
    raise RuntimeError("未配置有效的 LLM API Key，请先在设置中配置模型")


def model_name() -> str:
    try:
        return str(_get_model().name or _get_model().model)
    except Exception:
        return ""


def _extract_json(content: str) -> dict[str, Any]:
    text = (content or "").strip()
    if not text:
        raise ValueError("模型返回空内容")
    if "```" in text:
        blocks = re.findall(r"```(?:json)?\s*(.*?)```", text, flags=re.S | re.I)
        for block in blocks:
            try:
                value = json.loads(block.strip())
                if isinstance(value, dict):
                    return value
            except json.JSONDecodeError:
                continue
    try:
        value = json.loads(text)
        if isinstance(value, dict):
            return value
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        value = json.loads(text[start : end + 1])
        if isinstance(value, dict):
            return value
    raise ValueError("模型未返回可解析的 JSON")


def _chat_json(
    *,
    system: str,
    user: str,
    max_tokens: int = 2500,
    temperature: float = 0.5,
) -> dict[str, Any]:
    model = _get_model()
    client = get_client_for_model(model)
    request_cfg = SimpleNamespace(think_mode=False, think_effort="off", max_tokens=max_tokens)
    kwargs = _completion_token_kwargs(model, max_tokens)
    think_params = _build_think_params(model, request_cfg)
    if think_params:
        kwargs["extra_body"] = think_params
    response = client.chat.completions.create(
        model=model.model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=temperature,
        **kwargs,
    )
    content = response.choices[0].message.content or ""
    try:
        return _extract_json(content)
    except Exception:
        repair = client.chat.completions.create(
            model=model.model,
            messages=[
                {"role": "system", "content": "你是 JSON 修复器。只输出合法 JSON，不要 Markdown。"},
                {
                    "role": "user",
                    "content": "把下面内容修复成严格 JSON，字段和值尽量保持不变：\n\n" + content[:12000],
                },
            ],
            temperature=0,
            **kwargs,
        )
        repaired = repair.choices[0].message.content or ""
        return _extract_json(repaired)


def _normalized_category(value: Any) -> str:
    category = str(value or "").strip().lower()
    aliases = {
        "project": "resume_project",
        "resume": "resume_project",
        "experience": "resume_project",
        "technical_question": "technical",
        "behavior": "behavioral",
        "behavioral_question": "behavioral",
        "situational": "scenario",
        "motivation_fit": "motivation",
        "comprehensive": "behavioral",
        "general": "behavioral",
    }
    category = aliases.get(category, category)
    return category if category in CATEGORY_LABELS else "behavioral"


def _clamp_limit(value: Any, category: str) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        parsed = _DEFAULT_LIMITS.get(category, 120)
    return max(45, min(300, parsed))


def _distribution(has_resume: bool, focus: str) -> str:
    if focus == "technical":
        return "技术强化：6 个专业技术、2 个简历/项目、1 个行为协作、1 个情景应变。"
    if focus == "comprehensive":
        return "综合强化：1 个简历/项目、3 个专业技术、3 个行为协作、2 个情景应变、1 个动机匹配。"
    if has_resume:
        return "均衡：3 个简历/项目深挖、3 个专业技术、2 个行为协作、1 个情景应变、1 个动机匹配。"
    return "均衡：4 个专业技术、3 个行为协作、2 个情景应变、1 个动机匹配。"


def generate_interview_plan(
    *,
    position: str,
    company: str,
    job_description: str,
    difficulty: str,
    focus: str,
    resume_text: str,
) -> list[dict[str, Any]]:
    has_resume = bool((resume_text or "").strip())
    prompt = f"""请为一次中文 AI 模拟面试生成 10 个主问题。

候选人目标岗位：{position or "后端开发"}
目标公司：{company or "未指定"}
难度：{difficulty}
侧重点：{focus}
题目分布要求：{_distribution(has_resume, focus)}

简历快照：
{resume_text[:MAX_RESUME_CHARS] if has_resume else "（未提供简历，请按目标岗位随机生成）"}

目标 JD（可选）：
{job_description[:MAX_JD_CHARS] or "（未提供）"}

要求：
1. 必须生成恰好 10 个主问题，按面试流程排列，不展示追问。
2. 必须技术问题与非技术综合问题混合；问题要适合口头回答。
3. 有简历时，简历/项目题要紧扣简历中的项目、技术栈、职责或成果，不得编造不存在的信息。
4. 无简历时，根据岗位生成通用专业题和综合题，不要提到简历。
5. 题目不得重复，不能是笔试编程题，不要求候选人现场写代码。
6. 为每题给出 answer_time_limit_seconds，必须是 45 到 300 之间的整数，根据题型和难度决定。
7. category 只能是 resume_project、technical、behavioral、scenario、motivation 之一。
8. 只输出 JSON，不要 Markdown 或解释。

JSON 格式：
{{
  "questions": [
    {{"category": "technical", "question": "请解释...", "answer_time_limit_seconds": 150}}
  ]
}}
"""
    data = _chat_json(
        system="你是一位严谨、经验丰富的中文技术面试官，擅长基于简历进行结构化面试。",
        user=prompt,
        max_tokens=3500,
        temperature=0.8,
    )
    raw_questions = data.get("questions")
    if not isinstance(raw_questions, list) or len(raw_questions) != 10:
        raise ValueError("模型未生成 10 个主问题，请重试")
    plan: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw_questions:
        if not isinstance(item, dict):
            continue
        question = re.sub(r"\s+", " ", str(item.get("question") or "")).strip()
        if len(question) < 6 or question in seen:
            continue
        seen.add(question)
        category = _normalized_category(item.get("category"))
        plan.append(
            {
                "category": category,
                "question": question[:500],
                "answer_time_limit_seconds": _clamp_limit(
                    item.get("answer_time_limit_seconds"), category
                ),
            }
        )
    if len(plan) != 10:
        raise ValueError("模型生成的问题数量不足或不重复校验失败，请重试")
    categories = {item["category"] for item in plan}
    if "technical" not in categories:
        raise ValueError("模型生成的问题缺少专业技术题，请重试")
    if not categories.intersection({"behavioral", "scenario", "motivation"}):
        raise ValueError("模型生成的问题缺少综合面试题，请重试")
    return plan


def evaluate_answer(
    *,
    position: str,
    company: str,
    question: str,
    category: str,
    answer: str,
    main_index: int,
    follow_up_count: int,
    recent_context: list[dict[str, Any]],
) -> dict[str, Any]:
    if not str(answer or "").strip():
        return {
            "score": 0.0,
            "strengths": [],
            "risks": ["本题未作答"],
            "improvement": "即使时间不足，也应先给出结论和一个具体例子。",
            "follow_up_question": None,
            "follow_up_reason": None,
            "follow_up_time_limit_seconds": _clamp_limit(None, category),
            "follow_up_count": follow_up_count,
        }
    context_text = "\n".join(
        f"- {item.get('question_text', '')}\n  回答：{str(item.get('answer_text') or '')[:1000]}"
        for item in recent_context[-5:]
    )
    prompt = f"""你是正在面试 {position or "目标岗位"} 候选人的中文面试官，公司是 {company or "未指定"}。

当前主问题：{main_index}/10
当前问题：{question}
题型：{CATEGORY_LABELS.get(category, category)}
候选人回答：
{answer or "（候选人未作答）"}

最近对话上下文：
{context_text or "（无）"}

请严格评价本题回答，并决定是否追问。
评分维度：准确性、完整性、逻辑、表达、岗位相关性与可信度。总分 0-100。
如果候选人未作答，score 必须为 0 且不要追问。
只有当 score >= 65、回答还有明确可深挖点、且当前主问题追问次数小于 3 时，才可以追问。
追问必须针对当前回答中的具体事实、技术取舍或风险点，只生成一个问题，不要泛泛而问。
若不适合追问，follow_up_question 必须为 null。
如果追问题型需要，可给出 45-300 秒的 follow_up_time_limit_seconds。

只输出 JSON：
{{
  "score": 78,
  "strengths": ["...", "..."],
  "risks": ["...", "..."],
  "improvement": "一条具体改进建议",
  "follow_up_question": "追问文本或 null",
  "follow_up_reason": "为什么追问或 null",
  "follow_up_time_limit_seconds": 90
}}
"""
    data = _chat_json(
        system="你是一位客观、克制、善于深挖但不纠缠候选人的中文面试官。",
        user=prompt,
        max_tokens=1600,
        temperature=0.25,
    )
    try:
        score = max(0.0, min(100.0, float(data.get("score") or 0)))
    except (TypeError, ValueError):
        score = 0.0
    follow_up = data.get("follow_up_question")
    follow_up_text = str(follow_up).strip() if follow_up else ""
    if answer.strip() and score >= FOLLOW_UP_SCORE_THRESHOLD and follow_up_count < MAX_FOLLOW_UPS:
        if follow_up_text.lower() in {"null", "none", "无"}:
            follow_up_text = ""
    else:
        follow_up_text = ""
    # 防止模型原样重复上一道题，浪费候选人的作答时间。
    recent_questions = {
        str(question or "").strip(),
        *{
            str(item.get("question_text") or "").strip()
            for item in recent_context
            if str(item.get("question_text") or "").strip()
        },
    }
    if follow_up_text in recent_questions:
        follow_up_text = ""
    return {
        "score": round(score, 1),
        "strengths": [str(x)[:200] for x in (data.get("strengths") or []) if str(x).strip()][:5],
        "risks": [str(x)[:200] for x in (data.get("risks") or []) if str(x).strip()][:5],
        "improvement": str(data.get("improvement") or "")[:500],
        "follow_up_question": follow_up_text[:500] if follow_up_text else None,
        "follow_up_reason": str(data.get("follow_up_reason") or "")[:300] if follow_up_text else None,
        "follow_up_time_limit_seconds": _clamp_limit(
            data.get("follow_up_time_limit_seconds"), category
        ),
        "follow_up_count": follow_up_count,
    }


def _question_review(item: dict[str, Any]) -> dict[str, Any]:
    evaluation = item.get("evaluation") if isinstance(item.get("evaluation"), dict) else {}
    return {
        "question_id": item.get("id"),
        "kind": item.get("kind"),
        "main_index": item.get("main_index"),
        "category": item.get("category"),
        "question": item.get("question_text"),
        "answer": item.get("answer_text"),
        "score": float(item.get("score") or evaluation.get("score") or 0),
        "strengths": evaluation.get("strengths") or [],
        "risks": evaluation.get("risks") or [],
        "improvement": evaluation.get("improvement") or "",
    }


def generate_report(
    *,
    session: dict[str, Any],
    questions: list[dict[str, Any]],
) -> dict[str, Any]:
    reviews = [_question_review(item) for item in questions]
    qa_text = "\n\n".join(
        f"[{idx}] 主问题 {item.get('main_index')} / {item.get('kind')} / {item.get('category')}\n"
        f"问题：{item.get('question_text')}\n"
        f"回答：{str(item.get('answer_text') or '（未作答）')[:1800]}\n"
        f"单题得分：{item.get('score', 0)}"
        for idx, item in enumerate(questions, start=1)
    )
    prompt = f"""请根据以下完整模拟面试记录，生成一份中文诊断报告。

岗位：{session.get('position')}
公司：{session.get('company') or "未指定"}
难度：{session.get('difficulty')}
简历快照：
{str(session.get('resume_snapshot') or '')[:10000] or "（无简历）"}

面试记录：
{qa_text[:50000]}

请返回严格 JSON：
{{
  "summary_markdown": "2-4 段整体评价，可含 Markdown 列表",
  "dimensions": {{
    "professional_accuracy": 0-100,
    "project_depth": 0-100,
    "logical_structure": 0-100,
    "communication": 0-100,
    "adaptability": 0-100,
    "role_motivation": 0-100
  }},
  "strengths": ["3-5 条具体亮点"],
  "risks": ["3-5 条具体风险"],
  "improvements": ["3-5 条可执行改进建议"],
  "next_practice_plan": ["3-5 个下一轮练习任务"]
}}

评分要参考候选人真实回答，不能虚构经历；未作答题目必须拉低相关维度。只输出 JSON。
"""
    data = _chat_json(
        system="你是一位资深面试教练，擅长给出具体、可执行且不空泛的诊断报告。",
        user=prompt,
        max_tokens=3000,
        temperature=0.3,
    )
    dimensions_raw = data.get("dimensions") if isinstance(data.get("dimensions"), dict) else {}
    dimensions: dict[str, float] = {}
    for key in DIMENSION_WEIGHTS:
        try:
            score = float(dimensions_raw.get(key) or 0)
        except (TypeError, ValueError):
            score = 0.0
        dimensions[key] = round(max(0.0, min(100.0, score)), 1)
    total = round(
        sum(dimensions[key] * weight for key, weight in DIMENSION_WEIGHTS.items()), 1
    )
    return {
        "total_score": total,
        "dimensions": [
            {
                "key": key,
                "label": DIMENSION_LABELS[key],
                "score": dimensions[key],
                "weight": int(DIMENSION_WEIGHTS[key] * 100),
            }
            for key in DIMENSION_WEIGHTS
        ],
        "summary_markdown": str(data.get("summary_markdown") or "").strip(),
        "strengths": [str(x)[:300] for x in (data.get("strengths") or []) if str(x).strip()][:6],
        "risks": [str(x)[:300] for x in (data.get("risks") or []) if str(x).strip()][:6],
        "improvements": [str(x)[:300] for x in (data.get("improvements") or []) if str(x).strip()][:6],
        "next_practice_plan": [
            str(x)[:300] for x in (data.get("next_practice_plan") or []) if str(x).strip()
        ][:6],
        "question_reviews": reviews,
        "answered_count": len(reviews),
        "main_question_target": 10,
        "max_follow_ups": MAX_FOLLOW_UPS,
    }
