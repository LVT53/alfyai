# Read Aloud — Plan 1 of 4: The Speech Service

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A loopback HTTP service on the GPU box that turns a reply's sentences into one continuous MP3 stream plus a timeline of sentence and word times, using Zonos for the voice and FuseAlign for word timing.

**Architecture:** A small Python 3.12 service in `deploy/speech-service/` (Starlette on uvicorn). Each reading is a session: a worker synthesizes sentence by sentence through Zonos, keeping a set number of sentences ahead of the reader's reported position. For each sentence it normalizes the text (zyphra-textnorm plus the Hungarian "két" fix), synthesizes it, matches its loudness, aligns its words, appends it to one MP3 encoder, and emits timeline events over SSE. AlfyAI's server (Plan 2) is its only client and passes voices and controls through; the service holds no user data and writes nothing to disk.

**Tech Stack:** Python 3.12, starlette, uvicorn, httpx, numpy, soundfile, zyphra-textnorm, fusealign-hub (CPU) or the native `fusealign-cli`, ffmpeg (libmp3lame) as a piped subprocess, pytest with pytest-asyncio.

**Spec:** `docs/superpowers/specs/2026-11-16-read-aloud-design.md` (§3, §4.4, §4.10, §6, §9). Read it before starting. The design session's spike scripts are in `docs/superpowers/specs/2026-11-16-read-aloud/spikes/`. The approved Hungarian voices and their rebuild note are in `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.superpowers/hu-voices/`, which is git-ignored, so use the absolute path from a worktree.

## The four plans

| Plan | Delivers | Depends on |
|---|---|---|
| **1. The speech service** (this plan) | text in → audio stream + word timeline out; deployed on the box beside Zonos | nothing |
| 2. Reading in the chat | config, the session routes, the speech script, the speaker button, marks, the floating player and its failure states, Read from here, per-paragraph voices with a read-aloud language detector; built against a fake of this service | Plan 1's contract |
| 3. Voices and the editor | personal voices (DB and API), Settings → Read aloud, the voice editor, previews | Plans 1 and 2 |
| 4. Guide, docs and rollout | Feature Guide entry, ADR-0070, README and runbook, knob ranges re-measured on the box, owner's listening checkpoints, enabling on staging then production | Plans 1–3 |

Plans 2–4 are written in detail when their turn comes, so they build on what this one learns.

## Global Constraints

- Bind `127.0.0.1` only; default port **1920** (Zonos is on 1919). Never expose it beyond loopback.
- Nothing is written to disk: no audio, no text. Logs carry no reply text (ids, counts and timings only).
- Zonos is reached at `ZONOS_URL` (default `http://127.0.0.1:1919`). One request per sentence. Every request sends:
  - `language` `en_us` or `hu`
  - `speaker_mode: "embedding"`
  - `seed` 1234
  - `text_normalization: false` (the service normalizes first)
  - the caller's `controls` unchanged

  Unknown request fields make Zonos answer 422, so send nothing else.
- Zonos runs two syntheses at once (`--batch 2`) and caps a request at 1500 frames (about 100 s). The service never sends a sentence over 400 characters; it answers 422 instead.
- Prefetch: keep at most **2** sentences synthesized beyond the reader's reported position.
- Loudness: match each sentence to an RMS of −20 dBFS over its speech frames, with peaks at most −1 dBFS.
- Gaps between sentences: **0.30 s**, and **0.60 s** where a new paragraph starts (my call; the spec leaves gaps to the builder).
- Audio out: MP3, 44.1 kHz mono, 128 kbit/s, written progressively to one HTTP response per session.
- Memory budget for the whole service: about **1.5 GB** resident (spec §6.4).
- vLLM and `zonos3.service` are never restarted or reconfigured by this work. Any change on the box needs the owner's OK first (`alfyroot` for systemd; `alfyws` for files).

## Review Focus

1. **A reader closes the tab without stopping.** The session must end by itself and stop calling Zonos within 30 s of losing its last audio reader. Test: `test_session_ends_when_reader_leaves` (Task 5).
2. **A very long reply (200 sentences).** It streams with bounded memory: no sentence's audio is kept after it is written. Test: `test_long_session_keeps_no_written_audio` (Task 5).
3. **Two people read at once.** Both sessions progress; neither blocks the other's events. Test: `test_two_sessions_progress_together` (Task 5).
4. **A token that speaks as nothing** (a lone symbol, a leftover emoji, a URL fragment). It gets a `null` time and nothing crashes. Test: `test_unspeakable_tokens_get_null_times` (Task 3).
5. **A sentence in another language mid-reply** (per-paragraph voices). Language and voice change at that sentence and the stream continues without a gap. Test: `test_language_switch_mid_session` (Task 5).

