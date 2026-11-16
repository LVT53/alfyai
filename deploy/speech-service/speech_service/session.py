"""Reading sessions: one reply read out, sentence by sentence, as one MP3 stream and a timeline.

A session is a worker task. For each sentence, in order, and never more than `prefetch` sentences
ahead of the one the reader has reported as playing, it
  1. turns the written tokens into the words the voice will say (zyphra-textnorm, in a thread),
  2. has Zonos say them, trims the audio and matches its loudness,
  3. writes a gap and the audio to the session's one MP3 encoder, announcing the sentence first,
  4. and has FuseAlign find the words in that audio, while the next sentence is being synthesized.

Two readers follow it, each taken once: `events()` for the timeline (what the SSE route sends) and
`audio()` for the MP3 (what the audio response sends).

The session ends in one of these ways, and no task of it and no ffmpeg is left running (a job
queued for a thread is cancelled; one already running in a thread, a normalization, a resampling or
an alignment, cannot be interrupted and finishes by itself, its result dropped):
  - `cancel()`, or the idle end (no audio reader for `idle_seconds`): the worker is stopped at once,
    ffmpeg is killed, whatever MP3 is still unread is dropped, and both streams finish;
  - it fails (Zonos could not be reached or made no usable audio, ffmpeg died, a bug): the `error`
    event says which sentence, the encoder closes the ordinary way so the audio before it is
    delivered whole, and both streams finish;
  - it finishes: `done` comes after the last `words` event, the encoder closes, and the session is
    over once both readers have drained.

Nothing a sentence's audio was made of is kept once it has been written and aligned, so a reply of
any length runs in bounded memory. Logs carry the session id, counts, timings and the type of an
error, never reply text.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
import traceback
from collections.abc import AsyncGenerator
from concurrent.futures import ThreadPoolExecutor
from pathlib import PurePath

import numpy as np

from speech_service.aligner import Aligner, Interval, resample_16k, token_times
from speech_service.audio import SAMPLE_RATE, Mp3Encoder, match_loudness, silence, trim_silence
from speech_service.config import Settings
from speech_service.models import Sentence
from speech_service.text import Spoken, normalize
from speech_service.zonos import SynthesisFailed, ZonosClient, ZonosUnavailable

logger = logging.getLogger(__name__)

Event = tuple[str, dict]

# The gap before a sentence, and before the first sentence of a paragraph.
_GAP_SECONDS = 0.30
_PARAGRAPH_GAP_SECONDS = 0.60

# Every alignment of every session runs on this one thread. FuseAlign blocks, and two of them at
# once would double its memory against the service's budget of 1.5 GB. A job that has not started
# when its session ends is cancelled; one that is running cannot be interrupted, so it finishes
# (within a sentence's alignment time) and its result is dropped.
_ALIGNER_THREAD = ThreadPoolExecutor(max_workers=1, thread_name_prefix="speech-align")


class ReaderTaken(Exception):
    """`events()` or `audio()` was called a second time: each can be taken once per session."""


class ReadingSession:
    """One reading: sentences in, an MP3 stream and a timeline out. See the module docstring.

    `start()` must be called on the event loop that serves the readers. `events()` and `audio()`
    return async generators, and the route must close them (`aclose()`) when its client goes: an
    audio reader that has left is what the idle clock waits for. A session that is no longer needed
    is cancelled, never just dropped.
    """

    def __init__(
        self,
        id: str,
        sentences: list[Sentence],
        zonos: ZonosClient,
        aligner: Aligner,
        settings: Settings,
    ) -> None:
        """Raises ValueError for no sentences, a sentence of more than `settings.max_sentence_chars`
        characters (its tokens joined by spaces), or two sentences with the same id. The message
        names a sentence by its position, never by its text."""
        if not sentences:
            raise ValueError("a session needs at least one sentence")
        for position, sentence in enumerate(sentences):
            if len(" ".join(sentence.tokens)) > settings.max_sentence_chars:
                raise ValueError(
                    f"sentence {position} is longer than {settings.max_sentence_chars} characters"
                )
        if len({sentence.id for sentence in sentences}) != len(sentences):
            raise ValueError("sentence ids must be unique")

        self.id = id
        self._sentences = list(sentences)
        self._position_of = {sentence.id: position for position, sentence in enumerate(sentences)}
        self._zonos = zonos
        self._aligner = aligner
        self._settings = settings

        self._encoder = Mp3Encoder()
        self._events: asyncio.Queue[Event | None] = asyncio.Queue()  # None ends the stream
        self._audio: asyncio.Queue[bytes | None] = asyncio.Queue()  # None ends the stream
        self._events_closed = False
        self._audio_closed = False

        # Where the reader is: the index of the sentence now playing.
        self._reader_at = 0
        self._reader_moved = asyncio.Event()

        self._loop: asyncio.AbstractEventLoop | None = None
        self._worker: asyncio.Task[None] | None = None
        self._forwarder: asyncio.Task[None] | None = None
        self._aligning: asyncio.Task[None] | None = None
        self._teardown: asyncio.Task[None] | None = None
        self._idle_clock: asyncio.TimerHandle | None = None

        self._events_taken = False
        self._audio_taken = False
        self._events_finished = False  # the events reader has returned (drained or left)
        self._audio_finished = False
        self._audio_attached = False
        # "completed" once `done` is out, "failed" once `error` is. Cancel and idle set neither.
        self._outcome: str | None = None
        self._ended = False
        self._current = 0  # the index of the sentence being read
        self._announced = 0
        self._began = 0.0

    @property
    def ended(self) -> bool:
        """Whether the session is over: no task of it and no ffmpeg is running, and both streams
        have finished.

        True after `cancel()`, the idle end, an error, and (once both readers have drained) `done`.
        """
        return self._ended

    def start(self) -> None:
        """Begin reading. The idle clock starts now."""
        if self._worker is not None or self._teardown is not None:
            raise RuntimeError("the session has started already, or has ended")
        self._loop = asyncio.get_running_loop()
        self._began = time.monotonic()
        self._worker = self._loop.create_task(self._run(), name=f"reading-{self.id}")
        self._worker.add_done_callback(self._worker_stopped)
        self._arm_idle_clock()
        logger.info("session %s: started, %d sentences", self.id, len(self._sentences))

    def events(self) -> AsyncGenerator[Event, None]:
        """The timeline, as `(name, data)` pairs: `sentence`, `words`, `error` and `done`.

        Raises ReaderTaken if it was taken already.
        """
        if self._events_taken:
            raise ReaderTaken("the events of this session have been taken already")
        self._events_taken = True
        return self._stream_events()

    def audio(self) -> AsyncGenerator[bytes, None]:
        """The MP3, in chunks, as it is made. Reading it stops the idle clock; leaving restarts it.

        Raises ReaderTaken if it was taken already.
        """
        if self._audio_taken:
            raise ReaderTaken("the audio of this session has been taken already")
        self._audio_taken = True
        return self._stream_audio()

    def report_position(self, sentence_id: str) -> None:
        """The reader is now on this sentence: the worker may go `prefetch` sentences past it.

        Raises KeyError for an id that is not one of the session's sentences.
        """
        self._reader_at = self._position_of[sentence_id]
        self._reader_moved.set()

    async def cancel(self) -> None:
        """End the session now. When this returns, its worker and ffmpeg are gone and both streams
        have finished. Calling it again, or after the session ended, is fine."""
        if not self._ended:
            await asyncio.shield(self._begin_end("cancelled"))

    # The readers.

    async def _stream_events(self) -> AsyncGenerator[Event, None]:
        try:
            while (event := await self._events.get()) is not None:
                yield event
        finally:
            self._events_finished = True
            self._conclude()

    async def _stream_audio(self) -> AsyncGenerator[bytes, None]:
        self._audio_attached = True
        self._disarm_idle_clock()
        try:
            while (chunk := await self._audio.get()) is not None:
                yield chunk
        finally:
            self._audio_attached = False
            self._audio_finished = True
            self._drop_audio()  # what this reader did not read, nobody will
            self._arm_idle_clock()
            self._conclude()

    # The worker.

    async def _run(self) -> None:
        """The worker. However it ends, none of its tasks is left running when it returns."""
        try:
            async with self._encoder:
                self._forwarder = asyncio.create_task(
                    self._forward_audio(), name=f"reading-{self.id}-audio"
                )
                await self._read_aloud()
            # Leaving the block closed the encoder: ffmpeg's last frames are on their way.
            await self._forwarder
        except Exception as error:
            # The encoder could not start or could not finish (ffmpeg is missing, or died).
            logger.warning("session %s: the encoder failed: %s", self.id, _describe(error))
            if self._outcome is None:
                self._fail("synthesis_failed")
        finally:
            await self._stop_tasks()
            # The streams end as the last thing the worker does, so a reader that sees its stream
            # end finds the worker gone. A teardown (cancel, idle) does this itself, once it has
            # the worker's word that it is gone, and then says the session has ended.
            if self._teardown is None:
                self._close_events()
                self._close_audio()

    async def _read_aloud(self) -> None:
        """Read every sentence out and say `done`; or say which sentence went wrong and stop."""
        try:
            for index, sentence in enumerate(self._sentences):
                self._current = index
                await self._wait_for_the_reader(index)
                await self._read(sentence)
            await self._flush_alignment()
            self._outcome = "completed"
            self._emit("done", {})
        except Exception as error:
            logger.warning(
                "session %s: sentence %d failed: %s", self.id, self._current, _describe(error)
            )
            # The words of the sentence before still come first, then the error ends the timeline.
            await self._flush_alignment()
            self._fail(_error_code(error))

    async def _wait_for_the_reader(self, index: int) -> None:
        """Hold the worker until `index` is within `prefetch` sentences of the one being played."""
        while index > self._reader_at + self._settings.prefetch:
            self._reader_moved.clear()
            await self._reader_moved.wait()

    async def _read(self, sentence: Sentence) -> None:
        # Off the event loop: a sentence of many numbers can take the normalizer a tenth of a second
        # and more (the Hungarian "két" lookups are quadratic in them), and another session's events
        # must not wait for that. The default executor, not the aligner's thread, which can be busy.
        spoken = await asyncio.to_thread(normalize, sentence.tokens, sentence.language)
        if not spoken.words:
            # Nothing to say (a lone symbol, an emoji): no call to Zonos, no time, no gap.
            await self._flush_alignment()
            now = self._clock()
            self._emit("sentence", {"id": sentence.id, "start": _ms(now), "end": _ms(now)})
            self._emit("words", {"id": sentence.id, "times": [None] * len(sentence.tokens)})
            self._announced += 1
            return

        clip = await self._synthesize(sentence, spoken)
        if self._encoder.samples_written:  # a gap goes between sentences, not before the first
            gap = _PARAGRAPH_GAP_SECONDS if sentence.paragraph_start else _GAP_SECONDS
            await self._encoder.write(silence(gap, SAMPLE_RATE))
        start = self._clock()
        end = start + len(clip) / SAMPLE_RATE
        self._emit("sentence", {"id": sentence.id, "start": _ms(start), "end": _ms(end)})
        self._announced += 1
        await self._encoder.write(clip)

        # What is aligned is exactly what was written. Keep only that, at 16 kHz. Off the event
        # loop: a clip of nearly 30 s takes 25 ms, 130 at worst (a length with a large prime factor
        # falls back to a slower transform), and another session's events must not wait for that.
        # The default executor again, not the aligner's thread.
        audio_16k = await asyncio.to_thread(resample_16k, clip, SAMPLE_RATE)
        del clip
        # One alignment at a time: the words of the sentence before come out first, and the memory
        # held for alignment is one sentence's. The next sentence is synthesized meanwhile.
        await self._flush_alignment()
        self._aligning = asyncio.create_task(
            self._align(self._current, sentence, spoken, audio_16k, start),
            name=f"reading-{self.id}-words",
        )

    async def _synthesize(self, sentence: Sentence, spoken: Spoken) -> np.ndarray:
        """The sentence as Zonos says it, trimmed and matched in loudness, ready to be written."""
        audio, rate = await self._zonos.synthesize(
            " ".join(spoken.words), sentence.language, sentence.voice, self._settings.seed
        )
        if rate != SAMPLE_RATE:  # Zonos's output is documented, and measured, as 44.1 kHz
            raise SynthesisFailed(f"Zonos sent audio at {rate} Hz, not {SAMPLE_RATE} Hz")
        clip = match_loudness(trim_silence(audio, rate), rate)
        if clip.size == 0:
            raise SynthesisFailed("Zonos sent nothing but silence")
        return clip

    async def _align(
        self, index: int, sentence: Sentence, spoken: Spoken, audio_16k: np.ndarray, start: float
    ) -> None:
        """Find the sentence's words in its audio and announce them on the stream's clock."""
        try:
            word_times = await asyncio.get_running_loop().run_in_executor(
                _ALIGNER_THREAD, self._aligner.align, audio_16k, spoken.words
            )
            times = [_on_stream_clock(t, start) for t in token_times(spoken, word_times)]
        except Exception as error:
            # The reader then gets the sentence tint without the word mark, and no error.
            logger.warning(
                "session %s: no word times for sentence %d: %s", self.id, index, _describe(error)
            )
            times = [None] * len(sentence.tokens)
        self._emit("words", {"id": sentence.id, "times": times})

    async def _flush_alignment(self) -> None:
        """Wait until the `words` of the sentence written last are out."""
        pending, self._aligning = self._aligning, None
        if pending is not None:
            await pending

    async def _forward_audio(self) -> None:
        """Move the MP3 from the encoder to the audio queue as it appears."""
        async for chunk in self._encoder.read_chunks():
            if not self._audio_finished:  # a reader that has left reads nothing more
                self._audio.put_nowait(chunk)

    async def _stop_tasks(self) -> None:
        tasks = [task for task in (self._aligning, self._forwarder) if task is not None]
        for task in tasks:
            task.cancel()  # a task that has finished is not affected
        await asyncio.gather(*tasks, return_exceptions=True)
        self._aligning = self._forwarder = None

    def _clock(self) -> float:
        """Where the next sample written will be heard, in seconds on the stream's clock."""
        return self._encoder.samples_written / SAMPLE_RATE + self._encoder.delay_seconds

    # Telling the readers.

    def _emit(self, name: str, data: dict) -> None:
        if not self._events_closed:
            self._events.put_nowait((name, data))

    def _fail(self, code: str) -> None:
        """Say which sentence went wrong. The timeline ends here, and so does the session."""
        self._outcome = "failed"
        self._emit("error", {"id": self._sentences[self._current].id, "code": code})

    def _close_events(self) -> None:
        if not self._events_closed:
            self._events_closed = True
            self._events.put_nowait(None)

    def _close_audio(self, drop: bool = False) -> None:
        """End the audio stream, once. With `drop`, whatever MP3 is still unread is thrown away."""
        if drop:
            self._drop_audio()
        if drop or not self._audio_closed:
            self._audio_closed = True
            self._audio.put_nowait(None)

    def _drop_audio(self) -> None:
        while not self._audio.empty():
            self._audio.get_nowait()

    # How a session ends.

    def _arm_idle_clock(self) -> None:
        """Start counting down to the idle end, unless an audio reader is attached or it is over."""
        if self._loop is None or self._loop.is_closed():  # not started, or the loop is gone
            return
        if self._audio_attached or self._ended or self._teardown is not None:
            return
        self._disarm_idle_clock()
        self._idle_clock = self._loop.call_later(self._settings.idle_seconds, self._went_idle)

    def _disarm_idle_clock(self) -> None:
        if self._idle_clock is not None:
            self._idle_clock.cancel()
            self._idle_clock = None

    def _went_idle(self) -> None:
        self._idle_clock = None
        logger.info("session %s: nobody reads the audio, ending it", self.id)
        self._begin_end("idle")

    def _begin_end(self, reason: str) -> asyncio.Task[None]:
        """Stop the worker this instant (no Zonos call starts after this) and finish the session."""
        if self._teardown is None:
            self._disarm_idle_clock()
            if self._worker is not None:
                self._worker.cancel()  # a worker that has finished is not affected
            self._teardown = asyncio.get_running_loop().create_task(
                self._end(reason), name=f"reading-{self.id}-end"
            )
        return self._teardown

    async def _end(self, reason: str) -> None:
        if self._worker is not None:
            # The worker kills ffmpeg and stops its own tasks as it unwinds: wait until it has.
            await asyncio.gather(self._worker, return_exceptions=True)
        self._close_events()
        self._close_audio(drop=True)
        self._finish(reason)

    def _worker_stopped(self, worker: asyncio.Task[None]) -> None:
        if not worker.cancelled() and (error := worker.exception()) is not None:
            # Not expected: the worker reports its own failures. Do not leave the readers waiting.
            logger.error("session %s: the worker crashed: %s", self.id, _describe(error))
            self._outcome = "failed"
            self._close_events()
            self._close_audio()
        self._conclude()

    def _conclude(self) -> None:
        """End the session if it is over by itself: it failed, or it finished and both readers are
        through. (Cancel and the idle end finish it in `_end`.)"""
        worker = self._worker
        if self._ended or self._teardown is not None or worker is None or not worker.done():
            return
        if self._outcome == "failed":
            if not self._audio_attached:  # nobody is reading the audio before it: drop it
                self._close_audio(drop=True)
            self._finish("failed")
        elif self._outcome == "completed" and self._events_finished and self._audio_finished:
            self._finish("completed")

    def _finish(self, reason: str) -> None:
        if self._ended:
            return
        self._ended = True
        self._disarm_idle_clock()
        logger.info(
            "session %s: ended (%s), %d of %d sentences announced in %.1f s",
            self.id,
            reason,
            self._announced,
            len(self._sentences),
            time.monotonic() - self._began,
        )


def _ms(seconds: float) -> float:
    return round(seconds, 3)


def _on_stream_clock(interval: Interval | None, start: float) -> list[float] | None:
    """A token's `(start, end)` in its sentence's audio as `[start, end]` on the stream's clock, in
    milliseconds; None for a token with no time, or one that is not a finite number."""
    if interval is None:
        return None
    begin, end = start + interval[0], start + interval[1]
    if not (math.isfinite(begin) and math.isfinite(end)):  # JSON has no NaN
        return None
    return [_ms(begin), _ms(end)]


def _error_code(error: Exception) -> str:
    """The `error` event's code: Zonos not answering at all, or anything else gone wrong."""
    return "zonos_unavailable" if isinstance(error, ZonosUnavailable) else "synthesis_failed"


def _describe(error: BaseException) -> str:
    """What to log of an error: its type and where it was raised. Never its message, which may
    quote the reply, nor its traceback."""
    frames = traceback.extract_tb(error.__traceback__)
    where = f" at {PurePath(frames[-1].filename).name}:{frames[-1].lineno}" if frames else ""
    return f"{type(error).__name__}{where}"
