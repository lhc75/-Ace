"""STT engine factory: singleton management, provider selection, and resilience."""

import time
import threading
from typing import Optional

import numpy as np

from core.logger import get_logger
from core.config import REMOTE_STT_PROVIDERS
from .aliyun import AliyunSTT, AliyunSTTAuthError
from .engines import (
    STTEngine,
    DoubaoSTT,
    GenericHTTPSTT,
    RemoteSTTEmptyResultError,
)

_log = get_logger("stt.factory")

_engine: Optional[STTEngine] = None
_whisper_engines: dict[tuple[str, str], STTEngine] = {}
_doubao_engine: Optional[DoubaoSTT] = None
_generic_engine: Optional[GenericHTTPSTT] = None
_aliyun_engine: Optional[AliyunSTT] = None
_engine_lock = threading.Lock()
_whisper_infer_lock = threading.Lock()
REMOTE_EMPTY_RETRY_PAD_MS = 240
REMOTE_EMPTY_RETRY_MAX_AUDIO_SEC = 6.0
# A short normal response with no text can be caused by VAD boundaries or
# endpointing. It should not accumulate toward a 60-second remote outage.
REMOTE_EMPTY_CIRCUIT_MIN_AUDIO_SEC = 8.0

# ---------------------------------------------------------------------------
# Circuit breaker for remote STT engines
# ---------------------------------------------------------------------------

_circuit_lock = threading.Lock()
_circuit_failures = 0
_circuit_open_until = 0.0
_circuit_failures_by_scope: dict[str, int] = {}
_circuit_open_until_by_scope: dict[str, float] = {}
CIRCUIT_THRESHOLD = 3
CIRCUIT_THRESHOLD_TIMEOUT = 5
CIRCUIT_COOLDOWN_SEC = 60.0
CIRCUIT_COOLDOWN_AUTH_SEC = 3600.0

_TIMEOUT_EXCEPTIONS = (TimeoutError,)
try:
    import websocket as _ws_mod
    _WS_TIMEOUT_EXC = getattr(_ws_mod, "WebSocketTimeoutException", None)
    if _WS_TIMEOUT_EXC:
        _TIMEOUT_EXCEPTIONS = (TimeoutError, _WS_TIMEOUT_EXC)
except ImportError:
    pass


def _is_timeout_error(err: Exception) -> bool:
    if isinstance(err, _TIMEOUT_EXCEPTIONS):
        return True
    msg = str(err).lower()
    return "timeout" in msg or "timed out" in msg


def _is_auth_error(err: Exception) -> bool:
    if isinstance(err, AliyunSTTAuthError):
        return True
    msg = str(err).lower()
    return "401" in msg or "403" in msg or "unauthorized" in msg or "forbidden" in msg or "grant not found" in msg


def _is_empty_remote_result_error(err: Exception) -> bool:
    return isinstance(err, RemoteSTTEmptyResultError)


def _circuit_record_failure(is_timeout: bool = False, is_auth: bool = False, scope: str = "interviewer"):
    global _circuit_failures, _circuit_open_until
    circuit_scope = (scope or "interviewer").strip() or "interviewer"
    threshold = CIRCUIT_THRESHOLD_TIMEOUT if is_timeout else CIRCUIT_THRESHOLD
    with _circuit_lock:
        failures = _circuit_failures_by_scope.get(circuit_scope, 0) + 1
        _circuit_failures_by_scope[circuit_scope] = failures
        if circuit_scope == "interviewer":
            _circuit_failures = failures
        if failures >= threshold:
            cooldown = CIRCUIT_COOLDOWN_AUTH_SEC if is_auth else CIRCUIT_COOLDOWN_SEC
            open_until = time.monotonic() + cooldown
            _circuit_open_until_by_scope[circuit_scope] = open_until
            if circuit_scope == "interviewer":
                _circuit_open_until = open_until
            _log.warning(
                "STT circuit OPEN scope=%s after %d failures (timeout=%s auth=%s), fallback for %.0fs",
                circuit_scope, failures, is_timeout, is_auth, cooldown,
            )


