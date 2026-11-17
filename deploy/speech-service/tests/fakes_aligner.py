"""Stand-ins for the aligner's tests: a FakeAligner, a fake `fusealign-cli` and a fake FuseAlign.

The real FuseAlign needs torch and the model weights, and the real CLI needs a built binary and a
GGUF model, so the unit tests run against these. `tests/test_aligner.py` has the one live test
that runs the real thing.
"""

import json
import shlex
import sys
import types
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from speech_service.aligner import ALIGN_SAMPLE_RATE, Interval


class FakeAligner:
    """An Aligner that spreads the audio's duration evenly over the words.

    Like every real backend it answers an empty word list with `[]`. With `fail`, any other call
    raises RuntimeError, as a backend does when it cannot time a sentence.
    """

    def __init__(self, fail: bool = False) -> None:
        self.fail = fail

    def align(self, audio_16k: np.ndarray, words: list[str]) -> list[Interval | None]:
        if not words:
            return []
        if self.fail:
            raise RuntimeError("the fake aligner was told to fail")
        step = len(audio_16k) / ALIGN_SAMPLE_RATE / len(words)
        return [(i * step, (i + 1) * step) for i in range(len(words))]


# The fake CLI's behaviour follows `ggml/src/cli.cpp` of fusealign-multilingual, batch mode:
# `-m MODEL [-d DEVICE] [-t N] --batch IN [-o OUT]`, one result row per input row, a failed row
# written as {"clip_id", "error"} with exit status 1, a usage error with status 2, and a summary
# line on stderr. Word `i` of a row's text comes back at `i * 0.25` for 0.125 s and is placed when
# `i` is even; an unplaced word is zero-width, as FuseAlign's fallback leaves one.
#
# What the fake saw goes to the log file (one JSON object per run), so a test can check the
# command line, the rows, the WAV and the directory the aligner used, after it has been deleted.
_FAKE_CLI_BODY = r'''
import array
import json
import os
import sys
import time
import wave


def record(call):
    with open(LOG, "a", encoding="utf-8") as log:
        log.write(json.dumps(call) + "\n")


def usage_error(message):
    sys.stderr.write("fusealign-cli: %s\n\nusage: fusealign-cli -m MODEL --batch IN\n" % message)
    sys.exit(2)


args = sys.argv[1:]
options = {}
i = 0
while i < len(args):
    if args[i] not in ("-m", "-d", "-t", "--batch", "-o"):
        usage_error("unknown argument " + args[i])
    if i + 1 >= len(args):
        usage_error("missing value for " + args[i])
    options[args[i]] = args[i + 1]
    i += 2
if "-m" not in options:
    usage_error("--model is required")
if "--batch" not in options:
    usage_error("give exactly one of --audio and --batch")

call = {
    "argv": args,
    "dir": os.path.dirname(options["--batch"]),
    "batch": options["--batch"],
    "out": options.get("-o"),
    "rows": [],
    "wavs": [],
    "pid": os.getpid(),
    "started": time.time(),
}


def finish(status):
    call["ended"] = time.time()
    record(call)
    sys.exit(status)


if MODE == "model_error":
    sys.stderr.write("fusealign-cli: cannot read GGUF file " + options["-m"] + "\n")
    finish(1)
if MODE == "hang":
    record(call)
    time.sleep(120)


def entry(index, word):
    placed = index % 2 == 0
    start = index * 0.25
    return {
        "word": word,
        "start": start,
        "end": start + (0.125 if placed else 0.0),
        "presence": 0.9 if placed else 0.0,
        "placed": placed,
    }


results = []
failed = 0
with open(options["--batch"], encoding="utf-8") as batch:
    for line in batch:
        if not line.strip():
            continue
        row = json.loads(line)
        call["rows"].append(row)
        result = {"clip_id": row.get("clip_id")}
        if MODE in ("error_row", "error_row_exit_0"):
            result["error"] = "cannot open " + row["audio"]
            failed += 1
        else:
            with wave.open(row["audio"], "rb") as wav:
                samples = array.array("h")
                samples.frombytes(wav.readframes(wav.getnframes()))
                call["wavs"].append({
                    "rate": wav.getframerate(),
                    "channels": wav.getnchannels(),
                    "width": wav.getsampwidth(),
                    "frames": wav.getnframes(),
                    "max": max(samples, default=0),
                    "min": min(samples, default=0),
                })
            words = [entry(index, word) for index, word in enumerate(row["text"].split())]
            if MODE == "short":
                words = words[:-1]
            if MODE == "null_time":
                words[0]["start"] = None
            if MODE == "nan_time":
                words[0]["start"] = float("nan")
            result["words"] = words
        results.append(result)

if MODE == "slow":
    time.sleep(0.3)
if MODE != "silent":
    out = open(options["-o"], "w", encoding="utf-8") if "-o" in options else sys.stdout
    if MODE == "garbage":
        out.write("this is not json\n")
    else:
        for result in results:
            out.write(json.dumps(result, ensure_ascii=False) + "\n")
    out.flush()
sys.stderr.write("fusealign-cli: %d rows (%d failed) in 0.0 s\n" % (len(results), failed))
finish(1 if failed and MODE != "error_row_exit_0" else 0)
'''


