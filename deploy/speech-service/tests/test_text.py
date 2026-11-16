"""Text: the words the voice says for a sentence's written tokens, and which token became which."""

import pytest
import zyphra_textnorm

from speech_service.text import normalize


def spoken(text: str) -> str:
    """The Hungarian sentence as the voice will say it."""
    return " ".join(normalize(text.split(), "hu").words)


# The normalizer and the Hungarian fix: "két" before a counted word and inside a number.


def test_two_eggs():
    assert "két tojás" in spoken("A recepthez 2 tojás kell.")


def test_year():
    assert "kétezer-huszonhat" in spoken("A határidő 2026. december 3-án van.")


def test_forint():
    assert spoken("A jegy ára 12 990 Ft.").count("tizenkétezer") == 1


def test_degrees():
    assert "hét és tizenkét fok" in spoken("Holnap 7 és 12 fok lesz.")


def test_written_word_kept():
    assert "a kettő között" in spoken("Válassz a kettő között.").lower()


def test_lone_kettő_kept():
    assert spoken("Ebből van 2.").rstrip(".").endswith("kettő")


def test_english_untouched():
    assert "two eggs" in " ".join(normalize("It needs 2 eggs.".split(), "en").words)


def test_a_year_before_a_month_stays_a_year():
    # "2022." is a year here: its dot says it does not count the month, so only the inside changes.
    assert spoken("A 2022. december 3-án.") == "A kétezer-huszonkettő december harmadikán."


def test_two_before_a_unit_but_not_before_a_decimal_part():
    # "2" and "kg" are one unmatched run, so both tokens have both spoken words as their span.
    assert spoken("Ez 2 kg és 2,5 l.") == "Ez két kilogramm és kettő egész öt tized liter."


def test_two_million_forints():
    # "Kb." shares its run with "12000": the inside of "tizenkettőezer" is fixed all the same.
    assert (
        spoken("Kb. 12000 fő és 2 millió Ft.") == "körülbelül tizenkétezer fő és két millió forint."
    )


def test_a_number_ending_in_a_comma_is_not_counting_the_next_word():
    assert spoken("Ebből van 2, abból 3.") == "Ebből van kettő, abból három."


def test_a_written_kettő_beside_a_number_is_kept():
    assert spoken("A kettő és a 2 tojás.") == "A kettő és a két tojás."


def test_a_number_the_normalizer_reads_two_ways_is_left_as_spoken(monkeypatch):
    # With the rest of the sentence cut off, "2" is read as "kettedik": the normalizer disagrees
    # with itself about where "2" ends, so "kettő" stays.
    said = {"A 2 tojás": "A kettő tojás", "A 2": "A kettedik"}
    monkeypatch.setattr(zyphra_textnorm, "normalize", lambda text, language: said[text])
    assert normalize(["A", "2", "tojás"], "hu").words == ["A", "kettő", "tojás"]


# Which written token became which spoken words.


def test_block_shares_span():
    sp = normalize("A jegy ára 12 990 Ft.".split(), "hu")
    # "12", "990" and "Ft." are one unit.
    assert sp.token_spans[3] == sp.token_spans[4] == sp.token_spans[5]


def test_unspeakable_tokens_get_null_spans():
    sp = normalize(["Nézd", "→", "itt."], "hu")
    assert sp.token_spans[1] is None and sp.token_spans[0] is not None


def test_symbols_are_not_spoken():
    sp = normalize(["Nézd", "→", "itt.", "😀"], "hu")
    assert sp.words == ["Nézd", "itt."]
    assert sp.token_spans == [(0, 1), None, (1, 2), None]


def test_a_symbol_inside_an_unmatched_run_gets_no_span():
    sp = normalize("A jegy ára 12 → 990 Ft.".split(), "hu")
    assert sp.token_spans[4] is None
    assert sp.token_spans[3] is not None
    assert sp.token_spans[3] == sp.token_spans[5] == sp.token_spans[6]


def test_an_unmatched_token_gets_null_and_an_added_word_has_no_owner(monkeypatch):
    monkeypatch.setattr(zyphra_textnorm, "normalize", lambda text, language: "a b extra c")
    sp = normalize(["a", "gone", "b", "c"], "en")
    assert sp.words == ["a", "b", "extra", "c"]
    assert sp.token_spans == [(0, 1), None, (1, 2), (3, 4)]


@pytest.mark.parametrize(
    "language, text",
    [
        ("hu", "A recepthez 2 tojás kell."),
        ("hu", "A határidő 2026. december 3-án van."),
        ("hu", "A jegy ára 12 990 Ft."),
        ("hu", "Ez 2 kg és 2,5 l."),
        ("hu", "Kb. 12000 fő és 2 millió Ft."),
        ("hu", "Az ára 12 002 Ft."),
        ("en", "It needs 2 eggs, 250 grams and 1.5 dl on December 3, 2026 at 4 p.m."),
    ],
)
def test_the_fix_adds_no_word_and_every_span_stays_inside_the_words(language, text):
    sp = normalize(text.split(), language)
    assert len(sp.words) == len(zyphra_textnorm.normalize(text, language).split())
    spans = [span for span in sp.token_spans if span is not None]
    assert all(0 <= start < end <= len(sp.words) for start, end in spans)
    assert [start for start, _ in spans] == sorted(start for start, _ in spans)


def test_a_language_the_normalizer_has_no_grammar_for_is_refused():
    # zyphra_textnorm hands the text back unchanged for "en_us" instead of failing.
    with pytest.raises(ValueError, match="en_us"):
        normalize(["It", "needs", "2", "eggs."], "en_us")  # type: ignore
