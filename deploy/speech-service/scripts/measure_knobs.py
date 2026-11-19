"""Measures where each knob of the voice editor stops being safe, on the box's own Zonos.

The editor's five knobs (spec §4.6) make six Zonos controls. The spec gives each a range that was
measured on the owner's Mac; readings come from the box's build (a quantized backbone, one decoder),
which may break earlier. This sweep renders the samples at growing doses of one control at a time,
for every voice and a few seeds, and finds for each language the last dose before one goes wrong
(spec §8, §9.4; Plan 3, Decision 16). A dose is safe when, at every seed and for every voice of the
language:

- the aligner places every word of the clip (the words as a reading's are timed, through the
  service's own `NativeFuseAligner`);
- there is no more clipping than in the voice's baseline (5 seeds, no control);
- no silence inside the clip is longer than 1.5 x the baseline's longest (and at least 0.8 s);
- the clip's length is within 0.5-2 x the baseline's median (the tempo: 0.4-2.5 x).

Doses are walked outward from 0 and a series stops at its first unsafe dose: nothing past it is
measured, and the range is never wider than the spec's. The clips are made exactly as a preview is:
the service's own normalizer and its own Zonos request (`ZonosClient`), and the voice's own default
controls (Berta's and Imre's studio control) under every dose.

Writes `DIR/knob-ranges.json` (every clip's numbers, no audio, no text) and prints a summary and the
`SAFE_CONTROL_RANGES` object to paste into `src/lib/shared/read-aloud/voice-knobs.ts`. It writes
nothing else, and nothing into the repository.

Exit status: 0 when the sweep ran, whatever it found; 1 when it could not run (Zonos or the aligner
cannot be reached, or Zonos cannot make a baseline clip); 2 for a bad argument.

Run it from deploy/speech-service, with the service's Python (on the box, as alfyws):

    python -I scripts/measure_knobs.py --out /a/folder/outside/the/repo \\
        --aligner-cli PATH --aligner-model PATH --aligner-threads 8

About 15 minutes of Zonos beside vLLM, which decodes about 10% slower meanwhile. Nothing restarts.
Without the aligner flags the words are not checked, and the report says so.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

# `python -I` adds no folder of its own, and the service's package is in this folder's parent.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402
import numpy as np  # noqa: E402

from speech_service.aligner import Aligner, NativeFuseAligner, resample_16k  # noqa: E402
from speech_service.models import Voice  # noqa: E402
from speech_service.text import normalize  # noqa: E402
from speech_service.zonos import (  # noqa: E402
    SynthesisFailed,
    ZonosClient,
    ZonosUnavailable,
)

REPORT_NAME = "knob-ranges.json"
DEFAULT_ZONOS = "http://127.0.0.1:1919"
DEFAULT_SEEDS = 3
DEFAULT_ALIGNER_THREADS = 8
BASELINE_CLIPS = 5
# The service's own seed (`SPEECH_SEED`); the others are spread from it.
SERVICE_SEED = 1234
SEED_STEP = 7919
# Zonos runs two syntheses at once (`--batch 2`).
ZONOS_SLOTS = 2

# --- constants copied from the app (tests/test_measure_knobs.py checks them against it) -----------


@dataclass(frozen=True)
class VoiceSpec:
    key: str
    language: str
    speaker_id: str
    controls: dict[str, float]


# Copied from src/lib/server/services/read-aloud/voices.ts (BUILT_IN_VOICES): key, language, Zonos
# speaker id and the controls the voice always carries.
VOICES: tuple[VoiceSpec, ...] = (
    VoiceSpec("imogen", "en", "default_b78b28baf5c31a1d", {}),
    VoiceSpec("rupert", "en", "default_3765f0d1140c05c0", {}),
    VoiceSpec("savannah", "en", "default_de4d191ca7574982", {}),
    VoiceSpec("wyatt", "en", "default_34370fd91e3484ef", {}),
    VoiceSpec("berta", "hu", "default_bf7632822e6b4dc0", {"room.clean": 2}),
    VoiceSpec("imre", "hu", "default_fde02d0881bd267d", {"room.clean": 2}),
)

# Copied from src/lib/shared/read-aloud/voice-samples.ts (VOICE_SAMPLES): a language's two
# sentences as one text, as the preview speaks them (at most 300 characters).
SAMPLES = {
    "en": (
        "Here's the short version: feed it once a day, keep it somewhere warm, and it will double"
        " in about six hours. Shall I read you the long one?"
    ),
    "hu": (
        "Röviden: ha minden nap eteted, és meleg helyen tartod, körülbelül hat óra alatt"
        " megduplázódik. Elolvassam a hosszabb változatot is?"
    ),
}

# Copied from src/lib/shared/read-aloud/voice-knobs.ts (the spec's §4.6 ranges, which
# SAFE_CONTROL_RANGES held before any measurement): each control's range, in the order the
# report and the pasted object list them.
SPEC_RANGES: dict[str, tuple[float, float]] = {
    "delivery.tempo": (-2.0, 2.0),
    "pitch.pitch": (-2.0, 2.0),
    "texture.deep": (0.0, 4.0),
    "mood.arousal": (-4.0, 4.0),
    "delivery.whisper": (0.0, 1.5),
    "delivery.loud": (0.0, 2.0),
}

# The doses, from 0 toward each end of the spec's range (Plan 3, Task 7): a control with a negative
# side is also measured at the same doses below 0.
_POSITIVE_DOSES: dict[str, tuple[float, ...]] = {
    "delivery.tempo": (0.5, 1.0, 1.5, 2.0),
    "pitch.pitch": (0.5, 1.0, 1.5, 2.0),
    "texture.deep": (1.0, 2.0, 3.0, 4.0),
    "mood.arousal": (1.0, 2.0, 3.0, 4.0),
    "delivery.whisper": (0.5, 1.0, 1.5),
    "delivery.loud": (0.5, 1.0, 1.5, 2.0),
}

# What makes a clip fail (Decision 16).
FRAME_SECONDS = 0.02
QUIET_BELOW_90TH_PERCENTILE_DB = 40.0
CLIPPED_AT = 0.999
CLIPPING_MARGIN = 0.001
GAP_FLOOR_SECONDS = 0.8
GAP_FACTOR = 1.5
LENGTH_RATIO = (0.5, 2.0)
TEMPO_LENGTH_RATIO = (0.4, 2.5)
SILENT_PEAK = 1e-4


# --- doses, seeds ---------------------------------------------------------------------------------


def series_of(control: str) -> dict[str, list[float]]:
    """A control's doses by direction, each outward from 0: the positive side, and the negative if
    the spec's range has one."""
    low, _ = SPEC_RANGES[control]
    positive = list(_POSITIVE_DOSES[control])
    series = {"positive": positive}
    if low < 0:
        series["negative"] = [-dose for dose in positive]
    return series


