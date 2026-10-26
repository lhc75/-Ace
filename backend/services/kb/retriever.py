"""KB 检索：FTS5 + 双预算 + 碎句 early-return + 子线程 watchdog。

`retrieve(...)` 是**同步**函数；调用方（pipeline/HTTP）需要 `await run_in_threadpool(retrieve, ...)`。
deadline_ms 作为**硬上限**：超时时用 `sqlite3.Connection.interrupt()` 打断查询，返回空。
"""
from __future__ import annotations

import re
import threading
import time

from core.config import get_config
from core.logger import get_logger

from ._tokenize import cjk_bigram_query_tokens
from .indexer import _get_store
from .types import KBHit

_log = get_logger(__name__)

_NOISE_WORDS = (
    "嗯", "呃", "那个", "然后", "就是", "啊", "吧", "呢", "的话",
    "em", "uh", "um",
)
# 口语高频但无检索价值的短语, 归一化时整段移除。
_STOP_PHRASES = (
    "什么", "怎么", "为什么", "怎么样", "有没有", "是不是", "能不能",
    "一下", "这个", "咱们", "其实", "所以", "可以",
)
# 纯语气字: 含这些字的 CJK bigram 基本是语法噪音 ("我吗", "是吧"), 在 token 层丢弃。
# 只收绝不会出现在实词里的句末语气字; "的/了" 虽更吵, 但会误伤 "目的/了解",
# 高频词交给 bm25 的 IDF 自己压制, 不在这里过滤。
_STOP_BIGRAM_CHARS = frozenset("吗呢吧啊哦嘛呀啦")
_MAX_QUERY_CHARS = 128

# 面试领域常见同义/缩写组: 任一成员出现即把其余成员的 token 补进 OR 查询。
# 同时覆盖 ASR 误识别变体 ("b加树" ↔ "b+树", "c加加" ↔ "c++")。
_SYNONYM_GROUPS: tuple[tuple[str, ...], ...] = (
    ("mq", "消息队列", "message queue"),
    ("oom", "内存溢出", "out of memory"),
    ("rpc", "远程过程调用", "远程调用"),
    ("gc", "垃圾回收"),
    ("jvm", "java虚拟机", "java 虚拟机"),
    ("ioc", "控制反转"),
    ("aop", "面向切面", "切面编程"),
    ("k8s", "kubernetes"),
    ("golang", "go语言", "go 语言"),
    ("b+树", "b加树", "b+ tree", "btree"),
    ("b树", "b-树", "b-tree"),
    ("c++", "c加加", "cpp"),
    ("ddos", "分布式拒绝服务"),
    ("cap", "cap定理", "cap 定理"),
)


def _normalize_query(query: str) -> str:
    q = (query or "").strip()
    if not q:
        return ""
    for w in _NOISE_WORDS + _STOP_PHRASES:
        q = q.replace(w, " ")
    q = re.sub(r"\s+", " ", q).strip()
    if len(q) > _MAX_QUERY_CHARS:
        q = q[:_MAX_QUERY_CHARS]
    return q


def _should_early_return_asr(q: str, min_chars: int) -> bool:
    """ASR 模式：去掉空白和标点后有效字符不足就直接丢。"""
    sig = re.sub(r"[\s\W_]+", "", q, flags=re.UNICODE)
    return len(sig) < max(1, min_chars)


def _expand_synonyms(q: str, toks: list[str]) -> list[str]:
    """命中的同义词组, 把组内其他成员也拆成 token 补进查询。"""
    latin = {t.lower() for t in toks if t.isascii()}
    q_lower = q.lower()
    extra: list[str] = []
    for group in _SYNONYM_GROUPS:
        if any(
            (m.lower() in latin) if m.isascii() else (m in q or m.lower() in q_lower)
            for m in group
        ):
            for m in group:
                extra.extend(cjk_bigram_query_tokens(m))
    return extra


def _build_fts_expr(q: str, *, synonyms_enabled: bool = True, max_tokens: int = 64) -> str:
    """query → FTS5 MATCH: CJK 走 bigram, 非 CJK 按空白切词, token 之间用 ``OR`` 连接。

    用 ``OR`` 而不是隐式 ``AND`` 是因为长 CJK query 的 bigram 数量很容易超过任何
    单个 chunk 同时包含的数量(例如 "持久化方式" 拆出 4 个 bigram, 文档里只有 3 个)
    AND 会导致整段 query 一个结果都查不到; OR 让 bm25 自动按命中数 + 词频排序,
    top_k 截断后效果更稳定。

    在 OR 语义下, 语气字 bigram ("我吗", "是吧") 和重复 token 只会贡献噪音,
    因此这里做 token 级过滤 + 保序去重 + 上限截断; 同义词扩展放在去重之前。

    用 ``"..."`` 包住每个 token 避免 ``-`` / ``OR`` / ``NEAR`` 被当成运算符。
    """
    toks = cjk_bigram_query_tokens(q)
    if synonyms_enabled:
        toks.extend(_expand_synonyms(q, toks))
    if not toks:
        return ""

    safe: list[str] = []
    seen: set[str] = set()
    for t in toks:
        s = t.replace('"', '""').strip()
        if not s or s in seen:
            continue
        # FTS5 不允许把纯标点/数字当成 phrase 主体, 但 unicode61 会把非字母数字当分隔符,
        # 这里再过一遍去除只剩标点的 token。
        if not any(ch.isalnum() or ord(ch) > 127 for ch in s):
            continue
        # 含语气字的 CJK bigram 只贡献噪音。
        if len(s) == 2 and any(ord(ch) > 127 and ch in _STOP_BIGRAM_CHARS for ch in s):
            continue
        seen.add(s)
        safe.append(f'"{s}"')
        if len(safe) >= max_tokens:
            break
    return " OR ".join(safe)


