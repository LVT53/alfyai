"""Word timing: when each spoken word of a sentence is said, and so when each written token is.

An `Aligner` finds the spoken words (`text.Spoken.words`, exactly what Zonos was sent) in the
sentence's audio, and `token_times` hands each written token the time of the words it became, so
the reader can follow the voice on the written text. FuseAlign, a forced aligner, does the finding:
in this process (`PythonFuseAligner`, the Mac's choice), through its native `fusealign-cli`
(`NativeFuseAligner`, the GPU box's), or not at all (`NoAligner`).

A backend raises when it cannot time a sentence, and the caller goes on without word times, whatever
it raised. A backend's own failures are RuntimeErrors whose message never quotes the words (the
service logs no reply text); an error of the disk under the native backend's files comes out as the
OSError it is.
"""

from __future__ import annotations

import json
import logging
import math
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Protocol, assert_never

import numpy as np
import soundfile as sf

from speech_service.config import Settings
from speech_service.text import Spoken

logger = logging.getLogger(__name__)

# FuseAlign wants mono audio at 16 kHz.
ALIGN_SAMPLE_RATE = 16_000

# Seconds from the start of a sentence's audio to the start and to the end of a word.
Interval = tuple[float, float]

# How long one `fusealign-cli` run may take. A sentence is at most 400 characters and a short one
# takes the CLI 0.2 to 0.5 s on the box, so a run that takes 30 s is stuck, and is killed.
_CLI_TIMEOUT_SECONDS = 30.0


class Aligner(Protocol):
    """Finds the spoken words of one sentence in its audio."""

    def align(self, audio_16k: np.ndarray, words: list[str]) -> list[Interval | None]:
        """The `(start, end)` of each of `words` in the audio, or None for a word it did not place.

        `audio_16k` is the sentence's audio as `resample_16k` makes it (mono, float32, samples in
        [-1, 1]), and `words` are `Spoken.words`. The answer has one entry per word, and `[]` for no
        words, which no model is run for.

        Raises when the sentence cannot be timed at all. Any exception may come out: a backend's own
        failures are RuntimeErrors (whose message never quotes the words), the native backend lets
        an error of the disk (an OSError) through, and the caller, a session, treats every one of
        them as no word times for that sentence.
        """
        ...


