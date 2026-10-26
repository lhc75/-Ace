from __future__ import annotations

import asyncio
import importlib
from pathlib import Path
import sys
from types import SimpleNamespace

import numpy as np
import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import config as config_module
from core.config import AppConfig
from services.stt import factory

common_router = importlib.import_module("api.common.router")
ws_module = importlib.import_module("api.realtime.ws")


@pytest.fixture
def isolated_circuits(monkeypatch):
    monkeypatch.setattr(factory, "_circuit_failures", 0)
    monkeypatch.setattr(factory, "_circuit_open_until", 0.0)
    monkeypatch.setattr(factory, "_circuit_failures_by_scope", {})
    monkeypatch.setattr(factory, "_circuit_open_until_by_scope", {})


@pytest.mark.parametrize("scope", ["interviewer", "candidate"])
def test_cooldown_starts_fresh_failure_window(monkeypatch, isolated_circuits, scope):
    clock = [100.0]
    monkeypatch.setattr(factory.time, "monotonic", lambda: clock[0])
    for _ in range(factory.CIRCUIT_THRESHOLD):
        factory._circuit_record_failure(scope=scope)
    assert factory._is_circuit_open(scope)
    clock[0] += factory.CIRCUIT_COOLDOWN_SEC
    assert not factory._is_circuit_open(scope)

    factory._circuit_record_failure(scope=scope)
    assert not factory._is_circuit_open(scope)
    assert factory._circuit_failures_by_scope[scope] == 1


@pytest.mark.parametrize("provider,changed_field", [
    ("generic", "generic_stt_api_key"),
    ("generic", "generic_stt_model"),
    ("generic", "generic_stt_api_base_url"),
    ("generic", "generic_stt_custom_headers"),
    ("doubao", "doubao_stt_api_key"),
    ("doubao", "doubao_stt_resource_id"),
    ("aliyun", "aliyun_stt_api_key"),
])
def test_corrected_settings_reset_only_affected_provider(
    monkeypatch, tmp_path, isolated_circuits, provider, changed_field,
):
    monkeypatch.setattr(config_module, "CONFIG_FILE", str(tmp_path / "config.json"))
    monkeypatch.setattr(config_module, "_config", AppConfig(
        stt_provider=provider, candidate_stt_provider="whisper",
    ))
    for scope in ("interviewer", "candidate"):
        for _ in range(factory.CIRCUIT_THRESHOLD):
            factory._circuit_record_failure(scope=scope, is_auth=True)

    asyncio.run(common_router.api_update_config(common_router.ConfigUpdate(**{changed_field: "corrected"})))
    assert not factory._is_circuit_open("interviewer")
    assert factory._is_circuit_open("candidate")


def test_switching_remote_provider_does_not_inherit_old_outage(monkeypatch, tmp_path, isolated_circuits):
    monkeypatch.setattr(config_module, "CONFIG_FILE", str(tmp_path / "config.json"))
    monkeypatch.setattr(config_module, "_config", AppConfig(stt_provider="doubao"))
    for _ in range(factory.CIRCUIT_THRESHOLD):
        factory._circuit_record_failure(is_auth=True)

    asyncio.run(common_router.api_update_config(common_router.ConfigUpdate(stt_provider="generic")))
    assert not factory._is_circuit_open()


@pytest.mark.parametrize("success", [False, True])
def test_successful_primary_probe_recovers_matching_scopes(monkeypatch, isolated_circuits, success):
    cfg = AppConfig(
        stt_provider="generic", generic_stt_api_base_url="http://localhost/v1", generic_stt_model="asr",
        candidate_stt_provider="generic", candidate_remote_stt_enabled=True,
    )
    monkeypatch.setattr(common_router, "get_config", lambda: cfg)
    monkeypatch.setattr(common_router.Path, "exists", lambda _path: False)

    def transcribe(*_args, **_kwargs):
        if not success:
            raise RuntimeError("connection failed")
        return "test phrase"

    monkeypatch.setattr(common_router, "get_stt_engine", lambda: SimpleNamespace(transcribe=transcribe))
    for scope in ("interviewer", "candidate"):
        for _ in range(factory.CIRCUIT_THRESHOLD):
            factory._circuit_record_failure(scope=scope, is_auth=True)

    result = asyncio.run(common_router.api_stt_test())
    assert result["ok"] is success
    assert factory._is_circuit_open("interviewer") is not success
    assert factory._is_circuit_open("candidate") is not success


def test_probe_for_old_settings_does_not_clear_new_provider_outage(monkeypatch, isolated_circuits):
    old_cfg = AppConfig(
        stt_provider="generic", generic_stt_api_base_url="http://localhost/v1", generic_stt_model="old",
    )
    new_cfg = AppConfig(
        stt_provider="generic", generic_stt_api_base_url="http://localhost/v1", generic_stt_model="new",
    )
    configs = iter([old_cfg, new_cfg])
    monkeypatch.setattr(common_router, "get_config", lambda: next(configs))
    monkeypatch.setattr(common_router.Path, "exists", lambda _path: False)
    monkeypatch.setattr(common_router, "get_stt_engine", lambda: SimpleNamespace(transcribe=lambda *_args, **_kwargs: "ok"))
    for _ in range(factory.CIRCUIT_THRESHOLD):
        factory._circuit_record_failure(is_auth=True)

    result = asyncio.run(common_router.api_stt_test())
    assert result["ok"] is True
    assert factory._is_circuit_open()
