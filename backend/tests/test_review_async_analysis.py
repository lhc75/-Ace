from pathlib import Path
import sys
from unittest.mock import Mock

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services import review_async_analysis as analysis


@pytest.fixture
def mocked_analysis(monkeypatch):
    turns = [{
        "id": 1, "is_partial": False, "question_text": "question",
        "candidate_answer_text": "answer",
    }]
    monkeypatch.setattr(analysis.review, "get_session_detail", lambda session_id: {
        "source": "manual", "turns": turns,
    })
    update_turn = Mock()
    update_summary = Mock()
    update_status = Mock()
    monkeypatch.setattr(analysis.review, "update_turn_analysis", update_turn)
    monkeypatch.setattr(analysis.review, "update_session_summary", update_summary)
    monkeypatch.setattr(analysis.review, "update_session_status", update_status)
    analyze_turn = Mock(return_value={"scorecard": {"accuracy": 8}})
    summary = Mock(return_value={"summary_markdown": "complete summary"})
    monkeypatch.setattr(analysis.review_analysis, "analyze_turn", analyze_turn)
    monkeypatch.setattr(analysis.review_analysis, "generate_summary", summary)
    return analyze_turn, summary, update_turn, update_summary, update_status


@pytest.mark.parametrize("returns_error", [False, True])
def test_summary_failure_keeps_session_retryable(mocked_analysis, returns_error):
    _, summary, update_turn, update_summary, update_status = mocked_analysis
    if returns_error:
        summary.return_value = {"error": "provider unavailable"}
    else:
        summary.side_effect = RuntimeError("provider unavailable")

    analysis._analyze_session_worker(1)

    assert update_turn.call_args.kwargs["analysis_status"] == "completed"
    update_summary.assert_not_called()
    update_status.assert_called_once_with(1, "analysis_failed")


def test_turn_failure_keeps_session_retryable(mocked_analysis):
    analyze_turn, _, update_turn, _, update_status = mocked_analysis
    analyze_turn.return_value = {"error": "invalid API key"}

    analysis._analyze_session_worker(1)

    assert update_turn.call_args.kwargs["analysis_status"] == "failed"
    update_status.assert_called_once_with(1, "analysis_failed")


def test_successful_analysis_completes_session(mocked_analysis):
    _, _, update_turn, update_summary, update_status = mocked_analysis

    analysis._analyze_session_worker(1)

    assert update_turn.call_args.kwargs["analysis_status"] == "completed"
    assert update_summary.call_args.kwargs["summary_markdown"] == "complete summary"
    assert update_summary.call_args.kwargs["avg_score"] == 8
    update_status.assert_called_once_with(1, "completed")


def test_turn_score_backfills_knowledge_record(mocked_analysis, monkeypatch):
    update_score = Mock(return_value=True)
    save_record = Mock()
    monkeypatch.setattr(analysis.knowledge, "update_score_for_qa", update_score)
    monkeypatch.setattr(analysis.knowledge, "save_record", save_record)
    monkeypatch.setattr(analysis.review, "get_session_detail", lambda session_id: {
        "source": "assist",
        "turns": [{
            "id": 1, "is_partial": False, "question_text": "question",
            "candidate_answer_text": "answer", "qa_id": "qa-42",
        }],
    })

    analysis._analyze_session_worker(1)

    update_score.assert_called_once_with("qa-42", 8.0)
    save_record.assert_not_called()


def test_turn_without_matching_record_inserts_new_one(mocked_analysis, monkeypatch):
    update_score = Mock(return_value=False)
    save_record = Mock()
    monkeypatch.setattr(analysis.knowledge, "update_score_for_qa", update_score)
    monkeypatch.setattr(analysis.knowledge, "save_record", save_record)
    monkeypatch.setattr(analysis.review, "get_session_detail", lambda session_id: {
        "source": "manual",
        "turns": [{
            "id": 1, "is_partial": False, "question_text": "question",
            "candidate_answer_text": "answer", "qa_id": "manual-7-1",
        }],
    })

    analysis._analyze_session_worker(1)

    update_score.assert_called_once_with("manual-7-1", 8.0)
    save_record.assert_called_once_with(
        "manual", "question", "", score=8.0, qa_id="manual-7-1", candidate_answer="answer",
    )


def test_turn_without_candidate_submission_skips_backfill(mocked_analysis, monkeypatch):
    update_score = Mock()
    save_record = Mock()
    monkeypatch.setattr(analysis.knowledge, "update_score_for_qa", update_score)
    monkeypatch.setattr(analysis.knowledge, "save_record", save_record)
    monkeypatch.setattr(analysis.review, "get_session_detail", lambda session_id: {
        "source": "assist",
        "turns": [{
            "id": 1, "is_partial": False, "question_text": "question",
            "candidate_answer_text": "", "code_text": "", "qa_id": "qa-99",
        }],
    })

    analysis._analyze_session_worker(1)

    update_score.assert_not_called()
    save_record.assert_not_called()