---

## File Structure

| Path | Responsibility |
|---|---|
| `deploy/speech-service/AGENTS.md` | Folder rules: loopback only, nothing on disk, no text in logs, how to run the tests |
| `deploy/speech-service/README.md` | What it is, the HTTP contract, running locally against Zonos MLX on a Mac, deploying |
| `deploy/speech-service/pyproject.toml` | Package `speech_service`, dependencies, pytest config |
| `deploy/speech-service/speech_service/config.py` | `Settings` from environment |
| `deploy/speech-service/speech_service/models.py` | `Voice`, `Sentence` |
| `deploy/speech-service/speech_service/text.py` | Normalization, the Hungarian fix, mapping written tokens to spoken words |
| `deploy/speech-service/speech_service/audio.py` | Loudness matching, silence trimming, gaps, the MP3 encoder pipe |
| `deploy/speech-service/speech_service/zonos.py` | Zonos HTTP client |
| `deploy/speech-service/speech_service/aligner.py` | `Aligner` protocol, the Python and native FuseAlign backends, mapping times to tokens |
| `deploy/speech-service/speech_service/session.py` | `ReadingSession`: the worker, prefetch, events, cancel, idle end |
| `deploy/speech-service/speech_service/app.py` | Starlette routes and the session registry |
| `deploy/speech-service/tests/fakes.py` | `FakeZonos`, `FakeAligner` |
| `deploy/speech-service/tests/helpers.py` | `SR`, `tone`, `rms_db`, `peak_db`, `decoded_seconds`, `VOICE` |
| `deploy/speech-service/tests/test_*.py` | One file per module |
| `deploy/speech-service/speech-service.service` | systemd unit for the box |

## The HTTP contract (Plan 2 builds against this)

```
POST   /v1/sessions                 body: SessionRequest     → 201 {"session_id": str}
GET    /v1/sessions/{id}/audio      → 200 audio/mpeg, chunked, progressive
GET    /v1/sessions/{id}/events     → 200 text/event-stream
POST   /v1/sessions/{id}/position   body: {"sentence_id": str} → 204
DELETE /v1/sessions/{id}            → 204
POST   /v1/preview                  body: PreviewRequest      → 200 audio/mpeg (whole clip)
GET    /health                      → 200 {"ok": bool, "zonos": bool, "aligner": bool}

SessionRequest  = {"sentences": [Sentence], "seed"?: int}           # 1..2000 sentences
Sentence        = {"id": str, "language": "en" | "hu", "voice": Voice,
                   "tokens": [str], "paragraph_start": bool}           # tokens: the written words, in order
Voice           = {"speaker_id": str, "controls": {str: float}}       # controls passed to Zonos unchanged
PreviewRequest  = {"text": str (≤ 300 chars), "language": "en" | "hu", "voice": Voice}

SSE events (in order of the stream):
  event: sentence  data: {"id", "start", "end"}                  # seconds on the stream's clock
  event: words     data: {"id", "times": [[start, end] | null]}   # one entry per token, same clock
  event: error     data: {"id", "code"}                            # code: "zonos_unavailable" | "synthesis_failed"
  event: done      data: {}
```

Each `sentence` event comes before the audio it describes. The `words` event for a sentence may come later than its `sentence` event (it waits for alignment). After an `error` the stream ends, and the client starts a new session from that sentence.

---

### Task 1: Package skeleton and settings

**Files:**
- Create: `deploy/speech-service/pyproject.toml`, `speech_service/__init__.py`, `speech_service/config.py`, `tests/test_config.py`, `AGENTS.md`

**Interfaces:**
- Produces: `Settings` (frozen dataclass) with
  - `zonos_url: str = "http://127.0.0.1:1919"`
  - `host: str = "127.0.0.1"`, `port: int = 1920`
  - `prefetch: int = 2`, `seed: int = 1234`
  - `aligner: Literal["python", "native", "none"] = "python"`, `aligner_model: str | None = None`
  - `idle_seconds: float = 30.0`, `max_sentence_chars: int = 400`
  
  `Settings.from_env(env: Mapping[str, str]) -> Settings` reads `SPEECH_ZONOS_URL`, `SPEECH_HOST`, `SPEECH_PORT`, `SPEECH_PREFETCH`, `SPEECH_SEED`, `SPEECH_ALIGNER`, `SPEECH_ALIGNER_MODEL`, `SPEECH_IDLE_SECONDS`.

