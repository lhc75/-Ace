"""SQLite + FTS5 持久层。

关键设计:
- `kb_fts` 是独立 FTS5 表, rowid 与 `kb_chunk.id` 对齐; 不使用 content= 映射。
- `kb_fts` 分两列: `section`(标题路径) 与 `body`(正文); 检索时
  `bm25(kb_fts, _SECTION_WEIGHT, 1.0)` 让标题命中显著加权 —— 面试笔记里
  标题/小节名往往就是知识点本身, 词面重合时应该排最前。
- 写入 FTS 时把文本做 CJK bigram 化, 让 unicode61 tokenizer 能检索中文短语。
- `kb_chunk` 存原文; SELECT 时从 JOIN 里取原文, 不从 FTS 里读。
- 短连接 + WAL + check_same_thread=False, 让 retriever watchdog 主线程能 interrupt 子线程查询。
"""
from __future__ import annotations

import contextlib
import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

from core.logger import get_logger

from ._tokenize import cjk_bigram_text
from .types import Chunk

_log = get_logger(__name__)

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS kb_doc (
  id      INTEGER PRIMARY KEY,
  path    TEXT NOT NULL UNIQUE,
  mtime   REAL NOT NULL,
  size    INTEGER NOT NULL DEFAULT 0,
  loader  TEXT NOT NULL,
  title   TEXT,
  status  TEXT NOT NULL DEFAULT 'ok',
  error   TEXT
);

CREATE TABLE IF NOT EXISTS kb_chunk (
  id           INTEGER PRIMARY KEY,
  doc_id       INTEGER NOT NULL REFERENCES kb_doc(id) ON DELETE CASCADE,
  section_path TEXT,
  page         INTEGER,
  ord          INTEGER NOT NULL,
  text         TEXT NOT NULL,
  origin       TEXT NOT NULL DEFAULT 'text'
);

