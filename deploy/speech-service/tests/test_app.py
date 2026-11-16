"""The HTTP app: routes, validation, the session registry, preview and health.

Two kinds of test. Most run the app under Starlette's `TestClient` (used as a context manager, so
the event loop that runs the sessions lives across requests): whole requests and their answers,
on a `fake_zonos`, a `FakeAligner` and a real ffmpeg. The ones about a stream's life (a client that
leaves, a reader that is already taken, a cancel under an open stream) drive the app as a server
does instead, with `Exchange`: the TestClient's streaming differs between Starlette versions, and
it never says `http.disconnect` before a response is done, which is what uvicorn does.
"""

import asyncio
import contextlib
import itertools
import json
import logging
import os
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass

import pytest
import uvicorn

from speech_service import __main__ as entry_point
from speech_service import app as app_module
from speech_service.aligner import NoAligner, make_aligner
from speech_service.app import create_app
from speech_service.audio import Mp3Encoder
from speech_service.config import Settings
from speech_service.session import ReadingSession
from speech_service.zonos import ZonosClient
from tests.fakes_zonos import fake_zonos, refusing_transport
from tests.helpers import SR, decode_mp3, decoded_seconds, rms_db

# Like tests/test_aligner.py: the bare module name, which both Pythons that run these tests find.
from fakes_aligner import FakeAligner

from starlette.testclient import TestClient

# Words that must never come back in an answer or a log line: they are in every body below.
SECRET = ("Zebrafish", "Quokka.")
MARKERS = ("zebrafish", "quokka")
MISSING = object()  # a field to leave out of a body
JSON = {"content-type": "application/json"}


@pytest.fixture(scope="module", autouse=True)
def encoder_delay_is_measured() -> None:
    """The encoder measures its delay once per process; keep that out of every timing below."""
    asyncio.run(Mp3Encoder.warm_up())


# What a client sends.


def sentence(index: int = 0, **fields) -> dict:
    """A valid sentence of a session request. Its words are SECRET, so any echo shows."""
    return {
        "id": f"s{index}",
        "language": "en",
        "voice": {"speaker_id": "quokka_voice", "controls": {}},
        "tokens": list(SECRET),
        "paragraph_start": False,
        **fields,
    }


def reading(count: int = 3, **fields) -> dict:
    """A valid session request of `count` sentences (the sixth and later wait for the reader)."""
    return {"sentences": [sentence(i) for i in range(count)], **fields}


def second(**changes) -> dict:
    """A reading of three sentences whose second one has `changes` (MISSING removes the field)."""
    body = reading(3)
    for name, value in changes.items():
        if value is MISSING:
            del body["sentences"][1][name]
        else:
            body["sentences"][1][name] = value
    return body


def voiced(**fields) -> dict:
    """A reading whose second sentence has a voice with `fields` (MISSING removes one)."""
    voice = {"speaker_id": "quokka_voice", "controls": {}}
    for name, value in fields.items():
        if value is MISSING:
            del voice[name]
        else:
            voice[name] = value
    return second(voice=voice)


def preview_request(**fields) -> dict:
    body = {
        "text": "Hello there.",
        "language": "en",
        "voice": {"speaker_id": "quokka_voice", "controls": {}},
    }
    for name, value in fields.items():
        if value is MISSING:
            del body[name]
        else:
            body[name] = value
    return body


def parse_sse(text: str) -> list[tuple[str, dict]]:
    """The events of an SSE body, each exactly `event: <name>\\ndata: <compact json>\\n\\n`."""
    assert text == "" or text.endswith("\n\n")
    events = []
    for block in text.split("\n\n")[:-1]:
        name_line, data_line = block.split("\n")  # two lines: nothing a client sent can add one
        assert name_line.startswith("event: ")
        assert data_line.startswith("data: ")
        data = json.loads(data_line[len("data: ") :])
        assert data_line == "data: " + json.dumps(data, separators=(",", ":"))
        events.append((name_line[len("event: ") :], data))
    return events


def of(events: list[tuple[str, dict]], name: str) -> list[dict]:
    return [data for event, data in events if event == name]


def ffmpeg_children() -> list[int]:
    """The ffmpeg processes this process has started and not yet seen end."""
    try:
        found = subprocess.run(
            ["pgrep", "-P", str(os.getpid()), "-x", "ffmpeg"], capture_output=True, text=True
        )
    except FileNotFoundError:  # no pgrep here: nothing to see
        return []
    return [int(pid) for pid in found.stdout.split()]


async def until(condition: Callable[[], bool], timeout: float = 10.0) -> None:
    """Wait for `condition`: for what a session shows only through its state."""
    async with asyncio.timeout(timeout):
        while not condition():
            await asyncio.sleep(0.01)


