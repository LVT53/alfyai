"""Audio: loudness, silence, the click and the MP3 encoder."""

import asyncio
import signal
import sys
import textwrap

import numpy as np
import pytest

from speech_service import audio
from speech_service.audio import (
    Mp3Encoder,
    inner_silences,
    lengthen_pauses,
    match_loudness,
    silence,
    trim_silence,
)
from tests.helpers import SR, click_at, decode_mp3, decoded_seconds, peak_db, rms_db, tone


def noise(level_db: float, seconds: float = 1.0) -> np.ndarray:
    """Gaussian noise at an RMS of `level_db` dBFS: float32, mono, at SR, the same every time."""
    samples = np.random.default_rng(0).normal(0.0, 10 ** (level_db / 20), round(seconds * SR))
    return samples.astype(np.float32)


# Loudness matching.


def test_two_levels_end_equal():
    a, b = tone(0.05), tone(0.5)
    assert abs(rms_db(match_loudness(a, SR)) - rms_db(match_loudness(b, SR))) < 1.0


def test_peaks_capped():
    assert peak_db(match_loudness(tone(0.9), SR)) <= -1.0 + 1e-6


def test_speech_lands_on_the_target_level():
    assert rms_db(match_loudness(tone(0.05), SR)) == pytest.approx(-20.0, abs=0.01)


def test_silence_around_the_speech_does_not_count():
    # Over the whole clip the tone's RMS would read 7 dB lower, and the gain would overshoot.
    out = match_loudness(np.concatenate([tone(0.1), silence(4.0, SR)]), SR)
    assert rms_db(out[:SR]) == pytest.approx(-20.0, abs=0.01)


@pytest.mark.parametrize(
    ("quiet_amp", "loud_part_db"),
    [
        # Below a thirtieth of the loudest frame's RMS: not speech, so the loud part lands on -20.
        (0.5 / 40, -20.0),
        # Above it: speech, so the quiet half pulls the level down and the gain rises by 3 dB.
        (0.5 / 20, -17.0),
    ],
)
def test_speech_is_the_frames_above_a_thirtieth_of_the_loudest(quiet_amp, loud_part_db):
    out = match_loudness(np.concatenate([tone(0.5), tone(quiet_amp)]), SR)
    assert rms_db(out[:SR]) == pytest.approx(loud_part_db, abs=0.1)


def test_a_peak_that_would_clip_lowers_the_gain_to_the_ceiling():
    quiet_with_a_click = tone(0.02)
    quiet_with_a_click[1000] = 1.0
    out = match_loudness(quiet_with_a_click, SR)
    assert peak_db(out) == pytest.approx(-1.0, abs=1e-4)
    assert rms_db(out) < -20.0  # the target is out of reach under that ceiling


@pytest.mark.parametrize(
    ("target_db", "ceiling_db", "expected_rms_db", "expected_peak_db"),
    [
        (-30.0, -1.0, -30.0, -27.0),  # the target moves the level
        (-10.0, -12.0, -15.0, -12.0),  # the ceiling moves the peak (and the level with it)
    ],
)
def test_target_and_ceiling_are_parameters(target_db, ceiling_db, expected_rms_db, expected_peak_db):
    out = match_loudness(tone(0.2), SR, target_db=target_db, peak_db=ceiling_db)
    assert rms_db(out) == pytest.approx(expected_rms_db, abs=0.02)
    assert peak_db(out) == pytest.approx(expected_peak_db, abs=0.02)


@pytest.mark.filterwarnings("error")
def test_silence_comes_back_unchanged():
    quiet = silence(1.0, SR)
    out = match_loudness(quiet, SR)
    assert np.array_equal(out, quiet)
    assert out is not quiet


@pytest.mark.filterwarnings("error")
def test_empty_audio_is_fine_for_both():
    nothing = np.zeros(0, dtype=np.float32)
    assert match_loudness(nothing, SR).size == 0
    assert trim_silence(nothing, SR).size == 0


def test_loudness_returns_a_new_float32_array():
    x = tone(0.05)
    before = x.copy()
    out = match_loudness(x, SR)
    assert out.dtype == np.float32
    assert not np.shares_memory(out, x)
    assert np.array_equal(x, before)


# What is too quiet to be speech at all: a model that said nothing leaves hiss, and the hiss must
# not be turned up to the level of speech.


