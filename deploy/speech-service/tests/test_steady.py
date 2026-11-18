"""Steady clips: Zonos sometimes stalls on a sentence, and the service makes that sentence again.

A stall is a clip with a long silence inside it, or one far longer than its words need. It comes
from the model's sampling, not from the text: the same sentence stalls under one seed and not under
the next, which is why the cure is another seed (spec §4.8, I12 of the UI walk). These tests run
`synthesize_steady` on a scripted Zonos, so every clip it meets is made by the test.
"""

import numpy as np
import pytest

from speech_service import questions, steady
from speech_service.models import Voice
from speech_service.zonos import SynthesisFailed, ZonosUnavailable
from tests.helpers import SR, question_clip, tone

TEXT = "Elolvassam a hosszabb változatot is"  # 36 characters, the length of a short question


def speech(seconds: float) -> np.ndarray:
    """`seconds` of something that is speech to the meters: a tone."""
    return tone(0.3, seconds)


def silence_of(seconds: float) -> np.ndarray:
    return np.zeros(round(seconds * SR), dtype=np.float32)


def with_pause(pause: float, before: float = 1.0, after: float = 1.0) -> np.ndarray:
    """Speech, a silence of `pause` seconds, speech: a clip that hesitated in the middle."""
    return np.concatenate([speech(before), silence_of(pause), speech(after)])


def steady_clip(chars: int = len(TEXT), language: str = "hu", tempo: float = 0.0) -> np.ndarray:
    """A clip as long as the sentence is expected to take, with no pause in it."""
    return speech(steady.expected_seconds(chars, language, tempo))


# --- how a clip is judged ------------------------------------------------------------------------


def test_a_clip_of_steady_speech_has_no_pause():
    assert steady.longest_pause(speech(2.0), SR) == 0.0


def test_the_longest_pause_is_the_silence_between_two_stretches_of_speech():
    assert steady.longest_pause(with_pause(1.5), SR) == pytest.approx(1.5, abs=0.05)


def test_the_longest_of_several_pauses_is_the_one_that_counts():
    clip = np.concatenate([speech(0.5), silence_of(0.4), speech(0.5), silence_of(1.2), speech(0.5)])
    assert steady.longest_pause(clip, SR) == pytest.approx(1.2, abs=0.05)


def test_silence_before_and_after_the_speech_is_not_a_pause():
    clip = np.concatenate([silence_of(2.0), speech(1.0), silence_of(2.0)])
    assert steady.longest_pause(clip, SR) == 0.0


@pytest.mark.parametrize("clip", [np.zeros(0, dtype=np.float32), silence_of(1.0), speech(0.02)])
def test_a_clip_with_nothing_to_measure_has_no_pause(clip):
    assert steady.longest_pause(clip, SR) == 0.0


def test_a_sentence_takes_longer_the_more_it_says():
    assert steady.expected_seconds(100, "hu") > steady.expected_seconds(50, "hu")
    assert steady.expected_seconds(1, "hu") > 0


def test_even_one_word_is_expected_to_take_a_breath_and_a_half():
    # Zonos's clip of "Yes." is a second or more with the silence round it: a clean one must not look long.
    assert steady.expected_seconds(4, "en") >= 1.2
    assert steady.expected_seconds(1, "hu") == steady.expected_seconds(4, "hu")


def test_a_clean_clip_of_one_word_is_no_trouble():
    assert steady.trouble(speech(1.5), SR, len("Yes."), "en") == 0.0


def test_speech_made_up_after_a_few_words_is_trouble():
    # What the owner heard on a selection of a few words: a clip of seconds of fluent speech, with
    # no pause in it, for a text that takes a second. Nothing is silent in it, and it is too long.
    clip = speech(5.0)
    assert steady.longest_pause(clip, SR) == 0.0
    assert steady.trouble(clip, SR, len("this village."), "en") > 1.0


def test_hungarian_is_expected_to_take_longer_than_english_for_the_same_length():
    assert steady.expected_seconds(80, "hu") > steady.expected_seconds(80, "en")


def test_a_slow_tempo_expects_a_longer_clip_and_a_fast_one_a_shorter():
    slow, normal, fast = (steady.expected_seconds(80, "en", tempo) for tempo in (-2.0, 0.0, 2.0))
    assert slow > normal > fast


def test_a_clip_as_long_as_expected_is_no_trouble():
    assert steady.trouble(steady_clip(), SR, len(TEXT), "hu") == 0.0


def test_a_clip_a_little_slower_than_expected_is_no_trouble():
    clip = speech(1.2 * steady.expected_seconds(len(TEXT), "hu"))
    assert steady.trouble(clip, SR, len(TEXT), "hu") == 0.0


