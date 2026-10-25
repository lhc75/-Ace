from __future__ import annotations

import asyncio
from pathlib import Path
import importlib
import sys
from types import SimpleNamespace

import pytest
from fastapi import HTTPException


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

main_mod = importlib.import_module("main")
assist_routes = importlib.import_module("api.assist.routes")
from core.session import Session  # noqa: E402


def test_is_path_within_dir_rejects_same_prefix_sibling(tmp_path: Path):
    safe_dir = tmp_path / "dist"
    sibling_dir = tmp_path / "dist-evil"
    safe_dir.mkdir()
    sibling_dir.mkdir()

    assert main_mod._is_path_within_dir(safe_dir, sibling_dir / "index.html") is False


def _request_with_origin(origin: str | None, host: str = "127.0.0.1", port: int = 18080):
    return SimpleNamespace(
        headers=({"origin": origin} if origin else {}),
        url=SimpleNamespace(scheme="http", hostname=host, port=port),
    )


def test_loopback_bypass_allows_non_browser_requests():
    assert main_mod._origin_allows_loopback_bypass(_request_with_origin(None)) is True


def test_loopback_bypass_rejects_cross_origin_browser_requests():
    req = _request_with_origin("http://localhost:5173")

    assert main_mod._origin_allows_loopback_bypass(req) is False


def test_loopback_bypass_allows_same_port_loopback_origin():
    req = _request_with_origin("http://localhost:18080")

    assert main_mod._origin_allows_loopback_bypass(req) is True


def test_api_start_rejects_non_integer_device_id():
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(assist_routes.api_start({"device_id": "abc"}))

    assert exc_info.value.status_code == 400
    assert "device_id" in str(exc_info.value.detail)


def test_api_ask_returns_error_when_no_answer_model_available(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(assist_routes, "submit_answer_task", lambda task: False)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            assist_routes.api_ask(assist_routes.ManualQuestion(text="解释一下 CAP 定理"))
        )

    assert exc_info.value.status_code == 503
    assert "模型" in str(exc_info.value.detail)


def test_api_ask_replacement_keeps_original_qa_id_without_global_cancel(
    monkeypatch: pytest.MonkeyPatch,
):
    session = Session()
    session.add_qa(
        "语音识别出的旧问题",
        "旧答案",
        qa_id="qa-replace",
        source="asr",
        model_name="旧模型",
    )
    submitted = []
    replacement_calls = []
    cancel_calls = []

    monkeypatch.setattr(assist_routes, "get_session", lambda: session)
    monkeypatch.setattr(
        assist_routes,
        "prepare_answer_replacement",
        lambda qa_id: replacement_calls.append(qa_id),
    )
    monkeypatch.setattr(
        assist_routes,
        "cancel_answer_work",
        lambda **kwargs: cancel_calls.append(kwargs),
    )
    monkeypatch.setattr(
        assist_routes,
        "submit_answer_task",
        lambda task: submitted.append(task) or True,
    )

    result = asyncio.run(
        assist_routes.api_ask(
            assist_routes.ManualQuestion(
                text="修正后的面试官问题",
                replace_qa_id="qa-replace",
            )
        )
    )

    assert result == {"ok": True}
    assert replacement_calls == ["qa-replace"]
    assert cancel_calls == []
    assert submitted[0][0] == "修正后的面试官问题"
    assert submitted[0][4]["replace_qa_id"] == "qa-replace"
    assert submitted[0][4]["replace_original_question"] == "语音识别出的旧问题"
    assert submitted[0][4]["replace_original_answer"] == "旧答案"


def test_api_clear_preserves_active_and_paused_session_state(monkeypatch: pytest.MonkeyPatch):
    session = Session()
    session.is_recording = True
    session.is_paused = True
    session.add_transcription("待清空的问题", transcription_id="tr-clear")
    session.add_qa("待清空的问题", "待清空的答案", qa_id="qa-clear")
    broadcasts = []

    monkeypatch.setattr(assist_routes, "get_session", lambda: session)
    monkeypatch.setattr(
        assist_routes,
        "cancel_answer_work",
        lambda **kwargs: kwargs,
    )
    monkeypatch.setattr("api.realtime.ws.broadcast", broadcasts.append)

    result = asyncio.run(assist_routes.api_clear())

    assert result == {"ok": True}
    assert session.is_recording is True
    assert session.is_paused is True
    assert session.transcription_history == []
    assert session.qa_pairs == []
    assert broadcasts == [{"type": "session_cleared"}]


