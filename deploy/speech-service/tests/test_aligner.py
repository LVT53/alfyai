"""Aligner: word times for the spoken words, mapped back to the written tokens a reader sees."""

import errno
import os
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from speech_service import aligner as aligner_module
from speech_service.aligner import (
    ALIGN_SAMPLE_RATE,
    NativeFuseAligner,
    NoAligner,
    PythonFuseAligner,
    make_aligner,
    resample_16k,
    token_times,
)
from speech_service.config import Settings
from speech_service.text import Spoken, normalize

# Not `tests.fakes_aligner`: the zonos3 Python that runs the live test below has a package named
# `tests` in its site-packages, and a package with an __init__.py beats this directory. pytest puts
# this directory on sys.path, so the module is found by its own name under either Python.
from fakes_aligner import FakeAligner, install_fake_fusealign, make_fake_cli

MODEL = "/models/fusealign.gguf"
WORDS = ["Szia,", "világ", "kettő."]


def sine(
    freq: float, sr: int, seconds: float = 1.0, amp: float = 0.5, phase: float = 0.0
) -> np.ndarray:
    """A sine of peak `amp` at `freq` Hz (a cosine at phase pi / 2): float32, mono, at `sr`."""
    t = np.arange(round(sr * seconds)) / sr
    return (amp * np.sin(2 * np.pi * freq * t + phase)).astype(np.float32)


def peak_hz(x: np.ndarray, sr: int) -> float:
    """The frequency of the strongest FFT bin of `x`."""
    return float(np.argmax(np.abs(np.fft.rfft(x))) * sr / len(x))


@pytest.fixture
def scratch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The directory the native aligner's temporary files go in. Nothing may stay in it."""
    path = tmp_path / "scratch"
    path.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(path))
    return path


# token_times: spoken-word times become written-token times.


def test_token_times_cover_blocks():
    sp = Spoken(
        words=["tizenkétezer-kilencszázkilencven", "forint"], token_spans=[(0, 2), (0, 2), (0, 2)]
    )
    assert token_times(sp, [(1.0, 2.0), (2.0, 2.5)]) == [(1.0, 2.5)] * 3


def test_unspeakable_tokens_get_null_times():
    sp = Spoken(words=["nézd", "itt"], token_spans=[(0, 1), None, (1, 2)])
    assert token_times(sp, [(0.0, 0.4), (0.5, 0.9)])[1] is None


def test_unplaced_words_give_null():
    sp = Spoken(words=["a", "b"], token_spans=[(0, 1), (1, 2)])
    assert token_times(sp, [(0.0, 0.2), None]) == [(0.0, 0.2), None]


def test_a_block_runs_from_its_first_placed_word_to_its_last():
    sp = Spoken(words=["a", "b", "c", "d"], token_spans=[(0, 4)])
    assert token_times(sp, [None, (1.0, 1.5), (1.6, 2.0), None]) == [(1.0, 2.0)]


def test_a_block_with_no_placed_word_gives_null():
    sp = Spoken(words=["a", "b"], token_spans=[(0, 2)])
    assert token_times(sp, [None, None]) == [None]


def test_words_no_token_owns_do_not_stretch_a_token():
    # The normalizer added the middle word; no token owns it.
    sp = Spoken(words=["két", "és", "tojás"], token_spans=[(0, 1), (2, 3)])
    assert token_times(sp, [(0.0, 0.3), (0.3, 0.5), (0.5, 0.9)]) == [(0.0, 0.3), (0.5, 0.9)]


def test_no_tokens_no_times():
    assert token_times(Spoken(words=[], token_spans=[]), []) == []


def test_a_word_time_count_that_differs_from_the_words_is_refused():
    sp = Spoken(words=["a", "b"], token_spans=[(0, 1), (1, 2)])
    with pytest.raises(ValueError):
        token_times(sp, [(0.0, 0.2)])


