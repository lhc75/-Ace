from __future__ import annotations

import asyncio
import importlib
import json
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import config as config_module
from core.config import ALIYUN_STT_MODEL_OPTIONS, AppConfig
from api.assist.pipeline import _candidate_provider_config, _candidate_streaming_config
from services.stt import factory

common_router = importlib.import_module("api.common.router")


def test_config_roundtrip_and_model_switch_preserve_other_engines(monkeypatch, tmp_path):
    path = tmp_path / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_FILE", str(path))
    monkeypatch.setattr(config_module, "_config", AppConfig(doubao_stt_api_key="doubao-key"))
    body = common_router.ConfigUpdate(
        stt_provider="aliyun", aliyun_stt_api_key=" key ",
        aliyun_stt_model=ALIYUN_STT_MODEL_OPTIONS[1],
        candidate_asr_enabled=True, candidate_stt_provider="aliyun", candidate_remote_stt_enabled=True,
    )
    result = asyncio.run(common_router.api_update_config(body))
    assert result["stt_provider"] == result["candidate_stt_provider"] == "aliyun"
    assert result["aliyun_stt_api_key"] == "key"
    assert result["aliyun_stt_model"] == ALIYUN_STT_MODEL_OPTIONS[1]
    assert result["doubao_stt_api_key"] == "doubao-key"
    assert json.loads(path.read_text())["aliyun_stt_api_key"] == "key"
    result = asyncio.run(common_router.api_update_config(common_router.ConfigUpdate(stt_provider="whisper")))
    assert result["aliyun_stt_api_key"] == "key"
    loaded = AppConfig(**json.loads(path.read_text()))
    assert loaded.aliyun_stt_model == ALIYUN_STT_MODEL_OPTIONS[1]


def test_custom_aliyun_model_is_trimmed_saved_and_reloaded(monkeypatch, tmp_path):
    path = tmp_path / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_FILE", str(path))
    monkeypatch.setattr(config_module, "_config", AppConfig())
    result = asyncio.run(common_router.api_update_config(common_router.ConfigUpdate(
        aliyun_stt_model="  custom-qwen-asr-model  ",
    )))
    assert result["aliyun_stt_model"] == "custom-qwen-asr-model"
    assert AppConfig(**json.loads(path.read_text())).aliyun_stt_model == "custom-qwen-asr-model"
    assert AppConfig(aliyun_stt_model="  other-model  ").aliyun_stt_model == "other-model"


def test_provider_and_model_options():
    options = asyncio.run(common_router.api_options())
    assert "aliyun" in options["stt_providers"]
    assert options["aliyun_stt_models"] == ALIYUN_STT_MODEL_OPTIONS
    assert AppConfig().aliyun_stt_model == ALIYUN_STT_MODEL_OPTIONS[0]
    assert AppConfig().stt_provider == "whisper"


def test_interviewer_streaming_toggle_defaults_off_and_roundtrips(monkeypatch, tmp_path):
    assert AppConfig().interviewer_streaming_asr_enabled is False
    path = tmp_path / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_FILE", str(path))
    monkeypatch.setattr(config_module, "_config", AppConfig())
    result = asyncio.run(common_router.api_update_config(common_router.ConfigUpdate(
        interviewer_streaming_asr_enabled=True,
    )))
    assert result["interviewer_streaming_asr_enabled"] is True
    assert AppConfig(**json.loads(path.read_text())).interviewer_streaming_asr_enabled is True
    result = asyncio.run(common_router.api_update_config(common_router.ConfigUpdate(
        interviewer_streaming_asr_enabled=False,
    )))
    assert result["interviewer_streaming_asr_enabled"] is False


@pytest.mark.parametrize("opt_in,expected", [(False, "whisper"), (True, "aliyun")])
def test_candidate_requires_remote_opt_in(opt_in, expected):
    cfg = AppConfig(candidate_stt_provider="aliyun", candidate_remote_stt_enabled=opt_in)
    assert cfg.candidate_stt_provider == expected
    assert _candidate_provider_config(cfg)[0] == expected
    assert _candidate_streaming_config(cfg, "aliyun")[0] is False


