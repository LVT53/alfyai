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
    "rms_db",
    "tone",
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
