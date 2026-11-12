import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.storage import mock_interview as store  # noqa: E402
from services.mock_interview import service as mock_service  # noqa: E402


def _plan():
    categories = [
        "resume_project", "resume_project", "resume_project",
        "technical", "technical", "technical",
        "behavioral", "behavioral", "scenario", "motivation",
    ]
    return [
        {
            "category": category,
            "question": f"第 {idx + 1} 道模拟面试问题，请结合经历回答。",
            "answer_time_limit_seconds": 90 + idx,
        }
        for idx, category in enumerate(categories)
    ]


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DB_PATH", str(tmp_path / "mock_interview.db"))
    store.init_db()
    from api.mock_interview import routes

    monkeypatch.setattr(routes, "generate_interview_plan", lambda **kwargs: _plan())
    monkeypatch.setattr(routes, "model_name", lambda: "test-model")
    monkeypatch.setattr(
        routes,
        "evaluate_answer",
        lambda **kwargs: {
            "score": 82,
            "strengths": ["结构清晰"],
            "risks": ["细节不足"],
            "improvement": "补充量化结果",
            "follow_up_question": "这个方案的最大风险是什么？",
            "follow_up_reason": "继续深挖",
            "follow_up_time_limit_seconds": 60,
            "follow_up_count": kwargs.get("follow_up_count", 0),
        },
    )
    monkeypatch.setattr(
        routes,
        "generate_report",
        lambda **kwargs: {
            "total_score": 78.5,
            "dimensions": [],
            "summary_markdown": "整体表现稳定。",
            "strengths": ["表达清楚"],
            "risks": ["深度不足"],
            "improvements": ["补充指标"],
            "next_practice_plan": ["练习项目复盘"],
            "question_reviews": [],
            "answered_count": len(kwargs["questions"]),
            "main_question_target": 10,
            "max_follow_ups": 3,
        },
    )
    from main import app

    return TestClient(app)


def test_create_start_submit_followup_limit_and_report(client):
    created = client.post(
        "/api/mock-interview/sessions",
        json={
            "position": "Java 后端开发",
            "company": "示例公司",
            "job_description": "Java/Redis",
            "difficulty": "medium",
            "focus": "balanced",
        },
    )
    assert created.status_code == 200, created.text
    session = created.json()
    assert session["status"] == "in_progress"
    assert session["main_question_target"] == 10
    assert session["current_question"]["phase"] == "thinking"
    assert len(session["questions"]) == 1
    question = session["current_question"]

    draft = client.patch(
        f"/api/mock-interview/sessions/{session['id']}/draft",
        json={"question_id": question["id"], "draft_text": "我负责过缓存优化"},
    )
    assert draft.status_code == 200

    started = client.post(
        f"/api/mock-interview/sessions/{session['id']}/start-answer",
        json={"question_id": question["id"]},
    )
    assert started.status_code == 200, started.text
    assert started.json()["current_question"]["phase"] == "answering"

    current = question
    for index in range(4):
        submitted = client.post(
            f"/api/mock-interview/sessions/{session['id']}/answers",
            json={
                "question_id": current["id"],
                "answer_text": f"这是第 {index + 1} 次回答，包含具体做法和结果。",
                "auto_submitted": False,
            },
        )
        assert submitted.status_code == 200, submitted.text
        body = submitted.json()
        current = body["next_question"]
        if index < 3:
            assert current["kind"] == "followup"
        else:
            assert current["kind"] == "main"
            assert current["main_index"] == 2

    finished = client.post(f"/api/mock-interview/sessions/{session['id']}/finish")
    assert finished.status_code == 200, finished.text
    report_session = finished.json()
    assert report_session["status"] == "completed"
    assert report_session["report"]["total_score"] == 78.5

    rated = client.post(
        f"/api/mock-interview/sessions/{session['id']}/self-assessment",
        json={"rating": 4, "note": "节奏合适", "tags": ["节奏合适"]},
    )
    assert rated.status_code == 200
    assert rated.json()["self_rating"] == 4

    listed = client.get("/api/mock-interview/sessions")
    assert listed.status_code == 200
    item = listed.json()["items"][0]
    assert item["id"] == session["id"]
    assert item["answered_count"] == 4
    assert item["main_answered_count"] == 1

    deleted = client.delete(f"/api/mock-interview/sessions/{session['id']}")
    assert deleted.status_code == 200
    assert client.get(f"/api/mock-interview/sessions/{session['id']}").status_code == 404


