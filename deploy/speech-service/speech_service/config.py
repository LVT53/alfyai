"""Settings for the speech service, read once from the environment.

The service answers on loopback only. A Settings with any other host cannot be
built, so a mistyped SPEECH_HOST stops the service instead of exposing it.
"""

from __future__ import annotations

import ipaddress
import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Literal, cast, get_args

# The longest silence a setting may name, in seconds.
_LONGEST_GAP = 5.0
_LONGEST_BREATH = 1.0

AlignerKind = Literal["python", "native", "none"]
_ALIGNERS = get_args(AlignerKind)


def _is_loopback(host: str) -> bool:
    """True for localhost and for any address in 127.0.0.0/8 or ::1."""
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _read[T](env: Mapping[str, str], name: str, default: T, parse: Callable[[str], T]) -> T:
    """`env[name]` run through `parse`, or `default` when the variable is unset."""
    if name not in env:
        return default
    try:
        return parse(env[name])
    except ValueError:
        raise ValueError(f"{name}={env[name]!r} is not a valid {parse.__name__}") from None


@dataclass(frozen=True)
class Settings:
    zonos_url: str = "http://127.0.0.1:1919"
    host: str = "127.0.0.1"
    port: int = 1920
    prefetch: int = 2
    seed: int = 1234
    aligner: AlignerKind = "python"
    aligner_model: str | None = None
    # The native FuseAlign backend runs `aligner_cli` on `aligner_threads` threads.
    aligner_cli: str = "fusealign-cli"
    aligner_threads: int = 4
    idle_seconds: float = 30.0
    # How many clips of a sentence are made at most when Zonos stalls on it (`steady.py`): the first
    # attempt and the retries under the next seeds. 1 turns the retries off.
    steady_attempts: int = 4
    # The silence between two sentences, and before the first sentence of a paragraph: a reader's
    # pause at a full stop is about half a second, and a new paragraph a good deal longer. (Until
    # 2026-11-17 they were 0.30 s and 0.60 s, which ran sentences together.)
    gap_seconds: float = 0.5
    paragraph_gap_seconds: float = 0.9
    # What each pause of 0.12 s or more inside a sentence is lengthened by (`audio.lengthen_pauses`):
    # Zonos pauses at a comma for a tenth of a second or two. 0 leaves the pauses as Zonos made them.
    breath_seconds: float = 0.15
    # Zonos caps a request at 1500 frames (about 100 s). Not an environment setting.
    max_sentence_chars: int = 400

    def __post_init__(self) -> None:
        if not _is_loopback(self.host):
            raise ValueError(
                "SPEECH_HOST must be localhost or a loopback address (127.0.0.0/8, ::1), "
                f"got {self.host!r}"
            )
        if self.aligner not in _ALIGNERS:
            raise ValueError(
                f"SPEECH_ALIGNER must be one of {', '.join(_ALIGNERS)}, got {self.aligner!r}"
            )
        if not 1 <= self.port <= 65535:
            raise ValueError(f"SPEECH_PORT must be from 1 to 65535, got {self.port}")
        # A negative prefetch parks every session at its gate before the first sentence, and an idle
        # time of nothing ends every session as it starts. An endless one (inf) is as bad the other
        # way: a session nobody reads never ends, and an ended one is never forgotten.
        if self.prefetch < 0:
            raise ValueError(f"SPEECH_PREFETCH must be 0 or more, got {self.prefetch}")
        if not (math.isfinite(self.idle_seconds) and self.idle_seconds > 0):  # nan is neither
            raise ValueError(
                f"SPEECH_IDLE_SECONDS must be a finite number above 0, got {self.idle_seconds}"
            )
        if self.aligner_threads < 1:
            raise ValueError(
                f"SPEECH_ALIGNER_THREADS must be 1 or more, got {self.aligner_threads}"
            )
        # A silence is a short, finite, non-negative time: a negative one would cut speech, an endless
        # one stops a reading, and nine seconds is a typo (nan is neither finite nor in range).
        for name, seconds, longest in (
            ("SPEECH_GAP_SECONDS", self.gap_seconds, _LONGEST_GAP),
            ("SPEECH_PARAGRAPH_GAP_SECONDS", self.paragraph_gap_seconds, _LONGEST_GAP),
            ("SPEECH_BREATH_SECONDS", self.breath_seconds, _LONGEST_BREATH),
        ):
            if not (math.isfinite(seconds) and 0 <= seconds <= longest):
                raise ValueError(f"{name} must be a number from 0 to {longest:g}, got {seconds}")
        # No attempt at all would be no clip, ever.
        if self.steady_attempts < 1:
            raise ValueError(
                f"SPEECH_STEADY_ATTEMPTS must be 1 or more, got {self.steady_attempts}"
            )

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> Settings:
        """The settings `env` sets through SPEECH_* variables; the rest keep their defaults.

        A string setting that is blank counts as unset.
        """
        defaults = cls()
        return cls(
            zonos_url=env.get("SPEECH_ZONOS_URL") or defaults.zonos_url,
            host=env.get("SPEECH_HOST") or defaults.host,
            port=_read(env, "SPEECH_PORT", defaults.port, int),
            prefetch=_read(env, "SPEECH_PREFETCH", defaults.prefetch, int),
            seed=_read(env, "SPEECH_SEED", defaults.seed, int),
            # Checked in __post_init__.
            aligner=cast(AlignerKind, env.get("SPEECH_ALIGNER") or defaults.aligner),
            aligner_model=env.get("SPEECH_ALIGNER_MODEL") or defaults.aligner_model,
            aligner_cli=env.get("SPEECH_ALIGNER_CLI") or defaults.aligner_cli,
            aligner_threads=_read(env, "SPEECH_ALIGNER_THREADS", defaults.aligner_threads, int),
            idle_seconds=_read(env, "SPEECH_IDLE_SECONDS", defaults.idle_seconds, float),
            steady_attempts=_read(
                env, "SPEECH_STEADY_ATTEMPTS", defaults.steady_attempts, int
            ),
            gap_seconds=_read(env, "SPEECH_GAP_SECONDS", defaults.gap_seconds, float),
            paragraph_gap_seconds=_read(
                env, "SPEECH_PARAGRAPH_GAP_SECONDS", defaults.paragraph_gap_seconds, float
            ),
            breath_seconds=_read(env, "SPEECH_BREATH_SECONDS", defaults.breath_seconds, float),
        )