def resample_16k(audio: np.ndarray, sr: int) -> np.ndarray:
    """`audio` (mono, sampled at `sr`) at 16 kHz as float32, which is what `Aligner.align` takes.

    The samples must be floats in [-1, 1], as `sf.read(..., dtype="float32")` gives them: whole
    numbers (`dtype="int16"`) would pass through unscaled, a thousand times too loud, so any other
    dtype is a ValueError.

    Band-limited, with numpy alone: the clip's spectrum is cut at 8 kHz (the new Nyquist
    frequency: the bins below it are kept, the rest dropped) and transformed back at the new
    length, so nothing above 8 kHz can alias into the speech. The result has `round(n * 16000 / sr)`
    samples for `n` in; at 16 kHz the audio comes back as it is.
    """
    if sr <= 0:
        raise ValueError(f"sample rate must be positive, got {sr}")
    if audio.ndim != 1:
        raise ValueError(f"expected mono audio (one dimension), got shape {audio.shape}")
    if not np.issubdtype(audio.dtype, np.floating):
        raise ValueError(f"expected float samples in [-1, 1], got dtype {audio.dtype}")
    if sr == ALIGN_SAMPLE_RATE:
        return np.asarray(audio, dtype=np.float32)
    n = len(audio)
    m = round(n * ALIGN_SAMPLE_RATE / sr)
    if m == 0:
        return np.zeros(0, dtype=np.float32)
    # float64 whatever comes in: numpy 2 transforms float32 in single precision, 1.x did not.
    spectrum = np.fft.rfft(np.asarray(audio, dtype=np.float64))
    # Bin k holds the same frequency before and after (k * sr / n and k * 16000 / m differ by
    # rounding only). `irfft` pads what is missing with zeros, so upsampling needs no step of its
    # own. The new Nyquist bin, if m is even, is left out: it is not below 8 kHz.
    kept = spectrum[: min(len(spectrum), (m + 1) // 2)]
    # `rfft` does not scale and `irfft` divides by its length: m / n keeps the loudness.
    return (np.fft.irfft(kept, m) * (m / n)).astype(np.float32)


class PythonFuseAligner:
    """FuseAlign in this process on torch: the Mac's choice (the `aligner-python` extra).

    Loading takes a few seconds, and the process peaked at about 3.5 GiB resident on the Mac: far
    over the service's budget, which is why the box runs the native backend. One clip goes through
    a forward at a time. A sentence over 30 s (or a transcript over 1022 UTF-8 bytes) takes
    FuseAlign's long-form path, which would load Whisper large-v3 to find approximate word times
    unless it is given some: it is given none, so it finds them with voice-activity detection, as
    `fusealign-cli` does.

    Calls are not serialized, unlike the native backend's (which are, for memory): the model is
    only read, and eight calls on four threads gave the answers of one.
    """

    def __init__(
        self, device: str = "cpu", threads: int | None = None, checkpoint: str | None = None
    ) -> None:
        # Imported here: only this backend needs them, and the unit tests have neither.
        import torch
        from fusealign_hub import load_aligner

        self._model = load_aligner(checkpoint=checkpoint, device=device, batch_size=1)
        if threads is not None:
            torch.set_num_threads(threads)
        self._to_tensor = torch.from_numpy

    def align(self, audio_16k: np.ndarray, words: list[str]) -> list[Interval | None]:
        if not words:
            return []
        waveform = self._to_tensor(np.ascontiguousarray(audio_16k, dtype=np.float32))
        try:
            # The list of words, not a string: one result per word, whatever the words hold.
            aligned = self._model.align(waveform, ALIGN_SAMPLE_RATE, words, asr_words=[])
        except Exception as error:
            # The type only: the original may quote the words, and the chain would print it.
            raise RuntimeError(f"FuseAlign failed ({type(error).__name__})") from None
        if len(aligned) != len(words):
            raise RuntimeError(f"FuseAlign timed {len(aligned)} words, expected {len(words)}")
        return [(word.start, word.end) if word.placed else None for word in aligned]


class NativeFuseAligner:
    """FuseAlign's native `fusealign-cli`, one run per sentence: the GPU box's choice.

    The CLI reads its audio from a file, so a call writes the sentence's 16 kHz WAV and its
    one-line JSONL into a `TemporaryDirectory`, runs the CLI on them and deletes both when it
    ends, success or failure. That is the service's one write to disk: the sentence's words and
    voice stay there for the length of one call, and nothing else reads them.

    Never reads or logs what the CLI prints: its answer is the output file, and a failure is a
    RuntimeError with its exit status. A CLI that cannot be run at all is a RuntimeError too; an
    error of the disk under its files (a full disk) is the OSError itself, with no text in it
    beyond the name of a path in the temporary directory.
    """

    # One CLI at a time, whichever aligner runs it: measured on the box, a clip of 32 to 38 s
    # peaks at 813 to 890 MiB in the CLI, and the service's systemd limit will be 2 GiB
    # (MemoryMax=2G), which two at once would reach. A short sentence takes 0.2 to 0.5 s, so waiting
    # costs next to nothing. The slot is also held while the files exist, so at most one sentence
    # is on disk at a time.
    _slot = threading.Lock()

    def __init__(self, cli: str, model: str, threads: int) -> None:
        self._cli = cli
        self._model = model
        self._threads = threads

    def align(self, audio_16k: np.ndarray, words: list[str]) -> list[Interval | None]:
        if not words:
            return []
        with self._slot, tempfile.TemporaryDirectory(prefix="fusealign-") as directory:
            work = Path(directory)
            wav, batch, out = work / "clip.wav", work / "in.jsonl", work / "out.jsonl"
            sf.write(wav, audio_16k, ALIGN_SAMPLE_RATE, subtype="PCM_16")
            # The words never hold whitespace, so "text" gives one result per word.
            row = {"clip_id": "s1", "audio": str(wav), "text": " ".join(words)}
            batch.write_text(json.dumps(row) + "\n", encoding="utf-8")
            self._run(batch, out)
            return _read_times(out, len(words))

    def _run(self, batch: Path, out: Path) -> None:
        """Run the CLI on the one-row `batch`, which writes its answer to `out`."""
        command = [
            self._cli,
            *("-m", self._model),
            # Always on the CPU, and on `threads` of it: without "-t" the CLI takes every core.
            *("-d", "cpu"),
            *("-t", str(self._threads)),
            *("--batch", str(batch)),
            *("-o", str(out)),
        ]
        try:
            done = subprocess.run(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=_CLI_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired:  # `run` has killed the CLI by now
            raise RuntimeError(
                f"fusealign-cli did not finish within {_CLI_TIMEOUT_SECONDS:g} s"
            ) from None
        except OSError as error:
            # A CLI that is missing or cannot be run: no text in what is raised. Only this call is
            # blamed on the CLI; an error of the disk under the files is raised as it is.
            raise RuntimeError(f"fusealign-cli could not be run ({type(error).__name__})") from None
        if done.returncode != 0:  # a row that failed is a status of 1
            raise RuntimeError(f"fusealign-cli exited with status {done.returncode}")


def _read_times(path: Path, count: int) -> list[Interval | None]:
    """The `count` word times in the CLI's output file. RuntimeError if it is not what it documents.

    The file holds one row, `{"clip_id", "words": [{"word", "start", "end", "presence",
    "placed"}, ...]}`, or `{"clip_id", "error"}` when the row failed. The times are seconds from
    the start of the file.
    """
    try:
        text = path.read_text(encoding="utf-8")
        rows = [json.loads(line) for line in text.splitlines() if line.strip()]
    except (OSError, ValueError):  # no file, not UTF-8, not JSON
        raise RuntimeError("fusealign-cli wrote no readable result") from None
    if len(rows) != 1 or not isinstance(rows[0], dict):
        raise RuntimeError("fusealign-cli wrote no readable result")
    if "error" in rows[0]:
        raise RuntimeError("fusealign-cli reported an error for the sentence")
    entries = rows[0].get("words")
    if not isinstance(entries, list):
        raise RuntimeError("fusealign-cli wrote no readable result")
    if len(entries) != count:
        raise RuntimeError(f"fusealign-cli timed {len(entries)} words, expected {count}")
    try:
        return [_interval(entry) for entry in entries]
    except (KeyError, TypeError, ValueError):
        raise RuntimeError("fusealign-cli wrote a malformed word entry") from None


def _interval(entry: dict) -> Interval | None:
    """The `(start, end)` of an output word, or None if the CLI did not place it.

    An unplaced word has a made-up interval, which is not worth passing on.
    """
    if not entry["placed"]:
        return None
    start, end = float(entry["start"]), float(entry["end"])
    if not (math.isfinite(start) and math.isfinite(end)):
        raise ValueError("a word time is not a finite number")
    return (start, end)


class NoAligner:
    """Places no word: the service then sends no word times."""

    def align(self, audio_16k: np.ndarray, words: list[str]) -> list[Interval | None]:
        return [None] * len(words)


def make_aligner(settings: Settings) -> Aligner:
    """The backend `settings.aligner` names, set up. The Python one loads FuseAlign now (a few
    seconds).

    Word times are an extra, so a backend that cannot be set up here does not stop the service: this
    answers with `NoAligner` instead, readings carry sentence marks only and `/health` says
    `aligner: false`. That is ONE error line in the log, naming the backend and what is missing, or
    the type of what went wrong, and never an exception's message. A backend cannot be set up when
    the native CLI is not a command or file that runs, or its model is not set or not a file, or
    when the Python backend's libraries do not import or its model does not load.
    """
    try:
        return _set_up(settings)
    except _Missing as missing:
        why = str(missing)
    except Exception as error:  # an import, a checkpoint: whatever the backend's own set-up raised
        why = _kind_of(error)
    logger.error(
        "the %s aligner cannot be set up (%s): readings will carry sentence marks only, "
        "without word times",
        settings.aligner,
        why,
    )
    return NoAligner()


class _Missing(Exception):
    """What the configured backend needs and cannot find: a setting, a file, a command. The message
    names the setting and the path, which are the operator's own words and no reply's."""


def _set_up(settings: Settings) -> Aligner:
    match settings.aligner:
        case "python":
            return PythonFuseAligner(
                device="cpu", threads=settings.aligner_threads, checkpoint=settings.aligner_model
            )
        case "native":
            return _set_up_native(settings)
        case "none":
            return NoAligner()
        case _:
            assert_never(settings.aligner)


def _set_up_native(settings: Settings) -> NativeFuseAligner:
    """The native backend, once its CLI is a command or file that runs (`which` takes an absolute
    path as it is, and a bare name from PATH, as `subprocess` does) and its model is a file. Raises
    `_Missing`, naming every one of the two that is not."""
    cli, model = settings.aligner_cli, settings.aligner_model
    missing = []
    if shutil.which(cli) is None:
        missing.append(f"SPEECH_ALIGNER_CLI {cli!r} is not an executable file or a command on PATH")
    if not model:
        missing.append("SPEECH_ALIGNER_MODEL is not set")
    elif not Path(model).is_file():
        missing.append(f"SPEECH_ALIGNER_MODEL {model!r} is not a file")
    if missing or not model:  # `not model` is in `missing` too: it is here for the type checker
        raise _Missing("; ".join(missing))
    return NativeFuseAligner(cli, model, settings.aligner_threads)


def _kind_of(error: Exception) -> str:
    """What to log of a backend's own failure to set up: the type of the exception, and the module
    a failed import was after. Never its message."""
    if isinstance(error, ImportError) and error.name:
        return f"{type(error).__name__}: {error.name}"
    return type(error).__name__


def token_times(spoken: Spoken, word_times: list[Interval | None]) -> list[Interval | None]:
    """The time of each written token, from the times of the spoken words (one per word).

    A token is said from the start of the first of its words that was placed to the end of the last
    one, and not at all (None) when it speaks as nothing or none of its words was placed. Words a
    token does not own (ones the normalizer added) take no part. `word_times` come from an
    `Aligner` run on `spoken.words`; a different count is a ValueError.
    """
    if len(word_times) != len(spoken.words):
        raise ValueError(f"{len(word_times)} word times for {len(spoken.words)} words")
    ordered = _starts_never_go_back(word_times)
    times: list[Interval | None] = []
    for span in spoken.token_spans:
        placed = [] if span is None else [t for t in ordered[span[0] : span[1]] if t is not None]
        times.append((placed[0][0], placed[-1][1]) if placed else None)
    return times


def _starts_never_go_back(word_times: list[Interval | None]) -> list[Interval | None]:
    """`word_times` where no placed word starts before the placed word ahead of it.

    A safety net: FuseAlign does not repair the order of its words, and a reader that follows the
    voice must not jump back. A word that starts too early takes the start of the one before, and
    ends no earlier than it starts. Words that were not placed are left as they are and do not
    count.
    """
    fixed: list[Interval | None] = []
    latest_start = -math.inf
    for interval in word_times:
        if interval is None:
            fixed.append(None)
            continue
        start = max(interval[0], latest_start)
        fixed.append((start, max(interval[1], start)))
        latest_start = start
    return fixed
