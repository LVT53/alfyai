"""Settings for the speech service, read once from the environment.

The service answers on loopback only. A Settings with any other host cannot be
built, so a mistyped SPEECH_HOST stops the service instead of exposing it.
"""

from __future__ import annotations

import ipaddress
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Literal, cast, get_args

Aligner = Literal["python", "native", "none"]
_ALIGNERS = get_args(Aligner)


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
    aligner: Aligner = "python"
    aligner_model: str | None = None
    # The native FuseAlign backend runs `aligner_cli` on `aligner_threads` threads.
    aligner_cli: str = "fusealign-cli"
    aligner_threads: int = 4
    idle_seconds: float = 30.0
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

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> Settings:
        """The settings `env` sets through SPEECH_* variables; the rest keep their defaults."""
        defaults = cls()
        return cls(
            zonos_url=env.get("SPEECH_ZONOS_URL", defaults.zonos_url),
            host=env.get("SPEECH_HOST", defaults.host),
            port=_read(env, "SPEECH_PORT", defaults.port, int),
            prefetch=_read(env, "SPEECH_PREFETCH", defaults.prefetch, int),
            seed=_read(env, "SPEECH_SEED", defaults.seed, int),
            # Checked in __post_init__.
            aligner=cast(Aligner, env.get("SPEECH_ALIGNER", defaults.aligner)),
            aligner_model=env.get("SPEECH_ALIGNER_MODEL", defaults.aligner_model),
            aligner_cli=env.get("SPEECH_ALIGNER_CLI", defaults.aligner_cli),
            aligner_threads=_read(env, "SPEECH_ALIGNER_THREADS", defaults.aligner_threads, int),
            idle_seconds=_read(env, "SPEECH_IDLE_SECONDS", defaults.idle_seconds, float),
        )
