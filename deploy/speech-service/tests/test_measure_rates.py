"""Tests of `scripts/measure_rates.py`, the script that measures each voice's speaking rate on the box.

They run against an `httpx.MockTransport` that answers `POST /v1/preview` like the service does (one
whole MP3 with an ID3 tag), so nothing here needs Zonos or the network.
"""

import importlib.util
import json
import math
import re
import sys
import unicodedata
from pathlib import Path

import httpx
import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "measure_rates.py"
APP_ROOT = Path(__file__).resolve().parents[3]


def _load():
    """The script as a module, from its path: `scripts/` is no package."""
    spec = importlib.util.spec_from_file_location("measure_rates", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["measure_rates"] = module
    spec.loader.exec_module(module)
    return module


mr = _load()

FRAME_SECONDS = 1152 / 44100
# The header of a silent MPEG-1 Layer III frame at 44.1 kHz, mono, 128 kbit/s: 417 bytes a frame.
FRAME = bytes([0xFF, 0xFB, 0x90, 0xC0]) + bytes(417 - 4)


def id3v2(size: int = 40) -> bytes:
    """An ID3v2.4 tag of `size` payload bytes (the size is written syncsafe)."""
    syncsafe = bytes([(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F])
    return b"ID3" + bytes([4, 0, 0]) + syncsafe + bytes(size)


def mp3_of(frames: int) -> bytes:
    return id3v2() + FRAME * frames


# --- reading a clip's length --------------------------------------------------------------------


def test_mp3_seconds_counts_frames_after_the_id3_tag():
    assert mr.mp3_seconds(mp3_of(10)) == pytest.approx(10 * FRAME_SECONDS)
    assert mr.mp3_seconds(mp3_of(1000)) == pytest.approx(1000 * FRAME_SECONDS)
    # No tag, a tag with a footer, and a tag whose size takes two syncsafe bytes.
    assert mr.mp3_seconds(FRAME * 5) == pytest.approx(5 * FRAME_SECONDS)
    footer = id3v2(300)[:5] + bytes([0x10]) + id3v2(300)[6:] + bytes(10)
    assert mr.mp3_seconds(footer + FRAME * 3) == pytest.approx(3 * FRAME_SECONDS)
    assert mr.mp3_seconds(id3v2(300) + FRAME * 4) == pytest.approx(4 * FRAME_SECONDS)


def test_mp3_seconds_follows_the_padding_bit_and_the_bit_rate():
    # A padded 128 kbit/s frame is 418 bytes; a 64 kbit/s frame is 208.
    padded = bytes([0xFF, 0xFB, 0x92, 0xC0]) + bytes(418 - 4)
    slow = bytes([0xFF, 0xFB, 0x50, 0xC0]) + bytes(208 - 4)
    assert mr.mp3_seconds(padded + FRAME + padded) == pytest.approx(3 * FRAME_SECONDS)
    assert mr.mp3_seconds(slow * 2) == pytest.approx(2 * FRAME_SECONDS)
    # The channel mode does not change a frame's length: a stereo frame counts too.
    stereo = bytes([0xFF, 0xFB, 0x90, 0x00]) + bytes(417 - 4)
    assert mr.mp3_seconds(stereo * 2) == pytest.approx(2 * FRAME_SECONDS)


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"not an mp3 at all, just text" * 20,
        id3v2(30),  # a tag and no frames
        FRAME[:300],  # a frame cut short
        FRAME * 2 + bytes(40),  # frames and then noise
        bytes([0xFF, 0xFB, 0x94, 0xC0]) + bytes(400),  # 48 kHz
        bytes([0xFF, 0xFD, 0x90, 0xC0]) + bytes(400),  # Layer II
        bytes([0xFF, 0xF3, 0x90, 0xC0]) + bytes(400),  # MPEG-2
        bytes([0xFF, 0xFB, 0x00, 0xC0]) + bytes(400),  # free-format bit rate
        bytes([0xFF, 0xFB, 0xF0, 0xC0]) + bytes(400),  # a bad bit rate
        id3v2(900)[:100],  # a tag that runs past the end
    ],
)
def test_mp3_seconds_refuses_anything_that_is_not_the_services_mp3(data: bytes):
    with pytest.raises(ValueError):
        mr.mp3_seconds(data)


# --- the rate -----------------------------------------------------------------------------------


def test_rate_is_characters_over_seconds_across_sentences():
    # The sum of the lengths over the sum of the seconds, not the mean of the rates:
    # a long sentence counts for more than a short one.
    assert mr.rate(["a" * 100, "b" * 20], [5.0, 4.0]) == pytest.approx(120 / 9)
    # 20 characters a second and 5 characters a second: the mean of the two rates is 12.5.
    assert mr.rate(["a" * 100, "b" * 20], [5.0, 4.0]) != pytest.approx(12.5)
    assert mr.rate(["x" * 150], [10.0]) == pytest.approx(15.0)
    # Written characters: spaces and punctuation count as the reader sees them.
    assert mr.rate(["ab cd."], [2.0]) == pytest.approx(3.0)