def test_a_clip_far_longer_than_its_words_need_is_trouble():
    clip = speech(3 * steady.expected_seconds(len(TEXT), "hu"))
    assert steady.trouble(clip, SR, len(TEXT), "hu") > 1.0


def test_a_long_silence_inside_a_clip_is_trouble_whatever_its_length():
    clip = with_pause(steady.GAP_SECONDS * 2, before=0.6, after=0.6)
    assert len(clip) / SR < steady.expected_seconds(len(TEXT), "hu")  # not long, only broken
    assert steady.trouble(clip, SR, len(TEXT), "hu") > 1.0


def test_a_pause_a_speaker_would_make_is_no_trouble():
    clip = with_pause(0.5, before=1.0, after=1.0)
    assert steady.trouble(clip, SR, len(TEXT), "hu") == 0.0


def test_the_worse_clip_is_the_greater_trouble():
    a = steady.trouble(speech(4 * steady.expected_seconds(len(TEXT), "hu")), SR, len(TEXT), "hu")
    b = steady.trouble(speech(2 * steady.expected_seconds(len(TEXT), "hu")), SR, len(TEXT), "hu")
    assert a > b > 1.0


def test_the_same_clip_is_trouble_at_a_normal_tempo_and_not_at_a_slow_one():
    clip = speech(1.8 * steady.expected_seconds(len(TEXT), "hu"))
    assert steady.trouble(clip, SR, len(TEXT), "hu", tempo=0.0) > 1.0
    assert steady.trouble(clip, SR, len(TEXT), "hu", tempo=-2.0) == 0.0


def test_a_slow_tempo_allows_a_longer_pause_too():
    clip = with_pause(1.0, before=1.0, after=1.0)
    assert steady.trouble(clip, SR, len(TEXT), "hu", tempo=0.0) > 1.0
    assert steady.trouble(clip, SR, len(TEXT), "hu", tempo=-2.0) == 0.0
    # A fast tempo does not tighten the pause that is allowed.
    assert steady.trouble(with_pause(0.7), SR, len(TEXT), "hu", tempo=2.0) == 0.0


def test_a_language_the_service_does_not_know_is_judged_by_the_slowest_one():
    assert steady.expected_seconds(80, "xx") == steady.expected_seconds(80, "hu")


def test_the_pause_it_measures_is_the_one_the_knob_sweep_measured_its_limits_on():
    """The limits were set on clips the sweep's meter measured; the two must agree to the frame."""
    rng = np.random.default_rng(7)
    clips = [
        with_pause(0.35), with_pause(1.2), with_pause(2.6, before=0.4, after=1.5),
        np.concatenate([silence_of(0.5), speech(0.8), silence_of(0.9), speech(0.8), silence_of(0.5)]),
        (rng.standard_normal(SR * 2) * 0.05).astype(np.float32),
        speech(1.0),
    ]  # fmt: skip
    for clip in clips:
        assert steady.longest_pause(clip, SR) == pytest.approx(
            _sweep().clip_metrics(clip, SR).longest_gap, abs=1e-9
        )


def _sweep():
    """`scripts/measure_knobs.py` as a module (`scripts/` is no package)."""
    import importlib.util
    import sys
    from pathlib import Path

    path = Path(__file__).resolve().parent.parent / "scripts" / "measure_knobs.py"
    spec = importlib.util.spec_from_file_location("measure_knobs", path)
    assert spec and spec.loader
    module = sys.modules.get("measure_knobs") or importlib.util.module_from_spec(spec)
    if "measure_knobs" not in sys.modules:
        sys.modules["measure_knobs"] = module
        spec.loader.exec_module(module)
    return module


# --- making a sentence again ---------------------------------------------------------------------


class Scripted:
    """A Zonos that answers each call with the next item of a script: a clip, or an error to raise."""

    def __init__(self, *script):
        self._script = list(script)
        self.seeds: list[int] = []
        self.texts: list[str] = []

    async def synthesize(self, text, language, voice, seed):
        self.seeds.append(seed)
        self.texts.append(text)
        item = self._script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item, SR


VOICE = Voice("default_test", {})
STALL = with_pause(2.5)


async def run(zonos, attempts=3, voice=VOICE, on_retry=None, seed=1234):
    return await steady.synthesize_steady(
        zonos, TEXT, "hu", voice, seed, attempts, on_retry=on_retry
    )


async def test_a_steady_clip_is_taken_at_once():
    good = steady_clip()
    zonos = Scripted(good)
    audio, rate = await run(zonos)
    assert audio is good and rate == SR
    assert zonos.seeds == [1234]