def test_single_active_question_gate(client):
    first = client.post("/api/mock-interview/sessions", json={"position": "后端开发"})
    assert first.status_code == 200
    second = client.post("/api/mock-interview/sessions", json={"position": "后端开发"})
    assert second.status_code == 409

    session = first.json()
    q = session["current_question"]
    other = "not-current"
    response = client.post(
        f"/api/mock-interview/sessions/{session['id']}/start-answer",
        json={"question_id": other},
    )
    assert response.status_code == 409

    response = client.post(
        f"/api/mock-interview/sessions/{session['id']}/answers",
        json={"question_id": other, "answer_text": "回答", "auto_submitted": False},
    )
    assert response.status_code == 409


def test_storage_clamps_limits_and_keeps_draft(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DB_PATH", str(tmp_path / "storage.db"))
    store.init_db()
    plan = _plan()
    plan[0]["answer_time_limit_seconds"] = 999
    session = store.create_session(
        position="后端",
        company="",
        job_description="",
        difficulty="medium",
        focus="balanced",
        resume_snapshot="项目经历",
        resume_filename="resume.pdf",
        model_name="model",
        plan=plan,
    )
    q = session["current_question"]
    assert q["answer_time_limit_seconds"] == 300
    store.save_draft(session["id"], q["id"], "可编辑草稿")
    assert store.get_question(session["id"], q["id"])["draft_text"] == "可编辑草稿"
    assert store.get_session_for_report(session["id"])["resume_snapshot"] == "项目经历"


def test_mock_interview_audio_websocket_concatenates_segments(client, monkeypatch):
    import numpy as np
    from api.mock_interview import ws as mock_ws

    monkeypatch.setattr(mock_ws, "transcribe_with_fallback", lambda *args, **kwargs: "这是第一段语音。")
    created = client.post('/api/mock-interview/sessions', json={'position': '后端开发'})
    assert created.status_code == 200
    session = created.json()
    question = session['current_question']
    started = client.post(
        f"/api/mock-interview/sessions/{session['id']}/start-answer",
        json={'question_id': question['id']},
    )
    assert started.status_code == 200

    with client.websocket_connect(
        f"/ws/mock-interview/audio?session_id={session['id']}&question_id={question['id']}"
    ) as ws:
        ready = ws.receive_json()
        assert ready['type'] == 'ready'
        speech = (np.sin(np.linspace(0, 2 * np.pi * 220, 16000)) * 0.25 * 32767).astype(np.int16)
        silence = np.zeros(16000 * 2, dtype=np.int16)
        payload = np.concatenate([speech, silence]).tobytes()
        for offset in range(0, len(payload), 2048):
            ws.send_bytes(payload[offset: offset + 2048])
        ws.send_json({'type': 'stop'})

        seen_segment = False
        seen_flushed = False
        for _ in range(20):
            message = ws.receive_json()
            if message['type'] == 'segment_final':
                seen_segment = True
                assert message['text'] == '这是第一段语音。'
            if message['type'] == 'flushed':
                seen_flushed = True
                break
        assert seen_segment
        assert seen_flushed


def test_empty_answer_is_always_zero_without_calling_llm(monkeypatch):
    def fail_chat(**kwargs):
        raise AssertionError("empty answer must not call the LLM")

    monkeypatch.setattr(mock_service, "_chat_json", fail_chat)
    result = mock_service.evaluate_answer(
        position="后端开发",
        company="",
        question="Redis 缓存击穿如何处理？",
        category="technical",
        answer="   ",
        main_index=1,
        follow_up_count=0,
        recent_context=[],
    )
    assert result["score"] == 0
    assert result["follow_up_question"] is None
    assert result["risks"] == ["本题未作答"]


def test_exact_duplicate_follow_up_is_suppressed(monkeypatch):
    monkeypatch.setattr(
        mock_service,
        "_chat_json",
        lambda **kwargs: {
            "score": 86,
            "strengths": ["回答扎实"],
            "risks": [],
            "improvement": "补充边界",
            "follow_up_question": "如果缓存重建期间数据库也过载，你会怎么降级？",
            "follow_up_reason": "继续深挖",
            "follow_up_time_limit_seconds": 60,
        },
    )
    result = mock_service.evaluate_answer(
        position="后端开发",
        company="",
        question="如果缓存重建期间数据库也过载，你会怎么降级？",
        category="technical",
        answer="先限流并切只读缓存。",
        main_index=1,
        follow_up_count=1,
        recent_context=[],
    )
    assert result["score"] == 86
    assert result["follow_up_question"] is None
