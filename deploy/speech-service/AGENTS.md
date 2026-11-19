# Speech Service

The read-aloud speech service (Python 3.12, Starlette on uvicorn) runs on the GPU box beside Zonos. It turns a reply's sentences into one MP3 stream and a timeline of sentence and word times: Zonos gives the voice, FuseAlign the word timing. AlfyAI's server is its only client, and the service holds no user data. Design: [`docs/superpowers/specs/2026-11-16-read-aloud-design.md`](../../docs/superpowers/specs/2026-11-16-read-aloud-design.md) (§3, §4.10, §6).

- **Loopback only.** It binds `127.0.0.1`, port **1920** (Zonos is on 1919), and nothing else: `Settings` raises `ValueError` for any host but `127.0.0.0/8`, `::1` and `localhost`. Never add a bind, a proxy rule or a flag that reaches past the box.
- **`Settings` is the one door to the environment.** `speech_service/config.py` declares every setting, its default and its `SPEECH_*` variable. No other module in `speech_service/` reads a `SPEECH_*` variable; only the entry point passes `os.environ` to `Settings.from_env`. (Test modules read `SPEECH_LIVE` and `SPEECH_LIVE_WAV` to gate the live tests.)
- **Nothing is written to disk**, with one exception: the native aligner's `TemporaryDirectory` (`aligner.py`), which holds one sentence's WAV and JSONL for the length of one call (calls run one at a time) and is deleted when the call ends, success or failure. No audio, no text, no cache, no other temp file. A sentence's audio goes from memory through the encoder into the session's one HTTP response.
- **No reply text in logs.** Ids, counts and timings only: never a sentence, a token, a request body or an exception text that quotes one.
- **The Zonos request is exact.** One request per sentence, to `SPEECH_ZONOS_URL` (default `http://127.0.0.1:1919`). Besides the text and the voice, every request sends `language` (`en_us` or `hu`), `speaker_mode: "embedding"`, `seed` (1234 by default), `text_normalization: false` (the service normalizes first) and the caller's `controls` unchanged. Zonos answers an unknown field with 422, so send nothing else.
- **A sentence is at most 400 characters.** Zonos caps a request at 1500 frames (about 100 s), cuts off silently after that, and runs two syntheses at once (`--batch 2`). The service never sends a longer sentence; it answers 422.
- **Prefetch is 2 by default** (`SPEECH_PREFETCH` overrides it). At most that many sentences are synthesized beyond the reader's reported position.
- **A stalled clip is made again.** `speech_service/steady.py` is the one place that judges a clip: `session.py` and `app.py` both call `synthesize_steady`, never `ZonosClient.synthesize` directly, so a reading and a preview are mended alike. The retry seeds are the sentence's seed plus multiples of 7,919, which keeps a reading repeatable. `steady.py` logs nothing; its callers log numbers only (a retry at debug level in a session, at info for a preview, and a count on the line that ends a session), never the text. Its limits (`LENGTH_RATIO`, `GAP_SECONDS`, `expected_seconds`) were chosen on measured clips (its docstring has them): change them with new measurements, not by feel. `SPEECH_STEADY_ATTEMPTS=1` turns the retries off.
- **A yes/no question is lifted and judged.** `speech_service/questions.py` finds the last word of each yes/no question in the text Zonos is sent (a sentence ending in one plain "?" whose first word is not a question word: those fall) and `synthesize_steady` passes it as a `control_spans` of `delivery.pitch` (`SPEECH_QUESTION_LIFT`), and, when the text ends in such a question, makes a clip again under the next seed while its end rises less than `SPEECH_QUESTION_RISE` semitones (`final_rise`, numpy alone). A span is placed by its characters at one codec frame (1/15 s) a character, which suits Berta and Imre (15 characters a second) and not Imogen (18): `RateMemory` learns each voice's rate from the clips it makes and `synthesize_steady` sends `control_span_rate`. Hungarian questions rise on the penultimate syllable and fall on the last, so there the lift stops before the last syllable (`_final_syllable_start`) and `penultimate_rise` judges the clip, not `final_rise`. A flat question scores `FLAT_QUESTION` (1.0): worse than a rising clip, better than a stall. The numbers are in `questions.py` and the README's "Questions"; the question-word lists are English and Hungarian only.
- **Loudness and gaps.** Each sentence is matched to an RMS of -20 dBFS over its speech frames, with peaks at most -1 dBFS. Gaps between sentences are 0.45 s, and 0.82 s where a new paragraph starts (`SPEECH_GAP_SECONDS`, `SPEECH_PARAGRAPH_GAP_SECONDS`), and each silence of 0.12 to 0.8 s inside a sentence is lengthened by 0.12 s (`SPEECH_BREATH_SECONDS`, `audio.lengthen_pauses`, after the trim and the loudness match, so the timeline and the aligner see the audio that is played).
- **Audio out is MP3**, 44.1 kHz mono, 128 kbit/s, written progressively to one HTTP response per session.
- **The whole service stays within about 1.5 GB resident** (spec §6.4), so a session keeps no sentence's audio once it is written.
- **Never restart or reconfigure vLLM or `zonos3.service` without the owner's OK.** Any change on the box needs the owner's OK first (`alfyroot` for systemd, `alfyws` for files). Since 2026-11-18 both run under NVIDIA MPS on GPU0, at the owner's decision; units, numbers and rollback are in [`deploy/gpu0-mps/`](../gpu0-mps/README.md).
- **The Hungarian voices' reference audio is never committed or published.** Their datasets' terms forbid identifying the speakers: no clip, no fixture made from one, nothing public.
- **Dependencies are locked.** `requirements.lock` holds the exact versions of the runtime dependencies (CPython 3.12, Linux x86_64) that the tests ran on, and the box installs from it: `app.py`'s `_Stream` relies on Starlette's internals, so a version nobody tested must never be pulled in. A change to the dependencies in `pyproject.toml`, or to the versions the dev venv runs on, regenerates the lock in the same change (the commands are under Tests).
- **`scripts/` holds checks run by hand** (the live check, the knob ranges, the speaking rates). They write only into the `--out` folder they are given, never into the repository, and they log no reply text. `scripts/measure_knobs.py` copies the voices, the samples and the spec's ranges from the app (`voices.ts`, `voice-samples.ts`, `voice-knobs.ts`), `scripts/measure_rates.py` the voices and the samples, and `tests/test_measure_knobs.py` and `tests/test_measure_rates.py` fail when the copies drift.