def test_word_starts_never_go_backwards():
    sp = Spoken(words=list("abcd"), token_spans=[(0, 1), (1, 2), (2, 3), (3, 4)])
    # "c" is timed before "b" starts: it takes b's start, and its end is not before its start.
    out_of_order = [(1.0, 1.4), (2.0, 2.4), (1.5, 1.7), (2.6, 3.0)]
    assert token_times(sp, out_of_order) == [(1.0, 1.4), (2.0, 2.4), (2.0, 2.0), (2.6, 3.0)]


def test_an_unplaced_word_does_not_reset_the_floor_for_starts():
    sp = Spoken(words=list("abc"), token_spans=[(0, 1), (1, 2), (2, 3)])
    assert token_times(sp, [(2.0, 2.4), None, (1.0, 3.5)]) == [(2.0, 2.4), None, (2.0, 3.5)]


def test_a_block_after_an_out_of_order_word_starts_where_the_floor_is():
    # "b" and "c" are one block. Their own starts are before "a" starts; the block does not start
    # before "a" does, and it ends where its last word ends.
    sp = Spoken(words=list("abc"), token_spans=[(0, 1), (1, 3)])
    assert token_times(sp, [(2.0, 2.5), (1.0, 1.2), (1.1, 3.0)]) == [(2.0, 2.5), (2.0, 3.0)]


def test_a_spoken_sentence_with_a_symbol_gets_one_time_per_token():
    tokens = ["Nézd", "→", "itt", "2", "tojás."]
    spoken = normalize(tokens, "hu")
    times = token_times(spoken, FakeAligner().align(np.zeros(3 * 16000, np.float32), spoken.words))
    assert len(times) == len(tokens)
    assert times[1] is None
    assert None not in times[:1] + times[2:]
    starts = [t[0] for t in times if t is not None]
    assert starts == sorted(starts)


# resample_16k: numpy only, band-limited, float32 out.


def test_resample_keeps_the_length_ratio_and_the_frequency():
    x = sine(1000, 44100)
    y = resample_16k(x, 44100)
    assert y.dtype == np.float32
    assert len(y) == round(len(x) * 16000 / 44100)
    assert peak_hz(y, ALIGN_SAMPLE_RATE) == pytest.approx(1000, abs=1.0)
    assert np.max(np.abs(y)) == pytest.approx(0.5, abs=1e-3)


@pytest.mark.parametrize(
    ("sr", "n"),
    [(44100, 44100), (44100, 31337), (48000, 48001), (22050, 10001), (8000, 12345), (24000, 7)],
)
def test_resample_length_is_the_rounded_ratio(sr, n):
    y = resample_16k(np.zeros(n, dtype=np.float32), sr)
    assert len(y) == round(n * 16000 / sr)
    assert y.dtype == np.float32


@pytest.mark.parametrize(
    ("freq", "phase", "amplitude"),
    [(7900, 0.0, 0.5), (8000, np.pi / 2, 0.0), (10_000, 0.0, 0.0)],
    ids=["below", "at", "above"],
)
def test_resample_keeps_what_is_below_8_khz_and_drops_what_is_above(freq, phase, amplitude):
    # A 10 kHz tone has no place at 16 kHz: plain decimation would alias it to 6 kHz. 8 kHz is
    # not below 8 kHz either (a cosine, because a sine's bin there is all imaginary).
    y = resample_16k(sine(freq, 44100, phase=phase), 44100)
    assert np.max(np.abs(y)) == pytest.approx(amplitude, abs=1e-3)
    if amplitude:
        assert peak_hz(y, ALIGN_SAMPLE_RATE) == pytest.approx(freq, abs=1.0)


def test_resample_upsamples_too():
    y = resample_16k(sine(1000, 8000), 8000)
    assert len(y) == 16000
    assert peak_hz(y, ALIGN_SAMPLE_RATE) == pytest.approx(1000, abs=1.0)
    assert np.max(np.abs(y)) == pytest.approx(0.5, abs=1e-3)


def test_resample_at_16_khz_changes_nothing_but_the_type():
    x = sine(1000, 16000)
    assert np.array_equal(resample_16k(x, 16000), x)
    y = resample_16k(x.astype(np.float64), 16000)
    assert y.dtype == np.float32
    assert np.array_equal(y, x)


