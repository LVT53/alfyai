"""Questions the voice lifts.

Zonos lets a yes/no question rise at its end in about one clip in five (the owner's report of
2026-11-18: a long question "sounds like a normal statement"). The request carries the "?" and the
service passes it on, so the model is the cause. Measured on the box's own Zonos, on made-up
questions through the session route with four seeds, a question's last 150 ms is at least three
semitones above the lowest point of the second before it in this share of the clips (17% of
Imogen's yes/no questions and 6% of Berta's rise, against 6% and 2% of the same words as statements):

    English (Imogen), yes/no    short 33%  medium 4%  long 12%     (the same words as statements: 12, 0, 4%)
    Hungarian (Berta), yes/no   short 15%  medium 0%  long 4%      (statements: 5, 0, 0%)

On the Mac's build Imre's and Wyatt's yes/no questions rose in 0% and 4% of the clips. Question-word
questions (where, who, hogyan, miért) fall in English and Hungarian, and they do. Length decides
little, the voice more, and within a voice it is the seed, as it is for a stall.

So the service asks for a lift on the last word of a yes/no question (`question_controls`: Zonos's
`control_spans` with the `delivery.pitch` direction), and `steady.py` judges the end of a clip whose
text ends in such a question (`final_rise`) and makes it again under the next seed while it rises
less than `SPEECH_QUESTION_RISE` semitones, as it does a stall. A doubled mark ("??") was no use:
it helped English at the end of a unit only and Hungarian not at all.

A span is placed by its characters (`RateMemory`, below), and the judge is numpy alone, because the
service has no scipy or librosa: it agreed with librosa's pYIN on whether a clip rises by at least
three semitones in 91% of 398 clips (the other 9% split about evenly) and takes about 10 ms a clip.
Through the service on the Mac (18 yes/no questions a length and voice, three seeds), the share
that rise went from 22% to 81% in Imogen's voice and from 8% to 87% in Berta's.
"""

from __future__ import annotations

import re

import numpy as np

# The steering direction that moves the pitch of the frames made while the characters it covers are
# spoken (Zonos's `control_spans`; the ggml and MLX servers place a span by its characters).
LIFT_CONTROL = "delivery.pitch"

# Question words that start a question the voice lets fall: the other questions rise.
WH_WORDS: dict[str, frozenset[str]] = {
    "en": frozenset({"who", "whom", "whose", "what", "which", "when", "where", "why", "how"}),
    "hu": frozenset(
        {
            "ki", "kit", "kinek", "kié", "kiért", "kivel", "kiben", "kiről", "kihez", "kitől",
            "mi", "mit", "minek", "mivel", "miért", "miben", "miről", "mihez", "mitől",
            "mikor", "mikorra", "mióta", "meddig", "hol", "hová", "hova", "honnan", "merre",
            "hogyan", "hogy", "hány", "hányadik", "hányszor", "hányan", "mennyi", "mennyit",
            "mennyire", "mennyibe", "mennyivel", "melyik", "melyiket", "melyikben", "milyen",
            "miféle", "mekkora",
        }
    ),
}  # fmt: skip

_CLOSERS = "\"'”’»)]}"
# A word that ends a sentence, a closing quote or bracket allowed after the mark.
_ENDS_A_SENTENCE = re.compile(rf"[.!?…][{re.escape(_CLOSERS)}]*$")
# A word that ends in one plain question mark (not "??", "?!" or "…?").
_PLAIN_QUESTION = re.compile(rf"(?<![?!.…])\?[{re.escape(_CLOSERS)}]*$")


def question_spans(text: str, language: str) -> list[tuple[int, int]]:
    """The character spans of the last word of each yes/no question in `text`, in order.

    `text` is what Zonos is sent: the words with one space between. A sentence is a run of words
    that ends in a word that ends in `.`, `!`, `?` or `…`; it is a question when its last word ends
    in one plain `?`, and a yes/no question when its first word is not a question word.
    """
    wh = WH_WORDS.get(language, frozenset())
    spans: list[tuple[int, int]] = []
    first: str | None = None  # the first word of the sentence in progress, lower-cased and bare
    for word in re.finditer(r"\S+", text):
        if first is None:
            first = re.sub(r"^\W+|\W+$", "", word.group().lower())
        if _PLAIN_QUESTION.search(word.group()) and first not in wh:
            spans.append((word.start(), word.end()))
        if _ENDS_A_SENTENCE.search(word.group()):
            first = None
    return spans


def question_controls(text: str, language: str, dose: float) -> list[dict]:
    """Zonos's `control_spans` for `text`: `dose` of the lift over each yes/no question's last word.
    Nothing for a dose of nothing."""
    if dose <= 0:
        return []
    return [
        {"start": start, "end": end, "controls": {LIFT_CONTROL: dose}}
        for start, end in question_spans(text, language)
    ]


# --- where a span lands -------------------------------------------------------------------------
# Zonos places a span by its characters, one frame a character unless a request says otherwise
# (`control_span_rate`), and its codec runs at 15 frames a second: it expects 15 characters a second.
# Berta and Imre speak at 15, so a span on their last word lands on it. Imogen speaks at 18, so on a
# question of 120 characters the span lands a second after the clip has ended and steers nothing (the
# share of her long yes/no questions that rose stayed 17% with the lift). The service learns how fast
# each voice speaks from the clips it makes and tells Zonos.