def test_a_clip_quieter_than_the_floor_is_silence_to_both():
    hiss = noise(-70.4)  # the loudest 20 ms of it is about -70 dBFS
    assert trim_silence(hiss, SR).size == 0
    out = match_loudness(hiss, SR)
    assert np.array_equal(out, hiss)
    assert out is not hiss


@pytest.mark.parametrize(
    ("amplitude", "level_db"),
    [
        (0.002, -57.0),  # 3 dB above the floor of -60 dBFS (RMS of the loudest 20 ms)
        (0.001, -63.0),  # 3 dB below it
    ],
)
def test_the_floor_is_60_dbfs_for_the_loudest_20_ms(amplitude, level_db):
    x = tone(amplitude)
    assert rms_db(x) == pytest.approx(level_db, abs=0.2)
    kept, matched = trim_silence(x, SR), match_loudness(x, SR)
    if level_db > -60.0:
        assert kept.size > 0
        assert rms_db(matched) == pytest.approx(-20.0, abs=0.01)
    else:
        assert kept.size == 0
        assert np.array_equal(matched, x)


def test_hiss_around_speech_is_still_cut_and_does_not_count():
    # The floor is on the loudest frame only: with speech in the clip, the ordinary rule (a
    # thirtieth of the loudest frame) still decides which frames around it are speech.
    x = np.concatenate([noise(-80.0), tone(0.05), noise(-80.0)])
    assert len(trim_silence(x, SR)) == round(1.1 * SR)
    assert rms_db(match_loudness(x, SR)[SR : 2 * SR]) == pytest.approx(-20.0, abs=0.01)


# The silences inside a clip, and lengthening them.


def speech_pause_speech(pause: float, before: float = 0.6, after: float = 0.6) -> np.ndarray:
    return np.concatenate([tone(0.3, before), silence(pause, SR), tone(0.3, after)])


def test_a_silence_inside_a_clip_is_found_with_its_place_and_length():
    runs = inner_silences(speech_pause_speech(0.30), SR)
    assert len(runs) == 1
    start, end = runs[0]
    assert start / SR == pytest.approx(0.6, abs=0.03)
    assert (end - start) / SR == pytest.approx(0.30, abs=0.04)


def test_the_silence_before_and_after_the_speech_is_not_inside_it():
    clip = np.concatenate([silence(1.0, SR), tone(0.3, 0.5), silence(1.0, SR)])
    assert inner_silences(clip, SR) == []


@pytest.mark.parametrize("clip", [np.zeros(0, dtype=np.float32), silence(1.0, SR), tone(0.3, 0.02)])
def test_a_clip_with_nothing_to_measure_has_no_silences(clip):
    assert inner_silences(clip, SR) == []


def test_a_pause_inside_a_clip_is_lengthened_by_what_is_asked():
    clip = speech_pause_speech(0.30)
    longer = lengthen_pauses(clip, SR, 0.15)
    assert len(longer) - len(clip) == round(0.15 * SR)


def test_the_speech_either_side_of_a_lengthened_pause_is_untouched():
    clip = speech_pause_speech(0.30)
    longer = lengthen_pauses(clip, SR, 0.15)
    (start, end), = inner_silences(clip, SR)
    middle = (start + end) // 2
    fade = round(0.005 * SR)
    # Up to a few milliseconds around the join (the fades), the samples are the clip's own.
    assert np.array_equal(longer[: middle - fade], clip[: middle - fade])
    assert np.array_equal(longer[len(longer) - (len(clip) - middle - fade) :], clip[middle + fade :])


def test_every_pause_of_a_clip_is_lengthened():
    clip = np.concatenate([tone(0.3, 0.5), silence(0.2, SR), tone(0.3, 0.5), silence(0.3, SR), tone(0.3, 0.5)])
    assert len(lengthen_pauses(clip, SR, 0.1)) - len(clip) == 2 * round(0.1 * SR)


def test_a_silence_shorter_than_a_pause_is_left_alone():
    # The closure of a consonant, not a comma.
    clip = speech_pause_speech(0.06)
    assert np.array_equal(lengthen_pauses(clip, SR, 0.15), clip)


def test_a_silence_as_long_as_a_stall_is_left_alone():
    # What steady.py is for: a pause that long is a clip to be made again, not one to stretch.
    clip = speech_pause_speech(1.2)
    assert np.array_equal(lengthen_pauses(clip, SR, 0.15), clip)