def wait_for(condition: Callable[[], bool], timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            return False
        time.sleep(0.02)
    return True


# The app, under TestClient.


def build_app(*, zonos=None, aligner=None, **settings):
    """An app on a fake Zonos (or `zonos`) and a FakeAligner (or `aligner`) with these Settings."""
    http, requests = zonos if zonos is not None else fake_zonos()
    app = create_app(
        Settings(**settings),
        ZonosClient("http://zonos.test", http),
        FakeAligner() if aligner is None else aligner,
    )
    return app, requests


@pytest.fixture
def serve():
    """`serve(**options)` builds an app and a started TestClient on it: `(client, zonos requests)`.
    Every client is closed when the test ends, which cancels the sessions it left behind."""
    stack = contextlib.ExitStack()

    def start(**options):
        app, requests = build_app(**options)
        return stack.enter_context(TestClient(app)), requests

    with stack:
        yield start


def known(client: TestClient, session_id: str) -> bool:
    """Whether the registry knows the session: a position that names no sentence is refused (422)
    by a session it knows and not found (404) otherwise, and it moves nobody."""
    reply = client.post(f"/v1/sessions/{session_id}/position", json={"sentence_id": "no-such-id"})
    assert reply.status_code in (404, 422)
    return reply.status_code == 422


@pytest.fixture
def sessions_made(monkeypatch):
    """The ReadingSessions the app makes, in order. The HTTP layer cannot show whether a session
    has ended (an ended session stays known for a while), so a test asks the session."""
    made: list[ReadingSession] = []

    class Recorded(ReadingSession):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            made.append(self)

    monkeypatch.setattr(app_module, "ReadingSession", Recorded)
    return made


def create(client: TestClient, body: dict | None = None) -> str:
    reply = client.post("/v1/sessions", json=reading() if body is None else body)
    assert reply.status_code == 201, reply.text
    return reply.json()["session_id"]


# A whole reading.


def test_session_round_trip(serve):
    client, requests = serve()
    created = client.post("/v1/sessions", json=reading(3))
    assert created.status_code == 201
    assert set(created.json()) == {"session_id"}
    session_id = created.json()["session_id"]
    assert isinstance(session_id, str) and session_id

    events = client.get(f"/v1/sessions/{session_id}/events")
    assert events.status_code == 200
    assert events.headers["content-type"].startswith("text/event-stream")
    assert events.headers["cache-control"] == "no-cache"
    timeline = parse_sse(events.text)
    announced, timed = of(timeline, "sentence"), of(timeline, "words")
    assert [data["id"] for data in announced] == ["s0", "s1", "s2"]
    assert all(set(data) == {"id", "start", "end"} for data in announced)
    assert all(data["start"] < data["end"] for data in announced)
    assert [data["id"] for data in timed] == ["s0", "s1", "s2"]
    assert all(set(data) == {"id", "times"} and len(data["times"]) == 2 for data in timed)
    assert timeline[-1] == ("done", {})
    assert [name for name, _ in timeline].count("done") == 1
    assert len(requests) == 3

    audio = client.get(f"/v1/sessions/{session_id}/audio")
    assert audio.status_code == 200
    assert audio.headers["content-type"] == "audio/mpeg"
    # The sentences and the gaps between them: the last `end` is where the speech stops.
    assert decoded_seconds(audio.content) == pytest.approx(announced[-1]["end"], abs=0.15)

    # Both readers have drained and the events were read to their end: over, and forgotten.
    assert not known(client, session_id)


def test_a_zonos_failure_comes_as_an_error_event_that_ends_the_stream(serve):
    client, _ = serve(zonos=fake_zonos(fail_on=2))
    session_id = create(client, reading(4))
    timeline = parse_sse(client.get(f"/v1/sessions/{session_id}/events").text)
    assert timeline[-1] == ("error", {"id": "s1", "code": "synthesis_failed"})
    assert "done" not in [name for name, _ in timeline]
    assert [data["id"] for data in of(timeline, "sentence")] == ["s0"]
    assert not known(client, session_id)  # a failed session is over; its events were read


def test_zonos_unreachable_comes_as_its_own_code(serve):
    client, _ = serve(zonos=(refusing_transport(), []))
    session_id = create(client, reading(2))
    timeline = parse_sse(client.get(f"/v1/sessions/{session_id}/events").text)
    assert timeline == [("error", {"id": "s0", "code": "zonos_unavailable"})]


def test_an_id_with_line_breaks_cannot_break_the_event_framing(serve):
    ugly = "a\nevent: error\ndata: {}\n\n\u2028b\r\nc"
    client, _ = serve()
    body = {"sentences": [sentence(0, id=ugly)]}
    timeline = parse_sse(client.get(f"/v1/sessions/{create(client, body)}/events").text)
    assert [name for name, _ in timeline] == ["sentence", "words", "done"]
    assert of(timeline, "sentence")[0]["id"] == ugly


def test_zonos_gets_the_voice_language_controls_and_the_seed_of_the_request(serve):
    client, requests = serve(seed=77)
    controls = {"room.clean": 2, "pitch_std": 0.25}
    voice = {"speaker_id": "hu_voice", "controls": controls}
    body = {
        "sentences": [sentence(0, language="hu", voice=voice, tokens=["Két", "tojás."])],
        "seed": 5,
    }
    session_id = create(client, body)
    client.get(f"/v1/sessions/{session_id}/events")
    assert len(requests) == 1
    assert requests[0]["speaker_embedding_id"] == "hu_voice"
    assert requests[0]["language"] == "hu"
    assert requests[0]["seed"] == 5  # the request's, not the settings'
    assert requests[0]["controls"] == controls
    assert type(requests[0]["controls"]["room.clean"]) is int  # unchanged, not made a float


def test_a_session_without_a_seed_uses_the_settings_seed(serve):
    client, requests = serve(seed=77)
    client.get(f"/v1/sessions/{create(client, reading(1))}/events")
    assert [request["seed"] for request in requests] == [77]


# Unknown sessions.


@pytest.mark.parametrize(
    ("method", "route", "options"),
    [
        ("GET", "events", {}),
        ("GET", "audio", {}),
        ("POST", "position", {"json": {"sentence_id": "s0"}}),
        ("POST", "position", {"json": {"sentence_id": 7}}),  # a bad body does not matter first
        ("DELETE", "", {}),
    ],
)
def test_unknown_session_404(serve, method, route, options):
    client, _ = serve()
    path = f"/v1/sessions/Quokka-no-such-session/{route}".rstrip("/")
    reply = client.request(method, path, **options)
    assert reply.status_code == 404
    assert reply.json() == {"error": "not_found"}
    assert not any(marker in reply.text.lower() for marker in MARKERS)


def test_a_cancelled_session_is_gone_for_every_route(serve):
    client, _ = serve()
    session_id = create(client)
    assert client.delete(f"/v1/sessions/{session_id}").status_code == 204
    assert client.delete(f"/v1/sessions/{session_id}").status_code == 404
    for route in ("events", "audio"):
        assert client.get(f"/v1/sessions/{session_id}/{route}").status_code == 404
    assert not known(client, session_id)


def test_delete_ends_a_session_that_nobody_reads_and_stops_its_ffmpeg(serve):
    client, requests = serve()
    session_id = create(client, reading(6))
    assert wait_for(lambda: len(ffmpeg_children()) >= 1)
    assert client.delete(f"/v1/sessions/{session_id}").status_code == 204
    assert ffmpeg_children() == []  # cancelled before the answer: nothing is left running
    count = len(requests)
    time.sleep(0.2)
    assert len(requests) == count


# One reader of each kind.


def test_second_audio_reader_409(serve):
    client, _ = serve()
    session_id = create(client)
    assert client.get(f"/v1/sessions/{session_id}/audio").status_code == 200
    second_reader = client.get(f"/v1/sessions/{session_id}/audio")
    assert second_reader.status_code == 409
    assert second_reader.json() == {"error": "reader_taken"}


def test_second_events_reader_409(serve):
    client, _ = serve()
    session_id = create(client)
    assert client.get(f"/v1/sessions/{session_id}/events").status_code == 200
    second_reader = client.get(f"/v1/sessions/{session_id}/events")
    assert second_reader.status_code == 409
    assert second_reader.json() == {"error": "reader_taken"}


def test_a_head_request_does_not_take_a_reader(serve):
    client, _ = serve()
    session_id = create(client)
    for route in ("audio", "events"):
        refused = client.head(f"/v1/sessions/{session_id}/{route}")
        assert refused.status_code == 405
        assert refused.headers["allow"] == "GET"
    assert client.get(f"/v1/sessions/{session_id}/events").status_code == 200
    assert client.get(f"/v1/sessions/{session_id}/audio").status_code == 200


def test_the_routes_take_the_methods_of_the_contract(serve):
    client, _ = serve()
    session_id = create(client)
    base = f"/v1/sessions/{session_id}"
    assert client.get("/v1/sessions").status_code == 405
    assert client.get(f"{base}/position").status_code == 405
    assert client.post(f"{base}/audio").status_code == 405
    assert client.post(f"{base}/events").status_code == 405
    assert client.post(base).status_code == 405
    assert client.get("/v1/preview").status_code == 405
    assert client.post("/health").status_code == 405
    assert known(client, session_id)  # and none of it touched the session


# Validation.

INVALID = [
    # (case, body, the field the answer names)
    ("sentences-missing", {"seed": 1}, "sentences"),
    ("sentences-not-a-list", {"sentences": "Zebrafish"}, "sentences"),
    ("sentences-null", {"sentences": None}, "sentences"),
    ("sentences-empty", {"sentences": []}, "sentences"),
    ("too-many-sentences", reading(2001), "sentences"),
    ("sentence-not-an-object", {"sentences": [sentence(0), "Zebrafish"]}, "sentences[1]"),
    ("sentence-null", {"sentences": [sentence(0), None]}, "sentences[1]"),
    ("id-missing", second(id=MISSING), "sentences[1].id"),
    ("id-empty", second(id=""), "sentences[1].id"),
    ("id-a-number", second(id=7), "sentences[1].id"),
    ("id-null", second(id=None), "sentences[1].id"),
    ("id-repeated", second(id="s0"), "sentences[1].id"),
    ("language-missing", second(language=MISSING), "sentences[1].language"),
    ("language-unknown", second(language="zebrafish"), "sentences[1].language"),
    ("language-zonos-name", second(language="en_us"), "sentences[1].language"),
    ("language-upper-case", second(language="EN"), "sentences[1].language"),
    ("language-a-number", second(language=7), "sentences[1].language"),
    ("language-a-list", second(language=["en"]), "sentences[1].language"),
    ("voice-missing", second(voice=MISSING), "sentences[1].voice"),
    ("voice-a-string", second(voice="quokka_voice"), "sentences[1].voice"),
    ("voice-null", second(voice=None), "sentences[1].voice"),
    ("speaker-missing", voiced(speaker_id=MISSING), "sentences[1].voice.speaker_id"),
    ("speaker-empty", voiced(speaker_id=""), "sentences[1].voice.speaker_id"),
    ("speaker-a-number", voiced(speaker_id=7), "sentences[1].voice.speaker_id"),
    ("controls-a-list", voiced(controls=[1.5]), "sentences[1].voice.controls"),
    ("controls-null", voiced(controls=None), "sentences[1].voice.controls"),
    ("controls-a-string", voiced(controls="Quokka"), "sentences[1].voice.controls"),
    ("control-a-string", voiced(controls={"quokka": "loud"}), "sentences[1].voice.controls"),
    ("control-a-bool", voiced(controls={"quokka": True}), "sentences[1].voice.controls"),
    ("control-null", voiced(controls={"quokka": None}), "sentences[1].voice.controls"),
    ("control-a-list", voiced(controls={"quokka": [1]}), "sentences[1].voice.controls"),
    ("control-a-mapping", voiced(controls={"quokka": {"a": 1}}), "sentences[1].voice.controls"),
    ("tokens-missing", second(tokens=MISSING), "sentences[1].tokens"),
    ("tokens-a-string", second(tokens="Zebrafish Quokka."), "sentences[1].tokens"),
    ("tokens-null", second(tokens=None), "sentences[1].tokens"),
    ("tokens-empty", second(tokens=[]), "sentences[1].tokens"),
    ("token-a-number", second(tokens=["Zebrafish", 7]), "sentences[1].tokens"),
    ("token-null", second(tokens=["Zebrafish", None]), "sentences[1].tokens"),
    ("token-a-list", second(tokens=[["Zebrafish"]]), "sentences[1].tokens"),
    ("sentence-too-long", second(tokens=["Quokka" * 67]), "sentences[1].tokens"),  # 402 characters
    ("sentence-too-long-in-tokens", second(tokens=["Quokka"] * 58), "sentences[1].tokens"),  # 405
    ("paragraph-start-missing", second(paragraph_start=MISSING), "sentences[1].paragraph_start"),
    ("paragraph-start-a-number", second(paragraph_start=1), "sentences[1].paragraph_start"),
    ("paragraph-start-a-string", second(paragraph_start="true"), "sentences[1].paragraph_start"),
    ("paragraph-start-null", second(paragraph_start=None), "sentences[1].paragraph_start"),
    ("seed-a-string", reading(2, seed="Quokka"), "seed"),
    ("seed-a-float", reading(2, seed=1.5), "seed"),
    ("seed-a-whole-float", reading(2, seed=1234.0), "seed"),
    ("seed-a-bool", reading(2, seed=True), "seed"),
    ("seed-negative", reading(2, seed=-1), "seed"),
    ("seed-over-zonos-bound", reading(2, seed=4294967296), "seed"),
    ("seed-null", reading(2, seed=None), "seed"),
    ("seed-a-list", reading(2, seed=[1]), "seed"),
]


@pytest.mark.parametrize(
    ("body", "field"), [case[1:] for case in INVALID], ids=[case[0] for case in INVALID]
)
def test_bad_session_request_422_without_echo(serve, body, field):
    client, requests = serve()
    reply = client.post("/v1/sessions", json=body)
    assert reply.status_code == 422
    assert reply.json() == {"error": "invalid", "field": field}
    assert not any(marker in reply.text.lower() for marker in MARKERS)  # the field path only
    assert requests == []  # nothing was started


def test_bad_language_422_without_echo(serve):
    client, _ = serve()
    body = reading(1)
    body["sentences"][0]["language"] = "xx"
    reply = client.post("/v1/sessions", json=body)
    assert reply.status_code == 422
    assert reply.json() == {"error": "invalid", "field": "sentences[0].language"}
    for word in (*SECRET, "quokka_voice", "xx"):  # nothing of the body comes back
        assert word not in reply.text


@pytest.mark.parametrize(
    ("content", "field"),
    [
        (b"", "body"),
        (b"Quokka, not json", "body"),
        (b'{"sentences": [', "body"),
        (b"\xff\xfe\xfd", "body"),  # not UTF-8
        (b'["Zebrafish"]', "body"),
        (b'"Zebrafish"', "body"),
        (b"null", "body"),
        (b"[" * 100_000, "body"),  # nested deeper than the parser goes
        (  # JSON.parse refuses NaN and Infinity, Python does not
            b'{"sentences": [{"id": "a", "language": "en", "tokens": ["Quokka"], '
            b'"paragraph_start": false, "voice": {"speaker_id": "v", "controls": {"x": NaN}}}]}',
            "sentences[0].voice.controls",
        ),
        (
            b'{"sentences": [{"id": "a", "language": "en", "tokens": ["Quokka"], '
            b'"paragraph_start": false, "voice": {"speaker_id": "v", "controls": {"x": -Infinity}}}'
            b"]}",
            "sentences[0].voice.controls",
        ),
        (
            b'{"sentences": [{"id": "a", "language": "en", "tokens": ["Quokka"], '
            b'"paragraph_start": false, "voice": {"speaker_id": "v", "controls": {"x": 1e999}}}]}',
            "sentences[0].voice.controls",
        ),
    ],
)
def test_a_body_that_is_not_a_request_422(serve, content, field):
    client, _ = serve()
    reply = client.post("/v1/sessions", content=content, headers=JSON)
    assert reply.status_code == 422
    assert reply.json() == {"error": "invalid", "field": field}
    assert not any(marker in reply.text.lower() for marker in MARKERS)


# The size of a body. The service is on loopback and its client is trusted, but a client with a bug
# must not be able to take the service's memory by sending one huge body.

MAX_BODY_BYTES = 4 * 1024 * 1024  # what the README says: about 2000 sentences of 400 characters


def reading_of_size(size: int) -> bytes:
    """A valid session request of exactly `size` bytes: an unknown field (which is ignored) takes up
    what the one sentence does not."""
    body = {**reading(1), "padding": ""}
    empty = len(json.dumps(body, separators=(",", ":")))
    body["padding"] = "x" * (size - empty)
    encoded = json.dumps(body, separators=(",", ":")).encode()
    assert len(encoded) == size
    return encoded


def test_a_body_of_4_mib_is_read_and_one_byte_more_is_refused_with_413(serve, sessions_made):
    client, _ = serve()
    fits = client.post("/v1/sessions", content=reading_of_size(MAX_BODY_BYTES), headers=JSON)
    assert fits.status_code == 201
    over = client.post("/v1/sessions", content=reading_of_size(MAX_BODY_BYTES + 1), headers=JSON)
    assert over.status_code == 413
    assert over.json() == {"error": "too_large"}
    assert len(sessions_made) == 1  # nothing was started for the one that was refused


@pytest.mark.parametrize("route", ["sessions", "position", "preview"])
def test_every_route_that_reads_a_body_refuses_one_over_4_mib(serve, route):
    client, requests = serve()
    session_id = create(client, reading(6))
    path = {
        "sessions": "/v1/sessions",
        "position": f"/v1/sessions/{session_id}/position",
        "preview": "/v1/preview",
    }[route]
    refused = client.post(path, content=b" " * (MAX_BODY_BYTES + 1), headers=JSON)
    assert refused.status_code == 413
    assert refused.json() == {"error": "too_large"}
    assert known(client, session_id)  # and the session it was about is as it was


async def call_with_chunks(app, chunks, *, headers=(), path="/v1/sessions"):
    """Run one POST through `app` as a server does, with a body that arrives in `chunks` (an
    iterator). Returns the status of the answer and how many pieces of the body were taken."""
    taken = 0
    answered: list[dict] = []

    async def receive():
        nonlocal taken
        taken += 1
        chunk = next(chunks, None)
        return {"type": "http.request", "body": chunk or b"", "more_body": chunk is not None}

    async def send(message):
        answered.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(b"host", b"127.0.0.1:1920"), *headers],
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 1920),
        "state": {},
    }
    await app(scope, receive, send)
    return answered[0]["status"], taken


