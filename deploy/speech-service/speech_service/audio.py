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
# A clip whose loudest frame is under this has no speech at all, however it compares with itself:
# it is the hiss of a model that said nothing, and the rule above would turn it up to speech level.
_SILENCE_FLOOR_DB = -60.0
_SILENCE_FLOOR_RMS = 10 ** (_SILENCE_FLOOR_DB / 20)


def _hop(sr: int) -> int:
    """The samples in one 20 ms frame."""
    return max(1, round(_FRAME_SECONDS * sr))


def _frame_energy(x: np.ndarray, hop: int) -> tuple[np.ndarray, np.ndarray]:
    """Each `hop`-sample frame of `x` (the last may be shorter): its sum of squares and its size."""
    starts = np.arange(0, len(x), hop)
    return np.add.reduceat(np.square(x, dtype=np.float64), starts), np.minimum(hop, len(x) - starts)


def _speech_frames(energy: np.ndarray, sizes: np.ndarray) -> np.ndarray:
    """Which frames are speech: none, when the clip is empty, silent or too quiet to be speech."""
    rms = np.sqrt(energy / sizes)
    if not rms.size or rms.max() < _SILENCE_FLOOR_RMS:
        return np.zeros(rms.shape, dtype=bool)
    return rms > rms.max() * _SPEECH_FRACTION