- [ ] **Step 1: Write the failing tests**

```python
def test_defaults_are_loopback_and_spec_values():
    s = Settings.from_env({})
    assert (s.host, s.port, s.prefetch, s.seed) == ("127.0.0.1", 1920, 2, 1234)

def test_refuses_a_non_loopback_host():
    with pytest.raises(ValueError):
        Settings.from_env({"SPEECH_HOST": "0.0.0.0"})

def test_reads_overrides():
    s = Settings.from_env({"SPEECH_ZONOS_URL": "http://127.0.0.1:1921", "SPEECH_ALIGNER": "none"})
    assert s.zonos_url.endswith(":1921") and s.aligner == "none"
```

- [ ] **Step 2: Run them and see them fail.** `cd deploy/speech-service && python -m pytest tests/test_config.py -q`. Expected: import error.
- [ ] **Step 3: Implement `Settings` and `pyproject.toml`.**
  - `pyproject.toml` dependencies: `starlette`, `uvicorn[standard]`, `httpx`, `numpy`, `soundfile`, `zyphra-textnorm`.
  - Optional extra `aligner-python`: `fusealign-hub @ git+https://github.com/Zyphra/fusealign-multilingual.git`.
  - Dev: `pytest`, `pytest-asyncio`.
  - `AGENTS.md` states the global constraints above and how to run the tests.
- [ ] **Step 4: Run the tests and see them pass.** Same command. Expected: 3 passed.
- [ ] **Step 5: Commit.** `git add deploy/speech-service && git commit -m "feat(speech): service skeleton and loopback-only settings"`

### Task 2: Text — normalization and the Hungarian fix

**Files:**
- Create: `speech_service/text.py`, `tests/test_text.py`

**Interfaces:**
- Produces:
  - `Spoken` (dataclass): `words: list[str]`, the spoken words; and `token_spans: list[tuple[int, int] | None]`, giving for each written token the half-open range of spoken words it became, with `None` when it speaks as nothing.
  - `normalize(tokens: list[str], language: Literal["en", "hu"]) -> Spoken`.
- Rules:
  - Normalize the whole sentence with `zyphra_textnorm.normalize(" ".join(tokens), "en_us" | "hu")`.
  - Map written tokens to spoken words with `difflib.SequenceMatcher` on lowercased, punctuation-stripped forms. Matching runs map one to one. An unmatched run of tokens shares its unmatched run of spoken words as one block: every token in the block gets the block's full span.
  - **Hungarian fix**, only on spoken words that came from a written token containing a digit:
    - inside a number word, `kettő` before `ezer`, `száz`, `millió` or `milliárd` becomes `két` ("kettőezer" → "kétezer", "tizenkettőezer" → "tizenkétezer");
    - a number word ending in `kettő` becomes `…két` when the next written token starts with a letter ("2 tojás" → "két tojás", "12 fok" → "tizenkét fok").

- [ ] **Step 1: Write the failing tests**

```python
def spoken(text): return " ".join(normalize(text.split(), "hu").words)

def test_two_eggs():          assert "két tojás" in spoken("A recepthez 2 tojás kell.")
def test_year():              assert "kétezer-huszonhat" in spoken("A határidő 2026. december 3-án van.")
def test_forint():            assert spoken("A jegy ára 12 990 Ft.").count("tizenkétezer") == 1
def test_degrees():           assert "hét és tizenkét fok" in spoken("Holnap 7 és 12 fok lesz.")
def test_written_word_kept(): assert "a kettő között" in spoken("Válassz a kettő között.").lower()
def test_lone_kettő_kept():   assert spoken("Ebből van 2.").rstrip(".").endswith("kettő")
def test_english_untouched(): assert "two eggs" in " ".join(normalize("It needs 2 eggs.".split(), "en").words)

def test_block_shares_span():
    sp = normalize("A jegy ára 12 990 Ft.".split(), "hu")
    assert sp.token_spans[3] == sp.token_spans[4] == sp.token_spans[5]   # "12", "990", "Ft." are one unit

def test_unspeakable_tokens_get_null_spans():
    sp = normalize(["Nézd", "→", "itt."], "hu")
    assert sp.token_spans[1] is None and sp.token_spans[0] is not None
```