async def test_a_body_with_no_length_is_refused_once_it_has_grown_past_the_cap(harness):
    web = await harness()
    megabyte = b"x" * 1024 * 1024
    status, taken = await call_with_chunks(web.app, itertools.repeat(megabyte, 200))
    assert status == 413
    assert taken <= 6  # the fifth megabyte crossed the cap: the other 195 were never asked for


async def test_a_declared_length_over_the_cap_is_refused_before_the_body_is_read(harness):
    web = await harness()

    def never_read():
        raise AssertionError("the body was read although its length was over the cap")
        yield  # makes this a generator, which is what `chunks` is

    declared = [(b"content-length", str(MAX_BODY_BYTES + 1).encode())]
    status, taken = await call_with_chunks(web.app, never_read(), headers=declared)
    assert status == 413
    assert taken == 0


@pytest.mark.parametrize("seed", [0, 1, 1234, 4294967295])
def test_a_seed_inside_zonos_range_is_accepted(serve, seed):
    client, requests = serve()
    client.get(f"/v1/sessions/{create(client, reading(1, seed=seed))}/events")
    assert [request["seed"] for request in requests] == [seed]


def test_the_most_a_reading_may_hold_is_2000_sentences(serve):
    client, _ = serve()
    session_id = create(client, reading(2000))
    assert client.delete(f"/v1/sessions/{session_id}").status_code == 204


def test_a_sentence_may_be_400_characters_with_the_spaces_between_its_tokens(serve):
    client, _ = serve()
    create(client, second(tokens=["Quokka" * 66 + "abcd"]))  # one token of 400 characters
    create(client, second(tokens=["Quokka"] * 56 + ["abcdefgh"]))  # 56 * 7 - 1 + 1 + 8 = 400
    for tokens in (["Quokka" * 66 + "abcde"], ["Quokka"] * 56 + ["abcdefghi"]):  # 401
        refused = client.post("/v1/sessions", json=second(tokens=tokens))
        assert refused.status_code == 422
        assert refused.json() == {"error": "invalid", "field": "sentences[1].tokens"}


