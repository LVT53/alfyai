"""The HTTP API: its routes, what a request may hold, and the registry of live reading sessions.

A reading is a `ReadingSession` (session.py): this module makes one for each `POST /v1/sessions`,
finds it again by id and hands its two streams, the timeline and the MP3, to the HTTP layer. How a
reading runs is the session's. What belongs here:
  - what a request may hold (`_parse_*`): a refusal names the field and never a value, so none of
    a reply's text is ever in an answer or in a log line;
  - a session that has ended is gone: every route answers 404 for it;
  - a client that leaves a stream detaches its reader (`_Stream`), and the app ending cancels every
    session, so none is left running;
  - preview: one sentence, spoken, matched in loudness and encoded whole, with no word times.
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import json
import logging
import math
import time
import uuid
from collections.abc import AsyncGenerator, AsyncIterator, Callable
from typing import get_args

import anyio
import numpy as np
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route
from starlette.types import Receive, Scope, Send

from speech_service.aligner import Aligner, NoAligner
from speech_service.audio import SAMPLE_RATE, Mp3Encoder, match_loudness, trim_silence
from speech_service.config import Settings
from speech_service.models import Sentence, Voice
from speech_service.session import Event, ReaderTaken, ReadingSession
from speech_service.text import Language, normalize
from speech_service.zonos import SynthesisFailed, ZonosClient, ZonosError, ZonosUnavailable

logger = logging.getLogger(__name__)

MAX_SENTENCES = 2000
MAX_PREVIEW_CHARS = 300
MAX_SEED = 2**32 - 1  # Zonos's own bound (servers/api/openapi.json)


def create_app(settings: Settings, zonos: ZonosClient, aligner: Aligner) -> Starlette:
    """The app that serves the HTTP contract (README.md) on `zonos` and `aligner`.

    Its lifespan measures the MP3 encoder's delay before the first request is served (it raises if
    ffmpeg cannot run), and cancels every session still live when the app ends.
    """
    api = _Api(settings, zonos, aligner)
    return Starlette(
        routes=[
            Route("/v1/sessions", api.create_session, methods=["POST"]),
            Route("/v1/sessions/{session_id}/audio", api.audio, methods=["GET"]),
            Route("/v1/sessions/{session_id}/events", api.events, methods=["GET"]),
            Route("/v1/sessions/{session_id}/position", api.position, methods=["POST"]),
            Route("/v1/sessions/{session_id}", api.delete_session, methods=["DELETE"]),
            Route("/v1/preview", api.preview, methods=["POST"]),
            Route("/health", api.health, methods=["GET"]),
        ],
        exception_handlers={_Invalid: _refuse},
        lifespan=api.lifespan,
    )


class _Api:
    """The routes' handlers, and what they share: the settings, Zonos, the aligner, the registry."""

    def __init__(self, settings: Settings, zonos: ZonosClient, aligner: Aligner) -> None:
        self._settings = settings
        self._zonos = zonos
        self._aligner = aligner
        self._sessions = _Sessions()

    @contextlib.asynccontextmanager
    async def lifespan(self, app: Starlette) -> AsyncIterator[None]:
        # The first reading would pay for this (two ffmpeg runs): start-up does.
        await Mp3Encoder.warm_up()
        try:
            yield
        finally:
            await self._sessions.cancel_all()

    # Sessions.

    async def create_session(self, request: Request) -> Response:
        sentences, seed = _parse_session(await _json_body(request), self._settings)
        settings = self._settings
        if seed is not None:
            settings = dataclasses.replace(settings, seed=seed)
        session = ReadingSession(uuid.uuid4().hex, sentences, self._zonos, self._aligner, settings)
        session.start()
        self._sessions.add(session)
        return JSONResponse({"session_id": session.id}, status_code=201)

    async def events(self, request: Request) -> Response:
        return self._take_reader(
            request,
            lambda session: _Stream(
                _server_sent(session.events()),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache"},
            ),
        )

    async def audio(self, request: Request) -> Response:
        return self._take_reader(
            request, lambda session: _Stream(session.audio(), media_type="audio/mpeg")
        )

    def _take_reader(
        self, request: Request, respond: Callable[[ReadingSession], Response]
    ) -> Response:
        """The response of a route that takes one of the session's two readers: `respond(session)`,
        or the refusal when there is no such session, or its reader is taken."""
        if request.method != "GET":  # a HEAD would take the one reader
            return _not_allowed()
        session = self._sessions.get(request.path_params["session_id"])
        if session is None:
            return _not_found()
        try:
            return respond(session)
        except ReaderTaken:
            return _reader_taken()

    async def position(self, request: Request) -> Response:
        session = self._sessions.get(request.path_params["session_id"])
        if session is None:
            return _not_found()
        body = await _json_body(request)
        if not isinstance(body, dict):
            raise _Invalid("body")
        sentence_id = body.get("sentence_id")
        if not isinstance(sentence_id, str):
            raise _Invalid("sentence_id")
        try:
            session.report_position(sentence_id)
        except KeyError:
            raise _Invalid("sentence_id") from None
        return Response(status_code=204)

    async def delete_session(self, request: Request) -> Response:
        session = self._sessions.pop(request.path_params["session_id"])
        if session is None:
            return _not_found()
        await session.cancel()
        return Response(status_code=204)

    # Preview and health.

    async def preview(self, request: Request) -> Response:
        """One sentence spoken in a voice: normalized, trimmed, matched in loudness and encoded to
        one whole MP3. Not aligned: a preview has no word times."""
        text, language, voice = _parse_preview(await _json_body(request))
        spoken = await asyncio.to_thread(normalize, text.split(), language)
        if not spoken.words:  # nothing the voice would say: no call to Zonos
            raise _Invalid("text")
        started = time.monotonic()
        try:
            audio, rate = await self._zonos.synthesize(
                " ".join(spoken.words), language, voice, self._settings.seed
            )
            if rate != SAMPLE_RATE:
                raise SynthesisFailed(f"Zonos sent audio at {rate} Hz, not {SAMPLE_RATE} Hz")
            clip = match_loudness(trim_silence(audio, rate), rate)
            if clip.size == 0:
                raise SynthesisFailed("Zonos sent nothing but silence")
        except ZonosUnavailable:
            logger.warning("preview: Zonos could not be reached")
            return JSONResponse({"code": "zonos_unavailable"}, status_code=503)
        except ZonosError as error:
            logger.warning("preview: synthesis failed (%s)", type(error).__name__)
            return JSONResponse({"code": "synthesis_failed"}, status_code=502)
        try:
            mp3 = await _encode(clip)
        except (OSError, RuntimeError) as error:  # ffmpeg is missing, or died
            logger.warning("preview: the encoder failed (%s)", type(error).__name__)
            return JSONResponse({"code": "synthesis_failed"}, status_code=502)
        logger.info(
            "preview: %d words, %.1f s of audio, %d bytes, made in %.2f s",
            len(spoken.words),
            len(clip) / SAMPLE_RATE,
            len(mp3),
            time.monotonic() - started,
        )
        return Response(mp3, media_type="audio/mpeg")

    async def health(self, request: Request) -> Response:
        """Always 200. `ok` is whether readings can be served: Zonos answers. `aligner` is whether
        words get times: without an aligner a reading carries sentence marks only."""
        zonos_answers = await self._zonos.healthy()
        return JSONResponse(
            {
                "ok": zonos_answers,
                "zonos": zonos_answers,
                "aligner": not isinstance(self._aligner, NoAligner),
            }
        )