@pytest.mark.parametrize(
    "texts, seconds",
    [([], []), (["a"], []), (["a", "b"], [1.0]), (["a"], [0.0]), (["a"], [-1.0]), (["a"], [math.nan])],
)
def test_rate_refuses_what_it_cannot_divide(texts: list[str], seconds: list[float]):
    with pytest.raises(ValueError):
        mr.rate(texts, seconds)


# --- the sentences ------------------------------------------------------------------------------


def _plain(text: str) -> bool:
    """Only letters, spaces and the marks a sentence ends or pauses with: nothing a voice expands."""
    return all(
        unicodedata.category(c).startswith("L") or c in " .,?!" for c in text
    )


def test_each_language_has_two_samples_and_four_plain_sentences():
    for language in ("en", "hu"):
        samples, plain = mr.SAMPLES[language], mr.PLAIN_SENTENCES[language]
        assert len(samples) == 2
        assert len(plain) == 4
        assert mr.sentences_of(language) == [*samples, *plain]
        for sentence in plain:
            assert 80 <= len(sentence) <= 200, sentence
            assert _plain(sentence), sentence
            assert not any(c.isdigit() for c in sentence), sentence
        assert len(set(mr.sentences_of(language))) == 6


# --- the command, on a fake service ---------------------------------------------------------------


class FakeService:
    """The service's preview, as httpx.MockTransport: a clip as long as the text reads at `speed`."""

    def __init__(self, speed: float = 15.0, status: int = 200, fail_for_voice: str | None = None) -> None:
        self.speed = speed
        self.status = status
        self.fail_for_voice = fail_for_voice
        self.bodies: list[dict] = []
        self.paths: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.paths.append(f"{request.method} {request.url.path}")
        if request.method != "POST" or request.url.path != "/v1/preview":
            return httpx.Response(404, text="Not Found")
        body = json.loads(request.content)
        self.bodies.append(body)
        if self.status != 200:
            return httpx.Response(self.status, json={"error": "invalid", "field": "text"})
        if self.fail_for_voice and body["voice"]["speaker_id"] == self.fail_for_voice:
            return httpx.Response(503, json={"code": "zonos_unavailable"})
        seconds = len(body["text"]) / self.speed
        frames = max(1, math.ceil(seconds / FRAME_SECONDS))
        return httpx.Response(200, content=mp3_of(frames), headers={"content-type": "audio/mpeg"})

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handler))


def test_runs_on_a_fake_service_and_writes_only_the_report(tmp_path: Path, capsys):
    service = FakeService(speed=15.0)
    out = tmp_path / "rates"
    code = mr.main(["--out", str(out)], http_client=service.client())
    assert code == 0
    # The out folder holds the report and nothing else.
    assert sorted(p.name for p in out.iterdir()) == ["rates.json"]
    report = json.loads((out / "rates.json").read_text(encoding="utf-8"))
    assert list(report["voices"]) == ["imogen", "rupert", "savannah", "wyatt", "berta", "imre"]

    for key, voice in report["voices"].items():
        assert voice["language"] == ("hu" if key in ("berta", "imre") else "en")
        assert len(voice["sentences"]) == 6
        for sentence in voice["sentences"]:
            assert set(sentence) == {"chars", "seconds"}
            assert sentence["seconds"] > 0
        assert voice["chars"] == sum(s["chars"] for s in voice["sentences"])
        assert voice["seconds"] == pytest.approx(sum(s["seconds"] for s in voice["sentences"]), abs=0.01)
        # Every clip was as long as its text at 15 characters a second, give or take a frame.
        assert voice["charsPerSecond"] == pytest.approx(15.0, rel=0.02)

    # One preview a sentence: 6 voices x 6 sentences, one at a time, to the preview route only.
    assert len(service.bodies) == 36
    assert set(service.paths) == {"POST /v1/preview"}

    printed = capsys.readouterr().out
    for key in report["voices"]:
        assert re.search(rf"{key}\s+charsPerSecond: 1[45]\.\d,", printed), key
    assert "voices.ts" in printed