def test_the_longest_sentence_is_the_settings_not_a_constant(serve):
    client, _ = serve(max_sentence_chars=10)
    short, long = sentence(0, tokens=["ab"]), sentence(1, tokens=["abcdef", "ghijk"])  # 12 chars
    refused = client.post("/v1/sessions", json={"sentences": [short, long]})
    assert refused.status_code == 422
    assert refused.json() == {"error": "invalid", "field": "sentences[1].tokens"}
    assert client.post("/v1/sessions", json=reading(1)).status_code == 422  # SECRET is 17
    ten = {"sentences": [sentence(0, tokens=["abcdef", "ghi"])]}  # 10 characters
    assert client.post("/v1/sessions", json=ten).status_code == 201


def test_unknown_fields_are_ignored(serve):
    client, requests = serve()
    body = reading(1, shout="Quokka")
    body["sentences"][0]["pitch"] = 3
    body["sentences"][0]["voice"]["style"] = "Zebrafish"
    client.get(f"/v1/sessions/{create(client, body)}/events")
    assert len(requests) == 1
    assert set(requests[0]) <= {  # the fields Zonos knows: it answers any other with 422
        *("text", "language", "format", "stream", "speaker_embedding_id", "speaker_mode"),
        *("seed", "text_normalization", "controls"),
    }


def test_each_sentence_may_have_its_own_language_and_voice(serve):
    client, requests = serve()
    other = {"speaker_id": "hu_voice", "controls": {"room.clean": 2.0}}
    body = {
        "sentences": [
            sentence(0),
            sentence(
                1, language="hu", voice=other, tokens=["Szia", "világ."], paragraph_start=True
            ),
        ]
    }
    client.get(f"/v1/sessions/{create(client, body)}/events")
    assert [request["language"] for request in requests] == ["en_us", "hu"]
    assert [request["speaker_embedding_id"] for request in requests] == ["quokka_voice", "hu_voice"]


# Position.


def test_position_of_a_known_sentence_204(serve):
    client, _ = serve()
    session_id = create(client, reading(6))
    for sentence_id in ("s3", "s0", "s5"):  # forwards and back
        position = {"sentence_id": sentence_id}
        reply = client.post(f"/v1/sessions/{session_id}/position", json=position)
        assert reply.status_code == 204
        assert reply.content == b""


@pytest.mark.parametrize(
    ("content", "field"),
    [
        (json.dumps({"sentence_id": "quokka-no-such-sentence"}).encode(), "sentence_id"),
        (json.dumps({"sentence_id": ""}).encode(), "sentence_id"),
        (json.dumps({"sentence_id": 3}).encode(), "sentence_id"),
        (json.dumps({"sentence_id": None}).encode(), "sentence_id"),
        (json.dumps({"sentence": "s0"}).encode(), "sentence_id"),
        (json.dumps({}).encode(), "sentence_id"),
        (b'["s0"]', "body"),
        (b"Quokka", "body"),
        (b"", "body"),
    ],
)
def test_position_of_an_unknown_sentence_422(serve, content, field):
    client, _ = serve()
    session_id = create(client)
    reply = client.post(
        f"/v1/sessions/{session_id}/position", content=content, headers=JSON
    )
    assert reply.status_code == 422
    assert reply.json() == {"error": "invalid", "field": field}
    assert "quokka" not in reply.text.lower()


# An ended session stays known for a while.
#
# A failure comes within milliseconds, and a player's streams connect one round trip after the
# session was made: it is over by then, but what it said is still waiting for its readers. So an
# ended session is kept until its events have been read to their end, or until idle_seconds after
# it ended, whichever comes first.


def test_a_failure_before_the_readers_come_still_gives_them_its_error(serve, sessions_made):
    client, _ = serve(zonos=(refusing_transport(), []))
    session_id = create(client, reading(2))
    assert wait_for(lambda: sessions_made[0].ended)  # Zonos is down: over within milliseconds
    assert known(client, session_id)  # and still known

    late = client.get(f"/v1/sessions/{session_id}/events")  # the events reader comes late
    assert late.status_code == 200
    assert parse_sse(late.text) == [("error", {"id": "s0", "code": "zonos_unavailable"})]
    assert not known(client, session_id)  # read to their end: forgotten at once


def test_a_late_audio_reader_of_an_ended_session_gets_an_ended_stream(serve, sessions_made):
    client, _ = serve(zonos=(refusing_transport(), []))
    session_id = create(client, reading(2))
    assert wait_for(lambda: sessions_made[0].ended)
    audio = client.get(f"/v1/sessions/{session_id}/audio")
    assert (audio.status_code, audio.headers["content-type"]) == (200, "audio/mpeg")
    assert audio.content == b""  # nothing was said, and the stream is over
    # That reader is taken for good (409, not 404), and the events are still there for theirs.
    assert client.get(f"/v1/sessions/{session_id}/audio").status_code == 409
    events = client.get(f"/v1/sessions/{session_id}/events")
    assert parse_sse(events.text) == [("error", {"id": "s0", "code": "zonos_unavailable"})]


def test_an_ended_session_is_forgotten_idle_seconds_after_it_ended(serve, sessions_made):
    client, _ = serve(zonos=(refusing_transport(), []), idle_seconds=0.6)
    session_id = create(client, reading(2))
    assert wait_for(lambda: sessions_made[0].ended)
    ended = time.monotonic()
    time.sleep(0.25)
    assert known(client, session_id)  # inside the time: a late reader still has it
    assert wait_for(lambda: not known(client, session_id), timeout=5)
    assert time.monotonic() - ended >= 0.5  # not before idle_seconds were up
    assert client.get(f"/v1/sessions/{session_id}/events").status_code == 404


def test_the_time_is_counted_from_the_end_even_when_nobody_asks(serve, sessions_made):
    client, _ = serve(zonos=(refusing_transport(), []), idle_seconds=0.5)
    session_id = create(client, reading(2))
    assert wait_for(lambda: sessions_made[0].ended)
    time.sleep(1.0)  # no request at all meanwhile: the registry looks by itself
    # The first request is after the time was up. Had the registry first looked now, the session
    # would seem to have ended just now and would still be here.
    assert client.get(f"/v1/sessions/{session_id}/events").status_code == 404


def test_a_session_nobody_reads_ends_by_idle_and_is_forgotten_as_long_after(serve, sessions_made):
    client, _ = serve(idle_seconds=0.6)
    session_id = create(client, reading(6))
    assert known(client, session_id)
    assert wait_for(lambda: sessions_made[0].ended, timeout=5)  # nobody reads the audio: idle
    ended = time.monotonic()
    time.sleep(0.25)
    assert known(client, session_id)  # its events were not read: kept for as long again
    assert wait_for(lambda: not known(client, session_id), timeout=5)
    assert time.monotonic() - ended >= 0.5
    assert client.delete(f"/v1/sessions/{session_id}").status_code == 404


def test_position_and_delete_are_accepted_for_an_ended_session_that_is_still_known(
    serve, sessions_made
):
    client, _ = serve(zonos=(refusing_transport(), []))
    session_id = create(client, reading(2))
    assert wait_for(lambda: sessions_made[0].ended)
    position = client.post(f"/v1/sessions/{session_id}/position", json={"sentence_id": "s1"})
    assert position.status_code == 204  # nothing to move, and no complaint
    assert client.delete(f"/v1/sessions/{session_id}").status_code == 204
    assert client.get(f"/v1/sessions/{session_id}/events").status_code == 404  # DELETE forgets it


def test_every_session_has_its_own_id(serve):
    client, _ = serve()
    ids = {create(client, reading(1)) for _ in range(5)}
    assert len(ids) == 5


# Preview.


def test_preview_returns_mp3(serve):
    aligner = FakeAligner()
    client, requests = serve(aligner=aligner)
    reply = client.post(
        "/v1/preview",
        json=preview_request(
            text="  Hello\n there.  ", voice={"speaker_id": "Imre", "controls": {"room.clean": 2}}
        ),
    )
    assert reply.status_code == 200
    assert reply.headers["content-type"] == "audio/mpeg"
    assert reply.content.startswith((b"ID3", b"\xff\xfb", b"\xff\xf3"))  # an MP3, whole
    assert len(requests) == 1
    assert requests[0]["text"] == "Hello there."  # the words, normalized, whitespace folded
    assert requests[0]["speaker_embedding_id"] == "Imre"
    assert requests[0]["controls"] == {"room.clean": 2}
    assert requests[0]["language"] == "en_us"
    assert requests[0]["seed"] == 1234
    # The clip is as long as Zonos made it (the fake: 0.06 s per character and 0.3 s), loudness
    # matched, and made once: no timeline, and no alignment.
    seconds = 0.06 * len("Hello there.") + 0.3
    assert decoded_seconds(reply.content) == pytest.approx(seconds, abs=0.15)
    pcm = decode_mp3(reply.content)
    assert rms_db(pcm[round(0.2 * SR) : round(0.9 * SR)]) == pytest.approx(-20.0, abs=1.5)