- [ ] **Step 2: Run them and see them fail.** `python -m pytest tests/test_text.py -q`
- [ ] **Step 3: Implement `normalize` in `speech_service/text.py`** with the rules above. Reuse `map_back` in `docs/superpowers/specs/2026-11-16-read-aloud/spikes/align_test.py`, the design session's spike, as the starting point.
- [ ] **Step 4: Run them and see them pass.** Expected: 9 passed.
- [ ] **Step 5: Commit.** `git commit -m "feat(speech): normalize sentences and fix Hungarian két before nouns and in numbers"`

### Task 3: Aligner — word times mapped to written tokens

**Files:**
- Create: `speech_service/aligner.py`, `tests/fakes.py` (the `FakeAligner` part), `tests/test_aligner.py`

**Interfaces:**
- Consumes: `Spoken` (Task 2).
- Produces:
  - `class Aligner(Protocol): def align(self, audio_16k: np.ndarray, words: list[str]) -> list[tuple[float, float] | None]` (one entry per spoken word).
  - `PythonFuseAligner(device="cpu")` wraps `fusealign_hub.load_aligner(device="cpu", batch_size=1)`.
  - `NativeFuseAligner(cli: str, model: str, threads: int)` calls `fusealign-cli --batch` on a one-line JSONL file in a temporary directory, then deletes it. This is the one sanctioned temporary write, and it never holds text after the call.
  - `NoAligner` returns all `None`.
  - `token_times(spoken: Spoken, word_times) -> list[tuple[float, float] | None]` gives each written token the start of its span's first placed word and the end of its last.
  - `make_aligner(settings) -> Aligner`.
  - `FakeAligner(fail: bool = False)` (in `tests/fakes.py`) spreads the audio's duration evenly over the words, or raises `RuntimeError` when `fail`.

- [ ] **Step 1: Write the failing tests**