class _Sessions:
    """The live sessions by id. A session that has ended is not in it.

    A session cannot say when it ends, so the registry looks whenever it is used, and drops every
    one that has.
    """

    def __init__(self) -> None:
        self._by_id: dict[str, ReadingSession] = {}

    def add(self, session: ReadingSession) -> None:
        self._sweep()
        self._by_id[session.id] = session

    def get(self, session_id: str) -> ReadingSession | None:
        self._sweep()
        return self._by_id.get(session_id)

    def pop(self, session_id: str) -> ReadingSession | None:
        self._sweep()
        return self._by_id.pop(session_id, None)

    async def cancel_all(self) -> None:
        """End every session still live and forget them all."""
        live = [session for session in self._by_id.values() if not session.ended]
        self._by_id.clear()
        logger.info("cancelling %d live session(s)", len(live))
        results = await asyncio.gather(*(s.cancel() for s in live), return_exceptions=True)
        for session, result in zip(live, results):
            if isinstance(result, BaseException):
                logger.warning("session %s: not cancelled (%s)", session.id, type(result).__name__)

    def _sweep(self) -> None:
        for session_id in [i for i, session in self._by_id.items() if session.ended]:
            del self._by_id[session_id]


# Streams.


class _Stream(StreamingResponse):
    """A streaming response that stops when its client leaves and closes its generator however it
    ends.

    Starlette listens for the client leaving only on servers that speak ASGI below 2.4 (uvicorn
    does today). From 2.4 on it trusts `send` to fail, which a stream waiting for its next chunk
    never calls. Either way the generator is left for the garbage collector to close. A reading's
    stream is often waiting, and its generator is what tells the session its reader has gone (the
    idle clock starts then), so here the client leaving always stops the stream at once, and the
    generator is closed before this returns.
    """

    body_iterator: AsyncGenerator

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        failure: Exception | None = None

        async def watch() -> None:
            await self.listen_for_disconnect(receive)
            group.cancel_scope.cancel()

        try:
            async with anyio.create_task_group() as group:
                group.start_soon(watch)
                try:
                    await self.stream_response(send)
                except OSError:
                    pass  # the client is gone: a server of ASGI 2.4 or later says so from `send`
                except Exception as error:  # not collected into the group's own error
                    failure = error
                group.cancel_scope.cancel()  # the stream is over: stop watching the client
        finally:
            # However it ended, even by a cancel, and not interrupted by one.
            with anyio.CancelScope(shield=True):
                await self.body_iterator.aclose()
        if failure is not None:
            raise failure


