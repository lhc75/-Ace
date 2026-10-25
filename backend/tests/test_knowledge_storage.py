from __future__ import annotations

from pathlib import Path
import sys

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.storage import knowledge  # noqa: E402


@pytest.fixture
def isolated_knowledge_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(knowledge, "DB_PATH", str(tmp_path / "knowledge.db"))
    monkeypatch.setattr(knowledge, "extract_tags", lambda _q, _a="", _candidate_answer="": ["Redis"])
    knowledge.init_db()
    knowledge.reset_all()
    return knowledge


def test_assist_history_includes_optional_candidate_answer(isolated_knowledge_db):
    store = isolated_knowledge_db

    store.save_record(
        "assist",
        "Redis 怎么持久化？",
        "助手建议：RDB 和 AOF。",
        qa_id="qa-1",
        tags=["Redis"],
    )
    assert store.update_candidate_answer_for_qa(
        "qa-1",
        "我实际回答了 RDB 快照、AOF 追加日志，以及重写机制。",
        refresh_tags=False,
    )

    history = store.get_history(1, 20, ("assist",))
    assert history["records"][0]["qa_id"] == "qa-1"
    assert history["records"][0]["candidate_answer"] == "我实际回答了 RDB 快照、AOF 追加日志，以及重写机制。"


def test_records_without_candidate_voice_stay_compatible(isolated_knowledge_db):
    store = isolated_knowledge_db

    store.save_record("assist", "MySQL 索引？", "B+ 树。", tags=["MySQL"])

    history = store.get_history(1, 20, ("assist",))
    assert history["records"][0]["qa_id"] == ""
    assert history["records"][0]["candidate_answer"] == ""


def test_candidate_answer_refreshes_tags_from_actual_spoken_answer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(knowledge, "DB_PATH", str(tmp_path / "knowledge.db"))
    seen: list[tuple[str, str, str]] = []

    def fake_extract_tags(question: str, answer: str = "", candidate_answer: str = "") -> list[str]:
        seen.append((question, answer, candidate_answer))
        return ["候选人口述"]

    monkeypatch.setattr(knowledge, "extract_tags", fake_extract_tags)
    knowledge.init_db()
    knowledge.reset_all()
    knowledge.save_record("assist", "讲讲项目", "助手建议：缓存项目。", qa_id="qa-2", tags=["缓存"])

    assert knowledge.update_candidate_answer_for_qa("qa-2", "我实际讲的是风控规则引擎。")

    history = knowledge.get_history(1, 20, ("assist",))
    assert history["records"][0]["tags"] == ["候选人口述"]
    assert seen[-1] == ("讲讲项目", "助手建议：缓存项目。", "我实际讲的是风控规则引擎。")


def test_update_score_for_qa_backfills_latest_record(isolated_knowledge_db):
    store = isolated_knowledge_db

    store.save_record("assist", "Redis 持久化？", "RDB + AOF。", qa_id="qa-9", tags=["Redis"])
    store.save_record("assist", "Redis 持久化？", "RDB + AOF。", qa_id="qa-9", tags=["Redis"])

    assert store.update_score_for_qa("qa-9", 7.5)

    history = store.get_history(1, 20, ("assist",))
    # 只回写最新一条,历史重复记录不覆盖
    scores = sorted(r["score"] for r in history["records"] if r["score"] is not None)
    assert scores == [7.5]

    summary = store.get_summary(("assist",))
    redis_tag = next(t for t in summary if t["tag"] == "Redis")
    assert redis_tag["avg_score"] == 7.5


def test_update_score_for_qa_rejects_invalid_input(isolated_knowledge_db):
    store = isolated_knowledge_db

    store.save_record("assist", "MySQL 索引？", "B+ 树。", qa_id="qa-10", tags=["MySQL"])

    assert not store.update_score_for_qa("", 8.0)
    assert not store.update_score_for_qa("qa-10", None)
    assert not store.update_score_for_qa("不存在的 qa", 8.0)

    history = store.get_history(1, 20, ("assist",))
    assert history["records"][0]["score"] is None


def test_candidate_answer_refresh_keeps_existing_tags_when_extraction_returns_empty(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(knowledge, "DB_PATH", str(tmp_path / "knowledge.db"))
    monkeypatch.setattr(knowledge, "extract_tags", lambda _q, _a="", _candidate_answer="": [])
    knowledge.init_db()
    knowledge.reset_all()
    knowledge.save_record("assist", "Redis 如何限流？", "助手建议：令牌桶。", qa_id="qa-3", tags=["Redis", "限流"])

    assert knowledge.update_candidate_answer_for_qa("qa-3", "我实际回答了令牌桶和漏桶。")

    history = knowledge.get_history(1, 20, ("assist",))
    assert history["records"][0]["candidate_answer"] == "我实际回答了令牌桶和漏桶。"
    assert history["records"][0]["tags"] == ["Redis", "限流"]
