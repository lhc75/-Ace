"""AI 模拟面试会话持久化。仅保存文字、评分和报告，不保存原始音频。"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from typing import Any, Iterator, Optional

from services.storage.paths import sqlite_path

DB_PATH = sqlite_path("mock_interview.db")
_db_lock = threading.RLock()
PREP_SECONDS = 15
MAIN_QUESTION_TARGET = 10
MAX_FOLLOW_UPS = 3


class MockInterviewBusyError(RuntimeError):
    pass


@contextmanager
def _db() -> Iterator[sqlite3.Connection]:
    with _db_lock:
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()


def init_db() -> None:
    with _db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS mock_interview_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                status TEXT NOT NULL DEFAULT 'in_progress',
                position TEXT NOT NULL,
                company TEXT NOT NULL DEFAULT '',
                job_description TEXT NOT NULL DEFAULT '',
                difficulty TEXT NOT NULL DEFAULT 'medium',
                focus TEXT NOT NULL DEFAULT 'balanced',
                resume_snapshot TEXT NOT NULL DEFAULT '',
                resume_filename TEXT NOT NULL DEFAULT '',
                model_name TEXT NOT NULL DEFAULT '',
                question_plan_json TEXT NOT NULL DEFAULT '[]',
                main_index INTEGER NOT NULL DEFAULT 1,
                turn_count INTEGER NOT NULL DEFAULT 1,
                current_question_id TEXT,
                total_score REAL,
                report_json TEXT,
                self_rating INTEGER,
                self_note TEXT NOT NULL DEFAULT '',
                self_tags_json TEXT NOT NULL DEFAULT '[]',
                error_message TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                completed_at REAL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS mock_interview_questions (
                id TEXT PRIMARY KEY,
                session_id INTEGER NOT NULL,
                main_index INTEGER NOT NULL,
                turn_index INTEGER,
                kind TEXT NOT NULL DEFAULT 'main',
                parent_id TEXT,
                category TEXT NOT NULL,
                question_text TEXT NOT NULL,
                answer_time_limit_seconds INTEGER NOT NULL DEFAULT 120,
                prep_seconds INTEGER NOT NULL DEFAULT 15,
                phase TEXT NOT NULL DEFAULT 'pending',
                prep_started_at REAL,
                answer_started_at REAL,
                answer_deadline_at REAL,
                draft_text TEXT NOT NULL DEFAULT '',
                answer_text TEXT NOT NULL DEFAULT '',
                auto_submitted INTEGER NOT NULL DEFAULT 0,
                score REAL,
                evaluation_json TEXT,
                asked_at REAL,
                answered_at REAL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                FOREIGN KEY(session_id) REFERENCES mock_interview_sessions(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_mock_questions_session ON mock_interview_questions(session_id, asked_at)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_mock_sessions_updated ON mock_interview_sessions(updated_at DESC)"
        )


def _now() -> float:
    return time.time()


def _question_id() -> str:
    return f"mq_{uuid.uuid4().hex}"


def _loads(value: Any, fallback: Any) -> Any:
    if value is None or value == "":
        return fallback
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return fallback


def _session_row(conn: sqlite3.Connection, session_id: int) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM mock_interview_sessions WHERE id = ?", (session_id,)
    ).fetchone()


def _question_dict(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["auto_submitted"] = bool(data.get("auto_submitted"))
    data["evaluation"] = _loads(data.pop("evaluation_json", None), {})
    return data


def _session_summary(row: sqlite3.Row, current: Optional[sqlite3.Row] = None) -> dict[str, Any]:
    data = dict(row)
    data["question_plan"] = _loads(data.pop("question_plan_json", None), [])
    data["self_tags"] = _loads(data.pop("self_tags_json", None), [])
    data["report"] = _loads(data.pop("report_json", None), None)
    data["current_question"] = _question_dict(current) if current else None
    data["has_resume"] = bool((data.get("resume_snapshot") or "").strip())
    data["main_question_target"] = MAIN_QUESTION_TARGET
    data["max_follow_ups"] = MAX_FOLLOW_UPS
    data.pop("resume_snapshot", None)
    return data


def create_session(
    *,
    position: str,
    company: str,
    job_description: str,
    difficulty: str,
    focus: str,
    resume_snapshot: str,
    resume_filename: str,
    model_name: str,
    plan: list[dict[str, Any]],
) -> dict[str, Any]:
    if len(plan) != MAIN_QUESTION_TARGET:
        raise ValueError("模拟面试题目蓝图必须包含 10 个主问题")
    now = _now()
    with _db() as conn:
        active = conn.execute(
            "SELECT id FROM mock_interview_sessions WHERE status = 'in_progress' ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if active:
            raise MockInterviewBusyError(f"已有进行中的模拟面试（ID {active['id']}）")
        cur = conn.execute(
            """
            INSERT INTO mock_interview_sessions (
                status, position, company, job_description, difficulty, focus,
                resume_snapshot, resume_filename, model_name, question_plan_json,
                main_index, turn_count, created_at, updated_at
            ) VALUES ('in_progress', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
            """,
            (
                position.strip() or "后端开发",
                company.strip(),
                job_description.strip(),
                difficulty,
                focus,
                resume_snapshot.strip(),
                resume_filename.strip(),
                model_name,
                json.dumps(plan, ensure_ascii=False),
                now,
                now,
            ),
        )
        session_id = int(cur.lastrowid)
        first_id = _question_id()
        for index, item in enumerate(plan, start=1):
            is_first = index == 1
            conn.execute(
                """
                INSERT INTO mock_interview_questions (
                    id, session_id, main_index, turn_index, kind, category,
                    question_text, answer_time_limit_seconds, prep_seconds,
                    phase, prep_started_at, asked_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    first_id if is_first else _question_id(),
                    session_id,
                    index,
                    1 if is_first else None,
                    str(item.get("category") or "technical"),
                    str(item.get("question") or "").strip(),
                    max(45, min(300, int(item.get("answer_time_limit_seconds") or 120))),
                    PREP_SECONDS,
                    "thinking" if is_first else "pending",
                    now if is_first else None,
                    now if is_first else None,
                    now,
                    now,
                ),
            )
        conn.execute(
            "UPDATE mock_interview_sessions SET current_question_id = ? WHERE id = ?",
            (first_id, session_id),
        )
    detail = get_session_detail(session_id)
    assert detail is not None
    return detail


