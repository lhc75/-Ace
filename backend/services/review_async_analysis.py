"""
后台分析任务：异步分析 review session
"""
import threading
import re
from typing import Any, Optional

from core.logger import get_logger
from services.storage import review
from services.storage import knowledge
from services import review_analysis

logger = get_logger(__name__)
_SCORE_NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")


def _score_values(scorecard: Any) -> list[float]:
    if not isinstance(scorecard, dict):
        return []
    scores: list[float] = []
    for raw in scorecard.values():
        value: Optional[float] = None
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            value = float(raw)
        elif isinstance(raw, str):
            match = _SCORE_NUMBER_RE.search(raw.strip())
            if match:
                try:
                    value = float(match.group(0))
                except ValueError:
                    value = None
        if value is None or value < 0 or value > 10:
            continue
        scores.append(value)
    return scores


# 在途分析的 session 集合: 两个并发触发(手动 generate + on_assist_stop 自动)
# 不能各起一个线程同时写同一场的 turns/summary
_in_flight: set[int] = set()
_in_flight_lock = threading.Lock()
# 被一键清空取消的分析: worker 在下一题/写总结前自检退出，不再向已删除的行回写
_cancelled: set[int] = set()


def cancel_all_analyses() -> int:
    """取消所有在途分析（一键清空复盘前调用）。返回标记取消的数量。

    只打标记、不 join 线程：worker 在下一次写库前自检退出；清库后它对已删除
    行的兜底 UPDATE 也是 no-op。
    """
    with _in_flight_lock:
        _cancelled.update(_in_flight)
        return len(_in_flight)


def is_cancelled(session_id: int) -> bool:
    with _in_flight_lock:
        return session_id in _cancelled


def analyze_session_async(session_id: int) -> bool:
    """
    异步分析 session, 在后台线程中执行，不阻塞主流程。
    同一场已有分析在跑时直接返回 False, 不重复起线程。
    """
    with _in_flight_lock:
        if session_id in _in_flight:
            logger.info("Analysis already in flight for session_id=%d, skip", session_id)
            return False
        _in_flight.add(session_id)
        _cancelled.discard(session_id)
    review.update_session_status(session_id, "analyzing")
    thread = threading.Thread(
        target=_analyze_session_worker,
        args=(session_id,),
        daemon=True,
    )
    thread.start()
    logger.info("Started background analysis for session_id=%d", session_id)
    return True


def _analyze_session_worker(session_id: int):
    """
    分析 worker
    1. 逐题分析
    2. 生成整场总结
    3. 更新数据库
    """
    try:
        _analyze_session_inner(session_id)
    finally:
        with _in_flight_lock:
            _in_flight.discard(session_id)
            _cancelled.discard(session_id)