def doses_of(control: str) -> list[float]:
    """Every dose of a control, lowest first."""
    return sorted(dose for doses in series_of(control).values() for dose in doses)


def seeds_for(count: int) -> list[int]:
    """`count` seeds, the service's own first; `seeds_for(3)` is the start of `seeds_for(5)`."""
    return [SERVICE_SEED + SEED_STEP * index for index in range(count)]


# --- what is measured of one clip -----------------------------------------------------------------


@dataclass(frozen=True)
class Metrics:
    seconds: float
    # The share of samples at or above 0.999 in absolute value.
    clipped: float
    # The longest silence inside the clip, in seconds (leading and trailing silence not counted).
    longest_gap: float
    peak: float


def _longest_run(flags: np.ndarray) -> int:
    best = run = 0
    for flag in flags.tolist():
        run = run + 1 if flag else 0
        best = max(best, run)
    return best


def clip_metrics(x: np.ndarray, sr: int) -> Metrics:
    """Length, clipping and the longest inner gap of a mono clip.

    A gap is a run of 20 ms frames more than 40 dB below the clip's 90th-percentile frame level,
    between the first and the last frame that are not.
    """
    if x.size == 0:
        return Metrics(0.0, 0.0, 0.0, 0.0)
    magnitude = np.abs(x)
    peak = float(np.max(magnitude))
    clipped = float(np.mean(magnitude >= CLIPPED_AT))
    frame = max(1, round(FRAME_SECONDS * sr))
    count = len(x) // frame
    longest = 0.0
    if count >= 3:
        frames = x[: count * frame].astype(np.float64).reshape(count, frame)
        rms = np.sqrt(np.mean(frames * frames, axis=1))
        level = 20.0 * np.log10(np.maximum(rms, 1e-9))
        quiet = level < np.percentile(level, 90) - QUIET_BELOW_90TH_PERCENTILE_DB
        loud = np.flatnonzero(~quiet)
        if loud.size:
            inner = quiet[loud[0] : loud[-1] + 1]
            longest = _longest_run(inner) * frame / sr
    return Metrics(seconds=len(x) / sr, clipped=clipped, longest_gap=longest, peak=peak)


