# S4-D report: the deck model, Alfy's create path, and eval suite 4

Agent model: `claude-sonnet-5-5`. Worktree `.claude/worktrees/art-s4d`, branch `feat/artifacts-s4-deck` (from
`feat/artifacts-slides`). Commits `d0027578` .. `abe8639a` (11 commits, 50 files, +6,994 / -51; nothing under
`docs/`, `AGENTS.md` or another worktree). Status: **DONE_WITH_CONCERNS**. The concern is the finding the brief made this
step for: **suite 4's bar is not met** (unsupported facts in 9 of 16 decks), so the design call is the owner's.

## 1. Result in five lines

- The deck model, the `create_artifact` Slides handler and suite 4 are built, tested and gated (section 5). No UI.
- Through the real tool, with the whole catalogue as a chat turn sends it, `qwen3-6-27b` writes **structurally sound decks
  in the right language**: **0 language misses in all 69 decks made across the seven runs** (Hungarian and English)
  (every recorded run set re-scored under the final scorer with the scratchpad's `stats.mts`).
- What fails the decks is **detail the model supplies from its own knowledge** (Klimt, Kettenbrückengasse, Vila Nova de
  Gaia, invented train times like 13:30, one outright hallucination, "Szerb-érchomlok"): 9 of 16 decks (description v2),
  5 of those 9 only in speaker notes.
- One tuning round of the tool description (facts rule first, eyebrow rule, quote shape) took it from **2/12 good to
  7/16 good**. A second wording (v3) measured no better and was discarded.
- Also worth deciding: 1 in ~10 first attempts fails on the deck being **JSON inside a JSON string** (escaping slips) and
  stray `eyebrow` fields are refused strictly (section 6).

## 2. Step 1: the deck model (T1) - commit `d0027578`

| File | What |
|---|---|
| `src/lib/shared/artifacts/slides-layouts.ts` | the seven ids (no zod), `SLIDE_FIELD_NAMES`, the layout table `SLIDE_LAYOUTS` (fields, required), `isSlideLayoutId`, `slideLayoutForbiddenFields`, `slideLayoutsWithField` |
| `slides.ts` | `SlidesBody`, `Slide`, `SlideBullet/Columns/Quote/ImageSource`, `SlidesLanguage`, `SlideAspect`, `SlidesDrop`/`SlidesDropReason`, id patterns and `mintSlideId`/`mintBulletId` (Web Crypto, client-safe) |
| `slides-schema.ts` | the thirteen caps, `slideDraftSchema` and `slidesDraftSchema` (zod 4, `.strict()`, no ids, bullets as strings) |
| `slides-theme.ts` | `SLIDE_THEMES`, `SlideThemePalette`, `SLIDE_THEME_PALETTES` (paper = the app's own light palette, ink = its dark one; a test enforces WCAG AA) |
| `src/lib/server/services/artifacts/serialize/slides.ts` | `normalizeSlidesBody` (validate-never-throw, `dropped` report), `serializeSlidesBody` (one canonical string, ruling 12), `slidesBodyHash`, `slidesSerializer` (registry line added) |

Normaliser rules (spec's order): reads a draft and a stored body alike; unknown layout -> slide dropped; missing required ->
slide dropped; a field the layout cannot show -> field dropped, slide kept; bullet/slide ids minted when missing and
re-minted **deterministically** when malformed or **duplicated** (I added duplicates: an address must name one field); caps
drop content and never the deck; empty `[]` fills a two-column side; language = caller's (ruling 55) > body's valid one >
what the deck text says > caller's fallback > `en`. Tests: 93 across the new shared and serialize files, including the
ruling-12 round trip (open -> serialise -> reload -> serialise, identical hashes) and idempotence.

## 3. Step 2: Alfy can make a deck - commit `197e801a`

- `src/lib/server/services/artifacts/slides/draft.ts`: `parseSlidesCreateBody(raw)`, the **strict** parse. Refuses (with
  everything that is wrong, up to 6 problems, then "+N more") a body that is not JSON, not an object, has an unknown layout id
  (lists all seven), an unknown field (lists the slide's fields; "never send ids"), a field the layout cannot show (names the
  layouts that carry it), a missing required field, an over-cap count or length (the count it got and the cap), an empty
  string, bullets sent as objects, or an `image` (the model cannot place a picture; use `imageAlt`/`imageCaption`). It ends
  "Fix these and send the whole deck again, once." Pure, so the eval scores through the same function.
- `slides/create.ts`: `createSlidesArtifact` (facade export): strict parse -> `normalizeSlidesBody(draft, { language,
  resolveImage: () => false })` -> refuses if anything would still be dropped (a whitespace-only required text) -> one
  `createArtifact` row, `author: "alfy"`, `artifactId` honoured (Regenerate), first version summary `alfyFirstDraft`.
  Stored `content_text` is exactly `serializeSlidesBody(body)`, so `body_hash` = `slidesBodyHash(body)`.
- `CREATE_ARTIFACT_HANDLERS.slides` in `artifact-tools/create.ts`: thin adapter; abort checked first (ruling 53); the turn's
  `language` is stamped on the deck, never guessed from the text (ruling 55); metadata records `artifactId`,
  `artifactKind: "slides"`, `artifactTitle`.
- **Ruling 62**: `kind-prose.ts` generates the Slides part of the `body` field description from the layout table and the
  schema's caps, and carries one worked example, exported as `CREATE_ARTIFACT_SLIDES_EXAMPLE`; a test parses it through
  `slidesDraftSchema` and `normalizeSlidesBody` with nothing dropped, and another that the description shows it literally.
  The example's topic ("Bike commuting") is deliberately nothing a fixture or a user's trip is about.
- **Catalogue**: registering advertises Slides in all three tools. Descriptions measured 4,773 -> 4,802 en and 7,782 ->
  7,822 hu; `CATALOGUE_TOKEN_CEILING` 4,799 -> **4,828** en and 7,809 -> **7,849** hu (measurement + the same 26 / 27
  margin). The deck contract is schema text, so it is not in that ceiling: 1,286 characters at first, **1,548** now (about
  390 tokens); snapshots regenerated (en 51,194 -> 52,998 chars, hu 56,373 -> 58,188). Numbers are in the commit
  messages and the comment above the ceiling.
- Base prompt kinds sentence now reads "Document, App or Slides" (`prompts.ts` + its test): the one deliberate cached-prefix
  change that goes with registering.
- Tests: 24 (refusals) + 8 (DB create) + 18 (tool level: registry, refusals write nothing, language from the turn, abort,
  `artifactId`, metadata, the ruling-62 example and generated text). Existing assertions that assumed Slides unregistered
  were updated (`create.test.ts`, `serialize/index.test.ts`, `prompts.test.ts`, `index.test.ts` markers).

## 4. Step 3: suite 4, run live through the real tool

### 4.1 The harness could not do ruling 62 today, so I added a path beside it (no edit to `run.ts`, `config.ts`, `client.ts`)

- `scripts/eval-artifact-contracts/tool-path.ts`: sends a case **through the tools exactly as the app does**: the catalogue
  is read from the app's own frozen `tool-catalogue.<lang>.snapshot.txt` (kept byte-identical to the request's `tools` array
  by `index.test.ts`), never re-typed; the base system prompt + the turn's required-language sentence (a test keeps that
  sentence in step with `normal-chat-context.ts`); `tool_choice: auto`; thinking off; the harness's sampling. Records an
  envelope (`toolCalls`, `content`, `finishReason`, `priorSteps`).
- `run-tool-suite.ts` (`npm run eval:artifacts:tools`): hands the harness's own `runSuite` a client built on it: same
  known-bad-first gate, one retry, two-5xx breaker. **A known-bad case is never sent to a model**: its hand-written answer is
  served from disk (ruling 59). Flags: `--repeat`, `--write-responses`, `--responses-out`, `--thinking on|off`.
- Two request-side choices, both from the first live runs and both tested: `withoutTools: memory_context, use_skill,
  suggest_instruction` (the snapshot's own header says a real turn withholds them per conversation; with them, 3 of 12 first
  steps were such a lookup) and a **bounded follow-up** (at most 4 steps): a lookup the suite can answer (`image_search`,
  `research_web`, `fetch_url`, `read_generated_file`, `files`) is answered with a stub that is empty or failed and contains no
  digit, and the model goes on. The call that makes the deck, and tools with no business in a deck request (`produce_file`,
  `email`, ...), are never answered: that step is the one scored.
- `.fallowrc.json` got the runner as an entry (a standalone script) and `package.json` one script.

### 4.2 Fixtures, scoring, known-bad

- `fixtures/slides/`: `vienna-5-hu` ("Készíts 5 diás diasort a bécsi útról." + a trip note), `vienna-5-en`, `itinerary` (a
  Porto weekend, English), `danube-facts` (Hungarian, numbers only in the notes). Each **declares its language**; the scorer
  checks against it (ruling 65), not `detectLanguage`. The `existing-deck` edit case waits for the edit handler.
- `suites/slides.ts` scores: the call (routing, arguments), the deck through `parseSlidesCreateBody` (JSON, schema,
  registered layout ids, layout fields and no forbidden one, caps), language (`classifyLanguageSignal` on the deck's text vs
  the fixture's declaration), no invented fact (`suites/slides-facts.ts`). Every reason starts with its check (`routing:`,
  `tool-args:`, `schema:`, `layout:`, `caps:`, `language:`, `facts:`, `note:`, `ok:`). Soft findings (a slide count other than
  the one asked for) are `acceptable`. When strict creation refuses a deck **only** for forbidden fields, a `note:` says a
  tolerant loader would have kept it.
- `slides-facts.ts` (rules are stated at the top of the file, with what it cannot see): numbers read every way separators
  can mean, a time is one unit, small numbers do not vouch for each other but any two source numbers give a sum,
  difference, product or quotient (May 9 + three nights = the 12th), the length of a journey is a relation of the source's
  times, structural numbering ("2 ·", "Day 2") is not a fact; a proper noun is a capitalised word with a lowercase letter,
  never a sentence's first word, not in a Title Case heading, supported by a shared stem (Hungarian suffixes), a weekday or
  month or its abbreviation. 24 tests, including honest decks per fixture that must score good.
- Known-bad (hand-written, `responses/slides-known-bad-*.json`, README in `known-bad/`): `invented-number` ("1,240 euros",
  the note says 462), `unregistered-layout` (`gallery`), `wrong-language` (a Hungarian request answered in English). Each
  fails for exactly the reason it exists; a test proves `runSuite` refuses to count real scores if one is let through.

### 4.3 The scorer changed four times after I saw data; here is exactly what and why

The scorer and fixtures were committed (`cc13656d`) before any model was asked. The first live run (12 decks) scored 0 good.
Reading the decks showed the scorer wrong in both directions, so I changed it on stated principles, each with a test, in
separate commits, and **re-scored the recorded answers under both versions**: **12 bad before, 12 bad after**, so the
finding does not depend on these rules.

1. `2e9296fa` - too strict vs the spec's own words ("or is a direct arithmetic relation of values in it"): any two source
   numbers relate (a result under 10 needs one operand of at least 10, so 3 - 2 = 1 is no relation); the length of a journey
   is a relation of two times; two inflections of one stem are one name (Schönbrunnba / Schönbrunni). Too lenient: a dash
   or colon opens a clause, not a sentence, so "Belvedere - Klimt" checks Klimt (that hole let one deck score good that plainly
   was not). **The known-bad gate caught a bug in my own loosening**: it made the "1,240 euros" deck score good, because the
   reading 1.24 borrowed an integer's rounding tolerance. Fixed (tolerance per reading; 0 is never derived).
2. `2e9296fa` - request: withhold the three per-conversation tools.
3. `a447a053` - the bounded follow-up (after the model opened 3 of 12 cases with an image search, a lookup the app answers).
4. `96c8b076` - a heading's dash is styling ("Friday - Arrive and settle in"); my first dash fix had turned Arrive and Books
   into invented names. `read_generated_file` and `files` are answered as empty lookups ("Turn this itinerary" made the model
   look for a file). `d2f4c7f1` - "Sat" and "I'll" are not names.

### 4.4 The live runs (sequential, thinking off, `qwen3-6-27b`, no key; each run = the 4 real cases)

| Configuration | Decks | No deck made | Structurally invalid (first attempt) | Language miss | Unsupported number/name | **Good** |
|---|---|---|---|---|---|---|
| v1 description, full catalogue, single step (first run) | 12 | 3 (lookups) | 3 of 9 made | 0 | 8 of 9 | 0 |
| **v1** description, final harness (3 repeats) | 12 | 0 | 3 | 0 | 9 (3 in notes only) | **2** |
| **v2** description (3 repeats + the committed run) | 16 | 0 | 1 | 0 | 9 (5 in notes only) | **7** |
| v3 (notes rule, discarded; 3 repeats) | 12 | 0 | 2 | 0 | 6 (5 in notes only) | 4 |

Two intermediate runs (single step, before the follow-up; then before the file-lookup stubs) are in the scratchpad and
agree with the table (about 3-4 of 12 good, no language miss). Per fixture, v2, over 4 runs: `vienna-5-hu` 2/4, `vienna-5-en` 3/4, `danube-facts` 2/4, `itinerary` **0/4** ("Vila Nova de
Gaia", the port lodges' district, appears every time; also "Douro" and "Andante"). Cost per case: ~14.6k prompt tokens (system
prompt + full catalogue), 320-1,066 completion tokens, 2-20 s. Routing: **0** of all first steps chose `produce_file` or another
kind; the lookups the model made first were `memory_context`, `use_skill` (a skill named "slides"), `image_search` and once
`read_generated_file`, all things the app answers and goes on from.

What the failing decks look like (all judged by eye against the source; none is a scorer false alarm in the final scoring):
real-world specifics not in the notes (Klimt, Upper/Lower Belvedere, Kettenbrückengasse, Herrengasse, Innere Stadt,
Stephansplatz, Douro, Vila Nova de Gaia, Kárpátok/Balkán, Europe), invented times (13:30, 14:30, 14:45, 16:15), and outright
hallucination ("Szerb-érchomlok", "Beer-Sheba"). If speaker notes were exempt from the fact check, 11 of 16 v2 decks would be
good; the spec scores them, so the suite does.

### 4.5 Tuning (ruling 62's lane), measured before and after

v1 led the fact rule last in a long syntax paragraph ("Use only figures and names the user or your sources gave you"): 2/12.
v2 (`de538351`) leads with it and makes it concrete (no names, places, times, prices or figures from your own knowledge,
speaker notes included; ask for detail in the notes instead of supplying it), generates "An eyebrow exists only on title,
section or bullets slides" from the layout table, and says a quote is an object, never a bare string: 7/16. v3 (an explicit
speaker-notes rule) 4/12 and longer decks: within noise of v2, not kept (reverted in the working tree, never committed). A
12-deck run has a spread of about +/-2, so v2 vs v1 (2 -> 6 of 12 on the same 12-deck design) is the reliable move.