async def _server_sent(events: AsyncGenerator[Event, None]) -> AsyncGenerator[bytes, None]:
    """The session's timeline as a server-sent event stream: `event: <name>\\ndata: <json>\\n\\n`
    for each event, the JSON compact on one line (a line break in an id is escaped, so nothing a
    client sent can start another event). `events` is closed when this is."""
    async with contextlib.aclosing(events):
        async for name, data in events:
            payload = json.dumps(data, separators=(",", ":"), allow_nan=False)
            yield f"event: {name}\ndata: {payload}\n\n".encode()


async def _encode(clip: np.ndarray) -> bytes:
    """`clip` (float32 mono at 44.1 kHz) as one whole MP3."""
    async with Mp3Encoder() as encoder:
        await encoder.write(clip)
    return b"".join([chunk async for chunk in encoder.read_chunks()])


# Answers.


def _not_found() -> Response:
    return JSONResponse({"error": "not_found"}, status_code=404)


def _reader_taken() -> Response:
    return JSONResponse({"error": "reader_taken"}, status_code=409)


def _not_allowed() -> Response:
    return Response(status_code=405, headers={"Allow": "GET"})


class _Invalid(Exception):
    """A request holds something the service refuses. `field` says where, as a path of field names
    and positions: never a value, so nothing a client sent comes back."""

    def __init__(self, field: str) -> None:
        super().__init__(field)
        self.field = field


async def _refuse(request: Request, error: Exception) -> Response:
    assert isinstance(error, _Invalid)
    logger.info("request refused: %s", error.field)
    return JSONResponse({"error": "invalid", "field": error.field}, status_code=422)


