from pydantic import BaseModel, Field, field_validator, model_validator
from typing import Literal, Optional, Any
import hashlib
import hmac
import json
import math
import os
import secrets

import shutil
import threading

from core.logger import get_logger

logger = get_logger(__name__)

DEFAULT_TEMPERATURE = 0.5

# 配置里表示"未填"的占位 key, 以及前端"保持已保存 key 不变"的哨兵
# (哨兵在保存配置时已解析成真实 key, 这里再排除一层只是防御)。
PLACEHOLDER_API_KEY = "sk-your-api-key-here"
KEEP_EXISTING_API_KEY = "__IA_KEEP_EXISTING_API_KEY__"


def has_valid_api_key(api_key) -> bool:
    # 有效 API key = 非空且不是占位符/保持哨兵
    return bool(api_key) and api_key not in ("", PLACEHOLDER_API_KEY, KEEP_EXISTING_API_KEY)
DEFAULT_MAX_TOKENS = 4096
DEFAULT_WEB_SEARCH_BASE_URL = "https://api.deepseek.com"
THINK_EFFORT_OPTIONS = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
]
ALIYUN_STT_MODEL_OPTIONS = [
    "qwen-audio-3.1-asr-flash-streaming",
    "qwen-audio-3.0-asr-flash-streaming",
]
REMOTE_STT_PROVIDERS = frozenset({"doubao", "generic", "aliyun"})
_MODEL_HEALTH_FINGERPRINT_KEY = secrets.token_bytes(32)


