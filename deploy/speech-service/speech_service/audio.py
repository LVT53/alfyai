"""Audio: loudness matching, silence trimming, gaps and the MP3 encoder pipe.

A sentence comes from Zonos as float32 mono PCM. It is matched to the loudness of every other
sentence, trimmed, and written (after a gap) to one Mp3Encoder: an ffmpeg process whose MP3 goes
out through the session's one HTTP response. Nothing here touches the disk.
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import AsyncIterator
from typing import ClassVar, Self

import numpy as np

SAMPLE_RATE = 44100

# Speech is every 20 ms frame whose RMS is above a thirtieth of the loudest frame's (the rule of the
# design spike). What is quieter is pause, room tone or a fading tail.
_FRAME_SECONDS = 0.02
_SPEECH_FRACTION = 1 / 30


def _hop(sr: int) -> int:
    """The samples in one 20 ms frame."""
    return max(1, round(_FRAME_SECONDS * sr))


def _frame_energy(x: np.ndarray, hop: int) -> tuple[np.ndarray, np.ndarray]:
    """Each `hop`-sample frame of `x` (the last may be shorter): its sum of squares and its size."""
    starts = np.arange(0, len(x), hop)
    return np.add.reduceat(np.square(x, dtype=np.float64), starts), np.minimum(hop, len(x) - starts)


def _speech_frames(energy: np.ndarray, sizes: np.ndarray) -> np.ndarray:
    """Which frames are speech: none, when the clip is silent or empty."""
    rms = np.sqrt(energy / sizes)
    return rms > (rms.max() * _SPEECH_FRACTION if rms.size else 0.0)


def match_loudness(
    x: np.ndarray, sr: int, target_db: float = -20.0, peak_db: float = -1.0
) -> np.ndarray:
    """`x` with one gain applied: the speech frames' RMS lands on `target_db` (dBFS).

    If that would put a peak above `peak_db`, the gain is lowered until the peak is exactly there.
    A silent clip comes back as it is. The result is a new array.
    """
    energy, sizes = _frame_energy(x, _hop(sr))
    speech = _speech_frames(energy, sizes)
    if not speech.any():
        return x.copy()
    rms = math.sqrt(energy[speech].sum() / sizes[speech].sum())
    gain = min(
        10 ** (target_db / 20) / rms,
        10 ** (peak_db / 20) / float(np.max(np.abs(x))),
    )
    return np.asarray(x * gain, dtype=np.float32)


def trim_silence(x: np.ndarray, sr: int, keep_s: float = 0.05) -> np.ndarray:
    """`x` from `keep_s` before its first speech frame to `keep_s` after its last, kept within `x`.

    A silent clip gives an empty array. The result is a new array.
    """
    hop = _hop(sr)
    energy, sizes = _frame_energy(x, hop)
    speech = np.flatnonzero(_speech_frames(energy, sizes))
    if speech.size == 0:
        return np.empty(0, dtype=x.dtype)
    keep = round(keep_s * sr)
    start = max(0, int(speech[0]) * hop - keep)
    end = min(len(x), (int(speech[-1]) + 1) * hop + keep)
    return x[start:end].copy()


def silence(seconds: float, sr: int) -> np.ndarray:
    """`seconds` of silence: the gap between sentences."""
    return np.zeros(round(seconds * sr), dtype=np.float32)


def click_at(seconds: float, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Silence with one full-scale sample at `seconds`, and half a second of silence after it.

    Where the click comes out of an encoder and decoder tells how late they play.
    """
    clip = np.zeros(round((seconds + 0.5) * sr), dtype=np.float32)
    clip[round(seconds * sr)] = 1.0
    return clip


# ffmpeg reads float32 little-endian mono PCM on stdin and writes MP3 on stdout. `-flush_packets 1`
# makes it flush after each MP3 frame, so the stream is progressive rather than arriving in blocks.
_FFMPEG_ENCODE = (
    "ffmpeg", "-hide_banner", "-loglevel", "error",
    "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "-",
    "-c:a", "libmp3lame", "-b:a", "128k", "-flush_packets", "1", "-f", "mp3", "-",
)
_FFMPEG_DECODE = (
    "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "-",
    "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-",
)
_CLICK_SECONDS = 0.5
_READ_BYTES = 65536