def test_resample_of_nothing_is_nothing():
    for samples in (0, 1):  # one sample at 44.1 kHz is less than one at 16 kHz
        y = resample_16k(np.zeros(samples, dtype=np.float32), 44100)
        assert y.shape == (0,)
        assert y.dtype == np.float32


def test_resample_refuses_what_is_not_mono_audio_at_a_rate():
    with pytest.raises(ValueError):
        resample_16k(np.zeros((10, 2), dtype=np.float32), 44100)
    with pytest.raises(ValueError):
        resample_16k(np.zeros(10, dtype=np.float32), 0)


@pytest.mark.parametrize("dtype", [np.int16, np.int32, np.uint8, np.bool_, np.complex64])
@pytest.mark.parametrize("sr", [44100, 16000], ids=["resampled", "already-16-khz"])
def test_resample_refuses_samples_that_are_not_floats(dtype, sr):
    # `sf.read(dtype="int16")` gives whole numbers up to 32767, not floats in [-1, 1]: passed on
    # unscaled they would reach the aligner as a clip a thousand times too loud.
    with pytest.raises(ValueError, match="float"):
        resample_16k(np.zeros(100, dtype=dtype), sr)


@pytest.mark.parametrize("dtype", [np.float16, np.float32, np.float64])
def test_resample_takes_floats_of_any_width(dtype):
    y = resample_16k(sine(1000, 44100).astype(dtype), 44100)
    assert y.dtype == np.float32
    assert np.max(np.abs(y)) == pytest.approx(0.5, abs=1e-2)


# NoAligner and FakeAligner.


def test_no_aligner_places_nothing():
    assert NoAligner().align(np.zeros(16000, np.float32), ["a", "b", "c"]) == [None] * 3


def test_the_fake_spreads_the_duration_evenly():
    times = FakeAligner().align(np.zeros(2 * 16000, np.float32), ["a", "b", "c", "d"])
    assert times == [(0.0, 0.5), (0.5, 1.0), (1.0, 1.5), (1.5, 2.0)]


def test_the_fake_can_fail():
    with pytest.raises(RuntimeError):
        FakeAligner(fail=True).align(np.zeros(16000, np.float32), ["a"])


# NativeFuseAligner against a fake `fusealign-cli`.


def test_native_aligner_times_each_word_and_leaves_unplaced_ones_null(tmp_path, scratch):
    cli = make_fake_cli(tmp_path)
    times = NativeFuseAligner(cli.path, MODEL, 3).align(sine(220, 16000, seconds=2), WORDS)
    assert times == [(0.0, 0.125), None, (0.5, 0.625)]


def test_native_aligner_runs_the_cli_the_way_the_box_measured_it(tmp_path, scratch):
    cli = make_fake_cli(tmp_path)
    audio = sine(220, 16000, seconds=2)
    NativeFuseAligner(cli.path, MODEL, 3).align(audio, WORDS)
    [call] = cli.calls()
    batch, out = Path(call["batch"]), Path(call["out"])
    assert call["argv"] == [
        *["-m", MODEL, "-d", "cpu", "-t", "3"],
        *["--batch", str(batch), "-o", str(out)],
    ]
    # One temporary directory, inside the system's, holding the JSONL and the WAV; gone again.
    assert batch.parent == out.parent
    assert batch.parent.parent == scratch
    assert not batch.parent.exists()
    [row] = call["rows"]
    assert sorted(row) == ["audio", "clip_id", "text"]
    assert Path(row["audio"]).parent == batch.parent
    assert row["text"] == "Szia, világ kettő."
    [wav] = call["wavs"]
    assert {k: wav[k] for k in ("rate", "channels", "width", "frames")} == {
        "rate": 16000,
        "channels": 1,
        "width": 2,
        "frames": len(audio),
    }
    assert list(scratch.iterdir()) == []