def _circuit_reset(scope: str = "interviewer"):
    global _circuit_failures, _circuit_open_until
    circuit_scope = (scope or "interviewer").strip() or "interviewer"
    with _circuit_lock:
        if _circuit_failures_by_scope.get(circuit_scope, 0) > 0:
            _circuit_failures_by_scope[circuit_scope] = 0
            _circuit_open_until_by_scope[circuit_scope] = 0.0
        if circuit_scope == "interviewer" and _circuit_failures > 0:
            _circuit_failures = 0
            _circuit_open_until = 0.0


def _is_circuit_open(scope: str = "interviewer") -> bool:
    global _circuit_failures, _circuit_open_until
    circuit_scope = (scope or "interviewer").strip() or "interviewer"
    with _circuit_lock:
        failures = _circuit_failures_by_scope.get(circuit_scope, _circuit_failures if circuit_scope == "interviewer" else 0)
        open_until = _circuit_open_until_by_scope.get(
            circuit_scope,
            _circuit_open_until if circuit_scope == "interviewer" else 0.0,
        )
        if failures < CIRCUIT_THRESHOLD:
            return False
        if time.monotonic() >= open_until:
            if open_until > 0.0:
                # Begin a fresh failure window after cooldown, so one failed
                # recovery attempt cannot immediately reopen the circuit.
                _circuit_failures_by_scope[circuit_scope] = 0
                _circuit_open_until_by_scope[circuit_scope] = 0.0
                if circuit_scope == "interviewer":
                    _circuit_failures = 0
                    _circuit_open_until = 0.0
            return False
        return True


def _call_circuit_open(scope: str) -> bool:
    try:
        return _is_circuit_open(scope)
    except TypeError:
        return _is_circuit_open()


def _call_circuit_reset(scope: str) -> None:
    try:
        _circuit_reset(scope)
    except TypeError:
        _circuit_reset()


def _call_circuit_record_failure(scope: str, *, is_timeout: bool, is_auth: bool) -> None:
    try:
        _circuit_record_failure(is_timeout=is_timeout, is_auth=is_auth, scope=scope)
    except TypeError:
        _circuit_record_failure(is_timeout=is_timeout, is_auth=is_auth)


# ---------------------------------------------------------------------------
# stt_error 广播节流：同一 scope 15 秒内最多一条，避免故障期间每段一条刷 toast
# ---------------------------------------------------------------------------

_stt_error_broadcast_lock = threading.Lock()
_stt_error_last_mono: dict[str, float] = {}
STT_ERROR_BROADCAST_MIN_INTERVAL_SEC = 15.0


def _broadcast_stt_error(scope: str, provider: str, reason: str) -> None:
    with _stt_error_broadcast_lock:
        now = time.monotonic()
        if now - _stt_error_last_mono.get(scope, 0.0) < STT_ERROR_BROADCAST_MIN_INTERVAL_SEC:
            return
        _stt_error_last_mono[scope] = now
    from api.realtime.ws import broadcast
    broadcast({"type": "stt_error", "scope": scope, "provider": provider, "reason": reason})


def _pad_audio_tail_silence(
    audio: np.ndarray,
    sample_rate: int,
    *,
    pad_ms: int,
) -> np.ndarray:
    if sample_rate <= 0 or len(audio) <= 0 or pad_ms <= 0:
        return audio
    pad_samples = int(round(sample_rate * (pad_ms / 1000.0)))
    if pad_samples <= 0:
        return audio
    return np.concatenate([audio, np.zeros(pad_samples, dtype=audio.dtype)])


# ---------------------------------------------------------------------------
# Whisper fallback (lazy init)
# ---------------------------------------------------------------------------

def _get_whisper_fallback() -> STTEngine:
    global _engine, _whisper_preload_done
    from core.config import get_config
    cfg = get_config()
    size = cfg.whisper_model or "base"
    lang = cfg.whisper_language or "auto"
    engine = get_stt_engine(provider="whisper", model_size=size, language=lang)
    if not engine.is_loaded:
        _log.info("Whisper fallback: loading model %s", engine.model_size)
        # Loading can take seconds; do not hold the global engine lock while
        # faster-whisper initializes, or /ws init and start/resume can block.
        engine.load_model()
    if engine.is_loaded:
        _whisper_preload_done = True
    return engine


_whisper_preload_done = False


def _remove_whisper_engine_aliases_locked(
    engine: STTEngine,
    *,
    keep_key: Optional[tuple[str, str]] = None,
) -> None:
    for cached_key, cached_engine in list(_whisper_engines.items()):
        if cached_engine is engine and cached_key != keep_key:
            _whisper_engines.pop(cached_key, None)


