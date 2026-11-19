"""Build a ~55 s voice reference from a single speaker's folder of short clips (FLAC, WEBM, WAV, MP3...).

Scores every clip (background below speech, treble, clipping), keeps the cleanest, trims silences, evens the level,
and joins them with 350 ms pauses. Prints the overall measurements of the speaker's recordings.
Usage: python -I ref_from_clips.py <clips-dir> <out.wav> [seconds=55]
"""

import os
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pick_speakers import SR, clip_stats, decode, score  # noqa: E402

src, out = sys.argv[1], sys.argv[2]
target = float(sys.argv[3]) if len(sys.argv) > 3 else 55.0
files = sorted(os.path.join(d, f) for d, _, fs in os.walk(src) for f in fs if f.lower().endswith((".flac", ".webm", ".wav", ".mp3", ".ogg", ".opus")))
scored, all_stats = [], []
for p in files:
    x = decode(p)
    s = clip_stats(x) if x is not None else None
    if s:
        all_stats.append(s)
        if s["clipped"] < 0.0005:
            scored.append((score(s), x[s["start"]:s["end"]]))
scored.sort(key=lambda t: t[0], reverse=True)
gap = np.zeros(int(0.35 * SR), dtype=np.float32)
parts, total = [], 0.0
for _, seg in scored:
    if total > target:
        break
    seg = seg / (np.sqrt(np.mean(seg ** 2)) + 1e-9) * 0.08
    parts += [seg, gap]
    total += (len(seg) + len(gap)) / SR
ref = np.concatenate(parts)
ref = ref * min(1.0, 0.89 / (np.max(np.abs(ref)) + 1e-9))
sf.write(out, ref, SR, subtype="PCM_16")
med = lambda k: float(np.median([s[k] for s in all_stats]))
print(f"{os.path.basename(out)}: {len(files)} clips, median background {med('floor'):.1f} dB, median treble {med('treble'):.1f} dB, "
      f"clipped clips {sum(s['clipped'] > 0.0005 for s in all_stats)}; reference {total:.0f} s from {len(parts)//2} clips")
