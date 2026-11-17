"""Tests of `scripts/measure_knobs.py`, the script that measures the knobs' safe ranges on the box.

They run against the fakes (`fakes_zonos.py`, `fakes_aligner.py`): nothing here needs Zonos, FuseAlign
or the network. The sweep's end-to-end test uses a Zonos whose clips go wrong at chosen doses, so
the narrowing is seen end to end.
"""

import importlib.util
import io
import json
import re
import sys
from collections.abc import Callable
from pathlib import Path

import httpx
import numpy as np
import pytest
import soundfile as sf

from speech_service.aligner import Interval
from tests.fakes_aligner import FakeAligner
from tests.fakes_zonos import Requests, fake_zonos, refusing_transport
from tests.helpers import SR, tone

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "measure_knobs.py"
APP_ROOT = Path(__file__).resolve().parents[3]


def _load():
    """The script as a module, from its path: `scripts/` is no package."""
    spec = importlib.util.spec_from_file_location("measure_knobs", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["measure_knobs"] = module
    spec.loader.exec_module(module)
    return module


mk = _load()


def _holes(seconds: float, holes: list[tuple[float, float]], clipped_every: int = 0) -> np.ndarray:
    """A tone of `seconds` with silent holes and, in the tone, every `clipped_every`-th sample at 1.0."""
    x = tone(0.3, seconds)
    for start, end in holes:
        x[round(start * SR) : round(end * SR)] = 0.0
    if clipped_every:
        mask = np.zeros(len(x), dtype=bool)
        mask[::clipped_every] = True
        for start, end in holes:
            mask[round(start * SR) : round(end * SR)] = False
        x[mask] = 1.0
    return x


# --- the numbers measured from one clip ---------------------------------------------------------


def test_clip_metrics_counts_clipping_and_the_longest_inner_gap():
    # 5 s of tone with a 1 s hole in the middle and 2% of the tone's samples clipped.
    x = _holes(5.0, [(2.0, 3.0)], clipped_every=50)
    metrics = mk.clip_metrics(x, SR)
    assert metrics.seconds == pytest.approx(5.0)
    clipped_samples = int(np.sum(np.abs(x) >= 0.999))
    assert metrics.clipped == pytest.approx(clipped_samples / len(x))
    assert metrics.clipped == pytest.approx(0.016, abs=0.001)
    assert metrics.longest_gap == pytest.approx(1.0, abs=0.05)
    assert metrics.peak == pytest.approx(1.0)


def test_leading_and_trailing_silence_is_not_a_gap():
    x = _holes(4.0, [(0.0, 0.7), (3.4, 4.0)])
    metrics = mk.clip_metrics(x, SR)
    assert metrics.longest_gap == pytest.approx(0.0, abs=0.02)
    assert metrics.clipped == 0.0


def test_the_longest_of_several_gaps_counts():
    x = _holes(6.0, [(1.0, 1.3), (2.5, 3.9), (5.0, 5.2)])
    assert mk.clip_metrics(x, SR).longest_gap == pytest.approx(1.4, abs=0.05)


def test_a_clip_of_nothing_and_a_clip_of_silence_have_no_gap_to_measure():
    assert mk.clip_metrics(np.zeros(0, dtype=np.float32), SR).seconds == 0.0
    silent = mk.clip_metrics(np.zeros(SR, dtype=np.float32), SR)
    assert silent.peak == 0.0
    assert silent.longest_gap == 0.0


class _DropsAWord(FakeAligner):
    """A FakeAligner that does not place the word at `index`."""

    def __init__(self, index: int) -> None:
        super().__init__()
        self.index = index

    def align(self, audio_16k: np.ndarray, words: list[str]) -> list[Interval | None]:
        times = super().align(audio_16k, words)
        if times:
            times[self.index] = None
        return times


def _baseline(**changes):
    values = {"max_clipped": 0.0, "longest_gap": 0.1, "median_seconds": 4.0}
    return mk.Baseline(**{**values, **changes})


def _metrics(**changes):
    values = {"seconds": 4.0, "clipped": 0.0, "longest_gap": 0.1, "peak": 0.5}
    return mk.Metrics(**{**values, **changes})


WORDS = ["one", "two", "three", "four", "five"]


def test_placed_counts_the_words_the_aligner_timed():
    x = tone(0.3, 3.0)
    assert mk.placed(FakeAligner(), x, SR, WORDS) == 5
    assert mk.placed(_DropsAWord(2), x, SR, WORDS) == 4
    # An aligner that cannot time the clip at all places nothing.
    assert mk.placed(FakeAligner(fail=True), x, SR, WORDS) == 0


def test_a_dropped_word_fails_the_clip():
    problems = mk.clip_problems(_metrics(), 4, 5, _baseline(), "mood.arousal")
    assert len(problems) == 1
    assert "4 of 5 words" in problems[0]
    assert mk.clip_problems(_metrics(), 5, 5, _baseline(), "mood.arousal") == []


def test_a_clip_fails_for_each_of_its_faults_and_says_why():
    base = _baseline(max_clipped=0.002, longest_gap=0.5, median_seconds=4.0)
    ok = _metrics(clipped=0.0029, longest_gap=0.7, seconds=4.0)
    assert mk.clip_problems(ok, 5, 5, base, "pitch.pitch") == []
    # Clipping more than the baseline's highest by more than 0.001.
    assert mk.clip_problems(_metrics(clipped=0.0031), 5, 5, base, "pitch.pitch")
    # A gap longer than 1.5 x the baseline's, and at least 0.8 s.
    assert mk.clip_problems(_metrics(longest_gap=0.8), 5, 5, base, "pitch.pitch") == []
    assert mk.clip_problems(_metrics(longest_gap=0.81), 5, 5, base, "pitch.pitch")
    long_gap = _baseline(longest_gap=1.0)
    assert mk.clip_problems(_metrics(longest_gap=1.5), 5, 5, long_gap, "pitch.pitch") == []
    assert mk.clip_problems(_metrics(longest_gap=1.51), 5, 5, long_gap, "pitch.pitch")
    # A length outside 0.5-2.0 x the baseline's median (tempo: 0.4-2.5 x).
    assert mk.clip_problems(_metrics(seconds=8.0), 5, 5, base, "pitch.pitch") == []
    assert mk.clip_problems(_metrics(seconds=8.1), 5, 5, base, "pitch.pitch")
    assert mk.clip_problems(_metrics(seconds=2.0), 5, 5, base, "pitch.pitch") == []
    assert mk.clip_problems(_metrics(seconds=1.9), 5, 5, base, "pitch.pitch")
    assert mk.clip_problems(_metrics(seconds=10.0), 5, 5, base, "delivery.tempo") == []
    assert mk.clip_problems(_metrics(seconds=10.1), 5, 5, base, "delivery.tempo")
    assert mk.clip_problems(_metrics(seconds=1.6), 5, 5, base, "delivery.tempo") == []
    assert mk.clip_problems(_metrics(seconds=1.5), 5, 5, base, "delivery.tempo")
    # A clip that is silent is no clip.
    assert mk.clip_problems(_metrics(peak=0.0), 5, 5, base, "pitch.pitch")
    # Several faults are several reasons.
    assert len(mk.clip_problems(_metrics(clipped=0.1, seconds=20.0), 3, 5, base, "pitch.pitch")) == 3


# --- from doses to ranges -----------------------------------------------------------------------


def test_safe_end_stops_before_the_first_unsafe_dose():
    doses = [0.5, 1.0, 1.5, 2.0]
    assert mk.safe_end(doses, {0.5: True, 1.0: True, 1.5: False, 2.0: True}) == 1.0
    assert mk.safe_end(doses, {0.5: False, 1.0: True, 1.5: True, 2.0: True}) == 0.0
    assert mk.safe_end(doses, dict.fromkeys(doses, True)) == 2.0
    negative = [-0.5, -1.0, -1.5, -2.0]
    assert mk.safe_end(negative, {-0.5: True, -1.0: True, -1.5: True, -2.0: False}) == -1.5
    # The order they are given in does not matter: it is out from 0.
    assert mk.safe_end([2.0, 0.5, 1.5, 1.0], {0.5: True, 1.0: True, 1.5: False, 2.0: True}) == 1.0
    # A dose that was not measured is not safe.
    assert mk.safe_end([0.5, 1.0], {0.5: True}) == 0.5


def test_never_reports_beyond_the_spec():
    # A dose past the spec's end is ignored, even when everything is safe.
    doses = [0.5, 1.0, 2.5]
    assert mk.safe_end(doses, dict.fromkeys(doses, True), limit=2.0) == 1.0
    assert mk.safe_end([-0.5, -3.0], {-0.5: True, -3.0: True}, limit=2.0) == -0.5
    # Every control's doses end at the spec's end, never beyond it.
    for control, (low, high) in mk.SPEC_RANGES.items():
        ends = [d for d in mk.doses_of(control)]
        assert max(abs(d) for d in ends) <= max(abs(low), abs(high))
        assert max((d for d in ends if d > 0), default=0.0) == high
        assert min((d for d in ends if d < 0), default=0.0) == low
    # And the ranges built from the results are never wider than the spec's.
    assert mk.build_range("delivery.tempo", -5.0, 5.0) == {"min": -2.0, "max": 2.0}
    assert mk.build_range("texture.deep", -1.0, 9.0) == {"min": 0.0, "max": 4.0}
    assert mk.build_range("delivery.whisper", 0.0, 1.0) == {"min": 0.0, "max": 1.0}


def test_the_doses_are_the_plans():
    assert sorted(mk.doses_of("delivery.tempo")) == [-2.0, -1.5, -1.0, -0.5, 0.5, 1.0, 1.5, 2.0]
    assert sorted(mk.doses_of("pitch.pitch")) == [-2.0, -1.5, -1.0, -0.5, 0.5, 1.0, 1.5, 2.0]
    assert sorted(mk.doses_of("texture.deep")) == [1.0, 2.0, 3.0, 4.0]
    assert sorted(mk.doses_of("mood.arousal")) == [-4.0, -3.0, -2.0, -1.0, 1.0, 2.0, 3.0, 4.0]
    assert sorted(mk.doses_of("delivery.whisper")) == [0.5, 1.0, 1.5]
    assert sorted(mk.doses_of("delivery.loud")) == [0.5, 1.0, 1.5, 2.0]


def _clip(dose: float, voice: str, seed: int, problems: list[str]):
    return mk.ClipResult(
        language="en",
        voice=voice,
        control="delivery.tempo",
        dose=dose,
        seed=seed,
        metrics=_metrics(),
        placed=5,
        words=5,
        problems=problems,
    )


def test_a_dose_is_unsafe_for_a_language_when_any_voice_or_seed_fails():
    clips = [
        _clip(0.5, "imogen", 1234, []),
        _clip(0.5, "rupert", 1234, []),
        _clip(1.0, "imogen", 1234, []),
        _clip(1.0, "rupert", 1234, []),
        _clip(1.0, "rupert", 2345, ["a word was not placed"]),
        _clip(1.5, "imogen", 1234, ["clipping"]),
        _clip(1.5, "rupert", 1234, ["clipping"]),
    ]
    assert mk.dose_safety(clips) == {0.5: True, 1.0: False, 1.5: False}


# --- the sweep, end to end, on the fakes ---------------------------------------------------------

KNOWN_ZONOS_FIELDS = {
    "text",
    "language",
    "format",
    "stream",
    "speaker_embedding_id",
    "speaker_mode",
    "seed",
    "text_normalization",
    "controls",
}


def _wav(x: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    sf.write(buffer, x, SR, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def controlled_zonos(
    fail_when: Callable[[dict], bool] | None = None,
) -> tuple[httpx.AsyncClient, Requests]:
    """A Zonos whose clips go wrong at chosen doses, like a real one at the edge of a control.

    Normal clips are a tone 0.06 s a character long. At a tempo of 1.5 or more a 2 s hole opens
    in the clip; at a tempo of -2 the clip is far too short; a whisper of 1.5 clips; a deep of 3
    or more makes the clip three times as long. `fail_when(body)` answers a request with a 500.
    """
    requests = Requests()

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path == "/v2/health":
            return httpx.Response(200, json={"status": "ok"})
        body = json.loads(request.content)
        requests.append(body)
        controls = body.get("controls", {})
        seconds = 0.06 * len(body["text"]) + 0.3
        if fail_when is not None and fail_when(body):
            return httpx.Response(500, json={"detail": "synthesis failed"})
        x = tone(0.3, seconds)
        if controls.get("delivery.tempo", 0.0) >= 1.5:
            x = _holes(seconds, [(0.8, 2.8)])
        if controls.get("delivery.tempo", 0.0) <= -2.0:
            x = tone(0.3, seconds * 0.2)
        if controls.get("delivery.whisper", 0.0) >= 1.5:
            x = _holes(seconds, [], clipped_every=10)
        if controls.get("texture.deep", 0.0) >= 3.0:
            x = tone(0.3, seconds * 3)
        return httpx.Response(200, content=_wav(x), headers={"content-type": "audio/wav"})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler)), requests


def _run(tmp_path: Path, http: httpx.AsyncClient, *extra: str, aligner=None) -> tuple[int, Path]:
    out = tmp_path / "out"
    code = mk.main(
        ["--out", str(out), "--seeds", "1", "--voices", "imogen,berta", *extra],
        http_client=http,
        aligner=aligner if aligner is not None else FakeAligner(),
    )
    return code, out


def test_sends_only_the_fields_zonos_knows(tmp_path: Path):
    http, requests = controlled_zonos()
    code, _ = _run(tmp_path, http)
    assert code == 0
    assert requests
    for body in requests:
        assert set(body) <= KNOWN_ZONOS_FIELDS, set(body) - KNOWN_ZONOS_FIELDS
        assert {"text", "language", "speaker_embedding_id", "seed"} <= set(body)
        assert body["speaker_mode"] == "embedding"
        assert body["format"] == "wav"
        assert body["stream"] is False
        assert body["language"] in {"en_us", "hu"}
        assert body["speaker_embedding_id"] in {
            "default_b78b28baf5c31a1d",
            "default_bf7632822e6b4dc0",
        }
    # Every control is a known control at a dose of the plan, on top of the voice's own.
    for body in requests:
        controls = dict(body.get("controls", {}))
        controls.pop("room.clean", None)
        assert len(controls) <= 1
        for name, dose in controls.items():
            assert dose in mk.doses_of(name)
    # Hungarian carries Berta's studio control in every request, English none of its own.
    hungarian = [b for b in requests if b["language"] == "hu"]
    assert hungarian
    assert all(b.get("controls", {}).get("room.clean") == 2 for b in hungarian)
    english = [b for b in requests if b["language"] == "en_us"]
    assert all("room.clean" not in b.get("controls", {}) for b in english)


def test_at_most_two_requests_run_at_once(tmp_path: Path):
    http, requests = fake_zonos(concurrency=8)
    code, _ = _run(tmp_path, http)
    assert code == 0
    assert requests.max_in_flight <= 2


def test_runs_end_to_end_on_the_fakes_and_writes_only_the_report(tmp_path: Path, capsys):
    http, requests = controlled_zonos()
    code, out = _run(tmp_path, http)
    assert code == 0
    # The out folder holds the report and nothing else.
    assert sorted(p.name for p in out.iterdir()) == ["knob-ranges.json"]
    report = json.loads((out / "knob-ranges.json").read_text(encoding="utf-8"))

    for language in ("en", "hu"):
        ranges = report["safeControlRanges"][language]
        assert ranges["delivery.tempo"] == {"min": -1.5, "max": 1.0}
        assert ranges["texture.deep"] == {"min": 0.0, "max": 2.0}
        assert ranges["delivery.whisper"] == {"min": 0.0, "max": 1.0}
        # What went right at every dose stays at the spec's end.
        assert ranges["pitch.pitch"] == {"min": -2.0, "max": 2.0}
        assert ranges["mood.arousal"] == {"min": -4.0, "max": 4.0}
        assert ranges["delivery.loud"] == {"min": 0.0, "max": 2.0}

    tempo = report["ranges"]["en"]["delivery.tempo"]
    assert tempo["spec"] == {"min": -2.0, "max": 2.0}
    assert tempo["directions"]["positive"]["safeEnd"] == 1.0
    assert tempo["directions"]["positive"]["specEnd"] == 2.0
    first_unsafe = tempo["directions"]["positive"]["firstUnsafe"]
    assert first_unsafe["dose"] == 1.5
    assert first_unsafe["voice"] == "imogen"
    assert first_unsafe["seed"] == 1234
    assert any("gap" in reason for reason in first_unsafe["reasons"])
    assert tempo["directions"]["negative"]["safeEnd"] == -1.5
    assert tempo["directions"]["negative"]["firstUnsafe"]["dose"] == -2.0
    pitch = report["ranges"]["en"]["pitch.pitch"]["directions"]
    assert pitch["positive"]["firstUnsafe"] is None
    assert pitch["negative"]["firstUnsafe"] is None

    # Nothing is measured past the first unsafe dose.
    doses_sent = {
        body["controls"]["delivery.tempo"]
        for body in requests
        if "delivery.tempo" in body.get("controls", {})
    }
    assert doses_sent == {-0.5, -1.0, -1.5, -2.0, 0.5, 1.0, 1.5}
    assert 2.0 not in doses_sent
    # Every clip measured is in the report, with its numbers and no audio.
    assert report["clips"]
    clip = report["clips"][0]
    assert {"language", "voice", "control", "dose", "seed", "seconds", "clipped", "longestGap", "placed", "words", "problems"} <= set(clip)

    # The summary names the ranges and prints the object to paste.
    printed = capsys.readouterr().out
    assert "SAFE_CONTROL_RANGES" in printed
    assert '"delivery.tempo": { min: -1.5, max: 1 }' in printed


def test_the_report_holds_no_audio_and_no_text_but_the_samples(tmp_path: Path):
    http, requests = controlled_zonos()
    code, out = _run(tmp_path, http)
    assert code == 0
    raw = (out / "knob-ranges.json").read_text(encoding="utf-8")
    for body in requests[:6]:
        assert body["text"] not in raw
    assert "RIFF" not in raw
    assert "base64" not in raw.lower()
    # A reason is a reason: no clip, no sentence.
    assert max(len(s) for s in re.findall(r'"([^"]*)"', raw)) < 200


def test_no_sweep_when_zonos_cannot_make_the_baseline(tmp_path: Path, capsys):
    # No clip with a Hungarian voice is made: there is no baseline to measure against.
    http, requests = controlled_zonos(fail_when=lambda body: body["language"] == "hu")
    code, out = _run(tmp_path, http)
    assert code == 1
    assert not out.exists()
    assert requests
    assert "baseline" in capsys.readouterr().err


def test_a_dose_zonos_cannot_make_is_unsafe_and_the_sweep_goes_on(tmp_path: Path):
    http, _ = controlled_zonos(
        fail_when=lambda body: body.get("controls", {}).get("delivery.loud") == 1.0
    )
    code, out = _run(tmp_path, http)
    assert code == 0
    report = json.loads((out / "knob-ranges.json").read_text(encoding="utf-8"))
    assert report["safeControlRanges"]["en"]["delivery.loud"] == {"min": 0.0, "max": 0.5}
    unsafe = report["ranges"]["en"]["delivery.loud"]["directions"]["positive"]["firstUnsafe"]
    assert unsafe["dose"] == 1.0
    assert any("Zonos" in reason for reason in unsafe["reasons"])
    # What came before and after, in other controls, is measured as it would have been.
    assert report["safeControlRanges"]["en"]["pitch.pitch"] == {"min": -2.0, "max": 2.0}


# --- what the command does with what it is given ------------------------------------------------


def test_exit_1_when_zonos_cannot_be_reached(tmp_path: Path, capsys):
    code, out = _run(tmp_path, refusing_transport())
    assert code == 1
    assert not out.exists()
    assert "Zonos" in capsys.readouterr().err


def test_exit_1_when_the_aligner_cannot_run(tmp_path: Path, capsys):
    http, _ = controlled_zonos()
    code, out = _run(tmp_path, http, aligner=FakeAligner(fail=True))
    assert code == 1
    assert not out.exists()
    assert "aligner" in capsys.readouterr().err


@pytest.mark.parametrize(
    "arguments",
    [
        [],
        ["--out"],
        ["--out", "x", "--seeds", "0"],
        ["--out", "x", "--seeds", "many"],
        ["--out", "x", "--voices", "nobody"],
        ["--out", "x", "--voices", ""],
        ["--out", "x", "--zonos", "not a url"],
        ["--out", "x", "--aligner-cli", "/bin/echo"],
        ["--out", "x", "--aligner-model", "/tmp/model.gguf"],
        ["--out", "x", "--aligner-threads", "0"],
        ["--out", "x", "--unknown"],
    ],
)
def test_exit_2_for_a_bad_argument(arguments: list[str], tmp_path: Path):
    arguments = [str(tmp_path / "out") if a == "x" else a for a in arguments]
    assert mk.main(arguments) == 2
    assert not (tmp_path / "out").exists()


def test_seeds_start_with_the_services_own():
    assert mk.seeds_for(1) == [1234]
    assert mk.seeds_for(3)[0] == 1234
    assert len(set(mk.seeds_for(5))) == 5
    assert mk.seeds_for(3) == mk.seeds_for(5)[:3]


# --- the constants are the app's -----------------------------------------------------------------


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
        (key, language, speaker, json.loads(controls.replace(",}", "}")))
        for key, language, speaker, controls in pattern.findall(voices_ts)
    ]
    assert len(app_voices) == 6
    assert [(v.key, v.language, v.speaker_id, v.controls) for v in mk.VOICES] == app_voices

    samples_ts = (APP_ROOT / "src/lib/shared/read-aloud/voice-samples.ts").read_text(encoding="utf-8")
    for language in ("en", "hu"):
        block = re.search(rf"\b{language}: \[(.*?)\],\s*(?:hu|en|\}})", samples_ts, re.S)
        assert block, language
        sentences = re.findall(r'"((?:[^"\\]|\\.)*)"', block.group(1))
        assert len(sentences) == 2
        assert mk.SAMPLES[language] == " ".join(sentences)
        assert len(mk.SAMPLES[language]) <= 300
