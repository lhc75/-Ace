# -*- coding: utf-8 -*-
"""AI面试API路由"""

import time
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from core.ai_interview_session import (
    AIInterviewSession,
    InterviewAnswer,
    InterviewPhase,
    QuestionType,
    STARTemplate,
    create_ai_interview_session,
    get_ai_interview_session,
    reset_ai_interview_session,
)
from services.ai_interview import (
    get_question_bank_manager,
    score_answer,
    guide_star_completion,
)
from core.logger import get_logger

router = APIRouter()
_log = get_logger("ai_interview.routes")


class StartAIInterviewRequest(BaseModel):
    """开始AI面试请求"""
    position: str = Field(default="后端开发", max_length=50)
    question_count: int = Field(default=5, ge=1, le=20)
    difficulty: Optional[str] = Field(default=None, pattern="^(easy|medium|hard)$")
    total_time_minutes: int = Field(default=60, ge=10, le=180)
    enable_star_guide: bool = True
    show_timer: bool = True


class SubmitAnswerRequest(BaseModel):
    """提交答案请求"""
    question_id: str = Field(..., max_length=100)
    answer_text: str = Field(..., min_length=1, max_length=10000)
    star_situation: Optional[str] = Field(default=None, max_length=2000)
    star_task: Optional[str] = Field(default=None, max_length=2000)
    star_action: Optional[str] = Field(default=None, max_length=2000)
    star_result: Optional[str] = Field(default=None, max_length=2000)
    time_used_seconds: float = Field(default=0.0, ge=0)


@router.post("/start")
async def start_ai_interview(req: StartAIInterviewRequest):
    """开始AI面试"""
    # 检查是否已有活跃会话
    existing_session = get_ai_interview_session()
    if existing_session and existing_session.is_active:
        raise HTTPException(409, "已有AI面试正在进行，请先结束当前面试")

    # 获取题目
    question_bank = get_question_bank_manager()
    questions = question_bank.get_questions_by_position(
        position=req.position,
        count=req.question_count,
        difficulty=req.difficulty,
    )

    if not questions:
        raise HTTPException(500, "未找到合适的面试题目")

    # 创建会话
    session_id = f"ai_interview_{int(time.time())}"
    session = create_ai_interview_session(
        session_id=session_id,
        questions=questions,
        position=req.position,
        total_time_limit_seconds=req.total_time_minutes * 60,
        enable_star_guide=req.enable_star_guide,
        show_timer=req.show_timer,
    )
    session.start()

    _log.info(
        "AI面试已开始: session_id=%s, position=%s, questions=%d",
        session_id,
        req.position,
        len(questions),
    )

    return {
        "ok": True,
        "session": session.to_dict(),
        "guide_message": _get_guide_message(req.position),
    }


@router.get("/session")
async def get_ai_interview_session_info():
    """获取当前AI面试会话信息"""
    session = get_ai_interview_session()
    if not session:
        return {"ok": True, "session": None}

    return {
        "ok": True,
        "session": session.to_dict(),
    }


@router.post("/next-question")
async def next_question():
    """获取下一题"""
    session = get_ai_interview_session()
    if not session:
        raise HTTPException(404, "没有活跃的AI面试会话")

    if not session.is_active:
        raise HTTPException(400, "AI面试已结束")

    question = session.next_question()
    if not question:
        # 没有更多题目，结束面试
        session.complete()
        return {
            "ok": True,
            "has_more": False,
            "session": session.to_dict(),
        }

    return {
        "ok": True,
        "has_more": True,
        "question": question.to_dict(),
        "session": session.to_dict(),
    }


