"""Reading sessions: the worker, its timeline, prefetch, cancel, the idle end and the failures.

Every test runs a ReadingSession on `fake_zonos` (a Zonos that answers with a tone as long as the
sentence's text) and a `FakeAligner`, with a real ffmpeg for the MP3. A session is read the way the
HTTP routes will read it: the events by one reader and the audio by another.
"""

import asyncio
import gc
import io
import json
import logging
import os
import signal
import subprocess
import threading
import tracemalloc
from collections.abc import AsyncIterator, Callable
from concurrent.futures import ThreadPoolExecutor
from itertools import pairwise

import httpx
import numpy as np
import pytest
import soundfile as sf

from speech_service import session as session_module
from speech_service.audio import Mp3Encoder
from speech_service.config import Settings
from speech_service.models import Sentence, Voice
from speech_service.session import ReaderTaken, ReadingSession
from speech_service.text import normalize
from speech_service.zonos import ZonosClient
from tests.fakes_zonos import fake_zonos, refusing_transport
from tests.helpers import SR, VOICE, decode_mp3, decoded_seconds, rms_db, tone

# Like tests/test_aligner.py: the bare module name, which both Pythons that run these tests find.
from fakes_aligner import FakeAligner

SECRET = ["Zebrafish", "Quokka."]  # tokens whose text must never reach a log


@pytest.fixture(scope="module", autouse=True)
def encoder_delay_is_measured() -> None:
    """The encoder measures its delay once per process; keep that out of every timing below."""
    asyncio.run(Mp3Encoder.warm_up())


@pytest.fixture
async def new_session():
    """`new_session(sentences, ...)` builds a session on a fake Zonos; the test's sessions are all
    cancelled when it ends, so none outlives it."""
    made: list[ReadingSession] = []
    clients: list[httpx.AsyncClient] = []

    def build(
        sentences: list[Sentence],
        *,
        zonos: tuple[httpx.AsyncClient, list] | None = None,
        fail_on: int | None = None,
        aligner=None,
        session_id: str = "test-session",
        **settings,
    ) -> tuple[ReadingSession, list]:
        http, requests = zonos if zonos is not None else fake_zonos(fail_on=fail_on)
        clients.append(http)
        client = ZonosClient("http://zonos.test", http)
        session = ReadingSession(
            session_id, sentences, client, aligner or FakeAligner(), Settings(**settings)
        )
        made.append(session)
        return session, requests

    yield build
    for session in made:
        await cancel(session)
    for client in clients:
        await client.aclose()


def make_sentences(
    count: int,
    *,
    tokens: tuple[str, ...] = ("Hello", "there."),
    language: str = "en",
    voice: Voice = VOICE,
    paragraph_starts: frozenset[int] | set[int] = frozenset(),
) -> list[Sentence]:
    return [
        Sentence(f"s{i}", language, voice, list(tokens), i in paragraph_starts)  # type: ignore
        for i in range(count)
    ]


async def drain[T](stream: AsyncIterator[T], timeout: float | None = 30) -> list[T]:
    """Everything `stream` yields until it ends. A stream that never ends fails the test."""
    async with asyncio.timeout(timeout):
        return [item async for item in stream]


async def cancel(session: ReadingSession) -> None:
    """`session.cancel()`, which must not hang."""
    async with asyncio.timeout(10):
        await session.cancel()


async def play(
    session: ReadingSession, timeout: float = 30
) -> tuple[list[tuple[str, dict]], bytes]:
    """Start `session` and read both of its streams to their ends: its events and its MP3."""
    session.start()
    async with asyncio.timeout(timeout):  # for both streams: it cancels the one still reading
        events, chunks = await asyncio.gather(
            drain(session.events(), None), drain(session.audio(), None)
        )
    return events, b"".join(chunks)


def of(events: list[tuple[str, dict]], name: str) -> list[dict]:
    """The data of the events called `name`, in the order they came."""
    return [data for event, data in events if event == name]


async def until(condition: Callable[[], bool], timeout: float = 10.0) -> None:
    """Wait for `condition`: for the few facts a session shows only through its state."""
    async with asyncio.timeout(timeout):
        while not condition():
            await asyncio.sleep(0.005)


def wav_response(samples: np.ndarray, rate: int = SR) -> httpx.Response:
    buffer = io.BytesIO()
    sf.write(buffer, samples, rate, format="WAV", subtype="PCM_16")
    return httpx.Response(200, content=buffer.getvalue(), headers={"content-type": "audio/wav"})


def zonos_answering(answer: Callable[[], httpx.Response]) -> tuple[httpx.AsyncClient, list]:
    """A Zonos whose every answer is `answer()`, and the list of the requests it received."""
    requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        return answer()

    return httpx.AsyncClient(transport=httpx.MockTransport(handler)), requests


def ffmpeg_children() -> list[int]:
    """The ffmpeg processes this process has started and not yet seen end."""
    try:
        found = subprocess.run(
            ["pgrep", "-P", str(os.getpid()), "-x", "ffmpeg"], capture_output=True, text=True
        )
    except FileNotFoundError:  # no pgrep here: nothing to see
        return []
    return [int(pid) for pid in found.stdout.split()]


def ffmpeg_status(session: ReadingSession) -> int | None:
    """How the session's ffmpeg ended: 0 when the encoder was closed, minus the signal when it was
    killed. (The one place a test needs the process itself, as in test_audio.py.)"""
    return session._encoder._proc.returncode