def test_preview_is_not_aligned(serve):
    class Refuses(FakeAligner):
        def align(self, audio_16k, words):
            raise AssertionError("a preview has no word times")

    client, _ = serve(aligner=Refuses())
    assert client.post("/v1/preview", json=preview_request()).status_code == 200


def test_preview_speaks_hungarian_with_the_hungarian_fix(serve):
    client, requests = serve()
    reply = client.post("/v1/preview", json=preview_request(text="2 tojás", language="hu"))
    assert reply.status_code == 200
    assert requests[0]["language"] == "hu"
    assert requests[0]["text"] == "két tojás"


def test_preview_with_nothing_to_say_422_on_text(serve):
    client, requests = serve()
    for text in ("🙂 …", "   ", "\n\t"):
        reply = client.post("/v1/preview", json=preview_request(text=text))
        assert reply.status_code == 422
        assert reply.json() == {"error": "invalid", "field": "text"}
    assert requests == []


@pytest.mark.parametrize(
    ("body", "field"),
    [
        (preview_request(text=MISSING), "text"),
        (preview_request(text=""), "text"),
        (preview_request(text=7), "text"),
        (preview_request(text=None), "text"),
        (preview_request(text="Zebrafish " * 31), "text"),  # 310 characters
        (preview_request(text="Z" * 301), "text"),
        (preview_request(language=MISSING), "language"),
        (preview_request(language="zebrafish"), "language"),
        (preview_request(language="en_us"), "language"),
        (preview_request(voice=MISSING), "voice"),
        (preview_request(voice="quokka_voice"), "voice"),
        (preview_request(voice={"controls": {}}), "voice.speaker_id"),
        (preview_request(voice={"speaker_id": "", "controls": {}}), "voice.speaker_id"),
        (preview_request(voice={"speaker_id": "v", "controls": {"q": "loud"}}), "voice.controls"),
        (preview_request(voice={"speaker_id": "v", "controls": [1]}), "voice.controls"),
    ],
)
def test_bad_preview_request_422_without_echo(serve, body, field):
    client, requests = serve()
    reply = client.post("/v1/preview", json=body)
    assert reply.status_code == 422
    assert reply.json() == {"error": "invalid", "field": field}
    assert not any(marker in reply.text.lower() for marker in MARKERS)
    assert requests == []


def test_preview_text_may_be_300_characters(serve):
    client, _ = serve()
    assert client.post("/v1/preview", json=preview_request(text="Z" * 300)).status_code == 200


def test_preview_controls_may_be_absent(serve):
    client, requests = serve()
    reply = client.post("/v1/preview", json=preview_request(voice={"speaker_id": "v"}))
    assert reply.status_code == 200
    assert "controls" not in requests[0]  # none given, none sent


def test_a_body_that_is_not_json_is_not_a_preview_request(serve):
    client, _ = serve()
    reply = client.post("/v1/preview", content=b"Quokka", headers=JSON)
    assert reply.status_code == 422
    assert reply.json() == {"error": "invalid", "field": "body"}


def test_preview_when_zonos_is_unreachable_503(serve):
    client, _ = serve(zonos=(refusing_transport(), []))
    reply = client.post("/v1/preview", json=preview_request())
    assert reply.status_code == 503
    assert reply.json() == {"code": "zonos_unavailable"}


def test_preview_when_synthesis_fails_502(serve):
    client, _ = serve(zonos=fake_zonos(fail_on=1))
    reply = client.post("/v1/preview", json=preview_request())
    assert reply.status_code == 502
    assert reply.json() == {"code": "synthesis_failed"}


def test_preview_when_the_encoder_is_gone_502(serve, monkeypatch):
    class Broken:
        async def __aenter__(self):
            raise FileNotFoundError("ffmpeg")

        async def __aexit__(self, *error):
            return None

    client, _ = serve()
    monkeypatch.setattr(app_module, "Mp3Encoder", Broken)
    reply = client.post("/v1/preview", json=preview_request())
    assert reply.status_code == 502
    assert reply.json() == {"code": "synthesis_failed"}


@pytest.mark.parametrize("breaks", ["normalize", "match_loudness", "_encode"])
def test_an_unexpected_failure_of_a_preview_is_a_500_that_says_nothing_of_the_text(
    serve, monkeypatch, caplog, breaks
):
    # A bug somewhere in the preview, with a message that quotes the text it was given. Left to
    # Starlette it is a 500 whose exception the server logs with its message and traceback.
    caplog.set_level(logging.DEBUG)

    def bug(*args, **kwargs):
        raise ValueError("cannot handle " + " ".join(SECRET))

    async def async_bug(*args, **kwargs):
        raise ValueError("cannot handle " + " ".join(SECRET))

    monkeypatch.setattr(app_module, breaks, async_bug if breaks == "_encode" else bug)
    client, _ = serve()
    reply = client.post("/v1/preview", json=preview_request(text="Zebrafish Quokka."))
    assert reply.status_code == 500
    assert reply.json() == {"code": "synthesis_failed"}  # fixed: the same for every bug
    assert not any(marker in reply.text.lower() for marker in MARKERS)
    lines = _logged(caplog)
    assert any("ValueError at test_app.py:" in line for line in lines)  # its type and its place
    for line in lines:
        assert not any(marker in line.lower() for marker in MARKERS), line


def test_a_failed_preview_does_not_stop_the_next_one(serve, monkeypatch):
    client, _ = serve()
    real = app_module.normalize

    def bug_once(tokens, language):
        monkeypatch.setattr(app_module, "normalize", real)
        raise ValueError("a bug")

    monkeypatch.setattr(app_module, "normalize", bug_once)
    assert client.post("/v1/preview", json=preview_request()).status_code == 500
    assert client.post("/v1/preview", json=preview_request()).status_code == 200


def test_preview_works_after_a_failed_one(serve):
    client, _ = serve(zonos=fake_zonos(fail_on=1))
    assert client.post("/v1/preview", json=preview_request()).status_code == 502
    assert client.post("/v1/preview", json=preview_request()).status_code == 200


# Health.


def test_health_reports_parts(serve):
    client, _ = serve()
    reply = client.get("/health")
    assert reply.status_code == 200
    assert reply.json() == {"ok": True, "zonos": True, "aligner": True}
    assert list(reply.json()) == ["ok", "zonos", "aligner"]


def test_health_with_zonos_down_is_still_200(serve):
    client, _ = serve(zonos=(refusing_transport(), []))
    reply = client.get("/health")
    assert reply.status_code == 200
    assert reply.json() == {"ok": False, "zonos": False, "aligner": True}


def test_health_says_when_there_are_no_word_times(serve):
    client, _ = serve(aligner=NoAligner())
    assert client.get("/health").json() == {"ok": True, "zonos": True, "aligner": False}


def test_health_with_neither_up(serve):
    client, _ = serve(zonos=(refusing_transport(), []), aligner=NoAligner())
    assert client.get("/health").json() == {"ok": False, "zonos": False, "aligner": False}


def test_health_says_so_when_the_configured_aligner_could_not_be_set_up(serve, tmp_path):
    # A native backend whose CLI and model are not there: `make_aligner` answers with NoAligner,
    # and health must not claim word times that cannot come.
    settings = Settings(
        aligner="native",
        aligner_cli=str(tmp_path / "no-such-cli"),
        aligner_model=str(tmp_path / "no-such-model"),
    )
    client, _ = serve(aligner=make_aligner(settings))
    assert client.get("/health").json() == {"ok": True, "zonos": True, "aligner": False}
    # Readings go on, with sentence marks only.
    timeline = parse_sse(client.get(f"/v1/sessions/{create(client, reading(2))}/events").text)
    assert all(data["times"] == [None, None] for data in of(timeline, "words"))
    assert timeline[-1] == ("done", {})


def test_a_session_runs_without_an_aligner_and_says_so_in_its_events(serve):
    client, _ = serve(aligner=NoAligner())
    timeline = parse_sse(client.get(f"/v1/sessions/{create(client, reading(2))}/events").text)
    assert all(data["times"] == [None, None] for data in of(timeline, "words"))
    assert timeline[-1] == ("done", {})


# The app's start and end.


def test_leaving_the_app_cancels_every_session():
    app, requests = build_app()
    with TestClient(app) as client:
        for _ in range(2):
            create(client, reading(6))
        assert wait_for(lambda: len(ffmpeg_children()) == 2)
    assert ffmpeg_children() == []  # the lifespan has ended: both are cancelled and reaped
    count = len(requests)
    time.sleep(0.2)
    assert len(requests) == count