def test_config_update_enforces_candidate_remote_guard(monkeypatch, tmp_path):
    monkeypatch.setattr(config_module, "CONFIG_FILE", str(tmp_path / "config.json"))
    monkeypatch.setattr(config_module, "_config", AppConfig())
    result = asyncio.run(common_router.api_update_config(common_router.ConfigUpdate(
        candidate_asr_enabled=True, candidate_stt_provider="aliyun",
        candidate_remote_stt_enabled=False,
    )))
    assert result["candidate_stt_provider"] == "whisper"
    result = asyncio.run(common_router.api_update_config(common_router.ConfigUpdate(
        candidate_stt_provider="aliyun", candidate_remote_stt_enabled=True,
    )))
    assert result["candidate_stt_provider"] == "aliyun"
    result = asyncio.run(common_router.api_update_config(common_router.ConfigUpdate(
        candidate_remote_stt_enabled=False,
    )))
    assert result["candidate_stt_provider"] == "whisper"


def test_factory_reuses_engine_and_refreshes_credentials_and_model(monkeypatch):
    cfg = AppConfig(stt_provider="aliyun", aliyun_stt_api_key="one")
    monkeypatch.setattr(config_module, "get_config", lambda: cfg)
    monkeypatch.setattr(factory, "_aliyun_engine", None)
    first = factory.get_stt_engine()
    assert factory.get_stt_engine(provider="aliyun") is first
    cfg.aliyun_stt_model = "custom-qwen-asr-model"
    second = factory.get_stt_engine()
    assert second is not first
    assert second.model == "custom-qwen-asr-model"
    cfg.aliyun_stt_api_key = "two"
    third = factory.get_stt_engine()
    assert third is not second
    assert third.api_key == "two"
    assert first.api_key == "one"


def test_saved_aliyun_changes_reset_only_affected_circuits(monkeypatch, tmp_path):
    monkeypatch.setattr(config_module, "CONFIG_FILE", str(tmp_path / "config.json"))
    monkeypatch.setattr(config_module, "_config", AppConfig(
        stt_provider="aliyun", aliyun_stt_api_key="one",
        candidate_stt_provider="generic", candidate_remote_stt_enabled=True,
    ))
    monkeypatch.setattr(factory, "_circuit_failures", 3)
    monkeypatch.setattr(factory, "_circuit_open_until", time.monotonic() + 3600)
    monkeypatch.setattr(factory, "_circuit_failures_by_scope", {"interviewer": 3, "candidate": 3})
    monkeypatch.setattr(factory, "_circuit_open_until_by_scope", {
        "interviewer": time.monotonic() + 3600, "candidate": time.monotonic() + 3600,
    })
    asyncio.run(common_router.api_update_config(common_router.ConfigUpdate(aliyun_stt_api_key="two")))
    assert not factory._is_circuit_open("interviewer")
    assert factory._is_circuit_open("candidate")
    for _ in range(3):
        factory._circuit_record_failure(is_auth=True, scope="interviewer")
    asyncio.run(common_router.api_update_config(common_router.ConfigUpdate(aliyun_stt_api_key="two")))
    assert factory._is_circuit_open("interviewer")
    asyncio.run(common_router.api_update_config(common_router.ConfigUpdate(candidate_stt_provider="aliyun")))
    assert not factory._is_circuit_open("candidate")
    assert factory._is_circuit_open("interviewer")
    asyncio.run(common_router.api_update_config(common_router.ConfigUpdate(aliyun_stt_model=ALIYUN_STT_MODEL_OPTIONS[1])))
    assert not factory._is_circuit_open("interviewer")
    assert not factory._is_circuit_open("candidate")