async def test_a_stalled_clip_is_made_again_with_the_next_seed():
    good = steady_clip()
    zonos = Scripted(STALL, good)
    audio, _ = await run(zonos)
    assert audio is good
    assert zonos.seeds == [1234, 1234 + steady.SEED_STEP]


async def test_it_keeps_trying_seeds_a_step_apart_until_a_clip_is_steady():
    good = steady_clip()
    zonos = Scripted(STALL, STALL, good)
    audio, _ = await run(zonos)
    assert audio is good
    assert zonos.seeds == [1234, 1234 + steady.SEED_STEP, 1234 + 2 * steady.SEED_STEP]


async def test_the_retries_say_the_same_words_in_the_same_voice():
    zonos = Scripted(STALL, steady_clip())
    await run(zonos)
    assert zonos.texts == [TEXT, TEXT]


async def test_when_every_attempt_stalls_the_least_bad_clip_is_kept():
    worst, least_bad, between = with_pause(3.5), with_pause(1.5), with_pause(2.5)
    zonos = Scripted(worst, least_bad, between)
    audio, _ = await run(zonos)
    assert audio is least_bad
    assert len(zonos.seeds) == 3


async def test_one_attempt_means_no_retry():
    zonos = Scripted(STALL)
    audio, _ = await run(zonos, attempts=1)
    assert audio is STALL
    assert zonos.seeds == [1234]


async def test_a_retry_that_fails_leaves_the_stalled_clip_as_the_answer():
    zonos = Scripted(STALL, SynthesisFailed("Zonos answered 500"))
    audio, _ = await run(zonos)
    assert audio is STALL


async def test_a_retry_that_cannot_reach_zonos_leaves_the_stalled_clip_as_the_answer():
    zonos = Scripted(STALL, ZonosUnavailable("Zonos did not answer"))
    audio, _ = await run(zonos)
    assert audio is STALL


async def test_a_first_attempt_that_fails_is_the_callers_error():
    zonos = Scripted(SynthesisFailed("Zonos answered 500"))
    with pytest.raises(SynthesisFailed):
        await run(zonos)
    assert zonos.seeds == [1234]


async def test_a_first_attempt_that_cannot_reach_zonos_is_the_callers_error():
    with pytest.raises(ZonosUnavailable):
        await run(Scripted(ZonosUnavailable("Zonos did not answer")))


async def test_the_slow_tempo_of_a_voice_is_part_of_what_is_expected():
    clip = speech(1.8 * steady.expected_seconds(len(TEXT), "hu"))
    slow = Voice("default_test", {"delivery.tempo": -2.0})
    zonos = Scripted(clip)
    audio, _ = await run(zonos, voice=slow)
    assert audio is clip
    assert zonos.seeds == [1234]  # it was no trouble, so nothing was made again


async def test_each_retry_is_reported_with_numbers_and_no_text():
    told: list[tuple] = []
    zonos = Scripted(STALL, STALL, steady_clip())
    await run(zonos, on_retry=lambda *args: told.append(args))
    assert [attempt for attempt, *_ in told] == [1, 2]
    for args in told:
        attempt, attempts, seconds, pause, expected = args
        assert attempts == 3
        assert seconds == pytest.approx(len(STALL) / SR)
        assert pause == pytest.approx(2.5, abs=0.05)
        assert expected == pytest.approx(steady.expected_seconds(len(TEXT), "hu"))
        assert all(isinstance(value, int | float) for value in args)  # numbers: never the text


async def test_a_voices_own_controls_reach_every_attempt():
    seen: list[dict] = []

    class Listening(Scripted):
        async def synthesize(self, text, language, voice, seed):
            seen.append(dict(voice.controls))
            return await super().synthesize(text, language, voice, seed)

    voice = Voice("default_test", {"room.clean": 2, "mood.arousal": 1.5})
    await run(Listening(STALL, steady_clip()), voice=voice)
    assert seen == [voice.controls, voice.controls]


# --- a question that ends flat is made again ------------------------------------------------------

QUESTION = "Did you find the file that I sent you?"


class ScriptedWithSpans(Scripted):
    """A Scripted that also keeps the control spans each call asked for."""

    def __init__(self, *script):
        super().__init__(*script)
        self.spans: list = []
        self.rates: list = []

    async def synthesize(self, text, language, voice, seed, control_spans=None, control_span_rate=None):
        self.spans.append(control_spans)
        self.rates.append(control_span_rate)
        return await super().synthesize(text, language, voice, seed)


