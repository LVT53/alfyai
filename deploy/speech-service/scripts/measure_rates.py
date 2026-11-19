"""Measures how fast each built-in voice speaks, for `charsPerSecond` in the app's voices.ts.

AlfyAI's browser estimates a reading's length before its sentences are made, from the number of
characters and each voice's speaking rate (`charsPerSecond`, in written characters per second: the
estimate is "about", and the readings correct it as the sentences arrive). Every voice has had 15 so
far, a guess. This asks the running speech service for a preview of each sentence in each voice and
reads each clip's length from its MP3 frames, so the rate is the voice's own, as the box makes it.

For each of the six voices it posts `POST /v1/preview` once for each sentence of the voice's
language, one after the other: the language's two samples (the ones the voice editor plays) and four
plain sentences with no digit or symbol, which a voice would expand into more words than are written
(a digit speaks as a word, so a sentence with figures reads faster than its characters say). The rate
is the characters of all the sentences over the seconds of all their clips.

Writes `DIR/rates.json` (per voice: each sentence's length in characters and its clip's seconds, the
totals and the rate) and prints a table and one `charsPerSecond: <rate>` line per voice, rounded to
0.1, to put into `src/lib/server/services/read-aloud/voices.ts`. It writes nothing else, and nothing
into the repository. It only needs httpx and the standard library.

Exit status: 0 when it ran; 1 when the service did not answer or refused (any 4xx or 5xx), or sent a
clip that is not the MP3 it writes; 2 for a bad argument.

Run it from deploy/speech-service, with the service's Python (on the box, as alfyws):

    python -I scripts/measure_rates.py --out /a/folder/outside/the/repo

About a minute of Zonos beside vLLM, which decodes about 10% slower meanwhile. Nothing restarts.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import httpx

REPORT_NAME = "rates.json"
DEFAULT_SERVICE = "http://127.0.0.1:1920"
# A preview is one sentence made whole: the service is given this long to answer one.
PREVIEW_TIMEOUT = httpx.Timeout(connect=5.0, read=120.0, write=10.0, pool=10.0)


@dataclass(frozen=True)
class VoiceSpec:
    key: str
    language: str
    speaker_id: str
    controls: dict[str, float]


# Copied from src/lib/server/services/read-aloud/voices.ts (BUILT_IN_VOICES): key, language, Zonos
# speaker id and the controls the voice always carries. tests/test_measure_rates.py checks the copy
# against the app's source when it is beside this folder.
VOICES: tuple[VoiceSpec, ...] = (
    VoiceSpec("imogen", "en", "default_b78b28baf5c31a1d", {}),
    VoiceSpec("rupert", "en", "default_3765f0d1140c05c0", {}),
    VoiceSpec("savannah", "en", "default_de4d191ca7574982", {}),
    VoiceSpec("wyatt", "en", "default_34370fd91e3484ef", {}),
    VoiceSpec("berta", "hu", "default_bf7632822e6b4dc0", {"room.clean": 2}),
    VoiceSpec("imre", "hu", "default_fde02d0881bd267d", {"room.clean": 2}),
)

# Copied from src/lib/shared/read-aloud/voice-samples.ts (VOICE_SAMPLES): the two sentences the
# voice editor plays in each language.
SAMPLES: dict[str, tuple[str, str]] = {
    "en": (
        "Here's the short version: feed it once a day, keep it somewhere warm, and it will double"
        " in about six hours.",
        "Shall I read you the long one?",
    ),
    "hu": (
        "Röviden: ha minden nap eteted, és meleg helyen tartod, körülbelül hat óra alatt"
        " megduplázódik.",
        "Elolvassam a hosszabb változatot is?",
    ),
}

# Four plain sentences a language, 80 to 200 characters each, with no digit and no symbol: letters,
# spaces and the marks a sentence pauses or ends with. They are made up for this measurement.
PLAIN_SENTENCES: dict[str, tuple[str, str, str, str]] = {
    "en": (
        "The old library on the hill opens early in the morning, and the first visitors usually"
        " arrive before the sun is fully up.",
        "A good soup takes patience, so we chop the vegetables slowly, add a little salt, and let"
        " everything simmer on a low heat.",
        "When the train finally pulled into the station, the platform filled with people carrying"
        " bags, umbrellas, and tired smiles.",
        "She wrote a short letter to her friend by the sea, telling her about the garden, the"
        " weather, and the new kitten.",
    ),
    "hu": (
        "A régi könyvtár a domb tetején korán reggel nyit, és az első látogatók általában még"
        " napfelkelte előtt megérkeznek.",
        "A jó leveshez türelem kell, ezért lassan felvágjuk a zöldségeket, teszünk bele egy kis"
        " sót, és hagyjuk csendesen főni.",
        "Amikor a vonat végre beállt az állomásra, a peron megtelt emberekkel, akik táskákat,"
        " esernyőket és fáradt mosolyokat vittek.",
        "Levelet írt a tengerparti barátnőjének, amelyben mesélt a kertről, az időjárásról és az"
        " új kiscicáról.",
    ),
}


def sentences_of(language: str) -> list[str]:
    """What a voice of `language` speaks: the two samples, then the four plain sentences."""
    return [*SAMPLES[language], *PLAIN_SENTENCES[language]]


# --- reading a clip's length ----------------------------------------------------------------------

_SAMPLE_RATE = 44_100
_SAMPLES_PER_FRAME = 1152
# MPEG-1 Layer III bit rates in kbit/s by the header's index; 0 (free format) and 15 (bad) are refused.
_BITRATES_KBPS = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0)


def _id3v2_length(data: bytes) -> int:
    """The bytes a leading ID3v2 tag takes, 0 when there is none: a 10-byte header with a syncsafe size,
    and 10 more for a footer."""
    if len(data) < 10 or data[:3] != b"ID3":
        return 0
    size = (data[6] & 0x7F) << 21 | (data[7] & 0x7F) << 14 | (data[8] & 0x7F) << 7 | (data[9] & 0x7F)
    footer = 10 if data[5] & 0x10 else 0
    return 10 + size + footer


def mp3_seconds(data: bytes) -> float:
    """The length of an MP3 the service writes, from its frames.

    Skips a leading ID3v2 tag, then walks MPEG-1 Layer III frame headers at 44 100 Hz: a frame is
    `floor(144 x bit rate / 44100) + padding` bytes and holds 1152 samples. ValueError for anything
    else: no frames, a frame that is not Layer III at 44.1 kHz, or a frame cut short.
    """
    at = _id3v2_length(data)
    if at > len(data):
        raise ValueError("the ID3 tag runs past the end")
    frames = 0
    while at < len(data):
        header = data[at : at + 4]
        if len(header) < 4 or header[0] != 0xFF or header[1] & 0xE0 != 0xE0:
            raise ValueError("not at a frame")
        if (header[1] >> 3) & 3 != 3:
            raise ValueError("not MPEG-1")
        if (header[1] >> 1) & 3 != 1:
            raise ValueError("not Layer III")
        bitrate = _BITRATES_KBPS[header[2] >> 4]
        if bitrate == 0:
            raise ValueError("not a fixed bit rate")
        if (header[2] >> 2) & 3 != 0:
            raise ValueError("not 44.1 kHz")
        length = (144 * bitrate * 1000) // _SAMPLE_RATE + ((header[2] >> 1) & 1)
        if at + length > len(data):
            raise ValueError("a frame is cut short")
        at += length
        frames += 1
    if frames == 0:
        raise ValueError("no frames")
    return frames * _SAMPLES_PER_FRAME / _SAMPLE_RATE


def rate(texts: list[str], seconds: list[float]) -> float:
    """Written characters a second: the sum of the texts' lengths over the sum of the seconds.

    It is not the mean of each sentence's rate, so a long sentence counts for more than a short one.
    ValueError when there is nothing to divide: no texts, a different number of seconds, or seconds
    that are not positive numbers.
    """
    if not texts or len(texts) != len(seconds):
        raise ValueError("a rate needs a clip's seconds for each text")
    if not all(math.isfinite(s) and s > 0 for s in seconds):
        raise ValueError("the seconds of a clip are positive numbers")
    return sum(len(text) for text in texts) / sum(seconds)


# --- the measurement ------------------------------------------------------------------------------


class ServiceError(Exception):
    """The service did not answer, refused, or sent what is not its MP3. Never carries a sentence."""


def _preview(
    client: httpx.Client, service: str, voice: VoiceSpec, text: str
) -> float:
    """The seconds of one sentence, spoken in a voice, as the service's preview makes it."""
    body = {
        "text": text,
        "language": voice.language,
        "voice": {"speaker_id": voice.speaker_id, "controls": dict(voice.controls)},
    }
    try:
        response = client.post(f"{service}/v1/preview", json=body, timeout=PREVIEW_TIMEOUT)
    except httpx.TransportError as error:
        raise ServiceError(
            f"the speech service did not answer for {voice.key} ({type(error).__name__})"
        ) from None
    if response.status_code != 200:
        raise ServiceError(f"the speech service answered {response.status_code} for {voice.key}")
    try:
        return mp3_seconds(response.content)
    except ValueError:
        raise ServiceError(f"the clip for {voice.key} is not an MP3 the service writes") from None