def test_silence_at_the_ends_of_a_clip_is_left_alone():
    clip = np.concatenate([silence(0.5, SR), tone(0.3, 0.5), silence(0.5, SR)])
    assert np.array_equal(lengthen_pauses(clip, SR, 0.15), clip)


def test_lengthening_by_nothing_changes_nothing_and_gives_a_copy():
    clip = speech_pause_speech(0.30)
    same = lengthen_pauses(clip, SR, 0.0)
    assert np.array_equal(same, clip) and same is not clip


def test_the_join_of_a_lengthened_pause_makes_no_click():
    # A pause with a faint hiss in it (the room, 50 dB down): no sample at the join may jump by
    # more than the hiss itself.
    hiss = noise(-50.0, 0.30)
    clip = np.concatenate([tone(0.3, 0.6), hiss, tone(0.3, 0.6)])
    longer = lengthen_pauses(clip, SR, 0.2)
    assert np.max(np.abs(np.diff(longer[round(0.58 * SR) : round(1.2 * SR)]))) < 0.03


def test_a_lengthened_clip_has_the_dtype_it_came_with():
    assert lengthen_pauses(speech_pause_speech(0.30), SR, 0.15).dtype == np.float32


# Trimming and gaps.


def test_trim_keeps_the_speech_frames_and_50_ms_around_them():
    x = np.concatenate([silence(1.0, SR), tone(0.3, 0.5), silence(1.0, SR)])
    # The speech frames run from 1.0 s to 1.5 s (frames of 20 ms); the first one minus 50 ms is at
    # 0.95 s and the last one plus 50 ms ends at 1.55 s.
    assert np.array_equal(trim_silence(x, SR), x[round(0.95 * SR) : round(1.55 * SR)])


def test_trim_keeps_as_much_as_it_is_asked_to():
    x = np.concatenate([silence(1.0, SR), tone(0.3, 0.5), silence(1.0, SR)])
    assert len(trim_silence(x, SR, keep_s=0.0)) == round(0.5 * SR)
    assert len(trim_silence(x, SR, keep_s=0.2)) == round(0.9 * SR)


def test_trim_does_not_run_past_either_end():
    # A start before sample 0 would be a slice from the end of the clip, not from its start.
    starts_loud = np.concatenate([tone(0.3, 0.5), silence(1.0, SR)])
    assert np.array_equal(trim_silence(starts_loud, SR), starts_loud[: round(0.55 * SR)])
    ends_loud = np.concatenate([silence(1.0, SR), tone(0.3, 0.5)])
    assert np.array_equal(trim_silence(ends_loud, SR), ends_loud[round(0.95 * SR) :])


def test_trim_cuts_a_tail_quieter_than_a_thirtieth_of_the_loudest():
    x = np.concatenate([tone(0.5), tone(0.5 / 60)])
    assert len(trim_silence(x, SR)) == round(1.05 * SR)


def test_trim_of_silence_is_an_empty_array():
    out = trim_silence(silence(1.0, SR), SR)
    assert out.size == 0
    assert out.dtype == np.float32


def test_trim_returns_a_copy():
    x = tone(0.3)
    assert not np.shares_memory(trim_silence(x, SR), x)


def test_silence_is_that_many_zero_samples():
    gap = silence(0.3, SR)
    assert gap.shape == (round(0.3 * SR),)
    assert gap.dtype == np.float32
    assert not gap.any()


def test_click_is_one_full_scale_sample_with_half_a_second_after_it():
    clip = click_at(0.5)
    assert clip.dtype == np.float32
    assert np.flatnonzero(clip).tolist() == [round(0.5 * SR)]
    assert clip[round(0.5 * SR)] == 1.0
    assert len(clip) == SR


# The MP3 encoder.


async def collect(enc: Mp3Encoder) -> bytes:
    return b"".join([chunk async for chunk in enc.read_chunks()])


async def test_encoder_delay_is_reported():
    async with Mp3Encoder() as enc:
        assert 0.0 <= enc.delay_seconds < 0.08  # LAME priming is about 25 ms at 44.1 kHz


async def test_the_delay_is_the_priming_not_a_fallback_zero():
    # LAME's 576 samples of encoder delay plus the decoder's 529 are 25.06 ms at 44.1 kHz.
    async with Mp3Encoder() as enc:
        assert 0.020 < enc.delay_seconds < 0.030


