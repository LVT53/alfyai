# Read Aloud — Plan 2 of 4: Reading in the Chat

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A speaker on every finished reply reads it aloud through Plan 1's speech service, with sentence and word marks, a floating player with a sentence scrubber, every failure state of spec §4.8, and Read from here, all built and tested against a fake of Plan 1's HTTP contract.

**Architecture:**
- **The browser** builds a *speech script* from the rendered reply: paragraphs, then sentences, then written words, each word with its DOM `Range` and the tokens it is spoken as. A shared reading dictionary gives those tokens (code read the way a teacher says it; spoken forms for addresses, abbreviations, symbols, shortcuts and versions), and a lazily loaded tinyld detector names each paragraph's language.
- **A new session route** checks that the person owns the conversation, that every written word occurs in the reply's text in order, and that its tokens are the shared dictionary's reading of it. It resolves the built-in voices, opens a session on the speech service, and becomes that session's only reader. It keeps a bounded in-memory replay of the session's MP3 and timeline, so any number of browser requests can attach.
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
- **Spoken forms** come only from `src/lib/shared/read-aloud/spoken-forms.ts` and its data module `reading-dictionary.ts` (Task 0). The browser builds every token with them, and the session route checks every token with them, so the two cannot disagree.
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
2. **A reply with nothing readable** (only long code blocks, a table or a chart): the speaker is dimmed with the note "Nothing in this reply can be read aloud." Read from here inside a code block still reads it (spec §4.4).
3. **The app server is the speech service's only reader.**
   - It keeps up to 8 MB of a session's MP3 (about 8.7 min), and the session's whole timeline, in memory.
   - So a browser that asks twice still hears the stream from its first byte. Safari probes media with a range request before its real one.
   - It is all dropped when the reading ends.
4. **A pause longer than 30 s ends the session.** Play then restarts at the start of that sentence, as after a hidden page.
5. **Player times are listening times** (divided by the speed), as in the prototype.
6. **Speaking rates for the estimate:** 15 characters per second in both languages, until Plan 4 measures each voice. The box measured 14.5–16 for Hungarian text at the default Pace.
7. **Short sentences across paragraphs.** When a one- or two-word sentence joins one in the next paragraph or code line, its last token gets "." after a heading and "," after anything else, so headings, lists and code lines keep their pause.
8. **A reading replaced by one in another tab ends quietly,** with no error note.
9. **Long sentences split at 240 characters,** as the refined spec now says too. The box measurements of 2026-11-16 (the project memory note `alfyai-read-aloud-aligner-on-box-2026-11-16`) found that every clip then stays under 30 s at any Pace, and the aligner stays out of its long-form mode.
10. **The containment check matches written words in order, not whole sentences.**
    - For each word of the request, the route finds its letters in the reply's text after the previous word's. A skipped formula, emoji, hash or citation inside a sentence then leaves only a gap.
    - It recomputes every word's tokens with the shared dictionary, so nothing outside the reply, or outside the dictionary's reading of it, can be spoken. Spec §6.1's "letters occur in that message's text in order" holds word by word.
    - List numbers are not searched: the renderer numbers a list, and Markdown may write "1." for every item.
11. **The Hungarian spoken forms are the plan's spelling.**
    - The spec gives English forms for the code words, acronyms and shortcuts. Its Hungarian forms cover only "." ("pont"), the prose symbols and the abbreviations.
    - The plan writes the rest the way a Hungarian teacher says them, spelled for the Hungarian voice ("print lájn", "dzséjszon", "á pé í", "kontrol C"), or as Hungarian words where Hungarians use them ("függvény", "hossz", "csillag"). They want the owner's ear once (Task 16, Step 5).
    - The spec reads `WriteLine` as "print line". The plan pins that, though "write line" may be what was meant.
    - An acronym written in capitals is read the same way in prose ("JSON" is "Jason"). Lower-case prose words are left alone (the Hungarian word "api").
12. **Numbers stay with the speech service, except two kinds.**
    - A word that starts with a digit ("20%", "20°C", "3×4"), a unit with a superscript ("m²") and a version's digits ("v2.3.1" is sent as "version 2.3.1") go as written, for the service's text clean-up (§4.4).
    - List numbers are written as words ("One.", "Egy."), because a Hungarian "1." is an ordinal.
    - Whole numbers up to 99 in code are written as words ("x equals two"), because the service's Hungarian "két" rule would turn `2 * 3` into "két csillag három".
13. **A heading's pause is the paragraph gap.**
    - A heading ends with a full stop, and the text after it starts a paragraph, so 0.60 s follows it: twice the gap between sentences.
    - A short heading joined to the next sentence (Decision 7) pauses at its full stop instead.
    - A longer pause than between paragraphs would need a per-sentence pause in Plan 1's contract. It is not asked for unless the owner wants it.
14. **Comparison and arithmetic symbols stay silent,** as the spec says ("any other symbol is dropped"), so `if x < 10` reads "if x 10". Each of `<`, `>`, `<=`, `>=`, `+`, `-` and `!` would be one row of the dictionary ("less than", "kisebb mint", …) if the owner wants them read.

## Review Focus

