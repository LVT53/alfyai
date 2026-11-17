"""Make a trial Hungarian voice from a reference recording on the local Zonos server, and render test lines.

Usage: python -I make_voice.py <label> <reference.wav> <out-dir> [start_s] [dur_s]
- Cuts the reference (optional), matches its loudness, caches it as a session voice (nothing is written to
  the zonos3 checkout), saves the voice's 192-d embedding as <label>.npy, and renders the test lines in
  embedding mode (what the product uses) and, where the voice allows it, reference mode for comparison.
"""

import base64
import io
import json
import os
import sys
import urllib.request

import numpy as np
import soundfile as sf

SERVER = "http://127.0.0.1:1921"
SESSION = "hu-voice-trials"
SEED = 1234
LINES = {
    "hu1": "Etesd a kovászt naponta egyszer, és tartsd meleg helyen, amíg a duplájára nem nő.",
    "hu2": "A recepthez két tojás, kétszázötven gramm liszt és másfél deciliter tej kell.",
    "hu3": "A határidő kétezer-huszonhat december harmadikán, csütörtökön délután négy órakor van.",
    "hu6": "Röviden: ha minden nap eteted, és meleg helyen tartod, körülbelül hat óra alatt megduplázódik. Elolvassam a hosszabb változatot is?",
    "hu7": "Tényleg holnap jön? Akkor addig még megetetem a kovászt, hogy reggelre szép legyen.",
    "hu8": ("A kovász lényegében liszt és víz keveréke, amelyben vadélesztők és tejsavbaktériumok élnek. "
            "Az első napokban alig történik valami, és ez teljesen természetes. Ha naponta egyszer eteted, és meleg helyen tartod, "
            "körülbelül egy hét múlva már elég erős lesz ahhoz, hogy kenyeret süss vele."),
}


def call(method: str, path: str, body: dict | None = None) -> bytes:
    req = urllib.request.Request(SERVER + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "X-TTS-Session-ID": SESSION})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def loudness_match(x: np.ndarray, sr: int, target_db: float = -20.0) -> np.ndarray:
    hop = int(0.02 * sr)
    rms = np.array([np.sqrt(np.mean(x[i:i + hop] ** 2) + 1e-12) for i in range(0, max(len(x) - hop, 1), hop)])
    active = rms[rms > rms.max() / 30]
    x = x * 10 ** ((target_db - 20 * np.log10(np.sqrt(np.mean(active ** 2)))) / 20)
    peak = float(np.max(np.abs(x)))
    return x * (0.89 / peak) if peak > 0.89 else x


def main() -> None:
    label, ref, out = sys.argv[1], sys.argv[2], sys.argv[3]
    start = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
    dur = float(sys.argv[5]) if len(sys.argv) > 5 else None
    os.makedirs(out, exist_ok=True)
    x, sr = sf.read(ref, dtype="float32")
    x = x.mean(axis=1) if x.ndim > 1 else x
    x = x[int(start * sr): int((start + dur) * sr) if dur else None]
    x = loudness_match(x, sr)
    buf = io.BytesIO(); sf.write(buf, x, sr, subtype="PCM_16", format="WAV")
    sf.write(os.path.join(out, f"{label}-reference.wav"), x, sr, subtype="PCM_16")
    spk = json.loads(call("POST", "/v2/speakers", {"label": label, "speaker_audio_base64": base64.b64encode(buf.getvalue()).decode(),
                                                   "speaker_audio_name": f"{label}.wav"}))
    print(label, "->", spk.get("id"), "modes", spk.get("speaker_modes"), "dim", spk.get("embedding_dim"), f"ref {len(x)/sr:.1f}s")
    try:
        emb = json.loads(call("GET", f"/v2/speakers/{spk['id']}/embedding"))
        np.save(os.path.join(out, f"{label}.npy"), np.asarray(emb["embedding"], dtype=np.float32))
    except Exception as e:  # not every voice exposes an embedding
        print("  no embedding:", e)
    variants = [("embedding", "embedding", None), ("studio", "embedding", {"room.clean": 2}), ("reference", "reference", None)]
    only_lines = [k for k in os.environ.get("VOICE_LINES", "").split(",") if k] or list(LINES)
    only_variants = [v for v in os.environ.get("VOICE_VARIANTS", "").split(",") if v] or [v[0] for v in variants]
    for name, mode, controls in [v for v in variants if v[1] in (spk.get("speaker_modes") or []) and v[0] in only_variants]:
        for key, text in [(k, LINES[k]) for k in only_lines]:
            body = {"text": text, "language": "hu", "format": "wav", "stream": False,
                    "speaker_embedding_id": spk["id"], "speaker_mode": mode, "seed": SEED}
            if controls:
                body["controls"] = controls
            y, ysr = sf.read(io.BytesIO(call("POST", "/v2/generate", body)), dtype="float32")
            sf.write(os.path.join(out, f"{label}-{name}-{key}.wav"), loudness_match(y, ysr), ysr, subtype="PCM_16")
        print("  rendered", name)


if __name__ == "__main__":
    main()