async def test_mp3_round_trip_keeps_duration():
    async with Mp3Encoder() as enc:
        await enc.write(tone(0.1, seconds=2.0))
        await enc.close()
        data = b"".join([c async for c in enc.read_chunks()])
    assert abs(decoded_seconds(data) - 2.0) < 0.1


async def test_a_click_comes_out_delay_seconds_late_however_it_is_written():
    async with Mp3Encoder() as enc:
        for piece in np.array_split(click_at(1.0), [1000, 30000, 30001, 50000]):
            await enc.write(piece)
        await enc.close()
        mp3 = await collect(enc)
        delay = enc.delay_seconds
    found = int(np.argmax(np.abs(decode_mp3(mp3)))) / SR
    assert found == pytest.approx(1.0 + delay, abs=0.001)


async def test_samples_written_counts_what_was_written():
    async with Mp3Encoder() as enc:
        assert enc.samples_written == 0
        await enc.write(tone(0.1, seconds=0.5))
        await enc.write(silence(0.3, SR))
        assert enc.samples_written == round(0.8 * SR)


async def test_mp3_is_readable_before_the_stream_is_closed():
    async with Mp3Encoder() as enc:
        await enc.write(tone(0.1, seconds=1.0))
        chunks = enc.read_chunks()
        received = b""
        async with asyncio.timeout(5):
            while len(received) < 8000:  # half of what a second of audio comes to
                received += await anext(chunks)
        await chunks.aclose()
    assert received.startswith(b"ID3")


async def test_the_end_of_the_stream_ends_every_read():
    async with Mp3Encoder() as enc:
        await enc.write(tone(0.1, seconds=0.5))
        await enc.close()
        async with asyncio.timeout(5):
            first = await collect(enc)
            again = await collect(enc)
    assert first
    assert again == b""


async def test_write_after_close_is_an_error():
    async with Mp3Encoder() as enc:
        await enc.close()
        with pytest.raises(RuntimeError, match="closed"):
            await enc.write(tone(0.1, seconds=0.1))


async def test_write_before_the_encoder_has_started_is_an_error():
    with pytest.raises(RuntimeError, match="async with"):
        await Mp3Encoder().write(tone(0.1, seconds=0.1))


async def test_closing_twice_is_fine():
    async with Mp3Encoder() as enc:
        await enc.write(tone(0.1, seconds=0.5))
        await enc.close()
        await enc.close()  # and leaving the block closes a third time


# The pipes and the subprocess are not quite the same on stock asyncio and on uvloop, which
# uvicorn[standard] runs in production, so the tests that depend on them run on both.


@pytest.fixture(params=["asyncio", "uvloop"])
def run(request):
    """Runs a coroutine to completion on a new event loop of that kind."""
    if request.param == "uvloop":
        return pytest.importorskip("uvloop").run
    return asyncio.run


def test_writing_does_not_wait_for_a_reader(run):
    # 30 s of audio is about 480 KB of MP3, many times what the pipe from ffmpeg holds. Nobody reads
    # until the end, so a write would block for good unless ffmpeg's output is drained meanwhile.
    async def scenario() -> bytes:
        async with Mp3Encoder() as enc:
            async with asyncio.timeout(20):
                for _ in range(10):
                    await enc.write(tone(0.1, seconds=3.0))
                await enc.close()
            return await collect(enc)

    assert abs(decoded_seconds(run(scenario())) - 30.0) < 0.1


def test_an_error_in_the_block_kills_ffmpeg(run):
    async def scenario() -> int | None:
        with pytest.raises(ValueError, match="boom"):
            async with Mp3Encoder() as enc:
                proc = enc._proc  # the one place a test needs to see the process itself
                await enc.write(tone(0.1, seconds=3.0))  # ffmpeg has output nobody has read yet
                raise ValueError("boom")
        return proc.returncode

    assert run(scenario()) == -signal.SIGKILL


def test_cancelling_the_task_kills_ffmpeg_and_ends_the_readers(run):
    async def scenario() -> int | None:
        entered = asyncio.Event()
        seen = {}

        async def reading_session() -> None:
            async with Mp3Encoder() as enc:
                seen["proc"] = enc._proc
                seen["reader"] = asyncio.create_task(collect(enc))
                await enc.write(tone(0.1, seconds=1.0))
                entered.set()
                await asyncio.sleep(60)

        task = asyncio.create_task(reading_session())
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        async with asyncio.timeout(5):
            await seen["reader"]  # released by the end of the stream, not left waiting for more
        return seen["proc"].returncode

    assert run(scenario()) == -signal.SIGKILL


