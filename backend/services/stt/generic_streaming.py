"""面试官声道的通用 HTTP ASR “伪流式”实时转写。

通用 ASR（OpenAI 兼容的 ``POST {base}/audio/transcriptions``）是整段批量
接口，没有服务端流式事件。本类在协议不变的前提下复刻阿里千问双工流式
（``AliyunInterviewerStream``）的体验：

  - **边说边出字**：面试官还在说话时，按固定间隔把 VAD 已缓存的当前语句
    整体重转写一次，结果经“只追加、不跳变”稳定化后作为“进行中”行抛出——
    批量引擎每次都会改写前文，直接替换会闪烁，所以只在公共前缀足够长且
    文本变长时才刷新显示，视觉上与流式模型的逐字增长一致；
  - **说完马上定稿派发**：VAD 切出一句时把整段音频排队做定稿重转写
    （走与逐段路径相同的 ``transcribe_with_fallback`` 韧性链路），完成后
    通过 on_final 抛出，上层与千问 sentence_end 一样立即发布并派发答题；
  - **不重复识别**：流式生效期间逐段入队被跳过，定稿只由本类完成。

线程模型：
  - 调用方线程（采集主循环）只做 ``submit()`` / ``finalize()``，永不阻塞；
  - ``generic-interim`` 线程串行处理 interim，同一时刻最多一个在途请求，
    在途期间的 interim 提交直接丢弃（快照越新越好，排队旧快照没有意义）；
  - ``generic-final`` 线程串行处理定稿/收尾：定稿与在途 interim 并行执行，
    不再排在一次可能长达数秒的 interim 重转写后面（段越说越长时该阻塞会
    直接叠加到"说完→派发答题"的延迟上），定稿之间仍保持先来后到；
  - finalize 的定稿任务会挤掉队列里待处理的 interim（已被定稿取代）；
  - 回调都在这两个工作线程执行，实现方只允许使用线程安全的广播与锁。

中间结果是尽力而为的：interim 重转写失败不记熔断、不降级、不影响定稿
路径，只在连续失败时进入冷却；定稿失败则与逐段路径一样走熔断+Whisper 降级。
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from typing import Callable, Optional

import numpy as np

# 中间结果 / 定稿结果回调：参数为 (句子编号, 文本)。中间结果空文本表示“清除
# 进行中这一行”；定稿空文本表示该句未识别出内容（上层仍负责清行）。
InterimCallback = Callable[[int, str], None]
StateCallback = Callable[[str], None]
# 定稿转写函数：(音频, 采样率) -> 文本。由上层注入带熔断/降级的韧性链路。
FinalTranscribeFn = Callable[[np.ndarray, int], str]

_JOB_INTERIM = "i"
_JOB_FINAL = "f"
_JOB_FINISH = "done"


class GenericInterimTranscriber:
    """一场录音对应一个伪流式转写器：周期 interim + 每句一次 finalize 定稿。"""

    MIN_AUDIO_SEC = 1.0              # 缓存语音短于该值不值得打 interim 请求
    DEFAULT_INTERVAL_MS = 2000       # 默认 interim 重转写间隔
    MIN_INTERVAL_SEC = 0.8           # 间隔下限，防止把服务打满
    MAX_INTERVAL_SEC = 10.0          # 间隔上限，再大就没有“实时”感了
    FAILURE_BACKOFF_THRESHOLD = 3    # interim 连续失败这么多次后进入冷却
    FAILURE_BACKOFF_SEC = 15.0       # 冷却时长；期间忽略 submit
    MAX_REJECT_STREAK = 3            # interim 连续被稳定化拦截这么多次后放行，
                                     # 防止显示卡在永远不再收敛的旧文本上
    _JOIN_TIMEOUT_SEC = 2.0          # 停止时等工作线程退出的上限

    def __init__(
        self,
        *,
        engine,
        transcribe_final: FinalTranscribeFn,
        sample_rate: int = 16000,
        interval_ms: int = DEFAULT_INTERVAL_MS,
        min_final_samples: int = 0,
        on_interim: InterimCallback,
        on_final: InterimCallback,
        on_state_change: Optional[StateCallback] = None,
        logger: Optional[logging.Logger] = None,
    ) -> None:
        self._engine = engine
        self._transcribe_final = transcribe_final
        self.sample_rate = int(sample_rate or 16000)
        interval_sec = (int(interval_ms) or self.DEFAULT_INTERVAL_MS) / 1000.0
        self.interval_sec = max(self.MIN_INTERVAL_SEC, min(self.MAX_INTERVAL_SEC, interval_sec))
        self._min_final_samples = max(0, int(min_final_samples or 0))
        self._on_interim = on_interim
        self._on_final = on_final
        self._on_state_change = on_state_change
        self._log = logger or logging.getLogger(__name__)

        # 统计：发出的 interim / 定稿请求数、被丢弃的迟到结果数，供排查与测试断言。
        self.interim_requests = 0
        self.final_requests = 0
        self.dropped_late_results = 0

        self._interim_q: "queue.Queue[tuple]" = queue.Queue(maxsize=1)
        # 定稿/收尾走无界队列：put_nowait 永不阻塞采集主循环，定稿一个都不丢；
        # 由独立的定稿线程消费（见文档字符串的线程模型），interim 队列只放
        # "越新越好"的快照。
        self._final_q: "queue.Queue[tuple]" = queue.Queue()
        self._dead = threading.Event()
        self._interim_thread: Optional[threading.Thread] = None
        self._final_thread: Optional[threading.Thread] = None
        self._state_lock = threading.Lock()
        # 以下状态由 submit/finalize（调用方线程）与 worker 共享，一律持锁读写。
        self._last_submit_mono = 0.0
        self._sentence_id = 1
        self._line_shown = False        # 当前句是否已推出过非空中间行
        self._last_shown_text = ""      # 进行中行当前显示的文本（稳定化基准）
        self._reject_streak = 0
        self._consecutive_failures = 0
        self._backoff_until = 0.0

    # ------------------------------------------------------------------ state

    @property
    def healthy(self) -> bool:
        """两条工作线程都存活且未进入终态；不健康时上层应回退到逐段识别。"""
        return (
            self._interim_thread is not None
            and self._interim_thread.is_alive()
            and self._final_thread is not None
            and self._final_thread.is_alive()
            and not self._dead.is_set()
        )

    # ------------------------------------------------------------------ public

    def start(self) -> None:
        """启动两条工作线程；幂等。"""
        with self._state_lock:
            if self._interim_thread is not None:
                return
            self._interim_thread = threading.Thread(
                target=self._run_interim_loop, name="generic-interim", daemon=True
            )
            self._final_thread = threading.Thread(
                target=self._run_final_loop, name="generic-final", daemon=True
            )
            self._interim_thread.start()
            self._final_thread.start()
        self._emit_state("started")

    def submit(self, audio: Optional[np.ndarray]) -> None:
        """把 VAD 当前缓存的整段语音交给工作线程做 interim 重转写（非阻塞）。

        按 interval 节流；在途或已排队时直接丢弃本次提交——音频是“越新越好”
        的快照，主循环很快会再交最新一份。
        """
        if audio is None or len(audio) < int(self.sample_rate * self.MIN_AUDIO_SEC):
            return
        if self._dead.is_set():
            return
        now = time.monotonic()
        with self._state_lock:
            if now < self._backoff_until:
                return
            if now - self._last_submit_mono < self.interval_sec:
                return
            self._last_submit_mono = now
            sentence_id = self._sentence_id
        try:
            self._interim_q.put_nowait((_JOB_INTERIM, audio, sentence_id))
        except queue.Full:
            pass

    def finalize(self, audio: Optional[np.ndarray]) -> None:
        """VAD 切出一句：把整段音频排队做定稿重转写，对应千问的 sentence_end。

        进行中行在此刻冻结（保留最后显示的文本），等定稿发布后由上层清行，
        视觉上是“行内容直接变成正式转写”，不会出现先消失再出现的空窗。
        段短到会被逐段路径丢弃时不会有定稿，立即清行。
        """
        if self._dead.is_set():
            return
        with self._state_lock:
            sentence_id = self._sentence_id
            self._sentence_id += 1
            self._line_shown = False
            self._last_shown_text = ""
            self._reject_streak = 0
            self._last_submit_mono = 0.0  # 下一句的 interim 立刻可以出字
        if audio is None or len(audio) < self._min_final_samples:
            self._emit(sentence_id, "")
            return
        # 定稿排进无界队列（永不阻塞），并挤掉待处理的 interim（已被定稿取代）。
        try:
            self._interim_q.get_nowait()
        except queue.Empty:
            pass
        self._final_q.put_nowait((_JOB_FINAL, audio, sentence_id))

    def finish(self, drain_timeout_sec: float) -> None:
        """正常收尾：限时等队列里的定稿处理完，然后停线程。

        等待时长设上限，保证一定能在停止流程的 join 超时内退出。
        """
        if self._dead.is_set():
            return
        drained = threading.Event()
        self._final_q.put_nowait((_JOB_FINISH, drained, 0))
        drained.wait(timeout=max(0.0, float(drain_timeout_sec)))
        self._emit_state("closed")
        self._teardown()

    def abort(self) -> None:
        """立即停线程，不等定稿。用于异常兜底。"""
        self._teardown()

    # ----------------------------------------------------------------- intern

    def _teardown(self) -> None:
        self._dead.set()
        for thread in (self._interim_thread, self._final_thread):
            if (
                thread is not None
                and thread.is_alive()
                and thread is not threading.current_thread()
            ):
                thread.join(timeout=self._JOIN_TIMEOUT_SEC)

    def _emit(self, sentence_id: int, text: str) -> None:
        if self._dead.is_set():
            return
        try:
            self._on_interim(sentence_id, text)
        except Exception:
            self._log.exception("Generic interim on_interim callback raised")

    def _emit_final(self, sentence_id: int, text: str) -> None:
        if self._dead.is_set():
            return
        try:
            self._on_final(sentence_id, text)
        except Exception:
            self._log.exception("Generic interim on_final callback raised")

    def _emit_state(self, state: str) -> None:
        if self._dead.is_set() or self._on_state_change is None:
            return
        try:
            self._on_state_change(state)
        except Exception:
            self._log.exception("Generic interim on_state_change callback raised")

    # ------------------------------------------------------- interim 稳定化

    @staticmethod
    def _common_prefix_len(a: str, b: str) -> int:
        n = 0
        for ca, cb in zip(a, b):
            if ca != cb:
                break
            n += 1
        return n

    def _accept_interim(self, new: str) -> bool:
        """只追加、不跳变：新文本必须延续当前显示，或公共前缀足够长且更长。

        批量引擎每次整体重转写都会改写前文，直接替换显示会闪烁；拦截跳变，
        视觉上就是流式模型那样的逐字增长。连续被拦 MAX_REJECT_STREAK 次后
        放行一次，防止显示卡在不再收敛的旧文本上。
        调用时必须持有 _state_lock。
        """
        last = self._last_shown_text
        if not last:
            return True
        if new == last:
            return False  # 文本没变化，不需要刷新
        accept = (
            new.startswith(last)
            or (
                self._common_prefix_len(new, last) >= max(4, int(len(last) * 0.6))
                and len(new) > len(last)
            )
        )
        if not accept:
            self._reject_streak += 1
            accept = self._reject_streak >= self.MAX_REJECT_STREAK
        if accept:
            self._reject_streak = 0
        return accept

    # ------------------------------------------------------------ failure

    def _record_failure(self, error: Exception) -> None:
        with self._state_lock:
            self._consecutive_failures += 1
            failures = self._consecutive_failures
            if failures >= self.FAILURE_BACKOFF_THRESHOLD:
                self._backoff_until = time.monotonic() + self.FAILURE_BACKOFF_SEC
        if failures == 1 or failures == self.FAILURE_BACKOFF_THRESHOLD:
            self._log.warning(
                "Generic interim transcribe failed (%d consecutive): %s", failures, error
            )
        else:
            self._log.debug("Generic interim transcribe failed: %s", error)

    def _record_success(self) -> None:
        with self._state_lock:
            self._consecutive_failures = 0

    # ------------------------------------------------------------- worker

    def _run_final_loop(self) -> None:
        """定稿线程：只消费定稿/收尾任务，不被在途 interim 阻塞。"""
        while not self._dead.is_set():
            try:
                kind, payload, sentence_id = self._final_q.get(timeout=0.2)
            except queue.Empty:
                continue
            if kind == _JOB_FINISH:
                payload.set()
                return
            self._run_final(payload, sentence_id)

    def _run_interim_loop(self) -> None:
        """interim 线程：只消费 interim 快照；任何异常只记日志。"""
        while not self._dead.is_set():
            try:
                kind, payload, sentence_id = self._interim_q.get(timeout=0.2)
            except queue.Empty:
                continue
            if kind != _JOB_INTERIM:
                continue
            self._run_interim(payload, sentence_id)

    def _run_interim(self, audio: np.ndarray, sentence_id: int) -> None:
        self.interim_requests += 1
        try:
            text = (self._engine.transcribe(audio, self.sample_rate) or "").strip()
        except Exception as error:
            self._record_failure(error)
            return
        self._record_success()
        if not text:
            return
        with self._state_lock:
            if sentence_id != self._sentence_id:
                # 段已定稿的迟到结果：文本与定稿高度重复，显示出来只会是一行
                # 甩不掉的旧话，宁可不显示（正式转写很快由定稿发布）。
                self.dropped_late_results += 1
                return
            if not self._accept_interim(text):
                return
            self._last_shown_text = text
            self._line_shown = True
        self._emit(sentence_id, text)

    def _run_final(self, audio: np.ndarray, sentence_id: int) -> None:
        self.final_requests += 1
        try:
            text = (self._transcribe_final(audio, self.sample_rate) or "").strip()
        except Exception as error:
            # transcribe_final 内部已有熔断+降级；走到这里说明连降级也失败了，
            # 与逐段路径的失败等价：记日志、按空文本处理（上层照常清行）。
            self._log.warning("Generic final transcribe failed: %s", error)
            text = ""
        self._record_success()
        self._emit_final(sentence_id, text)
