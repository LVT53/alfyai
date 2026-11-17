"""The HTTP API: its routes, what a request may hold, and the registry of live reading sessions.

A reading is a `ReadingSession` (session.py): this module makes one for each `POST /v1/sessions`,
finds it again by id and hands its two streams, the timeline and the MP3, to the HTTP layer. How a
reading runs is the session's. What belongs here:
  - what a request may hold (`_parse_*`): a refusal names the field and never a value, so none of
    a reply's text is ever in an answer or in a log line;
  - a session that has ended is kept until its events have been read to their end, or until
    `idle_seconds` after it ended (a reader that comes late still gets what it said), and then
    forgotten: every route answers 404 for it;
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
from starlette.types import Message, Receive, Scope, Send

from speech_service.aligner import Aligner, NoAligner
from speech_service.audio import SAMPLE_RATE, Mp3Encoder, match_loudness, trim_silence
from speech_service.config import Settings
from speech_service.logs import describe
from speech_service.models import Sentence, Voice
from speech_service.session import Event, ReaderTaken, ReadingSession
from speech_service.text import Language, normalize
from speech_service.zonos import SynthesisFailed, ZonosClient, ZonosError, ZonosUnavailable

logger = logging.getLogger(__name__)

MAX_SENTENCES = 2000
MAX_PREVIEW_CHARS = 300
MAX_SEED = 2**32 - 1  # Zonos's own bound (servers/api/openapi.json)
# The most a request body may hold: a reading of 2000 sentences of 400 characters, with their JSON.
MAX_BODY_BYTES = 4 * 1024 * 1024

# How often the registry looks for sessions that have ended. It is also how exactly "idle_seconds
# after it ended" is counted.
_LOOK_SECONDS = 0.05


def create_app(settings: Settings, zonos: ZonosClient, aligner: Aligner) -> Starlette:
    """The app that serves the HTTP contract (README.md) on `zonos` and `aligner`.

    Its lifespan measures the MP3 encoder's delay before the first request is served (it raises if
    ffmpeg cannot run), keeps the registry looking for sessions that have ended, and cancels every
    session still live when the app ends.
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
        exception_handlers={_Invalid: _refuse, _TooLarge: _refuse_too_large},
        lifespan=api.lifespan,
    )