```python
def test_token_times_cover_blocks():
    sp = Spoken(words=["tizenkétezer-kilencszázkilencven", "forint"], token_spans=[(0, 2), (0, 2), (0, 2)])
    assert token_times(sp, [(1.0, 2.0), (2.0, 2.5)]) == [(1.0, 2.5)] * 3

def test_unspeakable_tokens_get_null_times():
    sp = Spoken(words=["nézd", "itt"], token_spans=[(0, 1), None, (1, 2)])
    assert token_times(sp, [(0.0, 0.4), (0.5, 0.9)])[1] is None

def test_unplaced_words_give_null():
    sp = Spoken(words=["a", "b"], token_spans=[(0, 1), (1, 2)])
    assert token_times(sp, [(0.0, 0.2), None]) == [(0.0, 0.2), None]
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the protocol, the three backends, `token_times` and `make_aligner`.** The two FuseAlign backends import lazily, so the tests need neither torch nor the CLI.
- [ ] **Step 4: Live check, not part of CI.** `SPEECH_LIVE=1 python -m pytest tests/test_aligner.py -m live` runs `PythonFuseAligner` on `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.superpowers/brainstorm/88338-1794826368/content/audition/norm-hu2-hu.wav` (git-ignored, on the owner's Mac; text: "A recepthez 2 tojás, 250 gramm liszt és 1,5 deciliter tej kell."). FuseAlign's weights are already cached at `HF_HOME=/Users/lvt53/Downloads/.hf-home`. Expected: every word placed, starts non-decreasing.
- [ ] **Step 5: Run the unit tests and see them pass, then commit.** `git commit -m "feat(speech): word alignment backends and token time mapping"`

### Task 4: Audio and the Zonos client

**Files:**
- Create: `speech_service/models.py`, `speech_service/audio.py`, `speech_service/zonos.py`, `tests/fakes.py` (the `FakeZonos` part), `tests/helpers.py`, `tests/test_audio.py`, `tests/test_zonos.py`

**Interfaces:**
- Produces:
  - `models.py`: frozen dataclasses `Voice(speaker_id: str, controls: dict[str, float])` and `Sentence(id: str, language: Literal["en", "hu"], voice: Voice, tokens: list[str], paragraph_start: bool)`.
  - `tests/helpers.py`:
    - `SR = 44100`
    - `tone(amp: float, seconds: float = 1.0) -> np.ndarray` (a 220 Hz sine)
    - `rms_db(x) -> float`, `peak_db(x) -> float`
    - `decoded_seconds(mp3: bytes) -> float` (via ffmpeg)
    - `click_at(seconds: float) -> np.ndarray`
    - `VOICE = Voice("default_test", {})`
  - `match_loudness(x: np.ndarray, sr: int, target_db=-20.0, peak_db=-1.0) -> np.ndarray`
  - `trim_silence(x: np.ndarray, sr: int, keep_s=0.05) -> np.ndarray`
  - `silence(seconds: float, sr: int) -> np.ndarray`
  - `class Mp3Encoder` (an async context manager around `ffmpeg -f f32le -ar 44100 -ac 1 -i - -c:a libmp3lame -b:a 128k -f mp3 -`): `async write(pcm: np.ndarray) -> None`, `async read_chunks() -> AsyncIterator[bytes]`, `samples_written: int`, `delay_seconds: float` (the encoder's priming delay as decoded, measured once at start-up by encoding `click_at(0.5)` and finding it), `async close()`.
  - `class ZonosClient(base_url, http: httpx.AsyncClient)`:
    - `async synthesize(text: str, language: str, voice: Voice, seed: int) -> tuple[np.ndarray, int]` posts to `/v2/generate` with `format: "wav", stream: false` and the global request fields, and raises `ZonosUnavailable` or `SynthesisFailed`;
    - `async healthy() -> bool`.
  - In `tests/fakes.py`:
    - `fake_zonos(fail_on: int | None = None, concurrency: int = 2) -> tuple[httpx.AsyncClient, list[dict]]` is an `httpx.AsyncClient` on a `MockTransport`. It answers `/v2/generate` with a 44.1 kHz WAV of 0.06 s per character plus 0.3 s, fails the `fail_on`-th call with a 500, serves at most `concurrency` calls at once, and appends every request body to the returned list.
    - `refusing_transport() -> httpx.AsyncClient` raises `httpx.ConnectError` on every call.

- [ ] **Step 1: Write the failing tests**

```python
def test_two_levels_end_equal():
    a, b = tone(0.05), tone(0.5)
    assert abs(rms_db(match_loudness(a, SR)) - rms_db(match_loudness(b, SR))) < 1.0

def test_peaks_capped():           assert peak_db(match_loudness(tone(0.9), SR)) <= -1.0 + 1e-6

async def test_request_has_exactly_the_contract_fields():
    zonos, calls = fake_zonos()
    await ZonosClient("http://z", zonos).synthesize("Szia.", "hu", Voice("default_x", {"room.clean": 2.0}), 1234)
    assert set(calls[0]) == {"text", "language", "format", "stream", "speaker_embedding_id",
                             "speaker_mode", "seed", "text_normalization", "controls"}
    assert calls[0]["speaker_mode"] == "embedding" and calls[0]["text_normalization"] is False

async def test_connection_refused_is_unavailable():
    with pytest.raises(ZonosUnavailable):
        await ZonosClient("http://z", refusing_transport()).synthesize("x", "en", VOICE, 1)

async def test_encoder_delay_is_reported():
    async with Mp3Encoder() as enc:
        assert 0.0 <= enc.delay_seconds < 0.08   # LAME priming is about 25 ms at 44.1 kHz

async def test_mp3_round_trip_keeps_duration():
    async with Mp3Encoder() as enc:
        await enc.write(tone(0.1, seconds=2.0)); await enc.close()
        data = b"".join([c async for c in enc.read_chunks()])
    assert abs(decoded_seconds(data) - 2.0) < 0.1
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
  - `match_loudness` and `trim_silence` follow the spike's `match_loudness`: speech frames are the 20 ms frames above 1/30 of the loudest.
  - When the request has no controls, `controls` is omitted, which is why it is in the field set only when given.
- [ ] **Step 4: Run them and see them pass, then commit.** `git commit -m "feat(speech): loudness, MP3 pipe and the Zonos client"`

### Task 5: The reading session

**Files:**
- Create: `speech_service/session.py`, `tests/test_session.py`