def test_ffmpeg_is_gone_after_the_block_even_when_closing_is_cancelled(run, monkeypatch):
    async def close_that_is_cancelled(self) -> None:
        raise asyncio.CancelledError

    monkeypatch.setattr(Mp3Encoder, "close", close_that_is_cancelled)

    async def scenario() -> int | None:
        with pytest.raises(asyncio.CancelledError):
            async with Mp3Encoder() as enc:
                proc = enc._proc
        return proc.returncode

    assert run(scenario()) == -signal.SIGKILL


@pytest.mark.parametrize("wait_for_the_death", [True, False], ids=["after-it-died", "as-it-dies"])
def test_a_dead_ffmpeg_makes_write_raise_instead_of_hang(run, wait_for_the_death):
    async def scenario() -> None:
        async with Mp3Encoder() as enc:
            enc._proc.kill()
            if wait_for_the_death:
                await enc._proc.wait()
            async with asyncio.timeout(10):
                while True:  # a write or two may still be taken in before the pipe is seen closed
                    await enc.write(tone(0.1, seconds=1.0))

    with pytest.raises(BrokenPipeError, match="no longer running"):
        run(scenario())


@pytest.mark.parametrize("close_it", [True, False], ids=["close", "leave-the-block"])
def test_a_stream_ffmpeg_did_not_finish_is_an_error_not_a_clean_end(run, close_it):
    async def scenario() -> None:
        async with Mp3Encoder() as enc:
            enc._proc.kill()
            if close_it:
                await enc.close()

    with pytest.raises(RuntimeError, match="ffmpeg exited with status"):
        run(scenario())


# What ffmpeg says when it fails. At -loglevel error that is codec and format errors, never the
# words being spoken, so the end of it goes into the error: a box without libmp3lame says so.


def stand_in_for_ffmpeg(monkeypatch, script: str) -> None:
    """Make the encoder's command a Python script that plays ffmpeg (stdin in, stderr out)."""
    monkeypatch.setattr(audio, "_FFMPEG_ENCODE", (sys.executable, "-c", textwrap.dedent(script)))


def delay_not_measured(monkeypatch) -> None:
    """Make the next `warm_up()` measure the delay, as a service that has just started does."""
    monkeypatch.setattr(Mp3Encoder, "_delay", None)
    monkeypatch.setattr(Mp3Encoder, "_delay_lock", asyncio.Lock())


def test_the_warm_up_error_says_what_ffmpeg_said(run, monkeypatch):
    # A box without libmp3lame: the real ffmpeg, asked for an encoder it has not got.
    missing = tuple("libnotthere" if arg == "libmp3lame" else arg for arg in audio._FFMPEG_ENCODE)
    assert missing != audio._FFMPEG_ENCODE
    monkeypatch.setattr(audio, "_FFMPEG_ENCODE", missing)
    delay_not_measured(monkeypatch)

    async def scenario() -> None:
        await Mp3Encoder.warm_up()

    with pytest.raises(RuntimeError, match=r"ffmpeg exited with status \d+: .*Unknown encoder"):
        run(scenario())


def test_the_warm_up_error_is_the_end_of_stderr_on_one_line(run, monkeypatch):
    stand_in_for_ffmpeg(
        monkeypatch,
        """
        import sys
        sys.stderr.write("first thing wrong\\n\\n  second thing wrong  \\n")
        sys.exit(1)
        """,
    )
    delay_not_measured(monkeypatch)

    async def scenario() -> None:
        await Mp3Encoder.warm_up()

    with pytest.raises(RuntimeError) as failure:
        run(scenario())
    said = "first thing wrong | second thing wrong"
    assert str(failure.value) == f"ffmpeg exited with status 1: {said}"


def test_an_ffmpeg_that_says_nothing_leaves_just_its_status(run, monkeypatch):
    stand_in_for_ffmpeg(monkeypatch, "import sys; sys.exit(4)")
    delay_not_measured(monkeypatch)

    async def scenario() -> None:
        await Mp3Encoder.warm_up()

    with pytest.raises(RuntimeError) as failure:
        run(scenario())
    assert str(failure.value) == "ffmpeg exited with status 4"


