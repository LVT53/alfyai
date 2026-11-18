"""Helpers the speech service's tests share: signals, level meters and an ffmpeg decode."""

import math
import subprocess

import numpy as np

from speech_service.audio import click_at
from speech_service.models import Voice

__all__ = [
    "SR",
    "VOICE",
    "click_at",
    "decode_mp3",
    "decoded_seconds",
    "peak_db",
    "question_clip",
    "rms_db",
    "shaped_clip",
    "tone",
    "voiced_clip",
]

SR = 44100
VOICE = Voice("default_test", {})


def tone(amp: float, seconds: float = 1.0) -> np.ndarray:
    """A 220 Hz sine of peak amplitude `amp`: float32, mono, at SR."""
    t = np.arange(round(seconds * SR)) / SR
    return (amp * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def rms_db(x: np.ndarray) -> float:
    """The RMS level of `x` in dBFS; -inf for silence."""
    rms = math.sqrt(float(np.mean(np.square(x, dtype=np.float64))))
    return 20 * math.log10(rms) if rms > 0 else -math.inf


def peak_db(x: np.ndarray) -> float:
    """The highest absolute sample of `x` in dBFS; -inf for silence."""
    peak = float(np.max(np.abs(x)))
    return 20 * math.log10(peak) if peak > 0 else -math.inf


def decode_mp3(mp3: bytes) -> np.ndarray:
    """`mp3` as ffmpeg decodes it: float32 mono at SR, with the encoder's delay and padding in it."""
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "-",
         "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
        input=mp3,
        capture_output=True,
        check=True,
    )
    return np.frombuffer(result.stdout, dtype="<f4")


def decoded_seconds(mp3: bytes) -> float:
    """How long `mp3` plays once ffmpeg has decoded it."""
    return len(decode_mp3(mp3)) / SR


def voiced_clip(f0, seconds: float) -> np.ndarray:
    """Speech-like sound whose pitch follows `f0` (a function from seconds to Hz): the first five
    harmonics of a falling or rising voice, faded in and out over 50 ms. float32, mono, at SR."""
    t = np.arange(round(seconds * SR)) / SR
    phase = 2 * np.pi * np.cumsum(f0(t)) / SR
    wave = sum(np.sin(k * phase) / k for k in range(1, 6))
    fade = np.minimum(1.0, np.minimum(t, seconds - t) / 0.05)
    return (0.3 * wave / np.max(np.abs(wave)) * fade).astype(np.float32)


def question_clip(rises: bool, seconds: float = 2.0) -> np.ndarray:
    """A voice that falls from 200 to 160 Hz and, in its last 0.3 s, either rises to 250 Hz (a question
    that was asked) or falls on to 130 Hz (the same words as a statement)."""
    last = seconds - 0.3
    end = 250.0 if rises else 130.0

    def f0(t):
        body = 200 - 40 * np.minimum(t, last) / last
        into = np.clip((t - last) / 0.3, 0, 1)
        return np.where(t > last, 160 + (end - 160) * into, body)

    return voiced_clip(f0, seconds)


def shaped_clip(points: list[tuple[float, float]], seconds: float = 2.0) -> np.ndarray:
    """A `voiced_clip` whose pitch passes through the (second, Hz) `points`, straight between them."""
    times, hertz = zip(*points)
    return voiced_clip(lambda t: np.interp(t, times, hertz), seconds)


def hungarian_question_clip(shape: str) -> np.ndarray:
    """2 s of a voice that comes down from 190 to 170 Hz and then, by `shape`: "rise-fall" peaks at 250 Hz
    a third of a second before the end and falls to 150 Hz (a Hungarian yes/no question); "late-peak" peaks
    0.15 s before the end; "final-rise" ends rising to 260 Hz (an English one); "plateau" peaks and stays up;
    "fall" falls on (a statement)."""
    body = [(0.0, 190.0), (1.4, 170.0)]
    ends = {
        "rise-fall": [(1.65, 250.0), (2.0, 150.0)],
        "final-rise": [(2.0, 260.0)],
        "plateau": [(1.65, 250.0), (2.0, 245.0)],
        "late-peak": [(1.85, 250.0), (2.0, 150.0)],
        "fall": [(2.0, 140.0)],
    }
    return shaped_clip(body + ends[shape], 2.0)