def match_loudness(
    x: np.ndarray, sr: int, target_db: float = -20.0, peak_db: float = -1.0
) -> np.ndarray:
    """`x` with one gain applied: the speech frames' RMS lands on `target_db` (dBFS).

    If that would put a peak above `peak_db`, the gain is lowered until the peak is exactly there.
    A silent clip, one with nothing louder than -60 dBFS (RMS of a 20 ms frame) included, comes
    back as it is. The result is a new array.
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

    A silent clip, one with nothing louder than -60 dBFS (RMS of a 20 ms frame) included, gives an
    empty array. The result is a new array.
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


# A silence inside a clip is a run of 20 ms frames more than 40 dB under the clip's 90th-percentile
# frame level, between its first and its last speech. The same rule sets the limits in steady.py and
# the knob sweep's gaps, so the three read a clip alike (a test holds the first and the last equal).
_QUIET_BELOW_P90_DB = 40.0


def inner_silences(x: np.ndarray, sr: int) -> list[tuple[int, int]]:
    """The silences inside `x` as `(start, end)` sample positions, in order. Silence before the first
    speech and after the last is not inside it. A clip too short or too silent to measure has none."""
    hop = _hop(sr)
    count = len(x) // hop
    if count < 3:
        return []
    frames = x[: count * hop].astype(np.float64).reshape(count, hop)
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    level = 20.0 * np.log10(np.maximum(rms, 1e-9))
    quiet = level < np.percentile(level, 90) - _QUIET_BELOW_P90_DB
    speech = np.flatnonzero(~quiet)
    if speech.size == 0:
        return []
    inner = quiet[speech[0] : speech[-1] + 1]
    padded = np.concatenate(([False], inner, [False]))
    edges = np.flatnonzero(padded[1:] != padded[:-1])
    first = int(speech[0])
    return [
        ((first + int(a)) * hop, (first + int(b)) * hop) for a, b in zip(edges[0::2], edges[1::2])
    ]


# The faint hiss of the room in a pause is cut and joined over this long, so the join does not click.
_JOIN_FADE_SECONDS = 0.005


def lengthen_pauses(
    x: np.ndarray,
    sr: int,
    extra_seconds: float,
    shortest_seconds: float = 0.12,
    longest_seconds: float = 0.8,
) -> np.ndarray:
    """`x` with each silence inside it that is `shortest_seconds` to `longest_seconds` long made
    `extra_seconds` longer: the breath a reader takes at a comma, which Zonos takes for a tenth of a
    second or two. Shorter silences are the closing of a consonant, and longer ones a stall, which
    steady.py makes again rather than stretches. The speech is not touched; silence is added at the
    middle of the pause, with a few milliseconds of fade either side. The result is a new array."""
    if extra_seconds <= 0:
        return x.copy()
    pauses = [
        (a, b)
        for a, b in inner_silences(x, sr)
        if shortest_seconds <= (b - a) / sr <= longest_seconds
    ]
    if not pauses:
        return x.copy()
    cuts = [(a + b) // 2 for a, b in pauses]
    fade = round(_JOIN_FADE_SECONDS * sr)
    extra = np.zeros(round(extra_seconds * sr), dtype=x.dtype)
    pieces: list[np.ndarray] = []
    for i, start in enumerate([0, *cuts]):
        end = cuts[i] if i < len(cuts) else len(x)
        piece = x[start:end].copy()
        if i > 0:  # follows an added silence: fade in
            n = min(fade, len(piece))
            piece[:n] *= np.linspace(0.0, 1.0, n, dtype=x.dtype)
        if i < len(cuts):  # is followed by one: fade out
            n = min(fade, len(piece))
            if n:
                piece[-n:] *= np.linspace(1.0, 0.0, n, dtype=x.dtype)
        pieces.append(piece)
        if i < len(cuts):
            pieces.append(extra)
    return np.concatenate(pieces)


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
# `-probesize 32 -analyzeduration 0` stop it reading ahead before it encodes: the box's ffmpeg 7.1.5
# otherwise holds every byte of MP3 until about 5 s of input have arrived (measured: first audio
# 4.4 s after the request instead of half a second). Homebrew's ffmpeg 9 streams either way, so the
# Mac's tests cannot catch their absence; `test_the_encoder_never_reads_ahead` pins them.
_FFMPEG_ENCODE = (
    "ffmpeg", "-hide_banner", "-loglevel", "error",
    "-probesize", "32", "-analyzeduration", "0",
    "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "-",
    "-c:a", "libmp3lame", "-b:a", "128k", "-flush_packets", "1", "-f", "mp3", "-",
)
_FFMPEG_DECODE = (
    "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "-",
    "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-",
)
_CLICK_SECONDS = 0.5
_READ_BYTES = 65536
# What ffmpeg says on stderr (at -loglevel error: codec and format errors, never the words being
# spoken) ends up in the error that says why it did not finish, as its last 200 characters. A UTF-8
# character is at most 4 bytes, so 4 times that many bytes of it are always enough to keep.
_STDERR_TAIL_CHARS = 200
_STDERR_KEEP_BYTES = 4 * _STDERR_TAIL_CHARS


def _ffmpeg_failure(returncode: int | None, stderr: bytes) -> str:
    """The error for an ffmpeg that did not exit cleanly: its status, and the end of what it said
    (its last lines on one line, at most `_STDERR_TAIL_CHARS` characters of them)."""
    lines = (line.strip() for line in stderr.decode(errors="replace").splitlines())
    said = " | ".join(line for line in lines if line)[-_STDERR_TAIL_CHARS:]
    status = f"ffmpeg exited with status {returncode}"
    return f"{status}: {said}" if said else status


async def _read_tail(stream: asyncio.StreamReader) -> bytes:
    """Read `stream` to its end and keep the last `_STDERR_KEEP_BYTES` bytes of it. Reading it at
    all is what keeps ffmpeg from blocking on a full pipe."""
    tail = b""
    while chunk := await stream.read(_READ_BYTES):
        tail = (tail + chunk)[-_STDERR_KEEP_BYTES:]
    return tail


async def _run_ffmpeg(command: tuple[str, ...], data: bytes) -> bytes:
    """What `command` writes to stdout when `data` is its stdin."""
    proc = await asyncio.create_subprocess_exec(
        *command,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        # Reads stdout and stderr together, so neither can fill up and block ffmpeg.
        out, err = await proc.communicate(data)
    except BaseException:
        if proc.returncode is None:
            proc.kill()
        raise
    if proc.returncode != 0:
        raise RuntimeError(_ffmpeg_failure(proc.returncode, err[-_STDERR_KEEP_BYTES:]))
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
        self._stderr: asyncio.Task[bytes] | None = None  # the end of what ffmpeg says
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
            stderr=asyncio.subprocess.PIPE,
        )
        assert proc.stdout is not None and proc.stderr is not None  # pipes
        self._proc = proc
        self._pump = asyncio.create_task(self._pump_output(proc.stdout))
        self._stderr = asyncio.create_task(_read_tail(proc.stderr))
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
            await asyncio.gather(self._pump, self._stderr, return_exceptions=True)

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
        proc, pump, stderr = self._proc, self._pump, self._stderr
        assert proc is not None and pump is not None and stderr is not None
        self._closed = True
        try:
            stdin.close()
            await stdin.wait_closed()
        except ConnectionError:
            pass  # ffmpeg is already gone; its exit status is checked below
        await proc.wait()
        await pump
        said = await stderr
        if proc.returncode != 0:
            raise RuntimeError(_ffmpeg_failure(proc.returncode, said))

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