def _cap_per_doc(rows: list[dict], per_doc: int, k: int) -> list[dict]:
    """同一文档最多保留 per_doc 条(按排名顺序); 截断后不足 k 条时用溢出部分按序补齐。"""
    picked: list[dict] = []
    overflow: list[dict] = []
    counts: dict[str, int] = {}
    for r in rows:
        path = r.get("path") or ""
        if counts.get(path, 0) < per_doc:
            counts[path] = counts.get(path, 0) + 1
            picked.append(r)
        else:
            overflow.append(r)
        if len(picked) >= k:
            break
    if len(picked) < k:
        picked.extend(overflow[: k - len(picked)])
    return picked


def retrieve(
    query: str,
    k: int = 4,
    deadline_ms: int = 150,
    *,
    mode: str = "manual_text",
    force: bool = False,
) -> list[KBHit]:
    """同步 FTS5 检索；deadline 到期立刻中断返回空。

    ``force=True`` 时跳过 ``kb_enabled`` / ``kb_trigger_modes`` 这两道开关;
    专给手动测试面板 (`/api/kb/search`) 用 —— 用户既然在 Drawer 里点了搜索,
    就不该被「主流程总开关」拦住。pipeline 默认 ``force=False``,行为不变。
    """
    cfg = get_config()
    if not force:
        if not getattr(cfg, "kb_enabled", False):
            return []
        if mode not in getattr(cfg, "kb_trigger_modes", []):
            return []

    q = _normalize_query(query)
    if not q:
        return []
    if mode == "asr_realtime" and _should_early_return_asr(
        q, int(getattr(cfg, "kb_asr_min_query_chars", 6))
    ):
        return []

    fts_expr = _build_fts_expr(
        q,
        synonyms_enabled=bool(getattr(cfg, "kb_synonyms_enabled", True)),
        max_tokens=int(getattr(cfg, "kb_max_query_tokens", 64)),
    )
    if not fts_expr:
        return []

    try:
        store = _get_store()
    except Exception as e:  # pragma: no cover
        _log.warning("kb retriever 拿 store 失败: %s", e)
        return []

    try:
        conn = store.open_connection()
    except Exception as e:  # pragma: no cover
        _log.warning("kb retriever 开连接失败: %s", e)
        return []

    # 多样性: 同一文档最多占 kb_per_doc_max_hits 条, 避免一个长文档铺满 top_k;
    # 需要多抓候选再截断。
    per_doc = max(1, int(getattr(cfg, "kb_per_doc_max_hits", 2)))
    fetch_limit = k if per_doc >= k else max(k * 3, k + per_doc)

    hit_rows: list[dict] = []
    error: dict = {}
    done = threading.Event()

    def _runner() -> None:
        try:
            rows = store.fts_search(fts_expr, limit=fetch_limit, interrupt_connection=conn)
            hit_rows.extend(rows)
        except Exception as e:
            error["e"] = str(e)
        finally:
            done.set()

    t = threading.Thread(target=_runner, name="kb-fts", daemon=True)
    t.start()
    t0 = time.monotonic()
    if not done.wait(max(0.0, deadline_ms / 1000.0)):
        try:
            conn.interrupt()
        except Exception:
            pass
        # interrupt() 之后 execute 立即报错返回, runner 只剩纯 Python 收尾;
        # 50ms 是留给这段收尾的窗口 — 不能再长, deadline 是 ASR 链路的硬性时延约束。
        done.wait(0.05)
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    try:
        conn.close()
    except Exception:
        pass

    if error:
        _log.warning("kb retrieve error q=%r: %s", q, error.get("e"))

    hits: list[KBHit] = []
    timed_out = not hit_rows and elapsed_ms >= deadline_ms

    if hit_rows:
        hit_rows = _cap_per_doc(hit_rows, per_doc, k)
        min_score = float(getattr(cfg, "kb_min_score", 0.0))
        for r in hit_rows:
            raw_score = float(r.get("score") or 0.0)
            # SQLite FTS5 bm25() 返回非正数，越接近 0 越相关；翻成正分给上层。
            pos = -raw_score if raw_score < 0 else raw_score
            if min_score > 0 and pos < min_score:
                continue
            hits.append(
                KBHit(
                    path=r["path"],
                    section_path=r.get("section_path") or "",
                    text=r["text"],
                    score=pos,
                    page=r.get("page"),
                    origin=r.get("origin") or "text",
                )
            )

    if timed_out:
        _log.info(
            "kb retrieve timeout q=%r mode=%s deadline=%dms elapsed=%dms",
            q, mode, deadline_ms, elapsed_ms,
        )
    else:
        _log.info(
            "kb retrieve q=%r mode=%s hits=%d latency=%dms",
            q, mode, len(hits), elapsed_ms,
        )

    try:
        from .recent_hits import global_recent_hits

        global_recent_hits().push(
            {
                "ts": time.time(),
                "query": q,
                "mode": mode,
                "hit_count": len(hits),
                "latency_ms": elapsed_ms,
                "timed_out": timed_out,
                "error": error.get("e"),
                "top_section_paths": [h.section_path for h in hits[:3]],
            }
        )
    except Exception:  # pragma: no cover
        pass

    return hits


__all__ = ["retrieve"]
