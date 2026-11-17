"""Spike: can FuseAlign give word timings for Zonos read-aloud, in English and Hungarian?

Aligns generated clips twice (the written text, and the text the voice actually spoke after
normalization), maps spoken words back to the written words a reader sees, and compares a
naive character-proportional estimate against the aligner. Writes timings.json for the
karaoke page. Run with the zonos3 venv: python -I align_test.py <audition_dir> <out_json>
"""

import difflib
import json
import os
import re
import sys
import time

import numpy as np
import soundfile as sf
import torch
import zyphra_textnorm as tn
from fusealign_hub import load_aligner

AUD, OUT = sys.argv[1], sys.argv[2]

CLIPS = [
    ("voice-imogen-en1.wav", "en_us", "Feed the starter once a day, and keep it somewhere warm until it doubles in size."),
    ("norm-en2-en.wav", "en_us", "The recipe needs 2 eggs, 250 grams of flour and 1.5 decilitres of milk."),
    ("norm-en3-en.wav", "en_us", "The deadline is Thursday, December 3, 2026, at 4 p.m."),
    ("norm-en4-en.wav", "en_us", "Tomorrow it will be between 7 and 12 degrees, with a 40% chance of rain."),
    ("voice-americanmale-en1.wav", "en_us", "Feed the starter once a day, and keep it somewhere warm until it doubles in size."),
    ("voice-imogen-hu1.wav", "hu", "Etesd a kovászt naponta egyszer, és tartsd meleg helyen, amíg a duplájára nem nő."),
    ("norm-hu2-hu.wav", "hu", "A recepthez 2 tojás, 250 gramm liszt és 1,5 deciliter tej kell."),
    ("norm-hu3-hu.wav", "hu", "A határidő 2026. december 3-án, csütörtökön délután 4 órakor van."),
    ("norm-hu4-hu.wav", "hu", "A jegy ára 12 990 Ft, ami nagyjából 33 euró."),
    ("norm-hu5-hu.wav", "hu", "Holnap 7 és 12 fok között lesz a hőmérséklet, és 40% esély van esőre."),
    ("voice-americanmale-hu1.wav", "hu", "Etesd a kovászt naponta egyszer, és tartsd meleg helyen, amíg a duplájára nem nő."),
]

THREADS = 8
torch.set_num_threads(THREADS)


def key(tok: str) -> str:
    return re.sub(r"[^\w%]", "", tok.lower())


def speech_bounds(wav: np.ndarray, sr: int) -> tuple[float, float]:
    """First and last 20 ms frame louder than 1/30 of the clip's loudest frame."""
    hop = int(0.02 * sr)
    frames = [float(np.sqrt(np.mean(wav[i:i + hop] ** 2))) for i in range(0, len(wav) - hop, hop)]
    peak = max(frames) or 1.0
    loud = [i for i, e in enumerate(frames) if e > peak / 30]
    return (loud[0] * hop / sr, (loud[-1] + 1) * hop / sr) if loud else (0.0, len(wav) / sr)


def estimate(tokens: list[str], start: float, end: float) -> list[dict]:
    """Spread the speech time over words by letter count, with a small pause after punctuation."""
    weights = []
    for t in tokens:
        w = max(len(key(t)), 1) + 1.0
        if re.search(r"[,;:]$", t):
            w += 3.0
        elif re.search(r"[.!?]$", t):
            w += 5.0
        weights.append(w)
    total = sum(weights)
    out, t0 = [], start
    for tok, w in zip(tokens, weights):
        dur = (end - start) * w / total
        out.append({"word": tok, "start": round(t0, 3), "end": round(t0 + dur * 0.85, 3)})
        t0 += dur
    return out