## 5. Gates (all once, on the final tree `abe8639a`)

| Gate | Result |
|---|---|
| `npm run check` | 0 errors, 17 warnings (the pre-existing ones; it caught a real missing `id` field, fixed) |
| `npx biome check src scripts tests` | clean (2,215 files) |
| `npm test` | 925 files, **14,432 passed**, 2 skipped (this agent added 210 tests in 11 files, and edited assertions in 4) |
| `npm run build` | exit 0; 32 `Unused CSS selector` + 2 `must have an ARIA role` = the baseline exactly |
| Playwright, port 5410 | **177 passed** (all `artifact*`/`artifacts-*` specs + knowledge + chat + conversation), 0 failed, 8.5 min |
| Fallow | 124 issues, 4 circular = baseline (it flagged one unused type of mine, `SlideDraft`, removed in `abe8639a`) |
| `npm run check:migrations` | passes unchanged; **no migration** was needed |
| `run.ts --suite all --replay` | document 7/0 bad, app 10/0, verification 4/0 unchanged; slides scores the committed set (1 good, 3 bad) |

No screenshots: there is no UI in this agent. No i18n rows: every string I wrote is model-facing English (the tool layer's
convention); `src/lib/i18n/artifacts.ts` is untouched, so it cannot conflict with S3-P.