def measure(client: httpx.Client, service: str) -> dict[str, object]:
    """Every voice speaks every sentence of its language, one after the other. Returns the report."""
    voices: dict[str, object] = {}
    for voice in VOICES:
        texts = sentences_of(voice.language)
        seconds = [_preview(client, service, voice, text) for text in texts]
        voices[voice.key] = {
            "language": voice.language,
            "sentences": [
                {"chars": len(text), "seconds": round(clip, 3)} for text, clip in zip(texts, seconds)
            ],
            "chars": sum(len(text) for text in texts),
            "seconds": round(sum(seconds), 3),
            "charsPerSecond": round(rate(texts, seconds), 3),
        }
        print(f"{voice.key}: {len(texts)} sentences", file=sys.stderr, flush=True)
    return {
        "tool": "scripts/measure_rates.py",
        "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "service": service,
        "voices": voices,
    }


def summary(report: dict[str, object]) -> str:
    voices: dict[str, dict[str, object]] = report["voices"]  # type: ignore[assignment]
    lines = [
        f"Speaking rates measured at {report['measuredAt']} on {report['service']}",
        "",
        f"{'voice':<10} {'lang':<5} {'sentences':>9} {'characters':>11} {'seconds':>9} {'chars/s':>8}",
    ]
    for key, voice in voices.items():
        lines.append(
            f"{key:<10} {voice['language']:<5} {len(voice['sentences']):>9} "  # type: ignore[arg-type]
            f"{voice['chars']:>11} {voice['seconds']:>9.1f} {voice['charsPerSecond']:>8.1f}"  # type: ignore[str-format]
        )
    lines += ["", "For src/lib/server/services/read-aloud/voices.ts, in each voice's entry:"]
    for key, voice in voices.items():
        lines.append(f"{key:<10} charsPerSecond: {round(voice['charsPerSecond'], 1)},")  # type: ignore[call-overload]
    return "\n".join(lines)


# --- the command ----------------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="measure_rates.py",
        description="Measure each built-in voice's speaking rate against the running speech service.",
    )
    parser.add_argument("--out", required=True, help="a folder outside the repository for rates.json")
    parser.add_argument(
        "--service", default=DEFAULT_SERVICE, help=f"the speech service's address (default {DEFAULT_SERVICE})"
    )
    return parser


def main(argv: list[str] | None = None, *, http_client: httpx.Client | None = None) -> int:
    """Runs the command. `http_client` stands in for the service in tests."""
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
        url = urlsplit(args.service)
        if url.scheme not in ("http", "https") or not url.netloc:
            parser.error(f"--service must be an http or https address, got {args.service!r}")
    except SystemExit as stop:
        return stop.code if isinstance(stop.code, int) else 2
    service = args.service.rstrip("/")
    try:
        if http_client is not None:
            report = measure(http_client, service)
        else:
            with httpx.Client() as client:
                report = measure(client, service)
    except ServiceError as error:
        print(f"measure_rates: {error}", file=sys.stderr)
        return 1
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / REPORT_NAME).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(summary(report))
    print(f"\nReport: {out / REPORT_NAME}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
