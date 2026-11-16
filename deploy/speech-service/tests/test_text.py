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


# Inside a number word "két" is the only way, however the word is inflected or made ordinal.


@pytest.mark.parametrize(
    "text, said",
    [
        ("A 2000-es években.", "A kétezres években."),
        ("2000-et fizettem.", "kétezret fizettem."),
        ("A 2000. évben.", "A kétezredik évben."),
        ("A 2000000. látogató volt.", "A kétmilliomodik látogató volt."),
    ],
)
def test_inflected_and_ordinal_number_words_say_két(text, said):
    assert "kettőezr" not in spoken(text) and "kettőmill" not in spoken(text)
    assert spoken(text) == said


# A number says "két" only when it counts the word after it, and only when that is sure.


@pytest.mark.parametrize(
    "text, said",
    [
        ("12 után jövök.", "tizenkettő után jövök."),
        ("Délután 2 körül jövök.", "Délután kettő körül jövök."),
        ("Csak 2 közül választhatsz.", "Csak kettő közül választhatsz."),
        ("A válasz 2 lett.", "A válasz kettő lett."),
        ("Ebből 2 van raktáron.", "Ebből kettő van raktáron."),
        ("2 és 3 között.", "kettő és három között."),
        # Nothing follows the number, or only a stray comma, which clings to "kettő" and ends it.
        ("Ebből van 2", "Ebből van kettő"),
        ("Ebből van 2 , abból sok.", "Ebből van kettő, abból sok."),
        # A likely year is not a count, but the inside of it is still fixed.
        ("2022 óta itt élek.", "kétezer-huszonkettő óta itt élek."),
        ("2012 végén költöztünk.", "kétezer-tizenkettő végén költöztünk."),
        ("2022 januárjában.", "kétezer-huszonkettő januárjában."),
        # The edges of the year range: 1902 and 2092 are in it (1900 and 2099 end in no "kettő").
        ("Vettem 1902 almát.", "Vettem ezerkilencszázkettő almát."),
        ("Vettem 2092 almát.", "Vettem kétezer-kilencvenkettő almát."),
        # The next spoken word is no lowercase word; the written token is no plain number.
        ("Az iPhone 12 Pro drága.", "Az iPhone tizenkettő Pro drága."),
        ("A CO2 kibocsátás nő.", "A C O kettő kibocsátás nő."),
        ("A2 szintű nyelvvizsga.", "A kettő szintű nyelvvizsga."),
        # A list marker is no count either.
        ("A lista: 1) alma, 2) körte.", "A lista: egy) alma, kettő) körte."),
        # Particles, adverbs and more copulas; "stb." is read "s a többi".
        ("Ebből 2 is elég.", "Ebből kettő is elég."),
        ("Ebből 2 nem elég.", "Ebből kettő nem elég."),
        ("A válasz 2 lehet.", "A válasz kettő lehet."),
        ("Ez 2 stb. kell.", "Ez kettő s a többi kell."),
    ],
)
def test_a_number_that_counts_nothing_stays_kettő(text, said):
    assert spoken(text) == said


@pytest.mark.parametrize(
    "text, said",
    [
        # A symbol is not spoken: the word after it is not what the number stands before.
        ("Ez 2 – 3 tojás.", "Ez kettő három tojás."),
        ("A válasz 2 — nem 3.", "A válasz kettő nem három."),
        ("Mivel 2 > 1, igaz.", "Mivel kettő egy, igaz."),
        ("Ez 2 → 3 lépés.", "Ez kettő három lépés."),
        ("Ez 2 • alma.", "Ez kettő alma."),
        # A number written before a number is a list.
        ("Nyerőszámok: 2 7 12 23.", "Nyerőszámok: kettő hét tizenkettő huszonhárom."),
        ("Számolj: 1 2 3.", "Számolj: egy kettő három."),
        # ...also when the second number has a symbol in front of it: "$5" is a number, not a word.
        ("Ez 2 $5 értékű.", "Ez kettő öt dollár értékű."),
    ],
)
def test_a_number_before_a_symbol_or_another_number_stays_kettő(text, said):
    assert spoken(text) == said


@pytest.mark.parametrize(
    "text, said",
    [
        ("A jegy ára 2 Ft.", "A jegy ára két forint."),
        ("22 alma kell.", "huszonkét alma kell."),
        ("A 102 éves néni 2 macskája.", "A százkét éves néni két macskája."),
        ("Az ára 12 002 Ft.", "Az ára tizenkétezer-két forint."),
        ("2 hét múlva jövök.", "két hét múlva jövök."),
        ("Ez 2 % kedvezmény.", "Ez két százalék kedvezmény."),
        # A number word that follows is no reason: it is a count of thousands and millions.
        ("Ez 2 ezer Ft.", "Ez két ezer forint."),
        ("Ez 2 millió Ft.", "Ez két millió forint."),
        # Just outside the year range: 1892 and 2102 are counts.
        ("Vettem 1892 almát.", "Vettem ezernyolcszázkilencvenkét almát."),
        ("Vettem 2102 almát.", "Vettem kétezer-százkét almát."),
    ],
)
def test_a_number_that_counts_the_next_word_says_két(text, said):
    assert spoken(text) == said