def placed(aligner: Aligner, x: np.ndarray, sr: int, words: list[str]) -> int:
    """How many of `words` the aligner timed in the clip; 0 when it cannot time the clip at all."""
    try:
        times = aligner.align(resample_16k(x, sr), words)
    except Exception:  # a clip the aligner cannot time places nothing
        return 0
    return sum(1 for interval in times if interval is not None)


@dataclass(frozen=True)
class Baseline:
    """What a voice does with no control: the reference its dosed clips are judged against."""

    max_clipped: float
    longest_gap: float
    median_seconds: float


def clip_problems(
    m: Metrics, placed_words: int, words: int, baseline: Baseline, control: str
) -> list[str]:
    """One reason for each way a clip fails (Decision 16); none when it is fine."""
    problems: list[str] = []
    if m.peak < SILENT_PEAK:
        problems.append("the clip is silent")
    if placed_words < words:
        problems.append(f"placed {placed_words} of {words} words")
    if m.clipped > baseline.max_clipped + CLIPPING_MARGIN:
        problems.append(
            f"clipping in {m.clipped:.4f} of the samples where the baseline's most is"
            f" {baseline.max_clipped:.4f}"
        )
    limit = max(GAP_FLOOR_SECONDS, GAP_FACTOR * baseline.longest_gap)
    if m.longest_gap > limit:
        problems.append(f"a gap of {m.longest_gap:.2f} s inside the clip (the limit is {limit:.2f} s)")
    low, high = TEMPO_LENGTH_RATIO if control == "delivery.tempo" else LENGTH_RATIO
    if baseline.median_seconds > 0:
        ratio = m.seconds / baseline.median_seconds
        if ratio < low or ratio > high:
            problems.append(
                f"a length of {ratio:.2f} x the baseline's median (allowed {low:g} to {high:g} x)"
            )
    return problems


# --- from clips to ranges -------------------------------------------------------------------------


@dataclass
class ClipResult:
    language: str
    voice: str
    control: str
    dose: float
    seed: int
    metrics: Metrics
    placed: int
    words: int
    problems: list[str]


def dose_safety(clips: list[ClipResult]) -> dict[float, bool]:
    """Each dose's verdict for a language: safe when no clip at it, of any voice or seed, has a problem."""
    safe: dict[float, bool] = {}
    for clip in clips:
        safe[clip.dose] = safe.get(clip.dose, True) and not clip.problems
    return safe


def safe_end(doses: list[float], safe: dict[float, bool], limit: float | None = None) -> float:
    """Walking out from 0, the last safe dose before the first unsafe one: 0 when the first is
    unsafe, and a dose that was not measured is not safe. A dose beyond `limit` (the spec's end) is
    left out, so the answer never lies beyond it."""
    last = 0.0
    for dose in sorted(doses, key=abs):
        if limit is not None and abs(dose) > limit:
            break
        if not safe.get(dose, False):
            break
        last = dose
    return last


def build_range(control: str, negative_end: float, positive_end: float) -> dict[str, float]:
    """A control's safe range from the two ends the walk found; never wider than the spec's."""
    low, high = SPEC_RANGES[control]
    return {"min": max(low, min(0.0, negative_end)), "max": min(high, max(0.0, positive_end))}


# --- the sweep ------------------------------------------------------------------------------------


class SweepError(Exception):
    """The sweep cannot run: Zonos or the aligner cannot be reached, or Zonos makes no baseline."""


@dataclass
class Settings:
    zonos_url: str
    out: Path
    seeds: list[int]
    voices: list[VoiceSpec]
    aligner_cli: str | None
    aligner_model: str | None
    aligner_threads: int


