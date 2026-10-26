"""Aliyun Qwen streaming-ASR real-speech probe (diagnostic tool, ASCII-only logs).

Unlike ali_stream_probe.py (silence only), this feeds LOOPS OF REAL SPEECH so the
server actively transcribes and returns sentence events — the exact traffic shape
the app produces. Usage:

    python3 ali_speech_probe.py [wav_path]

wav must be 16kHz mono int16 (default: /tmp/preflight_phrase.wav).
Runs 5 minutes or until the connection really dies. Ctrl+C to stop early.
"""
import json
import os
import sys
import threading
import time
import wave

import websocket

URL = "wss://maas.qianwenaiapi.com/api-ws/v1/inference"
MODEL = "qwen-audio-3.1-asr-flash-streaming"
DURATION_SEC = 300
CHUNK_BYTES = 3200  # 100ms @16kHz int16 mono


def main() -> None:
    key = input("Paste Aliyun API key then Enter: ").strip()
    wav_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/preflight_phrase.wav"
    with wave.open(wav_path) as w:
        if (w.getframerate(), w.getsampwidth(), w.getnchannels()) != (16000, 2, 1):
            raise SystemExit("wav must be 16kHz mono int16")
        speech = w.readframes(w.getnframes())
    audio = speech + b"\x00" * 32000  # 1s silence gap -> server VAD sentence_end

    task_id = os.urandom(16).hex()
    run_task = {
        "header": {"task_id": task_id, "streaming": "duplex", "action": "run-task"},
        "payload": {
            "task_group": "audio", "task": "asr", "function": "recognition",
            "model": MODEL,
            "parameters": {"format": "pcm", "sample_rate": 16000, "max_sentence_silence": 600},
            "input": {},
        },
    }
    ws = websocket.create_connection(
        URL, header={"Authorization": "Bearer " + key}, timeout=10, enable_multithread=True,
    )
    ws.send(json.dumps(run_task))
    t0 = time.monotonic()
    state = {"stop": False}

    def sender() -> None:
        pos = 0
        while time.monotonic() - t0 < DURATION_SEC and not state["stop"]:
            try:
                ws.send_binary(audio[pos:pos + CHUNK_BYTES])
            except Exception as exc:
                print("%s SEND failed: %s" % (time.strftime("%H:%M:%S"), exc), flush=True)
                state["stop"] = True
                return
            pos = (pos + CHUNK_BYTES) % len(audio)
            time.sleep(0.1)

    threading.Thread(target=sender, daemon=True).start()
    print("start: feeding looped speech for %ds (Ctrl+C to stop early)" % DURATION_SEC, flush=True)
    print("note: timeout lines are NORMAL keepalive ticks; only DISCONNECTED is a real drop.", flush=True)
    try:
        while time.monotonic() - t0 < DURATION_SEC + 30 and not state["stop"]:
            try:
                msg = json.loads(ws.recv())
            except websocket.WebSocketTimeoutException:
                continue
            header = msg.get("header", {})
            ev = header.get("event", "")
            if ev == "task-started":
                print("%s task-started" % time.strftime("%H:%M:%S"), flush=True)
            elif ev == "task-failed":
                print("%s task-failed: %s" % (time.strftime("%H:%M:%S"), msg), flush=True)
                break
            elif ev == "result-generated":
                sentence = msg.get("payload", {}).get("output", {}).get("sentence", {})
                if sentence.get("sentence_end") and sentence.get("text"):
                    print("%s final: %s" % (time.strftime("%H:%M:%S"), sentence["text"][:40]), flush=True)
    except KeyboardInterrupt:
        print("manual stop", flush=True)
    except Exception as exc:
        print("%s DISCONNECTED: %s: %s" % (time.strftime("%H:%M:%S"), type(exc).__name__, exc), flush=True)
    state["stop"] = True


if __name__ == "__main__":
    main()
