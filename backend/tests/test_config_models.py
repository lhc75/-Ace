from __future__ import annotations

from pathlib import Path
import sys

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from api.common.config_payload import build_config_payload  # noqa: E402
from core.config import AppConfig, ModelConfig  # noqa: E402


def test_active_model_falls_back_to_first_enabled_model():
    cfg = AppConfig(
        models=[
            ModelConfig(name="disabled", enabled=False),
            ModelConfig(name="enabled", enabled=True),
        ],
        active_model=0,
    )

    assert cfg.active_model == 1
    assert cfg.get_active_model().name == "enabled"


def test_active_model_keeps_clamped_index_when_all_models_are_disabled():
    cfg = AppConfig(
        models=[
            ModelConfig(name="disabled-a", enabled=False),
            ModelConfig(name="disabled-b", enabled=False),
        ],
        active_model=5,
    )

    assert cfg.active_model == 1


def test_candidate_remote_stt_requires_explicit_cost_opt_in():
    cfg = AppConfig(
        candidate_stt_provider="doubao",
        candidate_remote_stt_enabled=False,
    )

    assert cfg.candidate_stt_provider == "whisper"


def test_candidate_mic_asr_defaults_to_opt_in():
    cfg = AppConfig()

    assert cfg.candidate_asr_enabled is False


def test_remote_stt_defaults_to_whisper_preload_with_manual_opt_out():
    cfg = AppConfig(stt_provider="doubao")
    assert cfg.whisper_preload is True

    disabled = AppConfig(stt_provider="doubao", whisper_preload=False)
    assert disabled.whisper_preload is False


def test_candidate_remote_stt_can_be_enabled_explicitly():
    cfg = AppConfig(
        candidate_stt_provider="generic",
        candidate_remote_stt_enabled=True,
    )

    assert cfg.candidate_stt_provider == "generic"


def test_think_effort_accepts_xhigh():
    cfg = AppConfig(think_mode=True, think_effort="xhigh")

    assert cfg.think_mode is True
    assert cfg.think_effort == "xhigh"


def test_think_effort_accepts_full_universal_range():
    for effort in ("minimal", "max", "ultra"):
        cfg = AppConfig(think_mode=True, think_effort=effort)
        assert cfg.think_effort == effort


def test_generation_params_are_normalized_for_runtime_safety():
    cfg = AppConfig(temperature=float("nan"), max_tokens=999999)

    assert cfg.temperature == 0.5
    assert cfg.max_tokens == 32768

    cfg = AppConfig(temperature=-3, max_tokens=8)

    assert cfg.temperature == 0.0
    assert cfg.max_tokens == 256


def test_model_web_search_defaults_are_opt_in():
    cfg = AppConfig()

    assert cfg.models[0].web_search_enabled is False
    assert cfg.models[0].web_search_api_base_url == "https://api.deepseek.com"
    assert cfg.models[0].web_search_api_key == ""


def test_invalid_generation_param_strings_fall_back_to_defaults():
    cfg = AppConfig(temperature="not-a-number", max_tokens="not-a-number")

    assert cfg.temperature == 0.5
    assert cfg.max_tokens == 4096


def test_assist_stop_answer_wait_default_is_preserved():
    cfg = AppConfig()

    assert cfg.assist_stop_answer_wait_sec == 3.0


def test_assist_stop_answer_wait_can_be_disabled_explicitly():
    cfg = AppConfig(assist_stop_answer_wait_sec=0)

    assert cfg.assist_stop_answer_wait_sec == 0.0


def test_config_payload_includes_realtime_voice_runtime_knobs():
    cfg = AppConfig(
        assist_realtime_max_tokens=800,
        assist_realtime_high_churn_max_tokens=360,
        assist_stop_answer_wait_sec=2.5,
        assist_interviewer_asr_drain_timeout_sec=8.0,
    )

    payload = build_config_payload(cfg)

    assert payload["assist_realtime_max_tokens"] == 800
    assert payload["assist_realtime_high_churn_max_tokens"] == 360
    assert payload["assist_stop_answer_wait_sec"] == 2.5
    assert payload["assist_interviewer_asr_drain_timeout_sec"] == 8.0


def test_config_payload_model_health_fingerprint_changes_with_credentials():
    cfg = AppConfig()
    cfg.models[0].api_key = "sk-first"
    first = build_config_payload(cfg)["models"][0]["health_fingerprint"]

    cfg.models[0].api_key = "sk-second"
    second = build_config_payload(cfg)["models"][0]["health_fingerprint"]

    assert first
    assert second
    assert first != second
    assert "sk-first" not in first
    assert "sk-second" not in second


def test_config_payload_includes_model_search_state_without_exposing_key():
    cfg = AppConfig(
        models=[
            ModelConfig(
                name="search-model",
                web_search_enabled=True,
                web_search_api_key="search-secret",
            )
        ]
    )

    payload = build_config_payload(cfg)
    model_payload = payload["models"][0]

    assert model_payload["web_search_enabled"] is True
    assert model_payload["has_web_search_key"] is True
    assert "search-secret" not in str(payload)
    assert "web_search_api_key" not in model_payload


def test_stream_asr_window_defaults_and_clamps():
    cfg = AppConfig()
    assert cfg.assist_stream_asr_confirm_window_sec == 0.4
    assert cfg.assist_stream_asr_fast_confirm_sec == 0.8
    assert cfg.assist_stream_asr_candidate_wait_sec == 1.5
    assert cfg.assist_stream_asr_dispatch_grace_sec == 0.5

    clamped = AppConfig(
        assist_stream_asr_confirm_window_sec=99,
        assist_stream_asr_fast_confirm_sec=0,
        assist_stream_asr_candidate_wait_sec=99,
        assist_stream_asr_dispatch_grace_sec=-1,
    )
    assert clamped.assist_stream_asr_confirm_window_sec == 2.0
    assert clamped.assist_stream_asr_fast_confirm_sec == 0.1
    assert clamped.assist_stream_asr_candidate_wait_sec == 5.0
    assert clamped.assist_stream_asr_dispatch_grace_sec == 0.0


def test_aliyun_sentence_silence_and_web_search_budget_defaults_and_clamps():
    cfg = AppConfig()
    assert cfg.aliyun_stt_max_sentence_silence_ms == 600
    assert cfg.assist_web_search_timeout_sec == 2.5
    assert cfg.generic_stt_streaming_interval_ms == 1200

    clamped = AppConfig(
        aliyun_stt_max_sentence_silence_ms=50,
        assist_web_search_timeout_sec=99,
    )
    assert clamped.aliyun_stt_max_sentence_silence_ms == 200
    assert clamped.assist_web_search_timeout_sec == 30.0

    disabled = AppConfig(aliyun_stt_max_sentence_silence_ms=0)
    assert disabled.aliyun_stt_max_sentence_silence_ms == 0