def test_the_encoder_delay_is_measured_when_the_app_starts(monkeypatch):
    measured = []

    async def warm_up():
        measured.append(True)
        return 0.0

    monkeypatch.setattr(Mp3Encoder, "warm_up", warm_up)
    app, _ = build_app()
    assert measured == []  # building the app does not
    with TestClient(app):
        assert measured == [True]  # starting it does, before a request is served


def test_an_app_whose_encoder_cannot_start_does_not_start(monkeypatch):
    async def no_ffmpeg():
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr(Mp3Encoder, "warm_up", no_ffmpeg)
    app, _ = build_app()
    with pytest.raises(FileNotFoundError), TestClient(app):
        pass


# No reply text in logs.


def _logged(caplog) -> list[str]:
    lines = []
    for record in caplog.records:
        lines.append(record.getMessage())
        if record.exc_text:
            lines.append(record.exc_text)
    return lines


@pytest.mark.parametrize(
    "scenario", ["reading", "bad-request", "preview", "preview-503", "preview-502"]
)
def test_no_reply_text_is_logged(serve, caplog, scenario):
    caplog.set_level(logging.DEBUG)
    options: dict = {}
    if scenario == "preview-503":
        options["zonos"] = (refusing_transport(), [])
    if scenario == "preview-502":
        options["zonos"] = fake_zonos(fail_on=1)
    client, _ = serve(**options)
    if scenario == "reading":
        client.get(f"/v1/sessions/{create(client, reading(2))}/events")
    elif scenario == "bad-request":
        client.post("/v1/sessions", json=second(language="quokka"))
        client.post("/v1/preview", json=preview_request(text="Z" * 301))
    else:
        client.post("/v1/preview", json=preview_request(text="Zebrafish Quokka."))
    for line in _logged(caplog):
        assert not any(marker in line.lower() for marker in MARKERS), line


# A client that talks to the app the way a server runs it.


@dataclass
class Reply:
    status: int
    headers: dict[str, str]
    body: bytes

    def json(self):
        return json.loads(self.body)


class Exchange:
    """One HTTP exchange with the app, run as a server runs it, with a client that can leave.

    The request goes in as one message. What the app sends comes out through `chunk()`; the
    response is not delivered to anyone, so a stream the test does not read does not hold the app
    back (it is the generators' queues that grow). `leave()` is the client closing its connection:
    the app's `receive` says `http.disconnect`, and from ASGI 2.4 on its `send` raises OSError.

    With `stall`, the client does not read: the first `send` of a piece of the body does not
    return (a full socket buffer) until the client leaves, and `stalled` is set while it waits.
    """

    def __init__(self, app, method, path, body=b"", *, spec_version="2.3", stall=False):
        self.status: int | None = None
        self.headers: dict[str, str] = {}
        self.stalled = asyncio.Event()
        self._stall = stall
        self._unstalled = asyncio.Event()
        self._body = body
        self._raises_when_gone = tuple(map(int, spec_version.split("."))) >= (2, 4)
        self._request_sent = False
        self._gone = False
        self._over = asyncio.Event()  # the client has left, or the response is complete
        self._chunks: asyncio.Queue[bytes | None] = asyncio.Queue()  # None ends the body
        self._unparsed = ""  # the SSE text that does not make an event yet
        self._parsed: list[tuple[str, dict]] = []  # events read from the body and not handed out
        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": spec_version},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "root_path": "",
            "headers": [(b"host", b"127.0.0.1:1920"), (b"content-type", b"application/json")],
            "client": ("127.0.0.1", 50000),
            "server": ("127.0.0.1", 1920),
            "state": {},
        }
        self.task = asyncio.get_running_loop().create_task(app(scope, self._receive, self._send))

    async def _receive(self):
        if not self._request_sent:
            self._request_sent = True
            return {"type": "http.request", "body": self._body, "more_body": False}
        await self._over.wait()
        return {"type": "http.disconnect"}

    async def _send(self, message):
        if self._stall and message["type"] == "http.response.body" and message.get("body"):
            self.stalled.set()
            await self._unstalled.wait()
        if self._gone and self._raises_when_gone:
            raise OSError("the client has left")
        if message["type"] == "http.response.start":
            self.status = message["status"]
            self.headers = {k.decode().lower(): v.decode() for k, v in message["headers"]}
        elif message["type"] == "http.response.body":
            if message.get("body"):
                self._chunks.put_nowait(message["body"])
            if not message.get("more_body", False):
                self._chunks.put_nowait(None)
                self._over.set()

    def leave(self) -> None:
        self._gone = True
        self._unstalled.set()  # a send that waits is let go first, and sees that the client is gone
        self._over.set()

    async def chunk(self, timeout: float = 10.0) -> bytes | None:
        """The next piece of the body; None when the body is complete."""
        async with asyncio.timeout(timeout):
            return await self._chunks.get()

    async def quiet(self, seconds: float = 0.4) -> bytes:
        """What comes of the body until nothing has come for `seconds`."""
        received = b""
        while True:
            try:
                piece = await self.chunk(seconds)
            except TimeoutError:
                return received
            if piece is None:
                return received
            received += piece

    async def body(self, timeout: float = 30.0) -> bytes:
        received = b""
        async with asyncio.timeout(timeout):
            while (piece := await self._chunks.get()) is not None:
                received += piece
        return received

    async def finished(self, timeout: float = 10.0) -> None:
        """The app has returned (and raised nothing)."""
        await asyncio.wait_for(asyncio.shield(self.task), timeout)

    async def events(self, count: int, timeout: float = 10.0) -> list[tuple[str, dict]]:
        """The next `count` events of an SSE body: no more, a surplus waits for the next call."""
        while len(self._parsed) < count:
            piece = await self.chunk(timeout)
            assert piece is not None, f"the stream ended at {len(self._parsed)} of {count} events"
            self._unparsed += piece.decode()
            *blocks, self._unparsed = self._unparsed.split("\n\n")
            self._parsed += parse_sse("".join(block + "\n\n" for block in blocks))
        handed, self._parsed = self._parsed[:count], self._parsed[count:]
        return handed

    async def remaining_events(self, timeout: float = 30.0) -> list[tuple[str, dict]]:
        """Every event up to the end of an SSE body."""
        rest = await self.body(timeout)
        events = self._parsed + parse_sse(self._unparsed + rest.decode())
        self._parsed, self._unparsed = [], ""
        return events


class Harness:
    """An app whose lifespan is running, and the exchanges that were opened with it."""

    def __init__(self, app, requests, stack: contextlib.AsyncExitStack):
        self.app = app
        self.requests = requests
        self._stack = stack
        self._exchanges: list[Exchange] = []

    def open(self, method, path, body=b"", *, spec_version="2.3", stall=False) -> Exchange:
        exchange = Exchange(self.app, method, path, body, spec_version=spec_version, stall=stall)
        self._exchanges.append(exchange)
        return exchange

    async def call(self, method, path, *, json_body=None, spec_version="2.3") -> Reply:
        body = b"" if json_body is None else json.dumps(json_body).encode()
        exchange = self.open(method, path, body, spec_version=spec_version)
        received = await exchange.body()
        await exchange.finished()
        assert exchange.status is not None
        return Reply(exchange.status, exchange.headers, received)

    async def position(self, session_id: str, sentence_id: str) -> Reply:
        return await self.call(
            "POST", f"/v1/sessions/{session_id}/position", json_body={"sentence_id": sentence_id}
        )

    async def create(self, body: dict) -> str:
        reply = await self.call("POST", "/v1/sessions", json_body=body)
        assert reply.status == 201, reply.body
        return reply.json()["session_id"]

    async def known(self, session_id: str) -> bool:
        """See `known` above: a position that names no sentence moves nobody."""
        reply = await self.call(
            "POST", f"/v1/sessions/{session_id}/position", json_body={"sentence_id": "no-such-id"}
        )
        assert reply.status in (404, 422)
        return reply.status == 422

    async def until_forgotten(self, session_id: str, timeout: float = 5.0) -> None:
        async with asyncio.timeout(timeout):
            while await self.known(session_id):
                await asyncio.sleep(0.02)

    async def shut_down(self) -> None:
        """Leave the lifespan, which cancels the sessions; the exchanges are left as they are."""
        await self._stack.aclose()

    async def close(self) -> None:
        """Every client leaves, the lifespan ends; an exchange the app failed is raised."""
        for exchange in self._exchanges:
            exchange.leave()
        tasks = [exchange.task for exchange in self._exchanges]
        if tasks:
            await asyncio.wait(tasks, timeout=5)
        await self._stack.aclose()
        done = [task for task in tasks if task.done() and not task.cancelled()]
        failures = [task.exception() for task in done if task.exception()]
        if failures:
            raise failures[0]


