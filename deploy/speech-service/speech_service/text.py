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

# A word's match key: lowercase, with only word characters and "%" (the design spike's key()),
# except that an underscore is none: "___" is a blank to fill in, not a word to say.
_NOT_IN_KEY = re.compile(r"[^\w%]|_")
_HAS_DIGIT = re.compile(r"\d")
_ONLY_DIGITS = re.compile(r"\d+")
# A token that starts with a digit, not counting the punctuation before it: "(2%)", but not "CO2".
_STARTS_WITH_DIGIT = re.compile(r"\W*\d")
# "kettő" is "két" inside a number word, however it is inflected: before ezer, ezr- (kettőezres,
# kettőezredik), száz and milli- (millió, milliárd, kettőmilliomodik).
_KETTO_IN_NUMBER = re.compile(r"kettő(?=ezer|ezr|száz|milli)")
# ...and at the end of a number that counts what follows ("kettő tojás" is "két tojás"); a word
# with punctuation after "kettő" ("kettő,") ends its clause and stays.
_KETTO_AT_END = re.compile(r"kettő$")
# Four-digit numbers that read as a year ("2022 óta"), not as a count.
_LIKELY_YEARS = range(1900, 2100)
# Words a number before them does not count: postpositions, conjunctions, operators, copulas, ...
_NOT_COUNTED = frozenset(
    {
        # "2 után", "2 körül", "2 között"
        "után", "előtt", "óta", "körül", "felé", "között", "közül", "alatt", "fölött", "felett",
        "mellett", "múlva", "helyett", "nélkül", "szerint", "miatt", "által", "ellen", "iránt",
        "mögött",
        # "2 és 3", "2 plusz 2": the normalizer reads "*" and "×" as "szorozva"; "x" is as typed
        "és", "vagy", "meg", "illetve", "plusz", "mínusz", "szor", "szorozva", "x", "osztva",
        "egyenlő",
        # "a válasz 2 lett"
        "van", "vannak", "volt", "voltak", "lesz", "lesznek", "lett", "lettek", "marad", "maradt",
        "kell",
        # ... and particles: "Ebből 2 is elég", "2 nem elég", "a válasz 2 lehet", "2 stb." (which
        # the normalizer reads "s a többi")
        "is", "sem", "nem", "de", "pedig", "viszont", "lehet", "legyen", "már", "még", "csak",
        "azaz", "stb", "s",
        # ... and the connectives and adverbs that join or comment: "2 valamint 3", "2 vagyis"
        "valamint", "továbbá", "vagyis", "ugyanis", "szintén",
        # ... and comparisons and "about": "2 kisebb mint 3", "2 nagyobb", "2 körülbelül elég"
        "kisebb", "nagyobb", "körülbelül", "mint",
    }
)  # fmt: skip
# Where a "kettő" inside one token counts nothing: the decimal point, the dot of 1.2.3, a month.
_NOT_COUNTED_IN_A_TOKEN = frozenset(
    {
        "egész", "pont", "január", "február", "március", "április", "május", "június", "július",
        "augusztus", "szeptember", "október", "november", "december",
    }
)  # fmt: skip
# What number words begin with: a "kettő" that a number word follows is part of a longer number.
_NUMBER_WORDS = (
    "egy", "kettő", "két", "három", "négy", "öt", "hat", "hét", "nyolc", "kilenc", "tíz", "tizen",
    "húsz", "huszon", "harminc", "negyven", "ötven", "hatvan", "hetven", "nyolcvan", "kilencven",
    "száz", "ezer", "millió", "milliárd", "nulla",
)  # fmt: skip
# Words that begin like a number word and are none: "2%" is "kettő százalék", not "kettő száz...".
_NOT_NUMBER_WORDS = ("százalék",)