# What a request may hold.


async def _json_body(request: Request) -> object:
    try:
        return json.loads(await request.body())
    except (ValueError, RecursionError):  # not JSON, not UTF-8, or nested past what is parsed
        raise _Invalid("body") from None


def _parse_session(body: object, settings: Settings) -> tuple[list[Sentence], int | None]:
    """The sentences and the seed of a `POST /v1/sessions` body, or `_Invalid`."""
    if not isinstance(body, dict):
        raise _Invalid("body")
    listed = body.get("sentences")
    if not isinstance(listed, list) or not 1 <= len(listed) <= MAX_SENTENCES:
        raise _Invalid("sentences")
    sentences: list[Sentence] = []
    ids: set[str] = set()
    for position, item in enumerate(listed):
        path = f"sentences[{position}]"
        sentence = _parse_sentence(item, path, settings)
        if sentence.id in ids:
            raise _Invalid(f"{path}.id")
        ids.add(sentence.id)
        sentences.append(sentence)
    return sentences, _parse_seed(body)


def _parse_seed(body: dict) -> int | None:
    """The request's seed, or None when it has none. An integer in Zonos's range; no bool."""
    if "seed" not in body:
        return None
    seed = body["seed"]
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= MAX_SEED:
        raise _Invalid("seed")
    return seed


def _parse_sentence(item: object, path: str, settings: Settings) -> Sentence:
    if not isinstance(item, dict):
        raise _Invalid(path)
    sentence_id = item.get("id")
    if not isinstance(sentence_id, str) or not sentence_id:
        raise _Invalid(f"{path}.id")
    language = _parse_language(item.get("language"), f"{path}.language")
    voice = _parse_voice(item.get("voice"), f"{path}.voice")
    tokens = item.get("tokens")
    if (
        not isinstance(tokens, list)
        or not tokens
        or not all(isinstance(token, str) for token in tokens)
        or len(" ".join(tokens)) > settings.max_sentence_chars
    ):
        raise _Invalid(f"{path}.tokens")
    paragraph_start = item.get("paragraph_start")
    if not isinstance(paragraph_start, bool):
        raise _Invalid(f"{path}.paragraph_start")
    return Sentence(sentence_id, language, voice, tokens, paragraph_start)


def _parse_language(value: object, path: str) -> Language:
    for language in get_args(Language):
        if value == language:
            return language
    raise _Invalid(path)


def _parse_voice(value: object, path: str) -> Voice:
    """A speaker id and the controls that go to Zonos as they are (names and ranges are Zonos's)."""
    if not isinstance(value, dict):
        raise _Invalid(path)
    speaker_id = value.get("speaker_id")
    if not isinstance(speaker_id, str) or not speaker_id:
        raise _Invalid(f"{path}.speaker_id")
    controls = value.get("controls", {})
    if not isinstance(controls, dict) or not all(_is_number(v) for v in controls.values()):
        raise _Invalid(f"{path}.controls")  # not the control's name: that is the client's text too
    return Voice(speaker_id, controls)


def _is_number(value: object) -> bool:
    """An int or a finite float. Python's JSON parser also reads NaN and Infinity; JSON has none."""
    if isinstance(value, bool):
        return False
    return isinstance(value, int) or (isinstance(value, float) and math.isfinite(value))


def _parse_preview(body: object) -> tuple[str, Language, Voice]:
    """The text, language and voice of a `POST /v1/preview` body, or `_Invalid`."""
    if not isinstance(body, dict):
        raise _Invalid("body")
    text = body.get("text")
    if not isinstance(text, str) or not text or len(text) > MAX_PREVIEW_CHARS:
        raise _Invalid("text")
    language = _parse_language(body.get("language"), "language")
    voice = _parse_voice(body.get("voice"), "voice")
    return text, language, voice
