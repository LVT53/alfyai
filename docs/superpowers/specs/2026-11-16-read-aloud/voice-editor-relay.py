"""Local relay for the voice-editor prototype.

Serves the prototype page and turns POST /tts {voice, lang, text, knobs} into a Zonos request on
127.0.0.1:1921 with the measured knob mapping, a fixed seed and loudness matching. Loopback only.
Run: python -I relay.py <port> <dir-with-html>
"""

import hashlib
import io
import json
import os
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import soundfile as sf

PORT, ROOT = int(sys.argv[1]), sys.argv[2]
ZONOS = "http://127.0.0.1:1921/v2/generate"
SEED = 1234
CACHE: dict[str, bytes] = {}

# UI value -> request controls, from the measured Studio bundle mapping; clamped to the safe ranges.
SAFE = {"pace": (-2, 2), "pitch": (-2, 2), "depth": (0, 4), "energy": (-4, 4), "projection": (-1.5, 2)}


def controls_for(knobs: dict) -> dict:
    c: dict[str, float] = {}
    v = {k: max(SAFE[k][0], min(SAFE[k][1], float(knobs.get(k, 0)))) for k in SAFE}
    if v["pace"]:
        c["delivery.tempo"] = v["pace"]
    if v["pitch"]:
        c["pitch.pitch"] = v["pitch"]
    if v["depth"]:
        c["texture.deep"] = v["depth"]
    if v["energy"]:
        c["mood.arousal"] = v["energy"]
    if v["projection"] < 0:
        c["delivery.whisper"] = -v["projection"]
    elif v["projection"] > 0:
        c["delivery.loud"] = v["projection"]
    return c


def match_loudness(wav: bytes, target_db: float = -20.0, peak_db: float = -1.0) -> bytes:
    x, sr = sf.read(io.BytesIO(wav), dtype="float32")
    if x.ndim > 1:
        x = x.mean(axis=1)
    hop = int(0.02 * sr)
    rms = np.array([np.sqrt(np.mean(x[i:i + hop] ** 2) + 1e-12) for i in range(0, max(len(x) - hop, 1), hop)])
    active = rms[rms > rms.max() / 30] if len(rms) else rms
    if len(active):
        x = x * 10 ** ((target_db - 20 * np.log10(np.sqrt(np.mean(active ** 2)))) / 20)
    peak, lim = float(np.max(np.abs(x))) if len(x) else 0.0, 10 ** (peak_db / 20)
    if peak > lim:
        x = x * (lim / peak)
    out = io.BytesIO()
    sf.write(out, x, sr, subtype="PCM_16", format="WAV")
    return out.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # keep the console quiet
        pass

    def do_GET(self):
        name = os.path.basename(self.path.split("?")[0]) or "voice-editor.html"
        path = os.path.join(ROOT, name)
        if not os.path.isfile(path):
            self.send_error(404)
            return
        body = open(path, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8" if name.endswith(".html") else "application/octet-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/tts":
            self.send_error(404)
            return
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        payload = {
            "text": str(req.get("text", ""))[:400],
            "language": "hu" if req.get("lang") == "hu" else "en_us",
            "format": "wav",
            "stream": False,
            "speaker_embedding_id": str(req.get("voice", "")),
            "speaker_mode": "embedding",
            "seed": SEED,
        }
        ctl = controls_for(req.get("knobs") or {})
        if ctl:
            payload["controls"] = ctl
        key = hashlib.sha1(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        if key not in CACHE:
            r = urllib.request.Request(ZONOS, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(r, timeout=60) as resp:
                    CACHE[key] = match_loudness(resp.read())
            except Exception as e:  # report the failure to the page
                msg = str(e).encode()
                self.send_response(502)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(msg)
                return
        body = CACHE[key]
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("X-Controls", json.dumps(ctl))
        self.end_headers()
        self.wfile.write(body)


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
