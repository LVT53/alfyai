"""Live check of the speech service against a local Zonos, for the owner to listen to.

It posts one mixed reading to a running service: an English paragraph read by Imogen, then a
Hungarian paragraph read by Berta (room.clean 2, "studio"). It follows the timeline (SSE) and the
MP3 at the same time, as AlfyAI's server will, and tells the service which sentence is playing as
each `sentence` event arrives, so the service keeps synthesizing ahead (nothing is played in real
time). It then writes `live.mp3` and `live-events.json` into --out and prints:

- the first-audio latency: the POST to the first MP3 audio byte (an ID3 tag in front does not
  count),
- the words placed against the tokens sent, for each sentence, naming the tokens with no time,
- whether the times are in order: sentence and word starts never go backwards, words lie inside
  their sentence, and the gaps are the ones the service promises,
- whether the timeline's length agrees with the length of the audio.

It prints no text but what it sent, and it writes nothing into the repository.

Exit status: 0 when every check passes, 1 when a check misses or the reading could not be carried
out, 2 for a bad argument. A miss is reported as it is; nothing here bends a number to pass.

It needs the service (SPEECH_ALIGNER=python, port 1920) and Zonos (port 1921 on the Mac, with
Imogen and berta.npy among its voices), and only the standard library and httpx, so the service's
.venv Python and the zonos3 Python both run it. From deploy/speech-service:

    ~/Downloads/zonos3/.venv/bin/python -I scripts/live_check.py --out /a/directory/outside/the/repo
"""

from __future__ import annotations

import argparse
import asyncio
import codecs
import json
import math
import re
import sys
import time
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path
from urllib.parse import urlsplit

import httpx

DEFAULT_SERVICE = "http://127.0.0.1:1920"
DEFAULT_ZONOS = "http://127.0.0.1:1921"
MP3_NAME = "live.mp3"
EVENTS_NAME = "live-events.json"

# Zonos's default voice Imogen (Imogen_en-British_F_1.wav). Berta's id depends on the folder Zonos
# serves her from, so she is looked up by the file she was made from.
IMOGEN_ID = "default_b78b28baf5c31a1d"
BERTA_FILE = "berta.npy"
BERTA_CONTROLS = {"room.clean": 2}  # "studio", the setting the owner approved her with

# What a run is expected to show.
FIRST_AUDIO_LIMIT = 1.5  # seconds from the POST to the first MP3 audio byte
# The service's own defaults (SPEECH_GAP_SECONDS and SPEECH_PARAGRAPH_GAP_SECONDS; they were 0.30 and
# 0.60 until 2026-11-17). A service run with others is checked with --gap and --paragraph-gap.
GAP_SECONDS = 0.50  # silence before a sentence
PARAGRAPH_GAP_SECONDS = 0.90  # silence before the first sentence of a paragraph
GAP_TOLERANCE = 0.05
SPAN_TOLERANCE = 0.05  # a word may lie this far outside its sentence (alignment frames, rounding)
LENGTH_TOLERANCE = 0.15  # between the timeline's end and the audio's length
MP3_BYTES_PER_SECOND = 128_000 / 8  # the service's MP3 is 128 kbit/s, constant

QUICK = httpx.Timeout(10.0)
# A stream is quiet while Zonos works on a sentence; --timeout ends a stream that is stuck.
STREAM = httpx.Timeout(10.0, read=None)

KNOWN_EVENTS = ("sentence", "words", "error", "done")


@dataclass(frozen=True)
class Line:
    """One sentence of the reading, written as a person would see it."""

    id: str
    language: str  # "en" or "hu"
    voice: str  # "Imogen" or "Berta"
    text: str
    paragraph_start: bool = False


# An English paragraph (Imogen: a count, an amount, a date), then a Hungarian one (Berta: "két"
# before a counted noun, a price, "kettő" where it must stay, one lone symbol that has no time).
LINES = (
    Line("en-1", "en", "Imogen", "Here is a short test of the new reading voice.", True),
    Line(
        "en-2",
        "en",
        "Imogen",
        "The order has 3 items and costs $24.50, so it should arrive by March 14th.",
    ),
    Line(
        "en-3",
        "en",
        "Imogen",
        "Next, the service switches language and reads a paragraph in Hungarian.",
    ),
    Line(
        "hu-1",
        "hu",
        "Berta",
        "A recepthez 2 tojás, 250 gramm liszt és másfél deciliter tej kell.",
        True,
    ),
    Line("hu-2", "hu", "Berta", "A kenyérsütő ára 12 990 Ft, és 2022 óta nem változott."),
    Line("hu-3", "hu", "Berta", "Ha 12 után érkezel, már zárva lesz a bolt."),
    Line("hu-4", "hu", "Berta", "Nyisd meg a Beállítások → Hang menüt, majd mentsd el."),
)