## 6. Deviations, with reasons

1. **`body` stays a string.** The brief and `slice-5.md` say "the deck JSON" as a string, and I generated the description
   text plus one example from the schema. Ruling 62's literal reading ("Slides' `create_artifact` body [is] advertised with
   the same zod schema the handler validates with") would make `body` accept the deck as an **object** (a union with the
   string), which removes the JSON-in-a-string escaping failure (1 first attempt in ~10: a doubled quote in the first probe,
   `""notes"`; invalid JSON in 3 recorded decks; one "unexpected character after JSON"). That changes the shared schema for all
   kinds, so I did not do it unasked; the evidence is in section 7.
2. **Forbidden fields are refused on create** (per the brief), where the spec's normaliser drops them and keeps the slide.
   The normaliser keeps the spec behaviour for a stored body; the strict parse is only the create path. Live: v1 had 1 of 12
   decks refused only for an `eyebrow` on a two-column slide; the scorer records that as a note.
3. `forbidden` is the **complement of `fields`** (so `imageAlt`/`imageCaption` are forbidden on layouts without `image`),
   where the spec's table lists a few fewer. `image` is refused on create (the model has no file ids) and dropped as
   `image_not_found` when a resolver says no.
4. The language fallback uses `classifyLanguageSignal` (unknown -> the caller's fallback) rather than `detectLanguage`
   (which never says unknown); order otherwise as the spec.
5. `mintSlideId`/`mintBulletId` live in shared `slides.ts`, not `_lib/deck.ts`, because the server normaliser needs them too;
   the panel agent imports them from there. The type is `SlideTheme` (from `slides-theme.ts`), not `SlidesTheme`.
   `_lib/deck.ts` and `deck-ops.ts` (`hashSlideField`, `hashSlideContent`, patch vocabulary) are not created: no
   non-test consumer yet, and Fallow counts an unused export.
6. T1's `deck.test.ts` items that belong to the normaliser (round trip, id shapes, empty deck) are in
   `serialize/slides.test.ts`; "the same body hash for a reordered deck's unchanged slide" is read as key-order and
   round-trip stability plus "an unchanged slide serialises identically wherever it sits" (per-slide content hashing is
   `deck-ops.ts`'s, later).
7. Where I wrote a test and its implementation in one step without watching that test fail first: the service-level
   `create.test.ts` and the description-v2 tests. Everything else was seen red first.

## 7. Open questions for the owner (the design decision the brief reserved)

1. **Facts.** Bar: zero invented number or name. Measured: 9 of 16 decks (v2). The model elaborates with true-ish real-world
   detail and sometimes false detail. Options: (a) accept notes as free text and score only slide text (11 of 16 pass); (b)
   ADR-0066's named fallback, Alfy proposes and the user approves slide by slide; (c) a verification pass on decks like the
   App's (a second call lists claims not in the sources, removes them, re-checks before the row is written), which the repo
   already has the pattern for; (d) keep strict and stop at the message ("say what you added").
2. **First-attempt structure.** 1/16 (v2), 3/12 (v1): JSON escaping slips, a quote sent as a string, an `eyebrow` on the wrong
   layout, an invented layout `table`. The refusal text names each fix and the app lets the model retry once; the eval does
   not simulate that retry (the harness is one answer per case). Levers: tolerant creation for stray fields like the
   spec's normaliser; `body` as an object (deviation 1).
3. The suite's bar should probably be a rate over repeats, not "zero" on one sample: a 12-deck run has a spread of about +/-2.
   `--repeat` exists for that; the committed responses are one run.

## 8. Merge notes for the orchestrator (S3-P edits the same lines)

Both branches append and both flip "today, only X and Y are registered" assertions, so expect small conflicts in:
`artifact-tools/create.test.ts` (advertised set, canonical order, the schema test), `serialize/index.test.ts` (registry null
list), `serialize/index.ts` and `services/artifacts/index.ts` (one line/block each), `prompts.ts` + `prompts.test.ts`
(after both: "Document, App, Canvas or Slides"), `normal-chat-tools/index.test.ts` (ceiling, marker tests, comment) and the
two `tool-catalogue.*.snapshot.txt` (**regenerate with `-u` after the merge and re-measure the ceiling; the two raises are not
simply additive**), `kind-prose.ts` (separate entries, one header comment), and `scripts/eval-artifact-contracts/{cases,scoring}.ts`
+ README (one registry line each). `tool-path.ts` is generic: Canvas's suite can reuse it (ruling 62) instead of adding its
own. `edit_artifact`'s description now says "Documents and Slides: send patches", but there is no Slides edit handler yet
(it answers `unsupported_kind`, and the `patches` schema is still the Document's): fine while Slides waits on its own branch
(ruling 65), wrong if shipped before the edit slice.

## 9. Hand-off

**Deck types and schema**: `src/lib/shared/artifacts/{slides,slides-layouts,slides-schema,slides-theme}.ts` (exports listed
in section 2). Load: `normalizeSlidesBody(JSON.parse(stored))` or `slidesSerializer.parse(stored)` (null when not a deck; the
`dropped` reasons are `not_a_deck, unknown_layout, missing_required_field, field_not_on_layout, invalid_field,
field_too_long, too_many_slides, too_many_bullets, image_not_found`, each needing an `artifacts.slides.drop.*` EN+HU row).
Save: `serializeSlidesBody(body)`, hash `slidesBodyHash(body)`. `slideLayoutForbiddenFields`/`slideLayoutsWithField` are what
a patch validator needs to refuse a forbidden field with the valid alternatives (ruling 62).

**Handler**: `createSlidesArtifact` (facade) / `CREATE_ARTIFACT_HANDLERS.slides`; refusal text from
`parseSlidesCreateBody` (its `problems[].kind` set is `not_json, not_a_deck, invalid, unknown_layout, unknown_field,
field_not_on_layout, missing_required_field, over_cap, image`). Regenerate works through the generic `recreate.ts` (the stored
call's `body` re-runs the handler under the same id); not exercised end to end, and the read model's `regenerable` mark is
generic by kind, which the panel agent should confirm when the Slides card exists.

**Suite, per fixture (committed run)**: `vienna-5-hu` bad (facts in bullets, 6 slides asked 5), `vienna-5-en` good,
`itinerary` bad (facts, notes only), `danube-facts` bad (facts, notes only). Valid / layouts / language / facts / caps:
all four valid, all registered layouts, 0 language misses, facts as listed, caps respected. Re-run:

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
# replay, no model, no key:
npx tsx scripts/eval-artifact-contracts/run.ts --suite slides --replay
# live, one command with its tunnel (local port 30010), 3 repeats, answers kept for a look:
ssh -N -o ExitOnForwardFailure=yes -L 30010:192.168.1.96:30000 alfyroot & T=$!; sleep 2; \
  EVAL_ARTIFACTS_BASE_URL=http://127.0.0.1:30010/v1 EVAL_ARTIFACTS_MODEL=qwen3-6-27b \
  npx tsx scripts/eval-artifact-contracts/run-tool-suite.ts --suite slides --repeat 3 \
    --out /tmp/slides-out --responses-out /tmp/slides-answers; kill $T
# re-record the committed set (one run): add --write-responses (not with --repeat)
```

Working files (not committed): run dirs, raw answers and scripts are in the scratchpad `w3/` (`runs/baseline-off`,
`before-final`, `after-off`, `after-v3`, `v2-all`, `final-committed`; `stats.mts`, `rescore.mts`, `show.mts`).