def test_stt_probe_requires_key_without_connecting(monkeypatch):
    monkeypatch.setattr(common_router, "get_config", lambda: AppConfig(stt_provider="aliyun"))
    monkeypatch.setattr(common_router, "get_stt_engine", lambda: pytest.fail("Must not connect without key"))
    result = asyncio.run(common_router.api_stt_test())
    assert result["ok"] is False
    assert result["provider"] == "aliyun"
    assert result["fallback_used"] is False


def test_stt_probe_requires_model_without_connecting(monkeypatch):
    monkeypatch.setattr(common_router, "get_config", lambda: AppConfig(
        stt_provider="aliyun", aliyun_stt_api_key="key", aliyun_stt_model="  ",
    ))
    monkeypatch.setattr(common_router, "get_stt_engine", lambda: pytest.fail("Must not connect without model"))
    result = asyncio.run(common_router.api_stt_test())
    assert result["ok"] is False
    assert result["provider"] == "aliyun"
    assert "模型名称未配置" in result["detail"]


@pytest.mark.parametrize("failure", [False, True])
def test_stt_probe_uses_threadpool_and_never_hides_failure_with_fallback(monkeypatch, failure):
    caller_thread = threading.get_ident()
    cfg = AppConfig(stt_provider="aliyun", aliyun_stt_api_key="key")
    monkeypatch.setattr(common_router, "get_config", lambda: cfg)
    monkeypatch.setattr(common_router.Path, "exists", lambda _path: False)

    def transcribe(*_args, **_kwargs):
        assert threading.get_ident() != caller_thread
        if failure:
            raise RuntimeError("provider rejected request")
        return "Redis"

    monkeypatch.setattr(common_router, "get_stt_engine", lambda: SimpleNamespace(transcribe=transcribe))
    result = asyncio.run(common_router.api_stt_test())
    assert result["ok"] is not failure
    assert result["provider"] == "aliyun"
    assert result["fallback_used"] is False
    if not failure:
        assert result["text"] == "Redis"
        assert "阿里千问" in result["detail"]


def _patch_stt_probe(monkeypatch, cfg, *, failure: Exception | None = None):
    monkeypatch.setattr(common_router, "get_config", lambda: cfg)
    monkeypatch.setattr(common_router.Path, "exists", lambda _path: False)

    def transcribe(*_args, **_kwargs):
        if failure is not None:
            raise failure
        return "好的"

    monkeypatch.setattr(common_router, "get_stt_engine", lambda: SimpleNamespace(transcribe=transcribe))


def _patch_realtime_probe(monkeypatch, *, aliyun=None, generic=None):
    """替换真实音频探测：aliyun/generic 传 (ok, detail) 元组，或 pytest.fail 以断言未被调用。"""
    from services.stt import realtime_probe
    monkeypatch.setattr(
        realtime_probe, "probe_aliyun_realtime",
        aliyun if callable(aliyun) else lambda *a: aliyun,
    )
    monkeypatch.setattr(
        realtime_probe, "probe_generic_realtime",
        generic if callable(generic) else lambda *a: generic,
    )


def test_stt_test_runs_realtime_probe_and_surfaces_warning(monkeypatch):
    """开启实时转写且探测失败时：测试通过（逐段正常）但必须给出警告。"""
    cfg = AppConfig(
        stt_provider="aliyun", aliyun_stt_api_key="key",
        interviewer_streaming_asr_enabled=True,
    )
    _patch_stt_probe(monkeypatch, cfg)
    _patch_realtime_probe(monkeypatch, aliyun=(False, "任务失败: 模型不支持"))
    result = asyncio.run(common_router.api_stt_test())
    assert result["ok"] is True
    assert "实时语音探测失败" in result["warning"]
    assert "任务失败" in result["warning"]
    assert "请更换支持实时识别的模型" in result["warning"]
    assert "关闭「面试官实时流式转写」" in result["warning"]


