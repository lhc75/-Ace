"""通用 ASR 伪流式实时转写器（GenericInterimTranscriber）单元测试。

用 FakeEngine / 假 transcribe_final 控制转写结果、耗时与失败次数，覆盖：
间隔节流、在途去重、interim 前缀稳定化（只增不跳）、finalize 定稿与
迟到结果丢弃、短段直接清行、定稿挤掉排队 interim、失败冷却、finish 收尾。
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import numpy as np

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.stt.generic_streaming import GenericInterimTranscriber

ONE_SECOND = np.zeros(16000, dtype=np.float32)
INTERVAL_MS = 800  # 类内节流下限，测试按此值等待


class FakeEngine:
    """可控的假 ASR 引擎：记录每次请求的音频长度，可设定延迟与前 N 次失败。"""

    def __init__(self, text: str = "你好", delay: float = 0.0, fail_times: int = 0):
        self.text = text
        self.delay = delay
        self.fail_times = fail_times
        self.calls: list[int] = []
        self._lock = threading.Lock()

    def transcribe(self, audio, sample_rate: int = 16000, **_kwargs) -> str:
        with self._lock:
            self.calls.append(len(audio))
            call_no = len(self.calls)
        if self.delay:
            time.sleep(self.delay)
        if call_no <= self.fail_times:
            raise RuntimeError("boom")
        return self.text


def _make(engine, interims, finals, *, interval_ms: int = INTERVAL_MS,
          final_text: str = "定稿文本", final_delay: float = 0.0,
          min_final_samples: int = 1600) -> GenericInterimTranscriber:
    def _final(audio, sample_rate):
        if final_delay:
            time.sleep(final_delay)
        return final_text

    transcriber = GenericInterimTranscriber(
        engine=engine,
        transcribe_final=_final,
        sample_rate=16000,
        interval_ms=interval_ms,
        min_final_samples=min_final_samples,
        on_interim=lambda sid, text: interims.append((sid, text)),
        on_final=lambda sid, text: finals.append((sid, text)),
    )
    transcriber.start()
    return transcriber


def _force_ready(transcriber: GenericInterimTranscriber) -> None:
    """绕过节流起点，让下一次 submit 立即被接受（测试专用）。"""
    with transcriber._state_lock:
        transcriber._last_submit_mono = 0.0


def _wait_until(pred, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return False


def test_submit_emits_interim_with_sentence_id():
    interims, finals = [], []
    t = _make(FakeEngine(text="你好"), interims, finals)
    try:
        t.submit(ONE_SECOND)
        assert _wait_until(lambda: interims)
        assert interims == [(1, "你好")]
    finally:
        t.abort()


def test_submit_throttles_within_interval():
    engine = FakeEngine()
    interims, finals = [], []
    t = _make(engine, interims, finals)
    try:
        for _ in range(5):
            t.submit(ONE_SECOND)
        assert _wait_until(lambda: engine.calls)
        time.sleep(0.1)
        assert len(engine.calls) == 1
    finally:
        t.abort()


def test_submit_skips_while_request_in_flight():
    engine = FakeEngine(delay=0.5)
    interims, finals = [], []
    t = _make(engine, interims, finals)
    try:
        t.submit(ONE_SECOND)
        assert _wait_until(lambda: engine.calls)
        # 在途期间多次提交（绕过节流，专测在途去重）：最多再排队一份最新快照
        for _ in range(4):
            _force_ready(t)
            t.submit(ONE_SECOND)
        assert _wait_until(lambda: interims)
        time.sleep(0.8)
        assert len(engine.calls) <= 2
    finally:
        t.abort()


def test_interim_stabilization_only_appends():
    """批量引擎每次改写前文：跳变的重转写被拦截，显示只增不跳。"""
    engine = FakeEngine()
    interims, finals = [], []
    t = _make(engine, interims, finals)
    try:
        t.submit(ONE_SECOND)
        assert _wait_until(lambda: interims == [(1, "你好")])
        # 文本变长且延续旧文本 → 放行
        engine.text = "你好，请介绍"
        _force_ready(t)
        t.submit(ONE_SECOND)
        assert _wait_until(lambda: len(interims) >= 2)
        assert interims[-1] == (1, "你好，请介绍")
        # 整体改写（前缀全变）→ 拦截，显示不动
        engine.text = "完全不同的话"
        _force_ready(t)
        t.submit(ONE_SECOND)
        assert _wait_until(lambda: len(engine.calls) >= 3)
        time.sleep(0.2)
        assert len(interims) == 2
        # 变短 → 拦截
        engine.text = "你"
        _force_ready(t)
        t.submit(ONE_SECOND)
        time.sleep(0.2)
        assert len(interims) == 2
    finally:
        t.abort()


def test_interim_reject_streak_eventually_accepts():
    """连续被拦 MAX_REJECT_STREAK 次后放行，防止显示卡在不收敛的旧文本上。"""
    engine = FakeEngine()
    interims, finals = [], []
    t = _make(engine, interims, finals)
    try:
        t.submit(ONE_SECOND)
        assert _wait_until(lambda: interims)
        for i in range(GenericInterimTranscriber.MAX_REJECT_STREAK):
            engine.text = f"改写版本{i}改写版本{i}"  # 前缀全变但更长
            _force_ready(t)
            t.submit(ONE_SECOND)
            assert _wait_until(lambda n=i + 2: len(engine.calls) >= n)
            time.sleep(0.1)
        assert _wait_until(lambda: len(interims) >= 2)
        assert interims[-1][1].startswith("改写版本")
    finally:
        t.abort()


def test_finalize_emits_final_and_drops_late_interim():
    """finalize = sentence_end：定稿转写经 on_final 抛出，期间不清进行中行。"""
    engine = FakeEngine(delay=0.3)
    interims, finals = [], []
    t = _make(engine, interims, finals, final_text="完整的一句话")
    try:
        t.submit(ONE_SECOND)
        assert _wait_until(lambda: engine.calls)
        t.finalize(ONE_SECOND)  # interim 还在途时切段
        assert _wait_until(lambda: finals, timeout=3.0)
        assert finals == [(1, "完整的一句话")]
        # 在途 interim 属迟到结果：定稿与 interim 并行，interim 返回后被丢弃，
        # 不会清行也不会覆盖（丢弃发生在 interim 返回时，不保证先于定稿）
        assert _wait_until(lambda: t.dropped_late_results == 1)
        assert interims == []
        # 下一句编号 +1
        t.submit(ONE_SECOND)
        assert _wait_until(lambda: interims)
        assert interims == [(2, "你好")]
    finally:
        t.abort()


def test_finalize_not_blocked_by_inflight_interim():
    """定稿走独立线程：在途的慢 interim 不再把定稿（及答题派发）拖住。"""
    engine = FakeEngine(delay=1.0)  # 慢 interim：旧串行设计下定稿要等它返回
    interims, finals = [], []
    t = _make(engine, interims, finals, final_text="完整的一句话")
    try:
        started = time.monotonic()
        t.submit(ONE_SECOND)
        assert _wait_until(lambda: engine.calls)
        t.finalize(ONE_SECOND)
        assert _wait_until(lambda: finals, timeout=3.0)
        assert time.monotonic() - started < 0.9
        assert finals == [(1, "完整的一句话")]
        # 慢 interim 返回后按迟到结果丢弃
        assert _wait_until(lambda: t.dropped_late_results == 1, timeout=3.0)
    finally:
        t.abort()


def test_finalize_short_audio_clears_line_without_final():
    """短到会被逐段路径丢弃的段：立即清行，不打定稿请求。"""
    interims, finals = [], []
    t = _make(FakeEngine(), interims, finals)
    try:
        t.submit(ONE_SECOND)
        assert _wait_until(lambda: interims)
        t.finalize(np.zeros(800, dtype=np.float32))  # 0.05s < min_final
        assert interims[-1] == (1, "")
        assert finals == []
        assert t.final_requests == 0
    finally:
        t.abort()


def test_finalize_evicts_queued_interim():
    """定稿必须入队：队列被 interim 占着时挤掉它。"""
    engine = FakeEngine(delay=0.4)  # 第一个请求在途，第二个 interim 占住队列
    interims, finals = [], []
    t = _make(engine, interims, finals)
    try:
        t.submit(ONE_SECOND)
        assert _wait_until(lambda: engine.calls)
        _force_ready(t)
        t.submit(ONE_SECOND)  # 这份 interim 会占住队列
        t.finalize(ONE_SECOND)
        assert _wait_until(lambda: finals, timeout=3.0)
        assert finals[0][1] == "定稿文本"
        # 被挤掉的 interim 不应执行：interim 请求只有第一个
        assert t.interim_requests == 1
    finally:
        t.abort()


def test_consecutive_failures_trigger_backoff():
    engine = FakeEngine(fail_times=3)
    interims, finals = [], []
    t = _make(engine, interims, finals)
    try:
        for expected in (1, 2, 3):
            _force_ready(t)
            t.submit(ONE_SECOND)
            assert _wait_until(lambda e=expected: len(engine.calls) >= e)
            assert _wait_until(lambda e=expected: t._consecutive_failures >= e)
        assert _wait_until(lambda: t._backoff_until > time.monotonic())
        _force_ready(t)
        t.submit(ONE_SECOND)
        time.sleep(0.3)
        assert len(engine.calls) == 3  # 冷却期内 submit 被忽略
    finally:
        t.abort()


def test_final_failure_still_emits_empty_final():
    """定稿链路（含降级）也失败：on_final 收到空文本，上层照常清行。"""
    def _failing_final(audio, sample_rate):
        raise RuntimeError("all down")

    interims, finals = [], []
    t = GenericInterimTranscriber(
        engine=FakeEngine(),
        transcribe_final=_failing_final,
        sample_rate=16000,
        interval_ms=INTERVAL_MS,
        min_final_samples=1600,
        on_interim=lambda sid, text: interims.append((sid, text)),
        on_final=lambda sid, text: finals.append((sid, text)),
    )
    t.start()
    try:
        t.finalize(ONE_SECOND)
        assert _wait_until(lambda: finals)
        assert finals == [(1, "")]
    finally:
        t.abort()


def test_finish_drains_final_then_stops():
    """finish 等定稿发完再停线程，保证停止前最后的话能落库。"""
    interims, finals = [], []
    t = _make(FakeEngine(), interims, finals, final_delay=0.3)
    t.finalize(ONE_SECOND)
    t.finish(drain_timeout_sec=3.0)
    assert finals == [(1, "定稿文本")]
    assert not t.healthy
    # finish 幂等，之后再 submit/finalize 都是安全 no-op
    t.finish(drain_timeout_sec=0.1)
    t.submit(ONE_SECOND)
    t.finalize(ONE_SECOND)
    assert t.final_requests == 1


def test_empty_interim_text_not_emitted():
    engine = FakeEngine(text="  ")
    interims, finals = [], []
    t = _make(engine, interims, finals)
    try:
        t.submit(ONE_SECOND)
        assert _wait_until(lambda: engine.calls)
        time.sleep(0.2)
        assert not interims
        assert t._consecutive_failures == 0  # 空结果说明服务活着，不算失败
    finally:
        t.abort()
