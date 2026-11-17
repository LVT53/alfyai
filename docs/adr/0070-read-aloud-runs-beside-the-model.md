# Read aloud runs on a speech service beside the model

Accepted (2026-11-17). The owner approved the design section by section on 2026-11-16, chose the aligner over an estimate after watching both, and approved the build and the rollout on 2026-11-17. The transport and the service's contract below are the builder's, made under that approval. The design is [`docs/superpowers/specs/2026-11-16-read-aloud-design.md`](../superpowers/specs/2026-11-16-read-aloud-design.md) (§3, §4.10, §6); the service's contract is [`deploy/speech-service/README.md`](../../deploy/speech-service/README.md).

## Context

Every reply can be listened to, in English or in Hungarian, with the sentence being read tinted and the word being spoken marked. The voice is ZONOS3-Mini, already running on the GPU box at `127.0.0.1:1919` beside vLLM, with its waveform decoder on the CPU. It is a voice and nothing more: it returns audio and no sentence or word times, it takes the language only to choose its text-normalization rules, it stops a request at about 100 s of speech and cuts the rest off without an error, and it runs two syntheses at once. Following along needs word times, so something has to make them. A reading has to start within about a second, and the person can pause for as long as they like, jump to any sentence and change the speed.

Four facts about AlfyAI constrain the answer. The box's memory is tight (swap has been used before, and GPU0 has about 650 MiB free), so anything new on it needs a budget and a measurement. Speech is an auxiliary service: a chat turn must never wait on it or break because of it (`AGENTS.md`, Known Traps). Replies are private, so no audio and no reply text may be kept. And an address the app requests on its own comes from configuration, never from a model ([ADR-0068](0068-model-output-never-picks-an-address-fetched-without-a-click.md)).

## Decision

**1. One speech service on the GPU box, beside Zonos and vLLM, on loopback only.** `deploy/speech-service/` is a small Python 3.12 service (Starlette on uvicorn), run by systemd as `speech-service.service` on `127.0.0.1:1920`; it refuses to bind anything else. For each sentence it normalizes the text, calls Zonos once, times the words, matches the loudness and encodes MP3. It is the provider boundary the infrastructure handoff asked for: the model behind it can change without AlfyAI noticing. It puts nothing more on GPU0: Zonos's decoder stays on the CPU, and so does the aligner.

**2. Word times come from FuseAlign's native aligner, on the CPU, one alignment at a time.** It aligns the normalized sentence (what was spoken) and the result is mapped back to the written words, so a written run that was spoken as several words ("12 990 Ft") is marked as one unit. On the box it takes 0.20-0.53 s for a sentence of 2.9-9.5 s and peaks at 528-593 MiB. A word mark never comes from an estimate.

**3. AlfyAI's server is the service's only reader, and it keeps an in-memory replay.** A session's audio and its timeline can each be read once. So the server opens both as soon as the session exists and answers every browser request from what it holds: the audio from its first byte, then live, up to a cap; the timeline whole. The service never meets a browser, a `Range` request or a second tab. The server also checks that the person may read the message and that every sentence it is asked to speak occurs in that message, in order, so its route is not a free text-to-speech service. One person has one reading at a time, and a jump is a new session from another sentence.

**4. One progressive MP3 per reading, with the timeline over server-sent events.** The browser plays one response in one `<audio>` element while the service is still making it, and a second response says where each sentence and word falls on that audio's clock. Speed is the browser's `playbackRate`. A stop or a jump ends the session, which frees Zonos's slot.

**5. The preview is joined per sentence.** The voice editor's and Settings' ▶ speak a short sample with a voice that may not be saved yet: one service call per sentence, all at once, joined with a 0.30 s gap into one whole MP3, with the sentences' times in a response header. Nothing is cached.

**6. Nothing is stored, and no log carries text.** No audio is written to disk anywhere. What is held is held in memory and goes with its reading: the server's replay when the reading closes, the browser's copy when the page does. No reply text reaches a log: ids, counts, timings and field paths only. The one file is the aligner's temporary clip, for the length of one call. An incognito chat can be read aloud and leaves nothing behind. The database keeps only a person's choice of voices, their default speed and their personal voices (a name, a built-in voice to start from and five knob values).

**7. It degrades, and it can be switched off.** Without the aligner a reading goes on with sentence marks only and says nothing. With the service down or failing, the speaker says calmly that it could not start (or a running reading stops, with Try again), and the chat itself is untouched. `TTS_ENABLED` and `TTS_URL` are live admin settings: with either unset there is no speaker and no Read aloud card, and nothing else changes.

**8. The address comes only from `config-store.ts`.** `getReadAloudUrl()` is the one door. The browser never sends an address, and no word of a reply becomes one. ADR-0068 is unaffected.

## Options considered

| Option | Why it was not chosen |
|---|---|
| **Word times estimated from the letters of each word** | No aligner and no extra memory, but off by 70-430 ms on a typical word and by up to 0.9 s, worst around numbers. The owner watched both side by side and chose the aligner. |
| **FuseAlign as a Python package** | The same model and accuracy without building the C++ CLI, but 3.7 GB resident (measured on the Mac) against a 1.5 GB budget on a box that has swapped. The native build peaks at 528-593 MiB. |
| **Audio per sentence** (one request, or one `<audio>` source, for each sentence) | More requests, and a gap at the start of every sentence, where one stream plays straight on. |
| **Zonos's own timestamps** | It has none: the model returns audio only. |

## Consequences

- vLLM decodes about 10% slower while a reading's sentences are being made (157 to 141 tokens/s on one stream), and about 1-2% slower averaged over a whole reading, because Zonos's backbone shares GPU0 with it. The owner accepted this on 2026-11-16. The speech service's README records it as a known, accepted cost, with what could be tried later.
- The service has a budget of 1.5 GB resident (its unit caps it at 2 GB). Its measured peak is 695 MB, aligner runs included.
- Capacity is a few readings at once. Zonos makes two syntheses at a time and a third waits in its queue (the browser says the voice is busy after 2.5 s), and the aligner times one sentence at a time. Zonos measured 4.7-5.8× faster than real time with four readings at once.
- Apache must not buffer two routes. `GET /api/read-aloud/sessions/{id}/audio` and `…/events` need the streaming rules on each site's vhost. `deploy/apache-site.conf` is the template, and `deploy/README.md` ("Read aloud") says how to check them. Without them a reading starts late or stalls.
- The knobs' ranges and each voice's speaking rate were first measured on the owner's Mac (the MLX build), and the box's own Zonos is a quantized ggml build that may sound different. They are measured again on the box (`scripts/measure_knobs.py`, `scripts/measure_rates.py`) and the numbers go into `voice-knobs.ts` and `voices.ts`. Until then the ranges are the design's, and every voice is assumed to speak 15 characters a second, which only the estimate of a reading's length uses; readings correct it as sentences arrive.
- A second user of speech would need its own design. The service lets a session be read once and has no sign-in of its own: its protection is that it listens on loopback. Anything beyond AlfyAI's server that wanted to read from it would need both.