def assert_nothing_left_running() -> None:
    """After a session has ended no task of it is alive on this loop and no ffmpeg is."""
    others = [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
    assert not others, f"tasks still running: {others}"
    assert not ffmpeg_children()


# What a session says and writes.


async def test_events_follow_the_stream(new_session):
    delay = await Mp3Encoder.warm_up()
    sentences = make_sentences(3)
    session, _ = new_session(sentences)
    events, _ = await play(session)

    announced = of(events, "sentence")
    starts = [data["start"] for data in announced]
    assert [data["id"] for data in announced] == ["s0", "s1", "s2"]
    # The stream starts with the first sentence, as late as the encoder's priming delay.
    assert starts[0] == pytest.approx(delay, abs=0.002)
    assert all(b > a for a, b in pairwise(starts))
    timed = of(events, "words")
    assert [data["id"] for data in timed] == ["s0", "s1", "s2"]
    assert all(len(data["times"]) == len(s.tokens) for data, s in zip(timed, sentences))
    assert events[-1] == ("done", {})
    where = {(name, data["id"]): i for i, (name, data) in enumerate(events) if "id" in data}
    assert all(where[("sentence", i)] < where[("words", i)] for i in ("s0", "s1", "s2"))
    for _, data in events:
        json.dumps(data, allow_nan=False)  # what the SSE route will do with each event


async def test_there_is_no_gap_before_the_first_sentence(new_session):
    delay = await Mp3Encoder.warm_up()
    session, _ = new_session(make_sentences(2, paragraph_starts={0, 1}))
    events, _ = await play(session)
    assert of(events, "sentence")[0]["start"] == pytest.approx(delay, abs=0.002)


@pytest.mark.parametrize(("paragraph_start", "gap"), [(True, 0.60), (False, 0.30)])
async def test_paragraph_gap_is_longer(new_session, paragraph_start, gap):
    session, _ = new_session(make_sentences(2, paragraph_starts={1} if paragraph_start else set()))
    events, _ = await play(session)
    first, second = of(events, "sentence")
    assert second["start"] - first["end"] == pytest.approx(gap, abs=0.05)


async def test_the_timeline_matches_the_decoded_audio(new_session):
    session, _ = new_session(make_sentences(3, paragraph_starts={2}))
    events, mp3 = await play(session)
    pcm = decode_mp3(mp3)

    def level(start: float, end: float) -> float:
        return rms_db(pcm[round(start * SR) : round(end * SR)])

    announced = of(events, "sentence")
    for data in announced:  # each sentence sounds where the timeline says: matched to -20 dBFS
        assert level(data["start"] + 0.1, data["end"] - 0.1) == pytest.approx(-20.0, abs=1.5)
    for before, after in pairwise(announced):  # and the gaps between them are silent
        assert level(before["end"] + 0.05, after["start"] - 0.05) < -60.0
    assert decoded_seconds(mp3) == pytest.approx(announced[-1]["end"], abs=0.15)


async def test_zonos_hears_the_normalized_words_in_the_voice_and_seed(new_session):
    tokens = ["2", "tojás,", "12", "990", "Ft."]
    voice = Voice("hu_voice", {"room.clean": 2.0})
    session, requests = new_session(
        make_sentences(1, tokens=tuple(tokens), language="hu", voice=voice), seed=77
    )
    await play(session)
    heard = " ".join(normalize(tokens, "hu").words)
    assert heard != " ".join(tokens)  # the test needs a sentence the normalizer changes
    assert len(requests) == 1
    assert requests[0] == {
        "text": heard,
        "language": "hu",
        "format": "wav",
        "stream": False,
        "speaker_embedding_id": "hu_voice",
        "speaker_mode": "embedding",
        "seed": 77,
        "text_normalization": False,
        "controls": {"room.clean": 2.0},
    }


async def test_language_switch_mid_session(new_session):
    hungarian = Voice("hu_voice", {"room.clean": 2.0})
    english = Voice("en_voice", {})
    sentences = [
        Sentence("s0", "hu", hungarian, ["Szia,", "világ."], False),
        Sentence("s1", "en", english, ["Hello", "there."], False),
        Sentence("s2", "hu", hungarian, ["Viszlát,", "világ."], False),
    ]
    session, requests = new_session(sentences)
    events, _ = await play(session)

    assert [r["language"] for r in requests] == ["hu", "en_us", "hu"]
    assert [r["speaker_embedding_id"] for r in requests] == ["hu_voice", "en_voice", "hu_voice"]
    assert [r["seed"] for r in requests] == [1234, 1234, 1234]
    assert [r.get("controls") for r in requests] == [{"room.clean": 2.0}, None, {"room.clean": 2.0}]
    # The stream goes on across the switch with the ordinary gap, and no longer one.
    for before, after in pairwise(of(events, "sentence")):
        assert after["start"] - before["end"] == pytest.approx(0.30, abs=0.05)
    assert events[-1] == ("done", {})


# A sentence that speaks as nothing.


async def test_a_sentence_that_speaks_as_nothing_makes_no_zonos_call(new_session):
    sentences = make_sentences(3)
    sentences[1] = Sentence("s1", "en", VOICE, ["🙂", "…"], True)
    session, requests = new_session(sentences)
    events, _ = await play(session)

    assert len(requests) == 2  # the first and the last sentence only
    first, silent, last = of(events, "sentence")
    assert silent["id"] == "s1"
    assert silent["start"] == silent["end"] == pytest.approx(first["end"], abs=0.0011)
    assert of(events, "words")[1] == {"id": "s1", "times": [None, None]}
    # The silent sentence adds no gap of its own, and the gap before the next one is one gap: the
    # paragraph it opens is not lost, so that gap is the paragraph's.
    assert last["start"] - first["end"] == pytest.approx(0.60, abs=0.05)
    assert events[-1] == ("done", {})
    assert [name for name, _ in events].count("sentence") == 3


def sentences_of(kinds: str) -> list[Sentence]:
    """One sentence per letter: "a" is read, "s" says nothing, and a capital opens a paragraph."""
    read_out, says_nothing = ["Hello", "there."], ["🙂"]
    return [
        Sentence(f"s{i}", "en", VOICE, says_nothing if kind in "sS" else read_out, kind in "AS")
        for i, kind in enumerate(kinds)
    ]


@pytest.mark.parametrize(
    ("kinds", "gaps"),
    [
        ("aSa", [0.60]),  # a paragraph opens with a sentence that says nothing: the gap is its own
        ("asa", [0.30]),  # one that opens none leaves the ordinary gap
        ("aSsa", [0.60]),  # the paragraph is kept across more silent sentences
        ("asSsa", [0.60]),
        ("aSA", [0.60]),  # and is the one gap when the sentence read opens a paragraph too
        ("aSaa", [0.60, 0.30]),  # it is used once
        ("Saa", [0.30]),  # nothing is written before the first sentence read, so no gap, and
        ("SSaAa", [0.60, 0.30]),  # the paragraph waiting does not carry into the sentences after it
    ],
)
async def test_a_paragraph_that_opens_with_nothing_to_say_keeps_its_gap(new_session, kinds, gaps):
    session, _ = new_session(sentences_of(kinds), prefetch=len(kinds))  # no reader to wait for
    events, _ = await play(session)
    announced = of(events, "sentence")
    read = [announced[i] for i, kind in enumerate(kinds) if kind in "aA"]
    assert [b["start"] - a["end"] for a, b in pairwise(read)] == pytest.approx(gaps, abs=0.05)
    assert events[-1] == ("done", {})


async def test_a_session_of_nothing_but_unspeakable_sentences_still_ends_with_done(new_session):
    sentences = [Sentence(f"s{i}", "en", VOICE, ["🙂"], False) for i in range(3)]
    session, requests = new_session(sentences)
    events, mp3 = await play(session)
    assert requests == []
    assert [data["id"] for data in of(events, "sentence")] == ["s0", "s1", "s2"]
    assert all(data["times"] == [None] for data in of(events, "words"))
    assert events[-1] == ("done", {})
    assert mp3.startswith(b"ID3") and len(mp3) < 100  # the stream is the encoder's tag and no audio
    assert session.ended


# Word times.


async def test_word_times_are_on_the_streams_clock_in_milliseconds(new_session):
    tokens = ("Pay", "$12.50", "now.")  # one token becomes several words
    session, _ = new_session(make_sentences(2, tokens=tokens))
    events, _ = await play(session)

    for sentence, words in zip(of(events, "sentence"), of(events, "words")):
        times = words["times"]
        assert len(times) == len(tokens)
        assert all(t is not None and t == [round(t[0], 3), round(t[1], 3)] for t in times)
        assert times[0][0] == pytest.approx(sentence["start"], abs=0.0011)
        assert times[-1][1] == pytest.approx(sentence["end"], abs=0.002)
        assert all(a[1] <= b[0] + 0.0011 for a, b in pairwise(times))  # in the order they are said


async def test_a_token_that_speaks_as_nothing_gets_a_null_time(new_session):
    tokens = ("Hello", "🙂", "there.")
    session, _ = new_session(make_sentences(1, tokens=tokens))
    events, _ = await play(session)
    times = of(events, "words")[0]["times"]
    assert times[1] is None
    assert times[0] is not None and times[2] is not None
    assert events[-1] == ("done", {})


class _FailsWith(FakeAligner):
    """An aligner whose every call fails the way `error` says (a contract breach, for most)."""

    def __init__(self, error: Exception) -> None:
        super().__init__()
        self.error = error

    def align(self, audio_16k, words):
        raise self.error


class _WrongCount(FakeAligner):
    def align(self, audio_16k, words):
        return [(0.0, 0.1)] * (len(words) + 1)


class _NanFirst(FakeAligner):
    def align(self, audio_16k, words):
        times = super().align(audio_16k, words)
        times[0] = (float("nan"), float("nan"))
        return times


async def test_aligner_failure_gives_null_words(new_session):
    session, _ = new_session(make_sentences(3), aligner=FakeAligner(fail=True))
    events, mp3 = await play(session)
    assert [data["times"] for data in of(events, "words")] == [[None, None]] * 3
    assert events[-1] == ("done", {})
    assert [name for name, _ in events].count("error") == 0
    assert mp3  # the reading itself went on


@pytest.mark.parametrize(
    "aligner",
    [_FailsWith(ValueError("not a RuntimeError")), _WrongCount()],
    ids=["another-exception", "wrong-count"],
)
async def test_any_aligner_failure_is_null_words_and_no_error(new_session, aligner):
    session, _ = new_session(make_sentences(2), aligner=aligner)
    events, _ = await play(session)
    assert [data["times"] for data in of(events, "words")] == [[None, None]] * 2
    assert events[-1] == ("done", {})


async def test_a_time_that_is_not_a_number_is_null_not_nan(new_session):
    session, _ = new_session(make_sentences(1), aligner=_NanFirst())
    events, _ = await play(session)
    times = of(events, "words")[0]["times"]
    assert times[0] is None and times[1] is not None
    json.dumps(events, allow_nan=False)


class _OnOneThread(FakeAligner):
    """Notes which threads align, and whether two aligns were ever inside `align` together."""

    def __init__(self) -> None:
        super().__init__()
        self.threads: set[int] = set()
        self.overlapped = False
        self._inside = 0
        self._lock = threading.Lock()
        self._second_arrived = threading.Event()
        self._first = True

    def align(self, audio_16k, words):
        with self._lock:
            self.threads.add(threading.get_ident())
            self._inside += 1
            first, self._first = self._first, False
            if self._inside > 1:
                self.overlapped = True
                self._second_arrived.set()
        try:
            if first:  # hold the first call open: a second thread, if there were one, would join it
                self._second_arrived.wait(timeout=0.3)
            return super().align(audio_16k, words)
        finally:
            with self._lock:
                self._inside -= 1


async def test_all_alignment_runs_on_one_thread_shared_by_every_session(new_session):
    aligner = _OnOneThread()
    zonos = fake_zonos(concurrency=2)
    first, _ = new_session(
        make_sentences(5), zonos=zonos, aligner=aligner, session_id="a", prefetch=5
    )
    second, _ = new_session(
        make_sentences(5), zonos=zonos, aligner=aligner, session_id="b", prefetch=5
    )
    await asyncio.gather(play(first), play(second))
    assert len(aligner.threads) == 1
    assert threading.get_ident() not in aligner.threads  # not the loop's thread
    assert not aligner.overlapped


async def test_synthesis_goes_on_while_a_sentence_is_aligned(new_session):
    second_request_arrived = threading.Event()
    verdicts: list[bool] = []

    class HoldsTheFirstAlignment(FakeAligner):
        def align(self, audio_16k, words):
            if not verdicts:  # the first call waits for Zonos to be asked for the second sentence
                verdicts.append(second_request_arrived.wait(timeout=5))
            return super().align(audio_16k, words)

    session, requests = new_session(make_sentences(3), aligner=HoldsTheFirstAlignment())

    async def watch() -> None:
        await until(lambda: len(requests) >= 2)
        second_request_arrived.set()

    watching = asyncio.create_task(watch())
    await play(session)
    await watching
    assert verdicts == [True]


async def test_words_events_keep_sentence_order_when_the_first_alignment_is_the_slowest(
    new_session,
):
    calls = 0

    class SlowFirst(FakeAligner):
        def align(self, audio_16k, words):
            nonlocal calls
            calls += 1
            if calls == 1:
                threading.Event().wait(0.15)
            return super().align(audio_16k, words)

    session, _ = new_session(make_sentences(4), aligner=SlowFirst(), prefetch=4)
    events, _ = await play(session)
    assert [data["id"] for data in of(events, "words")] == ["s0", "s1", "s2", "s3"]
    assert events[-1] == ("done", {})


class _Slow(FakeAligner):
    """An aligner that takes `seconds` to align each sentence, so a sentence's words come late."""

    def __init__(self, seconds: float = 0.15) -> None:
        super().__init__()
        self.seconds = seconds

    def align(self, audio_16k, words):
        threading.Event().wait(self.seconds)
        return super().align(audio_16k, words)


async def test_done_comes_after_the_last_words_even_when_alignment_is_slow(new_session):
    session, _ = new_session(make_sentences(3), aligner=_Slow())
    events, _ = await play(session)
    assert [name for name, _ in events][-2:] == ["words", "done"]
    assert [data["id"] for data in of(events, "words")] == ["s0", "s1", "s2"]


async def test_the_words_before_an_error_come_first_even_when_alignment_is_slow(new_session):
    session, _ = new_session(make_sentences(3), aligner=_Slow(), fail_on=2)
    events, _ = await play(session)
    assert events[-1] == ("error", {"id": "s1", "code": "synthesis_failed"})
    name, words = events[-2]
    assert (name, words["id"]) == ("words", "s0")
    assert words["times"] != [None, None]  # the alignment finished: the error waited for it


async def test_alignment_is_one_sentence_deep(new_session):
    entered, release = threading.Event(), threading.Event()

    class BlocksOnTheFirst(FakeAligner):
        def align(self, audio_16k, words):
            if not entered.is_set():
                entered.set()
                assert release.wait(timeout=10)
            return super().align(audio_16k, words)

    session, requests = new_session(make_sentences(6), aligner=BlocksOnTheFirst(), prefetch=6)
    session.start()
    try:
        await until(entered.is_set)
        # One sentence is being aligned and the next one is synthesized and written; the worker
        # then waits, so the audio held for alignment is one sentence's however slow FuseAlign is
        # (for the few seconds before the words of the first are given up on).
        await until(lambda: len(requests) >= 2)  # that it gets there is what is waited for...
        await asyncio.sleep(0.3)
        assert len(requests) == 2  # ...and that it goes no further, what the sleep is for
    finally:
        release.set()
    assert (await drain(session.events()))[-1] == ("done", {})


async def test_cancel_does_not_wait_for_an_alignment_that_is_running(new_session):
    entered, release = threading.Event(), threading.Event()

    class BlocksOnTheFirst(FakeAligner):
        def align(self, audio_16k, words):
            entered.set()
            assert release.wait(timeout=10)
            return super().align(audio_16k, words)

    session, _ = new_session(make_sentences(2), aligner=BlocksOnTheFirst())
    session.start()
    try:
        await until(entered.is_set)
        async with asyncio.timeout(2):
            await cancel(session)  # a thread cannot be interrupted, and the session does not wait
        assert session.ended
        assert not release.is_set()
        assert_nothing_left_running()  # no task of it, and no ffmpeg
    finally:
        release.set()


class _RecordingExecutor(ThreadPoolExecutor):
    """The aligner's executor, counting the jobs sent to it."""

    def __init__(self) -> None:
        super().__init__(max_workers=1)
        self.submitted = 0

    def submit(self, fn, /, *args, **kwargs):
        self.submitted += 1
        return super().submit(fn, *args, **kwargs)


async def test_a_queued_alignment_never_runs_once_its_session_is_cancelled(
    new_session, monkeypatch
):
    executor = _RecordingExecutor()
    monkeypatch.setattr(session_module, "_ALIGNER_THREAD", executor)
    entered, release = threading.Event(), threading.Event()
    aligned: list[list[str]] = []

    class BlocksOnAlpha(FakeAligner):
        def align(self, audio_16k, words):
            aligned.append(list(words))
            if words == ["alpha"]:
                entered.set()
                assert release.wait(timeout=10)
            return super().align(audio_16k, words)

    aligner = BlocksOnAlpha()
    first, _ = new_session(
        [Sentence("a0", "en", VOICE, ["alpha"], False)], aligner=aligner, session_id="a"
    )
    # The second session reads its first sentence, then waits at the prefetch gate (prefetch 0) with
    # that sentence's alignment queued: its worker is not awaiting the job when it is cancelled.
    pair = [
        Sentence("b0", "en", VOICE, ["bravo"], False),
        Sentence("b1", "en", VOICE, ["charlie"], False),
    ]
    second, _ = new_session(pair, aligner=aligner, session_id="b", prefetch=0)
    try:
        first.start()
        await until(entered.is_set)  # the aligner's one thread is busy with the first session
        second.start()
        await until(lambda: executor.submitted == 2)  # the second session's job waits behind it
        await cancel(second)
        release.set()
        events = await drain(first.events())
        assert events[-1] == ("done", {})
        # Whatever was queued before this job has been handled by the time it runs.
        await asyncio.get_running_loop().run_in_executor(executor, lambda: None)
        assert aligned == [["alpha"]]
    finally:
        release.set()
        executor.shutdown(wait=True)


# An aligner that does not answer. Alignment only adds the word marks, so the audio and the
# timeline never wait for it for long: after a few seconds (shortened here) the sentence gets no
# word times and the reading goes on, and nothing more is queued behind the job that is stuck.


class _StuckOnTheFirst(FakeAligner):
    """An aligner whose first call blocks, in the aligner's thread, until `release` is set. Then it
    answers, or raises with `raises`."""

    def __init__(self, raises: bool = False) -> None:
        super().__init__()
        self.entered = threading.Event()
        self.release = threading.Event()
        self.calls = 0
        self.raises = raises

    def align(self, audio_16k, words):
        self.calls += 1
        if self.calls == 1:
            self.entered.set()
            assert self.release.wait(timeout=10)
            if self.raises:  # quoting the words, which no aligner may: the logs must not show it
                raise RuntimeError(f"cannot time {words}")
        return super().align(audio_16k, words)


@pytest.fixture
def impatient(monkeypatch):
    """Sessions that give up on an alignment after 0.3 s, on an aligner thread of their own."""
    monkeypatch.setattr(session_module, "_ALIGNMENT_PATIENCE_SECONDS", 0.3)
    executor = _RecordingExecutor()
    monkeypatch.setattr(session_module, "_ALIGNER_THREAD", executor)
    yield executor
    executor.shutdown(wait=True)


async def aligner_thread_is_free(executor: ThreadPoolExecutor) -> None:
    """Wait until everything sent to the aligner's thread so far has run, and what the loop was
    told of it has been dealt with."""
    await asyncio.get_running_loop().run_in_executor(executor, lambda: None)
    await asyncio.sleep(0)


async def test_a_stuck_aligner_holds_up_neither_the_audio_nor_the_timeline(new_session, impatient):
    aligner = _StuckOnTheFirst()
    session, requests = new_session(make_sentences(6), aligner=aligner, prefetch=6)
    try:
        events, mp3 = await play(session, timeout=5)  # with the aligner stuck all the while
        assert aligner.entered.is_set() and not aligner.release.is_set()
        queued = impatient.submitted
    finally:
        aligner.release.set()
    await aligner_thread_is_free(impatient)

    ids = [f"s{i}" for i in range(6)]
    announced = of(events, "sentence")
    assert [data["id"] for data in announced] == ids
    assert len(requests) == 6
    assert decoded_seconds(mp3) == pytest.approx(announced[-1]["end"], abs=0.15)
    assert events[-1] == ("done", {})
    # The sentence that was stuck and the ones behind it have no word times, each once, in order.
    assert of(events, "words") == [{"id": id, "times": [None, None]} for id in ids]
    # Nothing was queued behind the stuck job, and its answer came to nothing.
    assert queued == 1
    assert aligner.calls == 1
    assert_nothing_left_running()


async def test_a_job_given_up_on_that_fails_is_not_reported_by_asyncio(impatient, caplog):
    # When a future is collected with an exception nobody read, asyncio logs that exception, and
    # an aligner's error that quoted the words would put them in the log. Not a session left to the
    # fixture, which keeps it alive: here the session goes away as soon as it has ended.
    aligner = _StuckOnTheFirst(raises=True)
    http, _ = fake_zonos()
    session = ReadingSession(
        "test-session",
        make_sentences(3, tokens=tuple(SECRET)),
        ZonosClient("http://zonos.test", http),
        aligner,
        Settings(),
    )
    try:
        await play(session, timeout=5)
    finally:
        aligner.release.set()
    await aligner_thread_is_free(impatient)
    await http.aclose()
    del session
    gc.collect()

    assert aligner.calls == 1
    for record in caplog.records:
        assert "Zebrafish" not in record.getMessage() and "Quokka" not in record.getMessage()
        assert "Zebrafish" not in (record.exc_text or "") and not record.exc_info


async def test_alignment_goes_on_once_the_stuck_job_has_finished(new_session, impatient):
    aligner = _StuckOnTheFirst()
    session, _ = new_session(make_sentences(8), aligner=aligner)  # prefetch 2: three sentences
    collected: list[tuple[str, dict]] = []

    async def collect() -> None:
        async for event in session.events():
            collected.append(event)

    session.start()
    readers = [asyncio.create_task(collect()), asyncio.create_task(drain(session.audio(), None))]
    try:
        await until(lambda: len(of(collected, "words")) == 3, timeout=5)
        # The reading did not wait: three sentences are out, and the aligner is stuck on the first.
        assert len(of(collected, "sentence")) == 3
        assert aligner.calls == 1
    finally:
        aligner.release.set()
    await aligner_thread_is_free(impatient)
    session.report_position("s7")  # the reader moves on: the rest may be read
    async with asyncio.timeout(10):
        await asyncio.gather(*readers)

    words = of(collected, "words")
    assert [data["id"] for data in words] == [f"s{i}" for i in range(8)]
    assert [data["times"] for data in words[:3]] == [[None, None]] * 3
    assert all(None not in data["times"] for data in words[3:])
    assert aligner.calls == 1 + 5
    assert collected[-1] == ("done", {})


async def test_a_stuck_aligner_does_not_stall_another_session(new_session, impatient):
    aligner = _StuckOnTheFirst()  # one aligner, as the service has: the first session sticks it
    zonos = fake_zonos(concurrency=2)
    first, _ = new_session(make_sentences(2), zonos=zonos, aligner=aligner, session_id="a")
    second, _ = new_session(
        make_sentences(4), zonos=zonos, aligner=aligner, session_id="b", prefetch=4
    )
    first.start()
    try:
        await until(aligner.entered.is_set)
        # The second session's alignment waits behind the stuck one for its few seconds, and goes
        # on without it.
        events, mp3 = await play(second, timeout=5)
        assert not aligner.release.is_set()
    finally:
        aligner.release.set()
    await aligner_thread_is_free(impatient)

    assert events[-1] == ("done", {}) and mp3
    assert of(events, "words") == [{"id": f"s{i}", "times": [None, None]} for i in range(4)]
    # What it queued behind the stuck job was dropped, and never ran when the thread was free.
    assert aligner.calls == 1


async def test_normalization_does_not_queue_behind_another_sessions_alignment(new_session):
    entered, release = threading.Event(), threading.Event()

    class BlocksOnAlpha(FakeAligner):
        def align(self, audio_16k, words):
            if words == ["alpha"]:
                entered.set()
                assert release.wait(timeout=10)
            return super().align(audio_16k, words)

    aligner = BlocksOnAlpha()
    first, _ = new_session(
        [Sentence("a0", "en", VOICE, ["alpha"], False)], aligner=aligner, session_id="a"
    )
    second, requests = new_session(make_sentences(1, tokens=("bravo",)), session_id="b")
    first.start()
    try:
        await until(entered.is_set)  # the aligner's one thread is stuck on the first session
        second.start()
        # The second session gets as far as asking Zonos: its normalization did not wait for the
        # thread that is stuck.
        await until(lambda: len(requests) == 1, timeout=5)
    finally:
        release.set()
    assert (await drain(first.events()))[-1] == ("done", {})
    assert (await drain(second.events()))[-1] == ("done", {})


async def test_normalization_runs_off_the_event_loop(new_session, monkeypatch):
    real = session_module.normalize
    entered, release = threading.Event(), threading.Event()
    threads: list[int] = []

    def blocked_normalize(tokens, language):
        threads.append(threading.get_ident())
        entered.set()
        release.wait(timeout=2)  # never let a failing test hang for long
        return real(tokens, language)

    monkeypatch.setattr(session_module, "normalize", blocked_normalize)
    session, requests = new_session(make_sentences(1))
    session.start()
    # While normalization is stuck in its thread this loop keeps running: it sees the thread
    # arrive, and lets it go. Normalizing on the loop would block here until the 2 s are up.
    await until(entered.is_set, timeout=5)
    await asyncio.sleep(0.05)
    assert requests == []
    release.set()
    events = await drain(session.events())
    assert events[-1] == ("done", {})
    assert threads == [threads[0]] and threads[0] != threading.get_ident()


async def test_resampling_runs_off_the_event_loop(new_session, monkeypatch):
    real = session_module.resample_16k
    threads: list[threading.Thread] = []

    def noting_resample(audio, sr):
        threads.append(threading.current_thread())
        return real(audio, sr)

    monkeypatch.setattr(session_module, "resample_16k", noting_resample)
    session, _ = new_session(make_sentences(3))
    events, _ = await play(session)
    assert events[-1] == ("done", {})
    assert len(threads) == 3
    # A clip of nearly 30 s takes 25 ms to resample, 95 ms in one case in ten and 130 at worst, and
    # every other session's events would wait for it on the loop. The default executor, then: not
    # the aligner's thread, which can be busy.
    assert all(thread is not threading.current_thread() for thread in threads)
    assert not any(thread.name.startswith("speech-align") for thread in threads)


# Prefetch: how far ahead of the reader the worker goes.


async def test_prefetch_waits_for_the_reader(new_session):
    sentences = make_sentences(8)
    ids = [s.id for s in sentences]
    session, requests = new_session(sentences)  # prefetch is 2
    session.start()

    await until(lambda: len(requests) == 3)  # the sentence being read, and two ahead of it
    await asyncio.sleep(0.2)
    assert len(requests) == 3

    session.report_position(ids[1])  # the reader is on the second sentence: one more may start
    await until(lambda: len(requests) == 4)
    await asyncio.sleep(0.2)
    assert len(requests) == 4

    session.report_position(ids[7])  # near the end: everything left is within reach
    await until(lambda: len(requests) == 8)
    events = await drain(session.events())
    assert events[-1] == ("done", {})


async def test_the_prefetch_window_is_the_settings_one(new_session):
    session, requests = new_session(make_sentences(8), prefetch=0)
    session.start()
    await until(lambda: len(requests) == 1)
    await asyncio.sleep(0.2)
    assert len(requests) == 1


async def test_report_position_of_an_unknown_sentence_is_a_key_error(new_session):
    session, _ = new_session(make_sentences(2))
    with pytest.raises(KeyError):
        session.report_position("nonesuch")


async def test_a_position_reported_after_the_end_is_harmless(new_session):
    session, _ = new_session(make_sentences(2))
    await play(session)
    session.report_position("s1")


# The two readers.


async def test_each_reader_can_be_taken_once(new_session):
    session, _ = new_session(make_sentences(1))
    session.events()
    session.audio()
    with pytest.raises(ReaderTaken):
        session.events()
    with pytest.raises(ReaderTaken):
        session.audio()


async def test_a_session_starts_once(new_session):
    session, _ = new_session(make_sentences(1))
    session.start()
    with pytest.raises(RuntimeError, match="started"):
        session.start()


# Cancel.


async def test_cancel_stops_zonos_calls(new_session):
    session, requests = new_session(make_sentences(100), prefetch=100)
    session.start()
    await until(lambda: len(requests) >= 2)
    await cancel(session)
    count = len(requests)
    await asyncio.sleep(0.3)
    assert len(requests) == count
    assert count < 100


async def test_cancel_ends_both_streams_and_leaves_nothing_running(new_session):
    session, requests = new_session(make_sentences(100), prefetch=100)
    session.start()
    events, audio = session.events(), session.audio()
    async with asyncio.timeout(10):
        await anext(audio)  # the MP3 is flowing to a reader
    readers = [asyncio.create_task(drain(events)), asyncio.create_task(drain(audio))]
    await cancel(session)
    async with asyncio.timeout(5):
        await asyncio.gather(*readers)  # both streams end, instead of waiting for more
    assert session.ended
    assert ffmpeg_status(session) == -signal.SIGKILL
    assert_nothing_left_running()


async def test_cancel_right_after_start_ends_both_streams_without_a_zonos_call(new_session):
    session, requests = new_session(make_sentences(5))
    session.start()
    await cancel(session)
    async with asyncio.timeout(5):
        assert await drain(session.events()) == []
        assert await drain(session.audio()) == []
    assert requests == []
    assert session.ended
    assert_nothing_left_running()


async def test_cancel_before_start_ends_both_streams(new_session):
    session, _ = new_session(make_sentences(5))
    parked = [
        asyncio.create_task(drain(session.events())),
        asyncio.create_task(drain(session.audio())),
    ]
    await asyncio.sleep(0)
    await cancel(session)
    async with asyncio.timeout(5):
        assert await asyncio.gather(*parked) == [[], []]
    assert session.ended
    with pytest.raises(RuntimeError):
        session.start()
    assert_nothing_left_running()


@pytest.mark.parametrize("delay", [0.0, 0.002, 0.01, 0.03, 0.06, 0.1, 0.2])
async def test_cancel_at_any_moment_leaves_nothing_running(new_session, delay):
    session, _ = new_session(make_sentences(40), prefetch=40)
    session.start()
    readers = [
        asyncio.create_task(drain(session.events())),
        asyncio.create_task(drain(session.audio())),
    ]
    await asyncio.sleep(delay)
    await cancel(session)
    async with asyncio.timeout(5):
        await asyncio.gather(*readers)
    assert session.ended
    assert_nothing_left_running()


async def test_cancelling_twice_is_fine(new_session):
    session, _ = new_session(make_sentences(3))
    session.start()
    await asyncio.gather(cancel(session), cancel(session))
    await cancel(session)
    assert session.ended


# The idle end: nobody reads the audio.


async def test_session_ends_when_reader_leaves(new_session):
    # Sentences enough that the worker is mid-reading when the idle clock runs out.
    idle = 0.2
    session, requests = new_session(make_sentences(200), prefetch=200, idle_seconds=idle)
    loop = asyncio.get_running_loop()
    started = loop.time()
    session.start()
    await until(lambda: session.ended, timeout=5)
    # Not before the idle time is up, and soon after it: ffmpeg is killed and the worker gone.
    assert idle - 0.01 <= loop.time() - started <= idle + 0.3
    count = len(requests)
    assert 1 <= count < 200
    await asyncio.sleep(0.3)
    assert len(requests) == count  # and no call to Zonos after it
    assert ffmpeg_status(session) == -signal.SIGKILL
    async with asyncio.timeout(5):  # the streams are over, not waiting for more
        names = [name for name, _ in await drain(session.events())]
        assert "done" not in names
        assert await drain(session.audio()) == []
    assert_nothing_left_running()


async def test_nothing_is_queued_for_an_events_reader_that_has_left(new_session, monkeypatch):
    session, _ = new_session(make_sentences(6), prefetch=6)
    session.start()
    events = session.events()
    async with asyncio.timeout(10):
        await anext(events)
    await events.aclose()  # the timeline reader goes, and the audio reader stays

    queued: list = []
    real_put = session._events.put_nowait  # (the one place a test needs the timeline's queue)
    monkeypatch.setattr(
        session._events, "put_nowait", lambda item: (queued.append(item), real_put(item))
    )
    await drain(session.audio())
    assert session.ended
    assert queued == []  # not the rest of the timeline, which nobody reads, and not its end


async def test_an_attached_audio_reader_keeps_the_session_alive_until_it_leaves(new_session):
    session, requests = new_session(make_sentences(6), idle_seconds=0.3)
    loop = asyncio.get_running_loop()
    session.start()
    audio = session.audio()
    async with asyncio.timeout(10):
        await anext(audio)  # the reader has attached, and stops reading
    await asyncio.sleep(1.0)  # more than three idle periods
    assert not session.ended
    assert len(requests) == 3  # held by the prefetch, not by the end

    left = loop.time()
    await audio.aclose()
    await until(lambda: session.ended, timeout=5)
    assert loop.time() - left >= 0.3 - 0.01  # a full idle period after the reader left
    assert_nothing_left_running()


async def test_an_events_reader_alone_does_not_keep_the_session_alive(new_session):
    session, _ = new_session(make_sentences(6), idle_seconds=0.3)
    session.start()
    async with asyncio.timeout(10):
        events = await drain(session.events())  # the stream ends by itself
    assert "done" not in [name for name, _ in events]
    assert session.ended


async def test_an_audio_reader_that_never_started_does_not_keep_the_session_alive(new_session):
    session, _ = new_session(make_sentences(6), idle_seconds=0.3)
    audio = session.audio()  # taken, and never read
    session.start()
    await until(lambda: session.ended, timeout=5)
    await audio.aclose()


# Failures.


async def test_error_names_the_sentence(new_session):
    sentences = make_sentences(4)
    ids = [s.id for s in sentences]
    session, requests = new_session(sentences, fail_on=2)
    events, mp3 = await play(session)

    assert events[-1] == ("error", {"id": ids[1], "code": "synthesis_failed"})
    assert [name for name, _ in events].count("error") == 1
    assert "done" not in [name for name, _ in events]
    assert len(requests) == 2  # it stops: no sentence after the one that failed
    # The sentence before it was announced, timed, and is in the stream, up to its last frame.
    assert [data["id"] for data in of(events, "sentence")] == [ids[0]]
    assert [data["id"] for data in of(events, "words")] == [ids[0]]
    assert decoded_seconds(mp3) == pytest.approx(of(events, "sentence")[0]["end"], abs=0.15)
    assert ffmpeg_status(session) == 0  # the encoder was closed, not killed
    assert session.ended
    assert_nothing_left_running()


async def test_an_error_ends_the_session_without_waiting_for_its_readers(new_session):
    session, _ = new_session(make_sentences(3), fail_on=1)
    session.start()
    await until(lambda: session.ended, timeout=5)
    assert (await drain(session.events())) == [("error", {"id": "s0", "code": "synthesis_failed"})]
    assert_nothing_left_running()


async def test_zonos_unavailable_has_its_own_code(new_session):
    session, _ = new_session(make_sentences(2), zonos=(refusing_transport(), []))
    events, _ = await play(session)
    assert events == [("error", {"id": "s0", "code": "zonos_unavailable"})]
    assert session.ended
    assert_nothing_left_running()


@pytest.mark.parametrize("rate", [22050, 48000])
async def test_a_sample_rate_other_than_44100_is_a_failed_synthesis(new_session, rate):
    zonos = zonos_answering(lambda: wav_response(tone(0.3, 1.0), rate))
    session, requests = new_session(make_sentences(2), zonos=zonos)
    events, _ = await play(session)
    assert events == [("error", {"id": "s0", "code": "synthesis_failed"})]
    assert len(requests) == 1


async def test_audio_that_is_all_silence_is_a_failed_synthesis(new_session):
    zonos = zonos_answering(lambda: wav_response(np.zeros(SR, dtype=np.float32)))
    session, _ = new_session(make_sentences(2), zonos=zonos)
    events, _ = await play(session)
    assert events == [("error", {"id": "s0", "code": "synthesis_failed"})]


async def test_a_dead_encoder_ends_the_session_without_done(new_session, monkeypatch):
    real_write = Mp3Encoder.write
    writes = 0

    async def dying_write(self, pcm):
        nonlocal writes
        writes += 1
        if writes == 3:  # the second sentence's audio, after the first and the gap
            raise BrokenPipeError("ffmpeg is no longer running")
        await real_write(self, pcm)

    monkeypatch.setattr(Mp3Encoder, "write", dying_write)
    session, requests = new_session(make_sentences(4))
    events, _ = await play(session)
    assert "done" not in [name for name, _ in events]
    assert events[-1] == ("error", {"id": "s1", "code": "synthesis_failed"})
    assert of(events, "words")[0]["id"] == "s0"  # the first sentence's words still came first
    assert len(requests) == 2
    assert session.ended
    assert_nothing_left_running()


async def test_an_unexpected_failure_ends_the_session_with_an_error(new_session, monkeypatch):
    real = session_module.normalize

    def fails_on_the_second(tokens, language):
        if fails_on_the_second.calls:
            raise ValueError("a bug that mentions Zebrafish")
        fails_on_the_second.calls += 1
        return real(tokens, language)

    fails_on_the_second.calls = 0
    monkeypatch.setattr(session_module, "normalize", fails_on_the_second)
    session, _ = new_session(make_sentences(3))
    events, _ = await play(session)
    assert events[-1] == ("error", {"id": "s1", "code": "synthesis_failed"})
    assert "done" not in [name for name, _ in events]
    assert session.ended
    assert_nothing_left_running()


# Done.


async def test_the_session_ends_when_both_readers_have_drained(new_session):
    session, requests = new_session(make_sentences(3))
    session.start()
    async with asyncio.timeout(10):
        events = await drain(session.events())
    assert events[-1] == ("done", {})
    assert not session.ended  # the audio has not been read yet: it is still there to be read

    async with asyncio.timeout(10):
        mp3 = b"".join(await drain(session.audio()))
    assert session.ended
    assert decoded_seconds(mp3) == pytest.approx(of(events, "sentence")[-1]["end"], abs=0.15)
    assert ffmpeg_status(session) == 0
    assert_nothing_left_running()


async def test_a_session_read_by_both_readers_together_is_ended_when_they_return(new_session):
    session, _ = new_session(make_sentences(3))
    events, _ = await play(session)  # both readers, together
    assert events[-1] == ("done", {})
    assert session.ended
    assert_nothing_left_running()


# Memory, and two readers at once.


async def test_long_session_keeps_no_written_audio(new_session):
    sentences = make_sentences(200, tokens=("Hello", "there", "my", "dear", "old", "friend."))
    session, _ = new_session(sentences, prefetch=200)
    tracemalloc.start(25)
    try:
        events, mp3 = await play(session, timeout=120)
        snapshot = tracemalloc.take_snapshot()
    finally:
        tracemalloc.stop()
    assert events[-1] == ("done", {})
    mine = snapshot.filter_traces(
        [tracemalloc.Filter(True, session_module.__file__, all_frames=True)]
    )
    still_allocated = sum(stat.size for stat in mine.statistics("filename"))
    limit = 20 * 1024 * 1024
    assert still_allocated < limit
    # The check has teeth: even the 16 kHz copies of all the audio, kept, would be over the limit.
    assert of(events, "sentence")[-1]["end"] * 16_000 * 4 > limit


async def test_two_sessions_progress_together(new_session):
    zonos = fake_zonos(concurrency=2)
    first, _ = new_session(make_sentences(12), zonos=zonos, session_id="a", prefetch=12)
    second, _ = new_session(make_sentences(12), zonos=zonos, session_id="b", prefetch=12)
    (events_a, _), (events_b, _) = await asyncio.gather(play(first), play(second))
    assert events_a[-1] == events_b[-1] == ("done", {})
    # Their calls to Zonos overlapped: neither session waited for the other.
    assert zonos[1].max_in_flight == 2


# What the logs hold.


def _logged(caplog: pytest.LogCaptureFixture) -> list[str]:
    """Everything that was logged, message and exception text and all: by the speech service, and
    by asyncio and the rest, which log "exception never retrieved" and quote the exception."""
    formatter = logging.Formatter()
    lines = []
    for record in caplog.records:
        lines.append(record.getMessage())
        if record.exc_info:
            lines.append(formatter.formatException(record.exc_info))
        if record.exc_text:
            lines.append(record.exc_text)
    return lines


class _QuotesTheWords(FakeAligner):
    def align(self, audio_16k, words):
        raise RuntimeError(f"cannot time {words}")  # breaks the aligners' own rule on purpose


@pytest.mark.parametrize(
    "scenario",
    [
        "done",
        "aligner-quotes",
        "zonos-refuses",
        "zonos-500",
        "normalizer-quotes",
        "cancelled",
        "idle",
    ],
)
async def test_no_reply_text_is_logged(new_session, caplog, monkeypatch, scenario):
    caplog.set_level(logging.DEBUG, logger="speech_service")
    sentences = make_sentences(3, tokens=tuple(SECRET))
    options: dict = {}
    if scenario == "aligner-quotes":
        options["aligner"] = _QuotesTheWords()
    elif scenario == "zonos-refuses":
        options["zonos"] = (refusing_transport(), [])
    elif scenario == "zonos-500":
        options["fail_on"] = 2
    elif scenario == "normalizer-quotes":
        def quoting(tokens, language):
            raise ValueError(f"cannot normalize {tokens}")

        monkeypatch.setattr(session_module, "normalize", quoting)
    elif scenario == "idle":
        options.update(idle_seconds=0.1, prefetch=3)
    session, _ = new_session(sentences, **options)

    if scenario == "cancelled":
        session.start()
        await asyncio.sleep(0.05)
        await cancel(session)
    elif scenario == "idle":
        session.start()
        await until(lambda: session.ended)
    else:
        await play(session)

    lines = _logged(caplog)
    assert any("test-session" in line for line in lines)  # it logs, and says whose session it is
    for line in lines:
        assert "Zebrafish" not in line and "Quokka" not in line, line


# What a session may be made of.


def _zonos() -> ZonosClient:
    return ZonosClient("http://zonos.test", fake_zonos()[0])


def test_long_sentence_refused():
    zonos = _zonos()
    just_fits = Sentence("s0", "en", VOICE, ["x" * 400], False)
    ReadingSession("id", [just_fits], zonos, FakeAligner(), Settings())
    too_long = Sentence("s0", "en", VOICE, ["x" * 401], False)
    with pytest.raises(ValueError, match="400"):
        ReadingSession("id", [too_long], zonos, FakeAligner(), Settings())
    joined = Sentence("s0", "en", VOICE, ["abcd"] * 81, False)  # 81 words and 80 spaces: 404
    with pytest.raises(ValueError, match="400"):
        ReadingSession("id", [joined], zonos, FakeAligner(), Settings())


def test_the_longest_sentence_is_the_settings_not_a_constant():
    zonos = _zonos()
    sentence = Sentence("s0", "en", VOICE, ["x" * 11], False)
    ReadingSession("id", [sentence], zonos, FakeAligner(), Settings(max_sentence_chars=11))
    with pytest.raises(ValueError, match="10"):
        ReadingSession("id", [sentence], zonos, FakeAligner(), Settings(max_sentence_chars=10))


def test_a_session_needs_sentences():
    zonos = _zonos()
    with pytest.raises(ValueError, match="sentence"):
        ReadingSession("id", [], zonos, FakeAligner(), Settings())


def test_sentence_ids_must_be_unique():
    zonos = _zonos()
    twice = [Sentence("s0", "en", VOICE, ["a"], False), Sentence("s0", "en", VOICE, ["b"], False)]
    with pytest.raises(ValueError, match="unique"):
        ReadingSession("id", twice, zonos, FakeAligner(), Settings())


def test_a_refused_sentence_is_not_quoted():
    zonos = _zonos()
    with pytest.raises(ValueError) as refused:
        ReadingSession(
            "id",
            [Sentence("s0", "en", VOICE, [SECRET[0] * 100], False)],
            zonos,
            FakeAligner(),
            Settings(),
        )
    assert SECRET[0] not in str(refused.value)


# The same readings on the loop uvicorn runs in production.


@pytest.fixture(params=["asyncio", "uvloop"])
def run(request):
    """Runs a coroutine to completion on a new event loop of that kind."""
    if request.param == "uvloop":
        return pytest.importorskip("uvloop").run
    return asyncio.run


def test_a_reading_and_a_cancel_on_each_kind_of_loop(run):
    async def scenario() -> None:
        http, _ = fake_zonos()
        client = ZonosClient("http://zonos.test", http)

        def new() -> ReadingSession:
            settings = Settings(prefetch=40, idle_seconds=5)
            return ReadingSession("id", make_sentences(40), client, FakeAligner(), settings)

        await Mp3Encoder.warm_up()
        whole = new()
        events, mp3 = await play(whole)
        assert events[-1] == ("done", {}) and mp3 and whole.ended

        halfway = new()
        halfway.start()
        readers = [
            asyncio.create_task(drain(halfway.events())),
            asyncio.create_task(drain(halfway.audio())),
        ]
        await asyncio.sleep(0.1)
        await halfway.cancel()
        async with asyncio.timeout(5):
            await asyncio.gather(*readers)
        assert halfway.ended
        assert_nothing_left_running()
        await http.aclose()

    run(scenario())