def list_sessions(limit: int = 100) -> list[dict[str, Any]]:
    with _db() as conn:
        rows = conn.execute(
            "SELECT * FROM mock_interview_sessions ORDER BY updated_at DESC LIMIT ?",
            (max(1, min(200, int(limit))),),
        ).fetchall()
        result = []
        for row in rows:
            current = None
            if row["current_question_id"]:
                current = conn.execute(
                    "SELECT * FROM mock_interview_questions WHERE id = ?",
                    (row["current_question_id"],),
                ).fetchone()
            counts = conn.execute(
                """
                SELECT
                    SUM(CASE WHEN phase IN ('submitted_pending_eval','evaluated') THEN 1 ELSE 0 END) AS answered_count,
                    SUM(CASE WHEN kind = 'main' AND phase IN ('submitted_pending_eval','evaluated') THEN 1 ELSE 0 END) AS main_answered_count
                FROM mock_interview_questions
                WHERE session_id = ?
                """,
                (row["id"],),
            ).fetchone()
            summary = _session_summary(row, current)
            summary["answered_count"] = int((counts["answered_count"] if counts else 0) or 0)
            summary["main_answered_count"] = int((counts["main_answered_count"] if counts else 0) or 0)
            result.append(summary)
        return result


def get_current_session_id() -> Optional[int]:
    with _db() as conn:
        row = conn.execute(
            "SELECT id FROM mock_interview_sessions WHERE status = 'in_progress' ORDER BY id DESC LIMIT 1"
        ).fetchone()
        return int(row["id"]) if row else None


