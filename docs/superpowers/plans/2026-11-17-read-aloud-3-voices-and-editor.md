# Read Aloud — Plan 3 of 4: Voices and the Editor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. This plan is built natively by two parallel sessions on disjoint files (see **Tracks**). Each session implements its own task list in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People choose which voice reads each language and the speed every reading starts at, and they make personal voices from a built-in voice with five knobs and seven styles, in an editor that renders what they hear through the speech service. A personal voice stays private to its maker.

**Architecture:**
- **One shared voice-design module** (`src/lib/shared/read-aloud/voice-knobs.ts`) holds the five knobs, their word bands, the seven styles, the safe control ranges and the mapping from knob values to Zonos controls. The browser draws the sliders and words from it, and the server makes controls with it, so the two cannot disagree. The two samples live beside it.
- **Storage:** a `read_aloud_voices` table (one row per personal voice, keyed to its maker by a cascading foreign key) and three `users` columns (the English voice, the Hungarian voice, the Default speed). Every query that reads, changes or deletes a voice or a choice filters by the signed-in person's id.
- **Readings:** the session route resolves the person's choice for each language into a speaker and its controls, and answers the person's Default speed.
- **Preview:** an app route renders the sample (or the person's own words) through the speech service's `POST /v1/preview`, one call per sentence, and joins the clips into one MP3 with each sentence's start and end, so the editor's player has exact notches. A person has one preview at a time.
- **Browser:** a preview player (`voice-preview.ts`) owns the one `<audio>` element that every ▶ in Settings and the editor plays through, so only one sound plays at a time. The reply player's pill becomes a component that both the floating player and the editor use. The Settings card and the editor are Svelte 5 components on the app's `DialogShell`.
- **The knobs' safe ranges** are re-measured on the box by a script beside the speech service. It runs only with the owner's OK, and its result changes data, not code.

**Tech Stack:**
- SvelteKit 2.70 and Svelte 5.56 (runes), TypeScript, zod 4, Drizzle ORM on SQLite (better-sqlite3).
- Tests: Vitest 4 (jsdom by default; `// @vitest-environment node` for server tests), @testing-library/svelte, and Playwright on the production build.
- Python 3.12 with httpx, numpy and soundfile for the measuring script: the speech service's own environment.

**Spec:** `docs/superpowers/specs/2026-11-16-read-aloud-design.md`: §4.5, §4.6, §4.7, the editor and Settings rows of §4.8, §4.10, §6.5, §7, §8 (the re-measure) and §9.4.
- **Visual truth:** `docs/superpowers/specs/2026-11-16-read-aloud/voice-editor-prototype.html`, with `editor-desktop.png` and `editor-phone.png` beside it. Open the prototype in a browser. Its `KNOBS`, `STYLES`, `syncName` and `animateTo` are this plan's source for the word bands, the presets, the suggested name and the 260 ms animation.
- **Built on:**
  - Plan 1's speech service. `deploy/speech-service/README.md` is its contract, and its `POST /v1/preview` is fixed.
  - Plan 2's reading in the chat, merged into this branch at `0051fed75` (merge `e2427bfd9`). Plan 2's plan, `docs/superpowers/plans/2026-11-16-read-aloud-2-reading-in-chat.md`, explains the code this plan extends.

## Global Constraints

- **Docs check before code** (`AGENTS.md`). This planning session had no Context7 or Svelte MCP tools. The plan follows patterns already in this repo, at the versions it pins. Each implementer checks the current docs for the APIs their own task touches:
  - Svelte 5 runes, and the `input` and `change` events of `<input type="range">`;
  - a SvelteKit `RequestHandler` that answers a binary `Response`;
  - Drizzle's `sqliteTable`, `real` and `index`;
  - httpx and numpy (Task 7).
- **Strings:** every new string exists in English and Hungarian, with the words fixed in **Copy** below. The Hungarian words are this plan's until the owner reads and hears them at Plan 4's staging check (Decision 17).
- **Icons:** Lucide only. This plan adds `Plus`, `RotateCcw` (the ↺), `TriangleAlert` and the small `Play` and `Pause`; the reply player keeps its own.
- **Personal voices are private.** Every query that reads, changes or deletes a voice or a choice filters by the signed-in person's id. No route takes another person's id as its subject, and a route answers 404 for a voice that is not the caller's.
- **Privacy** (spec §4.10): no audio is written to disk or to a log, on the server or in the browser. No preview text reaches a log. The browser keeps renders in memory only (Decision 12).
- **Controls:**
  - knob values are stored as slider values;
  - a Zonos control is made only by `knobsToControls` (Task 1);
  - a control never lies outside `SAFE_CONTROL_RANGES`.
- **Limits:**
  - a name is 1–40 code points after trimming;
  - a person has at most 50 voices;
  - the person's own words are 1–300 characters and hold a letter or a digit;
  - the Default speed is one of 0.75, 1, 1.25, 1.5, 1.75 and 2.
- **Motion:**
  - the tokens (`--duration-micro`, `--duration-standard`, `--duration-emphasis`, `--ease-out`, `--ease-emphasis`, `--ease-in`), plus `DialogShell`'s own transitions;
  - a style moves the sliders over 260 ms, eased `1 − (1 − t)³` (the prototype's `animateTo`), and at once under reduced motion.
- **Layout:**
  - the editor is `DialogShell` with `phonePresentation="fullSheet"` and `maxWidthClass="max-w-[600px]"`;
  - its phone breakpoint is `DialogShell`'s: below 640 px, so in CSS `@media (max-width: 639px)`;
  - the Settings card uses the Settings page's own `settings-card`, `settings-row` and `settings-select` styles.
- **Addresses:** the speech service is reached only through `getReadAloudUrl()` (`config-store.ts`). The browser calls only `/api/read-aloud/…`.
- **The speech service stays as Plan 1 left it.** In `deploy/speech-service/` this plan adds only Task 7's script, its test and lines in the README and AGENTS.md. Task 15 changes the box only with the owner's OK.
- **Plan 2's contract stays.** The session route's answer keeps its shape (`ReadingStart`), and only its values change.
- **Tests use made-up data only:** people `user-a` and `user-b`, a voice named "Test Voice", and the samples. Never the owner's data.
- **Node 22 in a worktree.** `better-sqlite3` needs Node 22, and the Bash guard refuses a `PATH` built from a variable, so write it out: `PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run <files>`. `scripts/gates.sh` sets Node 22 itself.
- **Gates:**
  - once, at the end: Task 14;
  - while iterating: `npx vitest run <files>`, `npm run check` and `npx biome check src scripts tests`;
  - for Task 7, the speech service's pytest.
- **The Feature Guide** (root `AGENTS.md`) is Plan 4's. The feature stays off (`TTS_ENABLED` false) until then, and Plan 4 writes one guide entry for reading aloud, the Settings card and the editor together.

## Decisions this plan makes (my calls, so building is not blocked)

1. **The preview's sentences are rendered one call each, then joined.** The service's preview answers one whole clip with no times. One call per sentence, joined with Plan 1's 0.30 s gap, gives the editor's scrubber exact notches; the reply player's notches are by text share. It costs one more Zonos call per render, and previews share Zonos's two slots with readings.
2. **The editor's player is the reply player's pill, drawn inline,** with its transport and its scrubber. It draws no ⌖ (there is nothing to find), no speed chip (a playback speed beside Pace would blur what is being judged) and no ✕ (the dialog has its own).
3. **One preview player plays every ▶ in Settings and the editor**, through its own `<audio>` element, so one sound at a time holds by construction.
   - It is unlocked on the click that opens the editor and on every ▶, for iOS.
   - A reply reading cannot overlap it, because the chat's player stops its reading when the chat goes.
4. **Storage:** three `users` columns and a `read_aloud_voices` table. A voice row also keeps its `language`, which spec §6.5 does not list, so a voice whose base was removed still knows its picker.
5. **A choice** is a built-in key or the person's voice id, stored per language; null means the language's default.
   - Deleting a chosen voice gives the choice to the voice's base, in the same transaction (spec §4.6).
   - An id that is not the person's, or not of that language, reads as the default.
6. **Knob values are stored as slider values** and made into Zonos controls only when a reading or a preview is made, so a re-measured range reaches saved voices too.
7. **A narrower measured range clamps the control. It does not rescale the slider.**
   - Gain: the styles the owner approved on the box keep their exact controls.
   - Cost: a slider's far end may stop changing the sound in one language.
8. **Limits:**
   - 50 voices per person;
   - a name of 1–40 code points after trimming (an empty field saves the suggested name);
   - the person's own words: 1–300 characters with a letter or a digit, else the sample plays.
9. **A new voice starts from the base of the person's voice for the UI language** (Imogen or Berta, unless they chose another), with the Original style.
10. **Settings save on change,** as the Preferences card does. A failure puts the control back and says so.
11. **When a render happens:**
    - a pointer release renders at once;
    - a keyboard change renders after 400 ms without another;
    - Yours / Original always plays;
    - the person's own words render on ▶ or Enter.

    A newer render supersedes the person's older one twice over: the browser drops it, and the server aborts its calls and answers 409 `superseded`.
12. **The browser keeps the last 12 renders in memory,** so Yours / Original flips at once. Nothing is cached on the server, and nothing touches a disk.
13. **The samples.**
    - English: the prototype's two sentences.
    - Hungarian: the two sentences the owner approved on the box on 2026-11-16, with Berta and Imre (the listening pack's "hu6" in `.superpowers/hu-voices/box-approved-2026-11-16/listening-guide.md`). Spec §4.6 asked for the owner's check of it, and that check is done.
14. **A voice whose base was removed** reads with its language's default built-in voice, without its knobs, and shows the spec's warning. Edit opens it on that default, knobs kept. A built-in voice taken out of `BUILT_IN_VOICES` moves to `RETIRED_BUILT_IN_VOICES`, so a voice made from it can still be named.
15. **The Settings card loads its own data** (`GET /api/read-aloud/voices`), so the Settings loader is untouched.
16. **The measuring script's rule for "safe"** (§9.4 leaves the method open). A dose is safe when, at every seed and for every voice of the language:
    - the aligner places every word;
    - there is no more clipping than in the baseline;
    - no silence inside the clip is longer than 1.5 × the baseline's longest (at least 0.8 s);
    - the clip's length is within 0.5–2 × the baseline's (Pace: 0.4–2.5 ×).

    The script never reports a range wider than the spec's.
17. **The Hungarian words** for knobs, styles, voices and the editor are this plan's, until Plan 4's staging check.
18. **A personal voice is account data.**
    - It appears in the account's data archive.
    - It survives "Clear Memory" and "Clear Workspace", like the other settings.
    - Deleting the account deletes it, through the cascade.

**Only the owner can decide:**
- **Running Task 15 on the box:** about 15 minutes of Zonos on GPU0 beside vLLM, which decodes about 10% slower while it runs (Plan 1's measurement). Nothing restarts. Nothing else waits on it: until it runs, the editor works within the spec's ranges.
- **Only if Task 15 puts a style's value outside a measured range:** whether that style changes in that language. Until then the range stays at the spec's for that control.

## Review Focus

1. **Another person's voice, by any route.** A voice id from someone else, in a PATCH, a DELETE or a choice, or left behind in a choice, is never read, used or changed: 404, or 400 for a choice, and a reading resolves to the default. Tests: `never lists, changes, deletes or reads another person's voice` (Task 2), `answers 404 for another person's voice and 400 for choosing it` (Task 4) and `another person never sees or uses my voice` (Task 13).
2. **Malformed knobs** (a string, NaN, 1e9, a missing key) are refused with 400. A stored value beyond the slider, for example from before a range was narrowed, still makes controls inside the safe range. Tests: `clamps a stored value beyond its slider and ignores a value that is not a number` (Task 1) and `400 for knobs out of range, not numbers or missing, …` (Task 4).
3. **A burst of renders** (quick drags and releases, an arrow key held down): only the last render plays, the earlier ones are aborted upstream, and nothing plays out of order. Tests: `a later preview of the same person supersedes the earlier one` (Task 5), `drops a render that a later press overtook` (Task 10) and `a pointer release plays at once; a held key plays once, 400 ms after the last change` (Task 11).
4. **The chosen voice is deleted:** the choice falls back to its base, Settings shows the base, and the next reading uses the base. Tests: `deleting the chosen voice gives the choice back to its base` (Task 2), `deleting the English voice shows its base in the picker` (Task 12) and `a personal voice reads the replies, and deleting it gives the reading back to its base` (Task 13).
5. **iOS stays silent when a sound starts after an await on an element that was never unlocked.** `unlock()` runs synchronously in the click that opens the editor and in every ▶ handler. Tests: `unlocks synchronously, before the render is awaited` (Task 10), `unlocks and toggles on press, nothing awaited first` (Task 11) and `opening the editor unlocks the preview first` (Task 12).

---

## File Structure

| File | Track | What it holds |
|---|---|---|
| `src/lib/shared/read-aloud/voice-knobs.ts` (new) | A | Knobs, word bands, styles, safe ranges, `knobsToControls`, name parts, limits, speeds |
| `src/lib/shared/read-aloud/voice-samples.ts` (new) | A | The two samples per language; `ownWords` |
| `src/lib/server/db/schema.ts`, `drizzle/1777140000130_read_aloud_voices.sql`, `drizzle/meta/_journal.json` | A | The table and the three `users` columns |
| `src/lib/server/services/account-lifecycle/user-scoped-tables.ts` | A | The table in the erasure registry |
| `src/lib/server/services/account-data-archive/index.ts` | A | The voices in the data archive |
| `src/lib/server/services/read-aloud/voices.ts` | A | `builtInVoice`, `resolvedVoice`, `RETIRED_BUILT_IN_VOICES` |
| `src/lib/server/services/read-aloud/personal-voices.ts` (new) | A | Personal voices, the choice, the Default speed, `resolveReadingVoices` |
| `src/lib/server/services/read-aloud/voice-requests.ts` (new) | A | The zod schemas of the voice, preference and preview bodies |
| `src/lib/server/services/read-aloud/request.ts` | A | Sentences sent with the resolved voices |
| `src/lib/server/services/read-aloud/speech-client.ts` | A | `previewSpeech` |
| `src/lib/server/services/read-aloud/mp3-join.ts` (new) | A | Reading and joining MP3 clips |
| `src/lib/server/services/read-aloud/preview.ts` (new) | A | One preview per person; per-sentence calls, joined |
| `src/lib/server/services/read-aloud/testing/fake-speech-service.ts` | A | The fake's `POST /v1/preview` |
| `src/lib/server/services/read-aloud/index.ts`, `AGENTS.md` | A | Exports; the rules |
| `src/routes/api/read-aloud/voices/+server.ts`, `voices/[id]/+server.ts`, `preferences/+server.ts`, `preview/+server.ts` (new) | A | The routes |
| `src/routes/api/read-aloud/sessions/+server.ts` | A | Readings use the person's voices and speed |
| `deploy/speech-service/scripts/measure_knobs.py`, `tests/test_measure_knobs.py` (new); `README.md`, `AGENTS.md` | A | The re-measure |
| `src/lib/components/read-aloud/ReadAloudPlayerPill.svelte` (new), `ReadAloudPlayer.svelte`, `ReadAloudNote.svelte` | B | The pill both players use |
| `src/lib/client/read-aloud/controller.ts` | B | `type ReadAloudPlayerActions` only |
| `src/lib/i18n/read-aloud.ts` | B | The words |
| `src/lib/client/api/read-aloud-voices.ts` (new) | B | The browser's calls to Track A's routes |
| `src/lib/client/read-aloud/voice-preview.ts`, `voice-name.ts` (new); `AGENTS.md` | B | The preview player; the suggested name |
| `src/lib/stores/read-aloud.ts` | B | `voicePreviewView` |
| `src/lib/components/read-aloud/voices/*` (new) | B | The editor, its parts and the Settings card |
| `src/routes/(app)/settings/_components/SettingsProfileTab.svelte` | B | The card after Preferences |
| `tests/e2e/read-aloud-voices.spec.ts` (new), `tests/e2e/read-aloud-helpers.ts`, `tests/AGENTS.md` | B | End to end |

## The browser ↔ app contract (Plan 3)

```
GET    /api/read-aloud/voices          → 200 VoiceSettings
POST   /api/read-aloud/voices          body VoiceDraft           → 201 {"voice": PersonalVoice}
PATCH  /api/read-aloud/voices/{id}     body Partial<VoiceDraft>  → 200 {"voice": PersonalVoice}
DELETE /api/read-aloud/voices/{id}                               → 200 {"choice": Choice}
PUT    /api/read-aloud/preferences     body {"en"?, "hu"?, "defaultSpeed"?}  (at least one)
                                                                 → 200 {"choice": Choice, "defaultSpeed": number}
POST   /api/read-aloud/preview         body PreviewRequest       → 200 audio/mpeg, Content-Length,
                                                                   Cache-Control: no-store,
                                                                   X-Read-Aloud-Sentences: [[start,end],…]

VoiceSettings  = {"builtIn": [{"key", "name", "language"}], "voices": [PersonalVoice],
                  "choice": Choice, "defaultSpeed": number}
PersonalVoice  = {"id", "name", "base", "baseName", "language": "en" | "hu", "knobs": Knobs, "baseMissing": bool}
Choice         = {"en": string, "hu": string}   # a built-in key or one of the person's voice ids; never null here
VoiceDraft     = {"name": string, "base": string, "knobs": Knobs}
Knobs          = {"pace", "pitch", "depth", "energy", "projection"}: finite numbers within the sliders' ranges
PreviewRequest = {"base": string, "knobs": Knobs, "text"?: string}   # without text: the base language's sample
```

- **Times** in `X-Read-Aloud-Sentences` are seconds on the clip's clock, rounded to the millisecond: one `[start, end]` per sentence read.
- **Every route** answers:
  - 401 without a user;
  - 404 `read_aloud_off` when `getReadAloudUrl()` is empty;
  - 400 `invalid_request` for a body that is not JSON or fails its schema.
- **The voice and preference routes** also answer:
  - 400 `unknown_voice`: a base that is not a built-in voice, or a choice that is neither a built-in voice of that language nor one of the person's voices of that language;
  - 404 `not_found`: a voice that is not the person's;
  - 409 `too_many`: a 51st voice.
- **The preview** also answers:
  - 400 `unknown_voice`: a base that is not a built-in voice;
  - 400 `invalid_request`: words with nothing to say;
  - 409 `superseded`: a later preview of the same person overtook it;
  - 422 `nothing_to_say`: the service found nothing speakable;
  - 503 `voice_unavailable`: the service is down or failed.
- **Each error** has the body `{"error": "<code>"}`, from `createJsonErrorResponse`.

## Copy

English, then Hungarian. Keys are under `readAloud.`. `{…}` are placeholders. "Try again" reuses `readAloud.tryAgain`.

**Settings card** (`settings.`):

| Key | English | Hungarian |
|---|---|---|
| `title` | Read aloud | Felolvasás |
| `desc` | The voices AlfyAI uses when you press the speaker on a reply. | Ezekkel a hangokkal olvas fel az AlfyAI, amikor egy válasznál megnyomod a hangszórót. |
| `englishVoice` | English voice | Angol hang |
| `hungarianVoice` | Hungarian voice | Magyar hang |
| `builtIn` | Built in | Beépített |
| `yours` | Yours | Sajátok |
| `defaultSpeed` | Default speed | Alapsebesség |
| `defaultSpeedHelp` | Every reading starts at this speed | Minden felolvasás ezzel a sebességgel indul |
| `yourVoices` | Your voices | Saját hangjaid |
| `newVoice` | New voice | Új hang |
| `empty` | Make a voice of your own: start from one of the built-in voices and change how it sounds. Only you will see it. | Készíts saját hangot: válassz egy beépített hangot, és alakítsd a hangzását. Csak te fogod látni. |
| `edit` | Edit | Szerkesztés |
| `editVoice` | Edit {name} | {name} szerkesztése |
| `from` | from {voice} | {voice} alapján |
| `unchanged` | unchanged | változatlan |
| `baseMissingEn` | {voice} isn't available any more, so this voice reads as your English voice for now. | {voice} már nem érhető el, ezért ez a hang egyelőre az angol hangoddal olvas. |
| `baseMissingHu` | {voice} isn't available any more, so this voice reads as your Hungarian voice for now. | {voice} már nem érhető el, ezért ez a hang egyelőre a magyar hangoddal olvas. |
| `saveFailed` | Couldn't save this setting. | Nem sikerült menteni a beállítást. |
| `loadFailed` | Couldn't load your voices. | Nem sikerült betölteni a hangjaidat. |

**Voices and languages:**

| Key | English | Hungarian |
|---|---|---|
| `voice.option` | {name} · {description} | {name} · {description} |
| `voice.play` | Play {name} | {name} lejátszása |
| `voice.pause` | Pause {name} | {name} szüneteltetése |
| `voice.imogen` | British woman | Brit nő |
| `voice.rupert` | British man | Brit férfi |
| `voice.savannah` | American woman | Amerikai nő |
| `voice.wyatt` | American man | Amerikai férfi |
| `voice.berta` | Hungarian woman | Magyar nő |
| `voice.imre` | Hungarian man | Magyar férfi |
| `language.en` | English | Angol |
| `language.hu` | Hungarian | Magyar |

**The editor** (`editor.`):

| Key | English | Hungarian |
|---|---|---|
| `newTitle` | New voice | Új hang |
| `editTitle` | Edit voice | Hang szerkesztése |
| `startFrom` | Start from | Kiindulás |
| `style` | A style to start with | Egy stílus kezdésnek |
| `shape` | Shape it | Alakítsd |
| `resetAll` | Reset all | Mindet vissza |
| `reset` | {knob} back to normal | {knob} vissza normálra |
| `listen` | Listen | Meghallgatás |
| `compare` | Compare | Összehasonlítás |
| `yours` | Yours | A tiéd |
| `original` | Original | Eredeti |
| `playAfterChange` | Play after each change | Lejátszás minden módosítás után |
| `ownWords` | Use my own words | Saját szöveggel |
| `ownWordsLabel` | Your words | A szöveged |
| `ownWordsPlaceholder` | Type a sentence to hear | Írj be egy mondatot, amit meghallgatnál |
| `quote` | “{text}” | „{text}” |
| `sampleFailed` | Couldn't play the sample. | Nem sikerült lejátszani a mintát. |
| `name` | Name | Név |
| `cancel` | Cancel | Mégse |
| `save` | Save voice | Hang mentése |
| `saveChanges` | Save changes | Módosítások mentése |
| `saveAsNew` | Save as new | Mentés újként |
| `delete` | Delete | Törlés |
| `saveFailed` | Couldn't save this voice. | Nem sikerült menteni a hangot. |
| `deleteFailed` | Couldn't delete this voice. | Nem sikerült törölni a hangot. |
| `tooMany` | You have 50 voices, the most you can keep. Delete one to make another. | Már 50 hangod van, ennél többet nem tarthatsz meg. Törölj egyet, ha újat készítenél. |
| `deleteTitle` | Delete this voice? | Törlöd ezt a hangot? |
| `deleteMessage` | Delete “{name}”? Readings that use it go back to {voice}. | Törlöd: „{name}”? Az ezt használó felolvasások ismét {voice} hangján szólnak. |
| `nameStyle` | {style} {voice} | {style} {voice} |
| `nameOne` | {voice}, {first} | {voice}, {first} |
| `nameTwo` | {voice}, {first} and {second} | {voice}, {first} és {second} |
| `nameMine` | My {voice} | Saját {voice} |

**Styles** (`style.`): `original` Original / Eredeti; `bedtime` Bedtime / Esti; `storyteller` Storyteller / Mesélő; `brisk` Brisk / Lendületes; `calmAndClear` Calm and clear / Nyugodt és tiszta; `cheerful` Cheerful / Vidám; `newsreader` Newsreader / Hírolvasó.

**Knobs** (`knob.<key>` the name, `.low` and `.high` the ends, `.0`… the words from low to high; the English is spec §4.6's):

| Knob | Name | Ends | Words |
|---|---|---|---|
| `pace` | Pace / Tempó | Slower · Faster / Lassabb · Gyorsabb | Much slower, Slower, A little slower, Normal, A little faster, Faster, Much faster / Sokkal lassabb, Lassabb, Kicsit lassabb, Normál, Kicsit gyorsabb, Gyorsabb, Sokkal gyorsabb |
| `pitch` | Pitch / Hangmagasság | Lower · Higher / Mélyebb · Magasabb | Much lower, Lower, A little lower, Normal, A little higher, Higher / Sokkal mélyebb, Mélyebb, Kicsit mélyebb, Normál, Kicsit magasabb, Magasabb |
| `depth` | Depth / Mélység | Normal · Deeper / Normál · Öblösebb | Normal, A little fuller, Deeper, Much deeper / Normál, Kicsit teltebb, Öblösebb, Sokkal öblösebb |
| `energy` | Energy / Energia | Calmer · Livelier / Nyugodtabb · Élénkebb | Very calm, Calm, A little calmer, Normal, A little livelier, Lively, Very lively / Nagyon nyugodt, Nyugodt, Kicsit nyugodtabb, Normál, Kicsit élénkebb, Élénk, Nagyon élénk |
| `projection` | Projection / Hangerő | Softer · Projected / Halkabb · Erőteljes | Breathy, Softer, A little softer, Normal, A little clearer, Clearer, Projected / Suttogó, Halkabb, Kicsit halkabb, Normál, Kicsit tisztább, Tisztább, Erőteljes |

## Tracks

Two sessions build this plan at the same time, each in its own worktree, on disjoint files.

- **Track A: server, data and the measuring script.** Tasks 1, 2, 3, 4, 5, 6 and 7, in that order. It is well specified, so it suits Sonnet 5.5.
- **Track B: browser, UI, end to end, the review and the gate.** Tasks 8, 9, 10, 11, 12, 13 and 14, in that order. It is the heavier track, so it suits Opus 5.5.
- **Task 15** (the box) is on neither track. It runs when the owner says yes, and nothing waits on it.

**Files.** The File Structure table names each file's track, and no file belongs to both. A file stays its track's until that track's last task is committed (Task 7 for A, Task 14 for B); after that the other track may change it.

**Merge points, by commit trailer.** The last commit of each task carries a trailer on its own line, `Plan-3-Task: <N>`. Both worktrees share one repository, so each sees the other's commits.

| Track B task | Needs Track A's |
|---|---|
| 10 | 1 |
| 13 | 1, 2, 3, 4 and 5 |
| 14 | every task, 1 to 7 |

Track A needs nothing of Track B.

- **Before a task with needs,** find each needed task's commit and merge it, unless it is already an ancestor of `HEAD`. Write the commands out literally (the Bash guard), for example for Task 1:
  ```
  git log --all --format=%H -n 1 --grep='^Plan-3-Task: 1$'
  git merge-base --is-ancestor <that sha> HEAD || git merge --no-edit <that sha>
  ```
- **Merge, never cherry-pick.**
- **When a needed task is not there yet:**
  - first, take the next task of your own list that does not need it;
  - if none is left, wait on it with a Monitor until-loop over that `git log`, checking every 5 minutes.

  Never wait for a message: a message to a busy session can arrive an hour late.

**Needs that cross tracks.** A track may find that it needs a change in a file the other track owns. It then:
- writes the need under the other track's heading in the shared notes file `read-aloud-plan-3-tracks.md` (folder `/Users/lvt53/Library/Application Support/Claude/side-session-notes/local_5a3f641c-81d8-4f8a-a314-44d9e540ab5e/`);
- goes on with the rest of its work.

Each track reads that file at the start of every task and does what is under its heading first. Each track also writes its branch name at the top of the file when it starts.

**Progress.** At the end of every task, each track adds to its own hand-over note in the same folder (`read-aloud-plan-3-a-handover.md` or `…-b-handover.md`): the branch, the tip, the task done and any deviation from this plan.

**The end.** One Opus review of the whole branch, then the gate, both in Task 14 on Track B. Neither track runs `scripts/gates.sh` before then.

---

### Task 1: The voice design module (Track A)

**Files:**
- Create:
  - `src/lib/shared/read-aloud/voice-knobs.ts` and `voice-knobs.test.ts`;
  - `src/lib/shared/read-aloud/voice-samples.ts` and `voice-samples.test.ts`.
- Modify: `tests/integration/english-request-purity.test.ts`. Add a `HUNGARIAN_BY_DESIGN` entry: `"lib/shared/read-aloud/voice-samples.ts": "the Hungarian sample the voice editor plays; spoken by the speech service, never sent to a model"`.

**Interfaces:**
- Consumes: nothing.
- Produces, in `voice-knobs.ts` (no imports):
  - `type VoiceLanguage = "en" | "hu"`.
  - `KNOB_KEYS = ["pace", "pitch", "depth", "energy", "projection"] as const`; `type KnobKey`; `type Knobs = Record<KnobKey, number>`; `ZERO_KNOBS: Knobs`.
  - `type KnobSpec = { key: KnobKey; min: number; max: number; words: number; wordBounds: readonly number[] }`. `wordBounds` is each word's highest value, low to high; the last word has none (`wordBounds.length === words − 1`).
  - `KNOBS: readonly KnobSpec[]`, from spec §4.6's ranges and the prototype's `words` functions. The prototype writes some bands with `<`; on the 0.05 grid `v < −0.6` is `v ≤ −0.65`, and so on.

    | key | min | max | words | wordBounds |
    |---|---|---|---|---|
    | pace | −2 | 2 | 7 | −1.25, −0.65, −0.15, 0.1, 0.6, 1.25 |
    | pitch | −2 | 2 | 6 | −1.25, −0.65, −0.15, 0.1, 1.25 |
    | depth | 0 | 4 | 4 | 0.1, 1.5, 3 |
    | energy | −4 | 4 | 7 | −2.5, −1.25, −0.25, 0.2, 1.2, 2.5 |
    | projection | −1.5 | 2 | 7 | −0.9, −0.35, −0.15, 0.1, 0.5, 1.2 |
  - `KNOB_STEP = 0.05`; `SNAP_SHARE = 0.04`.
  - `type StyleKey = "original" | "bedtime" | "storyteller" | "brisk" | "calmAndClear" | "cheerful" | "newsreader"`; `STYLES: readonly { key: StyleKey; knobs: Knobs }[]`, in the spec's order and with its values.
  - `type ControlName = "delivery.tempo" | "pitch.pitch" | "texture.deep" | "mood.arousal" | "delivery.whisper" | "delivery.loud"`.
  - `type SafeRanges = Record<VoiceLanguage, Record<ControlName, { min: number; max: number }>>`; `SAFE_CONTROL_RANGES: SafeRanges`. Today both languages hold the spec's ranges: tempo −2…2, pitch −2…2, deep 0…4, arousal −4…4, whisper 0…1.5, loud 0…2. Task 15 narrows them from the box.
  - `snapKnob(key: KnobKey, value: number): number`:
    - a value that is not a finite number is 0;
    - clamp to the knob's range;
    - 0 when |v| is less than `SNAP_SHARE` × (max − min);
    - round to `KNOB_STEP`.
  - `knobsToControls(knobs: Knobs, language: VoiceLanguage, safe: SafeRanges = SAFE_CONTROL_RANGES): Partial<Record<ControlName, number>>`:
    - each knob goes through `snapKnob`, and a 0 sends nothing;
    - Pace → tempo, Pitch → pitch, Depth → deep, Energy → arousal;
    - Projection below 0 → whisper = −v; above 0 → loud = v;
    - each control is clamped to its safe range for the language and rounded to 3 decimals.
  - `knobWordIndex(key: KnobKey, value: number): number`. It compares on the 0.05 grid: `Math.round(value * 20)` against `Math.round(bound * 20)`.
  - `matchingStyle(knobs: Knobs): StyleKey | null`. The values must be equal on the 0.05 grid; zero knobs give `"original"`.
  - `type NameParts = { kind: "style"; style: Exclude<StyleKey, "original"> } | { kind: "changes"; changes: Array<{ key: KnobKey; word: number }> } | { kind: "mine" }`, and `nameParts(knobs: Knobs): NameParts`, the prototype's `syncName`:
    - a matching style other than Original;
    - else the knobs whose |v| / (max − min) exceeds 0.08, biggest first (ties in `KNOB_KEYS` order), at most two;
    - else `mine`.
  - `summaryKnobs(knobs: Knobs): KnobKey[]`: the knobs with |v| > 0.3, in `KNOB_KEYS` order. They make the "slower, very calm" line under a saved voice.
  - `VOICE_NAME_MAX = 40`; `clipVoiceName(name: string): string`, trimmed and cut to 40 code points.
  - `PERSONAL_VOICES_MAX = 50`.
  - `READING_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const`; `isReadingSpeed(value: unknown): value is number`.
- Produces, in `voice-samples.ts`:
  - `VOICE_SAMPLES: Record<VoiceLanguage, readonly [string, string]>`, exactly:
    - en: `"Here's the short version: feed it once a day, keep it somewhere warm, and it will double in about six hours."` and `"Shall I read you the long one?"`;
    - hu: `"Röviden: ha minden nap eteted, és meleg helyen tartod, körülbelül hat óra alatt megduplázódik."` and `"Elolvassam a hosszabb változatot is?"`.
  - `OWN_WORDS_MAX = 300`; `ownWords(text: string): string | null`. The text is trimmed; null when it is empty, longer than 300 code points, or holds no letter or digit (`/[\p{L}\p{N}]/u`).

- [ ] **Step 1: Write the failing tests.** In `voice-knobs.test.ts`:
  - `holds the spec's five sliders, in order, with their ranges`.
  - `holds the seven styles with the spec's values`.
  - `maps each style to the controls the owner approved on the box`: these are the listening pack's controls (2026-11-16), the same in both languages:

    | Style | Controls |
    |---|---|
    | original | `{}` |
    | bedtime | `{"delivery.tempo": -1, "texture.deep": 1, "mood.arousal": -2.5, "delivery.whisper": 0.6}` |
    | storyteller | `{"delivery.tempo": -0.5, "mood.arousal": 1.5, "delivery.loud": 0.5}` |
    | brisk | `{"delivery.tempo": 1.25, "mood.arousal": 1, "delivery.loud": 0.5}` |
    | calmAndClear | `{"delivery.tempo": -0.5, "mood.arousal": -1.5, "delivery.loud": 1}` |
    | cheerful | `{"delivery.tempo": 0.5, "pitch.pitch": 0.5, "mood.arousal": 2.5, "delivery.loud": 0.5}` |
    | newsreader | `{"delivery.tempo": 0.25, "texture.deep": 1, "mood.arousal": -0.5, "delivery.loud": 1.5}` |
  - `clamps each control to a narrower safe range of its language`. With `hu` tempo `{min: -1.5, max: 1}` and whisper `{min: 0, max: 1}`:
    - pace 2 → tempo 1; pace −2 → −1.5; pace −1 → −1, unchanged;
    - projection −1.5 → whisper 1;
    - the same knobs in `en` are unchanged.
  - `clamps a stored value beyond its slider and ignores a value that is not a number`: pace 7 → tempo 2; energy −9 → −4; `NaN`, `Infinity` and a string cast to a number send nothing.
  - `snaps to normal within 4% of the range and rounds to 0.05`: pace 0.15 → 0; pace 0.2 → 0.2; energy 0.3 → 0; energy 0.35 → 0.35; projection 0.1 → 0; pace 1.234 → 1.25; pitch 9 → 2.
  - `names each band as the prototype does`:
    - pace: −1.25→0, −1.2→1, −0.65→1, −0.6→2, −0.15→2, −0.1→3, 0.1→3, 0.15→4, 0.6→4, 0.65→5, 1.25→5, 1.3→6;
    - pitch: 1.25→4, 1.3→5;
    - depth: 0→0, 0.15→1, 1.5→1, 1.55→2, 3→2, 3.05→3;
    - energy: −2.5→0, −2.45→1, −1.25→1, −1.2→2, −0.25→2, −0.2→3, 0.2→3, 0.25→4, 1.2→4, 1.25→5, 2.5→5, 2.55→6;
    - projection: −0.9→0, −0.85→1, −0.35→1, −0.3→2, −0.15→2, −0.1→3, 0.1→3, 0.15→4, 0.5→4, 0.55→5, 1.2→5, 1.25→6.
  - `finds the style the knobs match`: zero → original; Bedtime's knobs → bedtime; Bedtime with pace −0.95 → null.
  - `suggests a style, the two biggest changes or none`:
    - Bedtime → `{kind: "style", style: "bedtime"}`;
    - pace −1 and energy −3 → changes `[{key: "energy", word: 0}, {key: "pace", word: 1}]`;
    - pace −0.6 and energy 1.2, a tie at 0.15 → pace first;
    - depth 0.3 alone (0.075) → `mine`;
    - three changes keep the two biggest.
  - `summarises the knobs moved by more than 0.3`: Bedtime → pace, depth, energy, projection.
  - `cuts a name to 40 code points`: `"  " + "é".repeat(45)` → 40 é; an emoji counts as one.

  In `voice-samples.test.ts`:
  - `holds two sentences per language, each within the preview's 300 characters, the second a question`.
  - `takes the person's words only when they hold a letter or a digit`: `"  "` → null; `"→ ★ …"` → null; 301 letters → null; `"  Hello there. "` → `"Hello there."`; `"42"` → `"42"`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/shared/read-aloud/voice-knobs.test.ts src/lib/shared/read-aloud/voice-samples.test.ts`.
- [ ] **Step 3: Implement both modules,** and add the purity entry.
- [ ] **Step 4: Run them and see them pass,** together with `tests/integration/english-request-purity.test.ts`.
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): the voice design module: knobs, styles, safe ranges and samples" -m "Plan-3-Task: 1"`

### Task 2: Storage, the personal-voice service and the voice list (Track A)

**Files:**
- Modify `src/lib/server/db/schema.ts`:
  - `users` gains `readAloudEnVoice: text("read_aloud_en_voice")`, `readAloudHuVoice: text("read_aloud_hu_voice")` and `readAloudSpeed: real("read_aloud_speed").notNull().default(1)`;
  - a new table `readAloudVoices`, below.
- Create `drizzle/1777140000130_read_aloud_voices.sql`, and add its entry to `drizzle/meta/_journal.json`: `idx` 143, `when` 1777140000130, `tag` `1777140000130_read_aloud_voices`, `breakpoints: true`, `version` `"7"` (as in most entries).
- Modify `src/lib/server/services/account-lifecycle/user-scoped-tables.ts`: register `read_aloud_voices` with erasure `cascade` and resets `[]` (Decision 18).
- Modify `src/lib/server/db/AGENTS.md`:
  - add `read_aloud_voices` to the overview;
  - say that account-level settings are columns on `users` (its `user_preferences` line names a table that does not exist).
- Modify `src/lib/server/services/read-aloud/voices.ts` and `voices.test.ts`.
- Create `src/lib/server/services/read-aloud/personal-voices.ts` and `personal-voices.test.ts`.
- Modify `src/lib/server/services/read-aloud/AGENTS.md` (Step 5).

**The table:**
- **Columns:**
  - `id` (text primary key);
  - `user_id` (text, not null, references `users.id` on delete cascade);
  - `name` (text, not null);
  - `base_voice` (text, not null);
  - `language` (text, not null: the base's language when saved);
  - `pace`, `pitch`, `depth`, `energy`, `projection` (real, not null, default 0);
  - `created_at` and `updated_at` (integer timestamps, default `unixepoch()`).
- **Index:** `read_aloud_voices_user_created_idx` on `(user_id, created_at)`.
- **The migration** is expand-only, with statement breakpoints, and it opens with a comment on what it is for, as `1777140000126_normal_chat_run_log.sql` does. It holds:
  - `CREATE TABLE` with `FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade`;
  - `CREATE INDEX`;
  - three `ALTER TABLE \`users\` ADD …`, the last `\`read_aloud_speed\` real DEFAULT 1 NOT NULL`.

**Interfaces:**
- Consumes: Task 1.
- Produces, in `voices.ts`:
  - `export type { VoiceLanguage } from "$lib/shared/read-aloud/voice-knobs"`, in place of its own declaration (the same type).
  - `builtInVoice(key: string): BuiltInVoice | null`.
  - `RETIRED_BUILT_IN_VOICES: Readonly<Record<string, { name: string; language: VoiceLanguage }>>`, empty today.
  - `type ResolvedVoice = { speakerId: string; controls: Record<string, number>; charsPerSecond: number }`.
  - `resolvedVoice(voice: BuiltInVoice, knobs: Knobs = ZERO_KNOBS): ResolvedVoice`, with `controls: { ...voice.controls, ...knobsToControls(knobs, voice.language) }`.
  - `defaultVoiceFor` stays, as the fallback.
- Produces, in `personal-voices.ts`:
  - `type VoiceDraft = { name: string; base: string; knobs: Knobs }`.
  - `type PersonalVoice = { id: string; name: string; base: string; baseName: string; language: VoiceLanguage; knobs: Knobs; baseMissing: boolean }`. `baseName` comes from `BUILT_IN_VOICES`, else `RETIRED_BUILT_IN_VOICES`, else the key with its first letter capitalised.
  - `type VoiceChoice = Record<VoiceLanguage, string>`. An unset choice answers the language's default key.
  - `type ReadAloudSettings = { voices: PersonalVoice[]; choice: VoiceChoice; defaultSpeed: number }`.
  - `class UnknownVoice extends Error` and `class TooManyVoices extends Error`.
  - `readAloudSettingsFor(userId: string): Promise<ReadAloudSettings>`, voices oldest first.
  - `createPersonalVoice(userId: string, draft: VoiceDraft): Promise<PersonalVoice>`:
    - the id is `randomUUID()`;
    - the name goes through `clipVoiceName`, and each knob through `snapKnob`;
    - `language` is the base's;
    - it throws `UnknownVoice` for a base that is not a built-in voice, and `TooManyVoices` for a 51st voice.
  - `updatePersonalVoice(userId: string, id: string, patch: Partial<VoiceDraft>): Promise<PersonalVoice | null>`:
    - null when the voice is not the person's;
    - a base in the other language moves the voice there, and a choice that pointed at it in the old language goes back to null.
  - `deletePersonalVoice(userId: string, id: string): Promise<VoiceChoice | null>`:
    - null when the voice is not the person's;
    - in one transaction, a choice that points at the voice becomes the voice's base key, and the row goes;
    - it answers the choice after that.
  - `setReadAloudPreferences(userId: string, next: { en?: string; hu?: string; defaultSpeed?: number }): Promise<{ choice: VoiceChoice; defaultSpeed: number }>`. A choice must be a built-in voice of that language or one of the person's voices of that language; anything else throws `UnknownVoice`.
  - `resolveReadingVoices(userId: string): Promise<{ voices: Record<VoiceLanguage, ResolvedVoice>; defaultSpeed: number }>`. For each language:
    - unset → `defaultVoiceFor(language)`;
    - a built-in key of that language → that voice;
    - one of the person's voices of that language, whose base is a built-in voice of that language → `resolvedVoice(base, knobs)`;
    - anything else (another person's id, a deleted id, a voice whose base is gone) → `defaultVoiceFor(language)`, with no knobs.

    The Default speed is the stored value when `isReadingSpeed` accepts it, else 1.
  - Every query carries `eq(readAloudVoices.userId, userId)` or `eq(users.id, userId)`.

- [ ] **Step 1: Write the failing tests.** `personal-voices.test.ts` runs against a real migrated SQLite file, the way `tests/cross-cutting/isolation.test.ts` does: `vi.mock("$lib/server/db")` over a throwaway file migrated from `drizzle/`, with two made-up people, `user-a` and `user-b`.
  - `a new person reads with Imogen and Berta at 1×`.
  - `creates, lists, edits and deletes a voice of one's own`: the name `"  Test Voice  "` is stored as `"Test Voice"`, and a pace of 0.1234 is stored snapped.
  - `never lists, changes, deletes or reads another person's voice`. Make a voice for A, then:
    - B's list is empty;
    - `updatePersonalVoice("user-b", aId, { name: "x" })` → null, and A's row is unchanged;
    - `deletePersonalVoice("user-b", aId)` → null, and the row is kept;
    - `setReadAloudPreferences("user-b", { en: aId })` throws `UnknownVoice`;
    - A's id written straight into B's `read_aloud_en_voice` resolves to Imogen, with Imogen's controls.
  - `deleting the chosen voice gives the choice back to its base`: a Savannah-based voice is chosen for English; after the delete, `choice.en` is `"savannah"` and a reading resolves to Savannah's speaker.
  - `a choice is of its own language`: `{ en: "berta" }` throws; `{ hu: <an English voice of the person> }` throws; `{ en: "rupert" }` gives `choice.en` `"rupert"`.
  - `moving a chosen voice to another language returns that choice to the default`.
  - `refuses a 51st voice`.
  - `a personal voice reads with its base's speaker and its knobs on top of the base's controls`: Berta with Bedtime → `default_bf7632822e6b4dc0`, `{"room.clean": 2, "delivery.tempo": -1, "texture.deep": 1, "mood.arousal": -2.5, "delivery.whisper": 0.6}`.
  - `a voice whose base is gone is listed with baseMissing and reads as its language's default`: insert a row whose base is `"gone"`.
  - `reads a stored speed that is not one of the six as 1×`.
  - `deleting the person deletes their voices`.

  In `voices.test.ts`:
  - `finds a built-in voice by key`;
  - `resolves a built-in voice with its knobs on top of its own controls`.

  `account-lifecycle.test.ts` holds a completeness guard built from the schema, so it covers the registration.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/server/services/read-aloud src/lib/server/services/account-lifecycle`.
- [ ] **Step 3: Implement** the schema, the migration, the registration and both modules.
- [ ] **Step 4: Run them and see them pass,** then run `npm run check:migrations`.
- [ ] **Step 5: Replace the Voices rule** in the read-aloud `AGENTS.md`, held by `personal-voices.test.ts`:
  - built-in voices are configuration in code;
  - a personal voice is its maker's only, and every query filters by the person's id;
  - the choice is resolved per language at each reading, and a deleted chosen voice gives the choice to its base;
  - knob values are stored as slider values and made into controls only by `knobsToControls`.
- [ ] **Step 6: Commit.** `git commit -m "feat(read-aloud): personal voices and the voice choice, private to each person" -m "Plan-3-Task: 2"`

### Task 3: Readings use the person's voices and Default speed (Track A)

**Files:**
- Modify:
  - `src/lib/server/services/read-aloud/request.ts`;
  - `src/routes/api/read-aloud/sessions/+server.ts`;
  - `src/routes/api/read-aloud/sessions/sessions.test.ts`;
  - `src/lib/server/services/read-aloud/index.ts`.

**Interfaces:**
- Consumes: Task 2 (`resolveReadingVoices`, `ResolvedVoice`).
- Produces:
  - `speechSentencesFor(request: ReadingRequest, voices: Record<VoiceLanguage, ResolvedVoice>): SpeechSentence[]`;
  - `charsPerSecondByLanguage(voices: Record<VoiceLanguage, ResolvedVoice>): { en: number; hu: number }`;
  - the index exports `resolveReadingVoices`.
- **The route:** after the containment check and before `openReading`, `const { voices, defaultSpeed } = await resolveReadingVoices(user.id)`. It answers that `defaultSpeed`, and the answer's shape does not change.

- [ ] **Step 1: Write the failing tests** in `sessions.test.ts`. Mock `$lib/server/services/read-aloud/personal-voices` the way the file mocks the conversation service, defaulting to Imogen and Berta at 1×.
  - `reads each language with the person's chosen voice`: Rupert and Imre → their speaker ids, Imre with `room.clean` 2.
  - `a personal voice sends its base's speaker and its knobs' controls`.
  - `answers the person's Default speed and their voices' speaking rates`.

  The existing `201 with Imogen for English and Berta with room.clean 2 for Hungarian` stays green, unchanged.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/routes/api/read-aloud/sessions`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): readings use the person's voices and Default speed" -m "Plan-3-Task: 3"`

### Task 4: The voice and preference routes (Track A)

**Files:**
- Create:
  - `src/lib/server/services/read-aloud/voice-requests.ts`;
  - `src/routes/api/read-aloud/voices/+server.ts`, `src/routes/api/read-aloud/voices/[id]/+server.ts` and `src/routes/api/read-aloud/preferences/+server.ts`;
  - `src/routes/api/read-aloud/voices/voices.test.ts`.
- Modify: `src/lib/server/services/read-aloud/index.ts`.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces:
  - **The routes** of the contract. Each one:
    - calls `requireApiUser`;
    - answers 404 `read_aloud_off` when the feature is off, and 400 `invalid_request` for a body that fails to parse or fails its schema;
    - answers 400 `unknown_voice` for `UnknownVoice`, 409 `too_many` for `TooManyVoices`, and 404 `not_found` when the service answers null.

    `GET` answers `builtIn` from `BUILT_IN_VOICES` as `{key, name, language}`.
  - **`voice-requests.ts`** (zod), used by these routes and by Task 5:
    - `knobsSchema`: an object of exactly the five keys, each `z.number().finite()` within its knob's `[min, max]`;
    - `voiceDraftSchema`: `name`, a string whose trimmed form is 1–40 code points; `base`, a string of 1–40 characters; `knobs`;
    - `voicePatchSchema`: its partial, with at least one field;
    - `preferencesSchema`: `{ en?: string (1–100), hu?: string (1–100), defaultSpeed?: one of READING_SPEEDS }`, with at least one field;
    - `previewRequestSchema`: `{ base: string (1–40), knobs, text?: string (at most 2000; the route applies `ownWords`) }`.

- [ ] **Step 1: Write the failing tests** in `voices.test.ts`. They run in node, through the real service over a real migrated database, as in Task 2, so that privacy is proven through the routes. Mock only the user on the event and `getReadAloudUrl`.
  - `401 without a user; 404 read_aloud_off when the feature is off`.
  - `lists the built-in voices, the person's voices, the choice and the speed`.
  - `creates a voice: 201 with its snapped knobs and trimmed name`.
  - `400 for knobs out of range, not numbers or missing, and for a name of 41 characters or only spaces`.
  - `400 unknown_voice for a base that is not a built-in voice`.
  - `409 too_many for a 51st voice`.
  - `edits and deletes one's own voice; DELETE answers the choice after`.
  - `answers 404 for another person's voice and 400 for choosing it`. As B: PATCH and DELETE of A's id → 404, with A's row unchanged; PUT `{ en: aId }` → 400 `unknown_voice`.
  - `saves a choice and a Default speed; 400 for a speed that is not one of the six`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/routes/api/read-aloud/voices`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): routes for personal voices and the voice choice" -m "Plan-3-Task: 4"`

### Task 5: The preview (Track A)

**Files:**
- Modify:
  - `src/lib/server/services/read-aloud/speech-client.ts` (adds `previewSpeech`);
  - `testing/fake-speech-service.ts` and `fake-speech-service.test.ts`;
  - `index.ts`;
  - the read-aloud `AGENTS.md`: a Preview rule, and the fake's new options.
- Create:
  - `src/lib/server/services/read-aloud/mp3-join.ts` and `mp3-join.test.ts`;
  - `src/lib/server/services/read-aloud/preview.ts` and `preview.test.ts`;
  - `src/routes/api/read-aloud/preview/+server.ts` and `preview.test.ts`.

**Interfaces:**
- Consumes: Tasks 1, 2 and 4 (`VOICE_SAMPLES`, `ownWords`, `builtInVoice`, `resolvedVoice`, `previewRequestSchema`); Plan 2's `silentMp3` (`src/lib/shared/read-aloud/silent-mp3.ts`).
- Produces:
  - **`previewSpeech(baseUrl: string, body: { text: string; language: VoiceLanguage; voice: { speaker_id: string; controls: Record<string, number> } }, signal?: AbortSignal): Promise<Uint8Array>`.**
    - A 200 gives the bytes.
    - A 500, 502 or 503, a network failure, or no answer within `PREVIEW_TIMEOUT_MS` (30 000) is `SpeechUnavailable`.
    - A 422 is `SpeechRefused(422, field)`.
    - An abort through `signal` rejects with the signal's reason.
  - **`mp3-join.ts`:**
    - `class Mp3Unreadable extends Error`.
    - `readMp3(bytes: Uint8Array): { frames: Uint8Array; seconds: number }`.
      - It drops a leading ID3v2 tag: a 10-byte header, the size syncsafe, plus 10 when the footer flag `0x10` is set. It also drops a trailing 128-byte ID3v1 tag (`TAG`).
      - It walks the frames. Every header must be MPEG-1 Layer III, 44 100 Hz and mono, which is the service's format (README, "The audio").
      - A frame is `floor(144 × bitrate / 44100) + padding` bytes long, and `seconds = frames × 1152 / 44100`.
      - Anything else is `Mp3Unreadable`.
    - `joinMp3(clips: readonly Uint8Array[], gapSeconds: number): { audio: Uint8Array; sentences: Array<[number, number]> }`: the clips' frames in order, with `silentMp3(gapSeconds)` between them, and each clip's `[start, end]` on the joined clock, rounded to the millisecond.
  - **`preview.ts`:**
    - `class PreviewSuperseded extends Error`.
    - `renderPreview(input: { userId: string; baseUrl: string; voice: ResolvedVoice; language: VoiceLanguage; sentences: readonly string[] }): Promise<{ audio: Uint8Array; sentences: Array<[number, number]> }>`:
      - one `previewSpeech` per sentence, all at once;
      - the clips are joined with a 0.30 s gap, Plan 1's gap between sentences;
      - one preview per person: a newer call for the same person aborts the older call's requests, and the older call rejects with `PreviewSuperseded`.
  - **The route `POST /api/read-aloud/preview`,** in this order:
    1. `requireApiUser`; when the feature is off, 404.
    2. The body, by `previewRequestSchema`: 400 `invalid_request`.
    3. A base that is not a built-in voice: 400 `unknown_voice`.
    4. The sentences: without `text`, `VOICE_SAMPLES[base.language]`; with `text`, `[ownWords(text)]`, where null is 400 `invalid_request`.
    5. `renderPreview` with `resolvedVoice(base, knobs)`.
    6. 200 with the contract's headers.

    Failures:
    - `PreviewSuperseded` → 409 `superseded`;
    - `SpeechRefused` with field `text` → 422 `nothing_to_say`;
    - anything else → 503 `voice_unavailable`, logging only the status and the field, never a word.
  - **The fake's `POST /v1/preview`:**
    - It checks the body as the service does (README, "What a request may hold": a text of 1–300 characters with something speakable, a language, a voice) and answers 422 with the field.
    - With `failPreview: "unavailable"` it answers 503 `{"code": "zonos_unavailable"}`, and with `"failed"` 502 `{"code": "synthesis_failed"}`.
    - Otherwise, after `previewDelayMs` (default 0), it answers a 10-byte ID3v2 header (size 0) and `silentMp3(text.length × secondsPerChar)`, with `Content-Type: audio/mpeg` and a `Content-Length`.
    - It records each accepted body in `previews: FakePreview[]`, where `type FakePreview = { text: string; language: string; voice: { speaker_id: string; controls: Record<string, number> } }`.
    - `FakeSpeechOptions` gains `failPreview?: "unavailable" | "failed"` and `previewDelayMs?: number`.

- [ ] **Step 1: Write the failing tests.**
  - `mp3-join.test.ts`:
    - `reads the length of a clip from its frames, after its ID3 tag`.
    - `joins two clips with a 0.30 s gap and says where each starts and ends`: clips of 10 and 20 silent frames give `[[0, 0.261], [0.575, 1.097]]`. The gap is `silentMp3(0.3)`, 12 frames.
    - `refuses a clip that is not 44.1 kHz mono Layer III`.
    - `drops a trailing ID3v1 tag`.
  - `preview.test.ts` (node, against the fake):
    - `renders the two sample sentences in one call each and joins them`.
    - `sends the base's speaker and the knobs' controls`: Berta with Bedtime → the fake's preview voice is `{speaker_id: "default_bf7632822e6b4dc0", controls: {"room.clean": 2, "delivery.tempo": -1, "texture.deep": 1, "mood.arousal": -2.5, "delivery.whisper": 0.6}}`.
    - `a later preview of the same person supersedes the earlier one`: with `previewDelayMs` 200, the first rejects with `PreviewSuperseded` and its requests are aborted.
    - `two people's previews do not touch each other`.
    - `503 and 502 from the service are SpeechUnavailable, 422 is SpeechRefused with its field`.
  - The route's `preview.test.ts` (node; the fake, with `getReadAloudUrl` mocked to the fake's address):
    - `401; 404 read_aloud_off`.
    - `400 for a body that is not a preview request, and unknown_voice for a base that is not a built-in voice`.
    - `answers the joined MP3 with Content-Length, no-store and the sentences' times`.
    - `reads the person's words instead of the sample`: the fake has one preview, with the trimmed text.
    - `400 for words with nothing to say`.
    - `409 superseded for a preview a later one overtook`.
    - `503 voice_unavailable when the service fails, and the log line carries no text`.
  - `fake-speech-service.test.ts`:
    - `answers a preview with an ID3 tag and silent frames as long as its text`.
    - `refuses a preview body the way the service does`.
    - `fails a preview on demand`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/server/services/read-aloud src/routes/api/read-aloud/preview`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Add a Preview rule to the read-aloud `AGENTS.md`:**
  - one preview per person;
  - one call per sentence, joined with 0.30 s;
  - nothing cached and nothing logged but statuses and fields;
  - the address only from `getReadAloudUrl()`.
- [ ] **Step 6: Commit.** `git commit -m "feat(read-aloud): the voice preview route, one call per sentence, joined" -m "Plan-3-Task: 5"`

### Task 6: Personal voices in the account's data archive (Track A)

**Files:**
- Modify:
  - `src/lib/server/services/account-data-archive/index.ts`;
  - `src/lib/server/services/account-data-archive/index.test.ts`.

**Interfaces:**
- Consumes: Task 2 (the schema).
- Produces:
  - an archive page `Read aloud.html` (title "Read aloud") that lists:
    - the English voice, the Hungarian voice and the Default speed;
    - each personal voice: its name, its base voice and its five values;
  - a link to the page on the archive's index;
  - the index's description, which names "read-aloud voices" among the sections.

  The archive is in English, as it is today.

- [ ] **Step 1: Write the failing test** `the archive holds the person's read-aloud voices and choice, and no one else's`.
- [ ] **Step 2: Run it and see it fail.** Run `npx vitest run src/lib/server/services/account-data-archive`.
- [ ] **Step 3: Implement it** the way `addSkillsSection` and `listUserSkills` do.
- [ ] **Step 4: Run it and see it pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): personal voices in the account's data archive" -m "Plan-3-Task: 6"`

### Task 7: The script that measures the knobs' safe ranges (Track A)

**Files:**
- Create `deploy/speech-service/scripts/measure_knobs.py` and `deploy/speech-service/tests/test_measure_knobs.py`.
- Modify `deploy/speech-service/README.md`: under "Measured on the box", a "Knob ranges" paragraph that says how to run the script; the numbers come in Task 15.
- Modify `deploy/speech-service/AGENTS.md`: one line, "`scripts/` holds checks run by hand (the live check, the knob ranges); they write only into the `--out` folder they are given, never into the repository".

**Interfaces:**
- **The command:** `python -I scripts/measure_knobs.py --out DIR [--zonos URL] [--aligner-cli PATH --aligner-model PATH --aligner-threads N] [--seeds N] [--voices KEY,…]`.
  - It writes `DIR/knob-ranges.json`, and prints a summary and a `SAFE_CONTROL_RANGES` object to paste into `voice-knobs.ts`.
  - Exit status: 0 when the sweep ran, whatever it found; 1 when it could not run (Zonos or the aligner unreachable); 2 for a bad argument.
- **Reuse.** It puts its folder's parent on `sys.path` and uses `speech_service.aligner` (`NativeFuseAligner`, `resample_16k`), so words are timed exactly as in a reading. Otherwise it needs only httpx, numpy and soundfile.
- **Constants,** each copied from `voices.ts` or `voice-knobs.ts`, with a comment that says so:
  - the six voices: key, speaker id, language and default controls;
  - the samples, both sentences of a language as one text (at most 300 characters);
  - the doses, from 0 toward each of the spec's ends:

    | Control | Doses |
    |---|---|
    | tempo | ±0.5, ±1, ±1.5, ±2 |
    | pitch | ±0.5, ±1, ±1.5, ±2 |
    | deep | 1, 2, 3, 4 |
    | arousal | ±1, ±2, ±3, ±4 |
    | whisper | 0.5, 1, 1.5 |
    | loud | 0.5, 1, 1.5, 2 |
  - the seeds: 1234 (the service's) and two more, three in all by default;
  - the baseline: 5 seeds with no control.
- **The Zonos request** is the prototype relay's: `POST {zonos}/v2/generate` with `{"text", "language": "en_us" | "hu", "format": "wav", "stream": false, "speaker_embedding_id", "speaker_mode": "embedding", "seed", "controls"}` and nothing else, because Zonos refuses unknown fields. At most two requests run at once (Zonos's `--batch 2`), through `httpx.AsyncClient`.
- **Functions:**
  - `clip_metrics(x: np.ndarray, sr: int) -> Metrics`:
    - `seconds`;
    - `clipped`: the share of samples with |x| ≥ 0.999;
    - `longest_gap`: the longest run of 20 ms frames more than 40 dB below the clip's 90th-percentile frame level, not counting leading or trailing silence.
  - `placed(aligner, x: np.ndarray, sr: int, words: list[str]) -> int`: how many words the aligner timed.
  - `clip_problems(m: Metrics, placed: int, words: int, baseline: Baseline, control: str) -> list[str]`, one reason for each failure (Decision 16):
    - a word was not placed;
    - `clipped` exceeds the baseline's highest by more than 0.001;
    - `longest_gap` exceeds max(0.8 s, 1.5 × the baseline's longest);
    - `seconds` lies outside 0.5–2.0 × the baseline's median (tempo: 0.4–2.5 ×).
  - `safe_end(doses: list[float], safe: dict[float, bool]) -> float`. Walking out from 0, it returns the last safe dose before the first unsafe one: 0 when the first is unsafe, and never beyond the spec's end. A dose is safe for a language when no clip at it (each voice of that language, at each seed) has a problem.
- **The report:** for each language, control and direction:
  - the spec's end and the safe end;
  - the first unsafe dose, with its voice, seed and reasons;
  - every clip's metrics.

  No audio, and no text but the samples.

- [ ] **Step 1: Write the failing tests** in `tests/test_measure_knobs.py`. Use `tests/fakes_zonos.py` and the `FakeAligner` of `tests/fakes_aligner.py`.
  - `test_clip_metrics_counts_clipping_and_the_longest_inner_gap`: a synthetic tone with a 1 s hole and 2% of its samples clipped.
  - `test_a_dropped_word_fails_the_clip`: an aligner that answers None for one word.
  - `test_safe_end_stops_before_the_first_unsafe_dose`.
  - `test_never_reports_beyond_the_spec`.
  - `test_a_dose_is_unsafe_for_a_language_when_any_voice_or_seed_fails`.
  - `test_sends_only_the_fields_zonos_knows`.
  - `test_runs_end_to_end_on_the_fakes_and_writes_only_the_report`: the `--out` folder (`tmp_path`) then holds only `knob-ranges.json`.
- [ ] **Step 2: Run them and see them fail.** From `deploy/speech-service`, run `.venv/bin/python -m pytest -q tests/test_measure_knobs.py`. Make the venv first if it is missing, with the commands in its AGENTS.md.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then the whole suite, and see them pass.** Run `.venv/bin/python -m pytest -q`.
- [ ] **Step 5: Commit.** `git commit -m "feat(speech): a script that measures the knobs' safe ranges" -m "Plan-3-Task: 7"`

### Task 8: The player's pill, shared by the floating player and the editor (Track B)

**Files:**
- Create: `src/lib/components/read-aloud/ReadAloudPlayerPill.svelte` and `ReadAloudPlayerPill.test.ts`.
- Modify:
  - `ReadAloudPlayer.svelte` and `ReadAloudNote.svelte`;
  - `src/lib/client/read-aloud/controller.ts`: the type below, and nothing else.

**Interfaces:**
- Consumes: Plan 2's `ReadAloudView`, `ReadAloudScrubber` and `ReadAloudSpeedMenu`.
- Produces:
  - in `controller.ts`, `type ReadAloudPlayerActions = Pick<ReadAloudController, "toggle" | "retry" | "seek" | "beginDrag" | "dragTo" | "endDrag" | "sentencePreview"> & Partial<Pick<ReadAloudController, "setSpeed" | "locate" | "stop">>`;
  - **`ReadAloudPlayerPill`,** with props `{ view: ReadAloudView; actions: ReadAloudPlayerActions; variant: "floating" | "inline" }`:
    - It is the `.read-aloud-pill` element and everything inside it today, moved out of `ReadAloudPlayer.svelte` with its classes, data attributes and styles.
    - `inline` draws no ⌖, speed chip, ✕ or "Finished" (Decision 2).
    - A `count` of 0 disables ⏮, ⏭ and the scrubber.
  - **`ReadAloudPlayer.svelte`** keeps the slot, its animation, the notes and the stop on leaving, and draws `<ReadAloudPlayerPill variant="floating" view={view} actions={reader()} />`.
  - **`ReadAloudNote`** gains `placement: "inline"`: in the flow, at full width, with no arrow and no absolute position.

- [ ] **Step 1: Write the failing tests:**
  - `the inline pill draws the transport and the scrubber, and no locate, speed or stop`.
  - `calls its actions`: play → `toggle`; stopped → `retry`; ⏮ and ⏭ → `seek(sentence ∓ 1)`.
  - `a pill with no sentences disables stepping and the scrubber`.
  - `an inline note sits in the flow`.

  `ReadAloudPlayer.test.ts` stays unchanged and keeps passing, because the move does not change behaviour.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/components/read-aloud`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "refactor(read-aloud): the player's pill as its own component, floating or inline" -m "Plan-3-Task: 8"`

### Task 9: The words (Track B)

**Files:**
- Modify: `src/lib/i18n/read-aloud.ts` and `src/lib/i18n/read-aloud.test.ts`.

**Interfaces:**
- Consumes: nothing.
- Produces: every key of **Copy**, in both languages.

- [ ] **Step 1: Write the failing tests.** The parity and placeholder tests already cover the new keys. Add:
  - `says the spec's sentences`:
    - `readAloud.settings.empty` in English is the spec's sentence exactly;
    - `readAloud.settings.baseMissingEn`, with `{voice}` = Imogen, reads "Imogen isn't available any more, so this voice reads as your English voice for now.";
    - `editor.sampleFailed`, then a space and `tryAgain`, reads "Couldn't play the sample. Try again.";
    - `editor.saveFailed` followed the same way reads "Couldn't save this voice. Try again.".
  - `names every knob word of the spec, in order`: the English words of each knob equal spec §4.6's lists, and each knob has 7, 6, 4, 7 and 7 words in KNOB_KEYS order.
  - `names every style and built-in voice`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/i18n/read-aloud.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): the words of the voice settings and the editor" -m "Plan-3-Task: 9"`

### Task 10: The client API, the preview player and the suggested name (Track B)

**Files:**
- Create:
  - `src/lib/client/api/read-aloud-voices.ts` and its test;
  - `src/lib/client/read-aloud/voice-preview.ts` and its test;
  - `src/lib/client/read-aloud/voice-name.ts` and its test.
- Modify: `src/lib/stores/read-aloud.ts` and `src/lib/client/read-aloud/AGENTS.md`.

**Interfaces:**
- Consumes:
  - Task 1: `Knobs`, `ZERO_KNOBS`, `VOICE_SAMPLES`, `ownWords`, `nameParts`, `clipVoiceName`;
  - Task 8: `ReadAloudPlayerActions`;
  - from Plan 2: `AudioLike` (`controller.ts`), `formatClock` (`timeline.ts`), `silentMp3DataUri`, and `ApiError`, `requestJson` and `requestResponse` (`http.ts`).
- Produces, in `read-aloud-voices.ts` (the contract, from the browser's side):
  - **Types:**
    - `BuiltInVoiceInfo = { key: string; name: string; language: "en" | "hu" }`;
    - `PersonalVoiceInfo = { id: string; name: string; base: string; baseName: string; language: "en" | "hu"; knobs: Knobs; baseMissing: boolean }`;
    - `VoiceChoice = Record<"en" | "hu", string>`;
    - `ReadAloudVoiceSettings = { builtIn: BuiltInVoiceInfo[]; voices: PersonalVoiceInfo[]; choice: VoiceChoice; defaultSpeed: number }`;
    - `VoiceDraftBody = { name: string; base: string; knobs: Knobs }`;
    - `PreviewRequestBody = { base: string; knobs: Knobs; text?: string }`;
    - `PreviewRender = { blob: Blob; sentences: Array<[number, number]> }`.
  - **Calls:**
    - `fetchReadAloudVoices(fetchImpl?)`;
    - `createReadAloudVoice(draft, fetchImpl?)` and `updateReadAloudVoice(id, patch, fetchImpl?)`, each → `PersonalVoiceInfo`;
    - `deleteReadAloudVoice(id, fetchImpl?)` → `VoiceChoice`;
    - `saveReadAloudChoice(next: { en?: string; hu?: string; defaultSpeed?: number }, fetchImpl?)` → `{ choice; defaultSpeed }`;
    - `renderVoicePreview(body, signal?, fetchImpl?)` → `PreviewRender`. A refusal is the same `ApiError` the other calls throw. The header must parse as `[[number, number], …]`, and anything else is an `ApiError` too.
- Produces, in `src/lib/stores/read-aloud.ts`:
  - `type VoicePreviewView = { owner: string | null; status: "idle" | "loading" | "playing" | "paused" | "failed"; player: ReadAloudView }`;
  - `idleVoicePreviewView`, `voicePreviewView: Readable<VoicePreviewView>` and `setVoicePreviewView(next)`, which only `voice-preview.ts` calls.
- Produces, in `voice-preview.ts`:
  - `type PreviewSound = { owner: string; request: PreviewRequestBody; sentences: readonly string[] }`. `owner` names the button that owns the sound: `"listen"`, `"base:<key>"` or `"voice:<id>"`.
  - `listenSound(input: { base: BuiltInVoiceInfo; knobs: Knobs; compare: "yours" | "original"; words: string | null }): PreviewSound`. Its owner is `"listen"`; Original sends `ZERO_KNOBS`; with `words` (already through `ownWords`), `text` is them and `sentences` is `[words]`, else the base language's sample.
  - `type VoicePreviewDeps = { audio: AudioLike; render: (body: PreviewRequestBody, signal: AbortSignal) => Promise<PreviewRender>; createObjectUrl: (blob: Blob) => string; revokeObjectUrl: (url: string) => void; setView: (view: VoicePreviewView) => void; document: Document; requestFrame: (fn: () => void) => unknown; cancelFrame: (handle: unknown) => void }`.
  - `interface VoicePreview`:
    - `unlock(): void`. The first call plays `silentMp3DataUri()` on the element, synchronously, so iOS allows its later plays; later calls do nothing.
    - `toggle(sound: PreviewSound): void`. For the same owner it pauses, or resumes (from the start, when the sound had finished). For another owner it stops that one, then loads and plays this one.
    - `play(sound: PreviewSound): void` (re)starts this sound from its first sentence, replacing whatever plays. It serves a render on release and Yours / Original.
    - `retry(): void` plays the failed sound again.
    - `seek(i)`, `beginDrag()`, `dragTo(i)`, `endDrag(i)` and `sentencePreview(i)` work on the sound now owned, as the reply controller's do: a drag pauses, and its release resumes from sentence `i`'s start.
    - `stop(): void` pauses and forgets the owner, when the editor closes.
    - `dispose(): void` stops and revokes every object address, when Settings goes.
  - `createVoicePreview(deps): VoicePreview`, and `getVoicePreview(): VoicePreview`, made on first use with one `<audio preload="auto">`.
  - **Behaviour:**
    - **Starts.** A render's answer is used only if no later `toggle`, `play` or `stop` came: each start has a token. Starting a render aborts the one in flight.
    - **Keeping renders.** The last 12 renders are kept, keyed by `JSON.stringify([base, knobs on the 0.05 grid, text ?? null])`. The oldest is evicted and revoked, never the one playing.
    - **While playing,** each animation frame updates `player`:
      - `elapsed` and `total` with `formatClock`;
      - `sentence`: the last sentence whose start ≤ `currentTime`;
      - `notches`: each start divided by the clip's length;
      - `progress`: `currentTime` divided by the length.
    - **States:**
      - loading shows `player.status` `"seeking"` (the pill's spinner);
      - at `ended`, status `paused` and `player.status` `"finished"`;
      - a failed render: status `failed`, `player.status` `"stopped"`, and the pill's Try again calls `retry`.
    - The page going hidden (`visibilitychange`) pauses. The speed is always 1.
  - **The rule in `AGENTS.md`:** replace "Only the controller touches the `<audio>` element and the session routes" with: "The reply controller owns its `<audio>` element and the session routes; the voice preview (`voice-preview.ts`) owns the one element every ▶ in Settings and the editor plays through, and the preview route. Components never touch either element, and never fetch."
- Produces, in `voice-name.ts`: `suggestVoiceName(input: { voiceName: string; knobs: Knobs; t: (key: string, values?: Record<string, string>) => string; locale: "en" | "hu" }): string`. From `nameParts`:
  - a style → `editor.nameStyle`;
  - two changes → `editor.nameTwo`, the words lower-cased in the locale; when that is longer than 40 code points, `editor.nameOne` with the first change;
  - one change → `editor.nameOne`;
  - none → `editor.nameMine`;
  - and last, `clipVoiceName`.

- [ ] **Step 1: Write the failing tests.**
  - `read-aloud-voices.test.ts`:
    - `each call sends its method, address and body`.
    - `renderVoicePreview reads the sentences' times from the header and gives the audio as a blob`.
    - `a refusal is an ApiError with its code`: 409 `too_many`; 503 `voice_unavailable`.
    - `a preview answer without a readable header is refused`.
  - `voice-preview.test.ts`, with a fake `AudioLike` as in `controller.test.ts` and a fake render:
    - `unlocks synchronously, before the render is awaited`: right after `unlock()`, before the render resolves, the element's src is the silent clip and `play` was called.
    - `plays one sound at a time: starting another stops the first`.
    - `a second press of the same button pauses, a third resumes`.
    - `drops a render that a later press overtook`: render A is slow and B is fast; only B plays, and A's signal is aborted.
    - `replays a render it has kept without asking again, and keeps no more than 12`: the 13th evicts and revokes the oldest, never the one playing.
    - `seeks to a sentence's start, and a drag pauses and resumes there`.
    - `a failed render shows stopped and retry renders it again`.
    - `pauses when the page is hidden`.
    - `dispose revokes every address`.
    - `says "2/2 · Shall I read you…" for the scrubber's bubble`.
  - `voice-name.test.ts`:
    - "Bedtime Imogen" in English, "Esti Imogen" in Hungarian;
    - pace −1 and energy −3 → "Imogen, very calm and slower" and "Imogen, nagyon nyugodt és lassabb";
    - Savannah with pace −0.6 and energy 1.2 → "Savannah, a little slower", because the two-change form would be 47 characters;
    - zero → "My Imogen" and "Saját Imogen";
    - a long voice name is cut to 40.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/client/api/read-aloud-voices.test.ts src/lib/client/read-aloud/voice-preview.test.ts src/lib/client/read-aloud/voice-name.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): the voice preview player, the voices API client and the suggested name" -m "Plan-3-Task: 10"`

### Task 11: The editor (Track B)

**Files:**
- Create, in `src/lib/components/read-aloud/voices/`:
  - `VoiceEditor.svelte`, `VoiceKnobSlider.svelte`, `VoiceListen.svelte` and `VoicePlayButton.svelte`, each with its test;
  - `VoiceBasePicker.svelte` and `VoiceStyleChips.svelte`, tested through the editor.

**Interfaces:**
- Consumes: Tasks 1, 8, 9 and 10; `DialogShell`, `ConfirmDialog`, `Toggle`; `prefersReducedMotion`.
- Produces:
  - **`VoicePlayButton`,** props `{ sound: PreviewSound; label: string; pauseLabel: string; preview?: VoicePreview }`:
    - a 32 px round button;
    - it shows `mini-spinner` while its own sound loads, `Pause` while that sound plays, else `Play`;
    - a press calls `preview.unlock()`, then `preview.toggle(sound)`, with nothing awaited.
  - **`VoiceKnobSlider`,** props `{ spec: KnobSpec; value: number; onInput: (v: number) => void; onCommit: (v: number, via: "pointer" | "key") => void; onReset: () => void }`:
    - **The input:** a native `<input type="range" step="0.05">`, with `aria-label` the knob's name and `aria-valuetext` its word.
    - **Events:** `oninput` calls `onInput(snapKnob(…))`. `onchange` calls `onCommit(value, "pointer")` while a pointer is down, else `onCommit(value, "key")`.
    - **Drawing:**
      - the track is painted under the input, with the accent from the 0 notch to the handle (the prototype's `paintTrack`);
      - a 2 × 16 px notch sits at 0, and the ends' words under the track;
      - the knob's word is on the right, accent and semibold once moved;
      - ↺ (`RotateCcw`, 13 px) shows only when moved.
    - **Layout:** on desktop, a grid of `96px minmax(0,1fr) 116px`. Below 640 px, the name and the word share a line, the range sits below them, and the thumb is 24 px.
  - **`VoiceStyleChips`,** props `{ knobs: Knobs; onPick: (style: StyleKey) => void }`: seven chips, with `aria-pressed` on `matchingStyle(knobs)`.
  - **`VoiceBasePicker`,** props `{ builtIn: BuiltInVoiceInfo[]; selected: string; onSelect: (key: string) => void; preview?: VoicePreview }`:
    - two groups, English and Hungarian;
    - each card is a select button (`aria-pressed`; the name and the description) beside its own `VoicePlayButton` (owner `base:<key>`, the base's sample, zero knobs): two buttons side by side, never one inside the other;
    - 4 columns, or 2 below 640 px.
  - **`VoiceListen`,** props `{ base: BuiltInVoiceInfo; knobs: Knobs; compare: "yours" | "original"; onCompare: (c: "yours" | "original") => void; playAfterChange: boolean; onPlayAfterChange: (on: boolean) => void; useOwnWords: boolean; onUseOwnWords: (on: boolean) => void; words: string; onWords: (text: string) => void; preview?: VoicePreview }`. It draws:
    - **the inline pill:**
      - its view is `$voicePreviewView.player` while the owner is `"listen"`;
      - otherwise an idle view: status `"paused"`, the sample's notches by text share, and a total of `≈` at 15 characters a second;
      - its actions are bound to `listenSound(…)`;
    - **Yours / Original:** a `role="group"` with `aria-label` `editor.compare`, its buttons `aria-pressed`;
    - **the text:** the sample in quotes (`editor.quote`), or the words field (`maxlength=300`; Enter renders);
    - **two `Toggle`s:** Play after each change, and Use my own words;
    - **the failure note** (`ReadAloudNote`, tone warn, placement inline, `editor.sampleFailed`, its action `tryAgain` → `preview.retry()`), while `$voicePreviewView.status` is `"failed"` and the owner is `listen` or a `base:` one.
  - **`VoiceEditor`,** props `{ builtIn: BuiltInVoiceInfo[]; voice: PersonalVoiceInfo | null; startFrom: string; onClose: () => void; onSaved: (voice: PersonalVoiceInfo, replacedId: string | null) => void; onDeleted: (id: string, choice: VoiceChoice) => void; preview?: VoicePreview }`. It saves through Task 10's `createReadAloudVoice`, `updateReadAloudVoice` and `deleteReadAloudVoice`; its tests `vi.mock` that module.
    - **The shell:** `DialogShell`, titled `editor.newTitle` or `editor.editTitle`, with `phonePresentation="fullSheet"`, `maxWidthClass="max-w-[600px]"` and a `footer` snippet.
    - **Its state:**
      - base, knobs and name;
      - `nameTouched`, true when editing;
      - compare; Play after each change (on); Use my own words; the words;
      - saving; the note (`saveFailed`, `deleteFailed` or `tooMany`); confirming the delete.
    - **A change** is one of:
      - a base picked;
      - a slider committed: by pointer at once, by key after 400 ms without another key;
      - a style chip, ↺ or Reset all, after its 260 ms animation.

      A change sets compare back to "yours", refreshes the suggested name while the name is untouched, and calls `preview.play(listenSound(…))` when Play after each change is on.
    - **The animation:** the knobs move from where they are to the target over 260 ms, eased `1 − (1 − t)³`, each step on the 0.05 grid. Under reduced motion they move at once.
    - **Yours / Original** sets compare and plays, whether Play after each change is on or not.
    - **Save:**
      - new → `createReadAloudVoice`; editing → `updateReadAloudVoice` (Save changes) or `createReadAloudVoice` (Save as new);
      - the name sent is the field trimmed, or the suggested name when the field is empty;
      - the buttons are disabled while saving;
      - a failure keeps everything and shows `editor.saveFailed` with Try again, or `editor.tooMany` for 409 `too_many`;
      - success calls `onSaved`.
    - **Delete** (editing only, on the left of the footer) opens `ConfirmDialog`:
      - `editor.deleteTitle`, and `editor.deleteMessage` with the name and `baseName`;
      - its confirm button is `editor.delete`, with `confirmVariant="danger"` and `initialFocus="cancel"`.

      Confirming calls `deleteReadAloudVoice`, then `onDeleted`; a failure shows `editor.deleteFailed`.
    - **The footer:** a new voice has Cancel and Save voice. Editing has Delete, a space, Save as new and Save changes. Below 640 px, Cancel is not drawn.
    - **Closing** (✕, Escape, Cancel or the backdrop) calls `preview.stop()` and `onClose`, and unsaved changes go.
    - **A voice whose base is missing** opens on its language's default built-in voice, with its knobs (Decision 14).

- [ ] **Step 1: Write the failing tests.**
  - `VoicePlayButton.test.ts`:
    - `unlocks and toggles on press, nothing awaited first`.
    - `shows a spinner, then pause, for its own sound only`.
  - `VoiceKnobSlider.test.ts`:
    - `shows the word for its value and the spec's ends`.
    - `snaps near normal while dragging`.
    - `commits by pointer or by key`.
    - `shows ↺ only when moved, and resets`.
    - `has a word for every band of its knob`: each knob has as many word keys as `KNOBS[k].words`.
  - `VoiceListen.test.ts`:
    - `before anything plays the pill shows the sample's two notches and an estimated length`.
    - `Yours / Original calls onCompare`.
    - `the person's words replace the sample`.
    - `shows the failure note with Try again when its render failed`.
  - `VoiceEditor.test.ts`, with the API module mocked and a `preview` double:
    - `a new voice starts from the given voice with the Original style and the name "My Imogen"`.
    - `a style chip moves all five sliders over 260 ms, names the voice and plays it`.
    - `under reduced motion a style sets the sliders at once`.
    - `a pointer release plays at once; a held key plays once, 400 ms after the last change`.
    - `with Play after each change off nothing plays until ▶`.
    - `Yours / Original plays the voice and its base`.
    - `stops suggesting a name once the person types one`.
    - `saves a new voice, and keeps everything with a note when saving fails`.
    - `edits: Save changes updates, Save as new creates, Delete asks first`.
    - `says when the person has 50 voices`.
    - `on a phone it is a full sheet without Cancel`.
    - `closing stops the sound`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/components/read-aloud/voices`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): the voice editor" -m "Plan-3-Task: 11"`

### Task 12: The Settings card (Track B)

**Files:**
- Create: `src/lib/components/read-aloud/voices/ReadAloudSettingsCard.svelte` and its test.
- Modify: `src/routes/(app)/settings/_components/SettingsProfileTab.svelte` and `SettingsProfileTab.test.ts`.
  - The card goes right after the Preferences card, in the same column.
  - A jump target `settings-section-read-aloud`, labelled `readAloud.settings.title`, appears only while `$readAloudAvailable`.

**Interfaces:**
- Consumes: Tasks 1, 9, 10 and 11.
- Produces: `ReadAloudSettingsCard`, whose only prop is `preview?: VoicePreview`, for tests; its tests `vi.mock` the API module. It carries `id="settings-section-read-aloud"` and `class="settings-card"`, and uses the page's `settings-card-head`, `settings-rows`, `settings-row` and `settings-select`.
- **Loading:**
  - The card is drawn only while `$readAloudAvailable`.
  - On mount it calls `fetchReadAloudVoices()`. While that loads, the rows keep their height, so the page does not jump.
  - A failure shows `settings.loadFailed` with Try again.
- **The English and Hungarian voice selects:**
  - a `<optgroup label={settings.builtIn}>` with that language's built-in voices ("Imogen · British woman");
  - then, when the person has any voices of that language, a `<optgroup label={settings.yours}>` with them.

  A change saves at once (`saveReadAloudChoice`). A failure puts the select back and shows `settings.saveFailed` with Try again.
- **The Default speed select:** the six speeds, written as the speed menu writes them (`Intl.NumberFormat` of the UI language, then "×"), with its help line. It saves the same way.
- **Your voices:** each row has:
  - a `VoicePlayButton`: owner `voice:<id>`, the voice's base, its knobs and its language's sample; a voice whose base is missing plays its language's default with no knobs;
  - the name;
  - a line with `settings.from` and the summary: the `summaryKnobs` words, lower-cased and joined with ", ", or `settings.unchanged`;
  - Edit.

  Under a voice whose base is missing: `TriangleAlert` and `settings.baseMissingEn` or `settings.baseMissingHu`, with `baseName`. With no voices, the card shows `settings.empty`.
- **New voice** (`Plus`, `settings.newVoice`) and Edit open the editor, and their click calls `preview.unlock()` first.
  - A new voice starts from the base of the person's voice for the UI language (Decision 9).
  - After a save, the list changes in place: a new voice is added at the end, an edited one replaced.
  - After a delete, the voice goes and the choice takes the answer, so a deleted chosen voice shows its base.
  - The pickers' Yours groups follow.
- **When the card goes** (leaving Settings), it calls `preview.dispose()`.

- [ ] **Step 1: Write the failing tests** in `ReadAloudSettingsCard.test.ts`:
  - `is not there while read aloud is off`.
  - `lists the built-in voices per language, then the person's own`.
  - `saves a voice choice and the Default speed on change, and puts a select back when saving fails`.
  - `shows each voice with its summary, and the empty text when there is none`.
  - `opening the editor unlocks the preview first`.
  - `a saved voice joins the list and its picker group`.
  - `deleting the English voice shows its base in the picker`.
  - `warns under a voice whose base is gone`.

  In `SettingsProfileTab.test.ts`: `shows the Read aloud card after Preferences only when read aloud is on`, and the same for the jump chip.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/components/read-aloud/voices "src/routes/(app)/settings/_components/SettingsProfileTab.test.ts"`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(read-aloud): the Read aloud card in Settings" -m "Plan-3-Task: 12"`

### Task 13: End to end (Track B)

**Files:**
- Create: `tests/e2e/read-aloud-voices.spec.ts`.
- Modify:
  - `tests/e2e/read-aloud-helpers.ts`: add `resetReadAloudVoices(page)`, which deletes the person's voices and puts back `{ en: "imogen", hu: "berta", defaultSpeed: 1 }`, and `openReadAloudSettings(page)`;
  - `tests/AGENTS.md`: add the spec to the read-aloud row.

**Interfaces:**
- Consumes:
  - Track A's Tasks 1–5 and Track B's 8–12;
  - the fake's `previews` and `failPreview`, and its sessions' `body.sentences[i].voice`.
- **Each test** starts the fake with `startFakeSpeechForSpec`. Its cleanup calls `resetReadAloudVoices`, then `stopFakeSpeechForSpec`. A worker keeps its database from one spec file to the next.

- [ ] **Step 1: Write the tests:**
  - `Settings shows the Read aloud card, and a chosen voice reads the replies`. Choose Rupert, then reload: Rupert is still chosen, and a reading's session sends `default_3765f0d1140c05c0`.
  - `the editor renders a style through the fake and saves the voice`:
    - New voice, then Savannah, then Bedtime;
    - the Pace word reads "Slower" and the name "Bedtime Savannah";
    - the fake gets a preview with Savannah's id and Bedtime's controls, and the dialog's pill plays;
    - after Save voice, the list shows "Bedtime Savannah" and "from Savannah · slower, a little fuller, very calm, softer".
  - `Yours / Original plays the base voice`: the newest preview has no controls.
  - `a personal voice reads the replies, and deleting it gives the reading back to its base`:
    - choose the voice for English; a reading then sends Savannah's id and the voice's controls;
    - Edit, Delete and confirm; the picker then shows Savannah;
    - a new reading sends Savannah's id with no controls.
  - `a preview that fails says so, and Try again plays it`: with `failPreview: "failed"` the note shows; after `setOptions({})`, Try again plays.
  - `a Default speed starts every reading at it`: with 1.5× chosen, a reading's speed chip shows "1.5×".
  - `on a phone the editor is a full sheet without Cancel`: 390 × 844.
  - `under reduced motion a style moves the sliders at once`: `page.emulateMedia({ reducedMotion: "reduce" })`.
  - `another person never sees or uses my voice`:
    - make a second person through the admin users API, as `tests/e2e/images-picture-filter.spec.ts` does;
    - in that person's own browser context: `GET /api/read-aloud/voices` lists none of the admin's voices; PATCH and DELETE of the admin's voice id answer 404; `PUT /api/read-aloud/preferences` with it answers 400;
    - the admin's voice is unchanged;
    - the second person is deleted in the cleanup.
- [ ] **Step 2: Build, then run the spec alone** (`tests/AGENTS.md`, "One or two specs on the build"): `npm run build`, then `E2E_PORT=4520 E2E_WORKERS=1 npx playwright test tests/e2e/read-aloud-voices.spec.ts`. Every test passes. Fix until it passes twice in a row.
- [ ] **Step 3: Commit.** `git commit -m "test(read-aloud): voices and the editor, end to end" -m "Plan-3-Task: 13"`

### Task 14: One review of the whole branch, then the gate (Track B)

- [ ] **Step 1: Merge Track A's tip,** the commit with `Plan-3-Task: 7`. Then check that every trailer from 1 to 13 is an ancestor of `HEAD`, with literal commands, one per trailer, as in **Tracks**.
- [ ] **Step 2: Dispatch one reviewer** on Opus 5.5 with a fresh context. Give it:
  - the range `0051fed75..HEAD`;
  - this plan;
  - the spec's §4.5–§4.8, §6.5, §8 and §9.4;
  - the five Review Focus items.

  It reports Critical, Important and Minor findings, each with its file and line.
- [ ] **Step 3: Fix every Critical and Important finding,** test first, one commit each. Write the Minors you leave in the hand-over note.
- [ ] **Step 4: Run the gate once,** with a literal folder in your scratchpad for `<out>`:
  `scripts/gates.sh agent <out> --port 4510 tests/e2e/read-aloud-voices.spec.ts tests/e2e/read-aloud.spec.ts tests/e2e/read-aloud-failures.spec.ts tests/e2e/settings-profile-redesign.spec.ts tests/e2e/settings-admin.spec.ts tests/e2e/login.test.ts`

  Every step must be green:
  - check 0 errors and 0 warnings; Biome; migrations; vitest;
  - the build with 0 warnings; the chunk guard;
  - Fallow at its baseline, with no new finding;
  - e2e with 0 failed and 0 flaky.

  Also run `.venv/bin/python -m pytest -q` in `deploy/speech-service`, which the gate does not run.
- [ ] **Step 5: Write `read-aloud-plan-3-handover.md`** in the shared notes folder: the branch and its tip, the gate's screen, the review's findings and what was fixed, the Minors left, and whether Task 15 has run.
- [ ] **Step 6: Commit** what is left, with `-m "Plan-3-Task: 14"`. When the fixes are all committed already, mark the end with `git commit --allow-empty -m "chore(read-aloud): plan 3 reviewed and gated" -m "Plan-3-Task: 14"`.

### Task 15: The knobs' safe ranges, measured on the box (the owner's OK)

This task is on neither track. It runs only after the owner says yes, through the design session. It is about 15 minutes of Zonos on GPU0 beside vLLM, and nothing restarts.

- [ ] **Step 1: Update the box's copy of the code,** with the owner's OK, as the README's "Install or update" step 1 says (as `alfyws`), so that `scripts/measure_knobs.py` is there.
- [ ] **Step 2: Run it on the box,** as `alfyws`, with the service's Python and its aligner (the paths are in the README's "Where things are on the box"):
  `cd /home/alfyws/opt/speech-service && /home/alfyws/venvs/speech-service/bin/python -I scripts/measure_knobs.py --out /home/alfyws/knob-ranges-<date> --aligner-cli <its CLI> --aligner-model <its model> --aligner-threads 8`
- [ ] **Step 3: Copy `knob-ranges.json`** to the shared notes folder, then delete the box folder.
- [ ] **Step 4: Narrow `SAFE_CONTROL_RANGES`** (Task 1's file) for each language and control whose measured end lies inside the spec's, then run Task 1's tests.
  - If `maps each style to the controls the owner approved on the box` then fails for a style, do not change the test.
  - Tell the owner which style and language would sound different, and keep that control's range at the spec's until they decide.
- [ ] **Step 5: Add the numbers** to the README's "Measured on the box" ("Knob ranges, <date>: …").
- [ ] **Step 6: Commit.** `git commit -m "feat(read-aloud): the knobs' safe ranges as measured on the box" -m "Plan-3-Task: 15"`

## Hand-over to Plan 4

- **The owner's checks on staging** (spec §8):
  - the slider words by ear, in both languages and with all six voices;
  - whether a knob needs a dose of its own in Hungarian (spec §4.6, "Calibration"), which would be a per-language factor in `knobsToControls`;
  - the editor's Hungarian words (Decision 17).
- **The Feature Guide:** one entry for reading aloud, the Read aloud card and the editor, with its drawing and Show me markers on the English voice picker and on "New voice" (spec §4.11).
- **Task 15** runs before `TTS_ENABLED` goes on in production, if it has not run yet (spec §8).
- **Apache:** the preview route needs no streaming rule, because it answers a whole clip with a length.
- **The migration number:** if `main` holds a migration numbered 1777140000130 when this branch merges, renumber this one (the file name and its journal entry).