def _is_whisper_preloaded() -> bool:
    global _whisper_preload_done
    if _whisper_preload_done:
        return True
    with _engine_lock:
        if _engine is not None and _engine.is_loaded:
            _whisper_preload_done = True
            return True
    return False


def preload_whisper_fallback() -> None:
    """Pre-load whisper model in background so fallback is instant when needed."""
    from core.config import get_config
    cfg = get_config()
    if not cfg.whisper_preload:
        _log.info("Whisper preload disabled by config")
        return
    if cfg.stt_provider in REMOTE_STT_PROVIDERS:
        def _load():
            from api.realtime.ws import broadcast
            broadcast({"type": "stt_status", "loaded": False, "loading": True, "provider": "whisper-preload"})
            try:
                _get_whisper_fallback()
                _log.info("Whisper fallback model pre-loaded")
                broadcast({"type": "stt_status", "loaded": True, "loading": False, "provider": "whisper-preload"})
            except Exception as e:
                _log.warning("Whisper fallback pre-load failed: %s", e)
                broadcast({"type": "stt_status", "loaded": False, "loading": False, "provider": "whisper-preload", "error": str(e)})
        t = threading.Thread(target=_load, daemon=True, name="whisper-preload")
        t.start()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def set_whisper_language(language: str) -> None:
    global _engine
    lang = (language or "auto").strip() or "auto"
    with _engine_lock:
        if _engine is not None:
            _remove_whisper_engine_aliases_locked(_engine)
            _engine.language = lang
            _whisper_engines[(getattr(_engine, "model_size", "base") or "base", lang)] = _engine


def reset_stt_circuit(scope: str) -> None:
    """Allow corrected provider settings to recover without waiting for cooldown."""
    _circuit_reset(scope)


def get_stt_engine(
    provider: Optional[str] = None,
    model_size: Optional[str] = None,
    language: Optional[str] = None,
):
    """Return the configured local or remote STT engine."""
    from core.config import get_config
    cfg = get_config()
    effective_provider = provider or cfg.stt_provider
    if effective_provider == "iflytek":
        raise RuntimeError("讯飞 STT 已下线，请在设置中改为通用 ASR 或 Whisper")
    if effective_provider == "aliyun":
        global _aliyun_engine
        api_key = cfg.aliyun_stt_api_key.strip()
        with _engine_lock:
            if _aliyun_engine is None or (
                _aliyun_engine.api_key != api_key
                or _aliyun_engine.model != cfg.aliyun_stt_model
            ):
                _aliyun_engine = AliyunSTT(api_key=api_key, model=cfg.aliyun_stt_model)
            return _aliyun_engine
    if effective_provider == "doubao":
        global _doubao_engine
        access_token = cfg.doubao_stt_access_token or ""
        api_key = getattr(cfg, "doubao_stt_api_key", "") or ""
        with _engine_lock:
            if _doubao_engine is None or (
                _doubao_engine.app_id != cfg.doubao_stt_app_id
                or _doubao_engine.access_token != access_token
                or _doubao_engine.api_key != api_key
                or _doubao_engine.resource_id != cfg.doubao_stt_resource_id
                or _doubao_engine.boosting_table_id != (cfg.doubao_stt_boosting_table_id or "")
            ):
                _doubao_engine = DoubaoSTT(
                    app_id=cfg.doubao_stt_app_id,
                    access_token=access_token,
                    api_key=api_key,
                    resource_id=cfg.doubao_stt_resource_id or "volc.seedasr.sauc.duration",
                    boosting_table_id=cfg.doubao_stt_boosting_table_id or "",
                )
            return _doubao_engine
    if effective_provider == "generic":
        global _generic_engine
        api_key = cfg.generic_stt_api_key or ""
        with _engine_lock:
            if _generic_engine is None or (
                _generic_engine.api_base_url != (cfg.generic_stt_api_base_url or "").rstrip("/")
                or _generic_engine.api_key != api_key
                or _generic_engine.model != (cfg.generic_stt_model or "")
                or _generic_engine.custom_headers != getattr(cfg, "generic_stt_custom_headers", "")
            ):
                _generic_engine = GenericHTTPSTT(
                    api_base_url=cfg.generic_stt_api_base_url,
                    api_key=api_key,
                    model=cfg.generic_stt_model,
                    custom_headers=getattr(cfg, "generic_stt_custom_headers", ""),
                )
            return _generic_engine
    if effective_provider != "whisper":
        raise RuntimeError(f"未知 STT provider: {effective_provider}")
    global _engine
    size = model_size if model_size is not None else cfg.whisper_model
    lang = language if language is not None else cfg.whisper_language
    key = (size or "base", lang or "auto")
    with _engine_lock:
        default_key = (cfg.whisper_model or "base", cfg.whisper_language or "auto")
        if _engine is None and key == default_key:
            _whisper_engines.pop(key, None)
        engine = _whisper_engines.get(key)
        if engine is not None and (
            getattr(engine, "model_size", None) != key[0]
            or getattr(engine, "language", None) != key[1]
        ):
            _whisper_engines.pop(key, None)
            engine = None
        if engine is None:
            if (
                _engine is not None
                and getattr(_engine, "model_size", None) == key[0]
                and getattr(_engine, "language", None) == key[1]
            ):
                engine = _engine
            else:
                engine = STTEngine(model_size=key[0], language=key[1])
            _whisper_engines[key] = engine
        _remove_whisper_engine_aliases_locked(engine, keep_key=key)
        if _engine is None or key == default_key:
            _engine = engine
        return engine