def _analyze_session_inner(session_id: int):
    try:
        logger.info("Analyzing session_id=%d", session_id)

        # 获取 session detail
        detail = review.get_session_detail(session_id)
        if not detail:
            logger.error("Session %d not found", session_id)
            return

        turns = detail.get("turns", [])
        review_source = str(detail.get("source") or "assist")
        if not turns:
            logger.info("Session %d has no turns, mark as completed", session_id)
            review.update_session_summary(
                session_id=session_id,
                summary_markdown="本场面试未录制到有效问答",
                strong_points=[],
                weak_points=[],
                avg_score=None,
            )
            review.update_session_status(session_id, "completed")
            return

        # 逐题分析
        analyzed_turns = []
        analysis_failed = False
        for turn in turns:
            if is_cancelled(session_id):
                logger.info("Analysis cancelled before turn: session_id=%d, turn_id=%d", session_id, turn["id"])
                return
            if turn["is_partial"]:
                logger.info("Skip partial turn: session_id=%d, turn_id=%d", session_id, turn["id"])
                continue

            try:
                result = review_analysis.analyze_turn(
                    question=turn["question_text"],
                    candidate_answer=turn["candidate_answer_text"],
                    reference_answer=turn.get("reference_answer_text", ""),
                    code_text=turn.get("code_text", ""),
                    review_source=review_source,
                )
                if result.get("error"):
                    raise RuntimeError(result["error"])

                if is_cancelled(session_id):
                    # 清库发生在 LLM 调用期间：结果直接丢弃，不回写已删除的行
                    logger.info("Analysis cancelled after turn LLM call: session_id=%d, turn_id=%d", session_id, turn["id"])
                    return

                # 更新 turn（包括纠正后的候选人回答）
                review.update_turn_analysis(
                    turn_id=turn["id"],
                    analysis_status="completed",
                    strengths=result.get("strengths", []),
                    risks=result.get("risks", []),
                    evidence=result.get("evidence", {}),
                    scorecard=result.get("scorecard", {}),
                    corrected_answer=result.get("corrected_answer"),  # ASR 纠错后的回答
                )

                # 用于整场总结的数据：使用纠正后的回答
                analyzed_turns.append({
                    **turn,
                    "candidate_answer_text": result.get("corrected_answer") or turn["candidate_answer_text"],
                    "strengths": result.get("strengths", []),
                    "risks": result.get("risks", []),
                    "scorecard": result.get("scorecard", {}),
                })

                # 把本题得分回写到知识库问答记录,能力分析雷达图只统计有评分的记录;
                # 候选人未作答(无口述也无代码)的 0 分不代表掌握度,跳过;
                # 手动复盘等场景知识库里没有对应记录时,补建一条
                turn_scores = _score_values(result.get("scorecard", {}))
                candidate_text = (result.get("corrected_answer") or turn.get("candidate_answer_text") or "").strip()
                has_submission = bool(candidate_text) or bool((turn.get("code_text") or "").strip())
                qa_id = str(turn.get("qa_id") or "").strip()
                if turn_scores and has_submission and qa_id:
                    try:
                        turn_avg = sum(turn_scores) / len(turn_scores)
                        if not knowledge.update_score_for_qa(qa_id, turn_avg):
                            knowledge.save_record(
                                review_source,
                                turn.get("question_text") or "",
                                turn.get("reference_answer_text") or "",
                                score=turn_avg,
                                qa_id=qa_id,
                                candidate_answer=candidate_text,
                            )
                    except Exception as score_err:
                        logger.warning(
                            "Failed to backfill knowledge score: session_id=%d, turn_id=%d, error=%s",
                            session_id,
                            turn["id"],
                            score_err,
                        )

                logger.info("Analyzed turn: session_id=%d, turn_id=%d", session_id, turn["id"])

            except Exception as e:
                analysis_failed = True
                logger.error(
                    "Failed to analyze turn: session_id=%d, turn_id=%d, error=%s",
                    session_id,
                    turn["id"],
                    e,
                    exc_info=True,
                )
                review.update_turn_analysis(
                    turn_id=turn["id"],
                    analysis_status="failed",
                )

        if is_cancelled(session_id):
            logger.info("Analysis cancelled before summary: session_id=%d", session_id)
            return

        try:
            summary_result = review_analysis.generate_summary(
                turns=analyzed_turns,
                review_source=review_source,
            )
            if summary_result.get("error"):
                raise RuntimeError(summary_result["error"])

            # 计算平均分
            all_scores = []
            for t in analyzed_turns:
                all_scores.extend(_score_values(t.get("scorecard", {})))
            avg_score = sum(all_scores) / len(all_scores) if all_scores else None

            # 更新 session
            review.update_session_summary(
                session_id=session_id,
                summary_markdown=summary_result.get("summary_markdown", ""),
                strong_points=summary_result.get("strong_points", []),
                weak_points=summary_result.get("weak_points", []),
                avg_score=avg_score,
            )

            logger.info("Generated summary for session_id=%d", session_id)

        except Exception as e:
            analysis_failed = True
            logger.error(
                "Failed to generate summary: session_id=%d, error=%s",
                session_id,
                e,
                exc_info=True,
            )

        status = "analysis_failed" if analysis_failed else "completed"
        review.update_session_status(session_id, status)
        logger.info("Analysis finished for session_id=%d status=%s", session_id, status)

    except Exception as e:
        logger.error(
            "Analysis worker failed: session_id=%d, error=%s",
            session_id,
            e,
            exc_info=True,
        )
        try:
            review.update_session_status(session_id, "analysis_failed")
        except Exception:
            pass
