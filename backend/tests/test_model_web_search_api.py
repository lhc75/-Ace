from __future__ import annotations

import asyncio
import importlib
from pathlib import Path
import sys

from fastapi import HTTPException
import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import config as config_module  # noqa: E402
from core.config import AppConfig, ModelConfig  # noqa: E402
from services.web_search import WebSearchBundle, WebSearchSource  # noqa: E402

common_router = importlib.import_module("api.common.router")


def _model_body(
    name: str,
    *,
    model_key: str = common_router._MODEL_API_KEY_KEEP,
    search_key: str = common_router._MODEL_WEB_SEARCH_API_KEY_KEEP,
    original_index: int = 0,
    enabled_search: bool = True,
):
    return {
        "name": name,
        "api_base_url": "https://api.openai.com/v1",
        "api_key": model_key,
        "model": "gpt-4o-mini",
        "supports_think": False,
        "supports_vision": False,
        "enabled": True,
        "model_original_index": original_index,
        "web_search_enabled": enabled_search,
        "web_search_api_base_url": "https://api.deepseek.com",
        "web_search_api_key": search_key,
    }


def _configure(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, *models: ModelConfig):
    monkeypatch.setattr(config_module, "CONFIG_FILE", str(tmp_path / "config.json"))
    monkeypatch.setattr(config_module, "_config", AppConfig(models=list(models), active_model=0))
    monkeypatch.setattr(common_router, "build_config_payload", lambda _cfg: {"ok": True})


def test_models_full_redacts_per_model_search_key(monkeypatch: pytest.MonkeyPatch):
    cfg = AppConfig(
        models=[
            ModelConfig(
                name="model",
                api_key="model-key",
                web_search_enabled=True,
                web_search_api_base_url="https://api.deepseek.com",
                web_search_api_key="search-secret",
            )
        ]
    )
    monkeypatch.setattr(common_router, "get_config", lambda: cfg)

    result = asyncio.run(common_router.api_get_models_full())
    item = result["models"][0]

    assert item["web_search_enabled"] is True
    assert item["web_search_api_base_url"] == "https://api.deepseek.com"
    assert item["web_search_api_key"] == ""
    assert item["has_web_search_key"] is True
    assert "search-secret" not in str(result)


def test_update_config_keeps_search_key_after_reorder(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    _configure(
        monkeypatch,
        tmp_path,
        ModelConfig(name="first", api_key="model-a", web_search_enabled=True, web_search_api_key="search-a"),
        ModelConfig(name="second", api_key="model-b", web_search_enabled=True, web_search_api_key="search-b"),
    )

    body = common_router.ConfigUpdate(
        models=[
            _model_body("second", original_index=1),
            _model_body("first", original_index=0),
        ]
    )
    result = asyncio.run(common_router.api_update_config(body))

    updated = config_module.get_config()
    assert result == {"ok": True}
    assert [model.name for model in updated.models] == ["second", "first"]
    assert [model.api_key for model in updated.models] == ["model-b", "model-a"]
    assert [model.web_search_api_key for model in updated.models] == ["search-b", "search-a"]


def test_enabled_search_requires_a_search_key(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    _configure(
        monkeypatch,
        tmp_path,
        ModelConfig(name="main", api_key="model-key", web_search_enabled=False),
    )
    body = common_router.ConfigUpdate(
        models=[
            _model_body(
                "main",
                search_key="",
                enabled_search=True,
            )
        ]
    )

    with pytest.raises(HTTPException) as exc:
        asyncio.run(common_router.api_update_config(body))

    assert exc.value.status_code == 422
    assert "Search API Key" in exc.value.detail


def test_web_search_test_endpoint_uses_saved_key_and_returns_safe_preview(
    monkeypatch: pytest.MonkeyPatch,
):
    cfg = AppConfig(
        models=[
            ModelConfig(
                name="main",
                api_key="model-key",
                web_search_enabled=True,
                web_search_api_key="saved-search-key",
            )
        ]
    )
    captured: dict[str, str] = {}
    monkeypatch.setattr(common_router, "get_config", lambda: cfg)

    def fake_test(api_base_url: str, api_key: str):
        captured["base"] = api_base_url
        captured["key"] = api_key
        return WebSearchBundle(
            query="DeepSeek API",
            sources=(
                WebSearchSource(
                    rank=1,
                    title="DeepSeek API Docs",
                    url="https://api-docs.deepseek.com/",
                    snippet="Official docs",
                ),
            ),
            ok=True,
            latency_ms=42,
        )

    monkeypatch.setattr(common_router, "test_search_connection", fake_test)
    result = asyncio.run(
        common_router.api_test_model_web_search(
            common_router.WebSearchTestRequest(
                api_base_url="https://api.deepseek.com",
                api_key=common_router._MODEL_WEB_SEARCH_API_KEY_KEEP,
                model_index=0,
            )
        )
    )

    assert captured == {
        "base": "https://api.deepseek.com",
        "key": "saved-search-key",
    }
    assert result["ok"] is True
    assert result["count"] == 1
    assert result["results"][0]["title"] == "DeepSeek API Docs"
    assert "saved-search-key" not in str(result)