async def _run_ffmpeg(command: tuple[str, ...], data: bytes) -> bytes:
    """What `command` writes to stdout when `data` is its stdin."""
    proc = await asyncio.create_subprocess_exec(
        *command,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        out, _ = await proc.communicate(data)
    except BaseException:
        if proc.returncode is None:
            proc.kill()
        raise
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg exited with status {proc.returncode}")
    return out


async def _measure_delay() -> float:
    """How late the encoder's output plays, in seconds: encode a click, decode it, find it."""
    click = np.asarray(click_at(_CLICK_SECONDS), dtype="<f4").tobytes()
    mp3 = await _run_ffmpeg(_FFMPEG_ENCODE, click)
    decoded = np.frombuffer(await _run_ffmpeg(_FFMPEG_DECODE, mp3), dtype="<f4")
    if decoded.size == 0:
        raise RuntimeError("ffmpeg decoded no audio from the click that measures the delay")
    found = int(np.argmax(np.abs(decoded))) / SAMPLE_RATE
    return max(0.0, found - _CLICK_SECONDS)


class Mp3Encoder:
    """One MP3 stream: PCM goes in through `write`, MP3 comes out through `read_chunks`.

    Use it once, as an async context manager. An ffmpeg process encodes (44.1 kHz mono, 128 kbit/s),
    and a task moves its output into a queue as it appears, so a write never waits for the reader of
    the MP3: the HTTP route may read the events before the audio, or stop reading altogether.

    Leaving the block normally closes the stream; leaving it with an error or a cancel kills ffmpeg
    at once.
    """

    # The encoder's priming delay is the same for every stream: measured once per process.
    _delay: ClassVar[float | None] = None
    _delay_lock: ClassVar[asyncio.Lock] = asyncio.Lock()

    def __init__(self) -> None:
        self.samples_written = 0
        self._chunks: asyncio.Queue[bytes | None] = asyncio.Queue()  # None ends the stream
        self._proc: asyncio.subprocess.Process | None = None
        self._pump: asyncio.Task[None] | None = None
        self._closed = False

    @classmethod
    async def warm_up(cls) -> float:
        """Measure the encoder's delay now, if it has not been measured, and return it.

        Otherwise the first stream pays for the two ffmpeg runs it takes; start-up calls this.
        """
        delay = cls._delay
        if delay is None:
            async with cls._delay_lock:
                delay = cls._delay
                if delay is None:
                    delay = cls._delay = await _measure_delay()
        return delay

    @property
    def delay_seconds(self) -> float:
        """How late the decoded stream plays what is written to it: the encoder's priming delay."""
        if self._delay is None:
            raise RuntimeError("The delay is not measured yet: start an encoder or warm_up() first")
        return self._delay

    async def __aenter__(self) -> Self:
        if self._proc is not None:
            raise RuntimeError("An Mp3Encoder carries one stream: make a new one")
        await self.warm_up()
        proc = await asyncio.create_subprocess_exec(
            *_FFMPEG_ENCODE,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        assert proc.stdout is not None  # a pipe
        self._proc = proc
        self._pump = asyncio.create_task(self._pump_output(proc.stdout))
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        if self._proc is None:
            return
        try:
            if exc_type is None:
                await self.close()
        finally:
            # With an error or a cancel the stream is abandoned: nobody waits for ffmpeg to finish
            # its last frames. Whatever happened, ffmpeg is gone when the block is left. The pump
            # keeps draining stdout meanwhile, and has to: wait() does not return while the output
            # is unread.
            self._closed = True
            if self._proc.returncode is None:
                self._proc.kill()
            await self._proc.wait()
            await asyncio.gather(self._pump, return_exceptions=True)

    async def write(self, pcm: np.ndarray) -> None:
        """Encode `pcm` (float32 mono, 44.1 kHz). Waits for ffmpeg to take it, not for a reader.

        Raises BrokenPipeError if ffmpeg is no longer running.
        """
        stdin = self._open_stdin()
        data = np.asarray(pcm, dtype="<f4").tobytes()
        try:
            stdin.write(data)
            await stdin.drain()
        except (OSError, RuntimeError) as error:
            # Stock asyncio says ConnectionResetError or BrokenPipeError here, uvloop RuntimeError.
            raise BrokenPipeError("ffmpeg is no longer running") from error
        self.samples_written += len(pcm)

    async def read_chunks(self) -> AsyncIterator[bytes]:
        """The MP3 as ffmpeg produces it, until the stream ends (after `close`, or ffmpeg dying)."""
        while (chunk := await self._chunks.get()) is not None:
            yield chunk
        self._chunks.put_nowait(None)  # a later read ends too, instead of waiting for more for ever

    async def close(self) -> None:
        """No more audio: ffmpeg writes its last frames and exits, and the stream ends.

        Closing twice is fine. Raises RuntimeError if ffmpeg did not exit cleanly.
        """
        if self._closed:
            return
        stdin = self._open_stdin()
        proc, pump = self._proc, self._pump
        assert proc is not None and pump is not None
        self._closed = True
        try:
            stdin.close()
            await stdin.wait_closed()
        except ConnectionError:
            pass  # ffmpeg is already gone; its exit status is checked below
        await proc.wait()
        await pump
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg exited with status {proc.returncode}")

    def _open_stdin(self) -> asyncio.StreamWriter:
        if self._proc is None:
            raise RuntimeError("The encoder has not started: use `async with Mp3Encoder()`")
        if self._closed:
            raise RuntimeError("The encoder is closed")
        assert self._proc.stdin is not None  # a pipe
        return self._proc.stdin

    async def _pump_output(self, stdout: asyncio.StreamReader) -> None:
        """Move ffmpeg's output into the queue as it appears, until it ends."""
        try:
            while chunk := await stdout.read(_READ_BYTES):
                self._chunks.put_nowait(chunk)
        finally:
            self._chunks.put_nowait(None)