@router.post("/submit-answer")
async def submit_answer(req: SubmitAnswerRequest):
    """提交答案并获取评分"""
    session = get_ai_interview_session()
    if not session:
        raise HTTPException(404, "没有活跃的AI面试会话")

    # 获取当前题目
    question = session.get_current_question()
    if not question or question.id != req.question_id:
        raise HTTPException(400, "题目ID不匹配")

    # 构建STAR数据（如果需要）
    star_data = None
    if question.requires_star and any([
        req.star_situation,
        req.star_task,
        req.star_action,
        req.star_result,
    ]):
        star_data = STARTemplate(
            situation=req.star_situation or "",
            task=req.star_task or "",
            action=req.star_action or "",
            result=req.star_result or "",
        )

    # 评分
    try:
        answer_score = score_answer(question, req.answer_text, star_data)
    except Exception as e:
        _log.error("评分失败: %s", e, exc_info=True)
        raise HTTPException(500, "评分失败，请稍后重试")

    # 保存答案
    answer = InterviewAnswer(
        question_id=req.question_id,
        answer_text=req.answer_text,
        star_data=star_data,
        score=answer_score,
        time_used_seconds=req.time_used_seconds,
    )
    session.submit_answer(answer)
    session.phase = InterviewPhase.FEEDBACK

    _log.info(
        "答案已提交: question_id=%s, score=%d/5",
        req.question_id,
        answer_score.score,
    )

    return {
        "ok": True,
        "score": answer_score.to_dict(),
        "session": session.to_dict(),
    }


@router.post("/check-star")
async def check_star_completion(answer_text: str = Field(..., max_length=10000)):
    """检查STAR模板完成情况"""
    try:
        result = guide_star_completion(answer_text)
        return {
            "ok": True,
            **result,
        }
    except Exception as e:
        _log.error("STAR检查失败: %s", e, exc_info=True)
        raise HTTPException(500, "STAR检查失败")


@router.post("/complete")
async def complete_ai_interview():
    """结束AI面试"""
    session = get_ai_interview_session()
    if not session:
        raise HTTPException(404, "没有活跃的AI面试会话")

    session.complete()

    _log.info(
        "AI面试已结束: session_id=%s, 总分=%.1f, 平均分=%.1f",
        session.session_id,
        session.total_score,
        session.average_score,
    )

    return {
        "ok": True,
        "session": session.to_dict(),
        "summary": _generate_summary(session),
    }


@router.post("/reset")
async def reset_ai_interview():
    """重置AI面试会话"""
    reset_ai_interview_session()
    _log.info("AI面试会话已重置")
    return {"ok": True}


@router.get("/questions/preview")
async def preview_questions(
    position: str = "后端开发",
    count: int = Field(default=10, ge=1, le=50),
    difficulty: Optional[str] = None,
):
    """预览题库（不创建会话）"""
    question_bank = get_question_bank_manager()
    questions = question_bank.get_questions_by_position(
        position=position,
        count=count,
        difficulty=difficulty,
    )

    return {
        "ok": True,
        "questions": [q.to_dict() for q in questions],
    }


def _get_guide_message(position: str) -> str:
    """获取开场引导语"""
    return f"""欢迎参加 {position} AI模拟面试！

本次面试流程：
1. 系统会依次提出面试问题
2. 您可以通过语音或文字回答
3. 系统会实时评分并给出改进建议
4. 项目经历类问题会引导您使用STAR模板回答

评分标准：
• 3分：基本回答，覆盖部分要点
• 4分：较为充分，覆盖主要要点
• 5分：完善回答，覆盖所有要点并有深度

准备好了就点击"下一题"开始吧！"""


def _generate_summary(session: AIInterviewSession) -> dict:
    """生成面试总结"""
    total_questions = len(session.answers)
    if total_questions == 0:
        return {
            "message": "未完成任何题目",
            "statistics": {},
        }

    scores = [a.score.score for a in session.answers if a.score]
    score_5_count = sum(1 for s in scores if s == 5)
    score_4_count = sum(1 for s in scores if s == 4)
    score_3_count = sum(1 for s in scores if s == 3)

    avg_time = sum(a.time_used_seconds for a in session.answers) / total_questions

    # 评价等级
    if session.average_score >= 4.5:
        level = "优秀"
        comment = "您的表现非常出色，准备充分！"
    elif session.average_score >= 3.8:
        level = "良好"
        comment = "表现不错，继续保持！"
    else:
        level = "需改进"
        comment = "建议加强练习，特别关注评分较低的题目。"

    return {
        "message": f"面试完成！总体评价：{level}",
        "comment": comment,
        "statistics": {
            "total_questions": total_questions,
            "average_score": round(session.average_score, 1),
            "total_score": round(session.total_score, 1),
            "score_distribution": {
                "5分": score_5_count,
                "4分": score_4_count,
                "3分": score_3_count,
            },
            "average_time_seconds": round(avg_time, 1),
            "total_time_seconds": round(session.get_elapsed_time(), 1),
        },
    }
