"""Questions the voice lifts: Zonos lets a yes/no question rise at its end in about one clip in five
(measured on the box, 2026-11-18), so the service asks for a lift on the last word of such a question
(`question_spans`) and judges the clip's end (`final_rise`)."""

import numpy as np
import pytest

from speech_service import questions
from tests.helpers import SR, question_clip, tone


def last_words(text: str, language: str = "en") -> list[str]:
    return [text[start:end] for start, end in questions.question_spans(text, language)]


# --- which questions are lifted ---------------------------------------------------------------


def test_a_yes_no_question_is_lifted_on_its_last_word():
    assert last_words("Did you find the file?") == ["file?"]


def test_a_hungarian_yes_no_question_is_lifted_on_its_last_word():
    assert last_words("Megtaláltad a fájlt?", "hu") == ["fájlt?"]


@pytest.mark.parametrize(
    "text",
    ["Where did you put it?", "How long does it take?", "WHO called this morning?", "Which one do you want?"],
)
def test_an_english_question_with_a_question_word_falls_and_is_left_alone(text):
    assert last_words(text) == []


@pytest.mark.parametrize(
    "text",
    ["Hová tetted?", "Miért nyitva az ajtó?", "Mennyi az idő?", "Melyiket kéred?", "Hogyan jutok oda?"],
)
def test_a_hungarian_question_with_a_question_word_falls_and_is_left_alone(text):
    assert last_words(text, "hu") == []


@pytest.mark.parametrize("text", ["It is ready.", "Ready!", "Is it ready?!", "Is it ready", "Wait…"])
def test_a_statement_or_a_mark_that_is_not_a_plain_question_mark_is_left_alone(text):
    assert last_words(text) == []


def test_each_question_of_a_unit_is_found_by_its_own_sentence():
    text = "Did you find it? Let me check. Is it ready? Where is it? Can you hear me?"
    assert last_words(text) == ["it?", "ready?", "me?"]


def test_a_quote_before_the_question_word_does_not_hide_it():
    assert last_words('"Where is it?"') == []
    assert last_words('"Is it ready?"') == ['ready?"']


def test_the_spans_are_character_offsets_into_the_text_and_never_cross_a_word():
    text = "Elolvassam a hosszabb változatot is?"
    ((start, end),) = questions.question_spans(text, "hu")
    assert text[start:end] == "is?" and (start == 0 or text[start - 1] == " ")


def test_the_controls_name_the_dose_and_the_span():
    text = "Is it ready?"
    assert questions.question_controls(text, "en", 5.0) == [
        {"start": 6, "end": 12, "controls": {"delivery.pitch": 5.0}}
    ]


def test_a_dose_of_nothing_asks_for_no_control():
    assert questions.question_controls("Is it ready?", "en", 0.0) == []


# --- the final rise ---------------------------------------------------------------------------


def test_a_question_that_rises_at_its_end_is_judged_to_rise():
    assert questions.final_rise(question_clip(True), SR) >= 5.0


def test_the_same_words_as_a_statement_do_not_rise():
    assert questions.final_rise(question_clip(False), SR) <= 0.5


def test_a_steady_tone_does_not_rise():
    assert abs(questions.final_rise(tone(0.3, 2.0), SR)) < 1.0


def test_a_clip_too_short_or_too_silent_to_judge_has_no_rise():
    assert questions.final_rise(tone(0.3, 0.3), SR) is None
    assert questions.final_rise(np.zeros(2 * SR, dtype=np.float32), SR) is None


def test_the_judge_is_quick():
    import time

    clip = question_clip(True, 8.0)
    started = time.perf_counter()
    questions.final_rise(clip, SR)
    assert time.perf_counter() - started < 0.5


# --- the rate a voice speaks at: where a span lands ------------------------------------------------
# Zonos places a span by its characters, at one frame a character unless told otherwise, and its codec
# runs at 15 frames a second: 15 characters a second. Berta and Imre speak at 15, and a span on their
# last word lands on it; Imogen speaks at 18, so a span on her last word lands after a long question
# has ended, and steers nothing (the share of long yes/no questions that rose stayed 17% with it).


def test_a_voice_that_has_not_been_heard_speaks_at_the_default_rate():
    assert questions.RateMemory().frames_per_char("a voice") == 1.0


def test_a_clip_teaches_the_rate_of_its_voice():
    memory = questions.RateMemory()
    memory.learn("a voice", chars=120, seconds=6.6)  # 18.2 characters a second
    assert memory.frames_per_char("a voice") == pytest.approx(15 * 6.6 / 120)
    assert memory.frames_per_char("another") == 1.0


def test_a_short_text_teaches_nothing():
    memory = questions.RateMemory()
    memory.learn("a voice", chars=20, seconds=2.0)
    assert memory.frames_per_char("a voice") == 1.0


def test_later_clips_move_the_rate_gradually():
    memory = questions.RateMemory()
    memory.learn("a voice", chars=100, seconds=5.0)  # 0.75 frames a character
    memory.learn("a voice", chars=100, seconds=6.0)  # 0.90
    assert memory.frames_per_char("a voice") == pytest.approx(0.75 * 0.7 + 0.90 * 0.3)


def test_a_rate_is_kept_within_what_a_voice_could_speak_at():
    memory = questions.RateMemory()
    memory.learn("fast", chars=100, seconds=0.5)
    memory.learn("slow", chars=100, seconds=60.0)
    assert memory.frames_per_char("fast") == 0.5
    assert memory.frames_per_char("slow") == 2.0
