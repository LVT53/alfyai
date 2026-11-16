# Read Aloud — Plan 2 of 4: Reading in the Chat

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A speaker on every finished reply reads it aloud through Plan 1's speech service, with sentence and word marks, a floating player with a sentence scrubber, every failure state of spec §4.8, and Read from here, all built and tested against a fake of Plan 1's HTTP contract.

**Architecture:**
- **The browser** builds a *speech script* from the rendered reply: paragraphs, then sentences, then tokens, each token with its DOM `Range`. A lazily loaded tinyld detector names each paragraph's language.
- **A new session route** checks that the person owns the conversation and that every sentence's letters occur in the reply's text in order. It resolves the built-in voices, opens a session on the speech service, and becomes that session's only reader. It keeps a bounded in-memory replay of the session's MP3 and timeline, so any number of browser requests can attach.
- **Playback:** the browser plays the MP3 in one `<audio>` element and maps `currentTime` through the timeline to the sentence and word.
- **Marks** are drawn on an overlay behind the text.
- **State:** a pure reducer owns every reading state and failure, and an impure controller carries out the reducer's commands.

**Tech Stack:**
- SvelteKit 2.70 and Svelte 5.56 in runes mode, TypeScript, zod 4.
- `<audio>` with `playbackRate` and `preservesPitch`; `EventSource`; `Intl.Segmenter` and `Intl.DisplayNames`.
- tinyld 1.3.4 (MIT): its browser build is an ES module, loaded as a lazy chunk.
- Tests: Vitest 4 (jsdom by default; `// @vitest-environment node` for server tests), @testing-library/svelte, and Playwright on the production build.

**Spec:** `docs/superpowers/specs/2026-11-16-read-aloud-design.md`: §4.1–§4.5, §4.8–§4.10, §5, §6.1–§6.3 and §7.
- **Visual truth:** `docs/superpowers/specs/2026-11-16-read-aloud/player-prototype.html` for the player, the scrubber, the phone layout and the failure states. Open it in a browser; the `player-*.png` and `v4-*.png` files beside it are stills.
- **Plan 1** is `docs/superpowers/plans/2026-11-16-read-aloud-1-speech-service.md`. Its "HTTP contract" block is fixed: this plan's fake implements it and the server talks to it.
- **Do not touch** `deploy/speech-service/`.

## Global Constraints

- **Docs check before code** (`AGENTS.md`). This session had no Context7 or Svelte MCP tools, so the plan was checked against:
  - the installed SvelteKit 2.70.3 source (`@sveltejs/kit/src/exports/node/index.js`): a streamed body is cancelled when the browser goes, but `request.signal` is not reliably aborted for a GET;
  - MDN and web-features for `preservesPitch`: unprefixed in Safari 17.2, Chrome 86 and Firefox 101;
  - tinyld's README and its published `dist`.

  Each implementer checks the current Svelte and SvelteKit docs for the APIs their own task touches.
- **Svelte and icons:**
  - Svelte 5 runes, with callback props.
  - Icons come from Lucide only: `Volume2`, `VolumeX`, `Pause`, `Play`, `SkipBack`, `SkipForward`, `LocateFixed`, `X`, `RotateCcw`, `CircleAlert`, `WifiOff` and `Clock`.
  - The speaker's progress ring is an inline SVG data visualisation, which `src/lib/components/AGENTS.md` allows, as it does for `ContextUsageRing`.
- **Strings:** every new string exists in English and Hungarian. The words are fixed in "Copy" below.
- **Addresses:** the speech service is reached only through `config-store.ts` (`TTS_URL`). The browser loads only same-origin `/api/read-aloud/…` addresses, so ADR-0068 is unaffected.
- **Privacy:** no audio and no reply text is written to disk or to a log. Log lines carry ids, counts and timings only.
- **Motion** uses the tokens: `--duration-micro` (100 ms), `--duration-standard` (150 ms), `--duration-emphasis` (250 ms), `--ease-out`, `--ease-emphasis` and `--ease-in`. The word marker's glide is 90 ms linear. Under reduced motion, `app.css` already collapses every transition.
- **Speeds:** 0.75, 1, 1.25, 1.5, 1.75 and 2.
- **Timers:**
  - the busy note appears after 2500 ms;
  - a start times out after 20000 ms;
  - a failed speaker shows for 3000 ms, and its note for at most 8000 ms;
  - "Finished" shows for 1100 ms;
  - a pause longer than 30000 ms ends the session;
  - during an update, health is polled every 3000 ms (`SERVER_UPDATE_WATCH_POLL_MS`) for at most 8 min (`SERVER_UPDATE_WATCH_MAX_MS`).