def say_the_two(text, language):
    """A stand-in normalizer: "2" is "kettő" and every other word stays as typed."""
    return text.replace("2", "kettő")


# What no number counts, as typed: the review's stop list and what the later rounds added.
NOT_COUNTED = [
    "után", "előtt", "óta", "körül", "felé", "között", "közül", "alatt", "fölött", "felett",
    "mellett", "múlva", "helyett", "nélkül", "szerint", "miatt", "által", "ellen", "iránt",
    "mögött",
    "és", "vagy", "meg", "illetve", "plusz", "mínusz", "szor", "szorozva", "x", "osztva",
    "egyenlő",
    "van", "vannak", "volt", "voltak", "lesz", "lesznek", "lett", "lettek", "marad", "maradt",
    "kell",
    "is", "sem", "nem", "de", "pedig", "viszont", "lehet", "legyen", "már", "még", "csak", "azaz",
    "stb.", "s",
]  # fmt: skip


@pytest.mark.parametrize("word", NOT_COUNTED)
def test_a_number_does_not_count_a_stop_word(word, monkeypatch):
    monkeypatch.setattr(zyphra_textnorm, "normalize", say_the_two)
    sp = normalize(["Ebből", "2", word, "elég."], "hu")
    assert sp.words == ["Ebből", "kettő", word, "elég."]


def test_a_number_counts_a_word_that_is_no_stop_word(monkeypatch):
    # The same stand-in with a counted word: the stop-word test above is not vacuous.
    monkeypatch.setattr(zyphra_textnorm, "normalize", say_the_two)
    sp = normalize(["Ebből", "2", "alma", "elég."], "hu")
    assert sp.words == ["Ebből", "két", "alma", "elég."]


def test_a_number_whose_next_token_the_normalizer_dropped_is_left_alone(monkeypatch):
    # "xx" is written after the "2" but no word is said after it: there is nothing to count.
    said = {"Ebből 2 xx": "Ebből kettő", "Ebből 2": "Ebből kettő"}
    monkeypatch.setattr(zyphra_textnorm, "normalize", lambda text, language: said.get(text, text))
    assert normalize(["Ebből", "2", "xx"], "hu").words == ["Ebből", "kettő"]


# One written token read as several words ("2%" is "kettő százalék") counts its own next word.


@pytest.mark.parametrize(
    "text, said",
    [
        ("Ez 2% kedvezmény.", "Ez két százalék kedvezmény."),
        ("Ez 12% kedvezmény.", "Ez tizenkét százalék kedvezmény."),
        ("Ez 2-féle sajt.", "Ez két féle sajt."),
        ("Ez 2-szobás lakás.", "Ez két szobás lakás."),
        ("A találkozó 2:30-kor lesz.", "A találkozó két óra harminc perckor lesz."),
        ("Pontosan 12:02 van.", "Pontosan tizenkét óra két perc van."),
        ("A 2/3 rész kész.", "A két harmad rész kész."),
        # "Kb." shares its run with "2%": the token's own words are still found.
        ("Kb. 2% emelkedés.", "körülbelül két százalék emelkedés."),
        # Leading punctuation does not hide the number.
        ("Ez (2%) kedvezmény.", "Ez (két százalék) kedvezmény."),
    ],
)
def test_a_number_read_as_several_words_says_két_before_its_own_next_word(text, said):
    assert spoken(text) == said


@pytest.mark.parametrize(
    "text, said",
    [
        # A name that holds a number, with a hyphenated word after it: the number names, not counts.
        ("A CO2-kibocsátás nő.", "A C O kettő kibocsátás nő."),
        ("A B12-vitamin fontos.", "A B tizenkettő vitamin fontos."),
        ("A SO2-kibocsátás nő.", "A S O kettő kibocsátás nő."),
        ("A NO2-szint magas.", "A N O kettő szint magas."),
        ("Ez CO2-mentes.", "Ez C O kettő mentes."),
        ("Az F2-billentyű kell.", "Az F kettő billentyű kell."),
        ("A K2-csúcs magas.", "A K kettő csúcs magas."),
        ("A B2-vitamin fontos.", "A B kettő vitamin fontos."),
    ],
)
def test_a_number_inside_a_name_stays_kettő(text, said):
    assert spoken(text) == said


