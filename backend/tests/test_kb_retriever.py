from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


@pytest.fixture
def setup_retriever(tmp_path, monkeypatch):
    from core import config as cfg_mod
    from services.kb import indexer, retriever

    kb_dir = tmp_path / "kb"
    kb_dir.mkdir()
    (kb_dir / "redis.md").write_text(
        "# Redis 持久化\n\n## RDB\n\nRDB 是 Redis 快照持久化方式。\n\n## AOF\n\nAOF 追加日志。",
        encoding="utf-8",
    )

    cfg = cfg_mod.get_config()
    monkeypatch.setattr(cfg, "kb_dir", str(kb_dir), raising=False)
    monkeypatch.setattr(cfg, "kb_db_path", str(tmp_path / "kb.sqlite"), raising=False)
    monkeypatch.setattr(cfg, "kb_enabled", True, raising=False)
    monkeypatch.setattr(cfg, "kb_min_score", 0.0, raising=False)
    monkeypatch.setattr(cfg, "kb_asr_min_query_chars", 6, raising=False)
    monkeypatch.setattr(
        cfg,
        "kb_trigger_modes",
        ["asr_realtime", "manual_text", "written_exam"],
        raising=False,
    )

    indexer.reset()
    indexer.reindex()
    yield retriever
    indexer.reset()


def test_keyword_hit(setup_retriever):
    hits = setup_retriever.retrieve("RDB 快照", k=3, deadline_ms=500)
    assert hits, "应至少命中 1 条"
    assert any("RDB" in h.text for h in hits)
    assert all(h.section_path for h in hits)
    assert all(h.path == "redis.md" for h in hits)


def test_disabled_returns_empty(setup_retriever, monkeypatch):
    from core.config import get_config
    monkeypatch.setattr(get_config(), "kb_enabled", False, raising=False)
    assert setup_retriever.retrieve("RDB", k=3, deadline_ms=500) == []


def test_mode_not_in_trigger_modes_returns_empty(setup_retriever, monkeypatch):
    from core.config import get_config
    monkeypatch.setattr(get_config(), "kb_trigger_modes", ["manual_text"], raising=False)
    hits = setup_retriever.retrieve("RDB", k=3, deadline_ms=500, mode="asr_realtime")
    assert hits == []


def test_short_asr_query_early_return(setup_retriever):
    hits = setup_retriever.retrieve("嗯", k=3, deadline_ms=80, mode="asr_realtime")
    assert hits == []


def test_noisy_asr_query_normalized(setup_retriever, monkeypatch):
    """含大量 ASR 噪声词; 归一化后应至少剩 'RDB 快照持久化' 足够触发检索。"""
    from core.config import get_config
    # 让这条 query 归一化后有效字符 (RDB+快照持久化=8) 超过默认 min_chars
    monkeypatch.setattr(get_config(), "kb_asr_min_query_chars", 6, raising=False)
    hits = setup_retriever.retrieve(
        "呃 那个 RDB 快照持久化 呃", k=3, deadline_ms=500, mode="asr_realtime"
    )
    assert hits


def test_empty_query_returns_empty(setup_retriever):
    assert setup_retriever.retrieve("   ", k=3, deadline_ms=500) == []


def test_manual_text_ignores_asr_min_chars(setup_retriever, monkeypatch):
    """manual_text 模式不受 kb_asr_min_query_chars 限制。"""
    from core.config import get_config
    monkeypatch.setattr(get_config(), "kb_asr_min_query_chars", 100, raising=False)
    hits = setup_retriever.retrieve("RDB", k=3, deadline_ms=500, mode="manual_text")
    assert hits


def test_long_cjk_query_partial_match(setup_retriever):
    """长 CJK query 不应因为多了几个 bigram 失配就整段命中失败。

    回归用例: 2026-04-17 真实 smoke 中发现 "Redis 快照持久化方式" 比
    "Redis 快照持久化" 多 bigrams ['化方', '方式'] 而 chunk 没这两个词,
    AND 语义把整个 query 撞空。修复后改成 OR 让 bm25 去排序。
    """
    hits = setup_retriever.retrieve(
        "Redis 快照持久化方式是什么", k=3, deadline_ms=500, mode="manual_text"
    )
    assert hits, "长 CJK query 应允许部分 bigram 匹配, 否则真实问答永远 0 命中"
    assert any("RDB" in h.text or "快照" in h.text for h in hits)


def test_deadline_enforced(setup_retriever, monkeypatch):
    """人为让 fts_search sleep，验证 deadline 到期返回空。"""
    from services.kb import store as store_mod

    def slow(self, *args, **kwargs):
        time.sleep(0.3)
        return []

    monkeypatch.setattr(store_mod.KBStore, "fts_search", slow)
    t0 = time.monotonic()
    hits = setup_retriever.retrieve("RDB", k=3, deadline_ms=50)
    elapsed_ms = (time.monotonic() - t0) * 1000
    assert hits == []
    # 允许 watchdog 再等 50ms 让子线程退出 + 一点调度延迟
    assert elapsed_ms < 250, f"deadline 超时保护失效, 实际 {elapsed_ms:.0f}ms"


