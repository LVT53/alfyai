"""Pick the cleanest stretch of a long recording to make a voice from.

Scans windows of `length` seconds (default 55) every 2.5 s and scores each one:
  steady speech   : share of 20 ms frames with speech, best between 0.65 and 0.90 (no long silences, some pauses)
  quiet background: the pause frames' level below the speech frames' level (lower is better)
  full treble     : energy above 10 kHz relative to the whole window (higher is better)
  no clipping     : no samples at full scale
Cuts the best window at the nearest pause on both sides and writes it as 44.1 kHz mono 16-bit WAV.
Usage: python -I pick_segment.py <in-audio> <out.wav> [length_s]
Any format ffmpeg reads is accepted (decoded to a temporary WAV first).
"""

import os
import subprocess
import sys
import tempfile

import numpy as np
import soundfile as sf


def load(path: str) -> tuple[np.ndarray, int]:
    with tempfile.TemporaryDirectory() as d:
        wav = os.path.join(d, "in.wav")
        subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", path, "-ac", "1", "-ar", "44100", wav], check=True)
        x, sr = sf.read(wav, dtype="float32")
    return x, sr


def main() -> None:
    src, out = sys.argv[1], sys.argv[2]
    length = float(sys.argv[3]) if len(sys.argv) > 3 else 55.0
    x, sr = load(src)
    hop = int(0.02 * sr)
    rms = np.array([np.sqrt(np.mean(x[i:i + hop] ** 2) + 1e-12) for i in range(0, len(x) - hop, hop)])
    thr = np.percentile(rms, 95) / 20
    speech = rms > thr
    win, step = int(length / 0.02), int(2.5 / 0.02)
    best = None
    for s in range(0, max(1, len(rms) - win), step):
        seg = slice(s, s + win)
        act = speech[seg].mean()
        sp, pa = rms[seg][speech[seg]], rms[seg][~speech[seg]]
        if len(sp) < 10 or len(pa) < 10:
            continue
        floor = 20 * np.log10(np.median(pa) / np.median(sp))
        a, b = s * hop, (s + win) * hop
        X = np.abs(np.fft.rfft(x[a:b])) ** 2
        f = np.fft.rfftfreq(b - a, 1 / sr)
        treble = 10 * np.log10(X[f > 10000].sum() / X.sum() + 1e-20)
        clipped = float(np.mean(np.abs(x[a:b]) > 0.995))
        steady = -abs(act - 0.78) * 40
        score = steady - floor * 0.6 + treble * 0.3 - clipped * 1000
        if best is None or score > best[0]:
            best = (score, s, act, floor, treble, clipped)
    if best is None:
        sys.exit("no usable window")
    _, s, act, floor, treble, clipped = best
    # Move both edges to the nearest pause so no word is cut.
    def to_pause(i: int, direction: int) -> int:
        while 0 < i < len(speech) - 1 and speech[i]:
            i += direction
        return i
    a, b = to_pause(s, -1) * hop, to_pause(s + win, -1) * hop
    sf.write(out, x[a:b], sr, subtype="PCM_16")
    print(f"picked {a/sr:.1f}-{b/sr:.1f} s of {len(x)/sr:.0f} s: speech {act:.0%}, background {floor:.1f} dB below speech, "
          f"treble {treble:.1f} dB, clipping {clipped:.4%}")


if __name__ == "__main__":
    main()