def test_native_aligner_clips_audio_past_full_scale_instead_of_wrapping_it(tmp_path, scratch):
    cli = make_fake_cli(tmp_path)
    NativeFuseAligner(cli.path, MODEL, 1).align(sine(220, 16000, amp=2.0), ["a"])
    [wav] = cli.calls()[0]["wavs"]
    assert wav["max"] > 32000
    assert wav["min"] < -32000


@pytest.mark.parametrize(
    ("mode", "reason"),
    [
        ("error_row", "exited with status 1"),
        ("model_error", "exited with status 1"),
        ("error_row_exit_0", "reported an error"),
        ("short", "expected 3"),
        ("null_time", "malformed"),
        ("nan_time", "malformed"),
        ("garbage", "no readable result"),
        ("silent", "no readable result"),
    ],
)
def test_native_aligner_failures_raise_runtime_error_and_leave_nothing(
    tmp_path, scratch, mode, reason
):
    cli = make_fake_cli(tmp_path, mode)
    with pytest.raises(RuntimeError, match=reason) as failure:
        NativeFuseAligner(cli.path, MODEL, 2).align(sine(220, 16000), WORDS)
    assert not any(word in str(failure.value) for word in WORDS)
    assert list(scratch.iterdir()) == []


def test_native_aligner_gives_up_on_a_cli_that_hangs(tmp_path, scratch, monkeypatch):
    monkeypatch.setattr(aligner_module, "_CLI_TIMEOUT_SECONDS", 0.5)
    # The id of the process is noted when it is spawned, and not read from what the fake CLI logs:
    # a freshly written launcher takes the machine 150 ms or more to run for the first time, and a
    # CLI killed before it had logged would leave nothing to read.
    spawned: list[int] = []

    class NotingPopen(subprocess.Popen):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            spawned.append(self.pid)

    monkeypatch.setattr(subprocess, "Popen", NotingPopen)
    cli = make_fake_cli(tmp_path, "hang")
    with pytest.raises(RuntimeError, match="did not finish"):
        NativeFuseAligner(cli.path, MODEL, 2).align(sine(220, 16000), WORDS)
    assert list(scratch.iterdir()) == []
    # The stuck process is killed, not left holding its memory.
    assert len(spawned) == 1
    with pytest.raises(ProcessLookupError):
        os.kill(spawned[0], 0)


def test_native_aligner_without_a_cli_raises_runtime_error(tmp_path, scratch):
    with pytest.raises(RuntimeError, match="could not be run"):
        NativeFuseAligner(str(tmp_path / "no-such-cli"), MODEL, 2).align(
            sine(220, 16000), WORDS
        )
    assert list(scratch.iterdir()) == []


@pytest.mark.parametrize("failing_step", ["writing the wav", "cleaning up"])
def test_native_aligner_does_not_blame_the_cli_for_a_disk_error(
    tmp_path, scratch, monkeypatch, failing_step
):
    # A full disk while the files are written or deleted is the disk's error, not a CLI that could
    # not be run: the OSError itself comes out, whose type and place the session logs.
    disk_full = OSError(errno.ENOSPC, "No space left on device")
    if failing_step == "writing the wav":

        def write_nothing(*args, **kwargs):
            raise disk_full

        monkeypatch.setattr(aligner_module.sf, "write", write_nothing)
    else:
        delete_for_real = tempfile.TemporaryDirectory.cleanup

        def delete_then_fail(self):
            delete_for_real(self)
            raise disk_full

        monkeypatch.setattr(tempfile.TemporaryDirectory, "cleanup", delete_then_fail)
    cli = make_fake_cli(tmp_path)
    with pytest.raises(OSError) as failure:
        NativeFuseAligner(cli.path, MODEL, 2).align(sine(220, 16000), WORDS)
    assert failure.value is disk_full
    assert not isinstance(failure.value, RuntimeError)
    assert list(scratch.iterdir()) == []


