"""通用 ASR 伪流式的真实 HTTP 栈验证脚本。

本地起一个慢速 mock ASR 服务（每个请求固定耗时 0.8s），验证：
1. finalize 定稿不再排在在途的慢 interim 后面（旧串行设计下要等 ~1.6s）；
2. interim 正常出字、定稿正常派发、迟到 interim 被丢弃。

用法：../env/bin/python scripts/verify_generic_parallel_final.py
"""

from __future__ import annotations

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from services.stt.engines import GenericHTTPSTT  # noqa: E402
from services.stt.generic_streaming import GenericInterimTranscriber  # noqa: E402

SLOW_SEC = 0.8


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        while length > 0:
            chunk = self.rfile.read(min(length, 65536))
            if not chunk:
                break
            length -= len(chunk)
        time.sleep(SLOW_SEC)  # 模拟慢速 ASR 服务
        body = json.dumps({"text": "请介绍一下 Redis 的持久化机制"}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]

    engine = GenericHTTPSTT(
        api_base_url=f"http://127.0.0.1:{port}/v1",
        api_key="",
        model="mock-asr",
    )
    interims: list[tuple[int, str]] = []
    finals: list[tuple[int, str]] = []
    final_at: list[float] = []

    transcriber = GenericInterimTranscriber(
        engine=engine,
        transcribe_final=lambda audio, sr: engine.transcribe(audio, sr),
        sample_rate=16000,
        interval_ms=800,
        min_final_samples=1600,
        on_interim=lambda sid, text: interims.append((sid, text)),
        on_final=lambda sid, text: (finals.append((sid, text)), final_at.append(time.monotonic())),
    )
    transcriber.start()
    audio = np.zeros(16000 * 3, dtype=np.float32)  # 3 秒语音

    started = time.monotonic()
    transcriber.submit(audio)  # 慢 interim 开始在途
    time.sleep(0.1)  # 确认 interim 已发出
    transcriber.finalize(audio)  # 说话结束：定稿应立即并行发出

    deadline = started + 5.0
    while not finals and time.monotonic() < deadline:
        time.sleep(0.02)
    transcriber.finish(drain_timeout_sec=3.0)
    server.shutdown()

    assert finals, "定稿未到达"
    final_latency = final_at[0] - started
    print(f"final 到达耗时: {final_latency:.2f}s（慢服务单次 {SLOW_SEC}s）")
    print(f"interims={interims} finals={finals} dropped_late={transcriber.dropped_late_results}")
    assert final_latency < SLOW_SEC + 0.5, (
        f"定稿被在途 interim 阻塞：{final_latency:.2f}s >= {SLOW_SEC + 0.5:.2f}s"
    )
    print("PASS: 定稿与在途 interim 并行，未被阻塞")
    return 0


if __name__ == "__main__":
    sys.exit(main())
