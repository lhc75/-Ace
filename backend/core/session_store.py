"""主会话（转录 + AI 答案）跨重启持久化。

复盘走 SQLite，但辅助面板的实时转录、候选人转录、对话历史、QA 答案此前只在
内存里，关掉应用就没了。这里把这些内容落到 data/session_state.json：
- 任一记录发生变更时标脏，后台线程防抖（~2s 空闲）后原子落盘；
- 启动时读回填充到当前会话，用户上次没清空的记录重开应用即可见；
- 用户“清空”后内存被清空也会标脏，落盘为“空”，所以清空后重开仍是空的。

仅在真实应用启动时 enable_and_restore() 后生效；单测不调用即不落盘，保持干净。
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from typing import Any, Optional

from core.logger import get_logger

_log = get_logger(__name__)

_STATE_FILENAME = "session_state.json"
_SAVE_DEBOUNCE_SEC = 2.0

_enabled = False
_dirty = threading.Event()
_stop = threading.Event()
_thread: Optional[threading.Thread] = None


def _state_path() -> str:
    from services.storage.paths import data_dir

    return os.path.join(data_dir(), _STATE_FILENAME)


def mark_dirty() -> None:
    """记录发生变更：启用后标脏，由后台线程防抖落盘。未启用则 no-op（单测场景）。"""
    if _enabled:
        _dirty.set()


def _save_now() -> None:
    from core.session import get_session, conversation_lock

    with conversation_lock:
        data = get_session().to_state()
    path = _state_path()
    tmp_fd, tmp_path = tempfile.mkstemp(
        prefix=".session_state.", suffix=".tmp", dir=os.path.dirname(path)
    )
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp_path, path)  # 原子替换，避免半写文件
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _autosave_loop() -> None:
    while not _stop.is_set():
        # 等到有变更；拿到变更后再等防抖窗口，把连续写入合并成一次落盘。
        if not _dirty.wait(timeout=1.0):
            continue
        _stop.wait(_SAVE_DEBOUNCE_SEC)
        _dirty.clear()
        try:
            _save_now()
        except Exception as e:
            _log.warning("session state save failed: %s", e)


def enable_and_restore() -> bool:
    """应用启动调用：读回磁盘上的会话记录并开启后台自动保存。返回是否恢复到内容。"""
    global _enabled, _thread
    restored = False
    try:
        path = _state_path()
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            from core.session import get_session, conversation_lock

            with conversation_lock:
                restored = get_session().load_state(data)
    except Exception as e:
        _log.warning("session state restore failed: %s", e)

    _enabled = True
    _stop.clear()
    if _thread is None or not _thread.is_alive():
        _thread = threading.Thread(target=_autosave_loop, daemon=True, name="session-autosave")
        _thread.start()
    return restored


def flush() -> None:
    """同步落盘一次（关机时调用，兜底防抖窗口里未写出的变更）。"""
    if not _enabled:
        return
    _dirty.clear()
    try:
        _save_now()
    except Exception as e:
        _log.warning("session state flush failed: %s", e)
