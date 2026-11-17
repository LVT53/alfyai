"""Does Zonos mark questions with intonation? Render statement/question pairs and measure the pitch at the end.

Writes the clips to intonation/ and prints, per clip, the pitch of the last stretch of speech against the
speaker's median (semitones) and where the highest pitch of the final word region falls.
"""

import io
import json
import os
import urllib.request

import numpy as np
import soundfile as sf

SERVER, SESSION, SEED = "http://127.0.0.1:1921", "hu-voice-trials", 1234
IMOGEN = "default_b78b28baf5c31a1d"
PAIRS = [
    ("en", "en_us", IMOGEN, "en-statement", "I will read you the long one."),
    ("en", "en_us", IMOGEN, "en-question", "Shall I read you the long one?"),
    ("en", "en_us", IMOGEN, "en-intonation-only-question", "You want me to read the long one?"),
    ("hu", "hu", None, "hu-statement", "Elolvasod a hosszabb változatot is."),
    ("hu", "hu", None, "hu-question", "Elolvasod a hosszabb változatot is?"),
    ("hu", "hu", None, "hu-question-2", "Elolvassam a hosszabb változatot is?"),
]


def call(path: str, body: dict | None = None) -> bytes:
    req = urllib.request.Request(SERVER + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "X-TTS-Session-ID": SESSION})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def f0_track(x: np.ndarray, sr: int) -> np.ndarray:
    hop, win = int(0.01 * sr), int(0.04 * sr)
    out = []
    for i in range(0, len(x) - win, hop):
        fr = x[i:i + win] - x[i:i + win].mean()
        if np.sqrt(np.mean(fr ** 2)) < 0.02 * np.max(np.abs(x)):
            out.append(np.nan); continue
        ac = np.correlate(fr, fr, "full")[win - 1:]
        lo, hi = int(sr / 400), int(sr / 70)
        k = lo + int(np.argmax(ac[lo:hi]))
        out.append(sr / k if ac[k] > 0.35 * ac[0] else np.nan)
    return np.array(out)


def main() -> None:
    os.makedirs("intonation", exist_ok=True)
    fleurs = [s for s in json.loads(call("/v2/speakers"))["speakers"] if s.get("label") == "fleurs-hu"][-1]["id"]
    for _, lang, voice, name, text in PAIRS:
        wav = call("/v2/generate", {"text": text, "language": lang, "format": "wav", "stream": False, "seed": SEED,
                                    "speaker_embedding_id": voice or fleurs, "speaker_mode": "embedding"})
        x, sr = sf.read(io.BytesIO(wav), dtype="float32")
        sf.write(f"intonation/{name}.wav", x, sr, subtype="PCM_16")
        f0 = f0_track(x, sr)
        voiced = np.where(~np.isnan(f0))[0]
        med = np.nanmedian(f0)
        tail = f0[voiced[int(len(voiced) * 0.8):]]          # the last fifth of the voiced frames
        last = f0[voiced[-8:]]                               # the final ~80 ms of voicing
        st = lambda v: 12 * np.log2(np.nanmedian(v) / med)
        peak_pos = (np.nanargmax(tail) + 1) / len(tail)
        print(f"{name:30s} tail {st(tail):+5.1f} st  final {st(last):+5.1f} st  peak of the tail at {peak_pos:4.0%}")


if __name__ == "__main__":
    main()