**Interfaces:**
- Consumes: `normalize` (Task 2), `Aligner` and `token_times` (Task 3), `ZonosClient`, `match_loudness`, `trim_silence`, `silence` and `Mp3Encoder` (Task 4).
- Produces: `class ReadingSession`:
  - constructor `(id: str, sentences: list[Sentence], zonos: ZonosClient, aligner: Aligner, settings: Settings)`
  - `start() -> None`
  - `async events() -> AsyncIterator[tuple[str, dict]]`
  - `async audio() -> AsyncIterator[bytes]`
  - `report_position(sentence_id: str) -> None`
  - `async cancel() -> None`
  - `ended: bool`
- Worker loop, per sentence in order:
  1. Wait until the sentence's index is at most the reported position plus `prefetch`.
  2. Normalize, then synthesize. On `ZonosUnavailable` or `SynthesisFailed`, emit `error` with that sentence's id and end.
  3. Trim, match loudness, and write a gap (0.30 s, or 0.60 s when `paragraph_start`, none before the first sentence).
  4. Emit `sentence` with `start = samples_written / 44100 + delay_seconds` and `end = start + duration`, then write the audio.
  5. Align on a 16 kHz resample in a thread executor, and emit `words`. If alignment raises, emit `words` with every time `null`: the reader then gets the sentence tint without the word mark, and no error.
  
  After the last sentence, emit `done`. The session ends when it is cancelled, when it finishes and both readers have drained, or when no audio reader has been attached for `idle_seconds`.

- [ ] **Step 1: Write the failing tests**, all using `FakeZonos` and `FakeAligner`:
  - `test_events_follow_the_stream`: three sentences give `sentence` events whose starts are 0 and then strictly increase, and one `words` event per sentence with `len(times) == len(tokens)`; the last event is `done`.
  - `test_paragraph_gap_is_longer`: with `paragraph_start=True` on the second sentence, `start[1] - end[0]` is between 0.55 and 0.65 s; otherwise between 0.25 and 0.35 s.
  - `test_prefetch_waits_for_the_reader`: with no position reported, FakeZonos receives exactly `1 + prefetch` requests; after `report_position(ids[0])` it receives one more.
  - `test_cancel_stops_zonos_calls`: after `cancel()` no further requests reach FakeZonos.
  - `test_error_names_the_sentence`: when FakeZonos fails on call 2, the events end with `("error", {"id": ids[1], "code": "synthesis_failed"})`.
  - `test_language_switch_mid_session`: the requests go out with `language` `hu`, `en`, `hu` and the matching `speaker_embedding_id`s, and there is no extra gap at the switch.
  - `test_session_ends_when_reader_leaves`: with `idle_seconds=0.2` and no audio reader, `ended` becomes true within 0.5 s and the request count stops growing.
  - `test_long_session_keeps_no_written_audio`: 200 sentences with prefetch 200. After the stream is drained, `tracemalloc` shows less than 20 MB still allocated in `session.py`.
  - `test_two_sessions_progress_together`: two sessions on one FakeZonos that allows two concurrent calls both reach `done`.
  - `test_aligner_failure_gives_null_words`: with `FakeAligner(fail=True)` every `words` event has all-`null` times, and the session still reaches `done`.
  - `test_long_sentence_refused`: `ReadingSession` refuses a sentence whose joined text is over 400 characters with `ValueError` at construction.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement `ReadingSession`.** Use one `asyncio.Queue` for events and the encoder's chunk stream for audio. Run alignment with `loop.run_in_executor`, since FuseAlign blocks.
- [ ] **Step 4: Run them and see them pass, then commit.** `git commit -m "feat(speech): reading sessions with prefetch, timeline, cancel and idle end"`

### Task 6: HTTP app, preview and health

**Files:**
- Create: `speech_service/app.py`, `speech_service/__main__.py`, `tests/test_app.py`, `README.md`

**Interfaces:**
- Consumes: `ReadingSession` (Task 5), `ZonosClient` (Task 4), `make_aligner` (Task 3), `Settings` (Task 1).
- Produces:
  - `create_app(settings: Settings, zonos: ZonosClient, aligner: Aligner) -> Starlette` serving the contract above;
  - `python -m speech_service` runs uvicorn on `settings.host:port`.
- Behaviour:
  - Unknown session → 404.
  - A second `GET …/audio` for a session already being read → 409.
  - Body validation failures → 422 with a field name, never echoing text.
  - `/v1/preview` synthesizes one sentence: normalized, loudness-matched, encoded to a whole MP3, not aligned.