def _finite_number(value: Any, fallback: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(parsed):
        return fallback
    return parsed


def normalize_llm_temperature(value: Any) -> float:
    parsed = _finite_number(value, DEFAULT_TEMPERATURE)
    return max(0.0, min(2.0, parsed))


def normalize_llm_max_tokens(value: Any) -> int:
    parsed = _finite_number(value, DEFAULT_MAX_TOKENS)
    return max(256, min(32768, int(parsed)))

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_FILE = os.environ.get("IA_CONFIG_PATH") or os.path.join(_BACKEND_DIR, "config.json")
CONFIG_EXAMPLE = os.environ.get("IA_CONFIG_EXAMPLE_PATH") or os.path.join(
    _BACKEND_DIR, "config.example.json"
)


class ModelConfig(BaseModel):
    name: str = "Default"
    api_base_url: str = "https://api.openai.com/v1"
    api_key: str = ""
    model: str = "gpt-4o-mini"
    supports_think: bool = False
    supports_vision: bool = False
    enabled: bool = True
    think_enabled_params: dict[str, Any] = Field(default_factory=dict)
    think_disabled_params: dict[str, Any] = Field(default_factory=dict)
    web_search_enabled: bool = False
    web_search_api_base_url: str = DEFAULT_WEB_SEARCH_BASE_URL
    web_search_api_key: str = ""


def model_health_fingerprint(model: Any) -> str:
    """Return a process-local opaque identity for health-check ownership.

    The API key participates so changing credentials invalidates an old
    health result, but the key itself (and a reusable unsalted hash of it) is
    never exposed to the frontend.
    """

    fields = (
        str(getattr(model, "name", "") or "").strip(),
        str(getattr(model, "api_base_url", "") or "").strip().rstrip("/"),
        str(getattr(model, "model", "") or "").strip(),
        str(getattr(model, "api_key", "") or ""),
    )
    payload = "\x1f".join(fields).encode("utf-8", errors="surrogatepass")
    return hmac.new(
        _MODEL_HEALTH_FINGERPRINT_KEY,
        payload,
        hashlib.sha256,
    ).hexdigest()[:24]


def _default_model_config() -> ModelConfig:
    return ModelConfig(
        name="请在 config.json 中配置",
        api_base_url="https://api.openai.com/v1",
        api_key="",
        model="gpt-4o-mini",
    )


class AppConfig(BaseModel):
    models: list[ModelConfig] = Field(default_factory=lambda: [_default_model_config()])
    active_model: int = 0

    temperature: float = 0.5
    max_tokens: int = 4096
    think_mode: bool = False
    # 通用推理强度；具体模型不支持某个档位时会按供应商协议归一化或退化为仅开关。
    think_effort: Literal[
        "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"
    ] = "off"

    # STT providers: local Whisper, Doubao, generic HTTP, and Aliyun Qwen.
    stt_provider: str = "whisper"
    whisper_model: str = "base"
    # "auto" is more robust for Chinese interview speech mixed with English terms.
    whisper_language: str = "auto"
    # 启动时预加载 whisper 降级模型（远程 ASR 为主引擎时，~300MB 内存换更快降级）
    whisper_preload: bool = True
    # 仅用于一次性升级旧版远程 ASR 配置；用户之后仍可在设置中关闭预加载。
    whisper_preload_migrated: bool = False
    # 豆包语音识别 API（当 stt_provider=doubao 时使用），使用小时版 + WebSocket 双流式
    doubao_stt_app_id: str = ""
    doubao_stt_access_token: str = ""
    # 新版控制台 API Key（优先于 app_id + access_token）
    doubao_stt_api_key: str = ""
    # 资源 ID：豆包流式语音识别模型2.0 小时版
    doubao_stt_resource_id: str = "volc.seedasr.sauc.duration"
    # 热词表 ID：在自学习平台上传热词文件后获得；有则传入请求，没有则不传
    doubao_stt_boosting_table_id: str = ""
    aliyun_stt_api_key: str = ""
    aliyun_stt_model: str = "qwen-audio-3.1-asr-flash-streaming"
    # 千问流式服务端 VAD 断句静音阈值（毫秒）：越小 sentence_end 定稿来得越早，
    # 答题触发更快；过小会在句中停顿处把一个问题拆成两个。官方默认 800。
    aliyun_stt_max_sentence_silence_ms: int = 600
    # 通用 ASR（OpenAI-compatible multipart: POST /audio/transcriptions）
    generic_stt_api_base_url: str = ""
    generic_stt_api_key: str = ""
    generic_stt_model: str = ""
    # 自定义 HTTP header，JSON 格式如 {"X-Custom":"value"} 或每行 Key: Value
    generic_stt_custom_headers: str = ""
    # 实时辅助候选人麦克风 ASR：默认关闭；开启后默认本地 Whisper，避免额外远程识别成本。
    candidate_asr_enabled: bool = False
    candidate_stt_provider: str = "whisper"
    candidate_whisper_model: str = ""
    candidate_whisper_language: str = ""
    candidate_remote_stt_enabled: bool = False
    # 候选人真实回答上下文：下一轮问题可携带，追问时强优先，非追问时作为可忽略背景。
    candidate_context_enabled: bool = True
    candidate_context_wait_ms: int = 200
    candidate_context_max_chars: int = 900
    candidate_context_min_chars: int = 6
    candidate_streaming_asr_enabled: bool = True
    candidate_streaming_asr_interval_ms: int = 1500
    # 面试官实时流式转写（边说边出字）：provider=aliyun 时为常驻千问 duplex WebSocket；
    # provider=generic 时为周期性整体重转写当前语句出“进行中”行（伪流式，定稿仍走逐段）；
    # 其他引擎不生效，关闭则维持逐段识别。
    interviewer_streaming_asr_enabled: bool = False
    # 千问流式断线重连期间的待上行音频缓冲时长（秒）：音频先入缓冲再泵出，
    # 重连成功后按序追平，断线窗口内采集的音频不丢失。0 = 关闭回补（旧行为：窗口内丢弃）。
    assist_stream_reconnect_buffer_sec: float = 30.0
    # 千问流式服务端 VAD 模型（仅 3.1 系列）：空=服务端默认（far_field_meeting_16k 远场）；
    # 手机贴近麦克风等近场场景可设 near_meeting_16k。
    aliyun_stt_vad_model: str = ""
    # 通用 ASR 伪流式的重转写间隔（毫秒）：过密会增加请求量，过疏出字慢
    generic_stt_streaming_interval_ms: int = 1200
    # 只用于“我的麦克风”：始终共享读取；开启后冲突时会尝试更保守的采样与默认输入设备。
    candidate_mic_compatibility_mode: bool = True
    # 麦克风采集自动增益（默认关闭）：手机外放等远场低电平场景可开启，复用 loopback 路径同款 AGC。
    mic_agc_enabled: bool = False

    position: str = "后端开发"
    language: str = "Python"
    resume_text: Optional[str] = None
    # 当前生效的简历对应的历史记录 id（写入 config.json；简历正文仍不入库）
    resume_active_history_id: Optional[int] = None

    auto_detect: bool = True
    silence_threshold: float = 0.01
    # Lower default reduces turn latency after interviewer finishes speaking.
    silence_duration: float = 1.2
    # 同时生成答案的最大路数（受可用模型数限制）
    max_parallel_answers: int = 2
    # 答案区流式输出时，距底部小于该像素则自动滚到底（调小便于手动上滑回看）
    answer_autoscroll_bottom_px: int = 40
    # 转写广播/入历史/自动答题：去标点后的有效字符（中英数字）至少为该值；过滤「嗯」等
    transcription_min_sig_chars: int = 2
    # 实时辅助：多段 ASR 合并后再写入转写/触发自动答题。上一段结束后若超过该秒数仍无新段则送出；0=关闭合并（恢复每段立即发送）
    assist_transcription_merge_gap_sec: float = 2.0
    # 从第一段 ASR 起最长等待（秒），超时强制送出，避免对方长停顿导致永远不触发
    assist_transcription_merge_max_sec: float = 12.0
    # 主链路 VAD 单段最长语音（秒），避免面试官连续讲话被攒成超长音频导致远程 ASR 超时
    assist_vad_max_speech_sec: float = 18.0
    # 主链路 VAD 单段最短语音（秒）；短于该值的片段视为噪声/语气词丢弃，不送 STT。
    # 调小可减少短句被误丢（漏听），调大可减少噪声片段送 STT。原硬编码 0.5。
    assist_vad_min_speech_sec: float = 0.3
    # 实时辅助：问句候选组在最后一条有效追问后静默超过该秒数再确认提交
    assist_asr_confirm_window_sec: float = 0.45
    # 实时辅助：候选问句组从第一条有效追问开始的最长等待时间
    assist_asr_group_max_wait_sec: float = 1.2
    # 千问流式识别（interviewer_streaming_asr_enabled）专用短窗口：服务端 sentence_end
    # 已是完整句子边界，长等待冗余；仅流式定稿走这组值，其余引擎/逐段路径不受影响。
    assist_stream_asr_confirm_window_sec: float = 0.4
    assist_stream_asr_fast_confirm_sec: float = 0.8
    assist_stream_asr_candidate_wait_sec: float = 1.5
    assist_stream_asr_dispatch_grace_sec: float = 0.5
    # 流式模式的句间停顿容忍：最后一段语音静默满该秒数才派发，防止"句中停顿"把一题拆成两题。
    assist_stream_asr_silence_flush_sec: float = 1.2
    # 千问流式即时派发：sentence_end 定稿后立刻把该句作为问题提交答题模型，跳过静默门控与确认窗口
    # （面试官的问题视为一口气问完）。关闭则回到短窗口 + 静默门控行为。仅千问流式生效。
    assist_stream_asr_instant_dispatch: bool = True
    # 实时辅助：确认新问句组后是否中断仍在生成的旧 ASR 回答
    assist_asr_interrupt_running: bool = True
    # 实时辅助：高 churn 场景下自动切短答，优先跟住最新问题
    assist_high_churn_short_answer: bool = False
    # 实时语音问答默认输出 token 上限，避免首题展开过长拖慢后续题。
    assist_realtime_max_tokens: int = 720
    # 高 churn 短答模式的更严格 token 上限。
    assist_realtime_high_churn_max_tokens: int = 320
    # 实时语音（ASR 即时派发）问题的联网搜索时间预算（秒）：搜索在答题前同步执行，
    # 全局 6s 上限对“说完就想看到回答”的场景太长；仅在模型开启联网搜索时生效。
    assist_web_search_timeout_sec: float = 2.5
    # stop 时等待 answer worker 收尾的最长时间；压测 interviewer 转写链路时可设为 0。
    assist_stop_answer_wait_sec: float = 3.0
    # stop 时等待面试官 ASR segment worker 清空队列的最长时间；本地 Whisper 需要更宽裕。
    assist_interviewer_asr_drain_timeout_sec: float = 6.0
    # 电脑截图区域：full=全屏，left_half/right_half/top_half/bottom_half=对应半屏
    screen_capture_region: str = "left_half"
    # 截图送入识图模型前的最长边限制；0=不缩放。默认 1600 兼顾题面可读性与 token/带宽。
    screen_capture_max_long_edge: int = 1600
    # 多图截图判题：最后一次截图后等待多少秒再提交整批图片
    multi_screen_capture_idle_sec: float = 10.0
    # 笔试模式：截屏后选择题直接输出答案，编程题直接输出代码，不做分析
    written_exam_mode: bool = False
    # 笔试模式下是否开启 think（深度思考），默认关闭以加快响应
    written_exam_think: bool = False

    # --- Knowledge Base ---
    # 路径相对 backend/ 目录解析; 默认值与 .gitignore (backend/data/kb/) 对齐。
    kb_enabled: bool = False
    kb_dir: str = "data/kb"
    kb_db_path: str = "data/kb.sqlite"
    kb_cache_dir: str = "data/kb_cache"
    kb_top_k: int = 4
    kb_deadline_ms: int = 150
    kb_asr_deadline_ms: int = 80
    # BM25 对稀疏语料区分度低 (常返回很小的分数), MVP 只靠 top_k + 排序,
    # 将 min_score 设为 0 关闭阈值过滤; 上线后看热点 query 再调。
    kb_min_score: float = 0.0
    kb_chunk_max_chars: int = 800
    kb_prompt_excerpt_chars: int = 300
    kb_trigger_modes: list[str] = Field(
        default_factory=lambda: ["asr_realtime", "manual_text", "written_exam"]
    )
    kb_file_extensions: list[str] = Field(
        default_factory=lambda: [".md", ".txt", ".log", ".docx", ".pdf"]
    )
    kb_ocr_enabled: bool = False
    kb_vision_caption_enabled: bool = False
    kb_max_upload_bytes: int = 20 * 1024 * 1024
    kb_recent_hits_capacity: int = 50
    kb_asr_min_query_chars: int = 6
    # 同义词扩展: 命中常见缩写/ASR 变体 (mq↔消息队列, b加树↔b+树) 时自动补充同组 token
    kb_synonyms_enabled: bool = True
    # 单条 query 送入 FTS 的 token 上限 (去重后截断, 防长 ASR 句产生超长 MATCH 表达式)
    kb_max_query_tokens: int = 64
    # top_k 中同一文档最多占几条, 保证来源多样性; 不足时按排名补齐
    kb_per_doc_max_hits: int = 2

    # --- Review (面试复盘) ---
    review_enabled: bool = False
    review_model_index: int = 0

    @field_validator("aliyun_stt_model")
    @classmethod
    def _normalize_aliyun_model_field(cls, value: str) -> str:
        return value.strip()

    @field_validator("temperature", mode="before")
    @classmethod
    def _normalize_temperature_field(cls, value: Any) -> float:
        return normalize_llm_temperature(value)

    @field_validator("max_tokens", mode="before")
    @classmethod
    def _normalize_max_tokens_field(cls, value: Any) -> int:
        return normalize_llm_max_tokens(value)

    @model_validator(mode="after")
    def _ensure_valid_models(self):
        if self.stt_provider == "iflytek":
            logger.warning(
                "检测到已废弃的 stt_provider=iflytek；请在设置中改为 generic 或 whisper"
            )
        if self.candidate_stt_provider == "iflytek":
            logger.warning(
                "检测到已废弃的 candidate_stt_provider=iflytek；已重置为 whisper"
            )
            self.candidate_stt_provider = "whisper"
        if self.candidate_stt_provider not in STT_PROVIDER_OPTIONS:
            logger.warning(
                "candidate_stt_provider=%r 不支持，已重置为 whisper",
                self.candidate_stt_provider,
            )
            self.candidate_stt_provider = "whisper"
        if self.candidate_stt_provider in REMOTE_STT_PROVIDERS and not self.candidate_remote_stt_enabled:
            self.candidate_stt_provider = "whisper"
        self.temperature = normalize_llm_temperature(self.temperature)
        self.max_tokens = normalize_llm_max_tokens(self.max_tokens)
        self.candidate_context_wait_ms = max(0, min(2000, int(self.candidate_context_wait_ms or 0)))
        self.candidate_context_max_chars = max(100, min(4000, int(self.candidate_context_max_chars or 900)))
        self.candidate_context_min_chars = max(1, min(100, int(self.candidate_context_min_chars or 6)))
        self.assist_realtime_max_tokens = max(256, min(4096, int(self.assist_realtime_max_tokens or 720)))
        self.assist_realtime_high_churn_max_tokens = max(
            128,
            min(self.assist_realtime_max_tokens, int(self.assist_realtime_high_churn_max_tokens or 320)),
        )
        self.candidate_streaming_asr_interval_ms = max(800, min(5000, int(self.candidate_streaming_asr_interval_ms or 1500)))
        self.candidate_mic_compatibility_mode = bool(self.candidate_mic_compatibility_mode)
        wl = (self.whisper_language or "").strip()
        if wl and wl != "auto":
            import re as _re
            if not _re.match(r"^[a-z]{2}(-[A-Z]{2})?$", wl):
                logger.warning(
                    "whisper_language=%r 格式不正确，已重置为 auto (应为 ISO 639-1 码如 en/zh)", wl
                )
                self.whisper_language = "auto"
        cwl = (self.candidate_whisper_language or "").strip()
        if cwl and cwl != "auto":
            import re as _re
            if not _re.match(r"^[a-z]{2}(-[A-Z]{2})?$", cwl):
                logger.warning(
                    "candidate_whisper_language=%r 格式不正确，已重置为空（沿用 whisper_language）",
                    cwl,
                )
                self.candidate_whisper_language = ""
        if not self.models:
            self.models = [_default_model_config()]
        self.screen_capture_max_long_edge = max(0, min(4000, int(self.screen_capture_max_long_edge or 0)))
        self.assist_vad_max_speech_sec = max(6.0, min(60.0, float(self.assist_vad_max_speech_sec or 18.0)))
        self.assist_vad_min_speech_sec = max(0.1, min(2.0, float(self.assist_vad_min_speech_sec or 0.3)))
        self.aliyun_stt_max_sentence_silence_ms = (
            0 if int(self.aliyun_stt_max_sentence_silence_ms or 0) <= 0
            else max(200, min(6000, int(self.aliyun_stt_max_sentence_silence_ms)))
        )
        self.assist_web_search_timeout_sec = max(0.5, min(30.0, float(self.assist_web_search_timeout_sec or 2.5)))
        self.assist_stream_asr_confirm_window_sec = max(0.1, min(2.0, float(self.assist_stream_asr_confirm_window_sec if self.assist_stream_asr_confirm_window_sec is not None else 0.4)))
        self.assist_stream_asr_fast_confirm_sec = max(0.1, min(2.0, float(self.assist_stream_asr_fast_confirm_sec if self.assist_stream_asr_fast_confirm_sec is not None else 0.8)))
        self.assist_stream_asr_candidate_wait_sec = max(0.3, min(5.0, float(self.assist_stream_asr_candidate_wait_sec if self.assist_stream_asr_candidate_wait_sec is not None else 1.5)))
        self.assist_stream_asr_dispatch_grace_sec = max(0.0, min(3.0, float(self.assist_stream_asr_dispatch_grace_sec if self.assist_stream_asr_dispatch_grace_sec is not None else 0.5)))
        self.assist_stream_asr_silence_flush_sec = max(0.3, min(3.0, float(self.assist_stream_asr_silence_flush_sec if self.assist_stream_asr_silence_flush_sec is not None else 1.2)))
        self.assist_stream_reconnect_buffer_sec = max(
            0.0,
            min(120.0, float(
                self.assist_stream_reconnect_buffer_sec
                if self.assist_stream_reconnect_buffer_sec is not None else 30.0
            )),
        )
        vm = (self.aliyun_stt_vad_model or "").strip()
        if vm and vm not in ("near_meeting_16k", "far_field_meeting_16k"):
            logger.warning("aliyun_stt_vad_model=%r 不支持，已重置为空（可选 near_meeting_16k / far_field_meeting_16k）", vm)
            vm = ""
        self.aliyun_stt_vad_model = vm
        self.mic_agc_enabled = bool(self.mic_agc_enabled)
        self.assist_stop_answer_wait_sec = max(0.0, min(20.0, float(self.assist_stop_answer_wait_sec)))
        self.assist_interviewer_asr_drain_timeout_sec = max(
            0.5,
            min(30.0, float(self.assist_interviewer_asr_drain_timeout_sec or 6.0)),
        )
        self.active_model = max(0, min(int(self.active_model), len(self.models) - 1))
        if not getattr(self.models[self.active_model], "enabled", True):
            for i, model in enumerate(self.models):
                if getattr(model, "enabled", True):
                    self.active_model = i
                    break
        self.review_model_index = max(0, min(int(self.review_model_index), len(self.models) - 1))
        return self

    def get_active_model(self) -> ModelConfig:
        idx = max(0, min(self.active_model, len(self.models) - 1))
        return self.models[idx]

    def get_review_model(self) -> ModelConfig:
        idx = max(0, min(self.review_model_index, len(self.models) - 1))
        return self.models[idx]


_config: Optional[AppConfig] = None
_config_lock = threading.RLock()


def get_config() -> AppConfig:
    global _config
    with _config_lock:
        if _config is None:
            _config = _load_config()
        return _config


def update_config(updates: dict) -> AppConfig:
    global _config
    with _config_lock:
        cfg = get_config()
        data = cfg.model_dump()
        for k, v in updates.items():
            if hasattr(cfg, k):
                data[k] = v
        _config = AppConfig(**data)
        _save_config(_config)
        return _config


def _load_config() -> AppConfig:
    _custom_path = os.environ.get("IA_CONFIG_PATH")
    if not os.path.exists(CONFIG_FILE):
        if os.path.exists(CONFIG_EXAMPLE):
            try:
                os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
                shutil.copy2(CONFIG_EXAMPLE, CONFIG_FILE)
                logger.info("已从 config.example.json 创建 config.json，请填入你的 API Key")
            except OSError as e:
                logger.warning("创建配置文件失败: %s", e)
        elif _custom_path:
            logger.warning("IA_CONFIG_PATH=%s does not exist, using defaults", _custom_path)
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                raw_config = json.load(f)
            should_persist_migration = False
            if (
                isinstance(raw_config, dict)
                and not raw_config.get("whisper_preload_migrated")
                and raw_config.get("stt_provider") in REMOTE_STT_PROVIDERS
            ):
                # Older releases defaulted this setting to false. Upgrade only
                # the desktop/user-data configuration path; a checked-in local
                # developer config remains untouched.
                raw_config["whisper_preload"] = True
                raw_config["whisper_preload_migrated"] = True
                should_persist_migration = bool(_custom_path)
                logger.info("已为远程 STT 启用 Whisper 降级预加载")
            if (
                isinstance(raw_config, dict)
                and not raw_config.get("generic_stt_interval_migrated")
                and raw_config.get("generic_stt_streaming_interval_ms") == 2000
            ):
                # 旧版默认值 2000ms 会被 model_dump 全量写进 config.json，
                # 直接改默认值到不了老用户；把恰好钉在旧默认值上的配置升到新默认。
                raw_config["generic_stt_streaming_interval_ms"] = 1200
                raw_config["generic_stt_interval_migrated"] = True
                should_persist_migration = should_persist_migration or bool(_custom_path)
                logger.info("已将通用 ASR 伪流式间隔从旧默认 2000ms 升级到 1200ms")
            cfg = AppConfig(**raw_config)
            if should_persist_migration:
                _save_config(cfg)
            return cfg
        except Exception as e:
            logger.warning("配置文件解析失败: %s，使用默认配置", e)
    return AppConfig()


def _save_config(cfg: AppConfig) -> bool:
    try:
        data = cfg.model_dump()
        data.pop("resume_text", None)
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        logger.warning("保存配置失败: %s", e, exc_info=True)
        return False


POSITION_OPTIONS = [
    "前端开发", "后端开发", "全栈开发", "算法工程师", "测试开发",
    "机器学习工程师", "数据开发", "DBA", "产品经理", "项目经理",
]
LANGUAGE_OPTIONS = [
    "Python", "Java", "C++", "JavaScript", "TypeScript",
    "Go", "SQL",
]
WHISPER_MODEL_OPTIONS = ["tiny", "base", "small", "medium", "large-v3"]
STT_PROVIDER_OPTIONS = ["whisper", "doubao", "generic", "aliyun"]
# 电脑截图区域
SCREEN_CAPTURE_REGION_OPTIONS = ["full", "left_half", "right_half", "top_half", "bottom_half"]