FRAMES_PER_SECOND = 15.0  # the codec's `frame_rate`
_LEAST_CHARS = 30  # a shorter text says little of a voice's rate: the clip's ends are most of it
_BOUNDS = (0.5, 2.0)  # frames a character no voice speaks outside of
_WEIGHT = 0.3  # how much a new clip moves the rate


class RateMemory:
    """How fast each voice speaks, in frames of Zonos's codec per character, from the clips made."""

    def __init__(self) -> None:
        self._rates: dict[str, float] = {}

    def frames_per_char(self, key: str) -> float:
        """The rate of the voice `key`: 1.0, Zonos's own, until a clip has said otherwise."""
        return self._rates.get(key, 1.0)

    def learn(self, key: str, chars: int, seconds: float) -> None:
        """Take in a clip of `chars` characters that was `seconds` long and had no stall in it."""
        if chars < _LEAST_CHARS or seconds <= 0:
            return
        rate = min(max(FRAMES_PER_SECOND * seconds / chars, _BOUNDS[0]), _BOUNDS[1])
        old = self._rates.get(key)
        self._rates[key] = rate if old is None else old * (1 - _WEIGHT) + rate * _WEIGHT


# What the service's readings and previews share: one memory for the process.
RATES = RateMemory()


# --- the judge ----------------------------------------------------------------------------------

_FRAME = 0.04  # seconds of sound a pitch is read from
_HOP = 0.01
_PITCH_RANGE = (60.0, 500.0)  # Hz: a deep voice to a high one
_VOICED = 0.45  # the normalized autocorrelation a voiced frame must reach
_TAIL_FRAMES = 15  # the last 150 ms of voiced speech
_BEFORE_FRAMES = 100  # the second before it
_LEAST_VOICED = 40  # frames: less than 0.4 s of voiced speech is too little to judge


def _f0_track(audio: np.ndarray, rate: int) -> np.ndarray:
    """The pitch in Hz of every 10 ms frame of `audio`, nan where the frame is not voiced.

    Normalized autocorrelation by FFT over 40 ms frames, taking the first strong peak (the
    shortest period, not the highest peak: that is where octave errors come from), refined by a
    parabola; a frame far from the median of its neighbours is dropped as an octave jump."""
    step = max(1, round(rate / 11025))
    x = audio[: len(audio) // step * step].astype(np.float64)
    if step > 1:
        x = x.reshape(-1, step).mean(axis=1)
    sr = rate / step
    frame, hop = int(_FRAME * sr), int(_HOP * sr)
    if len(x) < frame + hop:
        return np.array([])
    frames = np.lib.stride_tricks.sliding_window_view(x, frame)[::hop]
    frames = (frames - frames.mean(axis=1, keepdims=True)) * np.hanning(frame)
    loud = np.sqrt((frames**2).mean(axis=1)) > 0.03 * np.sqrt((frames**2).mean(axis=1)).max()
    size = 1 << (2 * frame - 1).bit_length()
    correlation = np.fft.irfft(np.abs(np.fft.rfft(frames, size, axis=1)) ** 2, size, axis=1)
    shortest, longest = int(sr / _PITCH_RANGE[1]), min(int(sr / _PITCH_RANGE[0]), frame - 2)
    f0 = np.full(len(frames), np.nan)
    for i in range(len(frames)):
        if not loud[i] or correlation[i, 0] <= 0:
            continue
        lags = correlation[i, shortest - 1 : longest + 2] / correlation[i, 0]
        best = lags[1:-1].max()
        if best < _VOICED:
            continue
        for k in range(1, len(lags) - 1):
            if lags[k] >= 0.9 * best and lags[k] >= lags[k - 1] and lags[k] >= lags[k + 1]:
                a, b, c = lags[k - 1], lags[k], lags[k + 1]
                curve = a - 2 * b + c
                f0[i] = sr / (shortest - 1 + k + (0.5 * (a - c) / curve if curve else 0.0))
                break
    cleaned = f0.copy()
    for i in np.flatnonzero(~np.isnan(f0)):
        near = f0[max(0, i - 3) : i + 4]
        near = near[~np.isnan(near)]
        if len(near) >= 3:
            median = np.median(near)
            if not median / 1.7 <= f0[i] <= 1.7 * median:
                cleaned[i] = np.nan
    return cleaned


def final_rise(audio: np.ndarray, rate: int) -> float | None:
    """How far the pitch rises at the end of `audio`, in semitones: the median of its last 150 ms of
    voiced speech over the lowest point of the second before. A statement ends at its lowest point
    (0 or below); a question that was asked ends well above it. None when the clip has too little
    voiced speech to say."""
    f0 = _f0_track(audio, rate)
    voiced = np.flatnonzero(~np.isnan(f0))
    if len(voiced) < _LEAST_VOICED:
        return None
    semitones = 12 * np.log2(f0 / np.nanmedian(f0))
    smooth = semitones.copy()
    for i in voiced:  # a 5-frame median takes out the single frames a pitch tracker gets wrong
        smooth[i] = np.nanmedian(semitones[max(0, i - 2) : i + 3])
    tail = voiced[-_TAIL_FRAMES:]
    before = voiced[(voiced < tail[0]) & (voiced >= tail[0] - _BEFORE_FRAMES)]
    if len(tail) < _TAIL_FRAMES // 2 or len(before) < _LEAST_VOICED // 2:
        return None
    return float(np.median(smooth[tail]) - np.min(smooth[before]))