@pytest.mark.parametrize(
    "text, said",
    [
        # "egész" is the decimal point.
        ("Ez 2,5% kedvezmény.", "Ez kettő egész öt tized százalék kedvezmény."),
        # A score: the colon clings to "kettő", which ends its clause.
        ("Az eredmény 2:1 lett.", "Az eredmény kettő: egy lett."),
        # A number word follows: "·" is not spoken, so "kettő" meets "három"; "egyed" begins "egy".
        ("Ez 2·3 volt.", "Ez kettő három volt."),
        ("Ez 2/1 volt.", "Ez kettő egyed volt."),
        # The normalizer capitalizes "Celsius-fok": no lowercase word follows.
        ("Ez 2°C hideg.", "Ez kettő Celsius-fok hideg."),
    ],
)
def test_a_decimal_or_a_capitalized_word_in_one_token_keeps_kettő(text, said):
    assert spoken(text) == said


@pytest.mark.parametrize(
    "text, said",
    [
        # An operation, as one token or as several: the normalizer says "szorozva" for * and ×.
        ("Ez 2+2=4 igaz.", "Ez kettő plusz kettő egyenlő négy igaz."),
        ("Ez 2*2=4 igaz.", "Ez kettő szorozva kettő egyenlő négy igaz."),
        ("Ez 2 * 2 = 4 igaz.", "Ez kettő szorozva kettő egyenlő négy igaz."),
        ("Ez 2 x 2 = 4 igaz.", "Ez kettő x kettő egyenlő négy igaz."),
        ("Ez 2 szor 3 igaz.", "Ez kettő szor három igaz."),
        # A version or an address: every "kettő" is followed by "pont".
        ("A 12.2.3 verzió.", "A tizenkettő pont kettő pont három verzió."),
        (
            "Az IP 192.168.2.2 cím.",
            "Az IP százkilencvenkettő pont százhatvannyolc pont kettő pont kettő cím.",
        ),
        # A date in one token: the year is followed by the month, and only its inside changes.
        ("Ekkor 2022-02-02 volt.", "Ekkor kétezer-huszonkettő február másodika volt."),
    ],
)
def test_an_operation_a_version_or_a_date_in_one_token_counts_nothing(text, said):
    assert spoken(text) == said


# When the match and the sentence's own prefix do not agree on the token's words, nothing changes.


def test_a_number_the_normalizer_reads_two_ways_is_left_as_spoken(monkeypatch):
    # With the rest of the sentence cut off, "2" is read as "kettedik": the normalizer disagrees
    # with itself about where "2" ends, so "kettő" stays.
    said = {"A 2 tojás": "A kettő tojás", "A 2": "A kettedik"}
    monkeypatch.setattr(zyphra_textnorm, "normalize", lambda text, language: said[text])
    assert normalize(["A", "2", "tojás"], "hu").words == ["A", "kettő", "tojás"]


def test_a_prefix_that_reaches_past_the_match_leaves_the_words_alone(monkeypatch):
    # The match puts "2" on word 1; the sentence up to "2" claims words 0 to 4. Not even the
    # unowned "kettő" there (word 4) may change.
    said = {"A 2 alma B tojás": "A kettő alma B kettő tojás", "A 2": "A kettő alma B kettő"}
    monkeypatch.setattr(zyphra_textnorm, "normalize", lambda text, language: said.get(text, text))
    sp = normalize(["A", "2", "alma", "B", "tojás"], "hu")
    assert sp.words == ["A", "kettő", "alma", "B", "kettő", "tojás"]


def test_a_prefix_that_starts_before_the_match_leaves_the_words_alone(monkeypatch):
    # The match puts "2%" on words 1 and 2; the sentence says "A" is nothing, so "2%" starts at 0.
    said = {"A 2% x": "A kettő százalék x", "A 2%": "A kettő százalék", "A": ""}
    monkeypatch.setattr(zyphra_textnorm, "normalize", lambda text, language: said.get(text, text))
    sp = normalize(["A", "2%", "x"], "hu")
    assert sp.words == ["A", "kettő", "százalék", "x"]


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


def test_an_underscore_run_is_not_spoken():
    sp = normalize("Töltsd ki: ___ a válasz.".split(), "hu")
    assert sp.words == ["Töltsd", "ki:", "a", "válasz."]
    assert sp.token_spans == [(0, 1), (1, 2), None, (2, 3), (3, 4)]


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
        ("hu", "Kb. 2% emelkedés."),
        ("hu", "A találkozó 2:30-kor lesz."),
        ("hu", "A 2000. évben nyert."),
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
