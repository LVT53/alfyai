"""Pick the best-recorded Common Voice speakers per gender and build a ~55 s reference for each.

Usage: python -I pick_speakers.py <lang-dir with validated.tsv and clips/> <out-dir> [per_gender=10]

1. Reads validated.tsv, groups clips by speaker (client_id), keeps speakers who gave a gender and have >= 15 clips.
2. Scores each speaker on up to 4 decoded clips: treble (energy above 8 kHz), background (pause level below speech),
   clipping, and level consistency. Ranks per gender; keeps the top `per_gender`.
3. For each kept speaker, scores every clip, keeps the cleanest, trims their silences, and joins them with short
   pauses into a reference of about 55 s (44.1 kHz mono, 16-bit).
Outputs anonymous labels only (hu-f-01, hu-m-01, ...); speaker ids stay in this machine's summary.json.
The dataset's terms forbid identifying speakers and re-sharing files: keep everything local.
"""

import csv
import json
import os
import subprocess
import sys
from collections import defaultdict

import numpy as np
import soundfile as sf

SR = 44100


def decode(path: str) -> np.ndarray | None:
    p = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                       capture_output=True)
    if p.returncode != 0 or not p.stdout:
        return None
    return np.frombuffer(p.stdout, dtype=np.float32).copy()


def clip_stats(x: np.ndarray) -> dict | None:
    hop = int(0.02 * SR)
    if len(x) < hop * 20:
        return None
    rms = np.array([np.sqrt(np.mean(x[i:i + hop] ** 2) + 1e-12) for i in range(0, len(x) - hop, hop)])
    speech = rms > np.percentile(rms, 95) / 20
    if speech.sum() < 10 or (~speech).sum() < 5:
        return None
    floor = 20 * np.log10(np.median(rms[~speech]) / np.median(rms[speech]))
    X = np.abs(np.fft.rfft(x)) ** 2
    f = np.fft.rfftfreq(len(x), 1 / SR)
    treble = 10 * np.log10(X[f > 8000].sum() / X.sum() + 1e-20)
    clipped = float(np.mean(np.abs(x) > 0.99))
    level = 20 * np.log10(np.median(rms[speech]))
    idx = np.where(speech)[0]
    return {"floor": floor, "treble": treble, "clipped": clipped, "level": level,
            "start": max(0, idx[0] - 6) * hop, "end": min(len(x), (idx[-1] + 7) * hop)}


def score(s: dict) -> float:
    # Full treble is required (band-limited microphones score low), and a background below -80 dB earns nothing
    # extra: that is a browser's noise gate zeroing the pauses, not a quiet studio.
    treble_penalty = max(0.0, -35.0 - s["treble"]) * 2.0
    return min(-s["floor"], 80.0) * 0.6 + s["treble"] * 0.4 - treble_penalty - s["clipped"] * 2000


def gender_of(g: str) -> str | None:
    g = (g or "").lower()
    if g.startswith("male"):
        return "m"
    if g.startswith("female"):
        return "f"
    return None


def main() -> None:
    lang_dir, out = sys.argv[1], sys.argv[2]
    per_gender = int(sys.argv[3]) if len(sys.argv) > 3 else 10
    os.makedirs(out, exist_ok=True)
    clips = defaultdict(list)
    gender = {}
    with open(os.path.join(lang_dir, "validated.tsv"), encoding="utf-8") as fh:
        for row in csv.DictReader(fh, delimiter="\t", quoting=csv.QUOTE_NONE):
            g = gender_of(row.get("gender", ""))
            if not g:
                continue
            clips[row["client_id"]].append(row["path"])
            gender[row["client_id"]] = g
    speakers = [s for s, c in clips.items() if len(c) >= 15]
    print(f"speakers with a gender and >= 15 clips: {len(speakers)} (f {sum(gender[s] == 'f' for s in speakers)}, m {sum(gender[s] == 'm' for s in speakers)})")

    ranked = {"f": [], "m": []}
    for n, spk in enumerate(speakers, 1):
        sample = clips[spk][:: max(1, len(clips[spk]) // 4)][:4]
        stats = [s for s in (clip_stats(x) for x in (decode(os.path.join(lang_dir, "clips", p)) for p in sample) if x is not None) if s]
        if len(stats) < 3:
            continue
        levels = [s["level"] for s in stats]
        sc = float(np.mean([score(s) for s in stats])) - float(np.std(levels)) * 0.5
        ranked[gender[spk]].append((sc, spk, {k: round(float(np.mean([s[k] for s in stats])), 1) for k in ("floor", "treble")}))
        if n % 100 == 0:
            print(f"  scored {n}/{len(speakers)}")

    summary = []
    for g in ("f", "m"):
        ranked[g].sort(reverse=True)
        for i, (sc, spk, stats) in enumerate(ranked[g][:per_gender], 1):
            label = f"hu-{g}-{i:02d}"
            parts, total = [], 0.0
            scored = []
            for p in clips[spk][:80]:                                   # enough to fill 55 s with the cleanest
                x = decode(os.path.join(lang_dir, "clips", p))
                s = clip_stats(x) if x is not None else None
                if s and s["clipped"] < 0.0005:
                    scored.append((score(s), x[s["start"]:s["end"]]))
            scored.sort(key=lambda t: t[0], reverse=True)
            gap = np.zeros(int(0.35 * SR), dtype=np.float32)
            for _, seg in scored:
                if total > 55:
                    break
                seg = seg / (np.sqrt(np.mean(seg ** 2)) + 1e-9) * 0.08     # even level between clips
                parts += [seg, gap]
                total += (len(seg) + len(gap)) / SR
            ref = np.concatenate(parts)
            ref = ref * min(1.0, 0.89 / (np.max(np.abs(ref)) + 1e-9))
            sf.write(os.path.join(out, f"{label}.wav"), ref, SR, subtype="PCM_16")
            summary.append({"label": label, "gender": g, "score": round(sc, 1), "clips_used": len(parts) // 2,
                            "seconds": round(total, 1), **stats, "speaker": spk})
            print(f"{label}: score {sc:.1f}, background {stats['floor']} dB, treble {stats['treble']} dB, {total:.0f} s from {len(parts)//2} clips")
    json.dump(summary, open(os.path.join(out, "summary.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
