# Speech service

The read-aloud speech service of AlfyAI. It turns the sentences of a reply into one continuous MP3 stream and a timeline of sentence and word times: Zonos speaks, FuseAlign times the words. It is a small Python 3.12 service (Starlette on uvicorn) that runs on the GPU box beside Zonos. AlfyAI's server is its only client. The service holds no user data, writes nothing to disk and logs no reply text.

- Design: [`docs/superpowers/specs/2026-11-16-read-aloud-design.md`](../../docs/superpowers/specs/2026-11-16-read-aloud-design.md) (§3, §4.10, §6).
- Rules for changing this folder (loopback only, nothing on disk, no text in logs, the tests): [AGENTS.md](./AGENTS.md).
- It binds `127.0.0.1`, port **1920**, and nothing else. Zonos is at `http://127.0.0.1:1919`.
- It needs **ffmpeg with libmp3lame** on `PATH`, for the service and for its tests. The Mac has it from Homebrew; the box has ffmpeg 7.1.5 with libmp3lame installed. Without it the service stops at start-up (exit status 3).

## How a reading goes

1. `POST /v1/sessions` with the sentences of the reply. The service starts speaking at once and answers with the session id.
2. The player opens `GET …/audio` (one MP3 response, written as it is made) and `GET …/events` (the timeline), and plays the MP3.
3. As the player moves from one sentence to the next it posts `POST …/position`. The service keeps at most two sentences synthesized beyond the one now playing (`SPEECH_PREFETCH`).
4. A stop, a jump or a new reading ends the session with `DELETE`. A session whose audio reader has left (or never came) ends by itself after `SPEECH_IDLE_SECONDS`, 30 s by default, and stops calling Zonos.

## The HTTP contract

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

### What the contract does not spell out

**Three rules for the client.** AlfyAI's server has to be built around them:

1. **Take each stream once.** A session has one audio reader and one events reader for its whole life, and a `Range` header changes nothing (see The audio). So the server opens `…/audio` and `…/events` once each, as soon as the session exists, reads both at the same time, and serves the browser from those two upstream responses. The `Range` probes and re-requests of a browser's `<audio>` element (Safari starts with `bytes=0-1`) are the server's to answer from what it holds: none of them can be forwarded, and a second `GET` is a 409.
2. **Report the sentence now playing from playback time** (the player's `currentTime`), not from the events as they arrive: they arrive ahead of playback. Without reports the service reads the first sentence and `SPEECH_PREFETCH` (2) more, and then waits.
3. **Never `DELETE` on `done`.** `done` means that synthesis has finished, not that playback has, and `DELETE` drops the MP3 that the audio reader has not read yet. `DELETE` is for a stop, a jump or a new reading.

**A session starts at its first sentence, and starts at once.** Synthesis begins at the `POST`, and so does the idle clock: the audio reader has to attach within `SPEECH_IDLE_SECONDS` (30 s). There is no starting in the middle: for a jump, or "read from here", make a new session of the sentences that remain. A session id is 32 lowercase hexadecimal characters.

**Position.** `sentence_id` is the sentence now playing, not the one just finished. Sentence `i` is synthesized once `i` is no more than `SPEECH_PREFETCH` past the position, and no sentence is skipped. A position before the last one is accepted and only narrows that window. An id that is not one of the session's sentences answers 422 (`sentence_id`), a body that is not an object 422 (`body`).

**One reader of each kind.** A session has one audio reader and one events reader. A second `GET …/audio` or `GET …/events` answers 409, also after the first reader has left: there is no resume, and a stream that was cut cannot be taken up again. Open both as soon as the session exists and read them at the same time.

**An ended session is kept for a while.** A session that fails (the `error` event) is over at once, without waiting for its readers, and a failure can come within milliseconds (Zonos is down), before the player's streams have connected. So an ended session stays known until its events have been read to their end, or until `SPEECH_IDLE_SECONDS` after it ended, whichever comes first, and only then is it forgotten (404). Meanwhile a late `GET …/events` gets what was said, `sentence` and `error` events included, and a late `GET …/audio` gets an empty, finished MP3 response (the audio made before a failure goes whole to a reader that was attached; it is dropped for one that was not). A reader already taken is still 409, and once the events have been read to their end there is nothing left to keep: a `GET …/audio` after that is a 404. `POST …/position` and `DELETE` are accepted for it and change nothing (`DELETE` forgets it at once). A reading that completed, and whose two streams have both drained, is forgotten at once too, so a `DELETE` for it answers 404: take a 404 as done.

**The audio.** One `audio/mpeg` response, 44.1 kHz mono at 128 kbit/s, chunked and written as it is made. It starts with ffmpeg's ID3v2 tag and has no Xing or Info header frame, so it has no length: a player sees a stream. `Range` is ignored: the answer is always `200` from byte 0, with no `Content-Length` and no `Accept-Ranges`. It ends after `done`, once the encoder has written its last frames; after an `error`, with the audio made before it whole for a reader that was attached (a reader that was not gets none); and early, with the MP3 not yet read dropped (the response still ends as a complete one), on `DELETE` and when the session ends idle. When the service stops, the connection is cut. A reading made only of sentences that say nothing has an ID3 tag and no MP3 frames, which an `<audio>` element may report as a decode error: do not make such a session.

**The events.** `Content-Type: text/event-stream` (Starlette adds `; charset=utf-8`), `Cache-Control: no-cache`, each event exactly `event: <name>\ndata: <compact json>\n\n`. A line break in a sentence `id` is escaped inside the JSON, so it cannot start another event. There is no `id:` or `retry:` field and there are no comments, so nothing can resume: a browser `EventSource` that reconnects gets a 409.

**Silence.** Neither stream sends keepalive bytes or comments, and both stay silent for as long as playback is paused: the service waits at its prefetch window and makes nothing more. So the fetches must have no idle or body timeout. (Node's `fetch`, undici, gives up on a body that has been silent for 300 s by default.)

**The order of the events.** Each sentence has a `sentence` event and then a `words` event, and each kind comes in sentence order. A sentence's `words` follows its own `sentence` at once, or after the next sentence's `sentence` (alignment runs while the next sentence is made), and never later than that: match them by `id`, not by their place in the stream. `done` comes after the last `words`. There is exactly one `error`, and it is the last event: the `words` of the sentences before it come first. It names the failing sentence, which may already have had its `sentence` event (the encoder died while its audio was written) and then gets no `words`. A stream can also end with neither `done` nor `error`: on `DELETE`, when the session ends idle, and when the service stops. Take that as stopped.

**Times.** `start`, `end` and the `words` times are seconds on the stream's clock, as a browser decodes the MP3: the encoder's start delay is already in them, so the first sentence starts at about 0.025 s, not at 0. They are rounded to the millisecond. The silence between sentences (0.5 s, and 0.9 s where a new paragraph starts: `SPEECH_GAP_SECONDS` and `SPEECH_PARAGRAPH_GAP_SECONDS`) is in the audio, between one sentence's `end` and the next one's `start`. A sentence that speaks as nothing (a lone symbol, an emoji) has `start` equal to `end` at the clock where it would be, no audio, no gap, no call to Zonos and `null` for each token; a paragraph it opens passes its 0.60 s gap to the next sentence that is read.

**Words.** `times` has one entry per token: `[start, end]`, or `null` for a token that was not said or not timed. An empty token is `null`; a token with spaces in it is one token and gets one time over all its words. Every entry of a sentence is `null` when there is no aligner (`SPEECH_ALIGNER=none`, or it could not be set up), when alignment fails for that sentence, when it takes more than 5 s from being queued, and while an alignment that was given up on is still stuck in the aligner (the sentences that come meanwhile have no word times either): the reader then marks sentences only. Word times are not clamped to their sentence's `[start, end]`: they can lie some tens of milliseconds outside it, so clamp them in the client.

**Errors in a reading.** `zonos_unavailable` means Zonos could not be reached: connection refused, a timeout, or no answer within 120 s. `synthesis_failed` is everything else: Zonos answered with an error status (an unknown `speaker_id` and a control out of range both end here) or with audio that cannot be decoded, no audio, only silence, or a rate other than 44.1 kHz; the encoder died; or a bug, the normalizer's included. No event says that Zonos is busy, and the first `sentence` event comes only when the first sentence has been synthesized whole. On the box Zonos speaks at 7 to 9 times real time, so a first sentence of 150 characters takes about 1.3 s and one of 250 about 2.2 s (more when it stalls and is made again, see Stalled clips): keep the first sentence of a session short, and infer "busy" from time.

**Answers.**

| Status | Body | When |
|---|---|---|
| 201 | `{"session_id": "…"}` | `POST /v1/sessions` |
| 204 | none | `position` taken; `DELETE` done (the session is cancelled and forgotten) |
| 307 | none, a `Location` header | a path with a trailing slash: to the path without it |
| 404 | `{"error": "not_found"}` | every session route, for a session that is unknown **or has been forgotten**: an ended session is forgotten once its events have been read to their end, or `SPEECH_IDLE_SECONDS` after it ended (see above). A session ends when both readers have drained it, after an `error`, on `DELETE`, or when idle |
| 404 | `Not Found`, as `text/plain` | any path that is no route: not the JSON above |
| 405 | `Method Not Allowed`, as `text/plain`, and an `Allow` header | a method the route does not take. `HEAD` on `…/audio` and `…/events` is a 405 with `Allow: GET` and no body, so a probe cannot take the one reader |
| 409 | `{"error": "reader_taken"}` | a second `GET …/audio` or `GET …/events` |
| 413 | `{"error": "too_large"}` | a request body of more than 4 MiB (4,194,304 bytes), on any route that reads one. It is refused as soon as its declared length, or the part of it that has arrived, is over that, and nothing is started |
| 422 | `{"error": "invalid", "field": "sentences[3].tokens"}` | a body the service refuses. The field path only, never a value, so none of the request comes back. Only the first field that fails is named |
| 500 | `{"code": "synthesis_failed"}` | `preview`: something nobody expected went wrong (a bug). The body is the same for every cause; the log has the error's type and place, never its message |
| 502 | `{"code": "synthesis_failed"}` | `preview`: Zonos failed or sent nothing usable, or the encoder failed |
| 503 | `{"code": "zonos_unavailable"}` | `preview`: Zonos could not be reached |

**What a request may hold.** Anything else is 422 with that field's path. Unknown fields are ignored.

| Field | Rule |
|---|---|
| body | a JSON object of at most 4 MiB. The `Content-Type` header is not checked |
| `sentences` | a list of 1 to 2000 sentences |
| `sentences[i].id` | a non-empty string, unique in the request |
| `sentences[i].language` | `"en"` or `"hu"` |
| `sentences[i].voice.speaker_id` | a non-empty string (a Zonos speaker id) |
| `sentences[i].voice.controls` | an object of strings to numbers (an integer, or a finite float; not `true`/`false`); absent means `{}`, `null` is 422. Names and ranges are Zonos's: the controls go to it unchanged, an integer staying one. A bad control is reported as `…voice.controls`, never by its name |
| `sentences[i].tokens` | a non-empty list of strings that, joined by single spaces, are at most 400 characters: the *written* ones (see Long sentences below). An empty string is accepted (it is said as nothing) and so is a token with spaces in it (one token, one time over all its words): send one written word for each token |
| `sentences[i].paragraph_start` | `true` or `false` |
| `seed` | optional: leave it out for the service's seed (`SPEECH_SEED`, 1234). Otherwise an integer from 0 to 4294967295 (Zonos's own range); `null`, a float and `true` are 422 |
| preview `text` | a non-empty string of at most 300 characters. It is split at whitespace and normalized as a sentence's tokens are; if nothing in it is speakable (a lone symbol), 422 `text` |
| preview `language`, `voice` | as above |

**Long sentences.** The 400 characters are what is written. What Zonos is sent is what is spoken, and digits spell themselves out (a token of 300 digits is 1,199 to 1,799 spoken characters in English; `3,14159265358979323846` is 22 written and 191 spoken in Hungarian). Zonos stops a request at about 100 s of speech, which is some 1,500 spoken characters, and **cuts the rest off without any error**. The service does not refuse a sentence for it. It sends the sentence as it is and logs one warning (the session, the sentence's position, its spoken and its written length: counts only, never the text) when a sentence speaks as more than 1,200 characters. A client that can have such sentences (long numbers) should split them itself before it sends them.

**Stalled clips.** Zonos sometimes stalls on a sentence: the clip has a silence of a second or more inside it, or runs far longer than its words need (on the Mac's build one sentence of 22 characters came out 91 s long). It happens with every voice and with no control at all (no style's doses raise it; the studio `room.clean` 2 that Imre and Berta carry does, from 32% to 55% of Imre's short clips and from 29% to 38% of Berta's, in 84 clips each), to short sentences far more than to long ones (a third of 204 clips of sentences under 45 characters, more than half of Imre's, and two of 156 clips of sentences of 77 characters or more), and it is the seed alone that decides: the same sentence is fine under the next one. So the service measures each clip as Zonos made it (`speech_service/steady.py`) and makes it again under the next seed when it is longer than 1.4 times what its characters need (0.4 s and 0.08 s a character for English, 0.09 for Hungarian, scaled by the voice's `delivery.tempo`) or holds a silence of more than 0.8 s. The seeds are the sentence's own and then steps of 7,919 from it; the first steady clip is the one spoken, or, when none is, the one least in trouble. `SPEECH_STEADY_ATTEMPTS` (default 4, the first included) sets how many clips are made at most; 1 turns it off. A retry that fails (Zonos errors or cannot be reached) leaves the stalled clip in place: it is better than none. For a client: a sentence that stalled comes later (the first `sentence` event of a reading too, and a preview's answer), the events and times describe the clip that is spoken, and a reading is as repeatable as before, because the retry seeds are fixed. The line that says a reading ended counts the clips it made again (`N made again`); each retry is logged at debug level in a reading and at info for a preview, with numbers only. A text of a word or two is the worst case: on the Mac's build 85 to 90% of the clips of fragments of three to sixteen characters in Berta's and Imre's voices were far longer than their words (the median clip of "Igen." is 4.6 s, of "Rendben." 6.9 s, the longest 28 s), 82% in Wyatt's and 42% in Imogen's, and on staging a selection of a few words was read with a sentence the text never held after it. The guard sees that by the length alone, so an addition inside a long sentence passes it, and at those rates most chains of four attempts fail too: the cure is not to send so little text (a sentence of 50 characters or more stalls in about one clip in a hundred, one of 40 to 49 in about one in fourteen). A text expected to take less than 1.3 s counts as taking 1.3 s, because a clean clip of "Yes." is a second or more with the silence round it. Each retry's log line says the clip's length, the length its text needs and its longest pause, never the text. The limits were chosen on the Mac's MLX build: of 324 clips of sentences under 100 characters in the six voices 70 stalled, and they flagged 68 of those and 9 of the 254 that did not; through the service with four attempts, 204 clips of sentences under 45 characters stalled 5 times (2.5%) instead of 68, at 1.7 attempts a clip. **The box's build has not been measured**: `made again` in its journal (`journalctl -u speech-service`) says how often it stalls there, and a count near 0 means the guard is only a safeguard.

**Breath.** Zonos pauses where the text has a comma, a semicolon or a colon, but briefly. Measured on the Mac's build, from the aligner's word times: the silence after a word that ends in a comma is about 0.1 s in English (many commas of a list get none) and 0.16 s in Hungarian, after a semicolon 0.2 and 0.27 s, after a colon 0.3 and 0.26 s, and 0.01 s after a word with no mark. It makes none at a dash or a bracket (the speech script turns those into commas, so that they are marks), and swapping a list's commas for a stronger mark (`;`, `:`, `...`) lengthened the pause by 0.01 to 0.06 s in English and 0.07 to 0.14 s in Hungarian, so the text cannot make the pauses long; the audio has to. A person reading aloud pauses about 0.2 to 0.3 s at a comma and half a second at a full stop; with Zonos's own pauses and 0.30 s between sentences (0.34 to 0.39 s measured), the sentences of a reply ran into each other. So the service lengthens each silence inside a sentence of 0.12 to 0.8 s by `SPEECH_BREATH_SECONDS` (0.15 s; a shorter silence is the closing of a consonant, a longer one a stall, which is made again instead), after trimming and loudness matching, so that the timeline and the aligner see the audio that is played (`audio.lengthen_pauses`: the silence is added at the middle of the pause, with 5 ms of fade either side), and puts `SPEECH_GAP_SECONDS` (0.5 s) between sentences and `SPEECH_PARAGRAPH_GAP_SECONDS` (0.9 s) before a paragraph's first sentence. `SPEECH_BREATH_SECONDS=0`, `SPEECH_GAP_SECONDS=0.3` and `SPEECH_PARAGRAPH_GAP_SECONDS=0.6` give back the audio of 2026-11-16. A preview has its pauses lengthened too; the sentences of a preview are joined by AlfyAI's server, with its own gap.

**Preview.** `POST /v1/preview` speaks one sentence (normalized, trimmed, matched in loudness) and answers one whole MP3, with a `Content-Length`. It is not aligned and makes no session. Its seed is always the service's (`SPEECH_SEED`): there is no field for one. Nothing limits how many run at once: previews share Zonos's two slots with the readings.

**Health.** `GET /health` always answers 200 with exactly `ok`, `zonos` and `aligner` (it can take up to 5 s, when Zonos hangs: that is its health check's time limit). `zonos` is whether Zonos answers its own health check. `ok` is whether readings can be served: it is the same as `zonos` today. `aligner` is whether the aligner was set up when the service started. `false` means readings carry sentence marks only (every `words` event is all `null`): either `SPEECH_ALIGNER=none`, or the configured backend could not be set up and the service went on without it (see Settings). `aligner` does not notice a later failure: an aligner that breaks while the service runs gives `null` times (one warning in the log for each reading, and the line that says the reading ended counts its sentences without word times), and `aligner` stays `true`.

**Stopping.** On SIGTERM the service stops taking requests and waits 5 s for the open responses (a reading's streams stay open for as long as it is read). It then cuts the ones still open, without `done` or `error`, and cancels every session, which kills its ffmpeg. An alignment that is running cannot be interrupted, and the process exits only when it is through with it: up to 30 s more, the native CLI's time limit. So the service's stop timeout (systemd's `TimeoutStopSec`, which is 90 s unless the unit sets it) must not be set below 40 s.

## Settings

Read once at start-up, from the environment, by `speech_service/config.py` (which is the list of record).

| Variable | Default | Meaning |
|---|---|---|
| `SPEECH_HOST` | `127.0.0.1` | Where to bind. `localhost`, `127.0.0.0/8` and `::1` only: anything else stops the service |
| `SPEECH_PORT` | `1920` | From 1 to 65535 |
| `SPEECH_ZONOS_URL` | `http://127.0.0.1:1919` | Where Zonos is |
| `SPEECH_PREFETCH` | `2` | Sentences synthesized beyond the reader's position: 0 or more |
| `SPEECH_SEED` | `1234` | The seed of a reading that brings none |
| `SPEECH_ALIGNER` | `python` | `python` (FuseAlign in this process), `native` (the `fusealign-cli` binary) or `none` (sentence marks only) |
| `SPEECH_ALIGNER_MODEL` | none | The FuseAlign checkpoint (`python`), or the GGUF file (`native`: required, and it must be a file) |
| `SPEECH_ALIGNER_CLI` | `fusealign-cli` | The native binary: an absolute path, or a name found on `PATH`. It must be an executable file |
| `SPEECH_ALIGNER_THREADS` | `4` | Threads of the aligner: 1 or more |
| `SPEECH_IDLE_SECONDS` | `30` | How long a session lives without an audio reader, and how long one that has ended is kept for a reader that comes late: a finite number above 0 |
| `SPEECH_GAP_SECONDS` | `0.5` | The silence between two sentences: 0 to 5 s (0.3 until 2026-11-17) |
| `SPEECH_PARAGRAPH_GAP_SECONDS` | `0.9` | The silence before the first sentence of a paragraph: 0 to 5 s (0.6 until 2026-11-17) |
| `SPEECH_BREATH_SECONDS` | `0.15` | What each silence of 0.12 to 0.8 s inside a sentence is lengthened by: 0 to 1 s. 0 leaves Zonos's pauses as they are (see Breath) |
| `SPEECH_STEADY_ATTEMPTS` | `4` | Clips made at most for a sentence Zonos stalls on, the first included: 1 or more. 1 turns the retries off (see Stalled clips) |

**An aligner that cannot be set up does not stop the service.** Word times are an extra, so if the configured aligner cannot be set up at start-up (`native`: the CLI is not an executable file or a command on `PATH`, or the model is not set or not a file; `python`: FuseAlign or torch does not import, or the model does not load), the service logs one `ERROR` line (the backend, what is missing or the exception's type, never its message), runs with `SPEECH_ALIGNER=none` and says `"aligner": false` on `/health`. A setting that is wrong (a number that is not one or is out of its range, a host beyond loopback, an unknown `SPEECH_ALIGNER`) stops it at start-up with one line instead.

## Running it on the Mac

The Mac runs Zonos MLX in place of the box's ggml build. The commands are `sh`; in fish, put `env` in front of the variables. Nothing here writes into the `zonos3` checkout.

1. **A voices folder outside the checkout**, laid out as on the box (`gguf/voices`): the English default voices in `English/`, and the two Hungarian voices (`berta.npy`, `imre.npy`, kept local in the git-ignored `.superpowers/hu-voices/` of the main checkout) as default voices too, in `Hungarian/`. A voice's id is `default_` and the first 16 hex digits of the SHA-1 of its path inside this folder, so the two folders' names matter: with them the ids are the box's. Without them the ids differ, and a client that sends the box's ids gets `synthesis_failed` for every Hungarian sentence (Zonos does not know the speaker).

   ```sh
   VOICES=~/Downloads/speech-voices
   mkdir -p "$VOICES/Hungarian"
   cp -R ~/Downloads/zonos3/assets/default_voices/English "$VOICES/"
   cp /Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.superpowers/hu-voices/{berta,imre}.npy "$VOICES/Hungarian/"
   ```

   The voices and their ids, which are the same on the Mac and on the box:

   | Voice | File in the folder | `speaker_id` |
   |---|---|---|
   | Berta (Hungarian) | `Hungarian/berta.npy` | `default_bf7632822e6b4dc0` |
   | Imre (Hungarian) | `Hungarian/imre.npy` | `default_fde02d0881bd267d` |
   | Imogen | `English/Imogen_en-British_F_1.wav` | `default_b78b28baf5c31a1d` |
   | Rupert | `English/Rupert_en-British_M_1.wav` | `default_3765f0d1140c05c0` |
   | Savannah | `English/Savannah_en-American_F_1.mp3` | `default_de4d191ca7574982` |
   | Wyatt | `English/Wyatt_en-American_M_1.ogg` | `default_34370fd91e3484ef` |

2. **Zonos MLX on port 1921**, which leaves 1919 and this service's 1920 free:

   ```sh
   SERVE_VOICES="$VOICES" ~/Downloads/zonos3/samples/serve_local.sh --port 1921
   curl -s http://127.0.0.1:1921/v2/speakers      # the voice ids
   ```

3. **The service**, under the `zonos3` Python, which has Starlette, uvicorn and FuseAlign (a few seconds to start, about 3.5 GB resident). Its Starlette and uvicorn may be older than the ones in `requirements.lock`: good enough to try it out, while the tests and the box use the locked versions:

   ```sh
   cd deploy/speech-service
   SPEECH_ZONOS_URL=http://127.0.0.1:1921 SPEECH_ALIGNER=python \
   HF_HOME=/Users/lvt53/Downloads/.hf-home PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. \
     ~/Downloads/zonos3/.venv/bin/python -m speech_service
   ```

   `SPEECH_ALIGNER=none` starts it without FuseAlign: readings then carry sentence marks only.

4. **Try it** (a voice id from step 2 in place of `<id>`):

   ```sh
   curl -s http://127.0.0.1:1920/health
   curl -s http://127.0.0.1:1920/v1/preview -H 'content-type: application/json' \
     -d '{"text": "Hello there.", "language": "en", "voice": {"speaker_id": "<id>", "controls": {}}}' \
     -o /tmp/preview.mp3 && afplay /tmp/preview.mp3
   ```

## Tests

From this folder, with the dev environment (see [AGENTS.md](./AGENTS.md) for making it and for the live tests):

```sh
.venv/bin/python -m pytest -q                      # all of them
.venv/bin/python -m pytest -q tests/test_app.py    # the HTTP app: TestClient, a fake Zonos and a real ffmpeg
```

`scripts/gates.sh` does not run these. They need ffmpeg with libmp3lame on `PATH`.

## Dependencies

`requirements.lock` pins every runtime dependency, and everything each one brings, to the exact version the tests ran on (CPython 3.12, Linux x86_64: the box). **The box installs from it and from nothing else.** `_Stream` in `app.py` relies on Starlette's internals, so a reinstall that pulled a Starlette, uvicorn or anyio nobody tested could silently stop the service from noticing that a client has left; `pyproject.toml` bounds `starlette<2` for the same reason.

```sh
uv pip install --python <venv>/bin/python -r requirements.lock
```

The service is run from its source folder, which is not installed: `cd <source folder> && <venv>/bin/python -m speech_service`. The lock has no FuseAlign (`SPEECH_ALIGNER=python`, the Mac's choice, runs under the `zonos3` Python): the box runs the native aligner. A change of dependencies regenerates the lock; the commands are in [AGENTS.md](./AGENTS.md).

## Deploy

The service runs on the GPU box beside Zonos (`zonos3.service`, ggml, 127.0.0.1:1919) and vLLM, as `alfyws`, under systemd. It was installed there on 2026-11-16. Every change on the box needs the owner's OK first (`alfyws` for files, `alfyroot` for systemd), and **`vllm-flashnext` and `zonos3` are never restarted or reconfigured** for it: the steps below leave both alone.

### Where things are on the box

| What | Where |
|---|---|
| Source (run in place, not installed) | `/home/alfyws/opt/speech-service` |
| Python environment (CPython 3.12.15) | `/home/alfyws/venvs/speech-service`, from `requirements.lock` |
| Unit | `/etc/systemd/system/speech-service.service` (a copy of `speech-service.service` here), enabled |
| Word timing: native FuseAlign CLI (CPU build; keep it in its build tree, it loads `libggml*.so.0` from `ggml/build/ggml/src`) | `/home/alfyws/opt/fusealign/fusealign-multilingual/ggml/build/fusealign-cli` (repo `fc17172c1`, ggml `a05c9922`) |
| Its model (514,803,776 bytes, sha256 `183b4247afe5de7c0d163eea4a41057fa8dd0da27f6a898632b1aba53db77a3f`) | `/home/alfyws/opt/fusealign/models/fusealign-multilingual-cjkft-step2500-q8_0.gguf` |
| The Hungarian voices (embeddings only, never the reference audio) | `/home/alfyws/opt/zonos3/servers/ggml/gguf/voices/Hungarian/{berta,imre}.npy` |

Zonos rescans its voices folder on every lookup, so adding or removing a voice there needs no restart. A voice's id hashes its path inside that folder, so the same layout gives the same ids everywhere:

| Voice | Zonos id (on the box) |
|---|---|
| Imogen | `default_b78b28baf5c31a1d` |
| Rupert | `default_3765f0d1140c05c0` |
| Savannah | `default_de4d191ca7574982` |
| Wyatt | `default_34370fd91e3484ef` |
| Berta | `default_bf7632822e6b4dc0` (default control `room.clean: 2`) |
| Imre | `default_fde02d0881bd267d` (default control `room.clean: 2`) |

### Install or update

From the repository root on the owner's Mac:

```sh
# 1. The code (as alfyws); tests and the Mac's venv stay behind.
rsync -a --exclude .venv --exclude tests --exclude __pycache__ --exclude .pytest_cache --exclude '*.egg-info' \
  deploy/speech-service/ alfyws:/home/alfyws/opt/speech-service/
# 2. The environment, exactly the lock (as alfyws).
ssh alfyws '/usr/local/bin/uv venv --python /usr/bin/python3.12 ~/venvs/speech-service'   # first install only
ssh alfyws '/usr/local/bin/uv pip sync --python ~/venvs/speech-service/bin/python ~/opt/speech-service/requirements.lock'
# 3. The Hungarian voices (as alfyws), first install only.
ssh alfyws 'mkdir -p /home/alfyws/opt/zonos3/servers/ggml/gguf/voices/Hungarian'
rsync -a .superpowers/hu-voices/berta.npy .superpowers/hu-voices/imre.npy \
  alfyws:/home/alfyws/opt/zonos3/servers/ggml/gguf/voices/Hungarian/
# 4. The unit (as root), first install or when the unit changed.
ssh alfyroot 'install -m 0644 -o root -g root /home/alfyws/opt/speech-service/speech-service.service /etc/systemd/system/speech-service.service && systemctl daemon-reload && systemctl enable --now speech-service'
# An update of the code only: step 1 (and 2 if the lock changed), then
ssh alfyroot 'systemctl restart speech-service'
```

Then check it: `GET /health` must say `{"ok":true,"zonos":true,"aligner":true}` (an `aligner` of `false` means the CLI or the model was not found: the journal says which), it must listen on `127.0.0.1:1920` only, and the live check must pass:

```sh
ssh alfyws 'curl -s http://127.0.0.1:1920/health; ss -ltn | grep ":1920 "'
ssh alfyws 'cd ~/opt/speech-service && ~/venvs/speech-service/bin/python -I -B scripts/live_check.py --service http://127.0.0.1:1920 --zonos http://127.0.0.1:1919 --out /home/alfyws/opt/speech-service-live'
ssh alfyws 'rm -rf /home/alfyws/opt/speech-service-live'   # its output is a test artifact
```

Logs: `journalctl -u speech-service` (as root): ids, counts and timings, never reply text.

### Measured on the box (2026-11-16)

| What | Measured |
|---|---|
| Box | AMD Ryzen 9 9950X, 16 cores / 32 threads; 190,202 MB RAM (about 55 GB available), swap 24 of 32 GB in use; GPU0 653 MiB free of 97,887 (vLLM and Zonos), GPU1 about 26 GB free; Python 3.12.15; ffmpeg 7.1.5 with libmp3lame |
| Word timing | native CLI (the plan's rule: under 1.5 GB with the service, a 5 s sentence in under 2 s): 0.20-0.53 s per sentence of 2.9-9.5 s at `-t 16` including start and model load, 0.35 s at `-t 8` for 4.3 s; 528-593 MiB peak (813-890 MiB for a 32-38 s clip, which the CLI aligns in its own long-form mode as accurately); all words placed |
| Service memory | about 80 MB idle; 695 MB peak (the cgroup, aligner runs included) against the 2 GB cap and the 1.5 GB budget |
| First audio, short first sentence (46 characters) | 0.50 s from the POST |
| First audio, first sentence of about 186 characters | 1.44 s (English, Imogen), 1.71 s (Hungarian, Berta): it grows with the first sentence's length, because a sentence is synthesized whole before it is loudness-matched |
| Live check | all 6 checks pass: 36.6 s of audio made in 6.0 s, 77 of 78 tokens timed (the lone `→` has none, as meant), gaps 0.30 / 0.60 s, timeline and audio length equal |
| Cancel and the Zonos slot | a cancel frees it: two long requests together took 2.43 s, and 2.56-2.59 s right after a reading was cancelled in mid-synthesis (a kept slot would have made one wait about 4 s) |
| vLLM while a reading is made | single-stream decode speed 157 tok/s idle and 141 tok/s while a reading's sentences are being synthesized (−10%, four alternating rounds, no other vLLM traffic); unchanged while no reading is made. Zonos shares GPU0 with vLLM and works in bursts (about a seventh of a reading's length), so a reading costs vLLM about 1-2% on average |

**Knob ranges.** The voice editor's five knobs make six Zonos controls, each with a range that was measured on the owner's Mac (spec §4.6, §9.4). `scripts/measure_knobs.py` measures them again on the box's own Zonos. For each language it renders the language's two sample sentences at growing doses of one control at a time, for every voice and three seeds, and finds the last dose before one goes wrong: a word the aligner does not place, more clipping than the voice's baseline (5 seeds, no control), a silence inside the clip longer than 1.5 × the baseline's longest (and at least 0.8 s), or a length outside 0.5-2 × the baseline's median (the tempo: 0.4-2.5 ×). It stops a series at its first unsafe dose, and never reports a range wider than the spec's. The clips are made as a preview is, through the service's own normalizer and Zonos request. It costs about 15 minutes of Zonos beside vLLM (which decodes about 10% slower meanwhile) and restarts nothing. Run it as `alfyws`, with the service's Python and its aligner, into a folder outside the repository:

```sh
ssh alfyws 'cd ~/opt/speech-service && ~/venvs/speech-service/bin/python -I -B scripts/measure_knobs.py --out /home/alfyws/knob-ranges-<date> --aligner-cli /home/alfyws/opt/fusealign/fusealign-multilingual/ggml/build/fusealign-cli --aligner-model /home/alfyws/opt/fusealign/models/fusealign-multilingual-cjkft-step2500-q8_0.gguf --aligner-threads 8'
```

It writes `knob-ranges.json` (every clip's numbers: no audio, no text) and prints the `SAFE_CONTROL_RANGES` object to paste into `src/lib/shared/read-aloud/voice-knobs.ts`. Copy the report off the box and delete its folder. Exit status 0 means the sweep ran, whatever it found; 1 that it could not (Zonos or the aligner cannot be reached, or Zonos makes no baseline clip); 2 a bad argument. `--voices` and `--seeds` shorten a run. Without the aligner flags the words are not checked, and the report says so. The ranges measured on the box are not in yet.

**Speaking rates.** The browser estimates how long a reading will be, before its sentences are made, from each voice's `charsPerSecond` in `src/lib/server/services/read-aloud/voices.ts` (15 for every voice until it is measured; readings correct the estimate as sentences arrive). `scripts/measure_rates.py` asks the running service for a preview of each sentence in each voice, one after the other (the language's two samples and four plain sentences with no digit or symbol, which a voice would expand into more words than are written), reads each clip's length from its MP3 frames, and prints each voice's rate (the characters of all its sentences over the seconds of all its clips, to 0.1) as the line to put into `voices.ts`. It costs about a minute of Zonos beside vLLM and restarts nothing. Run it as `alfyws`, with the service's Python, into a folder outside the repository:

```sh
ssh alfyws 'cd ~/opt/speech-service && ~/venvs/speech-service/bin/python -I -B scripts/measure_rates.py --service http://127.0.0.1:1920 --out /home/alfyws/opt/speech-service-rates'
```

It writes `rates.json` (each sentence's length and its clip's seconds, per voice) and nothing else. Copy the report off the box and delete its folder. Exit status 0 means it ran; 1 that the service did not answer or refused (a 4xx or 5xx); 2 a bad argument. The rates measured on the box are not in yet.

ffmpeg 7.1.5 (the box) reads ahead about 5 s of input before it encodes unless told not to; the encoder passes `-probesize 32 -analyzeduration 0` for that reason (see `audio.py`).

### Known, accepted cost: vLLM decodes slower while a reading is being made

Accepted by the owner on 2026-11-16, and written down so it can be looked into later.

- **What was measured.** vLLM's single-stream decode speed (a fixed 200-token completion at temperature 0) was 157.3 tokens/s with the speech service idle. While a reading's sentences were being synthesized it was 140.8 tokens/s: **−10.5%**. That held over four alternating rounds, and vLLM's own gauge showed no other requests. With no reading running, the speed is unchanged. Zonos makes speech about 7× faster than real time, so during a reading it works in bursts, for about a seventh of the reading's length. Averaged over a reading, that costs vLLM about **1-2%**.
- **The likely cause** is Zonos's backbone sharing GPU0 with vLLM, which is the layout the design approved. This work leaves both services exactly as they were. A first attempt to attribute the cost was too noisy to prove it (Zonos alone, then the aligner alone, three runs each). The aligner and the MP3 encoder run on the CPU, not the GPU.
- **What could be tried later:**
  - Attribute it properly under real load: longer runs, comparing Zonos alone, the aligner alone (`SPEECH_ALIGNER_THREADS=4`, or `SPEECH_ALIGNER=none` for a test) and the whole service.
  - `SPEECH_PREFETCH=1` spreads the bursts thinner. The total GPU work stays the same, and there is less lookahead for the reader.
  - On Zonos's side, each needing the owner's OK because they reconfigure `zonos3.service`:
    - `--batch 1`, so readings never run two syntheses at once (a second reading would wait longer);
    - or moving Zonos's backbone to GPU1, which had about 26 GB free on 2026-11-16, so it stops sharing GPU0 with vLLM. Check what else uses GPU1 first.

### Rollback

```sh
ssh alfyroot 'systemctl disable --now speech-service && rm /etc/systemd/system/speech-service.service && systemctl daemon-reload'
```

That stops the service and nothing else. The source folder, its environment and the voices can stay (Zonos ignores voices nobody asks for), or go with `rm -rf /home/alfyws/opt/speech-service /home/alfyws/venvs/speech-service` and the `Hungarian/` folder above. FuseAlign's build under `/home/alfyws/opt/fusealign` is independent of the service.