1. **A harmless re-render of the reply being read** (evidence loading, a theme switch) replaces the script's text nodes. The reading must go on, not stop. Test: `rebuilds the script when its nodes are replaced but the text is the same` (Task 10).
2. **A reply with links, images, HTML entities, inline code, a bare address and "Ask me first" segments:** the containment check must accept every word and spoken form the browser builds from it, or the reading never starts. Test: `accepts what the browser reads from a reply with links, images, entities, inline code and a bare address` (Task 2).
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
| `…/read-aloud/containment.ts` | The containment check: the request's written words in the reply's text in order, their tokens recomputed with the dictionary |
| `…/read-aloud/request.ts` | The zod schema of a session request |
| `…/read-aloud/speech-client.ts` | HTTP calls to the speech service (Plan 1's contract) |
| `…/read-aloud/readings.ts` | The registry: one reading per person, replay of audio and events, idle end |
| `…/read-aloud/index.ts` | The service's public surface for routes |
| `…/read-aloud/testing/fake-speech-service.ts` | A loopback fake of Plan 1's contract (Node built-ins only) |
| `src/lib/shared/read-aloud/silent-mp3.ts` | Silent MP3 frames: the fake's audio and the browser's iOS unlock clip |
| `src/lib/shared/read-aloud/reading-dictionary.ts` | The reading dictionary, data only: code symbols and words, acronyms, prose abbreviations and symbols, shortcut keys and number words, in English and Hungarian |
| `src/lib/shared/read-aloud/spoken-forms.ts` | `speakWord` and the rules that apply the dictionary: the speech script builds tokens with it, and the containment check verifies them with it |
| `scripts/run-fake-speech-service.ts` | Runs the fake on a port, for manual checks |
| `src/routes/api/read-aloud/sessions/**` | The five session routes |
| `src/lib/client/read-aloud/AGENTS.md` | Browser rules: DOM-only script, marks never reflow, the controller owns audio, the detector exception, spoken forms only from the dictionary |
| `src/lib/client/read-aloud/language.ts` | The read-aloud language detector (tinyld) and language names |
| `src/lib/client/read-aloud/speech-script.ts` | DOM to sentences, written words and their tokens, each word with its range, under every §4.4 rule |
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
- `MessageBubble.svelte`, `reply-segments.ts`, `MessageArea.svelte`, `MessageInput.svelte`, `ChatComposerPanel.svelte` and `CodeBlock.svelte`;
- `(app)/+layout.svelte` and `app.css`;
- `i18n/index.ts` and `i18n/settings.ts`;
- `package.json` and `.fallowrc.json`;
- `README.md` and `.env.example`;
- `chat-turn/AGENTS.md`, `services/AGENTS.md`, `client/AGENTS.md`, `stores/AGENTS.md`, `tests/AGENTS.md` and the root `AGENTS.md`.

## The browser ↔ app contract

```
POST   /api/read-aloud/sessions
       body {conversationId, messageId, sentences: [{id: "s<n>", language: "en"|"hu", paragraphStart: bool,
             words: [{shown: str, kind: "prose"|"code"|"shell"|"listNumber", tokens: [str]}]}]}
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

### Task 0: The reading dictionary

Spec §4.4, as the owner refined it on 2026-11-16: how code, addresses, abbreviations, symbols, shortcuts, versions and list numbers are spoken. It comes first because the containment check (Task 2) and the speech script (Task 7) both use it.

**Files:**
- Create in `src/lib/shared/read-aloud/`: `reading-dictionary.ts` (data only), `spoken-forms.ts` and `spoken-forms.test.ts`.

**Interfaces:**
- Produces, in `spoken-forms.ts` (no DOM or Node APIs, since the browser and the server both import it):
  - `type WordKind = "prose" | "code" | "shell" | "listNumber"`, and an internal `type ReadingLanguage = "en" | "hu"`.
  - `speakWord(shown: string, kind: WordKind, language: ReadingLanguage): string[]`: the tokens one written word (a run with no whitespace) is spoken as, or `[]` when it is not spoken.
    - Every token is 1–80 characters with no whitespace.
    - A word whose reading would pass 40 tokens or 160 characters gives `[]`.
  - `isSeparator(shown: string): boolean`: an arrow or a separator dot between items in prose: `→`, `⇒`, `⟶`, `->`, `=>`, `·`, `•` or `∙`.
  - `keepsSentenceOpen(before: string, language: ReadingLanguage): boolean`: true when `before` ends in a digit and a period ("16.") or in one of that language's abbreviations below, as a whole word, written as listed or with a capital first letter ("pl.", "Pl.", "e.g."). `before` is the text up to a sentence boundary, its trailing spaces ignored.
  - `codeKindOf(blockLanguage: string, firstWord: string): "code" | "shell"`. It answers `shell`:
    - for a block in `sh`, `bash`, `zsh`, `shell`, `console`, `fish`, `powershell` or `ps1`;
    - when `blockLanguage` is `""` (inline code, or a block with no language) and `firstWord` is one of the dictionary's shell commands: `ls cd cat grep echo sudo git npm npx curl ssh mkdir rm cp mv find chmod chown tail head docker systemctl export source sed awk tar pip`.
- Produces, in `reading-dictionary.ts`: the tables below as plain data, every spoken form as `{ en: string; hu: string }`. Only `spoken-forms.ts` imports it.

**The dictionary.**
- The English forms are the spec's. The Hungarian ones the spec does not give are the plan's (Decision 11).
- A form of several words becomes several tokens.

| Code symbol (longest match first) | English | Hungarian |
|---|---|---|
| `.` | dot | pont |
| `::` | double colon | dupla kettőspont |
| `:=` | colon equals | kettőspont egyenlő |
| `->`, `=>` | arrow | nyíl |
| `=`, `==`, `===` | equals, double equals, triple equals | egyenlő, dupla egyenlő, tripla egyenlő |
| `!=` | not equals | nem egyenlő |
| `&&`, `\|\|` | and, or | és, vagy |
| `\|`, only in `shell` | pipe | pájp |
| `*` | star | csillag |
| `/`, only in a path | slash | per |
| `~`, in `shell` or at a path's start | home | hóm |
| `<T>`, as in `List<T>` | of T: "List of T" | T típusú: "List T típusú" |
| `<div>`, `</div>` | div tag, closing div tag | div tag, záró div tag |

| Code word (a whole name, any case) | English | Hungarian |
|---|---|---|
| `println`, `WriteLine` | print line | print lájn |
| `printf` | print f | print ef |
| `def` | define | definiál |
| `elif` | else if | elsz if |
| `__init__`, and any `__name__` | dunder init | dander init |
| `kwargs` | keyword args | kulcsszavas argumentumok |
| `len` | length | hossz |
| `NaN` | not a number | nem szám |
| `console` | console | konzol |
| `std` (`std::` swallows its `::`) | standard | standard |
| `cout` | c out | szí aut |
| `include` | include | inklúd |
| `fmt` | format | format |
| `fn`, `fun`, `func` | function | függvény |
| `mut` | mutable | módosítható |
| `select` | select | szelekt |
| `chmod` | change mode | cséndzs mód |

| Acronym (in code in any case; in prose only as written here) | English | Hungarian |
|---|---|---|
| SQL, API, URL | S Q L, A P I, U R L | esz kú el, á pé í, ú er el |
| HTML, CSS, npm | H T M L, C S S, N P M | há té em el, cé esz esz, en pé em |
| JSON, YAML, GUI | Jason, yamel, gooey | dzséjszon, jemel, gúi |

| In prose | English | Hungarian |
|---|---|---|
| abbreviations, only in a paragraph of their language | e.g.: for example; i.e.: that is; etc.: et cetera | pl.: például; kb.: körülbelül; stb.: és a többi; ún.: úgynevezett; ill.: illetve; db: darab |
| `×`, `÷`, `±` | times, divided by, plus or minus | szorozva, osztva, plusz mínusz |
| `≤`, `≥` | less than or equal to, greater than or equal to | kisebb vagy egyenlő, nagyobb vagy egyenlő |
| `≠`, `≈` | not equal to, approximately | nem egyenlő, körülbelül |
| `²` and `³` after a letter; `½` | squared, cubed; half | négyzet, köb; fél |
| `°`, `°C`, `°F`, `%` | degrees, degrees Celsius, degrees Fahrenheit, percent | fok, Celsius-fok, Fahrenheit-fok, százalék |
| shortcut modifiers | Ctrl, Control, ⌃: Control; Cmd, Command, ⌘: Command; Shift, ⇧: Shift; Alt: Alt; Option, Opt, ⌥: Option | kontrol; kommand; sift; alt; opsön |
| linking words | version; at; dot | verzió; kukac; pont |

- **Number words:** 0–19 and the tens; English "twenty-one", Hungarian "huszonegy", "tizenkettő", "harminc".
- **File extensions:** `pdf doc docx xls xlsx ppt pptx odt txt md csv json yaml yml xml html css js ts tsx jsx py java c cpp h cs go rs kt swift php sql sh zip gz tar png jpg jpeg gif svg webp mp3 mp4 wav mov`.
- "plusz mínusz" is two words, not the spec's "plusz-mínusz", so the speech service's "két" rule sees "plusz" and keeps "kettő" before it.

**Rules** (what the tables and the tests leave open):
1. **Around a prose word.**
   - Matching ignores a leading `(`, `"`, `'`, `„` or `“`, and trailing `. , ; : ! ? ) " ' ”`, except a period an abbreviation ends in.
   - When a spoken form replaces the word, the leading marks are dropped and the trailing ones go back on its last token. A word kept as written keeps them all.
   - In code these marks are code like any other, and are dropped.
2. **Prose** (`prose`): the first of these that fits.
   1. A word with no letter, no digit and no listed symbol gives `[]`.
   2. **An address.** A word holding `://` or starting with `www.` gives its host without `www.`, every dot said ("example dot com"); an IPv4 host stays as written. An email address gives its local part, "at", then its host, every dot said.
   3. **A file name:** parts joined by dots, ending in a listed extension: "report dot pdf".
   4. **A shortcut:** listed modifiers joined by `+`, or modifier glyphs written straight before the key. It gives the modifiers' names, then the key as written.
   5. **A version:** `v` or `V`, then digits joined by dots. It gives "version" and the digits as written.
   6. **An abbreviation** of the paragraph's language, as written or with a capital first letter: its words, the capital kept ("Például").
   7. **An acronym** written as in the table, alone or with a hyphenated Hungarian suffix ("API-t"): its words, the suffix glued to the last one ("á pé ít").
   8. **For the speech service:** a word that starts with a digit, or a unit with a superscript (`m`, `dm`, `cm`, `mm` or `km`, then `²` or `³`), stays as written; the service reads numbers and units.
   9. **Otherwise** the word as written, with each listed prose symbol replaced by its words as separate tokens (a lone "%" gives "percent").
3. **Code** (`code`, `shell`): the first of these that fits.
   1. An address or an email address: as in prose.
   2. **An opaque id** gives `[]`: only letters, digits, `-` and `_`, with at least 12 letters and digits, at least 3 of them digits, and at least 4 switches between a letter and a digit (a hash, a UUID, a key).
   3. **A version:** `v` and digits joined by dots, as in prose; digits with two or more dots stay as written.
   4. **Otherwise** it is read left to right, longest match first:
      - `std::`;
      - a code symbol;
      - a number, `\d[\d_]*(\.\d+)?`: whole numbers 0–99 as number words, others as written without `_`;
      - a name: letters, digits, `_` and `$`;
      - anything else, brackets included, is dropped.

   **A name:**
   - A code word or an acronym that is the whole name gives its words. `__x__` gives "dunder" (Hungarian "dander") and x.
   - Otherwise it splits at `_`, between a lower-case letter or digit and a capital, before the last capital of a run followed by a lower-case letter ("XML Http Request"), and between letters and digits.
   - A piece that is an acronym gives its words, and a piece of digits is a number. When a name of two or more letters has only capitals, its other pieces are lower-cased ("max size"); a one-letter name stays ("T").
   - A leading `$` is silent.

   **In context:**
   - `.` inside a number belongs to the number.
   - `/` is "slash" only next to a name, a number, `.` or `~` (a path), and is dropped elsewhere.
   - `|` is "pipe" only in `shell`. `~` is "home" in `shell`, or straight before `/`.
   - `<`, a name and `>` are a type parameter: English says "of" before the name, and Hungarian says "típusú" after it.
   - `<name>` and `</name>` at the word's start, with a lower-case name, are HTML tags. They are matched before type parameters.
4. **List numbers** (`listNumber`, `shown` like `3.` or `3)`): 1–99 give the number word, capitalised, with a full stop ("Three.", "Három."). 100 and above give the digits and a comma ("120,").

- [ ] **Step 1: Write the failing tests.** First the spec's examples, in both languages:

```ts
const SPEC: Array<[shown: string, kind: WordKind, en: string, hu: string]> = [
	["ArrayList", "code", "Array List", "Array List"],
	["getUserName", "code", "get User Name", "get User Name"],
	["user_id", "code", "user id", "user id"],
	["MAX_SIZE", "code", "max size", "max size"],
	["a.b", "code", "a dot b", "a pont b"],
	["A::B", "code", "A double colon B", "A dupla kettőspont B"],
	["->", "code", "arrow", "nyíl"],
	["=>", "code", "arrow", "nyíl"],
	["=", "code", "equals", "egyenlő"],
	["==", "code", "double equals", "dupla egyenlő"],
	["===", "code", "triple equals", "tripla egyenlő"],
	["!=", "code", "not equals", "nem egyenlő"],
	["&&", "code", "and", "és"],
	["||", "code", "or", "vagy"],
	["|", "shell", "pipe", "pájp"],
	["*", "code", "star", "csillag"],
	["src/lib", "code", "src slash lib", "src per lib"],
	["<T>", "code", "of T", "T típusú"],
	["List<T>", "code", "List of T", "List T típusú"],
	["foo();", "code", "foo", "foo"],
	["println", "code", "print line", "print lájn"],
	["WriteLine", "code", "print line", "print lájn"],
	["def", "code", "define", "definiál"],
	["elif", "code", "else if", "elsz if"],
	["__init__", "code", "dunder init", "dander init"],
	["kwargs", "code", "keyword args", "kulcsszavas argumentumok"],
	["len", "code", "length", "hossz"],
	["console.log", "code", "console dot log", "konzol pont log"],
	["NaN", "code", "not a number", "nem szám"],
	["printf", "code", "print f", "print ef"],
	["std::cout", "code", "standard c out", "standard szí aut"],
	["#include", "code", "include", "inklúd"],
	["fmt.Println", "code", "format dot print line", "format pont print lájn"],
	[":=", "code", "colon equals", "kettőspont egyenlő"],
	["fn", "code", "function", "függvény"],
	["mut", "code", "mutable", "módosítható"],
	["println!", "code", "print line", "print lájn"],
	["fun", "code", "function", "függvény"],
	["func", "code", "function", "függvény"],
	["$name", "code", "name", "name"],
	["SELECT", "code", "select", "szelekt"],
	["chmod", "shell", "change mode", "cséndzs mód"],
	["~", "shell", "home", "hóm"],
	["<div>", "code", "div tag", "div tag"],
	[".class", "code", "dot class", "pont class"],
	["SQL", "code", "S Q L", "esz kú el"],
	["JSON", "code", "Jason", "dzséjszon"],
	["API", "code", "A P I", "á pé í"],
	["URL", "code", "U R L", "ú er el"],
	["HTML", "code", "H T M L", "há té em el"],
	["CSS", "code", "C S S", "cé esz esz"],
	["npm", "code", "N P M", "en pé em"],
	["YAML", "code", "yamel", "jemel"],
	["GUI", "code", "gooey", "gúi"],
	["https://www.example.com/a?b=1", "prose", "example dot com", "example pont com"],
	["anna@example.com", "prose", "anna at example dot com", "anna kukac example pont com"],
	["report.pdf", "prose", "report dot pdf", "report pont pdf"],
	["×", "prose", "times", "szorozva"],
	["÷", "prose", "divided by", "osztva"],
	["±", "prose", "plus or minus", "plusz mínusz"],
	["≤", "prose", "less than or equal to", "kisebb vagy egyenlő"],
	["≥", "prose", "greater than or equal to", "nagyobb vagy egyenlő"],
	["≠", "prose", "not equal to", "nem egyenlő"],
	["≈", "prose", "approximately", "körülbelül"],
	["x²", "prose", "x squared", "x négyzet"],
	["x³", "prose", "x cubed", "x köb"],
	["½", "prose", "half", "fél"],
	["°", "prose", "degrees", "fok"],
	["%", "prose", "percent", "százalék"],
	["Ctrl+C", "prose", "Control C", "kontrol C"],
	["⌘K", "prose", "Command K", "kommand K"],
	["Shift+Enter", "prose", "Shift Enter", "sift Enter"],
	["v2.3.1", "prose", "version 2.3.1", "verzió 2.3.1"],
];
it.each(SPEC)("reads %s as the spec says", (shown, kind, en, hu) => {
	expect(speakWord(shown, kind, "en").join(" ")).toBe(en);
	expect(speakWord(shown, kind, "hu").join(" ")).toBe(hu);
});
const ABBREVIATIONS: Array<[shown: string, language: "en" | "hu", spoken: string]> = [
	["pl.", "hu", "például"],
	["kb.", "hu", "körülbelül"],
	["stb.", "hu", "és a többi"],
	["ún.", "hu", "úgynevezett"],
	["ill.", "hu", "illetve"],
	["db", "hu", "darab"],
	["e.g.", "en", "for example"],
	["i.e.", "en", "that is"],
	["etc.", "en", "et cetera"],
];
it.each(ABBREVIATIONS)("reads %s in %s as the spec says", (shown, language, spoken) =>
	expect(speakWord(shown, "prose", language).join(" ")).toBe(spoken));
```

  Then:
  - `reads an abbreviation only in its own language, keeping a capital and the marks after it`: `speakWord("Pl.", "prose", "hu")` is `["Például"]`, `speakWord("stb.,", "prose", "hu")` is `["és", "a", "többi,"]`, and `speakWord("pl.", "prose", "en")` is `["pl."]`.
  - `reads an acronym with a Hungarian suffix, and leaves lower-case prose alone`: `"API-t"` (hu) gives `["á", "pé", "ít"]`, `"api"` (hu) gives `["api"]`, and `"JSON"` (en, prose) gives `["Jason"]`.
  - `keeps the marks around an address`: `"(https://example.com/x)."` gives `["example", "dot", "com)."]`.
  - `leaves numbers and units in prose to the speech service`: `"20%"`, `"20°C"`, `"3×4"`, `"12"` and `"m²"` each give themselves.
  - `skips long hashes, ids and keys, and reads a name that holds a digit`: `"a3f9c2b18e7d4b2a"` and `"550e8400-e29b-41d4-a716-446655440000"` give `[]`, and `"getUserName2"` gives `["get", "User", "Name", "two"]`.
  - `writes whole numbers up to 99 in code as words`: `"x=2"` (hu) gives `["x", "egyenlő", "kettő"]`, `"1.5"` gives `["1.5"]` and `"1_000"` gives `["1000"]`.
  - `reads list numbers as words`: `"1."` gives `["One."]` and `["Egy."]`; `"12."` (hu) gives `["Tizenkettő."]`, `"21)"` (en) gives `["Twenty-one."]`, and `"120."` gives `["120,"]`.
  - `says a pipe and home only where the shell is`: `codeKindOf("", "ls")` is `"shell"`, `codeKindOf("python", "ls")` is `"code"` and `codeKindOf("bash", "x")` is `"shell"`. `speakWord("|", "code", "en")` and `speakWord("~", "code", "en")` give `[]`, and `speakWord("~/projects", "code", "en")` gives `["home", "slash", "projects"]`.
  - `never ends a sentence after a number or a listed abbreviation`: `keepsSentenceOpen` is true for `"A vásár 2026. november 16."` (hu), `"Ehhez pl."` (hu) and `"Fruit, e.g."` (en), and false for `"It costs five dollars."` (en) and `"Ehhez pl."` (en).
  - `knows the separators between items`: `→`, `->`, `·` and `•` are separators, and `-` is not.
  - `keeps every token short and free of whitespace`: every token of every `SPEC` row, in both languages, matches `/^\S{1,80}$/`, and a prose word of 100 letters gives `[]`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/shared/read-aloud/spoken-forms.test.ts`.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): the reading dictionary and spoken forms, in English and Hungarian"`

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
- Consumes: `speakWord` and `WordKind` (Task 0).
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
    | `berta` | Berta | `PENDING_FROM_BOX_berta` | `{ "room.clean": 2 }` | 15 |
    | `imre` | Imre | `PENDING_FROM_BOX_imre` | `{ "room.clean": 2 }` | 15 |

  - Berta's and Imre's ids sit under a comment: `// PLACEHOLDER: Plan 1 Task 8 records these ids from the box's GET /v2/speakers in deploy/speech-service/README.md ("Deploy"). Plan 4 puts them here before TTS_ENABLED goes on.`
  - `PENDING_SPEAKER_ID_PREFIX = "PENDING_FROM_BOX_"`.
  - `defaultVoiceFor(language: VoiceLanguage): BuiltInVoice`: `en` gives Imogen and `hu` gives Berta, until Plan 3 adds a choice.
- Produces, in `containment.ts`:
  - `letterKey(text: string): string`: NFKC-normalised, lower-cased, keeping only `\p{L}` and `\p{N}`.
  - `replyKey(markdown: string): string`: `letterKey` of the Markdown after decoding numeric entities and `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;` and `&nbsp;`. Nothing else is cleaned away: link destinations, image syntax and tags only put letters between the words, and the search steps over them.
  - `type CheckedWord = { shown: string; kind: WordKind; tokens: readonly string[] }`.
  - `wordsFitReply(replyMarkdown: string, sentences: ReadonlyArray<{ language: "en" | "hu"; words: readonly CheckedWord[] }>): number | null` walks the words of all the sentences in order:
    - a word that is not a `listNumber` must have its `letterKey(shown)` found in `replyKey(markdown)` at or after the end of the previous word's match; an empty key counts as found;
    - a `listNumber` word is not searched (the renderer numbers lists, and Markdown may write "1." for every item), but its `shown` must match `^\d{1,4}[.)]$`;
    - every word's `letterKey(tokens.join(" "))` must equal `letterKey(speakWord(shown, kind, language).join(" "))`. So a token is the reply's own letters or the dictionary's reading of them, and the comparison ignores the pause marks the script adds;
    - it returns `null` when every word passes, and otherwise the index of the first sentence that holds a word that does not.

- [ ] **Step 1: Write the failing tests**

```ts
const said = (shown: string, kind: WordKind = "prose", language: "en" | "hu" = "en"): CheckedWord =>
	({ shown, kind, tokens: speakWord(shown, kind, language) });
const en = (...words: CheckedWord[]) => ({ language: "en" as const, words });
it("accepts what the browser reads from a reply with links, images, entities, inline code and a bare address", () => {
	const md = "See [the docs](https://example.com/a_(b)) now. ![a cat](cat.png) Salt &amp; pepper, `getUserName()` and **bold**. Visit https://www.example.com/x today.";
	expect(wordsFitReply(md, [
		en(said("See"), said("the"), said("docs"), said("now.")),
		en(said("Salt"), said("pepper,"), said("getUserName()", "code"), said("and"), said("bold.")),
		en(said("Visit"), said("https://www.example.com/x"), said("today.")),
	])).toBeNull();
});
it("steps over a formula, emoji or spaced number inside a sentence", () => {
	expect(wordsFitReply("The area is $\\pi r^2$ for a circle.", [
		en(said("The"), said("area"), said("is"), said("for"), said("a"), said("circle.")),
	])).toBeNull();
	const hu = ["A", "jegy", "ára", "12", "990", "Ft."].map((w) => said(w, "prose", "hu"));
	expect(wordsFitReply("A jegy ára 12 990 Ft 🎟️.", [{ language: "hu", words: hu }])).toBeNull();
});
it("accepts list numbers that the Markdown writes differently", () =>
	expect(wordsFitReply("1. Flour\n1. Water", [
		en(said("1.", "listNumber"), said("Flour")),
		en(said("2.", "listNumber"), said("Water")),
	])).toBeNull());
it("refuses tokens the dictionary does not make", () =>
	expect(wordsFitReply("Use `a.b` here.", [en({ shown: "a.b", kind: "code", tokens: ["free", "speech"] })])).toBe(0));
it("names the first sentence that is not in the reply", () =>
	expect(wordsFitReply("One two three.", [en(said("One"), said("two")), en(said("Free"), said("speech"))])).toBe(1));
it("refuses words out of order", () =>
	expect(wordsFitReply("Alpha beta. Gamma delta.", [en(said("Gamma"), said("delta.")), en(said("Alpha"), said("beta."))])).toBe(1));
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
  - **prefetch:** sentence i is written only once `i ≤ position + 2`. The position is the first sentence until `POST …/position {"sentence_id"}` names another; an unknown `sentence_id` answers 422;
  - **one reader of each stream:** a second `GET …/audio` or `GET …/events` answers 409, even after the first reader left; an unknown session answers 404;
  - a body that fails validation answers 422 `{"error": "invalid", "field": "<path>"}`, never echoing a value;
  - `DELETE` ends the streams;
  - `/health` answers `{ok: true, zonos: true, aligner: true}`.

  These follow the Plan 1 session's message of 2026-11-16, which its Task 6 README states as the contract.
- Produces, in `scripts/run-fake-speech-service.ts`: `npx tsx scripts/run-fake-speech-service.ts [--port 1929]` prints the base address and runs until Ctrl-C.

- [ ] **Step 1: Write the failing tests**
  - `silentMp3(1)` is 39 frames, 417 bytes each, and each frame starts `FF FB 90 C0`.
  - `follows Plan 1's contract for a two-sentence session`:
    - the POST answers 201 with a `session_id`;
    - the events come in the order sentence, words, sentence, words, done;
    - `start[0] === 0`, and `start[1] - end[0]` is 12 frames (0.30 s rounded up to whole frames: 0.313 s);
    - the audio is `silentMp3` frames whose count matches the events' end time.
  - `answers 409 to a second audio or events reader, even after the first left`.
  - `holds a sentence until a position report lets it through`: with four sentences and no report, only three are written; `POST …/position {"sentence_id": "s1"}` releases the fourth.
  - `answers 422 to a position for an unknown sentence`.
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
  - **Never reopened.** The service allows one reader of each stream per session, for the session's whole life: a second `GET`, even after the first ended, is 409. So an upstream stream that ends or fails early is never reopened. The reading ends its browser readers, and the browser starts a new session from that sentence.
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
  - `getReadAloudUrl` (Task 1), `defaultVoiceFor` and `wordsFitReply` (Task 2), and the registry (Task 4);
  - `getConversation(userId, conversationId)` from `$lib/server/services/conversations`;
  - `getReplyForDocumentKeep({ conversationId, messageId })` from `$lib/server/services/messages`. It walks "Ask me first" segments back from the last one and returns the whole reply's `content`.
- Produces:
  - `readingRequestSchema`, a zod object:
    - `conversationId` and `messageId`: strings of 1–100 characters;
    - `sentences`: 1–2000 items, each `{ id: /^s\d{1,5}$/, language: "en" | "hu", paragraphStart: boolean, words }`;
    - `words`: 1–200 items, each `{ shown: 1–2048 characters, kind: "prose" | "code" | "shell" | "listNumber", tokens: 1–40 strings of 1–80 characters with no whitespace }`;
    - refinements, for every sentence: at most 120 tokens in all, and its tokens joined with spaces ≤ 400 characters.
  - `type ReadingRequest = z.infer<typeof readingRequestSchema>`.
- POST, in order:
  1. `requireApiUser`.
  2. `getReadAloudUrl() === ""` → 404 `read_aloud_off`.
  3. Parse the body → 400 `invalid_request`.
  4. Conversation not the caller's → 404 `not_found`.
  5. No reply (or not an assistant message) → 404 `not_found`.
  6. `wordsFitReply` not null → 422 `not_in_reply`. Log only that index and the sentence count.
  7. Map each sentence to a `SpeechSentence` with `defaultVoiceFor(language)` and `tokens: words.flatMap((w) => w.tokens)`.
  8. `openReading`. `SpeechUnavailable`, or any other failure (a 422 from the service would mean this schema let through something the service refuses), → 503 `voice_unavailable`. Log only the service's status and its `field`.
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

**The folder's `AGENTS.md`** states six rules:
1. The script is built from the rendered DOM only, never from Markdown.
2. Marks never change the reply's DOM or layout: they are an overlay behind the text, and the prose is isolated only while it is marked.
3. Only the controller touches the `<audio>` element and the session routes; components read `readAloudView` and call the controller.
4. The iOS unlock happens synchronously in the press handler.
5. The detector exception above.
6. Spoken forms come only from `src/lib/shared/read-aloud/spoken-forms.ts`, the code the session route checks them with. Nothing else makes up a spoken word.

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
- Modify: `src/lib/components/chat/CodeBlock.svelte`: put `data-language={language ?? ""}` on `.code-block`, so the script can tell a shell block.

**Interfaces:**
- Consumes: `assignLanguages` and `isVoiced` (Task 6); `speakWord`, `isSeparator`, `keepsSentenceOpen`, `codeKindOf` and `WordKind` (Task 0).
- Produces:
  - `type ScriptWord = { shown: string; kind: WordKind; tokens: string[]; range: Range }`: a written word as it stands on screen, how it is read, and its `Range`, which may span several text nodes.
  - `type ScriptSentence = { id: string; index: number; language: "en" | "hu"; paragraphStart: boolean; words: ScriptWord[]; tokens: string[]; ranges: Range[]; text: string; charStart: number; chars: number }`:
    - `tokens` are the words' tokens in order, pause marks included;
    - `ranges[i]` is the range of token i's word, so a word read as several tokens stays marked whole while they are said;
    - `text` is `tokens.join(" ")`;
    - `chars` is `text.length + 1`;
    - `charStart` is the running sum of `chars`.
  - `type SpeechScript = { sentences: ScriptSentence[]; totalChars: number; missingLanguage: string | null; nothingToRead: boolean }`.
  - `buildSpeechScript(roots: readonly Element[], detect: (t: string) => string, options: { fallbackLanguage: "en" | "hu"; readBlock?: Element | null }): SpeechScript`.
    - The roots are each segment's `.markdown-container`.
    - `readBlock` is a code block that Read from here starts in. It is read whatever its length.
  - `sentenceAtPoint(script: SpeechScript, node: Node, offset: number): number | null`: the sentence holding the point, else the first one after it.
  - `SKIPPED_SELECTOR = ".markdown-diagram-block, .markdown-table-wrap, table, .markdown-frontmatter, .markdown-image-frame, img, svg, figure, button, input, a.source-link-chip, [aria-hidden='true'], script, style"`. Code blocks are no longer skipped whole: their language label and buttons fall under `button`, and their fade under `[aria-hidden='true']`.
  - `PARAGRAPH_TAGS = ["P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "SUMMARY", "DT", "DD", "DIV", "ASIDE"]`.
  - `CODE_BLOCK_MAX_LINES = 3` and `LONG_SENTENCE_CHARS = 240`.
    - The spec's 240 follows the box measurements of 2026-11-16: it keeps every clip under 30 s even at the slowest Pace (300 gives 33 s at Pace −2), so the aligner never enters its long-form mode.
    - The 80-character limit on a token is `speakWord`'s.
- **Rules** (what the tests below do not fully determine):
  1. **Walking the DOM.** Walk text nodes in document order with a `TreeWalker`.
     - Skip any node inside `SKIPPED_SELECTOR`, and any node inside a `<details>` without `open`, except its `<summary>`.
     - A text node's paragraph is its nearest ancestor in `PARAGRAPH_TAGS`, within the root.
     - A skipped element or a `<br>` between two nodes of one paragraph counts as a space.
  2. **Code blocks** (`.code-block`, or a bare `pre`) are paragraphs of their own, and only the text inside `pre` is read.
     - A block of at most 3 non-blank lines is read. A longer one is skipped, unless it is `options.readBlock`.
     - Each non-blank line is one sentence before the short and long rules (rules 7 and 8).
     - Its words take the kind `codeKindOf(block.dataset.language ?? "", the line's first word)`.
  3. **The spoken view keeps every offset.** Characters are replaced by spaces, never removed:
     - emoji: `\p{Extended_Pictographic}`, regional indicators, U+200D and U+FE0F;
     - TeX runs: `$…$` holding one of `\ ^ _ { } =`, `\(…\)` and `\[…\]`;
     - citation and footnote marks: `[1]`, `[2, 3]`, `[4–6]`, `[^1]` and `[^note]`.
  4. **Words** are the whitespace-separated runs of a paragraph's spoken view. Each gets a `Range` over its own characters.
     - **Kind.** A word whose first character is inside a `code` element is `code` or `shell`: `codeKindOf("", that element's first word)` for inline code, and the block's kind in a code block. Every other word is `prose`.
     - **Tokens:** `speakWord(shown, kind, the paragraph's language)`. A word with no tokens is left out.
     - **Separators.** A prose word for which `isSeparator` holds is left out. The kept word before it in the paragraph gets "," on its last token, unless that token ends in `. ! ? , ; : …`.
     - **Stray marks.** A word of punctuation only (left behind by a blanked mark, as in "now [1].") hands its marks to the last token of the kept word before it.
     - **Numbered lists.** An `<li>` whose parent is an `<ol>` starts with a `listNumber` word `"<n>."`, where n is the list's `start` (1 by default) plus the item's index. It has no characters on screen, so it takes the `Range` of the item's first word.
     - **Headings.** The last token of an `H1`–`H6` ends in "." unless it already ends in `. ! ? … :`.
     - **A written full stop is kept.** When a sentence's last written word ends in "." and its last token does not ("etc." read as "et cetera"), that token gets ".".
  5. **Languages.**
     - Run `assignLanguages` on the paragraph texts. A code block counts as empty text, so it takes the language around it.
     - A paragraph left with `""` takes `options.fallbackLanguage`, so a reply of only code is read in the UI language.
     - Keep only `en` and `hu` paragraphs. When none is voiced, `nothingToRead` is set if no paragraph had a word; otherwise `missingLanguage` is the language with the most letters.
  6. **Sentences** come from `new Intl.Segmenter(language, { granularity: "sentence" })` over a prose paragraph's spoken view.
     - A boundary where `keepsSentenceOpen(the text before it, language)` holds is no boundary.
     - A word belongs to the segment that holds its first character.
  7. **Short sentences.** While a sentence has fewer than 3 tokens, it joins the next sentence of the same language, across paragraphs and code lines too.
     - When the join crosses a paragraph or a code line and the last token does not already end in one of `. ! ? , ; : …`, that token gets "." if it came from a heading and "," otherwise.
     - A sentence with no next sentence to join joins the previous one of the same language.
     - A sentence with neither stays as it is.
  8. **Long sentences.** A sentence whose `text` is over 240 characters splits after the last word whose last token ends in "," or ";" and keeps the first part within 240. Failing that, it splits after the last word that keeps it within 240. A word is never split. Repeat until every part fits.
  9. **Ids and flags.** Ids are `s0, s1, …` in order. `paragraphStart` is true for a sentence that begins a paragraph, a code block's first line included. A merged sentence keeps its first part's flag.

- [ ] **Step 1: Write the failing tests** (jsdom, the real `Intl.Segmenter`, and a stub `detect` keyed by paragraph text). Build DOMs shaped like `MarkdownRenderer`'s output, with code blocks shaped like `CodeBlock.svelte`'s: `.code-block[data-language]`, a header `button`, and Shiki's `pre code > span.line`.
  - `reads paragraphs, headings, list items, checklist items and quotes in order`.
  - `reads a code block of up to three lines the way a teacher says it`: a `python` block of `total = price * 2` and `print(total)` gives the tokens `total equals price star two print total`, compared without punctuation.
  - `leaves out a longer code block, tables, CSV, charts, Mermaid, images, front matter and source chips`: a five-line block holding `secretCode` gives no token `secret`.
  - `reads a long code block that Read from here starts in`: with `readBlock` set to that block, its lines are sentences.
  - `reads inline code the way a teacher says it, and marks the whole name`: `` `getUserName()` `` gives `get`, `User` and `Name`, whose three ranges are one range with `toString() === "getUserName()"`. `` `=>` `` gives `arrow`, and `` `{}` `` gives nothing.
  - `says the pipe of an inline shell command`: `` `ls | grep x` `` gives `pipe`.
  - `reads a bare address by its site name, and drops emoji, formulas and citation and footnote marks`: "See https://www.example.com/docs now [1]." gives `["See", "example", "dot", "com", "now."]`.
  - `reads a numbered list's numbers`: in `<ol start="3"><li>Mix the flour well</li>…`, the first sentence's tokens start `["Three.", "Mix"]`, and `ranges[0] === ranges[1]`.
  - `ends a heading with a full stop`.
  - `never ends a sentence after a number or a listed abbreviation`: the Hungarian paragraph "A vásár 2026. november 16. Hétfőn nyit. Pl. Kenyér is lesz." gives two sentences, and the second starts with `Például`.
  - `pauses after a word before an arrow between items`: "Home → Settings → Profile" gives `["Home,", "Settings,", "Profile"]`.
  - `no syntax reaches the tokens`: no token is any of ``* _ # | ` [ ] ( ) < >`` and no token contains a backtick.
  - `keeps each token's range on its own characters`: for `<strong>bo</strong>ld`, `ranges[i].toString() === "bold"`.
  - `splits sentences with Intl.Segmenter in the paragraph's language`.
  - `merges short sentences across paragraphs with a pause mark`: a heading "Ingredients" and list items "Flour", "Water", "Salt" give one sentence with tokens `["Ingredients.", "Flour,", "Water,", "Salt"]` and `paragraphStart: true`.
  - `splits a sentence over 240 characters at a comma`: every part is at most 240 characters.
  - `skips a German paragraph, and names German when nothing is voiced`.
  - `reads a reply of only code in the fallback language`.
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
- Consumes: Tasks 0 (`WordKind`), 3 (`silentMp3DataUri`), 6, 7, 8 and 9; `fetchServerHealth`; `reportServerUpdateSign`; and `SERVER_UPDATE_WATCH_POLL_MS` and `SERVER_UPDATE_WATCH_MAX_MS`.
- Produces, in `client/api/read-aloud.ts` (through `requestJson` and `requestVoid` in `api/http.ts`):
  - `type ReadingStart = { sessionId: string; defaultSpeed: number; charsPerSecond: Record<"en" | "hu", number> }`.
  - `createReadingSession(body: { conversationId: string; messageId: string; sentences: Array<{ id: string; language: "en" | "hu"; paragraphStart: boolean; words: Array<{ shown: string; kind: WordKind; tokens: string[] }> }> }): Promise<ReadingStart>`.
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
    - `sentencePreview(i: number): string`, which returns `"4/9 · <first five written words>…"`.
  - `type Readability = { kind: "ready" } | { kind: "noVoice"; language: string | null } | { kind: "nothing" } | { kind: "unknown" }`.
  - `createReadAloudController(deps: ReadAloudDeps): ReadAloudController`.
  - `getReadAloud(): ReadAloudController`: the browser singleton, made on first use.
  - `assessReadability(segmentIds: readonly string[]): Promise<Readability>`: `unknown` while a segment's `.markdown-container` is missing or holds no text yet (Markdown renders asynchronously), so the speaker is never dimmed by mistake. It builds the script as `open` does, without `readBlock`.
  - `ReadAloudDeps` injects the audio element, `createEventSource`, the API above, the detector loader, `document`, `window`, `fetchHealth`, timers and `now`, so the tests use fakes.
- **Controller rules:**
  - **Unlocking iOS.** `start` runs synchronously in the click handler. On the page's first press only, before anything is awaited, it sets `audio.src = silentMp3DataUri()` and calls `play()`, ignoring a refused play. Once the element has played, iOS allows its later plays. Media events are ignored while that clip plays.
  - **The `open` command:**
    - rebuild the script when it is missing or stale; the roots are each `segmentIds` id's `[data-message-id="…"] .markdown-container`, `fallbackLanguage` is the UI language, and `readBlock` is the `.code-block` holding `from`, if any;
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
  - `starts from the sentence holding a selection's start, inside a long code block too`.
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
  - `dims a reply with nothing to read`: a reply of only a five-line code block.
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
  - **Watching the selection.** On `selectionchange` (coalesced per animation frame), a selection that is not collapsed and starts inside a `.markdown-container` of an element with `data-read-aloud-segments`, in a reply whose readability is `ready`, shows the pill. So does a selection inside a code block of a reply whose readability is `nothing` (a reply of only long code).
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
  - `shows the pill inside a long code block, and starts there`.
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
    - a five-sentence English reply, so that reading to the end needs the position reports (the fake holds sentence i until `i ≤ position + 2`);
    - a two-sentence English reply;
    - a German reply;
    - a "syntax" reply with a heading, bold, a link, the inline code `getUserName()`, a two-line block `total = price * 2` / `print(total)`, a five-line block holding `const secretCode = 42;`, a table holding `TABLECELL`, a numbered list, a checklist, a quote, an emoji and the bare URL `https://www.example.com/docs`.

- [ ] **Step 1: Write `read-aloud.spec.ts`,** with `secondsPerChar: 0.02`:
  - `@smoke the speaker reads a reply: the player rises and the tint moves`: wait until the second sentence's tint shows.
  - `no syntax reaches the voice, and code is read the way a teacher says it`:
    - no recorded token contains any of `*`, `` ` ``, `#`, `|`, `[`, `]`, `http` or `www.`;
    - none is `secret`, `secretCode` or `TABLECELL`;
    - the tokens hold `get User Name`, `total equals price star two`, `One.` and `example dot com`.
  - `✕ stops, and the end shows Finished`: the five-sentence reply is read to its end, which proves the position reports reach the service.
  - `a slash command hushes the player, and reading goes on`.
  - `another reply's speaker switches without the player leaving`.
  - `the scrubber jumps to a sentence, and the arrows step`: check the fake's recorded session starts at the expected `s<n>`.
  - `marks never move the text and never cover the player`: a word's bounding box is the same before and while reading, and `expectTopmost(player, { probe: "center" })` passes.
  - `a German reply's speaker is dimmed with a note`.
  - `Read from here starts at the selected sentence`.
  - `Read from here inside the long code block reads it`: the fake records a session whose tokens hold `secret Code equals forty-two`.
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
  6. With the real service, listen once to Task 0's Hungarian forms, a numbered list, a heading, a range like "7–12 fok" and a number with a suffix ("2026-ban"), as spec §4.4 asks. List for the owner any that sound wrong (Decisions 11 and 13).
- [ ] **Step 6: Commit.** `git commit -m "test(read-aloud): end-to-end specs on the fake speech service"`

---

## Hand-over to Plans 1, 3 and 4

- **Plan 1,** while it is being finalised (the owner decides):
  - Its Hungarian "két" rule counts the word after a number unless that word is on its list, so "2 ≤ x" would be read "két kisebb vagy egyenlő x". Adding "kisebb", "nagyobb" and "körülbelül" to the list fixes it. Code is not affected: Plan 2 writes numbers up to 99 in code as words.
  - A pause after headings longer than the paragraph gap would need a per-sentence pause in its contract (Decision 13).
- **Plan 3:**
  - The person's voice choice replaces `defaultVoiceFor` in the session route.
  - Their Default speed fills `defaultSpeed`.
  - The voice editor's preview reuses `ReadAloudPlayer` and `ReadAloudScrubber`.
- **Plan 4:**
  - **Voices.** Replace Berta's and Imre's placeholder ids in `voices.ts` (`PENDING_SPEAKER_ID_PREFIX` must be gone), and measure `charsPerSecond` on the box.
  - **Apache.** In both vhosts, add `^/api/read-aloud/sessions/[^/]+/(audio|events)` to the unbuffered streaming routes: a `ProxyPass … flushpackets=on` line before the catch-all, and the `LocationMatch` alternative. The project memory note `alfyroot-apache-alfyai-vhosts` explains how; mirror the change in `deploy/apache-site.conf`.
  - **Paperwork.** The Feature Guide entry, with its drawing and a Show me marker on the speaker; ADR-0070; and the owner's checks on staging.
  - **Listening.** On staging the owner hears the dictionary's Hungarian forms, the list numbers and the headings' pause, and the table changes where they sound wrong (Decisions 11 and 13).