def test_api_ask_replacement_updates_linked_transcriptions_while_paused(
    monkeypatch: pytest.MonkeyPatch,
):
    session = Session()
    first = session.add_transcription("语音识别出的旧问题", transcription_id="tr-replace")
    session.add_qa(
        "语音识别出的旧问题",
        "旧答案",
        qa_id="qa-replace-paused",
        source="asr",
        source_transcription_ids=[first.id],
    )
    submitted = []
    broadcasts = []

    monkeypatch.setattr(assist_routes, "get_session", lambda: session)
    monkeypatch.setattr(assist_routes, "is_paused", lambda: True)
    monkeypatch.setattr(assist_routes, "prepare_answer_replacement", lambda _qa_id: None)
    monkeypatch.setattr(
        assist_routes,
        "submit_answer_task",
        lambda task: submitted.append(task) or True,
    )
    monkeypatch.setattr("api.realtime.ws.broadcast", broadcasts.append)

    result = asyncio.run(
        assist_routes.api_ask(
            assist_routes.ManualQuestion(
                text="修正后的面试官问题",
                replace_qa_id="qa-replace-paused",
            )
        )
    )

    assert result == {"ok": True}
    assert session.transcription_history[0].text == "修正后的面试官问题"
    assert submitted[0][4]["replace_original_transcriptions"] == {
        "tr-replace": "语音识别出的旧问题",
    }
    assert broadcasts == [{
        "type": "transcription_updated",
        "id": "tr-replace",
        "text": "修正后的面试官问题",
        "qa_id": "qa-replace-paused",
    }]


def test_api_ask_rejects_new_question_while_paused(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(assist_routes, "is_paused", lambda: True)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            assist_routes.api_ask(
                assist_routes.ManualQuestion(text="暂停期间的新问题")
            )
        )

    assert exc_info.value.status_code == 409


def test_api_ask_replacement_restores_transcriptions_when_queue_rejects(
    monkeypatch: pytest.MonkeyPatch,
):
    session = Session()
    first = session.add_transcription("原始问题", transcription_id="tr-reject")
    session.add_qa(
        "原始问题",
        "原始答案",
        qa_id="qa-reject",
        source="asr",
        source_transcription_ids=[first.id],
    )
    broadcasts = []

    monkeypatch.setattr(assist_routes, "get_session", lambda: session)
    monkeypatch.setattr(assist_routes, "is_paused", lambda: True)
    monkeypatch.setattr(assist_routes, "prepare_answer_replacement", lambda _qa_id: None)
    monkeypatch.setattr(assist_routes, "submit_answer_task", lambda _task: False)
    monkeypatch.setattr("api.realtime.ws.broadcast", broadcasts.append)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            assist_routes.api_ask(
                assist_routes.ManualQuestion(
                    text="无法提交的新问题",
                    replace_qa_id="qa-reject",
                )
            )
        )

    assert exc_info.value.status_code == 503
    assert session.transcription_history[0].text == "原始问题"
    assert [event["text"] for event in broadcasts] == [
        "无法提交的新问题",
        "原始问题",
    ]


def test_api_ask_from_server_screens_submits_multi_image_task(monkeypatch: pytest.MonkeyPatch):
    submitted = []
    cancel_calls = []

    monkeypatch.setattr("services.llm.has_vision_model", lambda: True)
    monkeypatch.setattr(assist_routes, "get_config", lambda: SimpleNamespace(
        language="zh",
        screen_capture_region="left_half",
        written_exam_mode=False,
    ))
    monkeypatch.setattr(assist_routes, "pick_model_index", lambda task, busy: 0)
    monkeypatch.setattr(assist_routes, "cancel_answer_work", lambda reset_session_data=False: cancel_calls.append(reset_session_data))
    monkeypatch.setattr(assist_routes, "submit_answer_task", lambda task: submitted.append(task) or True)

    res = asyncio.run(
        assist_routes.api_ask_from_server_screens(
            assist_routes.MultiServerScreenQuestion(images=["data:image/png;base64,a", "data:image/png;base64,b"])
        )
    )

    assert res == {"ok": True}
    assert len(submitted) == 1
    text, images, manual, source, meta = submitted[0]
    assert "2 张连续截图" in text
    assert images == ["data:image/png;base64,a", "data:image/png;base64,b"]
    assert manual is True
    assert source == "server_screen_multi"
    assert meta["image_count"] == 2
    assert "override_think_mode" not in meta
    assert cancel_calls == [False]


def test_api_ask_from_server_screens_skips_cancel_in_written_exam(monkeypatch: pytest.MonkeyPatch):
    submitted = []
    cancel_calls = []

    monkeypatch.setattr("services.llm.has_vision_model", lambda: True)
    monkeypatch.setattr(assist_routes, "get_config", lambda: SimpleNamespace(
        language="zh",
        screen_capture_region="left_half",
        written_exam_mode=True,
    ))
    monkeypatch.setattr(assist_routes, "pick_model_index", lambda task, busy: 0)
    monkeypatch.setattr(assist_routes, "cancel_answer_work", lambda reset_session_data=False: cancel_calls.append(reset_session_data))
    monkeypatch.setattr(assist_routes, "submit_answer_task", lambda task: submitted.append(task) or True)

    res = asyncio.run(
        assist_routes.api_ask_from_server_screens(
            assist_routes.MultiServerScreenQuestion(
                images=["data:image/png;base64,a"],
                override_think_mode=True,
            )
        )
    )

    assert res == {"ok": True}
    assert len(submitted) == 1
    meta = submitted[0][4]
    assert meta["override_think_mode"] is True
    assert cancel_calls == []