- [ ] **Step 1: Write the failing tests** (Starlette `TestClient` and the fakes):
  - `test_session_round_trip`: POST, then reading `/events` until `done`, then `/audio` that decodes to the sum of the sentence durations.
  - `test_unknown_session_404`
  - `test_second_audio_reader_409`
  - `test_bad_language_422_without_echo`: the body's text is absent from the response.
  - `test_preview_returns_mp3`
  - `test_health_reports_parts`: Zonos down gives `{"ok": false, "zonos": false, ...}`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement `create_app` and `__main__`.** The README documents the contract (copy the block above), local running against Zonos MLX on port 1921, and the tests.
- [ ] **Step 4: Run them and see them pass, then commit.** `git commit -m "feat(speech): HTTP routes, preview and health"`

### Task 7: Live check on the Mac (owner-visible, no CI)

**Files:**
- Create: `deploy/speech-service/scripts/live_check.py`

**Interfaces:**
- Consumes: a running service with `SPEECH_ZONOS_URL=http://127.0.0.1:1921` (`~/Downloads/zonos3/samples/serve_local.sh --port 1921`) and `SPEECH_ALIGNER=python` (the zonos3 `.venv` has `fusealign_hub`).

- [ ] **Step 1: Write `live_check.py`.**
  - It posts a mixed session:
    - English with Imogen `default_b78b28baf5c31a1d`;
    - Hungarian with Berta, using `speaker_id` from `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.superpowers/hu-voices/berta.npy` (git-ignored; see its README) loaded as a session voice, plus `controls: {"room.clean": 2}`;
    - one paragraph break.
  - It writes `out/live.mp3` and `out/live-events.json` under the scratchpad, never the repo.
  - It prints the first-audio latency, words placed versus tokens, and whether the starts are monotonic.
- [ ] **Step 2: Run it.** Expected: first audio under 1.5 s, every token placed except the unspeakable ones, monotonic starts.
- [ ] **Step 3: Owner listens to `live.mp3`** (send it with SendUserFile). Their OK is recorded in the session, not in a file.
- [ ] **Step 4: Commit the script.** `git commit -m "chore(speech): live check against a local Zonos"`

### Task 8: The box — measure, choose the aligner, install (owner's OK required before each SSH command)

**Files:**
- Create: `deploy/speech-service/speech-service.service`; README "Deploy" section.

**Interfaces:**
- Produces:
  - the service listening on `127.0.0.1:1920` on the box;
  - the speaker ids of Berta and Imre on the box's Zonos, recorded in the README for Plans 2 and 3.

- [ ] **Step 1: Ask the owner for SSH access, then measure** (read only):
  - free RAM, swap use and CPU core count;
  - Python version and `ffmpeg -version`;
  - current GPU0 and GPU1 memory.
  
  Record them in the README.
- [ ] **Step 2: Build the native aligner on the box under `alfyws`.**
  - Build `fusealign-cli` on the CPU (`cmake -B ggml/build -S ggml && cmake --build ggml/build -j`).
  - Download `fusealign-multilingual-cjkft-step2500-q8_0.gguf` (0.51 GB) with the owner's OK.
  - Time five Hungarian sentences and measure peak RSS.
  - **Decision rule:** native if its RSS plus the service stays under 1.5 GB and it aligns a 5 s sentence in under 2 s; otherwise Python FuseAlign on the CPU, if RAM allows; otherwise `none` (sentence marks only) and tell the owner.
- [ ] **Step 3: Write `speech-service.service`.**
  - `User=alfyws`
  - `After=zonos3.service`
  - `MemoryMax=2G`
  - `Environment=SPEECH_ALIGNER=…`
  - `ExecStart=<venv>/bin/python -m speech_service`
  - `Restart=on-failure`
- [ ] **Step 4: With the owner's OK, install and start it under `alfyroot`.**
  - Install and start the unit.
  - Copy `berta.npy` and `imre.npy` into the box's Zonos voices folder.
  - Read their `default_…` ids from `GET /v2/speakers` and record them in the README.
- [ ] **Step 5: Run `live_check.py` on the box against `127.0.0.1:1920`.** Expected: same as Task 7. Confirm vLLM's throughput is unchanged with `systemctl status vllm-flashnext` and one test chat turn.
- [ ] **Step 6: Commit the unit and the README.** `git commit -m "deploy(speech): systemd unit and measured box settings"`
