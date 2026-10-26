"""Aliyun streaming ASR drop reproducer: speech <-> quiet cycles.

Mimics the app's exact traffic pattern (100ms PCM chunks continuously,
protocol ping every 25s) but alternates speech / quiet phases, because
field drops happen when speech resumes after a quiet period.

Logs every control frame (pong/close) and the exact moment + phase of any
disconnect, so we can tell a bare TCP FIN ('Connection to remote host was
lost') from a graceful server task-failed.

Usage: python3 ali_cycle_probe.py [--no-ping] [--minutes 15]
API key: reads the app config if present, otherwise asks via input().
"""
import json
import os
import sys
import threading
import time
import wave

try:
    import websocket
except ImportError:
    sys.exit("websocket-client not installed: pip3 install websocket-client")

URL = "wss://maas.qianwenaiapi.com/api-ws/v1/inference"
MODEL = "qwen-audio-3.1-asr-flash-streaming"
CONFIG = os.path.expanduser(
    "~/Library/Application Support/interview-assistant-desktop/config.json"
)
WAV_CANDIDATES = [
    os.path.join(os.path.dirname(__file__), "..", "backend", "assets", "preflight_phrase.wav"),
    "/tmp/preflight_phrase.wav",
]
CHUNK = 3200            # 100ms @ 16kHz int16
SILENCE = b"\x00" * CHUNK
SPEECH_SEC = 30
QUIET_SEC = 45
PING_EVERY = 25.0

def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)

def load_key():
    try:
        with open(CONFIG) as f:
            key = json.load(f).get("aliyun_stt_api_key", "").strip()
            if key:
                return key
    except Exception:
        pass
    return input("Aliyun API key: ").strip()

def load_speech():
    for path in WAV_CANDIDATES:
        if os.path.exists(path):
            with wave.open(path) as w:
                return w.readframes(w.getnframes())
    sys.exit("no wav found (backend/assets/preflight_phrase.wav)")

def main():
    with_ping = "--no-ping" not in sys.argv
    minutes = 15
    for i, arg in enumerate(sys.argv):
        if arg == "--minutes" and i + 1 < len(sys.argv):
            minutes = int(sys.argv[i + 1])
    key = load_key()
    speech = load_speech()
    log("start: ping=%s duration=%dmin speech=%ds quiet=%ds"
        % (with_ping, minutes, SPEECH_SEC, QUIET_SEC))

    task_id = os.urandom(16).hex()
    ws = websocket.create_connection(
        URL, header={"Authorization": "Bearer " + key},
        timeout=10, enable_multithread=True,
    )
    ws.send(json.dumps({
        "header": {"task_id": task_id, "streaming": "duplex", "action": "run-task"},
        "payload": {"task_group": "audio", "task": "asr", "function": "recognition",
                    "model": MODEL,
                    "parameters": {"format": "pcm", "sample_rate": 16000},
                    "input": {}},
    }))

    stop = threading.Event()
    state = {"phase": "startup", "phase_t0": time.monotonic()}
    t0 = time.monotonic()

    def sender():
        pos = 0
        while not stop.is_set():
            phase = "speech" if (time.monotonic() - t0) % (SPEECH_SEC + QUIET_SEC) < SPEECH_SEC else "quiet"
            state["phase"] = phase
            data = speech[pos:pos + CHUNK] if phase == "speech" else SILENCE
            if not data:
                pos = 0
                data = speech[:CHUNK]
            pos = (pos + CHUNK) % len(speech)
            try:
                ws.send_binary(data)
            except Exception as exc:
                log("SEND failed in phase=%s: %s" % (phase, exc))
                stop.set()
                return
            time.sleep(0.1)

    def pinger():
        if not with_ping:
            return
        while not stop.wait(PING_EVERY):
            try:
                ws.ping()
                log("ping sent")
            except Exception as exc:
                log("PING failed: %s" % exc)
                stop.set()
                return

    threading.Thread(target=sender, daemon=True).start()
    threading.Thread(target=pinger, daemon=True).start()

    ws.settimeout(5)
    last_phase = None
    try:
        while time.monotonic() - t0 < minutes * 60:
            try:
                frame = ws.recv_frame()
            except websocket.WebSocketTimeoutException:
                continue  # 5s no data: normal during quiet, connection still open
            if frame.opcode == 9:
                log("<< ping from server")
                continue
            if frame.opcode == 10:
                log("<< PONG (server answered heartbeat)")
                continue
            if frame.opcode == 8:
                log("<< CLOSE frame: %r -- server closed websocket gracefully"
                    % (frame.data[:80],))
                break
            if not frame.data:
                log("EOF: empty data frame (bare TCP FIN)")
                break
            try:
                header = json.loads(frame.data).get("header", {})
            except ValueError:
                continue
            event = header.get("event", "")
            if event == "task-started":
                log("task-started")
            elif event == "task-failed":
                log("task-failed: %s %s"
                    % (header.get("error_code"), header.get("error_message")))
                break
            elif event == "result-generated":
                if state["phase"] != last_phase:
                    last_phase = state["phase"]
                    log("phase=%s: results flowing again" % last_phase)
    except Exception as exc:
        age = time.monotonic() - t0
        log("DISCONNECTED after %.0fs, phase=%s: %s: %s"
            % (age, state["phase"], type(exc).__name__, exc))
    finally:
        stop.set()
        try:
            ws.close()
        except Exception:
            pass
    log("done")

if __name__ == "__main__":
    main()