def test_native_aligner_runs_one_cli_at_a_time(tmp_path, scratch):
    # A long clip takes close to 900 MiB in the CLI and the service's memory limit is 2 GiB, so
    # two at once would reach it.
    cli = make_fake_cli(tmp_path, "slow")
    native = NativeFuseAligner(cli.path, MODEL, 2)
    audio = sine(220, 16000)
    together = threading.Barrier(2, timeout=10)

    def align() -> list:
        together.wait()
        return native.align(audio, ["a", "b"])

    with ThreadPoolExecutor(max_workers=2) as pool:
        answers = [future.result() for future in [pool.submit(align), pool.submit(align)]]
    first, second = sorted(cli.calls(), key=lambda call: call["started"])
    assert first["ended"] <= second["started"]
    assert answers == [[(0.0, 0.125), None]] * 2
    assert list(scratch.iterdir()) == []


def test_two_native_aligners_share_the_one_cli_slot(tmp_path, scratch):
    cli = make_fake_cli(tmp_path, "slow")
    audio = sine(220, 16000)
    together = threading.Barrier(2, timeout=10)

    def align() -> list:
        together.wait()
        return NativeFuseAligner(cli.path, MODEL, 2).align(audio, ["a"])

    with ThreadPoolExecutor(max_workers=2) as pool:
        for future in [pool.submit(align), pool.submit(align)]:
            future.result()
    first, second = sorted(cli.calls(), key=lambda call: call["started"])
    assert first["ended"] <= second["started"]


def test_native_aligner_with_no_words_runs_nothing(tmp_path, scratch):
    cli = make_fake_cli(tmp_path)
    assert NativeFuseAligner(cli.path, MODEL, 2).align(sine(220, 16000), []) == []
    assert cli.calls() == []
    assert list(scratch.iterdir()) == []


# PythonFuseAligner against fake `torch` and `fusealign_hub` modules.


def test_python_aligner_loads_on_cpu_one_clip_at_a_time(monkeypatch):
    fake = install_fake_fusealign(monkeypatch)
    PythonFuseAligner(device="cpu", threads=3, checkpoint="/models/fusealign.safetensors")
    assert fake.loads == [
        {
            "checkpoint": "/models/fusealign.safetensors",
            "device": "cpu",
            "compile_model": False,
            "batch_size": 1,
        }
    ]
    assert fake.threads == [3]


def test_python_aligner_leaves_torchs_threads_alone_unless_asked(monkeypatch):
    fake = install_fake_fusealign(monkeypatch)
    PythonFuseAligner()
    assert fake.threads == []
    assert fake.loads[0]["device"] == "cpu"
    assert fake.loads[0]["checkpoint"] is None


def test_python_aligner_times_the_words_and_leaves_unplaced_ones_null(monkeypatch):
    fake = install_fake_fusealign(monkeypatch)
    fake.unplaced = frozenset({1})
    audio = sine(220, 16000)
    assert PythonFuseAligner().align(audio, ["a", "b", "c"]) == [(0.0, 0.125), None, (0.5, 0.625)]
    [call] = fake.aligns
    assert call["sample_rate"] == 16000
    assert call["transcript"] == ["a", "b", "c"]  # the list: one result per word
    assert call["audio"].dtype == np.float32
    assert np.array_equal(call["audio"], audio)
    # A sentence over 30 s must not make FuseAlign load Whisper large-v3 (3 GB) to time it: an
    # empty list of anchors sends it down its voice-activity-detection path instead.
    assert call["asr_words"] == []


def test_python_aligner_failure_raises_runtime_error_without_the_text(monkeypatch):
    fake = install_fake_fusealign(monkeypatch)
    fake.error = ValueError("cannot time 'kettő tojás'")
    with pytest.raises(RuntimeError) as failure:
        PythonFuseAligner().align(sine(220, 16000), ["kettő", "tojás"])
    assert "ValueError" in str(failure.value)
    assert "kettő" not in str(failure.value)
    assert failure.value.__cause__ is None
    assert failure.value.__suppress_context__


def test_python_aligner_answer_of_the_wrong_length_is_an_error(monkeypatch):
    fake = install_fake_fusealign(monkeypatch)
    fake.missing = 1
    with pytest.raises(RuntimeError, match="expected 3"):
        PythonFuseAligner().align(sine(220, 16000), ["a", "b", "c"])