def get_session_detail(session_id: int) -> Optional[dict[str, Any]]:
    with _db() as conn:
        row = _session_row(conn, session_id)
        if not row:
            return None
        current = None
        if row["current_question_id"]:
            current = conn.execute(
                "SELECT * FROM mock_interview_questions WHERE id = ?",
                (row["current_question_id"],),
            ).fetchone()
        question_rows = conn.execute(
            """
            SELECT * FROM mock_interview_questions
            WHERE session_id = ? AND asked_at IS NOT NULL
            ORDER BY asked_at ASC, created_at ASC
            """,
            (session_id,),
        ).fetchall()
    data = _session_summary(row, current)
    data["questions"] = [_question_dict(q) for q in question_rows]
    data["answered_count"] = sum(1 for q in data["questions"] if q.get("phase") in {"submitted", "evaluated"})
    data["main_answered_count"] = sum(
        1 for q in data["questions"] if q.get("kind") == "main" and q.get("phase") in {"submitted", "evaluated"}
    )
    return data


def get_question(session_id: int, question_id: str) -> Optional[dict[str, Any]]:
    with _db() as conn:
        row = conn.execute(
            "SELECT * FROM mock_interview_questions WHERE id = ? AND session_id = ?",
            (question_id, session_id),
        ).fetchone()
        return _question_dict(row) if row else None


def get_current_question(session_id: int) -> Optional[dict[str, Any]]:
    with _db() as conn:
        row = _session_row(conn, session_id)
        if not row or not row["current_question_id"]:
            return None
        q = conn.execute(
            "SELECT * FROM mock_interview_questions WHERE id = ?",
            (row["current_question_id"],),
        ).fetchone()
        return _question_dict(q) if q else None


def start_answer(session_id: int, question_id: str) -> dict[str, Any]:
    now = _now()
    with _db() as conn:
        session = _session_row(conn, session_id)
        if not session:
            raise FileNotFoundError("模拟面试不存在")
        if session["current_question_id"] != question_id:
            raise MockInterviewBusyError("只能回答当前问题")
        row = conn.execute(
            "SELECT * FROM mock_interview_questions WHERE id = ?", (question_id,)
        ).fetchone()
        if not row:
            raise FileNotFoundError("问题不存在")
        if row["phase"] == "thinking":
            deadline = now + int(row["answer_time_limit_seconds"])
            conn.execute(
                """
                UPDATE mock_interview_questions
                SET phase = 'answering', answer_started_at = ?, answer_deadline_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (now, deadline, now, question_id),
            )
        elif row["phase"] != "answering":
            raise MockInterviewBusyError("当前问题不在回答阶段")
        conn.execute(
            "UPDATE mock_interview_sessions SET updated_at = ? WHERE id = ?", (now, session_id)
        )
    detail = get_session_detail(session_id)
    assert detail is not None
    return detail


def save_draft(session_id: int, question_id: str, draft_text: str) -> dict[str, Any]:
    now = _now()
    text = str(draft_text or "")[:30000]
    with _db() as conn:
        session = _session_row(conn, session_id)
        if not session:
            raise FileNotFoundError("模拟面试不存在")
        if session["current_question_id"] != question_id:
            raise MockInterviewBusyError("草稿只属于当前问题")
        conn.execute(
            "UPDATE mock_interview_questions SET draft_text = ?, updated_at = ? WHERE id = ?",
            (text, now, question_id),
        )
        conn.execute(
            "UPDATE mock_interview_sessions SET updated_at = ? WHERE id = ?", (now, session_id)
        )
    return {"ok": True, "saved_at": now}


def mark_answer_submitted(
    session_id: int,
    question_id: str,
    answer_text: str,
    auto_submitted: bool,
) -> dict[str, Any]:
    now = _now()
    text = str(answer_text or "")[:30000]
    with _db() as conn:
        session = _session_row(conn, session_id)
        if not session:
            raise FileNotFoundError("模拟面试不存在")
        if session["current_question_id"] != question_id:
            raise MockInterviewBusyError("只能提交当前问题")
        row = conn.execute(
            "SELECT * FROM mock_interview_questions WHERE id = ?", (question_id,)
        ).fetchone()
        if not row:
            raise FileNotFoundError("问题不存在")
        if row["phase"] not in {"answering", "thinking", "submitted_pending_eval"}:
            raise MockInterviewBusyError("当前问题已提交")
        if row["phase"] != "submitted_pending_eval":
            conn.execute(
                """
                UPDATE mock_interview_questions
                SET phase = 'submitted_pending_eval', answer_text = ?, draft_text = ?,
                    auto_submitted = ?, answered_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (text, text, 1 if auto_submitted else 0, now, now, question_id),
            )
        conn.execute(
            "UPDATE mock_interview_sessions SET updated_at = ?, error_message = NULL WHERE id = ?",
            (now, session_id),
        )
    result = get_question(session_id, question_id)
    assert result is not None
    return result


