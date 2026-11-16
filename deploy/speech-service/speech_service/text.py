"""What the voice will say: a sentence's written tokens turned into spoken words.

zyphra-textnorm writes the sentence out ("2 tojás" becomes "kettő tojás"), the Hungarian fix
turns its "kettő" into "két" where Hungarian says "két" ("két tojás"), and a difflib match on the
words' letters records which written token became which spoken words, so the reader can follow
the voice on the written text.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass
from typing import Literal, get_args

import zyphra_textnorm

Language = Literal["en", "hu"]
_LANGUAGES = get_args(Language)

# A word's match key: lowercase, with only word characters and "%" (the design spike's key()).
_NOT_IN_KEY = re.compile(r"[^\w%]")
_HAS_DIGIT = re.compile(r"\d")
# "kettő" is "két" inside a number word ("kettőezer-huszonhat" is "kétezer-huszonhat")...
_KETTO_IN_NUMBER = re.compile(r"kettő(?=ezer|száz|millió|milliárd)")
# ...and at the end of the number that counts the next word ("kettő tojás" is "két tojás"),
# whatever punctuation clings to the word.
_KETTO_AT_END = re.compile(r"kettő(?=\W*$)")
# A number written with one of these last is not counting the next word: "2022. december" is a
# year, "van 2, abból 3" is a list.
_CLAUSE_END = ".,;:!?"


@dataclass
class Spoken:
    """The words a sentence is spoken as, and which written token became which of them.

    `words` is exactly what Zonos is sent (joined with single spaces; punctuation stays attached to
    its word: "tojás,") and exactly what the aligner aligns. A word that is only symbols (an
    arrow, an emoji) is not in it: the voice does not say it.

    `token_spans[i]` is the half-open range `(start, end)` of `words` that written token `i`
    became, or `None` when it speaks as nothing. Tokens that became words together ("12", "990"
    and "Ft." became "tizenkettőezer-kilencszázkilencven forint.") all have the whole range. A
    word the normalizer added that no token owns stays in `words` and is in no span.
    """

    words: list[str]
    token_spans: list[tuple[int, int] | None]


def normalize(tokens: list[str], language: Language) -> Spoken:
    """The written `tokens` of one sentence (in order) as the words the voice will say.

    Raises ValueError for a language other than "en" and "hu".
    """
    if language not in _LANGUAGES:
        # zyphra-textnorm hands the text back unchanged for a language it has no grammar for
        # ("en_us" is Zonos's name for English, not the normalizer's), digits and all.
        raise ValueError(f"language must be one of {', '.join(_LANGUAGES)}, got {language!r}")
    words = _speak(" ".join(tokens), language)
    spans = _map_tokens(tokens, words)
    if language == "hu":
        words = _fix_hungarian(tokens, words, spans)
    return Spoken(words, spans)


def _key(text: str) -> str:
    """What a written token and a spoken word must share to count as the same word."""
    return _NOT_IN_KEY.sub("", text.lower())


def _speak(text: str, language: Language) -> list[str]:
    """The words the normalizer says for `text`, without the ones that are only symbols."""
    return [word for word in zyphra_textnorm.normalize(text, language).split() if _key(word)]


def _map_tokens(tokens: list[str], words: list[str]) -> list[tuple[int, int] | None]:
    """The range of `words` that each token became, found by matching tokens and words by key.

    A token and a word with the same key are the same word. Between two such pairs lies an
    unmatched run of tokens and an unmatched run of words: every token of the run gets all of its
    words, or None when it has none, and words left without a token are owned by nobody. A token
    with no key (a lone symbol) never enters the match and stays None.
    """
    speakable = [i for i, token in enumerate(tokens) if _key(token)]
    matcher = difflib.SequenceMatcher(
        a=[_key(tokens[i]) for i in speakable], b=[_key(word) for word in words], autojunk=False
    )
    spans: list[tuple[int, int] | None] = [None] * len(tokens)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                spans[speakable[i1 + k]] = (j1 + k, j1 + k + 1)
        elif tag == "replace":
            for k in range(i1, i2):
                spans[speakable[k]] = (j1, j2)
        # "delete": tokens with no word stay None. "insert": words with no token stay unowned.
    return spans


def _fix_hungarian(
    tokens: list[str], words: list[str], spans: list[tuple[int, int] | None]
) -> list[str]:
    """`words` with "kettő" made "két" where Hungarian says so; no word is added or removed.

    Only the words of a written token with a digit are touched (a "kettő" the writer typed stays),
    inside a number word and at the end of a number written straight before a word.
    """
    fixed = list(words)
    keys = [_key(word) for word in words]
    for i, token in enumerate(tokens):
        span = spans[i]
        if span is None or not _HAS_DIGIT.search(token):
            continue
        for j in range(*span):
            fixed[j] = _KETTO_IN_NUMBER.sub("két", fixed[j])
        if _stands_before_a_word(tokens, i):
            last = _last_word_of(tokens, i, keys)
            # The match and the sentence's prefix find the token's words independently: if they
            # disagree, leave the word be.
            if last is not None and span[0] <= last < span[1]:
                fixed[last] = _KETTO_AT_END.sub("két", fixed[last])
    return fixed


def _stands_before_a_word(tokens: list[str], i: int) -> bool:
    """Whether token `i` is written straight before a word: "2 tojás", but not "2." or "2,"."""
    return (
        i + 1 < len(tokens)
        and tokens[i + 1][:1].isalpha()
        and tokens[i][-1] not in _CLAUSE_END
    )


def _last_word_of(tokens: list[str], i: int, keys: list[str]) -> int | None:
    """The index in the sentence's words of the last word token `i` became, or None if unsure.

    The token's span cannot say: tokens that became words together share their whole range ("2"
    and "kg" both have "kettő kilogramm"), so the span's last word may belong to a later token.
    The sentence up to and including the token can: its words end where the token's do. They count
    only if they are also the words the whole sentence starts with, because a number can read
    differently once what follows it is cut off ("2022." before a month is a year, at the end of
    the text it is the 2022nd).
    """
    prefix = [_key(word) for word in _speak(" ".join(tokens[: i + 1]), "hu")]
    return len(prefix) - 1 if prefix and prefix == keys[: len(prefix)] else None