class RunFailed(Exception):
    """The reading could not be carried out. The message says why, and quotes no reply text."""


# What the service sent.


@dataclass(frozen=True)
class Received:
    """One SSE event as it arrived: `at` is seconds after the session's POST was sent."""

    at: float
    name: str
    data: dict


class SseParser:
    """Turns the bytes of a text/event-stream response into `(event, data)` pairs.

    It follows the rules of the SSE format that the service relies on: a line ends in LF, CRLF or
    CR; a blank line ends an event; `event:` names it and each `data:` line adds a line to its data;
    lines that start with a colon are comments; other fields (`id`, `retry`) are ignored. An event
    with no data line is not delivered, and one the stream cut off before its blank line is dropped.
    """

    _LINE_END = re.compile(r"\r\n|\n|\r")

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")()
        self._pending = ""
        self._name = ""
        self._data: list[str] = []

    def feed(self, chunk: bytes) -> list[tuple[str, str]]:
        """The events that `chunk` completes, in order. Raises UnicodeDecodeError for bad UTF-8."""
        self._pending += self._decoder.decode(chunk)
        events: list[tuple[str, str]] = []
        while (match := self._LINE_END.search(self._pending)) is not None:
            if match.group() == "\r" and match.end() == len(self._pending):
                break  # perhaps the first half of a CRLF: wait for the next chunk
            line = self._pending[: match.start()]
            self._pending = self._pending[match.end() :]
            if (event := self._read_line(line)) is not None:
                events.append(event)
        return events

    def _read_line(self, line: str) -> tuple[str, str] | None:
        if line == "":
            name, data = self._name or "message", self._data
            self._name, self._data = "", []
            return (name, "\n".join(data)) if data else None
        if line.startswith(":"):
            return None
        field, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if field == "event":
            self._name = value
        elif field == "data":
            self._data.append(value)
        return None