async def ask(zonos, text=QUESTION, attempts=4, lift=5.0, rise=3.0, on_flat=None, rates=None):
    return await steady.synthesize_steady(
        zonos, text, "en", VOICE, 1234, attempts, question_lift=lift, question_rise=rise,
        on_flat=on_flat, rates=rates,
    )


async def test_a_yes_no_question_is_asked_with_a_lift_on_its_last_word():
    zonos = ScriptedWithSpans(question_clip(True))
    await ask(zonos)
    end = len(QUESTION)
    assert zonos.spans == [[{"start": end - 4, "end": end, "controls": {"delivery.pitch": 5.0}}]]


async def test_a_statement_is_made_as_it_is_and_never_judged():
    zonos = ScriptedWithSpans(question_clip(False))
    await ask(zonos, QUESTION[:-1] + ".")
    assert zonos.spans == [None] and zonos.seeds == [1234]


async def test_a_question_that_rises_is_taken_at_once():
    rising = question_clip(True)
    zonos = ScriptedWithSpans(rising)
    audio, _ = await ask(zonos)
    assert audio is rising and zonos.seeds == [1234]


async def test_a_question_that_ends_flat_is_made_again_under_the_next_seed():
    rising = question_clip(True)
    zonos = ScriptedWithSpans(question_clip(False), question_clip(False), rising)
    audio, _ = await ask(zonos)
    assert audio is rising
    assert zonos.seeds == [1234, 1234 + steady.SEED_STEP, 1234 + 2 * steady.SEED_STEP]


async def test_when_no_clip_rises_the_first_is_the_answer():
    first = question_clip(False)
    zonos = ScriptedWithSpans(first, question_clip(False), question_clip(False))
    audio, _ = await ask(zonos, attempts=3)
    assert audio is first and len(zonos.seeds) == 3


async def test_a_question_word_question_is_neither_lifted_nor_judged():
    zonos = ScriptedWithSpans(question_clip(False))
    await ask(zonos, "Where did you put the file that I sent you?")
    assert zonos.spans == [None] and zonos.seeds == [1234]


async def test_the_lift_and_the_judge_can_each_be_turned_off():
    unlifted = ScriptedWithSpans(question_clip(False), question_clip(True))
    await ask(unlifted, lift=0.0)
    assert unlifted.spans == [None, None] and len(unlifted.seeds) == 2  # still judged
    unjudged = ScriptedWithSpans(question_clip(False))
    await ask(unjudged, rise=0.0)
    assert unjudged.spans[0] is not None and len(unjudged.seeds) == 1  # still lifted


async def test_a_stall_is_worse_than_a_flat_question():
    flat = question_clip(False)
    zonos = ScriptedWithSpans(STALL, flat)
    audio, _ = await ask(zonos, attempts=2)
    assert audio is flat


async def test_a_clip_too_short_to_judge_is_taken():
    zonos = ScriptedWithSpans(tone(0.3, 0.3))
    await ask(zonos)
    assert zonos.seeds == [1234]


async def test_the_retry_of_a_flat_question_reports_numbers_only():
    heard = []
    zonos = ScriptedWithSpans(question_clip(False), question_clip(True))
    await ask(zonos, on_flat=lambda *numbers: heard.append(numbers))
    ((attempt, attempts, rise),) = heard
    assert (attempt, attempts) == (1, 4) and isinstance(rise, float) and rise < 3.0


async def test_the_span_goes_by_the_rate_the_voice_was_heard_to_speak_at():
    memory = questions.RateMemory()
    zonos = ScriptedWithSpans(question_clip(False, 3.0), question_clip(True, 3.0))
    await ask(zonos, rates=memory)
    # The first attempt has nothing to go by; the second goes by the first clip: 38 characters in 3 s.
    assert zonos.rates == [None, pytest.approx(15 * 3.0 / len(QUESTION), abs=0.05)]


async def test_a_stalled_clip_teaches_no_rate():
    memory = questions.RateMemory()
    await ask(ScriptedWithSpans(STALL, question_clip(True, 3.0)), rates=memory)
    assert memory.frames_per_char("default_test|0.0") == pytest.approx(15 * 3.0 / len(QUESTION), abs=0.05)


async def test_no_rate_is_sent_without_a_memory_or_without_a_span():
    zonos = ScriptedWithSpans(question_clip(False), question_clip(True))
    await ask(zonos)
    assert zonos.rates == [None, None]
    statement = ScriptedWithSpans(question_clip(False))
    await ask(statement, QUESTION[:-1] + ".", rates=questions.RateMemory())
    assert statement.rates == [None]