- **Gaps between sentences** are 0.30 s, and 0.60 s before a paragraph start (Plan 1's values; here they are used in the estimates).
- **Narrow layout:** `@media (max-width: 767px)`, the composer's own breakpoint.
- **Gates:**
  - Once, at the end: `scripts/gates.sh agent "$TMPDIR/alfyai-gates" --port <base> tests/e2e/read-aloud.spec.ts tests/e2e/read-aloud-failures.spec.ts`.
  - While iterating: `npx vitest run <file>`, `npm run check` and `npx biome check src scripts tests`.

## Decisions this plan makes (owner to confirm)

1. **The detector.** tinyld's normal build (62 languages, among them hu, en, de, fr, es, it, nl, pt and pl) is lazily loaded in the browser.
   - A paragraph under 40 letters takes the language of the paragraph before it.
   - A short paragraph that opens the reply takes the language of the first named paragraph after it.
2. **A reply with nothing readable** (only code, a table or a chart): the speaker is dimmed with the note "Nothing in this reply can be read aloud."
3. **The app server is the speech service's only reader.**
   - It keeps up to 8 MB of a session's MP3 (about 8.7 min), and the session's whole timeline, in memory.
   - So a browser that asks twice still hears the stream from its first byte. Safari probes media with a range request before its real one.
   - It is all dropped when the reading ends.
4. **A pause longer than 30 s ends the session.** Play then restarts at the start of that sentence, as after a hidden page.
5. **Player times are listening times** (divided by the speed), as in the prototype.
6. **Speaking rates for the estimate:** English 15 and Hungarian 14 characters per second, until Plan 4 measures them on the box.
7. **Short sentences across paragraphs.** When a one- or two-word sentence joins one in the next paragraph, its last token gets "." after a heading and "," after anything else, so headings and lists keep their pause.
8. **A reading replaced by one in another tab ends quietly,** with no error note.

## Review Focus

1. **A harmless re-render of the reply being read** (evidence loading, a theme switch) replaces the script's text nodes. The reading must go on, not stop. Test: `rebuilds the script when its nodes are replaced but the text is the same` (Task 10).
2. **A reply with links, images, HTML entities, inline code and "Ask me first" segments:** the containment check must accept every sentence the browser builds from it. Test: `accepts what the browser reads from a reply with links, images, entities and inline code` (Task 2).
3. **Safari asks for the audio twice:** both requests hear the stream from its first byte. Test: `a second reader of the audio hears it from the first byte` (Task 4).
4. **The person closes the tab mid-reading:** the app server ends the session within 30 s and stops calling the speech service. Test: `ends a reading 30 s after its last browser reader leaves` (Task 4).
5. **A one-word heading followed by one-word list items** ("Ingredients", "Flour", "Water", "Salt"): no sentence of fewer than three words reaches the voice, and the pauses survive. Test: `merges short sentences across paragraphs with a pause mark` (Task 7).

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/lib/server/env.ts`, `src/lib/server/config-store.ts`, `src/lib/config/admin-config-registry.ts` | `TTS_ENABLED`, `TTS_URL`; `getReadAloudUrl()` |
| `src/lib/server/services/app-shell.ts` | `readAloudEnabled` in the shell data |
| `src/lib/server/services/read-aloud/AGENTS.md` | Server rules: access, containment, one reading per person, replay, idle end, privacy |
| `…/read-aloud/voices.ts` | The six built-in voices in code; `defaultVoiceFor` |
| `…/read-aloud/containment.ts` | The reply-text containment check |
| `…/read-aloud/request.ts` | The zod schema of a session request |
| `…/read-aloud/speech-client.ts` | HTTP calls to the speech service (Plan 1's contract) |
| `…/read-aloud/readings.ts` | The registry: one reading per person, replay of audio and events, idle end |
| `…/read-aloud/index.ts` | The service's public surface for routes |
| `…/read-aloud/testing/fake-speech-service.ts` | A loopback fake of Plan 1's contract (Node built-ins only) |
| `src/lib/shared/read-aloud/silent-mp3.ts` | Silent MP3 frames: the fake's audio and the browser's iOS unlock clip |
| `scripts/run-fake-speech-service.ts` | Runs the fake on a port, for manual checks |
| `src/routes/api/read-aloud/sessions/**` | The five session routes |
| `src/lib/client/read-aloud/AGENTS.md` | Browser rules: DOM-only script, marks never reflow, the controller owns audio, the detector exception |
| `src/lib/client/read-aloud/language.ts` | The read-aloud language detector (tinyld) and language names |
| `src/lib/client/read-aloud/speech-script.ts` | DOM to sentences and tokens with ranges, with every §4.4 exclusion |
| `src/lib/client/read-aloud/timeline.ts` | `currentTime` to sentence and word; shares, notches, estimates, clock text |
| `src/lib/client/read-aloud/reading-machine.ts` | The pure reducer: states, events, commands |
| `src/lib/client/read-aloud/controller.ts` | Performs commands: audio, EventSource, timers, visibility, online state, health |
| `src/lib/client/read-aloud/line-rects.ts` | Range rects to per-line boxes |
| `src/lib/client/api/read-aloud.ts` | Browser calls to the session routes |
| `src/lib/stores/read-aloud.ts` | `readAloudAvailable`, `readAloudView` (state only) |
| `src/lib/stores/thread-focus.ts` | A one-shot request for `MessageArea` to bring a sentence into view |
| `src/lib/utils/damped-follow.ts` | One retargetable damped scroll |
| `src/lib/i18n/read-aloud.ts` | `readAloud.*` in English and Hungarian |
| `src/lib/components/read-aloud/ReadAloudSpeaker.svelte` | The speaker in the action row, with its notes |
| `src/lib/components/read-aloud/ReadAloudNote.svelte` | The calm or amber note (`role="status"`) |
| `src/lib/components/read-aloud/ReadAloudMarks.svelte` | Sentence tint, scrubber target and word marker, behind the text |
| `src/lib/components/read-aloud/ReadAloudPlayer.svelte` | The floating player and its slot |
| `src/lib/components/read-aloud/ReadAloudScrubber.svelte` | The sentence scrubber |
| `src/lib/components/read-aloud/ReadAloudSpeedMenu.svelte` | The speed chip and menu |
| `src/lib/components/read-aloud/ReadFromHere.svelte` | The pill on a selection |
| `tests/e2e/read-aloud-helpers.ts`, `tests/e2e/read-aloud.spec.ts`, `tests/e2e/read-aloud-failures.spec.ts` | End-to-end on the fake |

These existing files are modified:
- `MessageBubble.svelte`, `reply-segments.ts`, `MessageArea.svelte`, `MessageInput.svelte` and `ChatComposerPanel.svelte`;
- `(app)/+layout.svelte` and `app.css`;
- `i18n/index.ts` and `i18n/settings.ts`;
- `package.json` and `.fallowrc.json`;
- `README.md` and `.env.example`;
- `chat-turn/AGENTS.md`, `services/AGENTS.md`, `client/AGENTS.md`, `stores/AGENTS.md`, `tests/AGENTS.md` and the root `AGENTS.md`.

## The browser ↔ app contract

```
POST   /api/read-aloud/sessions
       body {conversationId, messageId, sentences: [{id: "s<n>", language: "en"|"hu", tokens: [str], paragraphStart: bool}]}
       → 201 {sessionId, defaultSpeed: 1, charsPerSecond: {en, hu}}
       → 400 invalid_request · 404 not_found | read_aloud_off · 422 not_in_reply · 503 voice_unavailable
GET    /api/read-aloud/sessions/{id}/audio     → 200 audio/mpeg: from the first byte, then live · 409 already_read once the replay is released
GET    /api/read-aloud/sessions/{id}/events    → 200 text/event-stream: Plan 1's events replayed then live,
                                                  plus `event: replaced` and a `: hb` comment every 15 s
POST   /api/read-aloud/sessions/{id}/position  {sentenceId} → 204
DELETE /api/read-aloud/sessions/{id}           → 204
Every {id} route answers 404 unless {id} is the caller's current reading.
```

## Copy

| Key (`readAloud.` unless noted) | English | Hungarian |
|---|---|---|
| `speaker.read` | Read aloud | Felolvasás |
| `speaker.pause` | Pause reading | Felolvasás szüneteltetése |
| `speaker.resume` | Resume reading | Felolvasás folytatása |
| `note.noVoice` | Read aloud isn't available in {language} yet. | {language} nyelvű felolvasás még nem érhető el. |
| `note.noVoiceUnknown` | Read aloud isn't available in this language yet. | Ezen a nyelven még nem érhető el felolvasás. |
| `note.nothing` | Nothing in this reply can be read aloud. | Ebben a válaszban nincs felolvasható szöveg. |
| `note.busy` | The voice is busy with another reading. Yours starts in a moment. | A hang most egy másik felolvasással foglalt. A tiéd mindjárt indul. |
| `note.cantStart` | Couldn't start reading. The voice isn't answering right now. | Nem sikerült elindítani a felolvasást. A hang most nem válaszol. |
| `note.stopped` | Reading stopped. The voice stopped answering. | A felolvasás megállt. A hang nem válaszol. |
| `note.offline` | You're offline. Reading continues when you're back. | Nincs internetkapcsolat. A felolvasás folytatódik, amint visszatér. |
| `note.updating` | AlfyAI is updating. Reading continues when it is back. | Az AlfyAI frissül. A felolvasás folytatódik, amint újra elérhető. |
| `tryAgain` | Try again | Próbáld újra |
| `dismiss` | Dismiss | Bezárás |
| `player.label` | Read aloud player | Felolvasó lejátszó |
| `player.previous` / `player.next` | Previous sentence / Next sentence | Előző mondat / Következő mondat |
| `player.play` / `player.pause` | Play / Pause | Lejátszás / Szünet |
| `player.waiting` | Waiting to continue | Folytatásra vár |
| `player.locate` | Go to where it's reading | Ugrás oda, ahol tart |
| `player.speed` | Speed | Sebesség |
| `player.stop` | Stop reading | Felolvasás leállítása |
| `player.finished` | Finished | Vége |
| `scrubber.label` | Sentence | Mondat |
| `scrubber.value` | Sentence {n} of {total} | {n}. mondat, összesen {total} |
| `readFromHere` | Read from here | Felolvasás innen |
| `admin.system.keys.TTS_ENABLED.label` | Read aloud | Felolvasás |
| `admin.system.keys.TTS_ENABLED.meaning` | Puts a speaker on every finished reply that reads it aloud through the speech service. | Minden kész válaszra hangszórót tesz, amely a beszédszolgáltatással felolvassa. |
| `admin.system.keys.TTS_URL.label` | Speech service | Beszédszolgáltatás |
| `admin.system.keys.TTS_URL.meaning` | Where the read-aloud speech service listens on this machine (http://127.0.0.1:1920). Read aloud stays off while it is empty. | A felolvasó beszédszolgáltatás címe ezen a gépen (http://127.0.0.1:1920). Amíg üres, a felolvasás ki van kapcsolva. |

**How the words are filled in:**
- `{language}` comes from `Intl.DisplayNames([uiLanguage], { type: "language", fallback: "none" })`, with its first letter upper-cased ("German", "Német"). An unnamed language uses `note.noVoiceUnknown`.
- A speed is written with `Intl.NumberFormat(uiLanguage)` plus "×": "1,25×" in Hungarian.
- An estimated total starts with "≈".

---

### Task 1: Config — `TTS_ENABLED` and `TTS_URL`

**Files:**
- Modify:
  - `src/lib/server/env.ts`: add `ttsEnabled` and `ttsUrl` to `interface Config` and to the reader, beside `comfyuiLtxUrl`.
  - `src/lib/server/config-store.ts`: `ADMIN_CONFIG_KEYS`, `RuntimeConfig`, `overrideAppliers`, `getResolvedAdminConfigValues`, and a new getter beside `getComfyuiLtxUrl`.
  - `src/lib/config/admin-config-registry.ts`: two specs in `ADVANCED_KEY_SPECS`, group `"integrations"`, effect `"live"`; `TTS_ENABLED` is `{ kind: "bool" }` and `TTS_URL` is `{ kind: "url" }`.
  - `src/lib/i18n/settings.ts`: the four admin keys from Copy, in English and Hungarian.
  - `src/lib/server/services/app-shell.ts`: `readAloudEnabled`.
  - `src/routes/(app)/+layout.svelte`: in `onMount`, beside `setMaxFileUploadSize`, call `setReadAloudAvailable(data.readAloudEnabled)`.
  - `README.md`: one line in the integrations list: "**Read aloud** — `TTS_ENABLED` (default `false`) and `TTS_URL`, the speech service in `deploy/speech-service/` on loopback (`http://127.0.0.1:1920`). With either unset, no speaker appears."
  - `.env.example`: a commented block naming both keys, the loopback default `http://127.0.0.1:1920`, and that read aloud stays off until both are set.
- Create:
  - `src/lib/stores/read-aloud.ts`, with this task's part only.
- Test:
  - `src/lib/server/services/config-store.test.ts` and `src/lib/server/services/app-shell.test.ts`.

**Interfaces:**
- Produces:
  - `getReadAloudUrl(config?: Pick<RuntimeConfig, "ttsEnabled" | "ttsUrl">): string`: the trimmed address with no trailing slash; `""` unless the feature is enabled and the address is set.
  - `AppShellData.readAloudEnabled: boolean`, which is `getReadAloudUrl() !== ""`.
  - `readAloudAvailable: Readable<boolean>` and `setReadAloudAvailable(on: boolean): void`.

- [ ] **Step 1: Write the failing tests**

```ts
it("reads TTS_ENABLED and TTS_URL, and lets an admin override them", () => {
	// env defaults: ttsEnabled false, ttsUrl ""
	applyOverrides({ TTS_ENABLED: "true", TTS_URL: " http://127.0.0.1:1920/ " });
	expect(getReadAloudUrl()).toBe("http://127.0.0.1:1920");
	expect(getResolvedAdminConfigValues().TTS_ENABLED).toBe("true");
});
it("is off when enabled without an address, and when an address is set but not enabled", () => {
	expect(getReadAloudUrl({ ttsEnabled: true, ttsUrl: "" })).toBe("");
	expect(getReadAloudUrl({ ttsEnabled: false, ttsUrl: "http://127.0.0.1:1920" })).toBe("");
});
// app-shell.test.ts
it("says read aloud is on only when it is enabled and has an address", …);
```

Use whatever override helper the existing `config-store.test.ts` cases use; `applyOverrides` above stands for it.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/server/services/config-store.test.ts src/lib/server/services/app-shell.test.ts`.
- [ ] **Step 3: Implement.** Booleans follow `ROUTING_ON_DEMAND_ENABLED` (`value.trim() === "true"`), and the URL follows `COMFYUI_LTX_URL`. Then run the registry and i18n tests that already exist (`npx vitest run src/lib/config src/lib/i18n`): they hold every admin key to a label and every key to both languages.
- [ ] **Step 4: Run all of the above and see them pass.** Then run `npm run check`.
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): TTS_ENABLED and TTS_URL through env, config-store and the System pane"`

### Task 2: Built-in voices and the containment check

**Files:**
- Create: `src/lib/server/services/read-aloud/voices.ts`, `containment.ts`, `voices.test.ts` and `containment.test.ts`.

**Interfaces:**
- Produces, in `voices.ts`:
  - `type VoiceLanguage = "en" | "hu"`.
  - `type BuiltInVoice = { key: string; name: string; language: VoiceLanguage; speakerId: string; controls: Record<string, number>; charsPerSecond: number }`.
  - `BUILT_IN_VOICES: readonly BuiltInVoice[]`, in this order:

    | `key` | `name` | `speakerId` | `controls` | `charsPerSecond` |
    |---|---|---|---|---|
    | `imogen` | Imogen | `default_b78b28baf5c31a1d` | `{}` | 15 |
    | `rupert` | Rupert | `default_3765f0d1140c05c0` | `{}` | 15 |
    | `savannah` | Savannah | `default_de4d191ca7574982` | `{}` | 15 |
    | `wyatt` | Wyatt | `default_34370fd91e3484ef` | `{}` | 15 |
    | `berta` | Berta | `PENDING_FROM_BOX_berta` | `{ "room.clean": 2 }` | 14 |
    | `imre` | Imre | `PENDING_FROM_BOX_imre` | `{ "room.clean": 2 }` | 14 |

  - Berta's and Imre's ids sit under a comment: `// PLACEHOLDER: Plan 1 Task 8 records these ids from the box's GET /v2/speakers in deploy/speech-service/README.md ("Deploy"). Plan 4 puts them here before TTS_ENABLED goes on.`
  - `PENDING_SPEAKER_ID_PREFIX = "PENDING_FROM_BOX_"`.
  - `defaultVoiceFor(language: VoiceLanguage): BuiltInVoice`: `en` gives Imogen and `hu` gives Berta, until Plan 3 adds a choice.
- Produces, in `containment.ts`:
  - `letterKey(text: string): string`: NFKC-normalised, lower-cased, keeping only `\p{L}` and `\p{N}`.
  - `readableReplyText(markdown: string): string`: replaces with a space everything that puts letters in the source but not on screen, in this order (images before links, so an image's alt text cannot survive as a link's text):
    - image syntax `![…](…)`;
    - link destinations `](…)` (one level of nested parentheses), keeping `]`;
    - reference definitions `[x]: url` (whole lines);
    - autolinks `<https://…>` and `<mailto:…>`;
    - bare `https?://…` and `www.…` runs;
    - HTML tags;
    - entities `&name;` and `&#n;`.
  - `sentencesFitReply(replyMarkdown: string, sentences: ReadonlyArray<{ tokens: readonly string[] }>): number | null`:
    - returns `null` when every sentence's `letterKey(tokens.join(" "))` is found in `letterKey(readableReplyText(markdown))`, each searched for from where the one before it ended;
    - otherwise returns the index of the first sentence that is not;
    - an empty key counts as found.

- [ ] **Step 1: Write the failing tests**

```ts
it("accepts what the browser reads from a reply with links, images, entities and inline code", () => {
	const md = "See [the docs](https://example.com/a_(b)) now. ![a cat](cat.png) Salt &amp; pepper, `npm_install()` and **bold**.";
	expect(sentencesFitReply(md, [
		{ tokens: ["See", "the", "docs", "now."] },
		{ tokens: ["Salt", "&", "pepper,", "npm", "install", "and", "bold."] },
	])).toBeNull();
});
it("ignores spacing in numbers and emoji", () =>
	expect(sentencesFitReply("A jegy ára 12 990 Ft 🎟️.", [{ tokens: ["A", "jegy", "ára", "12", "990", "Ft."] }])).toBeNull());
it("names the first sentence that is not in the reply", () =>
	expect(sentencesFitReply("One two three.", [{ tokens: ["One", "two"] }, { tokens: ["Free", "speech"] }])).toBe(1));
it("refuses sentences out of order", () =>
	expect(sentencesFitReply("Alpha beta. Gamma delta.", [{ tokens: ["Gamma", "delta."] }, { tokens: ["Alpha", "beta."] }])).toBe(1));
it("gives the English voices their ids and the Hungarian ones studio by default", () => {
	expect(defaultVoiceFor("en").speakerId).toBe("default_b78b28baf5c31a1d");
	expect(defaultVoiceFor("hu").controls).toEqual({ "room.clean": 2 });
	for (const v of BUILT_IN_VOICES) expect(v.speakerId).toMatch(/^(default_[0-9a-f]{16}|PENDING_FROM_BOX_[a-z]+)$/);
});
```

- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/server/services/read-aloud`.
- [ ] **Step 3: Implement** the two modules.
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): built-in voices and the reply containment check"`

### Task 3: Silent MP3 frames and the fake speech service

**Files:**
- Create:
  - `src/lib/shared/read-aloud/silent-mp3.ts` and `silent-mp3.test.ts`;
  - `src/lib/server/services/read-aloud/testing/fake-speech-service.ts` and `fake-speech-service.test.ts` (`// @vitest-environment node`);
  - `scripts/run-fake-speech-service.ts`.
- Modify: `.fallowrc.json`, adding the script to `entry` because it is a standalone script.

**Interfaces:**
- Produces, in `silent-mp3.ts` (no Node or DOM APIs beyond `btoa`):
  - `MP3_FRAME_SECONDS = 1152 / 44100`.
  - `silentMp3(seconds: number): Uint8Array`: `Math.ceil(seconds / MP3_FRAME_SECONDS)` frames. Each frame is 417 bytes: the MPEG-1 Layer III header `FF FB 90 C0` (44.1 kHz, mono, 128 kbit/s, no CRC, no padding) followed by 413 zero bytes, which decode as silence.
  - `silentMp3DataUri(seconds = 0.1): string`: `data:audio/mpeg;base64,…`.
- Produces, in `fake-speech-service.ts`, which uses Node built-ins and relative imports only so Playwright can import it:
  - `type FakeSpeechOptions`:
    - `secondsPerChar?: number`, default 0.02;
    - `firstAudioDelayMs?: number`;
    - `refuseSessions?: boolean`, so `POST /v1/sessions` answers 503;
    - `failAtSentence?: number`, which sends `error {id, code: "synthesis_failed"}` at that index and ends both streams;
    - `cutAtSentence?: number`, which destroys both connections at that index with no event;
    - `wordTimes?: "even" | "null"`, default `"even"`.
  - `type FakeSpeechSession = { id: string; body: { sentences: Array<{ id: string; language: string; voice: { speaker_id: string; controls: Record<string, number> }; tokens: string[]; paragraph_start: boolean }> }; positions: string[]; deleted: boolean }`.
  - `interface FakeSpeechService { baseUrl: string; sessions: FakeSpeechSession[]; setOptions(next: FakeSpeechOptions): void; close(): Promise<void> }`.
  - `createFakeSpeechService(options?: FakeSpeechOptions): Promise<FakeSpeechService>`, listening on `127.0.0.1:0`.
- Behaviour, following Plan 1's contract:
  - a sentence's audio lasts `chars × secondsPerChar + 0.3` seconds;
  - a 0.30 s gap goes before each sentence, or 0.60 s when `paragraph_start` is set, and none before the first;
  - every duration and gap is rounded up to whole frames (`Math.ceil(seconds / MP3_FRAME_SECONDS)`), and the events report those frame-exact times;
  - each `sentence` event (start and end on the stream's clock) is written before that sentence's audio, then its `words` event (an even split, or all `null`), and `done` comes at the end;
  - a second audio `GET` answers 409, and an unknown session 404;
  - `DELETE` ends the streams;
  - `/health` answers `{ok: true, zonos: true, aligner: true}`.
- Produces, in `scripts/run-fake-speech-service.ts`: `npx tsx scripts/run-fake-speech-service.ts [--port 1929]` prints the base address and runs until Ctrl-C.

- [ ] **Step 1: Write the failing tests**
  - `silentMp3(1)` is 39 frames, 417 bytes each, and each frame starts `FF FB 90 C0`.
  - `follows Plan 1's contract for a two-sentence session`:
    - the POST answers 201 with a `session_id`;
    - the events come in the order sentence, words, sentence, words, done;
    - `start[0] === 0`, and `start[1] - end[0]` is 12 frames (0.30 s rounded up to whole frames: 0.313 s);
    - the audio is `silentMp3` frames whose count matches the events' end time.
  - `answers 409 to a second audio reader`.
  - `fails at the asked sentence with an error event`.
  - `cuts both streams at the asked sentence`.
  - `refuses sessions when asked`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/shared/read-aloud src/lib/server/services/read-aloud/testing`.
- [ ] **Step 3: Implement** both modules and the script.
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "test(read-aloud): silent MP3 frames and a fake of the speech service's contract"`

### Task 4: The speech client and the readings registry

**Files:**
- Create in `src/lib/server/services/read-aloud/`: `speech-client.ts`, `readings.ts`, `index.ts`, `AGENTS.md` and `readings.test.ts` (`// @vitest-environment node`).
- Modify:
  - `src/lib/server/services/AGENTS.md`: one entry pointing at the folder.
  - the root `AGENTS.md` Folder Rules: `` `src/lib/server/services/read-aloud/` — read aloud's sessions: who may read a reply, the containment check, one reading per person, the replay, the idle end. ``

**Interfaces:**
- Consumes: `VoiceLanguage` (Task 2) and the fake (Task 3).
- Produces, in `speech-client.ts`:
  - `type SpeechSentence = { id: string; language: VoiceLanguage; voice: { speaker_id: string; controls: Record<string, number> }; tokens: string[]; paragraph_start: boolean }`.
  - `class SpeechUnavailable extends Error`.
  - `createSpeechSession(baseUrl: string, sentences: SpeechSentence[], fetchImpl?: typeof fetch): Promise<string>`: a network error or a 5xx throws `SpeechUnavailable`; any other answer that is not 201 throws `Error`.
  - `openSpeechStream(baseUrl: string, sessionId: string, kind: "audio" | "events", signal: AbortSignal, fetchImpl?: typeof fetch): Promise<ReadableStream<Uint8Array>>`.
  - `postSpeechPosition(baseUrl: string, sessionId: string, sentenceId: string, fetchImpl?: typeof fetch): Promise<void>`, which never throws.
  - `deleteSpeechSession(baseUrl: string, sessionId: string, fetchImpl?: typeof fetch): Promise<void>`, which never throws.
- Produces, in `readings.ts`:
  - `type Reading = { sessionId: string; userId: string }`.
  - `openReading(p: { userId: string; baseUrl: string; sentences: SpeechSentence[] }): Promise<Reading>`.
  - `currentReading(userId: string, sessionId: string): Reading | null`.
  - `attachAudio(r: Reading): ReadableStream<Uint8Array> | null`.
  - `attachEvents(r: Reading): ReadableStream<Uint8Array>`.
  - `reportPosition(r: Reading, sentenceId: string): Promise<void>`.
  - `closeReading(r: Reading): Promise<void>`.
  - `READING_IDLE_MS = 30_000`, `AUDIO_REPLAY_MAX_BYTES = 8 * 1024 * 1024` and `EVENTS_HEARTBEAT_MS = 15_000`.
  - `configureReadingsForTests(o: { idleMs?: number; replayMaxBytes?: number }): void` and `resetReadingsForTests(): void`.
  - `index.ts` re-exports what routes use.
- Rules:
  - **Starting.** `openReading` closes the person's current reading first and sends `event: replaced\ndata: {}\n\n` to its events readers. It then creates the session and immediately reads both upstream streams.
  - **Replay.** Every browser reader receives everything so far, then the live tail.
  - **Releasing the audio replay.** Once the audio passes `AUDIO_REPLAY_MAX_BYTES`, the replay is released: readers already attached keep the live tail, and `attachAudio` returns `null`.
  - **Detaching.** A reader detaches in the returned stream's `cancel()`. Do not rely on `request.signal`.
  - **Idle end.** The reading closes when no audio reader has been attached for `READING_IDLE_MS`, counted from creation too. It also closes when the upstream audio ends and every reader has drained.
  - **Closing** aborts both upstream fetches, sends `DELETE` to the session, ends every reader and forgets the reading.
  - **Heartbeat.** Events readers get `: hb\n\n` every `EVENTS_HEARTBEAT_MS`.
  - **Logs** carry the session id, the sentence count and byte counts only.
- `AGENTS.md` states these rules, the containment rule (Task 5) and the privacy rules, with the test file that holds each.

- [ ] **Step 1: Write the failing tests** against the fake:
  - `a browser reader hears the session from its first byte`: the bytes equal the fake's frames.
  - `a second reader of the audio hears it from the first byte`.
  - `replays the timeline to a late events reader`.
  - `opening a second reading for the same person closes the first and tells its readers`: the fake marks the first session deleted, and its old events stream ends with `event: replaced`.
  - `two people read at once`.
  - `ends a reading 30 s after its last browser reader leaves`: with `configureReadingsForTests({ idleMs: 200 })`, the fake session is deleted within 600 ms and `currentReading` is `null`.
  - `stops replaying after its cap`: with `replayMaxBytes: 10_000`, `attachAudio` returns `null` once that many bytes have arrived.
  - `refuses with SpeechUnavailable when the service is down`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/server/services/read-aloud/readings.test.ts`.
- [ ] **Step 3: Implement** both modules, `index.ts` and `AGENTS.md`.
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): speech client and one replayable reading per person"`

### Task 5: The session routes

**Files:**
- Create:
  - `src/lib/server/services/read-aloud/request.ts`;
  - `src/routes/api/read-aloud/sessions/+server.ts` (POST);
  - `src/routes/api/read-aloud/sessions/[sessionId]/+server.ts` (DELETE);
  - `…/[sessionId]/audio/+server.ts`, `…/[sessionId]/events/+server.ts` and `…/[sessionId]/position/+server.ts`;
  - `src/routes/api/read-aloud/sessions/sessions.test.ts` (`// @vitest-environment node`).

**Interfaces:**
- Consumes:
  - `getReadAloudUrl` (Task 1), `defaultVoiceFor` and `sentencesFitReply` (Task 2), and the registry (Task 4);
  - `getConversation(userId, conversationId)` from `$lib/server/services/conversations`;
  - `getReplyForDocumentKeep({ conversationId, messageId })` from `$lib/server/services/messages`. It walks "Ask me first" segments back from the last one and returns the whole reply's `content`.
- Produces:
  - `readingRequestSchema`, a zod object:
    - `conversationId` and `messageId`: strings of 1–100 characters;
    - `sentences`: 1–2000 items, each `{ id: /^s\d{1,5}$/, language: "en" | "hu", tokens: 1–120 strings of 1–80 characters, paragraphStart: boolean }`;
    - a refinement: `tokens.join(" ").length ≤ 400` for every sentence.
  - `type ReadingRequest = z.infer<typeof readingRequestSchema>`.
- POST, in order:
  1. `requireApiUser`.
  2. `getReadAloudUrl() === ""` → 404 `read_aloud_off`.
  3. Parse the body → 400 `invalid_request`.
  4. Conversation not the caller's → 404 `not_found`.
  5. No reply (or not an assistant message) → 404 `not_found`.
  6. `sentencesFitReply` not null → 422 `not_in_reply`. Log only that index and the sentence count.
  7. Map each sentence to a `SpeechSentence` with `defaultVoiceFor(language)`.
  8. `openReading`. `SpeechUnavailable` → 503 `voice_unavailable`.
  9. 201 `{ sessionId, defaultSpeed: 1, charsPerSecond: { en, hu } }`, with each rate taken from that language's default voice.
- `{sessionId}` routes:
  - all of them: `requireApiUser`, then `currentReading(user.id, sessionId)` or 404 `not_found`.
  - **audio**: `attachAudio` returns `null` → 409 `already_read`. Otherwise 200 with `Content-Type: audio/mpeg`, `Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no`.
  - **events**: the take-events route's SSE headers.
  - **position**: a body of `{ sentenceId: /^s\d{1,5}$/ }`, or 400 → 204.
  - **DELETE** → 204.
  - Errors are written with `createJsonErrorResponse(code, status)`.

- [ ] **Step 1: Write the failing tests.** Mock `conversations`, `messages` and `config-store` with `vi.mock`, as `src/routes/api/artifacts/artifacts.test.ts` does, and spy on the registry.
  - `401 without a user`.
  - `404 read_aloud_off when the feature is off`.
  - `400 for a sentence of 401 characters`.
  - `404 for another person's conversation`.
  - `404 for a message that is not a reply`.
  - `422 not_in_reply, and the log line carries no reply text`: spy on `console`, then check that no logged argument contains a token.
  - `201 with Imogen for English and Berta with room.clean 2 for Hungarian`: check the arguments `openReading` received.
  - `503 voice_unavailable when the service is down`.
  - `404 for another person's session id`.
  - `the audio route streams audio/mpeg with no-store`.
  - `409 once the replay is released`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/routes/api/read-aloud`.
- [ ] **Step 3: Implement** the schema and the five routes. They stay thin adapters (`src/routes/AGENTS.md`).
- [ ] **Step 4: Run them and see them pass,** then run `npm run check`.
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): session routes with message access and containment checks"`

### Task 6: The read-aloud language detector and its documented exception

**Files:**
- Create: `src/lib/client/read-aloud/language.ts`, `language.test.ts` and `src/lib/client/read-aloud/AGENTS.md`.
- Modify:
  - `package.json`: add the dependency `"tinyld": "1.3.4"` (exact), and append `--chat-forbid tinyld` to `check:artifact-chunks`.
  - `src/lib/server/services/chat-turn/AGENTS.md`: the exception below.
  - the root `AGENTS.md` Folder Rules: `` `src/lib/client/read-aloud/` — read aloud in the browser: the speech script, marks, the reading machine and controller, its language detector. ``

**Interfaces:**
- Produces:
  - `SHORT_PARAGRAPH_LETTERS = 40`.
  - `loadDetector(): Promise<(text: string) => string>`: a cached `import("tinyld")` that returns its `detect`, which answers an ISO 639-1 code, or `""` when it cannot tell.
  - `assignLanguages(paragraphs: readonly string[], detect: (t: string) => string): string[]`:
    - a paragraph with at least 40 letters gets the detected code when the detector names one;
    - any other paragraph takes the previous paragraph's code;
    - short paragraphs that open the reply take the first named code after them;
    - when no paragraph is named, every paragraph gets `detect(paragraphs.join("\n"))`.
  - `isVoiced(code: string): code is "en" | "hu"`.
  - `languageDisplayName(code: string, ui: "en" | "hu"): string | null`.

**The exception.** Add this to `chat-turn/AGENTS.md`'s "Reply Language, Short Texts And Follow-Up Chips" section, right after invariant I4:

> - **Read aloud's detector is the one exception to "no second reader"** (owner, 2026-11-16). `src/lib/client/read-aloud/language.ts` (tinyld, in the browser) names each paragraph's language only to pick a read-aloud voice and the speech service's text rules, and to name a language that has no voice ("Read aloud isn't available in German yet"). It never feeds anything the chat decides: no model request, title, chip, record or route reads it, and nothing in `chat-turn/` imports it. The chat's readers stay `readReplyLanguage` and `readShortTextLanguage`.

**The folder's `AGENTS.md`** states five rules:
1. The script is built from the rendered DOM only, never from Markdown.
2. Marks never change the reply's DOM or layout: they are an overlay behind the text, and the prose is isolated only while it is marked.
3. Only the controller touches the `<audio>` element and the session routes; components read `readAloudView` and call the controller.
4. The iOS unlock happens synchronously in the press handler.
5. The detector exception above.

- [ ] **Step 1: Write the failing tests** with the real tinyld:
  - `names English and Hungarian paragraphs`: two paragraphs of 2–3 sentences each.
  - `names German, so the note can say so`.
  - `a short paragraph takes the language before it`: "Ingredients" after an English paragraph is `en`.
  - `a short opening paragraph takes the next named one`: "Hozzávalók" before a Hungarian paragraph is `hu`.
  - `a reply of only short paragraphs is detected as a whole`.
  - `languageDisplayName("de", "hu") === "Német"` and `languageDisplayName("de", "en") === "German"`.
  - `languageDisplayName("xx", "en") === null`.
- [ ] **Step 2: Install, run, and see them fail.** Run `npm install tinyld@1.3.4 --save-exact`, then `npx vitest run src/lib/client/read-aloud/language.test.ts`.
- [ ] **Step 3: Implement,** and write both `AGENTS.md` texts.
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): a read-aloud-only language detector, documented as the one-reader exception"`

### Task 7: The speech script

**Files:**
- Create: `src/lib/client/read-aloud/speech-script.ts` and `speech-script.test.ts`.

**Interfaces:**
- Consumes: `assignLanguages` and `isVoiced` (Task 6).
- Produces:
  - `type ScriptSentence = { id: string; index: number; language: "en" | "hu"; paragraphStart: boolean; tokens: string[]; ranges: Range[]; text: string; charStart: number; chars: number }`:
    - `text` is `tokens.join(" ")`;
    - `chars` is `text.length + 1`;
    - `charStart` is the running sum of `chars`;
    - `ranges` holds one `Range` per token.
  - `type SpeechScript = { sentences: ScriptSentence[]; totalChars: number; missingLanguage: string | null; nothingToRead: boolean }`.
  - `buildSpeechScript(roots: readonly Element[], detect: (t: string) => string): SpeechScript`. The roots are each segment's `.markdown-container`.
  - `sentenceAtPoint(script: SpeechScript, node: Node, offset: number): number | null`: the sentence holding the point, else the first one after it.
  - `SKIPPED_SELECTOR = ".code-block, pre, .markdown-diagram-block, .markdown-table-wrap, table, .markdown-frontmatter, .markdown-image-frame, img, svg, figure, button, input, a.source-link-chip, [aria-hidden='true'], script, style"`.
  - `PARAGRAPH_TAGS = ["P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "SUMMARY", "DT", "DD", "DIV", "ASIDE"]`.
  - `LONG_SENTENCE_CHARS = 300` and `MAX_TOKEN_CHARS = 80`.
- **Rules** (what the tests below do not fully determine):
  1. **Walking the DOM.** Walk text nodes in document order with a `TreeWalker`.
     - Skip any node inside `SKIPPED_SELECTOR`, and any node inside a `<details>` without `open`, except its `<summary>`.
     - A text node's paragraph is its nearest ancestor in `PARAGRAPH_TAGS`, within the root.
     - A skipped element or a `<br>` between two nodes of one paragraph counts as a space.
  2. **The spoken view keeps every offset.** Characters are replaced by spaces, never removed:
     - inside a `code` element that is not inside `pre`, every character that is not a letter or a digit;
     - emoji: `\p{Extended_Pictographic}`, regional indicators, U+200D and U+FE0F;
     - TeX runs: `$…$` holding one of `\ ^ _ { } =`, `\(…\)` and `\[…\]`.
  3. **Tokens** are the whitespace-separated runs of a paragraph's spoken view. Drop a token that:
     - has no letter or digit;
     - contains `://` or starts with `www.`;
     - matches `^\[\d+(?:\s*[,–-]\s*\d+)*\]$` (a citation marker);
     - is longer than 80 characters.

     Each kept token gets a `Range` over its own characters; it may span several text nodes.
  4. **Languages.** Run `assignLanguages` on the paragraph texts and keep only `en` and `hu` paragraphs. When none is voiced:
     - `nothingToRead` is set when no paragraph had a token;
     - otherwise `missingLanguage` is the language with the most letters.
  5. **Sentences** come from `new Intl.Segmenter(language, { granularity: "sentence" })` over the paragraph's spoken view. A token belongs to the segment that holds its first character.
  6. **Short sentences.** While a sentence has fewer than 3 tokens, it joins the next sentence of the same language, across paragraphs too.
     - When the join crosses a paragraph and the last token does not already end in one of `. ! ? , ; : …`, that token gets "." if it came from a heading and "," otherwise.
     - A sentence with no next sentence to join joins the previous one of the same language.
     - A sentence with neither stays as it is.
  7. **Long sentences.** A sentence over 300 characters splits after the last token ending in "," or ";" that keeps the first part within 300. Failing that, it splits after the last token that does. Repeat until every part fits.
  8. **Ids and flags.** Ids are `s0, s1, …` in order. `paragraphStart` is true for a sentence that begins a paragraph; a merged sentence keeps its first part's flag.

- [ ] **Step 1: Write the failing tests** (jsdom, the real `Intl.Segmenter`, and a stub `detect` keyed by paragraph text). Build DOMs shaped like `MarkdownRenderer`'s output.
  - `reads paragraphs, headings, list items, checklist items and quotes in order`.
  - `leaves out code blocks, tables, CSV, charts, Mermaid, images, front matter and source chips`.
  - `reads inline code as words and drops what is left unpronounceable`: `` `foo_bar()` `` gives `foo` and `bar`, and `` `=>` `` gives nothing.
  - `drops emoji, bare addresses, citation markers and formulas`.
  - `no syntax reaches the tokens`: no token is any of ``* _ # | ` [ ] ( ) < >`` and no token contains a backtick.
  - `keeps each token's range on its own characters`: for `<strong>bo</strong>ld`, `ranges[i].toString() === "bold"`.
  - `splits sentences with Intl.Segmenter in the paragraph's language`.
  - `merges short sentences across paragraphs with a pause mark`: a heading "Ingredients" and list items "Flour", "Water", "Salt" give one sentence with tokens `["Ingredients.", "Flour,", "Water,", "Salt"]` and `paragraphStart: true`.
  - `splits a sentence over 300 characters at a comma`: every part is at most 300 characters.
  - `skips a German paragraph, and names German when nothing is voiced`.
  - `finds the sentence holding a selection's start`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/client/read-aloud/speech-script.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): the speech script from the rendered reply"`

### Task 8: Timeline and progress

**Files:**
- Create: `src/lib/client/read-aloud/timeline.ts` and `timeline.test.ts`.

**Interfaces:**
- Consumes: `SpeechScript` (Task 7).
- Produces:
  - `SENTENCE_GAP_SECONDS = 0.3` and `PARAGRAPH_GAP_SECONDS = 0.6`.
  - `class SessionTimeline`:
    - `constructor(script: SpeechScript, firstIndex: number)`;
    - `addSentence(id: string, start: number, end: number): void`;
    - `addWords(id: string, times: Array<[number, number] | null>): void`;
    - `locate(t: number): { sentence: number; word: number | null; within: number } | null`;
    - `durations(): Map<number, number>`.
  - `notches(script): number[]`: each sentence's `charStart / totalChars`.
  - `sentenceAtShare(script, share: number): number`.
  - `shareAt(script, sentence: number, within: number): number`.
  - `estimateSeconds(script, known: Map<number, number>, charsPerSecond: Record<"en" | "hu", number>, before?: number): { seconds: number; estimate: boolean }`: the whole reading, or the time before sentence `before`.
  - `formatClock(seconds: number): string`: `m:ss`, and `h:mm:ss` from an hour on.
- **`locate` rules:**
  - The sentence is the last one in session order whose start is at or before `t`.
  - The word is the last token whose time is not `null` and starts at or before `t`. It is `null` when the sentence has no word times.
  - `within` is `(characters of the tokens before the word, plus the word's index) / chars` when a word is known. Otherwise it is `(t − start) / (end − start)`, clamped to 0…1.
  - It returns `null` before the first `sentence` event.
- **`estimateSeconds`** adds each sentence's known duration, or `chars / charsPerSecond[language]` when it is unknown, plus 0.30 s between sentences or 0.60 s before a paragraph start. `estimate` stays true while any duration is unknown.

- [ ] **Step 1: Write the failing tests:**
  - `locates the sentence and word for a time`.
  - `a sentence without word times moves by time`.
  - `notches are text shares and never move`.
  - `a pointer share maps back to its sentence`.
  - `the total is an estimate until every sentence is known, gaps included`.
  - `formats 9, 65 and 3725 seconds`: "0:09", "1:05" and "1:02:05".
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/client/read-aloud/timeline.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): timeline, text shares and time estimates"`

### Task 9: The reading machine

**Files:**
- Create: `src/lib/client/read-aloud/reading-machine.ts` and `reading-machine.test.ts`.

**Interfaces:**
- Produces:
  - `type ReadingStatus = "idle" | "opening" | "playing" | "paused" | "seeking" | "waiting" | "stopped" | "finished" | "startFailed"`.
    - `opening` is the first start: the player is not shown yet and the speaker spins.
    - `seeking` is a new session inside an open player: its play button spins and the speaker keeps its ring.
  - `type BreakKind = "offline" | "updating" | "voice"`.
  - `type ReadingState = { status; messageId: string | null; sentence: number; word: number | null; speed: number; busy: boolean; failure: BreakKind | null; restartOnResume: boolean; doneReceived: boolean; drag: { target: number; wasPlaying: boolean } | null }`.
  - `initialReadingState: ReadingState`.
  - `type ReadingTimer = "busy" | "start" | "failedSpeaker" | "longPause" | "finished"`.
  - `READING_TIMER_MS = { busy: 2500, start: 20000, failedSpeaker: 3000, longPause: 30000, finished: 1100 }`.
  - `type ReadingEvent`, with these `type`s:
    - `press {messageId, from}` and `toggle`;
    - `firstAudio`, `busyTimeout`, `startTimeout`, `sessionFailed {kind}` and `startFailedTimeout`;
    - `longPause`, `hidden`, `interrupted` and `progress {sentence, word}`;
    - `broke {kind}`, `recovered` and `retry`;
    - `seek {sentence}`, `dragStart`, `dragMove {sentence}` and `dragEnd {sentence}`;
    - `done`, `ended` and `finishedTimeout`;
    - `speed {value}`, `replaced` and `stop`.
  - `type ReadingCommand`, with these `kind`s:
    - `open {messageId, from}` and `close`;
    - `play` and `pause`;
    - `report {sentence}` and `speed {value}`;
    - `startTimer {timer}` and `clearTimer {timer}`;
    - `awaitRecovery {from: "offline" | "updating"}`.
  - `reduce(state: ReadingState, event: ReadingEvent): { state: ReadingState; commands: ReadingCommand[] }`.
  - `classifyBreak(p: { serviceError: boolean; online: boolean; health: "up" | "draining" | "proxy_down" | "unreachable" | null }): BreakKind`:
    - a service error is `voice`;
    - otherwise, being offline is `offline`;
    - otherwise, health `draining` or `proxy_down` is `updating`;
    - anything else is `voice`.
- **Transitions.** Any pair not listed leaves the state as it is and sends no command.
  - Every move to `idle` also clears all timers.
  - Every transition that sends `open` also sets `word` to null, sets `busy` and `doneReceived` to false, and starts the `start` timer, so a jump that never gets audio fails too.
  - When a timer fires, the controller dispatches its event: busy → `busyTimeout`, start → `startTimeout`, failedSpeaker → `startFailedTimeout`, longPause → `longPause`, finished → `finishedTimeout`.

| From | Event | To | Commands |
|---|---|---|---|
| idle, finished, startFailed | press | opening (messageId, sentence = from) | open; startTimer busy and start |
| opening (same message) | press or toggle | idle | close |
| opening (another message) | press | opening (new message) | open; restart the busy and start timers |
| playing, paused, seeking, waiting, stopped (another message) | press | seeking (new message, from) | open |
| playing (same message) | press or toggle | paused | pause; startTimer longPause |
| paused, `restartOnResume` false (same message) | press or toggle | playing | play; clearTimer longPause |
| paused, `restartOnResume` true (same message) | press or toggle | seeking (sentence) | open |
| paused | longPause | paused, `restartOnResume` true | close |
| stopped (same message) | retry, press or toggle | seeking (sentence) | open |
| opening, seeking | firstAudio | playing, busy false | clearTimer busy and start |
| opening | busyTimeout | opening, busy true | — |
| opening | startTimeout or sessionFailed | startFailed | close; startTimer failedSpeaker |
| startFailed | startFailedTimeout | idle | — |
| seeking | startTimeout | stopped, failure voice | close |
| seeking, playing | sessionFailed or broke (offline, updating) | waiting, failure = kind | close; awaitRecovery |
| seeking, playing | sessionFailed or broke (voice) | stopped, failure voice | close |
| waiting | recovered | seeking (sentence) | open |
| opening | hidden | idle | close |
| playing, seeking | hidden | paused, `restartOnResume` true | close |
| waiting | hidden | paused, `restartOnResume` true | — (leaving `waiting` ends the recovery watch) |
| playing | interrupted | paused | startTimer longPause |
| playing | progress | sentence and word updated | report, when the sentence changed |
| playing, seeking, stopped, waiting | seek (i) | seeking (i), word null | open |
| paused | seek (i) | paused (i), `restartOnResume` true | close |
| playing, paused, stopped | dragStart | drag = {target: sentence, wasPlaying} | pause, when playing |
| (dragging) | dragMove (i) | drag.target = i | — |
| (dragging) | dragEnd (i) | seeking (i) when it was playing or stopped, else paused (i) with `restartOnResume` | open, or close |
| any active state | done | `doneReceived` true | — |
| playing | ended | finished | startTimer finished |
| finished | finishedTimeout | idle | close |
| any | speed (v) | speed v | speed |
| any but idle | replaced, or stop | idle | close |

The controller sends `ended` only when `doneReceived` is true; an early end of the audio is classified and sent as `broke`.

- [ ] **Step 1: Write the failing tests,** each asserting the state and the exact commands:
  - `opens a reading and plays on first audio`.
  - `shows the busy note after 2.5 s`.
  - `fails to start after 20 s or when the service refuses, and the speaker settles after 3 s`.
  - `pauses and resumes in the same session`.
  - `a pause longer than 30 s restarts at the sentence start`.
  - `a hidden page pauses, and play restarts at the sentence start`.
  - `the voice stopping shows Try again, which restarts at that sentence`.
  - `offline waits, and resumes by itself`.
  - `an update waits, and resumes when the server is back`.
  - `another reply switches without closing the player`.
  - `dragging pauses, and the release reads from the chosen sentence`.
  - `the end shows Finished for 1.1 s`.
  - `a replaced reading ends quietly`.
  - `✕ stops from every state`.
  - `classifies breaks`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/client/read-aloud/reading-machine.test.ts`.
- [ ] **Step 3: Implement `reduce` and `classifyBreak`** as the table says.
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): the reading state machine with every failure of §4.8"`

### Task 10: The client API, the stores and the reading controller

**Files:**
- Create:
  - `src/lib/client/api/read-aloud.ts` and `read-aloud.test.ts`;
  - `src/lib/stores/thread-focus.ts`;
  - `src/lib/client/read-aloud/controller.ts` and `controller.test.ts`.
- Modify:
  - `src/lib/stores/read-aloud.ts`: add the view.
  - `src/lib/client/AGENTS.md` and `src/lib/stores/AGENTS.md`: list the new files.

**Interfaces:**
- Consumes: Tasks 3 (`silentMp3DataUri`), 6, 7, 8 and 9; `fetchServerHealth`; `reportServerUpdateSign`; and `SERVER_UPDATE_WATCH_POLL_MS` and `SERVER_UPDATE_WATCH_MAX_MS`.
- Produces, in `client/api/read-aloud.ts` (through `requestJson` and `requestVoid` in `api/http.ts`):
  - `type ReadingStart = { sessionId: string; defaultSpeed: number; charsPerSecond: Record<"en" | "hu", number> }`.
  - `createReadingSession(body: { conversationId: string; messageId: string; sentences: Array<{ id: string; language: "en" | "hu"; tokens: string[]; paragraphStart: boolean }> }): Promise<ReadingStart>`.
  - `cancelReadingSession(id: string): void`: a `DELETE` with `keepalive`, errors ignored.
  - `reportReadingPosition(id: string, sentenceId: string): void`, errors ignored.
  - `readingAudioUrl(id)` and `readingEventsUrl(id)`, which give `/api/read-aloud/sessions/<id>/audio` and `/events`.
- Produces, in `stores/read-aloud.ts`:
  - `type ReadAloudView = { status: ReadingStatus; messageId: string | null; segmentIds: readonly string[]; sentence: number; count: number; notches: number[]; progress: number; elapsed: string; total: string; totalIsEstimate: boolean; speed: number; failure: BreakKind | null; busy: boolean; drag: number | null; marks: { sentence: Range[]; word: Range | null; target: Range[] } | null }`.
  - `readAloudView: Readable<ReadAloudView>` and `setReadAloudView(view: ReadAloudView): void`. Only the controller calls the setter.
- Produces, in `stores/thread-focus.ts`:
  - `type ThreadFocusRequest = { seq: number; rect: () => DOMRect | null; mode: "center" | "reveal" }`.
  - `threadFocusRequest: Readable<ThreadFocusRequest | null>` and `requestThreadFocus(rect: () => DOMRect | null, mode: "center" | "reveal"): void`.
- Produces, in `controller.ts`:
  - `type StartRequest = { conversationId: string; messageId: string; segmentIds: readonly string[]; from?: { node: Node; offset: number } }`.
  - `interface ReadAloudController` with:
    - `start(r: StartRequest): void`, `toggle(): void`, `seek(i: number): void` and `retry(): void`;
    - `beginDrag(): void`, `dragTo(i: number): void` and `endDrag(i: number): void`;
    - `setSpeed(v: number): void`, `stop(): void` and `locate(): void`;
    - `sentencePreview(i: number): string`, which returns `"4/9 · <first five tokens>…"`.
  - `type Readability = { kind: "ready" } | { kind: "noVoice"; language: string | null } | { kind: "nothing" } | { kind: "unknown" }`.
  - `createReadAloudController(deps: ReadAloudDeps): ReadAloudController`.
  - `getReadAloud(): ReadAloudController`: the browser singleton, made on first use.
  - `assessReadability(segmentIds: readonly string[]): Promise<Readability>`: `unknown` while a segment's `.markdown-container` is missing or holds no text yet (Markdown renders asynchronously), so the speaker is never dimmed by mistake.
  - `ReadAloudDeps` injects the audio element, `createEventSource`, the API above, the detector loader, `document`, `window`, `fetchHealth`, timers and `now`, so the tests use fakes.
- **Controller rules:**
  - **Unlocking iOS.** `start` runs synchronously in the click handler. On the page's first press only, before anything is awaited, it sets `audio.src = silentMp3DataUri()` and calls `play()`, ignoring a refused play. Once the element has played, iOS allows its later plays. Media events are ignored while that clip plays.
  - **The `open` command:**
    - rebuild the script when it is missing or stale; the roots are each `segmentIds` id's `[data-message-id="…"] .markdown-container`;
    - send `POST` with the sentences from `from` on;
    - then set `audio.src`, `playbackRate = speed` and `preservesPitch = true`, call `play()`, create the `EventSource`, and start a new `SessionTimeline`.
  - **The default speed.** When the session of a new reading answers (one begun by `press` from `opening`, or a switch to another reply), dispatch `speed {value: answer.defaultSpeed}`. A jump inside a reading keeps its speed.
  - **The `close` command** closes the `EventSource`, runs `audio.removeAttribute("src"); audio.load()`, and cancels the session.
  - **Each animation frame while playing:** `timeline.locate(audio.currentTime)` dispatches `progress`. The view then gets:
    - `progress`, from `shareAt`;
    - `elapsed`, the session's estimated start plus `currentTime`, divided by the speed;
    - `total`, from `estimateSeconds` divided by the speed.

    In `finished` the view's `progress` is 1, so the ring and the fill are full.
  - **Events:**
    - `sentence` and `words` go into the timeline;
    - `error` dispatches `broke {kind: "voice"}`;
    - `done` dispatches `done`;
    - `replaced` dispatches `replaced`;
    - an `EventSource` error whose `readyState` is `CLOSED` is treated as a stream break.
  - **Stream breaks** (an audio `error`, or an early `ended`) are classified with `classifyBreak`. `fetchServerHealth()` is asked only when the browser is online and the service sent no error. An `updating` result calls `reportServerUpdateSign()`.
  - **The `awaitRecovery` command:**
    - for `offline`, wait for the window's `online` event;
    - for `updating`, poll health every 3 s until it is `up`, and after 8 min dispatch `broke {kind: "voice"}`.

    The window's `offline` event during a reading dispatches `broke {kind: "offline"}`.
  - **The page.** `visibilitychange` to hidden dispatches `hidden`. An audio `pause` that the controller did not ask for dispatches `interrupted`.
  - **A stale script.** On each frame, and on a `MutationObserver` over the thread:
    - when a segment's `[data-message-id]` element has gone, dispatch `stop`;
    - when the first token's node is disconnected, rebuild the script;
    - when the rebuilt sentences' texts differ, dispatch `stop`; otherwise swap in the new ranges.
  - **Focus requests.** `locate()` calls `requestThreadFocus(rect of the current sentence, "center")`, and `dragTo` calls `requestThreadFocus(rect of the target, "reveal")`.

- [ ] **Step 1: Write the failing tests.** Use a fake audio element (an `EventTarget` with `src`, `currentTime`, `play`, `pause`, `load` and `playbackRate`), a fake `EventSource`, fake timers, a stubbed API, and a jsdom reply built with `data-message-id` and `.markdown-container`.
  - `unlocks the audio element before it waits for anything`.
  - `opens a session from the pressed sentence and plays its audio`.
  - `starts from the sentence holding a selection's start`.
  - `reports the position when the sentence changes`.
  - `classifies a broken stream as offline, an update or the voice`.
  - `resumes by itself when the browser is back online`.
  - `rebuilds the script when its nodes are replaced but the text is the same`.
  - `stops when the reply being read leaves the page`.
  - `ignores media events of the unlock clip`.
  - `a replaced reading ends quietly`.
  - `pauses when the page is hidden`.
  - `createReadingSession posts the body and returns the start`: in `read-aloud.test.ts`, with a fake fetch.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/client/read-aloud/controller.test.ts src/lib/client/api/read-aloud.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): client API, view store and the reading controller"`

### Task 11: Marks

**Files:**
- Create:
  - `src/lib/client/read-aloud/line-rects.ts` and `line-rects.test.ts`;
  - `src/lib/components/read-aloud/ReadAloudMarks.svelte` and `ReadAloudMarks.test.ts`.
- Modify:
  - `src/app.css`: tokens, in both themes.
  - `src/lib/components/chat/MessageBubble.svelte`: the overlay inside `.prose-container`.

**Interfaces:**
- Consumes: `readAloudView` (Task 10).
- Produces:
  - `type Box = { left: number; top: number; width: number; height: number }`.
  - `lineBoxes(rects: readonly DOMRectReadOnly[], origin: DOMRectReadOnly, joinGapPx = 12): Box[]`. Boxes are relative to `origin`. Rects that overlap vertically by at least half their height are one line, and gaps of up to 12 px join.
  - `ReadAloudMarks` props: `{ replyLastId: string; container: HTMLElement | null; onMarkedChange: (marked: boolean) => void }`.
- **Tokens** (`app.css`):

  | Token | Light (`:root`) | Dark (`.dark`) |
  |---|---|---|
  | `--read-aloud-sentence` | `color-mix(in srgb, var(--accent) 12%, transparent)` | the same at 18% |
  | `--read-aloud-word` | the same at 30% | 36% |
  | `--read-aloud-target` | 22% | 28% |
  | `--read-aloud-target-edge` | 45% | 55% |
  | `--read-aloud-chip-bg` | `#1a1a1a` | `#f2f2f0` |
  | `--read-aloud-chip-fg` | `#fff` | `#1a1a1a` |

- **Behaviour:**
  - **Placement.** The overlay is `div.read-aloud-marks`: `position: absolute; inset: 0; z-index: -1; pointer-events: none`.
    - `MessageBubble` gives `.prose-container` `data-read-aloud-marked` while `onMarkedChange(true)`.
    - CSS: `.prose-container[data-read-aloud-marked] { position: relative; isolation: isolate; }`. The marks then paint behind the text, inside the message, and never over the composer layer.
  - **Which ranges.** Only ranges inside its own `container` are drawn, so each segment of a segmented reply marks its own part.
  - **The sentence.** Its boxes sit in a `{#key view.sentence}` group with a 150 ms fade (`reducedMotionAware`), which gives the crossfade. In `stopped` and `waiting` the tint stays and the word marker hides.
  - **The word marker** is one div moved by `transform` and `width`, with `transition: transform 90ms linear, width 90ms linear`. It gets a `jump` class, with no slide, when its top changes by more than 2 px.
  - **While dragging,** the target sentence's boxes take `--read-aloud-target` with `box-shadow: 0 0 0 1px var(--read-aloud-target-edge)`, and the reading tint and the word marker hide.
  - **Updates.** Boxes are recomputed on a `ResizeObserver` of the container and whenever the view changes. At the end they fade out over 150 ms, then `onMarkedChange(false)`.

- [ ] **Step 1: Write the failing tests.** Stub `Range.prototype.getClientRects` and `getBoundingClientRect`.
  - `joins a line's word rects into one box`.
  - `draws the sentence in boxes behind the text`: the class, `z-index: -1` and the box geometry.
  - `the word marker jumps without sliding to a new line`.
  - `draws only the ranges inside its own segment`.
  - `isolates the prose only while it is marked`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/client/read-aloud/line-rects.test.ts src/lib/components/read-aloud/ReadAloudMarks.test.ts`.
- [ ] **Step 3: Implement,** and mount the marks in `MessageBubble`'s `.prose-container` with `bind:this` as `$state`.
- [ ] **Step 4: Run them and see them pass,** then run `npx vitest run src/lib/components/chat/MessageBubble.test.ts`.
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): sentence and word marks behind the text, with no reflow"`

### Task 12: The speaker

**Files:**
- Create:
  - `src/lib/i18n/read-aloud.ts`, holding every `readAloud.*` key from Copy;
  - `src/lib/components/read-aloud/ReadAloudNote.svelte`;
  - `src/lib/components/read-aloud/ReadAloudSpeaker.svelte` and `ReadAloudSpeaker.test.ts`.
- Modify:
  - `src/lib/i18n/index.ts`: spread the new dictionary into both `en` and `hu`.
  - `src/app.css`: move `.mini-spinner` here as a global rule, with its keyframes renamed `mini-spinner-spin`, and remove it from `MessageBubble.svelte`, whose fork and keep buttons use the global one.
  - `src/lib/components/chat/reply-segments.ts` and `reply-segments.test.ts`: add `segmentIds: string[]` to `ReplyPlace`, every row of the reply from first to last, on every row.
  - `src/lib/components/chat/MessageBubble.svelte`: the speaker and the pinned row.

**Interfaces:**
- Consumes: `getReadAloud`, `assessReadability` and `readAloudView` (Task 10); `readAloudAvailable` (Task 1); `languageDisplayName` (Task 6).
- Produces:
  - `ReadAloudNote` props: `{ tone: "calm" | "warn"; icon: "alert" | "clock" | "wifi"; text: string; actionLabel?: string; onAction?: () => void; onDismiss?: () => void; placement: "speaker" | "player" }`. It renders `role="status"`.
  - `ReadAloudSpeaker` props: `{ conversationId: string; messageId: string; segmentIds: readonly string[]; contentKey: string; onPinnedChange: (pinned: boolean) => void; controller?: ReadAloudController }`.
  - `MessageBubble`:
    - renders `{#if !isUser && $readAloudAvailable}<ReadAloudSpeaker …/>{/if}` right after Copy's `action-tooltip-container`, with `segmentIds={replyPlace?.segmentIds ?? [message.id]}` and `contentKey={replyText}`;
    - gives `.message-actions` the `data-pinned` attribute while the speaker reports pinned, with this CSS: `@media (hover: hover) { .message-actions[data-pinned] { opacity: 1; } }`.
- **Faces:** a 15 px `Volume2` in the same button class as Copy (`btn-icon-bare action-icon-btn`).

  | View | Face |
  |---|---|
  | `opening` | the global `mini-spinner` |
  | `playing` | a 12 px `Pause` inside the ring |
  | `paused`, `seeking`, `waiting`, `stopped` | a 12 px `Play` inside the ring |
  | `startFailed` | `VolumeX` in `--warning-text` |
  | dimmed | `Volume2` at `opacity: .38`, with `aria-disabled="true"` |

  - The ring is an SVG circle with `r = 11.5`, `stroke-width = 1.6` and `stroke-dasharray = 72.26`; its offset is `72.26 × (1 − progress)`.
  - `aria-label` is `speaker.read`, `speaker.pause` or `speaker.resume`, following the face.
- **Readability** is assessed when the button first intersects the viewport (in an idle callback), and again when `contentKey` changes.
  - `noVoice` and `nothing` dim the speaker.
  - Their note shows on hover or focus, and on tap with a coarse pointer. A tap's note closes when the person clicks elsewhere.
- **Notes,** anchored above the speaker:
  - the busy note (calm, `Clock`) while the view is `busy`;
  - the can't-start note (warn, `CircleAlert`, Try again and ✕). It closes on ✕, on a click elsewhere, or after 8000 ms, while the speaker returns to normal after 3000 ms.
- **Pinned** means the reply is being read or one of its notes is open.

- [ ] **Step 1: Write the failing tests:**
  - `shows the speaker after Copy only on a finished reply when read aloud is on`: write this case in `MessageBubble.test.ts`.
  - `starts reading on press and shows the spinner`.
  - `shows the ring and pause while reading`.
  - `dims with a note naming the language`: with readability stubbed to `noVoice("de")` and the UI in English, the note reads "Read aloud isn't available in German yet."
  - `the Hungarian note names the language`: "Német nyelvű felolvasás még nem érhető el."
  - `dims a reply with nothing to read`.
  - `shows the busy note`.
  - `shows the can't-start note with Try again, which closes after 8 s`.
  - `a reply drawn in segments reads from its last segment with every segment's id`: write this case in `reply-segments.test.ts` and `MessageBubble.test.ts`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/components/read-aloud src/lib/components/chat/MessageBubble.test.ts src/lib/components/chat/reply-segments.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass,** then run `npx vitest run src/lib/i18n` to hold both languages.
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): the speaker on finished replies, with its states and notes"`

### Task 13: The scrubber and the speed menu

**Files:**
- Create:
  - `src/lib/components/read-aloud/ReadAloudScrubber.svelte` and its test;
  - `src/lib/components/read-aloud/ReadAloudSpeedMenu.svelte` and its test.

**Interfaces:**
- Consumes: `sentenceAtShare` (Task 8).
- Produces:
  - `ReadAloudScrubber` props: `{ notches: number[]; progress: number; sentence: number; count: number; disabled: boolean; preview: (i: number) => string; onDragStart: () => void; onDragMove: (i: number) => void; onDragEnd: (i: number) => void; onStep: (i: number) => void }`.
  - `ReadAloudSpeedMenu` props: `{ speed: number; onSelect: (v: number) => void }`.
- **The scrubber:**
  - **Semantics.** It is `role="slider"` with `aria-valuemin=1`, `aria-valuemax={count}`, `aria-valuenow={sentence + 1}`, `aria-valuetext` from `scrubber.value`, `aria-label` from `scrubber.label` and `tabindex=0`.
  - **Keys.** ← and → call `onStep(sentence ∓ 1)`, and Home and End call `onStep(0)` and `onStep(count − 1)`.
  - **Pointer.** On `pointerdown` it takes pointer capture and calls `onDragStart`. Moves are coalesced per animation frame:
    - the handle and the fill follow the pointer exactly;
    - the landing notch lights up;
    - `onDragMove` is called with `sentenceAtShare`;
    - the dark bubble (`--read-aloud-chip-bg`) shows `preview(i)`, kept 6 px inside the player's edges.
  - **Release.** On `pointerup` it calls `onDragEnd`, and the handle glides onto the notch (`--duration-emphasis`, `--ease-emphasis`). A tap is a press and release in one place.
  - **Sizes.** `touch-action: none`. The track is 4 px, a notch is 2 × 10 px and grows to 2 × 16 px when lit, and the handle is a 16 px circle that scales to 1.3 while dragged.
- **The speed menu:**
  - The chip shows the speed formatted as in Copy.
  - It opens a `role="menu"` above the chip with six `menuitemradio` items carrying `aria-checked`.
  - ↑ and ↓ move between items, Enter picks one, and Esc or a click outside closes the menu and gives focus back to the chip.

- [ ] **Step 1: Write the failing tests:**
  - `places a notch at each sentence's text share`.
  - `steps with the arrows and jumps with Home and End`.
  - `a drag reports the sentence under the pointer and lands on its notch`.
  - `a tap jumps like a drag`.
  - `the bubble says "4/9 · …"`.
  - `the menu offers six speeds, checks the current one and picks with the keyboard`.
  - `writes 1.25 as "1,25×" in Hungarian`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/components/read-aloud`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): sentence scrubber and speed menu"`

### Task 14: The player in the composer layer

**Files:**
- Create:
  - `src/lib/components/read-aloud/ReadAloudPlayer.svelte` and its test;
  - `src/lib/utils/damped-follow.ts` and its test.
- Modify:
  - `ChatComposerPanel.svelte` and `ChatComposerPanel.test.ts`;
  - `MessageInput.svelte`;
  - `MessageArea.svelte` and `MessageArea.test.ts`.

**Interfaces:**
- Consumes: Tasks 10, 12 and 13.
- Produces:
  - `ReadAloudPlayer` props: `{ conversationId: string; hushed: boolean; controller?: ReadAloudController }`. It calls `controller.stop()` when `conversationId` changes and when it is destroyed.
  - `MessageInput`: a new prop `onCommandTrayChange?: (open: boolean) => void`, fired from an effect on `showCommandTray && !commandTrayClosing`.
  - `DAMPED_FOLLOW_TAU_MS = 90`.
  - `createDampedFollow(io: { read(): number; write(top: number): void; reducedMotion(): boolean; frame?: (cb: (now: number) => void) => number; cancelFrame?: (id: number) => void }): { aim(top: number): void; stop(): void; isActive(): boolean }`:
    - each frame, `pos += (target − pos) × (1 − e^(−dt/90))`, with `dt` capped at 64 ms;
    - it lands, and stops, within 0.5 px;
    - `aim` during a flight retargets the same loop;
    - under reduced motion it writes the target at once.
- **The slot.** `ChatComposerPanel` renders, while `$readAloudAvailable`, between `{@render children?.()}` and `.composer-box`, `<ReadAloudPlayer conversationId={conversationId} hushed={commandTrayOpen} />`.
  - The player's root is the slot: `display: grid; grid-template-rows: 0fr; margin-top: -0.75rem; transition: grid-template-rows var(--duration-emphasis) var(--ease-emphasis)`, with `[data-open] { grid-template-rows: 1fr }`.
  - The negative margin cancels the shell's `gap-3`, so a closed slot moves nothing.
  - Its inner element has `overflow: hidden` until the opening ends (`data-settled`), and `visible` after, so the notes above the player are not clipped.
- **The backdrop.** `.composer-shell` gets `position: relative; isolation: isolate`, and, while the view is not `idle`, `data-reading`.
  - `.composer-shell::before`: `top: -20px`, the bottom covering the layer's bottom padding, `z-index: -1`, `background: linear-gradient(to bottom, transparent 0, var(--surface-page) 20px)`, and an opacity transition (`--duration-emphasis`, `--ease-emphasis`).
- **The pill:**
  - `width: min(620px, 100%)`, radius 28 px and padding 6 px 10 px;
  - the elevated surface with a `--shadow-md`;
  - entering: it rises 8 px and fades in over 250 ms (emphasis);
  - leaving: it sinks 6 px and fades over 150 ms (`--ease-in`), then the slot closes;
  - hushed: `opacity: 0; pointer-events: none` over 100 ms, keeping its room.
- **Layouts.** The DOM order is the desktop order: ⏮ ▶/❚❚ ⏭, then the time, the scrubber and the total, then ⌖, the speed chip and ✕.
  - **Desktop:** buttons are 40 px with 6 px gaps; play and pause is a 40 px circle with the accent at 14% and an accent icon.
  - **Phone,** at 767 px and below: a grid with the scrubber row (elapsed, scrubber, total) on top, and the speed chip, ⏮ ▶ ⏭, then ⌖ ✕ below. Buttons are 44 px, play and pause a 52 px circle, and the radius is 24 px.
  - **Times** are monospace with tabular figures. The total is "≈m:ss" while it is an estimate.
- **The parts:**
  - **Play.** Its face follows the view:
    - `playing` shows `Pause`;
    - `paused` shows `Play`;
    - `seeking` and `waiting` show a spinner, with `aria-label` `player.waiting`;
    - `stopped` shows `RotateCcw`, with `--warning-tint` and `--warning-text`.
  - **The other buttons.** ⏮ and ⏭ call `seek(sentence ∓ 1)`. ⌖ calls `locate()` and ✕ calls `stop()`.
  - **Notes** sit above the pill, through `ReadAloudNote`:
    - `stopped` shows `note.stopped` with Try again, and the pill's border turns `color-mix(in srgb, var(--warning) 35%, var(--border-subtle))`;
    - `waiting` shows `note.offline` or `note.updating` without Try again.
  - **"Finished"** covers the pill while the view is `finished`.
- **Wiring.** Play and pause call `toggle()`, and Try again calls `retry()`. The scrubber's callbacks call `beginDrag`, `dragTo`, `endDrag` and `seek`; its `preview` is `sentencePreview`. The scrubber, ⏮ and ⏭ are disabled while the view is `waiting`, as in the prototype.
- **Focus requests in `MessageArea`.** It subscribes to `threadFocusRequest`. For each request it:
  1. releases the held position, stops the bottom glide, and sets `shouldAutoScroll = false`;
  2. finds the target `scrollTop`, which puts the rect's centre in the middle of `clientHeight − composerHeight`. With `"reveal"` it acts only when the rect lies outside that area;
  3. clamps the target, and aims one `createDampedFollow`.

  The reader's own press, key, wheel or touch stops the follow; add it to `readerTakesOver`.
- **A reader at the bottom follows the player down** (spec §4.3, "Following"). Nothing in `MessageArea` does this today, and pressing the speaker releases the held position.
  - Add an effect on `composerHeight` that remembers the previous height and the distance to the bottom before the change.
  - When the height grows and the reader was within `AUTO_SCROLL_EDGE_PX` of the bottom, move `scrollTop` down by the growth at once.
  - It runs on every height step as the slot opens, so the thread makes room frame by frame and nothing hides behind the player.

- [ ] **Step 1: Write the failing tests:**
  - `damped-follow`:
    - `follows a moving target in one loop`;
    - `lands within half a pixel`;
    - `writes at once under reduced motion`.
  - `ReadAloudPlayer`:
    - `opens its slot when a reading starts and closes it after ✕`;
    - `play shows the spinner while seeking or waiting`;
    - `stopped shows Try again and the amber edge`;
    - `shows the offline and the update notes without Try again`;
    - `shows Finished`;
    - `hushed keeps its room and hides it`;
    - `stops when the chat changes`.
  - `ChatComposerPanel`: `hushes the player while the command tray is open`, and `draws the backdrop only while reading`.
  - `MessageArea`: `centres a focus request above the composer`, `a reveal request leaves a visible sentence alone`, and `a reader at the bottom follows the player down` (a reader scrolled up stays where they are).
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/utils/damped-follow.test.ts src/lib/components/read-aloud "src/routes/(app)/chat/[conversationId]/_components/ChatComposerPanel.test.ts" src/lib/components/chat/MessageArea.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass,** then run `npm run check`.
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): the floating player above the composer, with locate and damped follow"`

### Task 15: Read from here

**Files:**
- Create: `src/lib/components/read-aloud/ReadFromHere.svelte` and its test.
- Modify:
  - `MessageArea.svelte`: mount it once.
  - `MessageBubble.svelte`: put `data-read-aloud-segments={segmentIds.join(" ")}` on `.message-body` of assistant rows.

**Interfaces:**
- Consumes: `getReadAloud`, `assessReadability` and `sentenceAtPoint` (via the controller's `start({ from })`).
- Produces: `ReadFromHere` props: `{ conversationId: string | null; composerHeight: number; controller?: ReadAloudController }`.
- **Behaviour:**
  - **When it exists.** It renders only while `$readAloudAvailable`.
  - **Watching the selection.** On `selectionchange` (coalesced per animation frame), a selection that is not collapsed and starts inside a `.markdown-container` of an element with `data-read-aloud-segments`, in a reply whose readability is `ready`, shows the pill.
  - **The pill** is portaled to the body with `portalToBody`, `position: fixed`, and never moves a word.
    - It sits 8 px above the selection's first rect; with a coarse pointer it sits 8 px below its last rect.
    - It is clamped 16 px inside the viewport, and above `window.innerHeight − composerHeight`.
    - It is dark (`--read-aloud-chip-bg`), shows "▶ Read from here" (`Play` and `readFromHere`), and keeps the last selection that was not collapsed.
  - **A press** calls `start({ messageId: last segment id, segmentIds, conversationId, from: { node, offset } })` inside the handler, then clears the selection.

- [ ] **Step 1: Write the failing tests:**
  - `shows the pill for a selection in a readable reply`.
  - `shows nothing for a selection outside replies`.
  - `sits above on a fine pointer and below on a coarse one`.
  - `starts reading at the selection's sentence`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): Read from here on a selection"`

### Task 16: End to end on the fake, and the final checks

**Files:**
- Create:
  - `tests/e2e/read-aloud-helpers.ts`;
  - `tests/e2e/read-aloud.spec.ts`;
  - `tests/e2e/read-aloud-failures.spec.ts`.
- Modify: `tests/AGENTS.md`, adding a "Where to Look" row.

**Interfaces:**
- Consumes: `createFakeSpeechService` (Task 3), and `clearAdminConfig`, `setDraining`, `expectTopmost`, `waitForMotionToSettle` and `login` from `tests/e2e/helpers.ts`.
- Produces, in the helpers:
  - `startFakeSpeechForSpec(page, options?): Promise<FakeSpeechService>`: makes the fake, then `PUT /api/admin/config {TTS_ENABLED: "true", TTS_URL: fake.baseUrl}`.
  - `stopFakeSpeechForSpec(page, fake)`: `clearAdminConfig(page, ["TTS_ENABLED", "TTS_URL"])`, then `fake.close()`.
  - `seedReadAloudChat(id, replies: string[]): Promise<void>`: inserts a conversation for `admin@local`, with a user message before each assistant reply, through `db`, as `context-ring-helpers.ts` does.
  - The fixture replies:
    - a three-sentence English reply;
    - a two-sentence English reply;
    - a German reply;
    - a "syntax" reply with a heading, bold, a link, inline code, a fenced code block holding `const secretCode = 42;`, a table holding `TABLECELL`, a checklist, a quote, an emoji and a bare URL.

- [ ] **Step 1: Write `read-aloud.spec.ts`,** with `secondsPerChar: 0.02`:
  - `@smoke the speaker reads a reply: the player rises and the tint moves`: wait until the second sentence's tint shows.
  - `no syntax reaches the voice`: no recorded token contains any of `*`, `` ` ``, `#`, `|`, `[`, `]`, `http` or `www.`, and none is `secretCode` or `TABLECELL`.
  - `✕ stops, and the end shows Finished`.
  - `a slash command hushes the player, and reading goes on`.
  - `another reply's speaker switches without the player leaving`.
  - `the scrubber jumps to a sentence, and the arrows step`: check the fake's recorded session starts at the expected `s<n>`.
  - `marks never move the text and never cover the player`: a word's bounding box is the same before and while reading, and `expectTopmost(player, { probe: "center" })` passes.
  - `a German reply's speaker is dimmed with a note`.
  - `Read from here starts at the selected sentence`.
  - `the phone layout`: at 390 × 844 the player has two rows, buttons are 44 px and play is 52 px.
  - `reduced motion: the player appears without moving`: under `emulateMedia({ reducedMotion: "reduce" })`, the pill's computed transitions are ≤ 0.01 ms.
- [ ] **Step 2: Write `read-aloud-failures.spec.ts`:**
  - `the voice is busy: the note shows after 2.5 s`: `firstAudioDelayMs: 4000`.
  - `it can't start: the crossed speaker and Try again`: `refuseSessions`.
  - `it stops while reading: an amber player, and Try again resumes`: `failAtSentence: 1`, cleared with `setOptions({})` before Try again.
  - `the connection drops: the offline note, then the resume`: `context.setOffline(true)` then `false`.
  - `AlfyAI updates: the note, then the resume`: `setDraining(page, true)` with `cutAtSentence: 1`; clear the cut, then `setDraining(page, false)`. `afterEach` puts the drain back.
  - `word timing fails: the tint without the word marker`: `wordTimes: "null"`.
  - `switched off: no speaker anywhere`.
- [ ] **Step 3: Build, and run them until they pass.**
  - `npm run build`
  - `E2E_PORT=<port> E2E_WORKERS=2 npx playwright test tests/e2e/read-aloud.spec.ts tests/e2e/read-aloud-failures.spec.ts`

  A flake is a bug to find, never a retry (`tests/AGENTS.md`).
- [ ] **Step 4: Run the gate.** `scripts/gates.sh agent "$TMPDIR/alfyai-gates" --port <base> tests/e2e/read-aloud.spec.ts tests/e2e/read-aloud-failures.spec.ts`. Expected: every step is 0, Fallow has no new finding, and the build has no warning.
- [ ] **Step 5: Check iOS Safari in the Simulator.**
  1. Run `npx tsx scripts/run-fake-speech-service.ts --port 1929` and `npm run dev`, and set `TTS_URL=http://127.0.0.1:1929` and `TTS_ENABLED=true` in the System pane.
  2. In the iOS Simulator's Safari, press a speaker. Expect audio to play, the marks to move, the scrubber to work, and the page to pause when Safari goes to the background.
  3. Read the app's log for the number of audio GETs per session; Safari's range probe should be served by the replay.
  4. Repeat the press-and-listen check once in desktop Firefox, for Gecko's handling of the progressive MP3 (the family's Android Firefox).
  5. If Plan 1's real service runs on the Mac (`127.0.0.1:1920`), repeat the check against it once.
- [ ] **Step 6: Commit.** `git commit -m "test(read-aloud): end-to-end specs on the fake speech service"`

---

## Hand-over to Plans 3 and 4

- **Plan 3:**
  - The person's voice choice replaces `defaultVoiceFor` in the session route.
  - Their Default speed fills `defaultSpeed`.
  - The voice editor's preview reuses `ReadAloudPlayer` and `ReadAloudScrubber`.
- **Plan 4:**
  - **Voices.** Replace Berta's and Imre's placeholder ids in `voices.ts` (`PENDING_SPEAKER_ID_PREFIX` must be gone), and measure `charsPerSecond` on the box.
  - **Apache.** In both vhosts, add `^/api/read-aloud/sessions/[^/]+/(audio|events)` to the unbuffered streaming routes: a `ProxyPass … flushpackets=on` line before the catch-all, and the `LocationMatch` alternative. The project memory note `alfyroot-apache-alfyai-vhosts` explains how; mirror the change in `deploy/apache-site.conf`.
  - **Paperwork.** The Feature Guide entry, with its drawing and a Show me marker on the speaker; ADR-0070; and the owner's checks on staging.