def _is_number(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def parse_event(name: str, raw: str, at: float) -> Received:
    """The event `name` with its JSON data. Raises RunFailed for data that is not what the contract
    says that event carries (the contract: sentence {id, start, end}, words {id, times}, error
    {id, code}, done {})."""
    try:
        data = json.loads(raw)
    except ValueError:
        raise RunFailed(f"a {name} event carries data that is not JSON") from None
    if not isinstance(data, dict):
        raise RunFailed(f"a {name} event carries data that is not an object")
    if name == "sentence":
        valid = (
            isinstance(data.get("id"), str)
            and _is_number(data.get("start"))
            and _is_number(data.get("end"))
        )
    elif name == "words":
        times = data.get("times")
        valid = (
            isinstance(data.get("id"), str)
            and isinstance(times, list)
            and all(
                t is None or (isinstance(t, list) and len(t) == 2 and all(map(_is_number, t)))
                for t in times
            )
        )
    else:
        valid = True
    if not valid:
        raise RunFailed(f"a {name} event does not have the shape the contract gives it")
    return Received(at, name, data)


def id3_length(head: bytes) -> int | None:
    """The length in bytes of the ID3v2 tag a stream starts with, given its first bytes: 0 for no
    tag, None while `head` is too short to tell. ffmpeg puts a tag in front of the MP3 frames."""
    if len(head) >= 3 and head[:3] != b"ID3":
        return 0
    if len(head) < 10:
        return None
    size = 0
    for byte in head[6:10]:  # four "syncsafe" bytes: seven bits each
        size = (size << 7) | (byte & 0x7F)
    footer = 10 if head[5] & 0x10 else 0
    return 10 + size + footer


class AudioLog:
    """What arrived of the MP3: sizes and times. The audio itself goes straight to the file."""

    def __init__(self) -> None:
        self.size = 0
        self.chunks = 0
        self.first_byte_at: float | None = None
        self.first_audio_at: float | None = None  # the first byte after the ID3 tag
        self.ended_at: float | None = None
        self.tag_length: int | None = None  # None until the stream's first ten bytes are in
        self._head = bytearray()

    def add(self, chunk: bytes, at: float) -> None:
        if self.first_byte_at is None:
            self.first_byte_at = at
        if len(self._head) < 10:
            self._head += chunk[: 10 - len(self._head)]
        self.size += len(chunk)
        self.chunks += 1
        if self.tag_length is None:
            self.tag_length = id3_length(bytes(self._head))
        if self.first_audio_at is None and self.tag_length is not None:
            if self.size > self.tag_length:
                self.first_audio_at = at

    @property
    def seconds(self) -> float | None:
        """The audio's length, from its size: the MP3 is 128 kbit/s, constant. None before any."""
        if self.tag_length is None or self.size <= self.tag_length:
            return None
        return (self.size - self.tag_length) / MP3_BYTES_PER_SECOND


class Run:
    """What one reading produced so far. It is kept when the reading fails, for the report."""

    def __init__(self, request: dict) -> None:
        self.request = request
        self.started = 0.0
        self.session_id = ""
        self.created_at: float | None = None
        self.events: list[Received] = []
        self.positions: list[str] = []
        self.audio = AudioLog()
        self.released: int | None = None  # what DELETE answered, when it answered
        self.failure: str | None = None

    def now(self) -> float:
        """Seconds since the session's POST was sent."""
        return time.perf_counter() - self.started


def build_request(berta_id: str) -> dict:
    """The body of POST /v1/sessions: `LINES`, each text split on whitespace into its tokens."""

    def voice(name: str) -> dict:
        if name == "Imogen":
            return {"speaker_id": IMOGEN_ID, "controls": {}}
        return {"speaker_id": berta_id, "controls": dict(BERTA_CONTROLS)}

    return {
        "sentences": [
            {
                "id": line.id,
                "language": line.language,
                "voice": voice(line.voice),
                "tokens": line.text.split(),
                "paragraph_start": line.paragraph_start,
            }
            for line in LINES
        ]
    }


# Talking to Zonos and to the service.


def describe(response: httpx.Response) -> str:
    """A response as one short line: its status and the start of its body. The service's error
    bodies are ids and field names, never reply text."""
    body = " ".join(response.text.split())
    return f"{response.status_code} {body[:200]}".strip()


def describe_error(error: httpx.HTTPError) -> str:
    return f"{type(error).__name__}: {error}".strip(": ")


def pick_speaker(speakers: list[dict], original_name: str) -> str:
    """The id of the one speaker Zonos made from `original_name`. Raises RunFailed otherwise."""
    ids = [s.get("id") for s in speakers if s.get("original_name") == original_name]
    if not ids:
        raise RunFailed(
            f"Zonos lists no speaker made from {original_name!r} (start it with SERVE_VOICES "
            "pointing at a folder that holds the file)"
        )
    if len(ids) > 1:
        raise RunFailed(f"Zonos lists several speakers made from {original_name!r}: {ids}")
    return str(ids[0])


async def find_berta(client: httpx.AsyncClient, zonos: str) -> str:
    """Berta's speaker id, looked up in Zonos by her file name. Also checks that Imogen is there."""
    try:
        response = await client.get(f"{zonos}/v2/speakers", timeout=QUICK)
    except httpx.HTTPError as error:
        raise RunFailed(f"cannot reach Zonos at {zonos} ({describe_error(error)})") from None
    if response.status_code != 200:
        raise RunFailed(f"Zonos answered GET /v2/speakers with {describe(response)}")
    try:
        listed = response.json()["speakers"]
    except (ValueError, KeyError, TypeError):
        listed = None
    if not isinstance(listed, list):
        raise RunFailed("Zonos's speaker list is not {'speakers': [...]}")
    speakers = [s for s in listed if isinstance(s, dict)]
    if IMOGEN_ID not in {s.get("id") for s in speakers}:
        raise RunFailed(f"Zonos does not list Imogen ({IMOGEN_ID})")
    return pick_speaker(speakers, BERTA_FILE)


async def get_health(client: httpx.AsyncClient, service: str) -> dict:
    """The service's /health body, once it says it is ready. Raises RunFailed if it does not."""
    try:
        response = await client.get(f"{service}/health", timeout=QUICK)
    except httpx.HTTPError as error:
        raise RunFailed(
            f"cannot reach the service at {service} ({describe_error(error)}): start it first"
        ) from None
    try:
        body = response.json()
    except ValueError:
        body = None
    if response.status_code != 200 or not isinstance(body, dict):
        raise RunFailed(f"the service answered GET /health with {describe(response)}")
    if body.get("ok") is not True or body.get("zonos") is not True:
        raise RunFailed(f"the service is not ready: {body}")
    if body.get("aligner") is not True:
        raise RunFailed(f"the service has no aligner (SPEECH_ALIGNER=python?): {body}")
    return body


async def require_stream(response: httpx.Response, media_type: str, what: str) -> None:
    """Raises RunFailed unless `response` is a 200 of `media_type`."""
    if response.status_code != 200:
        await response.aread()
        raise RunFailed(f"{what} answered {describe(response)}")
    content_type = response.headers.get("content-type", "")
    if not content_type.startswith(media_type):
        raise RunFailed(f"{what} is {content_type!r}, not {media_type}")


async def report_position(
    client: httpx.AsyncClient, session_url: str, sentence_id: str, run: Run
) -> None:
    """Tell the service that this sentence is now playing, so it may synthesize two further."""
    response = await client.post(
        f"{session_url}/position", json={"sentence_id": sentence_id}, timeout=QUICK
    )
    if response.status_code != 204:
        raise RunFailed(f"reporting the position {sentence_id!r} answered {describe(response)}")
    run.positions.append(sentence_id)


async def read_events(client: httpx.AsyncClient, session_url: str, run: Run) -> None:
    """Follow the timeline to its `done` (or `error`), reporting each sentence as it arrives."""
    parser = SseParser()
    async with client.stream(
        "GET", f"{session_url}/events", headers={"Accept": "text/event-stream"}, timeout=STREAM
    ) as response:
        await require_stream(response, "text/event-stream", "the events stream")
        async for chunk in response.aiter_bytes():
            try:
                pairs = parser.feed(chunk)
            except UnicodeDecodeError:
                raise RunFailed("the events stream is not UTF-8") from None
            for name, raw in pairs:
                event = parse_event(name, raw, run.now())
                run.events.append(event)
                if event.name == "sentence":
                    await report_position(client, session_url, event.data["id"], run)
                elif event.name == "error":
                    run.failure = (
                        f"the service ended the reading with an error event "
                        f"(sentence {event.data.get('id')!r}, code {event.data.get('code')!r})"
                    )
                if event.name in ("done", "error"):
                    return
    run.failure = "the events stream ended without a done or an error event"


async def read_audio(
    client: httpx.AsyncClient, session_url: str, run: Run, path: Path
) -> None:
    """Write the MP3 to `path` as it arrives, until the stream ends."""
    async with client.stream("GET", f"{session_url}/audio", timeout=STREAM) as response:
        await require_stream(response, "audio/mpeg", "the audio stream")
        with path.open("wb") as file:
            async for chunk in response.aiter_bytes():
                if chunk:
                    run.audio.add(chunk, run.now())
                    file.write(chunk)
    run.audio.ended_at = run.now()


async def perform(
    client: httpx.AsyncClient, service: str, run: Run, mp3_path: Path, timeout: float
) -> None:
    """Create the session, read its two streams to their ends, and end it. Raises RunFailed, an
    httpx error or TimeoutError when the reading does not get through."""
    run.started = time.perf_counter()
    response = await client.post(f"{service}/v1/sessions", json=run.request, timeout=QUICK)
    if response.status_code != 201:
        raise RunFailed(f"creating the session answered {describe(response)}")
    try:
        session_id = response.json()["session_id"]
    except (ValueError, KeyError, TypeError):
        session_id = None
    if not isinstance(session_id, str) or not session_id:
        raise RunFailed("creating the session did not answer with a session_id")
    run.session_id = session_id
    run.created_at = run.now()

    session_url = f"{service}/v1/sessions/{run.session_id}"
    tasks = [
        asyncio.create_task(read_audio(client, session_url, run, mp3_path), name="audio"),
        asyncio.create_task(read_events(client, session_url, run), name="events"),
    ]
    try:
        async with asyncio.timeout(timeout):
            await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        # End the session now, instead of leaving it to the service's idle clock.
        try:
            run.released = (await client.delete(session_url, timeout=QUICK)).status_code
        except httpx.HTTPError:
            pass


# What the numbers say.


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    detail: str


@dataclass(frozen=True)
class Row:
    """One sentence as sent, with the times the service gave it (None where it gave none)."""

    sentence: dict
    start: float | None
    end: float | None
    times: list | None  # one [start, end] or None per token

    @property
    def id(self) -> str:
        return self.sentence["id"]

    @property
    def tokens(self) -> list[str]:
        return self.sentence["tokens"]


def build_rows(sentences: list[dict], events: list[Received]) -> list[Row]:
    announced = {e.data["id"]: e.data for e in events if e.name == "sentence"}
    worded = {e.data["id"]: e.data for e in events if e.name == "words"}
    rows = []
    for sentence in sentences:
        said, words = announced.get(sentence["id"]), worded.get(sentence["id"])
        rows.append(
            Row(
                sentence,
                said["start"] if said else None,
                said["end"] if said else None,
                words["times"] if words else None,
            )
        )
    return rows


def unspeakable(token: str) -> bool:
    """A token with no letter or digit (a lone symbol, an arrow): the voice does not say it."""
    return not any(char.isalnum() for char in token)


def _summarize(problems: list[str], limit: int = 4) -> str:
    shown = "; ".join(problems[:limit])
    return shown + (f"; and {len(problems) - limit} more" if len(problems) > limit else "")


def check_events(sentences: list[dict], events: list[Received]) -> Check:
    ids = [s["id"] for s in sentences]
    names = [e.name for e in events]
    problems: list[str] = []
    for what in ("sentence", "words"):
        seen = [e.data["id"] for e in events if e.name == what]
        if seen != ids[: len(seen)]:
            problems.append(f"{what} events are out of order or name an unknown sentence")
        elif len(seen) < len(ids):
            problems.append(f"only {len(seen)} of {len(ids)} {what} events")
    first: dict[tuple[str, str], int] = {}
    for index, event in enumerate(events):
        if event.name in ("sentence", "words"):
            first.setdefault((event.name, event.data["id"]), index)
    for sentence_id in ids:
        said, worded = first.get(("sentence", sentence_id)), first.get(("words", sentence_id))
        if said is not None and worded is not None and worded < said:
            problems.append(f"the words of {sentence_id} came before its sentence event")
    for event in events:
        if event.name == "words":
            tokens = next((s["tokens"] for s in sentences if s["id"] == event.data["id"]), None)
            if tokens is not None and len(event.data["times"]) != len(tokens):
                problems.append(
                    f"{event.data['id']}: {len(event.data['times'])} times for {len(tokens)} tokens"
                )
    for event in events:
        if event.name == "error":
            problems.append(f"error event for {event.data.get('id')!r}: {event.data.get('code')!r}")
    if unknown := sorted({n for n in names if n not in KNOWN_EVENTS}):
        problems.append(f"unknown events: {', '.join(unknown)}")
    if names.count("done") > 1 or (names.count("done") == 1 and names[-1] != "done"):
        problems.append("done is not the last event, or came twice")
    if "done" not in names and "error" not in names:
        problems.append("the stream ended without done")
    if problems:
        return Check("events", False, _summarize(problems))
    return Check(
        "events",
        True,
        f"{len(ids)} sentence events and {len(ids)} word lists in order, then done; no error",
    )


def check_first_audio(audio: AudioLog) -> Check:
    if audio.first_audio_at is None:
        return Check("first audio", False, "no MP3 audio arrived")
    seconds = audio.first_audio_at
    return Check(
        "first audio",
        seconds < FIRST_AUDIO_LIMIT,
        f"{seconds:.2f} s from the POST (limit {FIRST_AUDIO_LIMIT:g} s)",
    )


def check_placement(rows: list[Row]) -> Check:
    placed = total = 0
    symbols: list[str] = []
    problems: list[str] = []
    for row in rows:
        total += len(row.tokens)
        if row.times is None:
            problems.append(f"{row.id} has no words event")
            continue
        for index, (token, interval) in enumerate(zip(row.tokens, row.times)):
            placed += 1 if interval is not None else 0
            if unspeakable(token) and interval is None:
                symbols.append(f"{row.id} token {index} {token!r}")
            elif unspeakable(token):
                problems.append(f"{row.id} token {index} {token!r} is a lone symbol but has a time")
            elif interval is None:
                problems.append(f"{row.id} token {index} {token!r} has no time")
    rest = f"; lone symbols without a time, as expected: {', '.join(symbols)}" if symbols else ""
    if problems:
        detail = f"{placed} of {total} tokens have a time; {_summarize(problems)}{rest}"
        return Check("words placed", False, detail)
    return Check("words placed", True, f"{placed} of {total} tokens have a time{rest}")


def check_order(rows: list[Row]) -> Check:
    problems: list[str] = []
    sentence_starts = word_starts = 0
    previous_sentence: float | None = None
    previous_word: tuple[float, str] | None = None
    for row in rows:
        if row.start is not None and row.end is not None:
            sentence_starts += 1
            if row.end < row.start:
                problems.append(f"{row.id} ends before it starts")
            if previous_sentence is not None and row.start < previous_sentence:
                problems.append(f"{row.id} starts before the sentence before it")
            previous_sentence = row.start
        for index, interval in enumerate(row.times or []):
            if interval is None:
                continue
            start, end = interval
            where = f"{row.id} token {index}"
            word_starts += 1
            if end < start:
                problems.append(f"{where} ends before it starts")
            if previous_word is not None and start < previous_word[0]:
                problems.append(
                    f"{where} starts at {start:.3f} s, before {previous_word[1]} at "
                    f"{previous_word[0]:.3f} s"
                )
            previous_word = (start, where)
            if row.start is not None and row.end is not None:
                if start < row.start - SPAN_TOLERANCE or end > row.end + SPAN_TOLERANCE:
                    problems.append(f"{where} lies outside its sentence")
    if problems:
        return Check("starts monotonic", False, _summarize(problems))
    return Check(
        "starts monotonic",
        True,
        f"{sentence_starts} sentence starts and {word_starts} word starts never go backwards; "
        f"every word lies inside its sentence (within {SPAN_TOLERANCE:g} s)",
    )


def check_gaps(
    rows: list[Row],
    gap_seconds: float = GAP_SECONDS,
    paragraph_gap_seconds: float = PARAGRAPH_GAP_SECONDS,
) -> Check:
    problems: list[str] = []
    gaps: list[float] = []
    for before, row in pairwise(rows):
        if before.end is None or row.start is None:
            continue
        gap = row.start - before.end
        gaps.append(gap)
        wanted = paragraph_gap_seconds if row.sentence["paragraph_start"] else gap_seconds
        if abs(gap - wanted) > GAP_TOLERANCE:
            problems.append(f"{gap:.2f} s before {row.id}, expected {wanted:.2f} s")
    if problems:
        return Check("gaps", False, _summarize(problems))
    shown = " ".join(f"{gap:.2f}" for gap in gaps)
    return Check(
        "gaps",
        True,
        f"{shown} s ({gap_seconds:.2f} s; {paragraph_gap_seconds:.2f} s before a paragraph start)",
    )


def check_length(rows: list[Row], audio: AudioLog) -> Check:
    ends = [row.end for row in rows if row.end is not None]
    length = audio.seconds
    if not ends or length is None:
        return Check("length", False, "no sentence end or no audio to compare")
    difference = length - ends[-1]
    return Check(
        "length",
        abs(difference) <= LENGTH_TOLERANCE,
        f"the timeline ends at {ends[-1]:.2f} s and the audio is {length:.2f} s long "
        f"(difference {difference:+.2f} s; from its size at 128 kbit/s)",
    )


def run_checks(
    rows: list[Row],
    run: Run,
    gap_seconds: float = GAP_SECONDS,
    paragraph_gap_seconds: float = PARAGRAPH_GAP_SECONDS,
) -> list[Check]:
    return [
        check_events(run.request["sentences"], run.events),
        check_first_audio(run.audio),
        check_placement(rows),
        check_order(rows),
        check_gaps(rows, gap_seconds, paragraph_gap_seconds),
        check_length(rows, run.audio),
    ]


# What it prints and writes.


def print_sent(request: dict) -> None:
    sentences = request["sentences"]
    tokens = sum(len(s["tokens"]) for s in sentences)
    print(f"sending {len(sentences)} sentences, {tokens} tokens:")
    print("  id    lang  voice   paragraph  text")
    for line, sentence in zip(LINES, sentences):
        para = "starts" if sentence["paragraph_start"] else "-"
        head = f"  {sentence['id']:<5} {sentence['language']:<5} {line.voice:<7} {para:<10}"
        print(f"{head} {line.text}")


def print_timeline(rows: list[Row]) -> None:
    print("timeline (seconds on the stream's clock; token numbers count from 0)")
    print("  id      start      end   gap  placed")
    previous_end: float | None = None
    for row in rows:
        start = f"{row.start:9.3f}" if row.start is not None else f"{'-':>9}"
        end = f"{row.end:9.3f}" if row.end is not None else f"{'-':>9}"
        gap = "-"
        if previous_end is not None and row.start is not None:
            gap = f"{row.start - previous_end:.2f}"
        notes = []
        if row.times is None:
            placed = "no words event"
        else:
            count = sum(interval is not None for interval in row.times)
            placed = f"{count}/{len(row.tokens)}"
            for index, (token, interval) in enumerate(zip(row.tokens, row.times)):
                if interval is None:
                    why = "a lone symbol, as expected" if unspeakable(token) else "UNEXPECTED"
                    notes.append(f"no time: token {index} {token!r} ({why})")
        print(f"  {row.id:<5} {start} {end} {gap:>5}  {placed}  {'; '.join(notes)}".rstrip())
        previous_end = row.end if row.end is not None else previous_end


def print_timings(run: Run) -> None:
    def seconds(value: float | None) -> str:
        return f"{value:.2f} s" if value is not None else "never"

    first_sentence = next((e.at for e in run.events if e.name == "sentence"), None)
    finished = next((e.at for e in run.events if e.name in ("done", "error")), None)
    print("timings (after the POST was sent)")
    print(f"  session created     {seconds(run.created_at)}")
    print(f"  first sentence      {seconds(first_sentence)}")
    print(f"  first audio         {seconds(run.audio.first_audio_at)}")
    print(f"  events finished     {seconds(finished)}")
    print(f"  audio finished      {seconds(run.audio.ended_at)}")
    if finished is not None and run.audio.seconds:
        print(
            f"  {run.audio.seconds:.1f} s of audio in {finished:.1f} s "
            f"({run.audio.seconds / finished:.1f}x real time)"
        )
    print(f"  audio: {run.audio.size} bytes in {run.audio.chunks} chunks")
    print(f"  positions reported: {len(run.positions)} (one per sentence event)")


def write_events_file(path: Path, run: Run, checks: list[Check]) -> None:
    def ms(seconds: float | None) -> float | None:
        return None if seconds is None else round(seconds, 3)

    payload = {
        "session_id": run.session_id,
        "passed": run.failure is None and all(check.ok for check in checks),
        "failure": run.failure,
        "request": run.request,
        "events": [
            {"at": round(e.at, 3), "event": e.name, "data": e.data} for e in run.events
        ],
        "positions_reported": run.positions,
        "audio": {
            "bytes": run.audio.size,
            "chunks": run.audio.chunks,
            "id3_tag_bytes": run.audio.tag_length,
            "first_byte_at": ms(run.audio.first_byte_at),
            "first_audio_at": ms(run.audio.first_audio_at),
            "ended_at": ms(run.audio.ended_at),
            "seconds_from_size": ms(run.audio.seconds),
        },
        "delete_status": run.released,
        "checks": [{"name": c.name, "ok": c.ok, "detail": c.detail} for c in checks],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


async def check(args: argparse.Namespace) -> int:
    out: Path = args.out
    async with httpx.AsyncClient(trust_env=False, timeout=QUICK) as client:
        print("speech service live check")
        try:
            health = await get_health(client, args.service)
            berta_id = await find_berta(client, args.zonos)
        except RunFailed as failure:
            print(f"RESULT: FAILED before the reading started: {failure}")
            return 1
        print(f"  service  {args.service} (health: {health})")
        print(f"  zonos    {args.zonos}")
        print(f"  voices   Imogen {IMOGEN_ID}; Berta {berta_id} (controls {BERTA_CONTROLS})")
        print(f"  output   {out}")
        request = build_request(berta_id)
        print_sent(request)

        run = Run(request)
        try:
            await perform(client, args.service, run, out / MP3_NAME, args.timeout)
        except RunFailed as failure:
            run.failure = str(failure)
        except httpx.HTTPError as error:
            run.failure = f"the connection failed ({describe_error(error)})"
        except TimeoutError:
            run.failure = f"the reading did not end within {args.timeout:g} s"

    rows = build_rows(request["sentences"], run.events)
    checks = run_checks(rows, run, args.gap, args.paragraph_gap)
    try:
        write_events_file(out / EVENTS_NAME, run, checks)
    except OSError as error:
        print(f"cannot write {out / EVENTS_NAME}: {error}")
        return 1

    print()
    print_timeline(rows)
    print()
    print_timings(run)
    print()
    print("checks")
    for item in checks:
        print(f"  {'PASS' if item.ok else 'MISS'}  {item.name:<16} {item.detail}")
    print()
    mp3 = out / MP3_NAME
    print(f"wrote {mp3 if mp3.exists() else 'no audio'} and {out / EVENTS_NAME}")
    if run.released not in (None, 204, 404):
        print(f"note: DELETE of the session answered {run.released}")
    if run.failure:
        print(f"RESULT: FAILED: {run.failure}")
        return 1
    missed = [item.name for item in checks if not item.ok]
    if missed:
        print(f"RESULT: MISS ({len(missed)} of {len(checks)} checks): {', '.join(missed)}")
        return 1
    print(f"RESULT: PASS (all {len(checks)} checks)")
    return 0


# The command line.


def _repository_root() -> Path | None:
    """The working tree this script lives in: its nearest ancestor that holds a `.git`."""
    for folder in Path(__file__).resolve().parents:
        if (folder / ".git").exists():
            return folder
    return None


def _url(parser: argparse.ArgumentParser, flag: str, value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        parser.error(f"{flag} must be an http(s) URL such as {DEFAULT_SERVICE}, got {value!r}")
    return value.rstrip("/")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="live_check.py",
        description=(
            "Post one mixed English and Hungarian reading to a running speech service, write "
            f"{MP3_NAME} and {EVENTS_NAME} into --out, and report the first-audio latency, the "
            "words placed against the tokens sent, and whether the times are in order."
        ),
        epilog=(
            "Exit status: 0 when every check passes, 1 when a check misses or the reading could "
            "not be carried out, 2 for a bad argument."
        ),
    )
    parser.add_argument(
        "--service",
        default=DEFAULT_SERVICE,
        metavar="URL",
        help="the speech service (default: %(default)s)",
    )
    parser.add_argument(
        "--zonos",
        default=DEFAULT_ZONOS,
        metavar="URL",
        help="Zonos, used only to look up Berta's speaker id (default: %(default)s)",
    )
    parser.add_argument(
        "--out",
        required=True,
        type=Path,
        metavar="DIR",
        help=f"where {MP3_NAME} and {EVENTS_NAME} go: a directory outside the repository",
    )
    parser.add_argument(
        "--gap",
        type=float,
        default=GAP_SECONDS,
        metavar="SECONDS",
        help="the silence the service puts between sentences (SPEECH_GAP_SECONDS; default: %(default)s)",
    )
    parser.add_argument(
        "--paragraph-gap",
        type=float,
        default=PARAGRAPH_GAP_SECONDS,
        metavar="SECONDS",
        help="the silence before a paragraph's first sentence (SPEECH_PARAGRAPH_GAP_SECONDS; default: %(default)s)",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=180.0,
        metavar="SECONDS",
        help="how long the whole reading may take (default: %(default)s)",
    )
    args = parser.parse_args(argv)
    args.service = _url(parser, "--service", args.service)
    args.zonos = _url(parser, "--zonos", args.zonos)
    if not args.timeout > 0:
        parser.error("--timeout must be more than 0")
    for flag, value in (("--gap", args.gap), ("--paragraph-gap", args.paragraph_gap)):
        if not (math.isfinite(value) and value >= 0):
            parser.error(f"{flag} must be a number of seconds from 0, got {value}")
    args.out = args.out.expanduser().resolve()
    root = _repository_root()
    if root is not None and args.out.is_relative_to(root):
        parser.error(f"--out must be outside the repository ({root}), got {args.out}")
    if args.out.exists() and not args.out.is_dir():
        parser.error(f"--out is not a directory: {args.out}")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    # A symbol that the terminal cannot show must not stop the report.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="backslashreplace")
    try:
        args.out.mkdir(parents=True, exist_ok=True)
        # No file of an earlier run stays to be mistaken for this one's.
        for name in (MP3_NAME, EVENTS_NAME):
            (args.out / name).unlink(missing_ok=True)
    except OSError as error:
        print(f"cannot prepare {args.out}: {error.strerror or error}", file=sys.stderr)
        return 1
    try:
        return asyncio.run(check(args))
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