class _Api:
    """The routes' handlers, and what they share: the settings, Zonos, the aligner, the registry."""

    def __init__(self, settings: Settings, zonos: ZonosClient, aligner: Aligner) -> None:
        self._settings = settings
        self._zonos = zonos
        self._aligner = aligner
        self._sessions = _Sessions(keep_seconds=settings.idle_seconds)

    @contextlib.asynccontextmanager
    async def lifespan(self, app: Starlette) -> AsyncIterator[None]:
        # The first reading would pay for this (two ffmpeg runs): start-up does.
        await Mp3Encoder.warm_up()
        looking = asyncio.create_task(self._sessions.keep_looking(), name="speech-sessions")
        try:
            yield
        finally:
            looking.cancel()
            await asyncio.gather(looking, return_exceptions=True)
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
                _server_sent(session.events(), lambda: self._sessions.events_read(session.id)),
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
        one whole MP3. Not aligned: a preview has no word times.

        Whatever goes wrong that nobody expected is a 500 with a fixed body, and the log has the
        error's type and place and no message (a message can quote the text, and an error left to
        the server is logged with its message and its traceback)."""
        text, language, voice = _parse_preview(await _json_body(request))
        try:
            return await self._speak(text, language, voice)
        except _Invalid:  # nothing speakable: the client's to be told, not a failure
            raise
        except Exception as error:
            logger.error("preview: failed unexpectedly: %s", describe(error))
            return JSONResponse({"code": "synthesis_failed"}, status_code=500)

    async def _speak(self, text: str, language: Language, voice: Voice) -> Response:
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


@dataclasses.dataclass
class _Entry:
    session: ReadingSession
    ended_at: float | None = None  # when the registry saw that it had ended
    events_read: bool = False  # its events were read to their end


class _Sessions:
    """The sessions that can be asked about, by id.

    A session that has ended is kept for a while, because what it said can be waiting for a reader
    that comes late: a session that fails (Zonos is down) is over within milliseconds, and a
    player's streams connect a round trip after it was made. It is kept until its events have been
    read to their end, or until `keep_seconds` after it ended, whichever comes first, and then
    forgotten: every route answers 404 for it.

    A session cannot say when it ends, so the registry looks: `keep_looking` often (so that the
    time is counted from the end, not from whenever somebody next asks), and every use.
    """

    def __init__(self, keep_seconds: float) -> None:
        self._entries: dict[str, _Entry] = {}
        self._keep_seconds = keep_seconds

    def add(self, session: ReadingSession) -> None:
        self._look()
        self._entries[session.id] = _Entry(session)

    def get(self, session_id: str) -> ReadingSession | None:
        self._look()
        entry = self._entries.get(session_id)
        return None if entry is None else entry.session

    def pop(self, session_id: str) -> ReadingSession | None:
        """Forget the session now, and return it (None if it is not known)."""
        self._look()
        entry = self._entries.pop(session_id, None)
        return None if entry is None else entry.session

    def events_read(self, session_id: str) -> None:
        """Its events have been read to their end: nothing is left to keep it for."""
        if (entry := self._entries.get(session_id)) is not None:
            entry.events_read = True

    async def keep_looking(self) -> None:
        while True:
            await asyncio.sleep(_LOOK_SECONDS)
            self._look()

    async def cancel_all(self) -> None:
        """End every session still live and forget them all."""
        live = [entry.session for entry in self._entries.values() if not entry.session.ended]
        self._entries.clear()
        logger.info("cancelling %d live session(s)", len(live))
        results = await asyncio.gather(*(s.cancel() for s in live), return_exceptions=True)
        for session, result in zip(live, results):
            if isinstance(result, BaseException):
                logger.warning("session %s: not cancelled (%s)", session.id, type(result).__name__)

    def _look(self) -> None:
        now = time.monotonic()
        for session_id, entry in list(self._entries.items()):
            if not entry.session.ended:
                continue
            if entry.ended_at is None:
                entry.ended_at = now
            if entry.events_read or now - entry.ended_at >= self._keep_seconds:
                del self._entries[session_id]


# Streams.


class _ClientGone(Exception):
    """`send` failed with an OSError: the client has left."""


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

        async def send_to_the_client(message: Message) -> None:
            try:
                await send(message)
            except OSError:  # a server of ASGI 2.4 or later says the client is gone from `send`
                raise _ClientGone from None

        try:
            async with anyio.create_task_group() as group:
                group.start_soon(watch)
                try:
                    await self.stream_response(send_to_the_client)
                except _ClientGone:
                    pass  # an OSError of the body itself is no such thing: it is a failure
                except Exception as error:  # not collected into the group's own error
                    failure = error
                group.cancel_scope.cancel()  # the stream is over: stop watching the client
        finally:
            # However it ended, even by a cancel, and not interrupted by one.
            with anyio.CancelScope(shield=True):
                await self.body_iterator.aclose()
        if failure is not None:
            raise failure


async def _server_sent(
    events: AsyncGenerator[Event, None], read_to_end: Callable[[], None]
) -> AsyncGenerator[bytes, None]:
    """The session's timeline as a server-sent event stream: `event: <name>\\ndata: <json>\\n\\n`
    for each event, the JSON compact on one line (a line break in an id is escaped, so nothing a
    client sent can start another event). `events` is closed when this is; `read_to_end` is called
    when the last event has been handed on, and not when the client leaves before it."""
    async with contextlib.aclosing(events):
        async for name, data in events:
            payload = json.dumps(data, separators=(",", ":"), allow_nan=False)
            yield f"event: {name}\ndata: {payload}\n\n".encode()
        read_to_end()


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


class _TooLarge(Exception):
    """A request body is over `MAX_BODY_BYTES`."""


async def _refuse_too_large(request: Request, error: Exception) -> Response:
    logger.info("request refused: the body is over %d bytes", MAX_BODY_BYTES)
    return JSONResponse({"error": "too_large"}, status_code=413)


# What a request may hold.


async def _json_body(request: Request) -> object:
    """The request's body as JSON. `_TooLarge` for one over `MAX_BODY_BYTES`, `_Invalid` for one
    that is not JSON."""
    body = await _read_body(request)
    try:
        return json.loads(body)
    except (ValueError, RecursionError):  # not JSON, not UTF-8, or nested past what is parsed
        raise _Invalid("body") from None


async def _read_body(request: Request) -> bytes:
    """The body, or `_TooLarge` as soon as it is known to be over `MAX_BODY_BYTES`: from its
    declared length before any of it is read, otherwise as it comes in."""
    try:
        declared = int(request.headers.get("content-length", ""))
    except ValueError:  # none, or not a number: the pieces are counted instead
        declared = 0
    if declared > MAX_BODY_BYTES:
        raise _TooLarge
    body = bytearray()
    async for piece in request.stream():
        body += piece
        if len(body) > MAX_BODY_BYTES:
            raise _TooLarge
    return bytes(body)


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
