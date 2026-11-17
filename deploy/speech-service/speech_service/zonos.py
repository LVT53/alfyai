"""The Zonos client: one sentence in, its audio out.

Zonos answers a request it does not recognise (an unknown field) with 422, so the request here
carries exactly the fields the service's contract names and nothing else. Errors never quote the
sentence: a message carries a status code or the kind of failure, never the text.
"""

from __future__ import annotations

import io

import httpx
import numpy as np
import soundfile as sf

from speech_service.models import Voice

# The service says "en"; Zonos says "en_us". (Hungarian is "hu" in both.)
_ZONOS_LANGUAGES = {"en": "en_us", "hu": "hu"}

# Zonos serves requests first-in-first-out, so a sentence can wait behind other people's readings:
# connect fast, read long.
_SYNTHESIS_TIMEOUT = httpx.Timeout(connect=5.0, read=120.0, write=10.0, pool=10.0)
_HEALTH_TIMEOUT = httpx.Timeout(5.0)


class ZonosError(Exception):
    """Zonos did not give us audio."""


class ZonosUnavailable(ZonosError):
    """Zonos could not be reached: connection refused, a timeout, a dropped connection."""


class SynthesisFailed(ZonosError):
    """Zonos answered, but with an error status or with audio that cannot be used."""


class ZonosClient:
    """Asks Zonos at `base_url` for speech, through `http`."""

    def __init__(self, base_url: str, http: httpx.AsyncClient) -> None:
        self._base_url = base_url.rstrip("/")
        self._http = http

    async def synthesize(
        self, text: str, language: str, voice: Voice, seed: int
    ) -> tuple[np.ndarray, int]:
        """`text` spoken in `voice`: float32 mono audio and its sample rate.

        `language` is "en" or "hu". Raises ValueError for any other, ZonosUnavailable when Zonos
        cannot be reached, and SynthesisFailed when it answers with anything but usable audio.
        """
        if language not in _ZONOS_LANGUAGES:
            raise ValueError(
                f"language must be one of {', '.join(_ZONOS_LANGUAGES)}, got {language!r}"
            )
        body: dict[str, object] = {
            "text": text,
            "language": _ZONOS_LANGUAGES[language],
            "format": "wav",
            "stream": False,
            "speaker_embedding_id": voice.speaker_id,
            "speaker_mode": "embedding",
            "seed": seed,
            "text_normalization": False,  # the service has normalized the text already
        }
        if voice.controls:
            body["controls"] = voice.controls
        try:
            response = await self._http.post(
                f"{self._base_url}/v2/generate", json=body, timeout=_SYNTHESIS_TIMEOUT
            )
        except httpx.TransportError as error:
            raise ZonosUnavailable(f"Zonos did not answer ({type(error).__name__})") from error
        if not response.is_success:
            raise SynthesisFailed(f"Zonos answered {response.status_code}")
        try:
            audio, sample_rate = sf.read(
                io.BytesIO(response.content), dtype="float32", always_2d=True
            )
        except (sf.SoundFileError, RuntimeError) as error:
            raise SynthesisFailed("Zonos sent audio that cannot be decoded") from error
        if audio.shape[0] == 0:
            raise SynthesisFailed("Zonos sent no audio")
        return audio.mean(axis=1, dtype=np.float32), sample_rate

    async def healthy(self) -> bool:
        """Whether Zonos answers its health check with 200. Any error is no."""
        try:
            response = await self._http.get(f"{self._base_url}/v2/health", timeout=_HEALTH_TIMEOUT)
        except (httpx.HTTPError, httpx.InvalidURL):
            return False
        return response.status_code == 200
