"""Aliyun Qwen streaming-ASR connection probe (diagnostic tool, ASCII-only).

Builds the exact same duplex WebSocket task the app's interviewer stream uses,
then feeds 100ms silence chunks in real time for 6 minutes. Any disconnect
prints the exact error. Run: python3 ali_stream_probe.py  (needs websocket-client)
"""
import json
import os
import threading
import time

import websocket

URL = "wss://maas.qianwenaiapi.com/api-ws/v1/inference"
MODEL = "qwen-audio-3.1-asr-flash-streaming"
DURATION_SEC = 360


def main() -> None:
    key = input("Paste Aliyun API key then Enter: ").strip()
    task_id = os.urandom(16).hex()
    run_task = {
        "header": {"task_id": task_id, "streaming": "duplex", "action": "run-task"},
        "payload": {
            "task_group": "audio", "task": "asr", "function": "recognition",
            "model": MODEL, "parameters": {"format": "pcm", "sample_rate": 16000},
            "input": {},
        },
    }
    ws = websocket.create_connection(
        URL, header={"Authorization": "Bearer " + key}, timeout=10, enable_multithread=True,
    )
    ws.send(json.dumps(run_task))
    t0 = time.monotonic()

    def sender() -> None:
        silence = b"\x00" * 3200  # 100ms @16kHz int16
        while time.monotonic() - t0 < DURATION_SEC:
            try:
                ws.send_binary(silence)
            except Exception as exc:
                print("%s SEND failed: %s" % (time.strftime("%H:%M:%S"), exc), flush=True)
                return
            time.sleep(0.1)

    threading.Thread(target=sender, daemon=True).start()
    print("start: feeding silence for %ds (Ctrl+C to stop early)" % DURATION_SEC, flush=True)
    print("note: recv timeout is NORMAL during silence (server sends nothing);", flush=True)
    print("      only DISCONNECTED lines mean the connection really died.", flush=True)
    try:
        while time.monotonic() - t0 < DURATION_SEC + 60:
            try:
                msg = json.loads(ws.recv())
            except websocket.WebSocketTimeoutException:
                print("%s alive: %ds elapsed, no events (normal for silence)"
                      % (time.strftime("%H:%M:%S"), int(time.monotonic() - t0)), flush=True)
                continue
            ev = msg.get("header", {}).get("event", "")
            if ev == "task-started":
                print("%s task-started" % time.strftime("%H:%M:%S"), flush=True)
            elif ev == "task-failed":
                print("%s task-failed: %s" % (time.strftime("%H:%M:%S"), msg), flush=True)
                break
    except KeyboardInterrupt:
        print("manual stop", flush=True)
    except Exception as exc:
        print("%s DISCONNECTED: %s: %s" % (time.strftime("%H:%M:%S"), type(exc).__name__, exc), flush=True)


if __name__ == "__main__":
    main()