def transcribe_with_fallback(
    audio: np.ndarray,
    sample_rate: int,
    position: str = "",
    language: str = "",
    *,
    provider: Optional[str] = None,
    whisper_model: Optional[str] = None,
    whisper_language: Optional[str] = None,
    allow_remote: bool = True,
    status_event_type: str = "stt_status",
    scope: str = "interviewer",
    whisper_lock_timeout_sec: Optional[float] = None,
    whisper_require_loaded: bool = False,
) -> str:
    """Resilient transcription **in the selected mode**: retry once, circuit breaker.

    绝不切换引擎：远程引擎失败时只重试/熔断限流并广播 stt_error，
    返回空文本（该段丢弃），下一段继续用所选引擎。没有 Whisper 降级。

    Flow:
      1. If circuit breaker is open and provider != whisper → fast-fail with
         an stt_error broadcast (no whisper switch).
      2. Try primary engine (up to 2 attempts with 0.3s gap).
      3. On failure → record circuit failure → stt_error broadcast → "".
    """
    from core.config import get_config
    from api.realtime.ws import broadcast

    cfg = get_config()
    selected_provider = provider or cfg.stt_provider
    if selected_provider in REMOTE_STT_PROVIDERS and not allow_remote:
        selected_provider = "whisper"
    is_remote = selected_provider in REMOTE_STT_PROVIDERS
    audio_sec = len(audio) / sample_rate if sample_rate and len(audio) else 0.0
    circuit_scope = (scope or "interviewer").strip() or "interviewer"

    if is_remote and _call_circuit_open(circuit_scope):
        _log.info("STT circuit open, fast-fail without switching provider scope=%s", circuit_scope)
        _broadcast_stt_error(circuit_scope, selected_provider, "circuit_open")
        return ""

    try:
        primary = get_stt_engine(
            provider=selected_provider,
            model_size=whisper_model,
            language=whisper_language,
        )
    except TypeError:
        # Backward compatibility for tests or plugins monkeypatching the old
        # two-argument factory signature.
        primary = get_stt_engine(
            model_size=whisper_model,
            language=whisper_language,
        )
    last_err: Optional[Exception] = None

    is_timeout_err = False
    is_auth_err = False
    max_attempts = 2 if is_remote else 1
    for attempt in range(max_attempts):
        try:
            if selected_provider == "whisper":
                if not primary.is_loaded:
                    if whisper_require_loaded:
                        _log.debug(
                            "Whisper skip scope=%s reason=model_not_loaded model=%s",
                            circuit_scope,
                            getattr(primary, "model_size", ""),
                        )
                        return ""
                    primary.load_model()
                acquired = False
                try:
                    if whisper_lock_timeout_sec is None:
                        _whisper_infer_lock.acquire()
                        acquired = True
                    else:
                        acquired = _whisper_infer_lock.acquire(timeout=max(0.0, whisper_lock_timeout_sec))
                    if not acquired:
                        _log.debug(
                            "Whisper skip scope=%s reason=infer_lock_busy model=%s audio=%.1fs",
                            circuit_scope,
                            getattr(primary, "model_size", ""),
                            audio_sec,
                        )
                        return ""
                    text = primary.transcribe(audio, sample_rate, position=position, language=language)
                finally:
                    if acquired:
                        _whisper_infer_lock.release()
            else:
                text = primary.transcribe(audio, sample_rate, position=position, language=language)
            if is_remote and not (text or "").strip():
                raise RemoteSTTEmptyResultError(
                    f"{selected_provider} 返回空文本（音频 {audio_sec:.1f}s）"
                )
            if is_remote:
                _call_circuit_reset(circuit_scope)
                broadcast({"type": status_event_type, "loaded": bool(primary.is_loaded), "loading": False, "provider": selected_provider})
            return text
        except Exception as e:
            last_err = e
            is_timeout_err = _is_timeout_error(e)
            is_auth_err = _is_auth_error(e)
            if is_remote and _is_empty_remote_result_error(e):
                _log.warning(
                    "STT %s returned empty text scope=%s raw=%.1fs reason=%s",
                    selected_provider,
                    circuit_scope,
                    audio_sec,
                    e,
                )
                if (
                    circuit_scope == "interviewer"
                    and audio_sec > 0.0
                    and audio_sec <= REMOTE_EMPTY_RETRY_MAX_AUDIO_SEC
                ):
                    try:
                        retry_audio = _pad_audio_tail_silence(
                            audio,
                            sample_rate,
                            pad_ms=REMOTE_EMPTY_RETRY_PAD_MS,
                        )
                        retry_audio_sec = len(retry_audio) / sample_rate if sample_rate else audio_sec
                        _log.info(
                            "STT %s retrying empty interviewer segment with tail pad raw=%.1fs padded=%.1fs",
                            selected_provider,
                            audio_sec,
                            retry_audio_sec,
                        )
                        retry_text = primary.transcribe(
                            retry_audio,
                            sample_rate,
                            position=position,
                            language=language,
                        )
                        if (retry_text or "").strip():
                            _call_circuit_reset(circuit_scope)
                            broadcast({
                                "type": status_event_type,
                                "loaded": bool(primary.is_loaded),
                                "loading": False,
                                "provider": selected_provider,
                            })
                            return retry_text
                    except Exception as retry_err:
                        last_err = retry_err
                        is_timeout_err = _is_timeout_error(retry_err)
                        is_auth_err = _is_auth_error(retry_err)
                        _log.warning(
                            "STT %s empty-text retry failed scope=%s: %s",
                            selected_provider,
                            circuit_scope,
                            retry_err,
                        )
                if _is_empty_remote_result_error(last_err):
                    # A completed, short response proves that the remote
                    # transport is alive. Do not let it extend a prior outage.
                    if audio_sec < REMOTE_EMPTY_CIRCUIT_MIN_AUDIO_SEC:
                        _call_circuit_reset(circuit_scope)
                    if audio_sec < 5.0:
                        _log.info(
                            "STT %s returned empty text for short audio %.1fs; drop segment",
                            selected_provider,
                            audio_sec,
                        )
                        return ""
                break
            if attempt == 0 and is_remote:
                if is_timeout_err or is_auth_err:
                    _log.warning("STT %s attempt 1 %s, skipping retry: %s", selected_provider,
                                 "auth error" if is_auth_err else "timeout", e)
                    break
                _log.warning("STT %s attempt 1 failed, retrying: %s", selected_provider, e)
                time.sleep(0.3)
            else:
                _log.error("STT %s attempt %d failed: %s", selected_provider, attempt + 1, e)

    should_record_circuit_failure = (
        is_remote
        and last_err is not None
        and (
            not _is_empty_remote_result_error(last_err)
            or audio_sec >= REMOTE_EMPTY_CIRCUIT_MIN_AUDIO_SEC
        )
    )
    if should_record_circuit_failure:
        _call_circuit_record_failure(circuit_scope, is_timeout=is_timeout_err, is_auth=is_auth_err)

    if is_remote:
        _log.warning("STT %s failed, keeping selected provider (err=%s)", selected_provider, last_err)
        _broadcast_stt_error(circuit_scope, selected_provider, str(last_err)[:120])

    return ""