class _Context:
    def __init__(self, zonos: ZonosClient, aligner: Aligner | None, voices: list[VoiceSpec]) -> None:
        self.zonos = zonos
        self.aligner = aligner
        self.gate = asyncio.Semaphore(ZONOS_SLOTS)
        # The sample of each language the sweep measures, as a preview speaks it.
        self.words: dict[str, list[str]] = {}
        self.text: dict[str, str] = {}
        for language in sorted({voice.language for voice in voices}):
            spoken = normalize(SAMPLES[language].split(), language)  # type: ignore[arg-type]
            self.words[language] = spoken.words
            self.text[language] = " ".join(spoken.words)
        self.baselines: dict[str, Baseline] = {}


async def _clip(
    ctx: _Context, voice: VoiceSpec, seed: int, control: str | None, dose: float
) -> ClipResult:
    """One clip: made by Zonos (two at a time), measured and judged against the voice's baseline."""
    controls = dict(voice.controls)
    if control is not None:
        controls[control] = dose
    words = ctx.words[voice.language]
    try:
        async with ctx.gate:
            audio, rate = await ctx.zonos.synthesize(
                ctx.text[voice.language], voice.language, Voice(voice.speaker_id, controls), seed
            )
    except ZonosUnavailable as error:
        raise SweepError(f"Zonos could not be reached ({error})") from error
    except SynthesisFailed as error:
        # A control that makes Zonos fail is not safe. The error names a status, never the text.
        return ClipResult(
            voice.language, voice.key, control or "baseline", dose, seed,
            Metrics(0.0, 0.0, 0.0, 0.0), 0, len(words), [f"Zonos could not make the clip ({error})"],
        )  # fmt: skip
    metrics = await asyncio.to_thread(clip_metrics, audio, rate)
    if ctx.aligner is not None:
        timed = await asyncio.to_thread(placed, ctx.aligner, audio, rate, words)
    else:
        timed = len(words)
    problems: list[str] = []
    if control is not None:
        problems = clip_problems(metrics, timed, len(words), ctx.baselines[voice.key], control)
    return ClipResult(
        voice.language, voice.key, control or "baseline", dose, seed, metrics, timed, len(words), problems
    )  # fmt: skip