def set_evaluation(
    session_id: int,
    question_id: str,
    score: float,
    evaluation: dict[str, Any],
) -> None:
    now = _now()
    with _db() as conn:
        conn.execute(
            """
            UPDATE mock_interview_questions
            SET phase = 'evaluated', score = ?, evaluation_json = ?, updated_at = ?
            WHERE id = ? AND session_id = ?
            """,
            (max(0.0, min(100.0, float(score))), json.dumps(evaluation, ensure_ascii=False), now, question_id, session_id),
        )
        conn.execute(
            "UPDATE mock_interview_sessions SET updated_at = ?, error_message = NULL WHERE id = ?",
            (now, session_id),
        )


def activate_next_main(session_id: int, main_index: int) -> Optional[dict[str, Any]]:
    now = _now()
    with _db() as conn:
        row = conn.execute(
            """
            SELECT * FROM mock_interview_questions
            WHERE session_id = ? AND kind = 'main' AND main_index = ? AND phase = 'pending'
            ORDER BY created_at ASC LIMIT 1
            """,
            (session_id, main_index),
        ).fetchone()
        if not row:
            return None
        turn_count = int(_session_row(conn, session_id)["turn_count"] or 0) + 1
        conn.execute(
            """
            UPDATE mock_interview_questions
            SET phase = 'thinking', turn_index = ?, prep_started_at = ?, asked_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (turn_count, now, now, now, row["id"]),
        )
        conn.execute(
            """
            UPDATE mock_interview_sessions
            SET current_question_id = ?, turn_count = ?, main_index = ?, updated_at = ?
            WHERE id = ?
            """,
            (row["id"], turn_count, main_index, now, session_id),
        )
        q = conn.execute(
            "SELECT * FROM mock_interview_questions WHERE id = ?", (row["id"],)
        ).fetchone()
        return _question_dict(q) if q else None


def add_follow_up(
    session_id: int,
    *,
    main_index: int,
    parent_id: str,
    category: str,
    question_text: str,
    answer_time_limit_seconds: int,
) -> dict[str, Any]:
    now = _now()
    qid = _question_id()
    with _db() as conn:
        session = _session_row(conn, session_id)
        if not session:
            raise FileNotFoundError("模拟面试不存在")
        turn_count = int(session["turn_count"] or 0) + 1
        conn.execute(
            """
            INSERT INTO mock_interview_questions (
                id, session_id, main_index, turn_index, kind, parent_id, category,
                question_text, answer_time_limit_seconds, prep_seconds, phase,
                prep_started_at, asked_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'followup', ?, ?, ?, ?, ?, 'thinking', ?, ?, ?, ?)
            """,
            (
                qid,
                session_id,
                main_index,
                turn_count,
                parent_id,
                category,
                question_text.strip(),
                max(45, min(300, int(answer_time_limit_seconds))),
                PREP_SECONDS,
                now,
                now,
                now,
                now,
            ),
        )
        conn.execute(
            """
            UPDATE mock_interview_sessions
            SET current_question_id = ?, turn_count = ?, updated_at = ?
            WHERE id = ?
            """,
            (qid, turn_count, now, session_id),
        )
    result = get_question(session_id, qid)
    assert result is not None
    return result


def mark_ready_to_finish(session_id: int) -> None:
    now = _now()
    with _db() as conn:
        conn.execute(
            """
            UPDATE mock_interview_sessions
            SET status = 'ready_to_finish', current_question_id = NULL, updated_at = ?
            WHERE id = ?
            """,
            (now, session_id),
        )


def count_follow_ups(session_id: int, main_index: int) -> int:
    with _db() as conn:
        row = conn.execute(
            """
            SELECT COUNT(*) AS c FROM mock_interview_questions
            WHERE session_id = ? AND main_index = ? AND kind = 'followup'
            """,
            (session_id, main_index),
        ).fetchone()
        return int(row["c"] if row else 0)


def update_report(
    session_id: int,
    *,
    total_score: float,
    report: dict[str, Any],
) -> None:
    now = _now()
    with _db() as conn:
        conn.execute(
            """
            UPDATE mock_interview_sessions
            SET status = 'completed', total_score = ?, report_json = ?, completed_at = ?,
                updated_at = ?, error_message = NULL
            WHERE id = ?
            """,
            (max(0.0, min(100.0, float(total_score))), json.dumps(report, ensure_ascii=False), now, now, session_id),
        )


def mark_error(session_id: int, message: str) -> None:
    now = _now()
    with _db() as conn:
        conn.execute(
            "UPDATE mock_interview_sessions SET error_message = ?, updated_at = ? WHERE id = ?",
            (str(message or "")[:1000], now, session_id),
        )


def save_self_assessment(
    session_id: int,
    rating: int,
    note: str,
    tags: list[str],
) -> dict[str, Any]:
    now = _now()
    with _db() as conn:
        if not _session_row(conn, session_id):
            raise FileNotFoundError("模拟面试不存在")
        conn.execute(
            """
            UPDATE mock_interview_sessions
            SET self_rating = ?, self_note = ?, self_tags_json = ?, updated_at = ?
            WHERE id = ?
            """,
            (max(1, min(5, int(rating))), str(note or "")[:4000], json.dumps(tags[:8], ensure_ascii=False), now, session_id),
        )
    detail = get_session_detail(session_id)
    assert detail is not None
    return detail


def delete_session(session_id: int) -> bool:
    with _db() as conn:
        cur = conn.execute("DELETE FROM mock_interview_sessions WHERE id = ?", (session_id,))
        return cur.rowcount > 0


def get_recent_answers(session_id: int, limit: int = 8) -> list[dict[str, Any]]:
    with _db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM mock_interview_questions
            WHERE session_id = ? AND phase = 'evaluated'
            ORDER BY asked_at DESC LIMIT ?
            """,
            (session_id, max(1, limit)),
        ).fetchall()
    result = [_question_dict(row) for row in reversed(rows)]
    return result


def get_evaluated_questions(session_id: int) -> list[dict[str, Any]]:
    with _db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM mock_interview_questions
            WHERE session_id = ? AND phase = 'evaluated'
            ORDER BY asked_at ASC
            """,
            (session_id,),
        ).fetchall()
    return [_question_dict(row) for row in rows]


init_db()


def get_session_for_report(session_id: int) -> Optional[dict[str, Any]]:
    """内部报告生成使用：保留简历快照，不直接返回给前端。"""
    with _db() as conn:
        row = _session_row(conn, session_id)
        if not row:
            return None
        data = dict(row)
        data["question_plan"] = _loads(data.pop("question_plan_json", None), [])
        data["self_tags"] = _loads(data.pop("self_tags_json", None), [])
        data["report"] = _loads(data.pop("report_json", None), None)
        return data
