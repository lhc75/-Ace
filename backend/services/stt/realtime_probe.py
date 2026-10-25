"""实时语音能力探测：不看模型名，直接发真实音频验证模型能否实时出字。

/stt/test 在「面试官实时流式转写」开启时调用：
- 阿里：建一条真实的 duplex 流式会话，喂测试音频，收中间/最终结果；
- 通用：伪流式的本质是说话中途对当前缓存整体重转写，故用音频前缀片段验证。
"""

from __future__ import annotations

import numpy as np


def probe_aliyun_realtime(
    api_key: str,
    model: str,
    audio: np.ndarray,
    sample_rate: int,
    max_sentence_silence_ms: int = 0,
) -> tuple[bool, str]:
    """建立真实流式会话验证模型能否实时识别；返回 (是否支持, 失败详情)。"""
    from .aliyun_streaming import AliyunInterviewerStream
    from .engines import _audio_to_pcm_int16

    finals: list[str] = []
    interims: list[str] = []
    stream = AliyunInterviewerStream(
        api_key=api_key,
        model=model,
        sample_rate=sample_rate,
        max_sentence_silence_ms=max_sentence_silence_ms,
        on_interim=lambda _sid, text: interims.append(text),
        on_final=lambda _sid, text: finals.append(text),
        on_state_change=lambda _state: None,
    )
    try:
        stream.start()
    except Exception as exc:
        return False, str(exc)
    try:
        pcm = _audio_to_pcm_int16(audio).astype("<i2", copy=False)
        chunk = max(1, int(sample_rate * 0.1))
        for offset in range(0, len(pcm), chunk):
            stream.feed(pcm[offset:offset + chunk].tobytes())
        audio_sec = len(audio) / max(sample_rate, 1)
        stream.finish(drain_timeout_sec=min(8.0, audio_sec + 3.0))
    except Exception as exc:
        stream.abort()
        return False, str(exc)
    if stream.failure is not None:
        return False, str(stream.failure)
    if not any(text.strip() for text in finals + interims):
        return False, "连接成功但没有返回任何实时识别结果"
    return True, ""


def probe_generic_realtime(engine, audio: np.ndarray, sample_rate: int) -> tuple[bool, str]:
    """通用伪流式探测：对测试音频的前缀片段做一次转写（与说话中途的
    重转写完全同构）；返回 (是否支持, 失败详情)。"""
    audio_sec = len(audio) / max(sample_rate, 1)
    prefix = audio[: int(sample_rate * min(2.0, max(0.8, audio_sec * 0.6)))]
    if len(prefix) < sample_rate // 2:
        return True, ""  # 音频太短无法探测，不据此下结论
    try:
        text = engine.transcribe(prefix, sample_rate)
    except Exception as exc:
        return False, str(exc)
    if not (text or "").strip():
        return False, "说话中途的转写没有返回文本（模型可能只在整段说完后才出结果）"
    return True, ""
