"""A rough recording-quality fingerprint of voice clips, to compare trial voices with Imogen.

high band  : energy above 10 kHz relative to the whole clip (closer to 0 = brighter, fuller band)
floor      : the quiet frames' level below the loud frames' level (more negative = cleaner background)
centroid   : spectral centroid of the voiced frames (Hz)
f0         : median pitch of the voiced frames (Hz), to tell a woman's from a man's voice
Usage: python -I fingerprint.py <wav> [<wav> ...]
"""

import sys

import numpy as np
import soundfile as sf


def fingerprint(path: str) -> dict:
    x, sr = sf.read(path, dtype="float32")
    x = x.mean(axis=1) if x.ndim > 1 else x
    X = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
    f = np.fft.rfftfreq(len(x), 1 / sr)
    high = 10 * np.log10(X[f > 10000].sum() / X.sum() + 1e-20)
    hop, win = int(0.02 * sr), int(0.04 * sr)
    frames = [x[i:i + win] for i in range(0, len(x) - win, hop)]
    rms = np.array([np.sqrt(np.mean(fr ** 2) + 1e-12) for fr in frames])
    floor = 20 * np.log10(np.percentile(rms, 8) / np.percentile(rms, 90))
    cents, f0 = [], []
    loud = rms > np.percentile(rms, 60)
    for fr, ok in zip(frames, loud):
        if not ok:
            continue
        S = np.abs(np.fft.rfft(fr * np.hanning(len(fr))))
        ff = np.fft.rfftfreq(len(fr), 1 / sr)
        cents.append((S * ff).sum() / (S.sum() + 1e-12))
        fr = fr - fr.mean()
        ac = np.correlate(fr, fr, "full")[len(fr) - 1:]
        lo, hi = int(sr / 400), int(sr / 70)
        k = lo + int(np.argmax(ac[lo:hi]))
        if ac[k] > 0.3 * ac[0]:
            f0.append(sr / k)
    return {"high_db": round(high, 1), "floor_db": round(floor, 1), "centroid": int(np.median(cents)), "f0": int(np.median(f0)) if f0 else None,
            "dur": round(len(x) / sr, 1), "sr": sr}


for p in sys.argv[1:]:
    d = fingerprint(p)
    print(f"{p.split('/')[-1]:38s} high {d['high_db']:6.1f} dB  floor {d['floor_db']:6.1f} dB  centroid {d['centroid']:5d} Hz  f0 {d['f0']} Hz  {d['dur']} s @ {d['sr']}")
