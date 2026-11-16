"""Test doubles for Zonos: httpx clients on a MockTransport that answer like its HTTP API."""

import asyncio
import io
import json

import httpx
import soundfile as sf

from tests.helpers import SR, tone

# How long the fake keeps one /v2/generate call in flight: long enough that calls overlap, short
# enough that a test of dozens of them stays quick.
SERVICE_SECONDS = 0.01


class Requests(list[dict]):
    """The /v2/generate request bodies the fake has received, in arrival order."""

    # The most /v2/generate calls the fake has served at the same moment.
    max_in_flight = 0


def _wav(text: str) -> bytes:
    """A 16-bit WAV of a 220 Hz tone (not silence, so trim_silence keeps it): 0.06 s per character
    of `text` plus 0.3 s."""
    buffer = io.BytesIO()
    sf.write(buffer, tone(0.3, 0.06 * len(text) + 0.3), SR, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def fake_zonos(
    fail_on: int | None = None, concurrency: int = 2
) -> tuple[httpx.AsyncClient, Requests]:
    """A client for a Zonos that answers POST /v2/generate with a tone and GET /v2/health with 200.

    The `fail_on`-th /v2/generate call (counted from 1) is answered with a 500. At most
    `concurrency` calls are served at once (Zonos runs two syntheses at once); the rest wait their
    turn. Every request body is appended to the returned list when the request arrives.
    """
    requests = Requests()
    slots = asyncio.Semaphore(concurrency)
    arrived = 0
    in_flight = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal arrived, in_flight
        if request.method == "GET" and request.url.path == "/v2/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.method != "POST" or request.url.path != "/v2/generate":
            return httpx.Response(404, json={"detail": "Not Found"})
        body = json.loads(request.content)
        requests.append(body)
        arrived += 1
        number = arrived
        async with slots:
            in_flight += 1
            requests.max_in_flight = max(requests.max_in_flight, in_flight)
            try:
                await asyncio.sleep(SERVICE_SECONDS)
            finally:
                in_flight -= 1
        if number == fail_on:
            return httpx.Response(500, json={"detail": "synthesis failed"})
        return httpx.Response(200, content=_wav(body["text"]), headers={"content-type": "audio/wav"})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler)), requests


def refusing_transport() -> httpx.AsyncClient:
    """A client whose every call raises httpx.ConnectError, as when nothing listens on the port."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused", request=request)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))