@dataclass
class Spoken:
    """The words a sentence is spoken as, and which written token became which of them.

    `words` is exactly what Zonos is sent (joined with single spaces; punctuation stays attached to
    its word: "tojás,") and exactly what the aligner aligns. A word that is only symbols (an
    arrow, an emoji) is not in it: the voice does not say it.

    `token_spans[i]` is the half-open range `(start, end)` of `words` that written token `i`
    became, or `None` when it speaks as nothing. Tokens that became words together ("12", "990"
    and "Ft." became "tizenkétezer-kilencszázkilencven forint.") all have the whole range. A
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
    and "két" is only said when that is sure; otherwise the normalizer's "kettő" stays:
    - inside a number word: kettőezer-huszonhat, kettőezres, kettőmilliomodik;
    - at the end of a plain number (digits only, no year) written straight before a word it counts,
      a lowercase spoken word that is no postposition, conjunction, adverb, comparison, operator,
      copula or particle: két tojás;
    - inside one token that starts with a number and reads as several words, before the word it
      counts: 2% is két százalék.
    """
    fixed = list(words)
    keys = [_key(word) for word in words]
    for i, token in enumerate(tokens):
        span = spans[i]
        if span is None or not _HAS_DIGIT.search(token):
            continue
        for j in range(*span):
            fixed[j] = _KETTO_IN_NUMBER.sub("két", fixed[j])
        end = _words_through(tokens, i, keys)
        # The match and the sentence's prefix find the token's words independently. If they do not
        # agree, nothing says which words are the token's: leave them as the normalizer said.
        if end is None or not span[0] < end <= span[1]:
            continue
        if (
            _is_counting_number(token)
            and _is_followed_by_a_word(tokens, i)
            and _is_counted(words, end)
        ):
            fixed[end - 1] = _KETTO_AT_END.sub("két", fixed[end - 1])
        # Inside one token that starts with a number and reads as several words, the token's own
        # words are start..end, and the last of them has no own word after it. In a name that holds
        # a number (CO2-kibocsátás, B12-vitamin) the number names something, it counts nothing.
        if not _STARTS_WITH_DIGIT.match(token):
            continue
        start = _words_through(tokens, i - 1, keys)
        if start is not None and span[0] <= start:
            for j in range(start, end - 1):
                if _is_counted_in_the_token(words[j + 1]):
                    fixed[j] = _KETTO_AT_END.sub("két", fixed[j])
    return fixed


def _is_counting_number(token: str) -> bool:
    """Whether the written token is a plain number: digits only, and not a likely year."""
    if not _ONLY_DIGITS.fullmatch(token):
        return False
    return not (len(token) == 4 and int(token) in _LIKELY_YEARS)


def _is_followed_by_a_word(tokens: list[str], i: int) -> bool:
    """Whether the next written token after token `i` is a word that is said straight after it.

    It must exist, hold a word and not a lone symbol (a symbol is not spoken, so the spoken word
    after it would be read past it: "2 – 3 tojás", "2 > 1"), and not start with a digit (a list of
    numbers: "2 7 12 23"). So "2 € kell" stays "kettő euró": nothing tells that "euró" is counted.
    """
    if i + 1 >= len(tokens):
        return False
    following = tokens[i + 1]
    return bool(_key(following)) and not _STARTS_WITH_DIGIT.match(following)


def _can_be_counted(word: str) -> bool:
    """Whether `word` is a lowercase word that a number before it can count."""
    return word[:1].islower() and _key(word) not in _NOT_COUNTED


def _is_counted(words: list[str], end: int) -> bool:
    """Whether the spoken word just after a number (at index `end`) is one that it counts."""
    return end < len(words) and _can_be_counted(words[end])


def _is_counted_in_the_token(word: str) -> bool:
    """Whether `word`, after a "kettő" in the same written token, is one that the "kettő" counts:
    not a decimal point, a dot, a month or another number word.
    """
    key = _key(word)
    is_number_word = key.startswith(_NUMBER_WORDS) and not key.startswith(_NOT_NUMBER_WORDS)
    return _can_be_counted(word) and key not in _NOT_COUNTED_IN_A_TOKEN and not is_number_word


def _words_through(tokens: list[str], i: int, keys: list[str]) -> int | None:
    """How many of the sentence's words tokens `0..i` became, or None if that cannot be told.

    A token's span cannot say where its own words end: tokens that became words together share
    their whole range ("2" and "kg" both have "kettő kilogramm"). The sentence up to and including
    the token can: its words end where the token's do. They count only if they are also the words
    the whole sentence starts with, because a number can read differently once what follows it is
    cut off ("2022." before a month is a year, at the end of the text it is the 2022nd). `i = -1`
    is the empty start of the sentence: no word.
    """
    prefix = [_key(word) for word in _speak(" ".join(tokens[: i + 1]), "hu")]
    return len(prefix) if prefix == keys[: len(prefix)] else None
