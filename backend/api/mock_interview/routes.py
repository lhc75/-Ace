"""AI 模拟面试 HTTP API。"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from core.config import get_config
from core.logger import get_logger
from services.mock_interview import (
    evaluate_answer,
    generate_interview_plan,
    generate_report,
    model_name,
)
from services.storage import mock_interview as store

router = APIRouter()
_log = get_logger("mock_interview.routes")


class CreateSessionRequest(BaseModel):
    position: str = Field(default="后端开发", max_length=100)
    company: str = Field(default="", max_length=100)
    job_description: str = Field(default="", max_length=8000)
    difficulty: Literal["easy", "medium", "hard"] = "medium"
    focus: Literal["balanced", "technical", "comprehensive"] = "balanced"


class QuestionActionRequest(BaseModel):
    question_id: str = Field(..., min_length=1, max_length=100)


class DraftRequest(BaseModel):
    question_id: str = Field(..., min_length=1, max_length=100)
    draft_text: str = Field(default="", max_length=30000)


class SubmitAnswerRequest(BaseModel):
    question_id: str = Field(..., min_length=1, max_length=100)
    answer_text: str = Field(default="", max_length=30000)
    auto_submitted: bool = False


class SelfAssessmentRequest(BaseModel):
    rating: int = Field(..., ge=1, le=5)
    note: str = Field(default="", max_length=4000)
    tags: list[str] = Field(default_factory=list, max_length=8)


def _detail_or_404(session_id: int) -> dict:
    detail = store.get_session_detail(session_id)
    if not detail:
        raise HTTPException(404, "模拟面试不存在")
    return detail


@router.get("/sessions")
async def list_sessions(limit: int = 100):
    return {"items": await run_in_threadpool(store.list_sessions, limit)}


@router.post("/sessions")
async def create_session(req: CreateSessionRequest):
    active_id = await run_in_threadpool(store.get_current_session_id)
    if active_id is not None:
        raise HTTPException(409, f"已有进行中的模拟面试（ID {active_id}），请先继续或删除")
    cfg = get_config()
    resume_text = (cfg.resume_text or "").strip()
    from services.storage.resume_history import get_filename_for_id

    resume_filename = ""
    try:
        if cfg.resume_active_history_id is not None:
            resume_filename = get_filename_for_id(int(cfg.resume_active_history_id)) or ""
    except Exception:
        resume_filename = ""
    try:
        plan = await run_in_threadpool(
            generate_interview_plan,
            position=req.position,
            company=req.company,
            job_description=req.job_description,
            difficulty=req.difficulty,
            focus=req.focus,
            resume_text=resume_text,
        )
    except store.MockInterviewBusyError as exc:
        raise HTTPException(409, str(exc)) from exc
    except Exception as exc:
        _log.warning("生成模拟面试蓝图失败: %s", exc, exc_info=True)
        raise HTTPException(502, f"生成面试问题失败：{str(exc)[:300]}") from exc
    try:
        detail = await run_in_threadpool(
            store.create_session,
            position=req.position,
            company=req.company,
            job_description=req.job_description,
            difficulty=req.difficulty,
            focus=req.focus,
            resume_snapshot=resume_text,
            resume_filename=resume_filename,
            model_name=model_name(),
            plan=plan,
        )
    except store.MockInterviewBusyError as exc:
        raise HTTPException(409, str(exc)) from exc
    except Exception as exc:
        _log.error("创建模拟面试失败: %s", exc, exc_info=True)
        raise HTTPException(500, f"创建模拟面试失败：{str(exc)[:300]}") from exc
    return detail


@router.get("/sessions/{session_id}")
async def get_session(session_id: int):
    return _detail_or_404(session_id)


@router.post("/sessions/{session_id}/start-answer")
async def start_answer(session_id: int, req: QuestionActionRequest):
    try:
        return await run_in_threadpool(store.start_answer, session_id, req.question_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except store.MockInterviewBusyError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.patch("/sessions/{session_id}/draft")
async def save_draft(session_id: int, req: DraftRequest):
    try:
        return await run_in_threadpool(
            store.save_draft, session_id, req.question_id, req.draft_text
        )
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except store.MockInterviewBusyError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/sessions/{session_id}/answers")
async def submit_answer(session_id: int, req: SubmitAnswerRequest):
    detail = _detail_or_404(session_id)
    if detail["status"] not in {"in_progress"}:
        raise HTTPException(409, "当前面试不在答题阶段")
    try:
        question = await run_in_threadpool(
            store.mark_answer_submitted,
            session_id,
            req.question_id,
            req.answer_text,
            req.auto_submitted,
        )
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except store.MockInterviewBusyError as exc:
        raise HTTPException(409, str(exc)) from exc

    recent = await run_in_threadpool(store.get_recent_answers, session_id, 8)
    existing_follow_ups = await run_in_threadpool(
        store.count_follow_ups, session_id, int(question["main_index"])
    )
    try:
        evaluation = await run_in_threadpool(
            evaluate_answer,
            position=detail["position"],
            company=detail["company"],
            question=question["question_text"],
            category=question["category"],
            answer=str(req.answer_text or ""),
            main_index=int(question["main_index"]),
            follow_up_count=existing_follow_ups,
            recent_context=recent,
        )
    except Exception as exc:
        _log.warning("模拟面试评分失败 session=%s: %s", session_id, exc, exc_info=True)
        await run_in_threadpool(store.mark_error, session_id, str(exc))
        raise HTTPException(502, f"AI 评分失败，答案已保存，可重试：{str(exc)[:300]}") from exc

    await run_in_threadpool(
        store.set_evaluation,
        session_id,
        req.question_id,
        evaluation["score"],
        evaluation,
    )

    next_question: Optional[dict] = None
    follow_up = evaluation.get("follow_up_question")
    if follow_up and existing_follow_ups < store.MAX_FOLLOW_UPS:
        next_question = await run_in_threadpool(
            store.add_follow_up,
            session_id,
            main_index=int(question["main_index"]),
            parent_id=req.question_id,
            category=question["category"],
            question_text=str(follow_up),
            answer_time_limit_seconds=int(evaluation.get("follow_up_time_limit_seconds") or 90),
        )
    else:
        next_main_index = int(question["main_index"]) + 1
        if next_main_index <= store.MAIN_QUESTION_TARGET:
            next_question = await run_in_threadpool(
                store.activate_next_main, session_id, next_main_index
            )
        if not next_question:
            await run_in_threadpool(store.mark_ready_to_finish, session_id)
            return {
                "assessment": evaluation,
                "ready_to_finish": True,
                "session": _detail_or_404(session_id),
            }

    return {
        "assessment": evaluation,
        "ready_to_finish": False,
        "next_question": next_question,
        "session": _detail_or_404(session_id),
    }


@router.post("/sessions/{session_id}/finish")
async def finish_session(session_id: int):
    detail = _detail_or_404(session_id)
    if detail["status"] == "completed" and detail.get("report"):
        return detail
    if detail["status"] not in {"in_progress", "ready_to_finish"}:
        raise HTTPException(409, "当前面试无法生成报告")
    questions = await run_in_threadpool(store.get_evaluated_questions, session_id)
    if not questions:
        raise HTTPException(400, "至少完成一道题后才能生成面试报告")
    raw_session = await run_in_threadpool(store.get_session_for_report, session_id)
    if not raw_session:
        raise HTTPException(404, "模拟面试不存在")
    try:
        report = await run_in_threadpool(
            generate_report, session=raw_session, questions=questions
        )
    except Exception as exc:
        _log.warning("生成模拟面试报告失败 session=%s: %s", session_id, exc, exc_info=True)
        await run_in_threadpool(store.mark_error, session_id, str(exc))
        raise HTTPException(502, f"生成面试报告失败，可重试：{str(exc)[:300]}") from exc
    await run_in_threadpool(
        store.update_report,
        session_id,
        total_score=float(report.get("total_score") or 0),
        report=report,
    )
    return _detail_or_404(session_id)


@router.post("/sessions/{session_id}/self-assessment")
async def self_assessment(session_id: int, req: SelfAssessmentRequest):
    try:
        return await run_in_threadpool(
            store.save_self_assessment,
            session_id,
            req.rating,
            req.note,
            req.tags,
        )
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: int):
    deleted = await run_in_threadpool(store.delete_session, session_id)
    if not deleted:
        raise HTTPException(404, "模拟面试不存在")
    return {"ok": True}
