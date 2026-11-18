"""Steady clips: when Zonos stalls on a sentence, the sentence is made again with another seed.

A stall is a clip with a long silence inside it, or one far longer than its words need (a runaway
one runs on to the 100 s at which the model stops). It comes from the model's sampling, not from the
text or from any style: the same sentence stalls under one seed and not under the next, with no
control at all, and no style's doses raise the rate. (A voice's default control can: the studio
`room.clean` 2 of Imre and Berta took short clips from 32% to 55% and from 29% to 38%, in 84 clips
each.) It is a short sentence's trouble. On Zonos MLX (the Mac's build), a third of 204 clips of
sentences under 45 characters stalled, more than half of Imre's, and 90 s of speech came out of one
sentence of 22 characters; of 156 clips of sentences of 77 characters or more, two did. The box's
build was not measured when this was written (the service logs how many clips it made again, so its
journal says how often that is there). The service therefore measures each clip, and one in trouble
is made again under the next seed, up to a few times; the clip least in trouble is the one that is
spoken. The same 204 clips, made through this module with four attempts allowed, stalled 5 times
(2.5%), at 1.7 attempts a clip.

A text of a word or two is the worst case. On the Mac's build 85 to 90% of the clips of fragments
of three to sixteen characters in Berta's and Imre's voices came out far longer than their words
(the median clip of "Igen." is 4.6 s, of "Rendben." 6.9 s, the longest 28 s), 82% in Wyatt's and
42% in Imogen's: the voice goes on speaking after the text is done, and on staging a selection of a
few words was read with a sentence the text never held after it. The guard sees that by the length
alone, so an addition inside a long sentence passes it (only a speech recognizer would hear that
one). The retries mend what they can, but at those rates most chains of four fail too: the cure is
not to send so little text, and the speech script no longer does (`src/lib/client/read-aloud/short-
sentences.ts` joins a sentence, a list item or a one-line paragraph under 50 characters to a
neighbour). A sentence of 50 characters or more stalls in about one clip in a hundred, one of 40 to
49 in about one in fourteen.

Nor can it see the opposite: a clip that leaves out the last words of a text that ends in no mark
(the walk's "Egy csipet só", the last item of a list, was never said; the same text ending in a full
stop is read in full) is not longer than its text needs. On the Mac, at the service's own seed, 1 of
20 Hungarian list tails dropped its last item with no stop and none of 20 with one. So the speech
script ends every unit in a stop (`speech-script.ts`, `closeSentences`), and the service is sent
nothing else.

The seeds are the caller's seed and then steps of `SEED_STEP` from it, so a reading is as repeatable
as one with no guard: the same sentence in the same voice stalls or not, and is mended, the same way
every time. A clip with no trouble costs one attempt, which is nearly every clip of a long sentence.

What is measured is a clip as Zonos made it, before it is trimmed or matched in loudness:
- its length against what the sentence's characters need, at most `LENGTH_RATIO` times
  `expected_seconds`;
- its longest silence inside the speech, at most `GAP_SECONDS`.
The limits were chosen on 324 clips of sentences under 100 characters in the six voices: 70 of them
stalled, and the limits flag 68 of those at the first attempt and 9 of the 254 clips that did not.

Nothing here logs. The caller says what it wants said, with numbers only (never the text).
"""

from __future__ import annotations

import math
from collections.abc import Callable
from typing import Protocol

import numpy as np

from speech_service import questions
from speech_service.audio import inner_silences, trim_silence
from speech_service.models import Voice
from speech_service.zonos import ZonosError

# The seeds of the attempts are `seed + attempt * SEED_STEP`: the step the knob sweep also takes.
SEED_STEP = 7919
# A clip is in trouble when it is longer than this many times what its sentence is expected to take.
LENGTH_RATIO = 1.4
# A clip is in trouble when it holds a silence longer than this many seconds, between its first and
# its last speech. A speaker's pause at a comma is half of it.
GAP_SECONDS = 0.8

# What a sentence takes: a start-up, and a time for each character (the slowest clean rate seen in
# each language), and never less than a word takes with the silence round it (a clean clip of "Yes."
# is a second or more). A voice's tempo control stretches or squeezes all of it, pauses included.
_START_SECONDS = 0.4
_LEAST_SECONDS = 1.3
_SECONDS_PER_CHARACTER = {"en": 0.080, "hu": 0.090}
_TEMPO_SLOPE = 0.16
_TEMPO_CONTROL = "delivery.tempo"



class _Synthesizer(Protocol):
    async def synthesize(
        self, text: str, language: str, voice: Voice, seed: int
    ) -> tuple[np.ndarray, int]: ...


# What a clip of a yes/no question that ends flat scores: in trouble, but less than any stall (which
# scores above 1), so a steady flat clip is a better answer than a stalled one.
FLAT_QUESTION = 1.0


