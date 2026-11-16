# Speech Service

The read-aloud speech service (Python 3.12, Starlette on uvicorn) runs on the GPU box beside Zonos. It turns a reply's sentences into one MP3 stream and a timeline of sentence and word times: Zonos gives the voice, FuseAlign the word timing. AlfyAI's server is its only client, and the service holds no user data. Design: [`docs/superpowers/specs/2026-11-16-read-aloud-design.md`](../../docs/superpowers/specs/2026-11-16-read-aloud-design.md) (§3, §4.10, §6).

- **Loopback only.** It binds `127.0.0.1`, port **1920** (Zonos is on 1919), and nothing else: `Settings` raises `ValueError` for any host but `127.0.0.0/8`, `::1` and `localhost`. Never add a bind, a proxy rule or a flag that reaches past the box.
- **`Settings` is the one door to the environment.** `speech_service/config.py` declares every setting, its default and its `SPEECH_*` variable. No other module reads a `SPEECH_*` variable; only the entry point passes `os.environ` to `Settings.from_env`.
- **Nothing is written to disk.** No audio, no text, no cache, no temp file. A sentence's audio goes from memory through the encoder into the session's one HTTP response.
- **No reply text in logs.** Ids, counts and timings only: never a sentence, a token, a request body or an exception text that quotes one.
- **The Zonos request is exact.** One request per sentence, to `SPEECH_ZONOS_URL` (default `http://127.0.0.1:1919`). Besides the text and the voice, every request sends `language` (`en_us` or `hu`), `speaker_mode: "embedding"`, `seed` (1234 by default), `text_normalization: false` (the service normalizes first) and the caller's `controls` unchanged. Zonos answers an unknown field with 422, so send nothing else.
- **A sentence is at most 400 characters.** Zonos caps a request at 1500 frames (about 100 s), cuts off silently after that, and runs two syntheses at once (`--batch 2`). The service never sends a longer sentence; it answers 422.
- **Prefetch is 2 by default** (`SPEECH_PREFETCH` overrides it). At most that many sentences are synthesized beyond the reader's reported position.
- **Loudness and gaps.** Each sentence is matched to an RMS of -20 dBFS over its speech frames, with peaks at most -1 dBFS. Gaps between sentences are 0.30 s, and 0.60 s where a new paragraph starts.
- **Audio out is MP3**, 44.1 kHz mono, 128 kbit/s, written progressively to one HTTP response per session.
- **The whole service stays within about 1.5 GB resident** (spec §6.4), so a session keeps no sentence's audio once it is written.
- **Never restart or reconfigure vLLM or `zonos3.service`.** Any change on the box needs the owner's OK first (`alfyroot` for systemd, `alfyws` for files).
- **The Hungarian voices' reference audio is never committed or published.** Their datasets' terms forbid identifying the speakers: no clip, no fixture made from one, nothing public.

## Tests

`scripts/gates.sh` does not run these; run them yourself from `deploy/speech-service` when you change this folder. The dev venv is `.venv` (git-ignored), made with uv on the owner's Mac. Never `pip install` into any other environment.

```bash
UV_CACHE_DIR=/Users/lvt53/Downloads/.uv-cache /Users/lvt53/Downloads/.tools/uv venv --python /opt/homebrew/bin/python3.12 .venv
UV_CACHE_DIR=/Users/lvt53/Downloads/.uv-cache /Users/lvt53/Downloads/.tools/uv pip install --python .venv/bin/python -e '.[dev]'
.venv/bin/python -m pytest -q
```

Live tests (marked `live`; they need FuseAlign weights and local audio) run read only under the zonos3 checkout's Python, which has torch and FuseAlign. Never write anything into `~/Downloads/zonos3`. That Python has no pytest-asyncio, so never pass `--strict-config` (the `asyncio_*` options would fail it).

```bash
SPEECH_LIVE=1 HF_HOME=/Users/lvt53/Downloads/.hf-home PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. ~/Downloads/zonos3/.venv/bin/python -m pytest -p no:cacheprovider -m live
```
