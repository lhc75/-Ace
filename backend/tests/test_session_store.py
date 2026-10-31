from __future__ import annotations

from pathlib import Path
import importlib
import sys

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

session_mod = importlib.import_module('core.session')
session_store = importlib.import_module('core.session_store')


@pytest.fixture
def fresh_session():
    s = session_mod.reset_session()
    yield s
    session_mod.reset_session()


def test_to_state_round_trips_records(fresh_session):
    fresh_session.add_transcription('面试官问题一', transcription_id='tr-1')
    fresh_session.add_candidate_transcription('候选人回答', qa_id='qa-1', segment_id='seg-1')
    fresh_session.add_qa(
        '两数之和怎么做？',
        '用哈希表一次遍历。',
        qa_id='qa-1',
        source='server_screen_left',
        model_name='模型一',
        images=['data:image/png;base64,abc'],
    )
    fresh_session.system_summary = '历史摘要'

    state = fresh_session.to_state()

    restored = session_mod.Session()
    assert restored.load_state(state) is True
    assert [t.id for t in restored.transcription_history] == ['tr-1']
    assert restored.transcription_history[0].text == '面试官问题一'
    assert restored.candidate_transcription_history == ['候选人回答']
    assert restored.candidate_answer_segments[0].qa_id == 'qa-1'
    assert len(restored.qa_pairs) == 1
    qa = restored.qa_pairs[0]
    assert qa.id == 'qa-1'
    assert qa.question == '两数之和怎么做？'
    assert qa.answer == '用哈希表一次遍历。'
    assert qa.images == ['data:image/png;base64,abc']
    assert restored.system_summary == '历史摘要'


def test_load_state_tolerates_unknown_and_malformed_fields(fresh_session):
    state = {
        'version': 999,
        'transcription_history': [
            {'id': 'tr-1', 'text': 'ok', 'bogus_field': 1},
            {'text': 'missing id -> skipped'},
            'not a dict -> skipped',
        ],
        'qa_pairs': [
            {'id': 'qa-1', 'question': 'q', 'answer': 'a', 'unknown': True},
            {'question': 'no id -> skipped', 'answer': 'x'},
        ],
        'candidate_transcription_history': ['c1', None, 'c2'],
    }
    restored = session_mod.Session()
    assert restored.load_state(state) is True
    assert [t.id for t in restored.transcription_history] == ['tr-1']
    assert [q.id for q in restored.qa_pairs] == ['qa-1']
    assert restored.candidate_transcription_history == ['c1', 'c2']


def test_load_state_empty_returns_false(fresh_session):
    restored = session_mod.Session()
    assert restored.load_state({}) is False
    assert restored.load_state({'qa_pairs': [], 'transcription_history': []}) is False


def test_enable_and_restore_reads_file_and_marks_dirty_saves(tmp_path, monkeypatch, fresh_session):
    # 把持久化目录指到临时目录，避免污染真实 data/
    monkeypatch.setenv('IA_APP_DATA_DIR', str(tmp_path))
    paths_mod = importlib.import_module('services.storage.paths')
    # data_dir 依赖 backend_root() 读环境变量，无需重载

    # 先写入会话并手动落盘
    fresh_session.add_qa('q1', 'a1', qa_id='qa-persist')
    session_store._enabled = True
    try:
        session_store._save_now()
        state_file = Path(session_store._state_path())
        assert state_file.is_file()

        # 清空内存，再从磁盘恢复
        session_mod.reset_session()
        assert session_mod.get_session().qa_pairs == []
        restored = session_store.enable_and_restore()
        assert restored is True
        assert [q.id for q in session_mod.get_session().qa_pairs] == ['qa-persist']
    finally:
        session_store._enabled = False
        session_store._stop.set()


def test_clear_content_persists_empty(tmp_path, monkeypatch, fresh_session):
    monkeypatch.setenv('IA_APP_DATA_DIR', str(tmp_path))
    fresh_session.add_qa('q1', 'a1', qa_id='qa-1')
    session_store._enabled = True
    try:
        session_store._save_now()
        assert [q['id'] for q in _read(session_store)['qa_pairs']] == ['qa-1']

        fresh_session.clear_content()
        session_store._save_now()
        assert _read(session_store)['qa_pairs'] == []
    finally:
        session_store._enabled = False


def _read(store):
    import json
    with open(store._state_path(), 'r', encoding='utf-8') as f:
        return json.load(f)