## Tests

`scripts/gates.sh` does not run these; run them yourself from `deploy/speech-service` when you change this folder. The dev venv is `.venv` (git-ignored), made with uv on the owner's Mac. Never `pip install` into any other environment.

The service and its tests need ffmpeg with libmp3lame on `PATH` (the Mac: Homebrew's; the box has ffmpeg 7.1.5 with libmp3lame installed). The service stops at start-up without it.

```bash
UV_CACHE_DIR=/Users/lvt53/Downloads/.uv-cache /Users/lvt53/Downloads/.tools/uv venv --python /opt/homebrew/bin/python3.12 .venv
UV_CACHE_DIR=/Users/lvt53/Downloads/.uv-cache /Users/lvt53/Downloads/.tools/uv pip install --python .venv/bin/python -e '.[dev]'
.venv/bin/python -m pytest -q
```

To regenerate `requirements.lock` after the dev venv's versions or `pyproject.toml`'s dependencies changed (and the tests passed on them), freeze the dev venv and compile `pyproject.toml` against the freeze. The lock then equals the tested versions, for the box's platform, and holds no dev tools. `dev-freeze.txt` is git-ignored: delete it afterwards.

```bash
UV_CACHE_DIR=/Users/lvt53/Downloads/.uv-cache /Users/lvt53/Downloads/.tools/uv pip freeze --python .venv/bin/python --exclude-editable > dev-freeze.txt
UV_CACHE_DIR=/Users/lvt53/Downloads/.uv-cache /Users/lvt53/Downloads/.tools/uv pip compile pyproject.toml --python-version 3.12 --python-platform x86_64-unknown-linux-gnu -c dev-freeze.txt -o requirements.lock
rm dev-freeze.txt
```

Live tests (marked `live`; they need FuseAlign weights and local audio) run read only under the zonos3 checkout's Python, which has torch and FuseAlign. Never write anything into `~/Downloads/zonos3`. That Python has no pytest-asyncio, so never pass `--strict-config` (the `asyncio_*` options would fail it).

```bash
SPEECH_LIVE=1 HF_HOME=/Users/lvt53/Downloads/.hf-home PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. ~/Downloads/zonos3/.venv/bin/python -m pytest -p no:cacheprovider -m live
```