@pytest.fixture
def setup_multi_doc(tmp_path, monkeypatch):
    """多文档场景: 测同义词扩展与 per-doc 多样性。"""
    from core import config as cfg_mod
    from services.kb import indexer, retriever

    kb_dir = tmp_path / "kb"
    kb_dir.mkdir()
    (kb_dir / "mq.md").write_text(
        "# 中间件\n\n## 消息队列\n\n消息队列用于异步解耦与削峰填谷。",
        encoding="utf-8",
    )
    (kb_dir / "rdb_a.md").write_text(
        "# Redis 笔记 A\n\n## RDB\n\nRDB 是 Redis 快照持久化方式。",
        encoding="utf-8",
    )
    (kb_dir / "rdb_b.md").write_text(
        "# Redis 笔记 B\n\n## 持久化对比\n\nRDB 快照与 AOF 追加日志的差异。",
        encoding="utf-8",
    )

    cfg = cfg_mod.get_config()
    monkeypatch.setattr(cfg, "kb_dir", str(kb_dir), raising=False)
    monkeypatch.setattr(cfg, "kb_db_path", str(tmp_path / "kb.sqlite"), raising=False)
    monkeypatch.setattr(cfg, "kb_enabled", True, raising=False)
    monkeypatch.setattr(cfg, "kb_min_score", 0.0, raising=False)
    monkeypatch.setattr(cfg, "kb_synonyms_enabled", True, raising=False)
    monkeypatch.setattr(cfg, "kb_per_doc_max_hits", 2, raising=False)
    monkeypatch.setattr(
        cfg, "kb_trigger_modes", ["asr_realtime", "manual_text", "written_exam"], raising=False
    )

    indexer.reset()
    indexer.reindex()
    yield retriever
    indexer.reset()


def test_synonym_expansion_latin_to_cjk(setup_multi_doc):
    """query 只有缩写 'MQ', 文档只写 '消息队列', 同义词扩展应能命中。"""
    hits = setup_multi_doc.retrieve("MQ 的作用", k=3, deadline_ms=500)
    assert hits and any("消息队列" in h.text for h in hits)


def test_synonym_expansion_cjk_to_latin(setup_multi_doc):
    """反向: query 是中文 '消息队列', 同组补充 'mq' token, 至少仍能命中原文档。"""
    hits = setup_multi_doc.retrieve("消息队列怎么选型", k=3, deadline_ms=500)
    assert hits and any("消息队列" in h.text for h in hits)


def test_synonym_expansion_asr_variant(setup_multi_doc):
    """ASR 变体 'b加树' 应扩展出 'b+树' 的 token; 这里只验证扩展逻辑本身。"""
    from services.kb import retriever as rt

    expr = rt._build_fts_expr("b加树", synonyms_enabled=True)
    assert '"b"' in expr and '"加树"' in expr


def test_synonyms_can_be_disabled(setup_multi_doc, monkeypatch):
    from core.config import get_config
    monkeypatch.setattr(get_config(), "kb_synonyms_enabled", False, raising=False)
    hits = setup_multi_doc.retrieve("MQ 的作用", k=3, deadline_ms=500)
    assert hits == []


def test_per_doc_diversity_cap(setup_multi_doc, monkeypatch):
    """per_doc=1 时, top_k 应覆盖两个不同文档。"""
    from core.config import get_config
    monkeypatch.setattr(get_config(), "kb_per_doc_max_hits", 1, raising=False)
    hits = setup_multi_doc.retrieve("RDB 快照", k=4, deadline_ms=500)
    paths = {h.path for h in hits}
    assert "rdb_a.md" in paths and "rdb_b.md" in paths


def test_per_doc_cap_fills_back_when_short(setup_multi_doc, monkeypatch):
    """候选总数不足时, 多样性截断后应回填, 返回数量仍尽量接近 k。"""
    from core.config import get_config
    monkeypatch.setattr(get_config(), "kb_per_doc_max_hits", 1, raising=False)
    hits = setup_multi_doc.retrieve("RDB 快照", k=10, deadline_ms=500)
    assert len(hits) >= 2


def test_stopword_bigrams_filtered():
    from services.kb import retriever as rt

    expr = rt._build_fts_expr("你了解吗", synonyms_enabled=False)
    # "解吗" 含语气字 "吗" 应被过滤; "你了/了解" 保留
    assert '"解吗"' not in expr
    assert '"了解"' in expr


def test_duplicate_tokens_deduped():
    from services.kb import retriever as rt

    expr = rt._build_fts_expr("快照 快照 快照", synonyms_enabled=False)
    assert expr.count('"快照"') == 1