async def _baseline(ctx: _Context, voice: VoiceSpec) -> tuple[Baseline, list[ClipResult]]:
    clips = await asyncio.gather(
        *(_clip(ctx, voice, seed, None, 0.0) for seed in seeds_for(BASELINE_CLIPS))
    )
    for clip in clips:
        if clip.problems:
            raise SweepError(f"Zonos could not make a baseline clip for {voice.key}")
    ordered = sorted(clip.metrics.seconds for clip in clips)
    baseline = Baseline(
        max_clipped=max(clip.metrics.clipped for clip in clips),
        longest_gap=max(clip.metrics.longest_gap for clip in clips),
        median_seconds=ordered[len(ordered) // 2],
    )
    return baseline, list(clips)


def _clip_json(clip: ClipResult) -> dict[str, object]:
    return {
        "language": clip.language,
        "voice": clip.voice,
        "control": clip.control,
        "dose": clip.dose,
        "seed": clip.seed,
        "seconds": round(clip.metrics.seconds, 3),
        "clipped": round(clip.metrics.clipped, 5),
        "longestGap": round(clip.metrics.longest_gap, 3),
        "peak": round(clip.metrics.peak, 4),
        "placed": clip.placed,
        "words": clip.words,
        "problems": clip.problems,
    }


def _progress(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


async def sweep(settings: Settings, zonos: ZonosClient, aligner: Aligner | None) -> dict[str, object]:
    """The whole sweep: baselines, then each language's controls outward from 0. Returns the report."""
    ctx = _Context(zonos, aligner, settings.voices)
    languages = sorted({voice.language for voice in settings.voices})

    baseline_report: dict[str, object] = {}
    for voice in settings.voices:
        baseline, clips = await _baseline(ctx, voice)
        ctx.baselines[voice.key] = baseline
        baseline_report[voice.key] = {
            "maxClipped": round(baseline.max_clipped, 5),
            "longestGap": round(baseline.longest_gap, 3),
            "medianSeconds": round(baseline.median_seconds, 3),
            "clips": [_clip_json(clip) for clip in clips],
        }
        _progress(f"baseline {voice.key}: median {baseline.median_seconds:.2f} s")

    all_clips: list[ClipResult] = []
    ranges: dict[str, dict[str, object]] = {language: {} for language in languages}
    for language in languages:
        voices = [voice for voice in settings.voices if voice.language == language]
        for control, (low, high) in SPEC_RANGES.items():
            directions: dict[str, object] = {}
            ends: dict[str, float] = {"positive": 0.0, "negative": 0.0}
            for direction, doses in series_of(control).items():
                safe: dict[float, bool] = {}
                first_unsafe: dict[str, object] | None = None
                for dose in doses:
                    clips = list(
                        await asyncio.gather(
                            *(
                                _clip(ctx, voice, seed, control, dose)
                                for voice in voices
                                for seed in settings.seeds
                            )
                        )
                    )
                    all_clips.extend(clips)
                    safe.update(dose_safety(clips))
                    verdict = "safe" if safe[dose] else "UNSAFE"
                    _progress(f"{language} {control} {dose:+g}: {verdict}")
                    if not safe[dose]:
                        bad = next(clip for clip in clips if clip.problems)
                        first_unsafe = {
                            "dose": dose,
                            "voice": bad.voice,
                            "seed": bad.seed,
                            "reasons": bad.problems,
                        }
                        break  # nothing past the first unsafe dose is measured
                spec_end = high if direction == "positive" else low
                ends[direction] = safe_end(doses, safe, limit=abs(spec_end))
                directions[direction] = {
                    "specEnd": spec_end,
                    "safeEnd": ends[direction],
                    "firstUnsafe": first_unsafe,
                }
            ranges[language][control] = {
                "spec": {"min": low, "max": high},
                "safe": build_range(control, ends["negative"], ends["positive"]),
                "directions": directions,
            }

    safe_ranges: dict[str, dict[str, dict[str, float]]] = {}
    for language in ("en", "hu"):
        safe_ranges[language] = {
            control: (
                ranges[language][control]["safe"]  # type: ignore[index]
                if language in ranges
                else {"min": low, "max": high}
            )
            for control, (low, high) in SPEC_RANGES.items()
        }

    return {
        "tool": "scripts/measure_knobs.py",
        "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "zonos": settings.zonos_url,
        "alignerUsed": aligner is not None,
        "seeds": settings.seeds,
        "baselineSeeds": seeds_for(BASELINE_CLIPS),
        "voices": [voice.key for voice in settings.voices],
        "languagesMeasured": languages,
        "baseline": baseline_report,
        "ranges": ranges,
        "safeControlRanges": safe_ranges,
        "clips": [_clip_json(clip) for clip in all_clips],
    }


# --- what is printed ------------------------------------------------------------------------------


def _number(value: float) -> str:
    """A number as the app's source writes it: 1 not 1.0, and never -0."""
    return f"{value + 0.0:g}"


def typescript_object(safe_ranges: dict[str, dict[str, dict[str, float]]]) -> str:
    """`SAFE_CONTROL_RANGES` as `voice-knobs.ts` declares it, to paste in."""
    lines = ["export const SAFE_CONTROL_RANGES: SafeRanges = {"]
    for language in ("en", "hu"):
        lines.append(f"\t{language}: {{")
        for control in SPEC_RANGES:
            end = safe_ranges[language][control]
            lines.append(
                f'\t\t"{control}": {{ min: {_number(end["min"])}, max: {_number(end["max"])} }},'
            )
        lines.append("\t},")
    lines.append("};")
    return "\n".join(lines)


def summary(report: dict[str, object]) -> str:
    lines = [f"Knob ranges measured at {report['measuredAt']} on {report['zonos']}"]
    if not report["alignerUsed"]:
        lines.append("NOTE: no aligner was given, so whether every word is placed was NOT checked.")
    lines.append(f"Voices: {', '.join(report['voices'])}; seeds: {report['seeds']}")  # type: ignore[arg-type]
    ranges = report["ranges"]
    for language in report["languagesMeasured"]:  # type: ignore[attr-defined]
        for control, entry in ranges[language].items():  # type: ignore[index]
            spec, safe = entry["spec"], entry["safe"]
            narrower = safe != spec
            lines.append(
                f"  {language}  {control:<17} spec {_number(spec['min'])}…{_number(spec['max'])}"
                f"  safe {_number(safe['min'])}…{_number(safe['max'])}"
                + ("   <- narrower than the spec" if narrower else "")
            )
            for direction, info in entry["directions"].items():
                unsafe = info["firstUnsafe"]
                if unsafe:
                    lines.append(
                        f"       first unsafe {direction} dose {_number(unsafe['dose'])}"
                        f" ({unsafe['voice']}, seed {unsafe['seed']}): {'; '.join(unsafe['reasons'])}"
                    )
    return "\n".join(lines)


# --- the command ----------------------------------------------------------------------------------


def _positive_int(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is not a whole number") from None
    if value < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return value


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="measure_knobs.py",
        description="Measure the knobs' safe ranges against a running Zonos (see the module's docstring).",
    )
    parser.add_argument("--out", required=True, help="a folder outside the repository for knob-ranges.json")
    parser.add_argument("--zonos", default=DEFAULT_ZONOS, help=f"Zonos's address (default {DEFAULT_ZONOS})")
    parser.add_argument("--aligner-cli", help="the path of fusealign-cli (with --aligner-model)")
    parser.add_argument("--aligner-model", help="the path of its GGUF model (with --aligner-cli)")
    parser.add_argument("--aligner-threads", type=_positive_int, default=DEFAULT_ALIGNER_THREADS)
    parser.add_argument("--seeds", type=_positive_int, default=DEFAULT_SEEDS, help="seeds for each clip")
    parser.add_argument("--voices", help="a comma-separated list of voice keys (default: all six)")
    return parser


def _parse(argv: list[str] | None) -> Settings:
    parser = _build_parser()
    args = parser.parse_args(argv)
    url = urlsplit(args.zonos)
    if url.scheme not in ("http", "https") or not url.netloc:
        parser.error(f"--zonos must be an http or https address, got {args.zonos!r}")
    if bool(args.aligner_cli) != bool(args.aligner_model):
        parser.error("--aligner-cli and --aligner-model go together")
    known = {voice.key: voice for voice in VOICES}
    if args.voices is None:
        voices = list(VOICES)
    else:
        keys = [key.strip() for key in args.voices.split(",")]
        if not keys or any(key == "" for key in keys):
            parser.error("--voices names at least one voice, separated by commas")
        unknown = [key for key in keys if key not in known]
        if unknown:
            parser.error(f"unknown voice {unknown[0]!r}; the voices are {', '.join(known)}")
        voices = [known[key] for key in dict.fromkeys(keys)]
    return Settings(
        zonos_url=args.zonos.rstrip("/"),
        out=Path(args.out),
        seeds=seeds_for(args.seeds),
        voices=voices,
        aligner_cli=args.aligner_cli,
        aligner_model=args.aligner_model,
        aligner_threads=args.aligner_threads,
    )


async def _run(
    settings: Settings, http_client: httpx.AsyncClient | None, aligner: Aligner | None
) -> dict[str, object]:
    own_client = http_client is None
    http = http_client if http_client is not None else httpx.AsyncClient()
    try:
        zonos = ZonosClient(settings.zonos_url, http)
        if not await zonos.healthy():
            raise SweepError(f"Zonos does not answer at {settings.zonos_url}")
        if aligner is None and settings.aligner_cli and settings.aligner_model:
            aligner = NativeFuseAligner(
                settings.aligner_cli, settings.aligner_model, settings.aligner_threads
            )
        if aligner is not None:
            probe = np.sin(2 * np.pi * 220 * np.arange(16000) / 16000).astype(np.float32)
            try:
                await asyncio.to_thread(aligner.align, probe, ["probe"])
            except Exception as error:
                raise SweepError(f"the aligner cannot run ({type(error).__name__})") from error
        return await sweep(settings, zonos, aligner)
    finally:
        if own_client:
            await http.aclose()


def main(
    argv: list[str] | None = None,
    *,
    http_client: httpx.AsyncClient | None = None,
    aligner: Aligner | None = None,
) -> int:
    """Runs the command. `http_client` and `aligner` stand in for Zonos and the aligner in tests."""
    try:
        settings = _parse(argv)
    except SystemExit as stop:
        return stop.code if isinstance(stop.code, int) else 2
    try:
        report = asyncio.run(_run(settings, http_client, aligner))
    except SweepError as error:
        print(f"measure_knobs: {error}", file=sys.stderr)
        return 1
    settings.out.mkdir(parents=True, exist_ok=True)
    (settings.out / REPORT_NAME).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(summary(report))
    print()
    print(typescript_object(report["safeControlRanges"]))  # type: ignore[arg-type]
    print(f"\nReport: {settings.out / REPORT_NAME}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