def test_sends_the_preview_request_the_service_takes(tmp_path: Path):
    service = FakeService()
    assert mr.main(["--out", str(tmp_path / "rates")], http_client=service.client()) == 0
    voices = {v.speaker_id: v for v in mr.VOICES}
    for body in service.bodies:
        # Exactly the preview's fields, and nothing else.
        assert set(body) == {"text", "language", "voice"}
        assert set(body["voice"]) == {"speaker_id", "controls"}
        voice = voices[body["voice"]["speaker_id"]]
        assert body["language"] == voice.language
        # The voice's own default controls: Berta's and Imre's studio, none for the English voices.
        assert body["voice"]["controls"] == voice.controls
        assert body["text"] in mr.sentences_of(voice.language)
    studio = [b for b in service.bodies if b["language"] == "hu"]
    assert studio
    assert all(b["voice"]["controls"] == {"room.clean": 2} for b in studio)
    # Each voice speaks every sentence of its language, once.
    for voice in mr.VOICES:
        spoken = [b["text"] for b in service.bodies if b["voice"]["speaker_id"] == voice.speaker_id]
        assert sorted(spoken) == sorted(mr.sentences_of(voice.language))


def test_a_slower_voice_has_a_lower_rate(tmp_path: Path):
    service = FakeService(speed=12.0)
    out = tmp_path / "rates"
    assert mr.main(["--out", str(out)], http_client=service.client()) == 0
    report = json.loads((out / "rates.json").read_text(encoding="utf-8"))
    assert report["voices"]["imogen"]["charsPerSecond"] == pytest.approx(12.0, rel=0.02)


@pytest.mark.parametrize("status", [400, 404, 413, 422, 500, 502, 503])
def test_exits_1_when_the_service_refuses(status: int, tmp_path: Path, capsys):
    service = FakeService(status=status)
    out = tmp_path / "rates"
    assert mr.main(["--out", str(out)], http_client=service.client()) == 1
    assert not out.exists()
    err = capsys.readouterr().err
    assert str(status) in err
    # The message names the voice, never a sentence.
    assert "imogen" in err
    for sentence in mr.sentences_of("en"):
        assert sentence not in err


def test_exits_1_when_the_service_fails_for_one_voice(tmp_path: Path):
    service = FakeService(fail_for_voice="default_fde02d0881bd267d")  # Imre
    out = tmp_path / "rates"
    assert mr.main(["--out", str(out)], http_client=service.client()) == 1
    # Nothing is written for a run that did not finish.
    assert not out.exists()


def test_exits_1_when_the_service_does_not_answer(tmp_path: Path, capsys):
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused", request=request)

    client = httpx.Client(transport=httpx.MockTransport(refuse))
    out = tmp_path / "rates"
    assert mr.main(["--out", str(out)], http_client=client) == 1
    assert not out.exists()
    assert "did not answer" in capsys.readouterr().err


def test_exits_1_when_the_clip_is_not_an_mp3(tmp_path: Path):
    client = httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b"RIFF....WAVE"))
    )
    out = tmp_path / "rates"
    assert mr.main(["--out", str(out)], http_client=client) == 1
    assert not out.exists()


@pytest.mark.parametrize(
    "arguments",
    [
        [],
        ["--out"],
        ["--out", "x", "--service", "not a url"],
        ["--out", "x", "--service", "ftp://127.0.0.1:1920"],
        ["--out", "x", "--unknown"],
    ],
)
def test_exits_2_for_a_bad_argument(arguments: list[str], tmp_path: Path):
    arguments = [str(tmp_path / "out") if a == "x" else a for a in arguments]
    assert mr.main(arguments) == 2
    assert not (tmp_path / "out").exists()


# --- the constants are the app's ----------------------------------------------------------------


@pytest.mark.skipif(
    not (APP_ROOT / "src/lib/server/services/read-aloud/voices.ts").exists(),
    reason="the app's sources are not beside this folder",
)
def test_the_constants_are_the_apps():
    voices_ts = (APP_ROOT / "src/lib/server/services/read-aloud/voices.ts").read_text(encoding="utf-8")
    pattern = re.compile(
        r'key:\s*"(\w+)",\s*name:\s*"\w+",\s*language:\s*"(en|hu)",\s*speakerId:\s*"(default_\w+)",'
        r"\s*controls:\s*(\{[^}]*\})",
    )
    app_voices = [
        (key, language, speaker, json.loads(controls))
        for key, language, speaker, controls in pattern.findall(voices_ts)
    ]
    assert len(app_voices) == 6
    assert [(v.key, v.language, v.speaker_id, v.controls) for v in mr.VOICES] == app_voices

    samples_ts = (APP_ROOT / "src/lib/shared/read-aloud/voice-samples.ts").read_text(encoding="utf-8")
    for language in ("en", "hu"):
        block = re.search(rf"\b{language}: \[(.*?)\],\s*(?:hu|en|\}})", samples_ts, re.S)
        assert block, language
        sentences = re.findall(r'"((?:[^"\\]|\\.)*)"', block.group(1))
        assert list(mr.SAMPLES[language]) == sentences