def test_python_aligner_with_no_words_calls_no_model(monkeypatch):
    fake = install_fake_fusealign(monkeypatch)
    assert PythonFuseAligner().align(sine(220, 16000), []) == []
    assert fake.aligns == []


def test_the_no_aligner_and_the_fake_answer_no_words_with_no_times():
    audio = sine(220, 16000)
    assert NoAligner().align(audio, []) == []
    assert FakeAligner().align(audio, []) == []
    assert FakeAligner(fail=True).align(audio, []) == []


# make_aligner: the Settings pick the backend.


def test_make_aligner_none():
    assert isinstance(make_aligner(Settings(aligner="none")), NoAligner)


def test_make_aligner_native_passes_the_cli_the_model_and_the_threads(tmp_path, scratch):
    cli = make_fake_cli(tmp_path)
    settings = Settings(
        aligner="native", aligner_model=MODEL, aligner_cli=cli.path, aligner_threads=6
    )
    aligner = make_aligner(settings)
    assert isinstance(aligner, NativeFuseAligner)
    aligner.align(sine(220, 16000), ["a"])
    [call] = cli.calls()
    assert call["argv"][:6] == ["-m", MODEL, "-d", "cpu", "-t", "6"]


def test_make_aligner_native_needs_a_model():
    with pytest.raises(ValueError, match="SPEECH_ALIGNER_MODEL"):
        make_aligner(Settings(aligner="native"))


def test_make_aligner_python_passes_the_checkpoint_and_the_threads(monkeypatch):
    fake = install_fake_fusealign(monkeypatch)
    aligner = make_aligner(Settings(aligner="python", aligner_model="/ckpt", aligner_threads=5))
    assert isinstance(aligner, PythonFuseAligner)
    assert fake.loads == [
        {"checkpoint": "/ckpt", "device": "cpu", "compile_model": False, "batch_size": 1}
    ]
    assert fake.threads == [5]


def test_make_aligner_python_without_a_model_uses_the_default_checkpoint(monkeypatch):
    fake = install_fake_fusealign(monkeypatch)
    make_aligner(Settings(aligner="python"))
    assert fake.loads[0]["checkpoint"] is None


# The live check: the real FuseAlign on a real clip. Not part of CI; needs the owner's Mac.

LIVE_WAV = (
    "/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.superpowers/brainstorm/"
    "88338-1794826368/content/audition/norm-hu2-hu.wav"
)
LIVE_TEXT = "A recepthez 2 tojás, 250 gramm liszt és 1,5 deciliter tej kell."


@pytest.mark.live
@pytest.mark.skipif(
    os.environ.get("SPEECH_LIVE") != "1", reason="set SPEECH_LIVE=1 to run the real FuseAlign"
)
def test_live_python_aligner_places_every_word():
    audio, sr = sf.read(os.environ.get("SPEECH_LIVE_WAV", LIVE_WAV), dtype="float32")
    tokens = LIVE_TEXT.split()
    spoken = normalize(tokens, "hu")
    audio_16k = resample_16k(audio, sr)

    started = time.perf_counter()
    aligner = PythonFuseAligner(device="cpu", threads=4)
    print(f"\nloaded FuseAlign in {time.perf_counter() - started:.1f} s")
    started = time.perf_counter()
    times = aligner.align(audio_16k, spoken.words)
    seconds = len(audio_16k) / ALIGN_SAMPLE_RATE
    print(f"aligned {len(times)} words of {seconds:.2f} s of audio in "
          f"{time.perf_counter() - started:.2f} s")
    for word, interval in zip(spoken.words, times):
        print(f"  {word:<14} {interval}")
    for token, interval in zip(tokens, token_times(spoken, times)):
        print(f"  token {token:<12} {interval}")

    assert len(times) == len(spoken.words)
    assert None not in times
    starts = [interval[0] for interval in times]
    assert starts == sorted(starts)
