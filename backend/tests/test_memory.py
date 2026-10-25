from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core.session import Session
from services import memory


def _history(count=14):
    return [{"role": "user", "content": f"message-{index}"} for index in range(count)]


def _capture_workers(monkeypatch, summary):
    workers = []

    class DeferredThread:
        def __init__(self, target, **kwargs):
            self.target = target

        def start(self):
            workers.append(self.target)

    monkeypatch.setattr(memory, "threading", SimpleNamespace(Thread=DeferredThread))
    monkeypatch.setattr(memory, "summarize_messages", summary)
    return workers


def test_compaction_keeps_history_and_prior_summary_after_failure(monkeypatch):
    def fail(*args):
        raise RuntimeError("provider unavailable")

    workers = _capture_workers(monkeypatch, fail)
    session = Session(conversation_history=_history(), system_summary="prior")
    original = list(session.conversation_history)

    memory.schedule_compaction(session)
    workers.pop()()

    assert session.conversation_history == original
    assert session.system_summary == "prior"
    assert session._compaction_running is False


def test_compaction_preserves_messages_added_after_snapshot(monkeypatch):
    workers = _capture_workers(monkeypatch, lambda *args: "new summary")
    session = Session(conversation_history=_history())
    recent = list(session.conversation_history[-4:])
    added = {"role": "assistant", "content": "new answer"}

    memory.schedule_compaction(session)
    session.conversation_history.append(added)
    workers.pop()()

    assert session.conversation_history == [*recent, added]
    assert session.system_summary == "new summary"
    assert session._compaction_running is False


def test_old_compaction_cannot_overwrite_cleared_session_or_new_worker(monkeypatch):
    workers = _capture_workers(monkeypatch, lambda *args: "old summary")
    session = Session(conversation_history=_history())
    memory.schedule_compaction(session)
    old_worker = workers.pop()

    session.clear_content()
    session.conversation_history = _history()
    memory.schedule_compaction(session)
    old_worker()

    assert session.conversation_history == _history()
    assert session.system_summary == ""
    assert session._compaction_running is True

    workers.pop()()
    assert session._compaction_running is False


@pytest.mark.parametrize("change", ["edit", "trim"])
def test_compaction_does_not_remove_changed_history(monkeypatch, change):
    workers = _capture_workers(monkeypatch, lambda *args: "stale summary")
    session = Session(conversation_history=_history())
    memory.schedule_compaction(session)
    if change == "edit":
        session.conversation_history[0]["content"] = "corrected question"
    else:
        session.conversation_history = session.conversation_history[1:]
    expected = list(session.conversation_history)

    workers.pop()()

    assert session.conversation_history == expected
    assert session.system_summary == ""
    assert session._compaction_running is False


@pytest.mark.parametrize("choices", [[], [SimpleNamespace(message=SimpleNamespace(content=""))]])
def test_empty_model_response_is_a_compaction_failure(monkeypatch, choices):
    from core import config
    from services import llm

    monkeypatch.setattr(config, "get_config", lambda: SimpleNamespace(
        get_active_model=lambda: SimpleNamespace(model="test-model"),
    ))
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(
        create=lambda **kwargs: SimpleNamespace(choices=choices, usage=None),
    )))
    monkeypatch.setattr(llm, "get_client", lambda: client)

    with pytest.raises(ValueError, match="returned"):
        memory.summarize_messages(_history(), "prior summary")