@pytest.mark.parametrize("close_it", [True, False], ids=["close", "leave-the-block"])
def test_an_encoder_that_failed_says_what_ffmpeg_said(run, monkeypatch, close_it):
    stand_in_for_ffmpeg(
        monkeypatch,
        """
        import sys
        sys.stdin.buffer.read()
        sys.stderr.write("codec exploded\\n")
        sys.exit(3)
        """,
    )
    monkeypatch.setattr(Mp3Encoder, "_delay", 0.025)  # the stand-in encodes nothing to measure

    async def scenario() -> None:
        async with Mp3Encoder() as enc:
            await enc.write(tone(0.1, seconds=0.2))
            if close_it:
                await enc.close()

    with pytest.raises(RuntimeError, match="ffmpeg exited with status 3: codec exploded"):
        run(scenario())


def test_a_flood_on_stderr_neither_blocks_ffmpeg_nor_floods_the_error(run, monkeypatch):
    stand_in_for_ffmpeg(
        monkeypatch,
        """
        import sys
        sys.stderr.write("x" * 1_000_000 + "\\n")  # far more than a pipe holds
        sys.stdin.buffer.read()
        sys.stderr.write("the end\\n")
        sys.exit(3)
        """,
    )
    monkeypatch.setattr(Mp3Encoder, "_delay", 0.025)  # the stand-in encodes nothing to measure

    async def encode() -> None:
        async with Mp3Encoder() as enc:
            await enc.write(tone(0.1, seconds=1.0))  # more than the pipe to ffmpeg holds
            await enc.close()

    async def scenario() -> None:
        work = asyncio.ensure_future(encode())
        done, _ = await asyncio.wait({work}, timeout=10)
        if not done:
            # An ffmpeg stuck on a full stderr never reads its input, so the write never ends. Once
            # it is killed the encoder waits for its pipes to be read to the end, and that does not
            # end either: stop waiting here, for a failure and not a hung run.
            work.cancel()
            await asyncio.wait({work}, timeout=5)
            pytest.fail("ffmpeg was blocked by what it wrote on stderr")
        await work

    with pytest.raises(RuntimeError) as failure:
        run(scenario())
    message = str(failure.value)
    assert message.endswith("the end")
    assert len(message) < 300
    assert message.count("x") <= 200


# The delay is measured once per process.


async def test_the_delay_is_measured_once_and_shared(monkeypatch):
    measured = []

    async def measure() -> float:
        measured.append(1)
        await asyncio.sleep(0.01)  # long enough that the encoders below overlap
        return 0.025

    monkeypatch.setattr(audio, "_measure_delay", measure)
    monkeypatch.setattr(Mp3Encoder, "_delay", None)
    monkeypatch.setattr(Mp3Encoder, "_delay_lock", asyncio.Lock())

    async def delay_of_a_new_encoder() -> float:
        async with Mp3Encoder() as enc:
            return enc.delay_seconds

    assert await asyncio.gather(*(delay_of_a_new_encoder() for _ in range(3))) == [0.025] * 3
    assert await Mp3Encoder.warm_up() == 0.025
    assert len(measured) == 1


async def test_a_failed_measurement_is_not_remembered(monkeypatch):
    outcomes = [RuntimeError("ffmpeg is not installed"), 0.025]

    async def measure() -> float:
        outcome = outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(audio, "_measure_delay", measure)
    monkeypatch.setattr(Mp3Encoder, "_delay", None)
    monkeypatch.setattr(Mp3Encoder, "_delay_lock", asyncio.Lock())

    with pytest.raises(RuntimeError, match="not installed"):
        await Mp3Encoder.warm_up()
    assert await Mp3Encoder.warm_up() == 0.025


def test_the_delay_is_not_known_before_the_encoder_starts(monkeypatch):
    monkeypatch.setattr(Mp3Encoder, "_delay", None)
    with pytest.raises(RuntimeError, match="warm_up"):
        _ = Mp3Encoder().delay_seconds


def test_the_encoder_never_reads_ahead():
    # The box's ffmpeg 7.1.5 holds all of its MP3 until about 5 s of input have arrived unless the
    # read-ahead is switched off; Homebrew's ffmpeg 9 streams either way, so no behaviour test on the
    # Mac can see this. The input options must come before `-i`.
    command = audio._FFMPEG_ENCODE
    before_input = command[: command.index("-i")]
    assert before_input[before_input.index("-probesize") + 1] == "32"
    assert before_input[before_input.index("-analyzeduration") + 1] == "0"
