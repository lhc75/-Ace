"""面试官声道的阿里千问双工流式识别（常驻会话）。

与 ``AliyunSTT.transcribe`` 的区别：后者每切出一个 VAD 音频段就新建一条
WebSocket，把整段音频一次性灌上去，并且丢弃中间结果；本类在整场录音期间
只保持一条双工任务，音频边采集边实时上行，中间识别结果通过回调抛给上层，
所以面试官还在说话时界面上就能看到滚动的文字。

存在本类不代表逐段路径被替换：只要开关关闭、引擎不是阿里千问、或本流异常
不可用，上层仍会回落到原有的 ``AliyunSTT`` 逐段识别。
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import time
import uuid
from typing import Callable, Optional

from .aliyun import (
    ALIYUN_ASR_WS_URL,
    _classify_task_failed,
    _transport_error,
    AliyunSTTAuthError,
    AliyunSTTConnectionError,
    AliyunSTTError,
    AliyunSTTProviderError,
    AliyunSTTTimeoutError,
)
from .engines import _is_websocket_timeout, websocket

AuthCallback = Callable[[str], None]
# 中间结果 / 定稿结果回调：参数为 (句子编号, 文本)。中间结果用空文本表示“清除进行中这一行”。
InterimCallback = Callable[[int, str], None]


class AliyunInterviewerStream:
    """一场录音对应一条双工识别任务，并向回调抛出中间结果。

    线程模型：
      - 调用方线程（流水线主循环）只做 ``feed()``，把 PCM 塞进有界队列，永不阻塞；
      - ``aliyun-stream-send`` 负责从队列取音频写进 WebSocket；
      - ``aliyun-stream-recv`` 负责读事件，节流后触发 on_interim / on_final。
    回调都在接收线程执行，实现方只允许使用线程安全的广播与锁。
    """

    CONNECT_TIMEOUT_SEC = 10.0   # 建连超时
    START_TIMEOUT_SEC = 10.0     # 等待 task-started 的超时
    INTERIM_THROTTLE_MS = 120    # 中间结果最小推送间隔，避免每个字都刷新界面
    SEND_QUEUE_MAX = 50          # 约 5 秒的 100ms 音频块；写满时丢弃最旧块
    _RECV_POLL_SEC = 1.0         # 单次 recv 的轮询粒度，便于及时响应 abort()

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        sample_rate: int = 16000,
        max_sentence_silence_ms: int = 0,
        on_interim: InterimCallback,
        on_final: InterimCallback,
        on_state_change: AuthCallback,
        logger: Optional[logging.Logger] = None,
    ) -> None:
        self.api_key = (api_key or "").strip()
        self.model = (model or "").strip()
        self.sample_rate = int(sample_rate or 16000)
        # 服务端 VAD 断句静音阈值（毫秒）；<=0 表示不下发、沿用服务端默认。
        self.max_sentence_silence_ms = max(0, int(max_sentence_silence_ms or 0))
        self._on_interim = on_interim
        self._on_final = on_final
        self._on_state_change = on_state_change
        self._log = logger or logging.getLogger(__name__)

        self.dropped_chunks = 0

        self._send_q: "queue.Queue[Optional[bytes]]" = queue.Queue(maxsize=self.SEND_QUEUE_MAX)
        self._dead = threading.Event()       # 已开始拆除：此后不再触发任何回调
        self._terminal = threading.Event()   # 收/发线程已进入终态（正常结束或失败）
        self._started = threading.Event()    # 已收到服务端 task-started
        self._finishing = threading.Event()  # 已调用 finish()：不再接收新音频
        self._failure: Optional[AliyunSTTError] = None
        self._state_lock = threading.Lock()

        self._ws = None
        self._task_id = ""
        self._sender: Optional[threading.Thread] = None
        self._receiver: Optional[threading.Thread] = None

        # 中间结果节流状态，只在接收线程读写
        self._last_emit_mono = 0.0
        self._emitted_interim: dict[int, str] = {}   # 每个句子最后一次已推送的文本
        self._pending_interim: dict[int, str] = {}   # 被节流挡下、等待补发的最新文本

    # ------------------------------------------------------------------ state

    @property
    def healthy(self) -> bool:
        """任务已启动且未进入终态时为 True，上层以此判断是否继续走流式路径。"""
        return (
            self._started.is_set()
            and not self._terminal.is_set()
            and not self._dead.is_set()
        )

    @property
    def failure(self) -> Optional[AliyunSTTError]:
        """终态失败原因；正常结束或仍在运行时为 None。"""
        return self._failure

    def _mark_terminal(self, error: Optional[AliyunSTTError]) -> None:
        """进入终态（幂等）。有错误时额外通知上层，供流水线决定重连还是降级。"""
        with self._state_lock:
            if self._terminal.is_set():
                return
            self._failure = error
            self._terminal.set()
        if error is not None:
            self._emit_state(f"failed:{type(error).__name__}")

    def _emit_state(self, state: str) -> None:
        if self._dead.is_set():
            return
        try:
            self._on_state_change(state)
        except Exception:
            self._log.exception("Aliyun stream on_state_change callback raised")

    def _emit_interim(self, sentence_id: int, text: str) -> None:
        if self._dead.is_set():
            return
        try:
            self._on_interim(sentence_id, text)
        except Exception:
            self._log.exception("Aliyun stream on_interim callback raised")

    def _emit_final(self, sentence_id: int, text: str) -> None:
        if self._dead.is_set():
            return
        try:
            self._on_final(sentence_id, text)
        except Exception:
            self._log.exception("Aliyun stream on_final callback raised")

    # ----------------------------------------------------------------- public

    def start(self) -> None:
        """建连、下发 run-task 并等到 task-started 后启动收发线程。

        失败时抛 AliyunSTTError 的子类，且保证连接已关闭、不残留线程，
        上层据此回落到逐段识别。
        """
        if not self.api_key:
            raise AliyunSTTAuthError("阿里千问 ASR API Key 未配置")
        if not self.model:
            raise AliyunSTTProviderError("阿里千问 ASR 模型名称未配置")
        if websocket is None:
            raise AliyunSTTError("阿里千问 ASR 缺少 websocket-client 依赖")
        self._task_id = uuid.uuid4().hex
        header = {"task_id": self._task_id, "streaming": "duplex"}
        parameters: dict = {"format": "pcm", "sample_rate": self.sample_rate}
        if self.max_sentence_silence_ms > 0:
            # 官方 SDK 文档对 qwen-audio-3.1-asr-flash-streaming 标明支持
            # max_sentence_silence（范围 200–6000，默认 800）；不认该参数的
            # 服务端会忽略它，不影响任务建立。
            parameters["max_sentence_silence"] = self.max_sentence_silence_ms
        run_task = {
            "header": {**header, "action": "run-task"},
            "payload": {
                "task_group": "audio", "task": "asr", "function": "recognition",
                "model": self.model,
                "parameters": parameters,
                "input": {},
            },
        }
        try:
            self._ws = websocket.create_connection(
                ALIYUN_ASR_WS_URL,
                header={"Authorization": f"Bearer {self.api_key}"},
                timeout=self.CONNECT_TIMEOUT_SEC,
                enable_multithread=True,
            )
            self._ws.send(json.dumps(run_task))
            startup_deadline = time.monotonic() + self.START_TIMEOUT_SEC
            while True:
                message = self._receive(startup_deadline)
                if message and message["header"].get("event") == "task-started":
                    break
        except AliyunSTTError:
            self._close_ws()
            raise
        except Exception as error:
            self._close_ws()
            raise _transport_error(error, self.api_key) from None

        self._started.set()
        self._sender = threading.Thread(target=self._send_loop, name="aliyun-stream-send", daemon=True)
        self._receiver = threading.Thread(target=self._recv_loop, name="aliyun-stream-recv", daemon=True)
        self._sender.start()
        self._receiver.start()
        self._emit_state("started")

    def feed(self, pcm: bytes) -> None:
        """把一块 16bit 单声道 PCM 交给发送线程。

        非阻塞：队列满时丢弃最旧的一块再入队，牺牲个别音频块换取采集主循环
        绝不被网络背压卡住（丢块会记 dropped_chunks，并在日志里告警）。
        """
        if not pcm or self._finishing.is_set() or not self.healthy:
            return
        try:
            self._send_q.put_nowait(pcm)
        except queue.Full:
            try:
                self._send_q.get_nowait()
            except queue.Empty:
                pass
            self.dropped_chunks += 1
            if self.dropped_chunks == 1 or self.dropped_chunks % 100 == 0:
                self._log.warning("Aliyun stream send queue full; dropped_chunks=%d", self.dropped_chunks)
            try:
                self._send_q.put_nowait(pcm)
            except queue.Full:
                pass

    def finish(self, drain_timeout_sec: float) -> None:
        """正常收尾：发 finish-task，限时等把剩余定稿收完，然后关闭连接。

        等待时长设上限，避免服务端不回 task-finished 时卡住停止流程；
        即使超时也会关闭连接，并保证不残留线程。
        """
        if self._dead.is_set():
            return
        self._finishing.set()
        if self._started.is_set() and not self._terminal.is_set():
            try:
                self._send_q.put_nowait(None)
            except queue.Full:
                # 发送线程还积压着音频：挤掉一块给结束哨兵腾位置，
                # 保证 finish-task 一定发得出去（此处丢弃的只是积压音频）。
                try:
                    self._send_q.get_nowait()
                    self._send_q.put_nowait(None)
                except (queue.Empty, queue.Full):
                    pass
            self._terminal.wait(timeout=max(0.0, float(drain_timeout_sec)))
        self._emit_state("closed")
        self._teardown()

    def abort(self) -> None:
        """立即断开，不等定稿。用于重连前清理或异常兜底。"""
        self._teardown()

    # ----------------------------------------------------------------- intern

    def _teardown(self) -> None:
        already_dead = self._dead.is_set()
        self._dead.set()
        self._close_ws()
        for thread in (self._sender, self._receiver):
            if thread is not None and thread.is_alive() and thread is not threading.current_thread():
                thread.join(timeout=2.0)
        if not already_dead:
            self._terminal.set()

    def _close_ws(self) -> None:
        ws = self._ws
        if ws is None:
            return
        # 先 abort 再 close：abort 能打断正在阻塞的 send，否则 close 要等
        # WebSocket 写锁，可能与发送线程互相卡住（与 AliyunSTT.transcribe 一致）。
        try:
            ws.abort()
        except Exception:
            pass
        try:
            ws.close(timeout=1)
        except Exception:
            pass

    def _receive(self, deadline: float) -> Optional[dict]:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AliyunSTTTimeoutError("阿里千问 ASR 等待任务响应超时")
        self._ws.settimeout(min(self._RECV_POLL_SEC, remaining))
        try:
            raw = self._ws.recv()
        except Exception as error:
            if _is_websocket_timeout(error) and time.monotonic() < deadline:
                return None
            raise _transport_error(error, self.api_key) from None
        if not raw:
            raise AliyunSTTConnectionError("阿里千问 ASR 在任务完成前断开连接")
        try:
            message = json.loads(raw)
        except (TypeError, ValueError):
            raise AliyunSTTProviderError("阿里千问 ASR 返回无效 JSON 事件") from None
        if not isinstance(message, dict) or not isinstance(message.get("header"), dict):
            raise AliyunSTTProviderError("阿里千问 ASR 返回无效事件结构")
        header = message["header"]
        if header.get("task_id") != self._task_id:
            return None
        if header.get("event") == "task-failed":
            raise _classify_task_failed(header, self.api_key, timeout_is_terminal=False)
        return message

    def _send_loop(self) -> None:
        """发送线程：从队列取音频写入 socket；收到 None 哨兵说明该发 finish-task 了。"""
        try:
            while not self._dead.is_set():
                try:
                    item = self._send_q.get(timeout=0.2)
                except queue.Empty:
                    continue
                if item is None:
                    self._ws.send(json.dumps({
                        "header": {"task_id": self._task_id, "streaming": "duplex", "action": "finish-task"},
                        "payload": {"input": {}},
                    }))
                    return
                self._ws.send_binary(item)
        except Exception as error:
            if not self._dead.is_set():
                classified = error if isinstance(error, AliyunSTTError) else _transport_error(error, self.api_key)
                self._log.warning("Aliyun stream sender failed: %s", classified)
                self._mark_terminal(classified)

    def _recv_loop(self) -> None:
        """接收线程：轮询事件并分发；异常一律转成终态，交给上层决定重连或降级。"""
        try:
            while not self._dead.is_set():
                try:
                    message = self._receive(time.monotonic() + self._RECV_POLL_SEC)
                except AliyunSTTTimeoutError:
                    # 单次 recv 轮空不算失败，继续等下一个事件
                    continue
                except AliyunSTTError as error:
                    self._mark_terminal(error)
                    return
                if not message:
                    continue
                event = message["header"].get("event")
                if event == "task-finished":
                    self._mark_terminal(None)
                    return
                if event == "result-generated":
                    self._handle_sentence(message.get("payload", {}))
        finally:
            self._terminal.set()

    def _handle_sentence(self, payload: dict) -> None:
        """处理一条句子事件：未结束的是中间结果，sentence_end 为真的是定稿。

        中间结果按 INTERIM_THROTTLE_MS 节流，但被挡下的最新文本会暂存，
        在定稿前补发一次，保证界面不会停留在过时的半句话上。
        这里的解析一律防御式：字段缺失或类型不对就跳过，绝不因为中间结果抛异常。
        """
        sentence = payload.get("output", {}).get("sentence", {})
        if not isinstance(sentence, dict) or sentence.get("heartbeat"):
            return
        sentence_id = sentence.get("sentence_id")
        if not isinstance(sentence_id, int) or sentence_id < 1:
            return  # 中间结果解析失败只跳过，不能中断整条流
        text = (sentence.get("text") or "").strip()
        if sentence.get("sentence_end"):
            # 定稿：先补发被节流挡下的最后一段中间文本，再清空进行中行，最后发布定稿
            pending = self._pending_interim.pop(sentence_id, None)
            if pending and pending != self._emitted_interim.get(sentence_id):
                self._emit_interim(sentence_id, pending)
            self._emitted_interim.pop(sentence_id, None)
            self._emit_interim(sentence_id, "")
            if text:
                self._emit_final(sentence_id, text)
            return
        if not text:
            return
        now = time.monotonic()
        if (
            text != self._emitted_interim.get(sentence_id)
            and (now - self._last_emit_mono) * 1000 >= self.INTERIM_THROTTLE_MS
        ):
            self._emitted_interim[sentence_id] = text
            self._pending_interim.pop(sentence_id, None)
            self._last_emit_mono = now
            self._emit_interim(sentence_id, text)
        else:
            # 还在节流窗口内或文本没变化：只记下最新文本，等窗口到期或定稿时补发
            self._pending_interim[sentence_id] = text