@pytest.fixture
async def harness():
    """`harness(**options)` builds an app, starts its lifespan and returns a Harness."""
    made: list[Harness] = []

    async def start(**options) -> Harness:
        app, requests = build_app(**options)
        stack = contextlib.AsyncExitStack()
        await stack.enter_async_context(app.router.lifespan_context(app))
        made.append(Harness(app, requests, stack))
        return made[-1]

    yield start
    for each in made:
        await each.close()


SPEC_VERSIONS = pytest.mark.parametrize("spec_version", ["2.3", "2.5"])


async def test_an_error_ends_both_streams_and_the_audio_before_it_is_delivered_whole(harness):
    web = await harness(zonos=fake_zonos(fail_on=2))
    session_id = await web.create(reading(4))
    events = web.open("GET", f"/v1/sessions/{session_id}/events")
    audio = web.open("GET", f"/v1/sessions/{session_id}/audio")  # both are read, as a player does
    timeline = await events.remaining_events()
    assert timeline[-1] == ("error", {"id": "s1", "code": "synthesis_failed"})
    mp3 = await audio.body()
    assert decoded_seconds(mp3) == pytest.approx(of(timeline, "sentence")[-1]["end"], abs=0.15)
    await events.finished()
    await audio.finished()
    await web.until_forgotten(session_id, timeout=2)  # events read to their end: not idle_seconds


@SPEC_VERSIONS
async def test_an_exchange_is_a_reading_over_asgi(harness, spec_version):
    web = await harness()
    session_id = await web.create(reading(3))
    events = web.open("GET", f"/v1/sessions/{session_id}/events", spec_version=spec_version)
    audio = web.open("GET", f"/v1/sessions/{session_id}/audio", spec_version=spec_version)
    timeline = await events.remaining_events()
    mp3 = await audio.body()
    await events.finished()
    await audio.finished()
    assert (events.status, audio.status) == (200, 200)
    assert timeline[-1] == ("done", {})
    assert decoded_seconds(mp3) == pytest.approx(of(timeline, "sentence")[-1]["end"], abs=0.15)
    # Both readers drained and the events were read to their end: forgotten at once, not after the
    # 30 s that a session nobody read from would be kept.
    await web.until_forgotten(session_id, timeout=2)


# A client that leaves.


@SPEC_VERSIONS
async def test_a_client_that_leaves_the_audio_while_it_waits_detaches_its_reader(
    harness, sessions_made, spec_version
):
    web = await harness(idle_seconds=0.5)
    session_id = await web.create(reading(6))  # three sentences, then the worker waits
    audio = web.open("GET", f"/v1/sessions/{session_id}/audio", spec_version=spec_version)
    assert (await audio.quiet(0.5)).startswith(b"ID3")  # all there is so far; now it waits for more

    # While the reader is there the idle clock does not run...
    await asyncio.sleep(1.2)  # more than two idle periods
    assert await web.known(session_id)
    assert not sessions_made[0].ended
    assert not audio.task.done()

    # ...and when it leaves, the response ends and the clock starts: the session ends by itself.
    left = time.monotonic()
    audio.leave()
    await audio.finished(timeout=3)
    await until(lambda: sessions_made[0].ended, timeout=5)
    assert time.monotonic() - left >= 0.4  # a full idle period after the reader left
    await web.until_forgotten(session_id, timeout=5)  # and forgotten idle_seconds later


@SPEC_VERSIONS
async def test_a_client_that_leaves_the_events_while_they_wait_detaches_its_reader(
    harness, sessions_made, spec_version
):
    web = await harness()  # the idle time is 30 s: only the readers can end the session before it
    session_id = await web.create(reading(6))
    events = web.open("GET", f"/v1/sessions/{session_id}/events", spec_version=spec_version)
    audio = web.open("GET", f"/v1/sessions/{session_id}/audio")
    first = await events.events(6)  # three sentences and their words, in an order of their own
    assert sorted(name for name, _ in first) == ["sentence"] * 3 + ["words"] * 3
    assert await audio.quiet(0.4)  # three sentences are written; the worker waits for the reader

    events.leave()
    await events.finished(timeout=3)

    # The reading goes on to its end for the audio reader, and the session ends the moment that
    # reader has drained it: the events reader is no longer waited for.
    reply = await web.position(session_id, "s3")
    assert reply.status == 204
    await audio.body()
    await audio.finished()
    await until(lambda: sessions_made[0].ended, timeout=3)  # not after the idle time of 30 s


async def test_a_client_that_leaves_before_it_reads_anything_is_handled(harness, sessions_made):
    web = await harness(idle_seconds=0.3)
    session_id = await web.create(reading(6))
    for route in ("audio", "events"):
        exchange = web.open("GET", f"/v1/sessions/{session_id}/{route}")
        exchange.leave()
        await exchange.finished(timeout=3)
    await until(lambda: sessions_made[0].ended, timeout=5)  # the session never had a reader: idle


async def test_the_app_does_not_fail_when_a_client_leaves_under_a_busy_stream(
    harness, sessions_made
):
    web = await harness(idle_seconds=0.3)
    session_id = await web.create(reading(3))
    audio = web.open("GET", f"/v1/sessions/{session_id}/audio", spec_version="2.5")
    assert await audio.chunk()  # the stream is running and has data to send
    audio.leave()  # what is sent after this is refused with OSError
    await audio.finished(timeout=3)  # and the app takes it as the client leaving
    await until(lambda: sessions_made[0].ended, timeout=5)


@SPEC_VERSIONS
async def test_a_client_that_leaves_a_stream_that_cannot_send_ends_it_quietly(
    harness, sessions_made, spec_version
):
    web = await harness(idle_seconds=0.3)
    session_id = await web.create(reading(3))
    audio = web.open(
        "GET", f"/v1/sessions/{session_id}/audio", spec_version=spec_version, stall=True
    )
    await asyncio.wait_for(audio.stalled.wait(), 5)  # the client reads nothing: `send` waits
    audio.leave()  # from ASGI 2.4 on, the `send` that waits now raises OSError
    await audio.finished(timeout=3)  # which is the client leaving, not a failure of the app
    await until(lambda: sessions_made[0].ended, timeout=5)


async def run_stream(body, send):
    """Run a `_Stream` of `body` the way a server does, for a client that never says anything.
    Returns what the stream's `__call__` raised, if it did."""

    async def receive():
        await asyncio.Event().wait()  # no message from the client: it neither sends nor leaves

    stream = app_module._Stream(body, media_type="audio/mpeg")
    try:
        async with asyncio.timeout(5):
            await stream({"type": "http", "asgi": {"spec_version": "2.5"}}, receive, send)
    except Exception as error:
        return error
    return None


async def test_an_oserror_from_send_is_the_client_leaving_and_ends_the_stream_quietly():
    closed: list[bool] = []

    async def body():
        try:
            yield b"a piece"
            yield b"another piece"
        finally:
            closed.append(True)

    async def send(message):
        if message["type"] == "http.response.body":
            raise OSError("the client has left")  # what a server of ASGI 2.4 or later does

    assert await run_stream(body(), send) is None
    assert closed == [True]  # and the generator was closed, not left to the garbage collector


async def test_an_oserror_of_the_body_itself_is_a_failure_and_not_the_client_leaving():
    sent: list[dict] = []

    async def body():
        yield b"a piece"
        raise OSError("the generator itself failed")  # nothing to do with the client

    async def send(message):
        sent.append(message)

    failure = await run_stream(body(), send)
    assert isinstance(failure, OSError) and "the generator itself" in str(failure)
    assert sent[0]["type"] == "http.response.start"  # the response had begun


@pytest.fixture
def watched_streams(monkeypatch):
    """The streams a session hands out, wrapped so that each says when it is closed: the list of
    their names, in the order they were closed. The test keeps the wrappers, so nothing but an
    explicit close can close them: the garbage collector cannot."""
    closed: list[str] = []
    kept: list = []

    def watch(name, make):
        def wrapped(self):
            inner = make(self)  # raises ReaderTaken at the call, as the session's does

            async def stream():
                try:
                    async for item in inner:
                        yield item
                finally:
                    closed.append(name)
                    await inner.aclose()

            kept.append(stream())
            return kept[-1]

        return wrapped

    monkeypatch.setattr(ReadingSession, "audio", watch("audio", ReadingSession.audio))
    monkeypatch.setattr(ReadingSession, "events", watch("events", ReadingSession.events))
    return closed


