"""What a reading is made of: the voice that speaks and the sentences it reads."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class Voice:
    """A Zonos speaker and the controls that shape it. The controls go to Zonos unchanged."""

    speaker_id: str
    controls: dict[str, float]


@dataclass(frozen=True)
class Sentence:
    """One sentence of a reply, as AlfyAI's server sends it.

    `tokens` are the written words in order; the reader follows them on screen. `paragraph_start`
    is true for the first sentence of a paragraph, which gets the longer gap before it.
    """

    id: str
    language: Literal["en", "hu"]
    voice: Voice
    tokens: list[str]
    paragraph_start: bool