def test_stt_test_realtime_probe_pass_means_no_warning(monkeypatch):
    cfg = AppConfig(
        stt_provider="aliyun", aliyun_stt_api_key="key",
        interviewer_streaming_asr_enabled=True,
    )
    _patch_stt_probe(monkeypatch, cfg)
    _patch_realtime_probe(monkeypatch, aliyun=(True, ""))
    result = asyncio.run(common_router.api_stt_test())
    assert result["ok"] is True
    assert "warning" not in result


def test_stt_test_skips_realtime_probe_when_toggle_off(monkeypatch):
    cfg = AppConfig(stt_provider="aliyun", aliyun_stt_api_key="key")
    _patch_stt_probe(monkeypatch, cfg)
    _patch_realtime_probe(monkeypatch, aliyun=lambda *a: pytest.fail("实时关闭时不应探测"))
    result = asyncio.run(common_router.api_stt_test())
    assert result["ok"] is True
    assert "warning" not in result


def test_stt_test_generic_realtime_probe_failure_warns(monkeypatch):
    cfg = AppConfig(
        stt_provider="generic",
        generic_stt_api_base_url="https://api.example.com/v1",
        generic_stt_model="some-asr",
        interviewer_streaming_asr_enabled=True,
    )
    _patch_stt_probe(monkeypatch, cfg)
    _patch_realtime_probe(monkeypatch, generic=(False, "说话中途的转写没有返回文本"))
    result = asyncio.run(common_router.api_stt_test())
    assert result["ok"] is True
    assert "实时语音探测失败" in result["warning"]
    assert "关闭「面试官实时流式转写」" in result["warning"]


def test_stt_test_whisper_never_probes(monkeypatch):
    cfg = AppConfig(stt_provider="whisper", interviewer_streaming_asr_enabled=True)
    _patch_stt_probe(monkeypatch, cfg)
    _patch_realtime_probe(
        monkeypatch,
        aliyun=lambda *a: pytest.fail("whisper 不应探测"),
        generic=lambda *a: pytest.fail("whisper 不应探测"),
    )
    result = asyncio.run(common_router.api_stt_test())
    assert result["ok"] is True
    assert "warning" not in result


def test_stt_probe_aliyun_failure_appends_model_guidance(monkeypatch):
    cfg = AppConfig(
        stt_provider="aliyun",
        aliyun_stt_api_key="key",
        aliyun_stt_model="qwen-audio-asr",
    )
    _patch_stt_probe(monkeypatch, cfg, failure=RuntimeError("阿里千问 ASR 任务失败: InvalidParameter: bad model"))
    result = asyncio.run(common_router.api_stt_test())
    assert result["ok"] is False
    assert "任务失败" in result["detail"]
    assert "请更换支持实时识别的模型" in result["detail"]


@pytest.mark.parametrize("realtime_on", [False, True])
def test_stt_probe_generic_model_failure_suggests_fix(monkeypatch, realtime_on):
    """通用 ASR 报模型类错误时必须提示换模型；开启实时时同时提示可关闭实时转写。"""
    cfg = AppConfig(
        stt_provider="generic",
        generic_stt_api_base_url="https://api.example.com/v1",
        generic_stt_model="gpt-4o",
        interviewer_streaming_asr_enabled=realtime_on,
    )
    _patch_stt_probe(monkeypatch, cfg, failure=RuntimeError("HTTP 404: model not found"))
    result = asyncio.run(common_router.api_stt_test())
    assert result["ok"] is False
    assert "不支持实时语音转写" in result["detail"]
    assert ("关闭「面试官实时流式转写」" in result["detail"]) is realtime_on


def test_stt_probe_generic_non_model_failure_keeps_detail(monkeypatch):
    cfg = AppConfig(
        stt_provider="generic",
        generic_stt_api_base_url="https://api.example.com/v1",
        generic_stt_model="whisper-1",
        interviewer_streaming_asr_enabled=True,
    )
    _patch_stt_probe(monkeypatch, cfg, failure=RuntimeError("通用 ASR 请求超时: timed out"))
    result = asyncio.run(common_router.api_stt_test())
    assert result["ok"] is False
    assert "不支持实时语音转写" not in result["detail"]