@pytest.mark.parametrize("route", ["audio", "events"])
@SPEC_VERSIONS
async def test_a_stream_that_is_cut_is_closed_before_the_response_returns(
    harness, watched_streams, route, spec_version
):
    # The server stops the response (uvicorn does, when it ends the app) while the generator is
    # suspended after a piece that `send` has not taken: only the response can close it.
    web = await harness()
    session_id = await web.create(reading(6))
    exchange = web.open(
        "GET", f"/v1/sessions/{session_id}/{route}", spec_version=spec_version, stall=True
    )
    await asyncio.wait_for(exchange.stalled.wait(), 5)
    exchange.task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await exchange.task
    assert watched_streams == [route]


@pytest.mark.parametrize("route", ["audio", "events"])
async def test_a_stream_that_ends_by_itself_is_closed_too(harness, watched_streams, route):
    web = await harness()
    session_id = await web.create(reading(2))
    other = "events" if route == "audio" else "audio"
    exchange = web.open("GET", f"/v1/sessions/{session_id}/{route}")
    web.open("GET", f"/v1/sessions/{session_id}/{other}")
    await exchange.body()
    await exchange.finished()
    assert route in watched_streams


async def test_a_second_reader_of_an_ended_session_is_still_refused(harness, sessions_made):
    web = await harness(idle_seconds=1.0)
    session_id = await web.create(reading(6))  # three sentences, then the worker waits
    events = web.open("GET", f"/v1/sessions/{session_id}/events", spec_version="2.5")
    await events.events(1)
    events.leave()  # the one events reader leaves before the end
    await events.finished(timeout=3)
    await until(lambda: sessions_made[0].ended, timeout=5)  # nobody reads the audio: idle

    refused = await web.call("GET", f"/v1/sessions/{session_id}/events")
    assert (refused.status, refused.json()) == (409, {"error": "reader_taken"})  # not 404
    late = await web.call("GET", f"/v1/sessions/{session_id}/audio")
    assert (late.status, late.body) == (200, b"")  # the audio reader is free: an ended stream
    await web.until_forgotten(session_id, timeout=3)  # idle_seconds after it ended


# Readers, once each.


async def test_a_second_audio_reader_is_refused_while_the_first_is_reading(harness):
    web = await harness()
    session_id = await web.create(reading(6))
    first = web.open("GET", f"/v1/sessions/{session_id}/audio")
    assert await first.chunk()
    refused = await web.call("GET", f"/v1/sessions/{session_id}/audio")
    assert (refused.status, refused.json()) == (409, {"error": "reader_taken"})
    assert not first.task.done()  # the one that is reading is left alone
    assert first.status == 200


async def test_a_second_events_reader_is_refused_while_the_first_is_reading(harness):
    web = await harness()
    session_id = await web.create(reading(6))
    first = web.open("GET", f"/v1/sessions/{session_id}/events")
    await first.events(1)
    refused = await web.call("GET", f"/v1/sessions/{session_id}/events")
    assert (refused.status, refused.json()) == (409, {"error": "reader_taken"})
    assert not first.task.done()


async def test_a_reader_that_left_cannot_be_replaced(harness):
    web = await harness()
    session_id = await web.create(reading(6))
    first = web.open("GET", f"/v1/sessions/{session_id}/audio")
    assert await first.chunk()
    first.leave()
    await first.finished()
    again = await web.call("GET", f"/v1/sessions/{session_id}/audio")
    assert again.status == 409  # one audio reader per session, for good


# The reader's position.


async def test_position_lets_the_worker_read_on(harness):
    web = await harness()  # prefetch 2: the worker may be three sentences in without a position
    session_id = await web.create(reading(6))
    events = web.open("GET", f"/v1/sessions/{session_id}/events")
    audio = web.open("GET", f"/v1/sessions/{session_id}/audio")  # an attached reader keeps it alive
    first = await events.events(6)
    assert sorted(name for name, _ in first) == ["sentence"] * 3 + ["words"] * 3
    with pytest.raises(TimeoutError):
        await events.chunk(0.5)  # held: nothing more until the reader moves
    assert len(web.requests) == 3

    reply = await web.position(session_id, "s3")
    assert reply.status == 204
    rest = await events.events(7)  # three more sentences, their words, and done
    assert [data["id"] for data in of(rest, "sentence")] == ["s3", "s4", "s5"]
    assert rest[-1] == ("done", {})
    assert len(web.requests) == 6
    await audio.body()


# DELETE under open streams.


async def test_delete_cancels_the_session_under_its_open_streams(harness):
    web = await harness()
    session_id = await web.create(reading(6))
    events = web.open("GET", f"/v1/sessions/{session_id}/events")
    audio = web.open("GET", f"/v1/sessions/{session_id}/audio")
    await events.events(6)
    assert await audio.quiet(0.4)

    reply = await web.call("DELETE", f"/v1/sessions/{session_id}")
    assert (reply.status, reply.body) == (204, b"")
    # Both responses are over, without `done`: the worker was cancelled, not finished.
    rest = await events.remaining_events()
    assert "done" not in [name for name, _ in rest]
    await audio.body()
    await events.finished()
    await audio.finished()
    assert ffmpeg_children() == []
    assert not await web.known(session_id)


# The app ends under open streams.


async def test_leaving_the_app_ends_the_streams_it_is_serving(harness):
    web = await harness()
    session_id = await web.create(reading(6))
    events = web.open("GET", f"/v1/sessions/{session_id}/events")
    audio = web.open("GET", f"/v1/sessions/{session_id}/audio")
    await events.events(6)
    assert await audio.quiet(0.4)
    assert len(ffmpeg_children()) == 1

    await web.shut_down()  # the lifespan ends: the sessions are cancelled
    await events.remaining_events()
    await audio.body()
    await events.finished()
    await audio.finished()
    assert ffmpeg_children() == []


# The entry point.


@pytest.fixture
def served(monkeypatch):
    """What `python -m speech_service` hands to uvicorn: `(app, options)`."""
    for name in [name for name in os.environ if name.startswith("SPEECH_")]:
        monkeypatch.delenv(name)
    calls: list[tuple] = []
    monkeypatch.setattr(uvicorn, "run", lambda app, **options: calls.append((app, options)))

    def run(**environment):
        for name, value in environment.items():
            monkeypatch.setenv(name, value)
        entry_point.main()
        assert len(calls) == 1
        return calls[0]

    return run


def test_the_entry_point_serves_where_the_settings_say(served):
    app, options = served(
        SPEECH_PORT="1999", SPEECH_ALIGNER="none", SPEECH_ZONOS_URL="http://127.0.0.1:9"
    )
    assert options["host"] == "127.0.0.1"
    assert options["port"] == 1999
    assert options["loop"] == "asyncio"  # the loop the tests exercise, not uvloop
    with TestClient(app) as client:  # nothing listens on port 9; and SPEECH_ALIGNER=none
        assert client.get("/health").json() == {"ok": False, "zonos": False, "aligner": False}


def test_the_entry_point_starts_without_an_aligner_that_cannot_be_set_up(served, tmp_path):
    # Word times are an extra: a CLI and a model that are not there must not take reading down.
    app, options = served(
        SPEECH_ALIGNER="native",
        SPEECH_ALIGNER_CLI=str(tmp_path / "no-such-cli"),
        SPEECH_ALIGNER_MODEL=str(tmp_path / "no-such-model"),
        SPEECH_ZONOS_URL="http://127.0.0.1:9",
    )
    assert options["port"] == 1920  # it went on to serve
    with TestClient(app) as client:
        assert client.get("/health").json() == {"ok": False, "zonos": False, "aligner": False}


def test_the_entry_point_serves_on_the_default_loopback_port(served):
    _, options = served(SPEECH_ALIGNER="none")
    assert (options["host"], options["port"]) == ("127.0.0.1", 1920)


def test_the_entry_point_waits_only_a_short_while_for_open_streams(served):
    _, options = served(SPEECH_ALIGNER="none")
    # uvicorn waits for every open response before it ends the app; a reading can last minutes.
    assert 1 <= options["timeout_graceful_shutdown"] <= 15


def test_the_entry_point_refuses_a_host_beyond_loopback(served):
    with pytest.raises(SystemExit) as stopped:
        served(SPEECH_HOST="0.0.0.0", SPEECH_ALIGNER="none")
    assert "SPEECH_HOST" in str(stopped.value)


def test_the_entry_point_names_a_setting_it_cannot_read(served):
    with pytest.raises(SystemExit) as stopped:
        served(SPEECH_PORT="Quokka", SPEECH_ALIGNER="none")
    assert "SPEECH_PORT" in str(stopped.value)
