"""Steady clips: when Zonos stalls on a sentence, the sentence is made again with another seed.

A stall is a clip with a long silence inside it, or one far longer than its words need (a runaway
one runs on to the 100 s at which the model stops). It comes from the model's sampling, not from the
text or the voice's controls: the same sentence stalls under one seed and not under the next, with
no control at all. It is a short sentence's trouble. On Zonos MLX (the Mac's build), a third of 204
clips of sentences under 45 characters stalled, more than half of Imre's, and 90 s of speech came
out of one sentence of 22 characters; of 156 clips of sentences of 77 characters or more, two did.
The box's build was not measured when this was written (the service logs how many clips it made
again, so its journal says how often that is there). The service therefore measures each clip, and
one in trouble is made again under the next seed, up to a few times; the clip least in trouble is
the one that is spoken. The same 204 clips, made through this module with four attempts allowed,
stalled 5 times (2.5%), at 1.7 attempts a clip.

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
# each language). A voice's tempo control stretches or squeezes all of it, pauses included.
_START_SECONDS = 0.4
_SECONDS_PER_CHARACTER = {"en": 0.080, "hu": 0.090}
_TEMPO_SLOPE = 0.16
_TEMPO_CONTROL = "delivery.tempo"

# A silence is a run of 20 ms frames more than 40 dB under the clip's 90th-percentile frame level.
_FRAME_SECONDS = 0.02
_QUIET_BELOW_P90_DB = 40.0


class _Synthesizer(Protocol):
    async def synthesize(
        self, text: str, language: str, voice: Voice, seed: int
    ) -> tuple[np.ndarray, int]: ...


def _longest_run(flags: np.ndarray) -> int:
    """The longest run of True in `flags`."""
    if not flags.any():
        return 0
    padded = np.concatenate(([False], flags, [False]))
    edges = np.flatnonzero(padded[1:] != padded[:-1])
    return int((edges[1::2] - edges[0::2]).max())


def longest_pause(audio: np.ndarray, rate: int) -> float:
    """The longest silence inside `audio`, in seconds: between its first and its last speech, so the
    silence at its ends does not count. 0 for a clip too short or too silent to measure."""
    frame = max(1, round(_FRAME_SECONDS * rate))
    count = len(audio) // frame
    if count < 3:
        return 0.0
    frames = audio[: count * frame].astype(np.float64).reshape(count, frame)
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    level = 20.0 * np.log10(np.maximum(rms, 1e-9))
    quiet = level < np.percentile(level, 90) - _QUIET_BELOW_P90_DB
    speech = np.flatnonzero(~quiet)
    if speech.size == 0:
        return 0.0
    return _longest_run(quiet[speech[0] : speech[-1] + 1]) * frame / rate


def _tempo_factor(tempo: float) -> float:
    return math.exp(-_TEMPO_SLOPE * tempo)


def expected_seconds(chars: int, language: str, tempo: float = 0.0) -> float:
    """How long a sentence of `chars` characters (as it is spoken) is expected to take, at `tempo`
    (the voice's `delivery.tempo`, 0 when it has none). A generous figure: clean clips come in
    under it."""
    per_character = _SECONDS_PER_CHARACTER.get(language, max(_SECONDS_PER_CHARACTER.values()))
    return (_START_SECONDS + per_character * chars) * _tempo_factor(tempo)


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
    on_retry: Callable[[int, int, float, float], None] | None = None,
) -> tuple[np.ndarray, int]:
    """`text` spoken in `voice`, made again under the next seed while the clip is in trouble.

    Up to `attempts` clips are made (1 is no retry at all). The first steady clip is the answer;
    when none is, the clip least in trouble. A failure of the first attempt is the caller's, as it
    is without a guard. A failure of a later attempt is not: a stalled clip is better than none, so
    it stays the answer. `on_retry(attempt, attempts, seconds, pause)` is called, with numbers only,
    each time a clip is given up on and another is about to be made.
    """
    chars = len(text)
    tempo = float(voice.controls.get(_TEMPO_CONTROL, 0.0))
    best: tuple[float, np.ndarray, int] | None = None
    for attempt in range(max(1, attempts)):
        try:
            audio, rate = await zonos.synthesize(text, language, voice, seed + attempt * SEED_STEP)
        except ZonosError:
            if best is None:
                raise
            break
        score = trouble(audio, rate, chars, language, tempo)
        if best is None or score < best[0]:
            best = (score, audio, rate)
        if score == 0.0:
            break
        if attempt + 1 < attempts and on_retry is not None:
            on_retry(attempt + 1, attempts, len(audio) / rate, longest_pause(audio, rate))
    assert best is not None  # the loop runs at least once, and the first failure was raised
    return best[1], best[2]