def longest_pause(audio: np.ndarray, rate: int) -> float:
    """The longest silence inside `audio`, in seconds: between its first and its last speech, so the
    silence at its ends does not count. 0 for a clip too short or too silent to measure."""
    return max((end - start for start, end in inner_silences(audio, rate)), default=0) / rate


def _tempo_factor(tempo: float) -> float:
    return math.exp(-_TEMPO_SLOPE * tempo)


def expected_seconds(chars: int, language: str, tempo: float = 0.0) -> float:
    """How long a sentence of `chars` characters (as it is spoken) is expected to take, at `tempo`
    (the voice's `delivery.tempo`, 0 when it has none). A generous figure: clean clips come in
    under it."""
    per_character = _SECONDS_PER_CHARACTER.get(language, max(_SECONDS_PER_CHARACTER.values()))
    return max(_LEAST_SECONDS, _START_SECONDS + per_character * chars) * _tempo_factor(tempo)


def trouble(audio: np.ndarray, rate: int, chars: int, language: str, tempo: float = 0.0) -> float:
    """0 for a steady clip. For one in trouble, how far past its limits it is: the larger of its
    length and its longest pause, each as a multiple of its limit (always above 1)."""
    length = len(audio) / rate / (LENGTH_RATIO * expected_seconds(chars, language, tempo))
    # A slow voice pauses slowly too; a fast one is not asked to pause less.
    pause = longest_pause(audio, rate) / (GAP_SECONDS * max(1.0, _tempo_factor(tempo)))
    worst = max(length, pause)
    return worst if worst > 1.0 else 0.0


async def synthesize_steady(
    zonos: _Synthesizer,
    text: str,
    language: str,
    voice: Voice,
    seed: int,
    attempts: int,
    on_retry: Callable[[int, int, float, float, float], None] | None = None,
    question_lift: float = 0.0,
    question_rise: float = 0.0,
    on_flat: Callable[[int, int, float], None] | None = None,
    rates: questions.RateMemory | None = None,
) -> tuple[np.ndarray, int]:
    """`text` spoken in `voice`, made again under the next seed while the clip is in trouble.

    Up to `attempts` clips are made (1 is no retry at all). The first steady clip is the answer;
    when none is, the clip least in trouble. A failure of the first attempt is the caller's, as it
    is without a guard. A failure of a later attempt is not: a stalled clip is better than none, so
    it stays the answer. `on_retry(attempt, attempts, seconds, pause, expected)` is called, with
    numbers only (the clip's length, its longest silence and the length its text needs), each time a
    clip is given up on and another is about to be made.

    A yes/no question is also asked to rise (`questions.py`): `question_lift` is the dose of the
    pitch steering over its last word (0 asks for none), and when the text ends in such a question
    a steady clip whose end rises less than `question_rise` semitones counts as in trouble (0 never
    judges), less than a stall is. `on_flat(attempt, attempts, rise)` is called, with numbers only,
    each time a clip is given up on for that and another is about to be made. With a `rates` memory
    the lift goes by how fast the voice has been heard to speak (a span is placed by its characters,
    and voices differ), and every clip without a stall teaches the memory.
    """
    chars = len(text)
    tempo = float(voice.controls.get(_TEMPO_CONTROL, 0.0))
    spans = questions.question_controls(text, language, question_lift)
    asked = questions.question_spans(text, language)
    judged = question_rise > 0 and bool(asked) and asked[-1][1] == len(text.rstrip())
    voice_key = f"{voice.speaker_id}|{tempo}"
    best: tuple[float, np.ndarray, int] | None = None
    for attempt in range(max(1, attempts)):
        extra: dict[str, object] = {}
        if spans:
            extra["control_spans"] = spans
            if rates is not None and abs(rates.frames_per_char(voice_key) - 1.0) > 0.02:
                extra["control_span_rate"] = rates.frames_per_char(voice_key)
        try:
            audio, rate = await zonos.synthesize(
                text, language, voice, seed + attempt * SEED_STEP, **extra
            )
        except ZonosError:
            if best is None:
                raise
            break
        score = trouble(audio, rate, chars, language, tempo)
        if score == 0.0 and rates is not None:  # the speech, not the silence round it
            rates.learn(voice_key, chars, len(trim_silence(audio, rate)) / rate)
        rise = None
        if score == 0.0 and judged:
            rise = questions.final_rise(audio, rate)
            if rise is not None and rise < question_rise:
                score = FLAT_QUESTION
        if best is None or score < best[0]:
            best = (score, audio, rate)
        if score == 0.0:
            break
        if attempt + 1 < attempts:
            if score == FLAT_QUESTION and rise is not None:
                if on_flat is not None:
                    on_flat(attempt + 1, attempts, rise)
            elif on_retry is not None:
                on_retry(
                    attempt + 1,
                    attempts,
                    len(audio) / rate,
                    longest_pause(audio, rate),
                    expected_seconds(chars, language, tempo),
                )
    assert best is not None  # the loop runs at least once, and the first failure was raised
    return best[1], best[2]