@dataclass
class FakeCli:
    """A fake `fusealign-cli` executable and the log of what it was run with."""

    path: str
    log: Path

    def calls(self) -> list[dict]:
        """One entry per run: argv, the paths it was given, its rows, the WAV facts of each, and the
        wall-clock times it started and ended (`ended` is missing for a run that never answered)."""
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]


def make_fake_cli(directory: Path, mode: str = "ok") -> FakeCli:
    """A fake `fusealign-cli` in `directory`. `mode` picks how it answers:

    - "ok": the documented output, one result row per input row
    - "slow": the same, after 0.3 s
    - "error_row": an {"clip_id", "error"} row and exit status 1
    - "error_row_exit_0": the same row with exit status 0 (the real CLI never does this)
    - "model_error": no output at all and exit status 1 (the model cannot be read)
    - "short": one word fewer than it was given
    - "null_time": a placed word whose start is null (what the CLI writes for a NaN)
    - "nan_time": a placed word whose start is the literal NaN (which the real CLI never writes)
    - "garbage": output that is not JSON
    - "silent": exit status 0 and no output file
    - "hang": never answers
    """
    script = directory / "fake_fusealign_cli.py"
    log = directory / "fake-fusealign-cli-calls.jsonl"
    script.write_text(f"MODE = {mode!r}\nLOG = {str(log)!r}\n{_FAKE_CLI_BODY}", encoding="utf-8")
    # A launcher, so the interpreter's path can hold spaces and exceed the shebang length limit.
    launcher = directory / "fusealign-cli"
    launcher.write_text(
        f'#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(script))} "$@"\n',
        encoding="utf-8",
    )
    launcher.chmod(0o755)
    return FakeCli(str(launcher), log)


@dataclass
class FakeFuseAlign:
    """What the fake `torch` and `fusealign_hub` modules were asked, and how they answer.

    `unplaced` holds the indices of the words the model leaves unplaced, `error` is what `align`
    raises when it is set, and `missing` is how many entries the answer comes up short.
    """

    threads: list[int] = field(default_factory=list)
    loads: list[dict] = field(default_factory=list)
    aligns: list[dict] = field(default_factory=list)
    unplaced: frozenset[int] = frozenset()
    error: Exception | None = None
    missing: int = 0


def install_fake_fusealign(monkeypatch: pytest.MonkeyPatch) -> FakeFuseAlign:
    """Put fake `torch` and `fusealign_hub` modules where `import` finds them, for one test.

    The fakes have exactly the parts of the real API that `PythonFuseAligner` uses
    (`torch.set_num_threads`, `torch.from_numpy`, `fusealign_hub.load_aligner(...).align(...)`),
    with the real signatures.
    """
    seen = FakeFuseAlign()

    torch = types.ModuleType("torch")
    torch.set_num_threads = seen.threads.append  # type: ignore[attr-defined]
    torch.from_numpy = lambda array: SimpleNamespace(array=array)  # type: ignore[attr-defined]

    class Model:
        def align(self, waveform, sample_rate, transcript, asr_words=None, language=None):
            seen.aligns.append(
                {
                    "audio": waveform.array,
                    "sample_rate": sample_rate,
                    "transcript": transcript,
                    "asr_words": asr_words,
                    "language": language,
                }
            )
            if seen.error is not None:
                raise seen.error
            result = []
            for index, word in enumerate(transcript):
                placed = index not in seen.unplaced
                start = index * 0.25
                result.append(
                    SimpleNamespace(
                        word=word,
                        start=start,
                        end=start + (0.125 if placed else 0.0),
                        presence=0.9 if placed else 0.0,
                        placed=placed,
                    )
                )
            return result[: len(result) - seen.missing]

    def load_aligner(checkpoint=None, device=None, compile_model=False, batch_size=64):
        seen.loads.append(
            {
                "checkpoint": checkpoint,
                "device": device,
                "compile_model": compile_model,
                "batch_size": batch_size,
            }
        )
        return Model()

    hub = types.ModuleType("fusealign_hub")
    hub.load_aligner = load_aligner  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "fusealign_hub", hub)
    return seen