CREATE TABLE IF NOT EXISTS kb_attachment (
  id       INTEGER PRIMARY KEY,
  chunk_id INTEGER NOT NULL REFERENCES kb_chunk(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL,
  mime     TEXT NOT NULL,
  path     TEXT
);
"""

_FTS_SQL = """
CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
  section,
  body,
  tokenize='unicode61 remove_diacritics 2'
);
"""

# bm25 列权重: 标题/小节命中比正文命中重要得多(笔记标题即知识点)。
_SECTION_WEIGHT = 10.0
_BODY_WEIGHT = 1.0


class KBStore:
    def __init__(self, db_path: str):
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=5.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        return conn

    @contextlib.contextmanager
    def _session(self) -> Iterator[sqlite3.Connection]:
        """连接上下文: with 包住提交/回滚, finally 保证关闭。

        sqlite3.Connection 自己的 with 只做 commit/rollback 不 close,
        直接用会依赖 GC 回收连接。
        """
        conn = self._connect()
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def init_schema(self) -> None:
        with self._lock, self._session() as conn:
            conn.executescript(_SCHEMA_SQL + _FTS_SQL)
            self._migrate_fts(conn)

    def _migrate_fts(self, conn: sqlite3.Connection) -> None:
        """旧版单列 kb_fts(chunk_text) → 双列 (section, body), 从 kb_chunk 原文重建。"""
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(kb_fts)").fetchall()}
        if not cols or "chunk_text" not in cols:
            return
        conn.execute("DROP TABLE kb_fts")
        conn.executescript(_FTS_SQL)
        rows = conn.execute("SELECT id, section_path, text FROM kb_chunk").fetchall()
        for r in rows:
            sec, body = _build_fts_columns(r["section_path"] or "", r["text"])
            conn.execute(
                "INSERT INTO kb_fts(rowid, section, body) VALUES(?,?,?)",
                (r["id"], sec, body),
            )
        _log.info("kb_fts 已迁移为双列加权索引, 重建 %d 行", len(rows))

    def list_tables(self) -> set[str]:
        with self._session() as conn:
            rows = conn.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
            ).fetchall()
        return {r["name"] for r in rows}

    def upsert_doc(
        self,
        path: str,
        mtime: float,
        size: int,
        loader: str,
        title: Optional[str],
    ) -> int:
        with self._lock, self._session() as conn:
            conn.execute(
                """
                INSERT INTO kb_doc(path, mtime, size, loader, title, status, error)
                VALUES(?,?,?,?,?,'ok',NULL)
                ON CONFLICT(path) DO UPDATE SET
                    mtime=excluded.mtime,
                    size=excluded.size,
                    loader=excluded.loader,
                    title=excluded.title,
                    status='ok',
                    error=NULL
                """,
                (path, mtime, size, loader, title),
            )
            row = conn.execute("SELECT id FROM kb_doc WHERE path=?", (path,)).fetchone()
            return int(row["id"])

    def set_status(self, path: str, status: str, error: Optional[str]) -> None:
        with self._lock, self._session() as conn:
            conn.execute(
                "UPDATE kb_doc SET status=?, error=? WHERE path=?",
                (status, error, path),
            )

    def delete_doc(self, path: str) -> None:
        """删 kb_doc + 先清相关 FTS 行 (外键 cascade 不会触及 FTS 独立表)。"""
        with self._lock, self._session() as conn:
            row = conn.execute("SELECT id FROM kb_doc WHERE path=?", (path,)).fetchone()
            if row is None:
                return
            conn.execute(
                "DELETE FROM kb_fts WHERE rowid IN (SELECT id FROM kb_chunk WHERE doc_id=?)",
                (row["id"],),
            )
            conn.execute("DELETE FROM kb_doc WHERE id=?", (row["id"],))

    def get_doc(self, path: str) -> Optional[dict[str, Any]]:
        with self._session() as conn:
            row = conn.execute("SELECT * FROM kb_doc WHERE path=?", (path,)).fetchone()
        return dict(row) if row else None

    def list_docs(self, limit: Optional[int] = None) -> list[dict[str, Any]]:
        sql = (
            "SELECT d.*, "
            "(SELECT COUNT(*) FROM kb_chunk c WHERE c.doc_id=d.id) AS chunk_count "
            "FROM kb_doc d ORDER BY d.path"
        )
        if limit is not None:
            sql += f" LIMIT {int(limit)}"
        with self._session() as conn:
            rows = conn.execute(sql).fetchall()
        return [dict(r) for r in rows]

    def stats(self) -> dict[str, Any]:
        with self._session() as conn:
            doc_n = conn.execute("SELECT COUNT(*) AS n FROM kb_doc").fetchone()["n"]
            chunk_n = conn.execute("SELECT COUNT(*) AS n FROM kb_chunk").fetchone()["n"]
            last = conn.execute("SELECT MAX(mtime) AS m FROM kb_doc").fetchone()["m"]
        return {
            "total_docs": int(doc_n),
            "total_chunks": int(chunk_n),
            "last_mtime": float(last or 0),
        }

    def replace_chunks(self, doc_id: int, chunks: Iterable[Chunk]) -> None:
        """事务内替换 doc 的所有 chunk, 同步写 kb_fts (含 bigram)。"""
        chunks_list = list(chunks)
        with self._lock, self._session() as conn:
            old_ids = [
                r["id"]
                for r in conn.execute(
                    "SELECT id FROM kb_chunk WHERE doc_id=?", (doc_id,)
                ).fetchall()
            ]
            if old_ids:
                conn.executemany(
                    "DELETE FROM kb_fts WHERE rowid=?",
                    [(cid,) for cid in old_ids],
                )
            conn.execute("DELETE FROM kb_chunk WHERE doc_id=?", (doc_id,))
            for c in chunks_list:
                cur = conn.execute(
                    """
                    INSERT INTO kb_chunk(doc_id, section_path, page, ord, text, origin)
                    VALUES(?,?,?,?,?,?)
                    """,
                    (doc_id, c.section_path, c.page, c.ord, c.text, c.origin),
                )
                chunk_id = cur.lastrowid
                sec, body = _build_fts_columns(c.section_path or "", c.text)
                conn.execute(
                    "INSERT INTO kb_fts(rowid, section, body) VALUES(?,?,?)",
                    (chunk_id, sec, body),
                )

    def fts_search(
        self,
        query: str,
        limit: int,
        *,
        interrupt_connection: Optional[sqlite3.Connection] = None,
    ) -> list[dict[str, Any]]:
        """query 必须是已经 bigram/token 化后的 FTS5 MATCH 表达式。"""
        conn = interrupt_connection or self._connect()
        own_conn = interrupt_connection is None
        try:
            rows = conn.execute(
                """
                SELECT d.path, c.section_path, c.text, c.page, c.origin,
                       bm25(kb_fts, ?, ?) AS score
                FROM kb_fts
                JOIN kb_chunk c ON c.id = kb_fts.rowid
                JOIN kb_doc   d ON d.id = c.doc_id
                WHERE kb_fts MATCH ?
                ORDER BY score
                LIMIT ?
                """,
                (_SECTION_WEIGHT, _BODY_WEIGHT, query, limit),
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            if own_conn:
                conn.close()

    def open_connection(self) -> sqlite3.Connection:
        return self._connect()


def _build_fts_columns(section_path: str, body: str) -> tuple[str, str]:
    """写入 FTS5 前的预处理: section / body 分别 bigram 化, 对应 kb_fts 两列。"""
    return cjk_bigram_text(section_path or ""), cjk_bigram_text(body or "")