def test_api_ask_from_server_screen_cancels_existing_generation(monkeypatch: pytest.MonkeyPatch):
    submitted = []
    cancel_calls = []

    monkeypatch.setattr("services.llm.has_vision_model", lambda: True)
    monkeypatch.setattr("services.capture.capture_primary_left_half_data_url", lambda: "data:image/jpeg;base64,a")
    monkeypatch.setattr(assist_routes, "get_config", lambda: SimpleNamespace(
        language="zh",
        screen_capture_region="left_half",
        written_exam_mode=False,
    ))
    monkeypatch.setattr(assist_routes, "pick_model_index", lambda task, busy: 0)
    monkeypatch.setattr(assist_routes, "cancel_answer_work", lambda reset_session_data=False: cancel_calls.append(reset_session_data))
    monkeypatch.setattr(assist_routes, "submit_answer_task", lambda task: submitted.append(task) or True)

    res = asyncio.run(assist_routes.api_ask_from_server_screen())

    assert res == {"ok": True}
    assert len(submitted) == 1
    assert submitted[0][1] == "data:image/jpeg;base64,a"
    assert submitted[0][3] == "server_screen_left"
    assert "override_think_mode" not in submitted[0][4]
    assert cancel_calls == [False]


def test_api_ask_from_server_screen_skips_cancel_in_written_exam(monkeypatch: pytest.MonkeyPatch):
    submitted = []
    cancel_calls = []

    monkeypatch.setattr("services.llm.has_vision_model", lambda: True)
    monkeypatch.setattr("services.capture.capture_primary_left_half_data_url", lambda: "data:image/jpeg;base64,a")
    monkeypatch.setattr(assist_routes, "get_config", lambda: SimpleNamespace(
        language="zh",
        screen_capture_region="left_half",
        written_exam_mode=True,
    ))
    monkeypatch.setattr(assist_routes, "pick_model_index", lambda task, busy: 0)
    monkeypatch.setattr(assist_routes, "cancel_answer_work", lambda reset_session_data=False: cancel_calls.append(reset_session_data))
    monkeypatch.setattr(assist_routes, "submit_answer_task", lambda task: submitted.append(task) or True)

    res = asyncio.run(
        assist_routes.api_ask_from_server_screen(
            assist_routes.ServerScreenQuestion(override_think_mode=False)
        )
    )

    assert res == {"ok": True}
    assert len(submitted) == 1
    assert submitted[0][4]["override_think_mode"] is False
    assert cancel_calls == []


def test_api_preflight_replay_validates_params_and_returns_result(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        assist_routes,
        "get_session",
        lambda: SimpleNamespace(is_recording=False, is_paused=False),
    )

    async def fake_run_in_threadpool(fn, *args, **kwargs):
        return fn(*args, **kwargs)

    replay_calls = {}

    def fake_replay(device_id, *, repeats=3, gap_sec=0.25, audio_path=None, expected_phrase=None):
        replay_calls.update(
            {
                "device_id": device_id,
                "repeats": repeats,
                "gap_sec": gap_sec,
                "audio_path": audio_path,
                "expected_phrase": expected_phrase,
            }
        )
        return {"device_id": device_id, "success_count": repeats, "failure_count": 0}

    monkeypatch.setattr(assist_routes, "run_in_threadpool", fake_run_in_threadpool)
    monkeypatch.setattr("api.assist.sound_test.replay_preflight_capture_stt", fake_replay)

    result = asyncio.run(
        assist_routes.api_preflight_replay({
            "device_id": 7,
            "repeats": 4,
            "gap_sec": 0.1,
            "audio_path": "tmp/sample.wav",
            "expected_phrase": "你好",
        })
    )

    assert result == {"device_id": 7, "success_count": 4, "failure_count": 0}
    assert replay_calls == {
        "device_id": 7,
        "repeats": 4,
        "gap_sec": 0.1,
        "audio_path": "tmp/sample.wav",
        "expected_phrase": "你好",
    }


def test_api_preflight_replay_rejects_when_recording(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        assist_routes,
        "get_session",
        lambda: SimpleNamespace(is_recording=True, is_paused=False),
    )

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(assist_routes.api_preflight_replay({"device_id": 7}))

    assert exc_info.value.status_code == 409


def test_api_exam_preflight_rejects_active_or_paused_session(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(
        assist_routes,
        "get_session",
        lambda: SimpleNamespace(is_recording=True, is_paused=True),
    )

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(assist_routes.api_exam_preflight_run())

    assert exc_info.value.status_code == 409
    assert "结束当前面试或笔试" in str(exc_info.value.detail)


def test_api_start_rejects_while_exam_preflight_is_running(
    monkeypatch: pytest.MonkeyPatch,
):
    exam_test = importlib.import_module("api.assist.exam_test")
    monkeypatch.setattr(exam_test, "is_exam_preflight_running", lambda: True)
    started: list[object] = []
    monkeypatch.setattr(
        assist_routes,
        "start_nonblocking",
        lambda device_id: started.append(device_id),
    )

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(assist_routes.api_start({"device_id": 1}))

    assert exc_info.value.status_code == 409
    assert "链路检测正在运行" in str(exc_info.value.detail)
    assert started == []
