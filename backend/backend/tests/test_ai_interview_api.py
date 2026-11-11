# -*- coding: utf-8 -*-
"""AI面试API集成测试"""

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    """创建测试客户端"""
    # 延迟导入以避免启动时初始化
    from main import app
    return TestClient(app)


def test_start_ai_interview(client):
    """测试开始AI面试"""
    response = client.post("/api/ai-interview/start", json={
        "position": "后端开发",
        "question_count": 3,
        "total_time_minutes": 30,
        "enable_star_guide": True,
        "show_timer": True,
    })

    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert "session" in data
    assert "guide_message" in data
    assert data["session"]["position"] == "后端开发"
    assert len(data["session"]["questions"]) == 3


def test_get_session_no_active(client):
    """测试获取会话（无活跃会话）"""
    # 先重置
    client.post("/api/ai-interview/reset")

    response = client.get("/api/ai-interview/session")
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["session"] is None


def test_preview_questions(client):
    """测试预览题库"""
    response = client.get("/api/ai-interview/questions/preview", params={
        "position": "后端开发",
        "count": 5,
    })

    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert "questions" in data
    assert len(data["questions"]) > 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