def map_back(written: list[str], spoken: list[dict]) -> list[dict]:
    """Give each written token the time span of the spoken words it became."""
    a = [key(t) for t in written]
    b = [key(w["word"]) for w in spoken]
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    spans: list[dict | None] = [None] * len(written)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                w = spoken[j1 + k]
                spans[i1 + k] = {"start": w["start"], "end": w["end"]}
        elif i2 > i1 and j2 > j1:
            block = [w for w in spoken[j1:j2] if w["start"] is not None]
            if block:
                s, e = block[0]["start"], block[-1]["end"]
                # Several written tokens share one spoken run ("12 990 Ft"): split it evenly.
                step = (e - s) / (i2 - i1)
                for k in range(i2 - i1):
                    spans[i1 + k] = {"start": s + k * step, "end": s + (k + 1) * step, "block": True}
    return [{"word": t, **(sp or {"start": None, "end": None})} for t, sp in zip(written, spans)]


def as_dicts(words) -> list[dict]:
    return [{"word": w.word, "start": None if w.start is None else round(float(w.start), 3),
             "end": None if w.end is None else round(float(w.end), 3),
             "presence": round(float(w.presence), 3), "placed": bool(w.placed)} for w in words]


def main() -> None:
    t_load = time.perf_counter()
    aligner = load_aligner(device="cpu", batch_size=1)
    load_s = time.perf_counter() - t_load
    # Warm up once so the first clip's time is not the first forward's.
    wav0, sr0 = sf.read(os.path.join(AUD, CLIPS[0][0]), dtype="float32")
    aligner.align(torch.from_numpy(wav0), sr0, CLIPS[0][2])

    results = []
    for name, lang, text in CLIPS:
        path = os.path.join(AUD, name)
        if not os.path.exists(path):
            results.append({"clip": name, "missing": True})
            continue
        wav, sr = sf.read(path, dtype="float32")
        if wav.ndim > 1:
            wav = wav.mean(axis=1)
        dur = len(wav) / sr
        spoken_text = tn.normalize(text, lang)

        t = time.perf_counter()
        spoken = as_dicts(aligner.align(torch.from_numpy(wav), sr, spoken_text))
        t_spoken = time.perf_counter() - t
        t = time.perf_counter()
        direct = as_dicts(aligner.align(torch.from_numpy(wav), sr, text))
        t_direct = time.perf_counter() - t

        s0, s1 = speech_bounds(wav, sr)
        est = estimate(spoken_text.split(), s0, s1)
        written = text.split()
        mapped = map_back(written, spoken)
        est_written = estimate(written, s0, s1)

        placed = [w for w in spoken if w["start"] is not None]
        diffs = [abs(e["start"] - w["start"]) for e, w in zip(est, spoken) if w["start"] is not None]
        monotonic = all(placed[i]["start"] <= placed[i + 1]["start"] for i in range(len(placed) - 1))
        results.append({
            "clip": name, "lang": lang, "text": text, "spoken_text": spoken_text, "duration": round(dur, 3),
            "align_seconds_spoken": round(t_spoken, 3), "align_seconds_written": round(t_direct, 3),
            "speed_x_realtime": round(dur / t_spoken, 1),
            "words_total": len(spoken), "words_placed": len(placed),
            "min_presence": min((w["presence"] for w in spoken), default=None),
            "monotonic": monotonic,
            "estimate_vs_aligner_start_ms": {
                "median": round(float(np.median(diffs)) * 1000) if diffs else None,
                "p90": round(float(np.percentile(diffs, 90)) * 1000) if diffs else None,
                "max": round(max(diffs) * 1000) if diffs else None,
            },
            "spoken_words": spoken, "direct_written_words": direct,
            "written_from_spoken": mapped, "estimate_written": est_written,
        })
        r = results[-1]
        print(f"{name:30s} {lang:5s} dur {dur:5.2f}s align {t_spoken:5.2f}s ({r['speed_x_realtime']:4.1f}x) "
              f"placed {len(placed)}/{len(spoken)} minP {r['min_presence']} mono {monotonic} "
              f"est-vs-align median {r['estimate_vs_aligner_start_ms']['median']} ms p90 {r['estimate_vs_aligner_start_ms']['p90']} ms")

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"threads": THREADS, "load_seconds": round(load_s, 2), "clips": results}, f, ensure_ascii=False, indent=1)
    print(f"load {load_s:.1f}s, threads {THREADS}, wrote {OUT}")


if __name__ == "__main__":
    main()
