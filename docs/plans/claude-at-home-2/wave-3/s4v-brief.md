# Slides agent S4-V · the deck fact check (ruling 66), on a branch that has caught up with Canvas

S4-D built the deck model, Alfy's Slides create path and suite 4, and measured the model writing decks in the right
language and shape but adding names, places and times the user never gave (7/16 decks clean). The owner chose ruling 66:
**before a deck is written, check every specific the user's material does not contain; keep what the web confirms;
remove or neutrally rephrase the rest; record what was checked.** You build that check and re-measure suite 4 with it. No
UI (the panel agent shows the result later).

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-s4v`, branch
  `feat/artifacts-s4-verify` (from `feat/artifacts-slides`), e2e port **5450**, label `s4v`, model tunnel local port
  **30030**.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/s4v-report.md`
- **Agent S3-F runs at the same time** on `feat/artifacts`: `src/lib/components/artifacts/canvas/**`,
  `tests/e2e/artifact-canvas*.spec.ts`, `package.json` (it drops two unused dependencies). Stay out of those.

## Read first

`wave-3/common.md`; decisions.md rulings 40, 52, 53, 55, 57, 59, 62, **66**; `wave-3/s4d-report.md` (all of §3–§4 and
§6–§9 — your predecessor's handler, suite, harness path and merge notes); `wave-3/s3t-report.md` §"Expected merge
friction" and §"Hand-off → For the orchestrator". The App verifier is your pattern:
`src/lib/server/services/artifacts/app/verify.ts` (`verifyApp`, the verifier prompt and answer parser, the
re-verification deadline) and `generate-and-verify.ts` (how it sits inside the create budget), with `research_web` built
from `normal-chat-tools/research-web-tool.ts` (ruling 57: no import cycle).

## Step 0 · Catch up with Canvas (a merge you are allowed to make)

Merge `feat/artifacts` into your branch (it now carries S3-P, S3-B and S3-T: the Canvas body, board, tools and eval).
Resolve as both reports' merge notes say: **keep both kinds everywhere** (the per-kind tool files, `kind-prose.ts`'s
example list "Document, Canvas, Slides", `EDIT_ARTIFACT_HANDLERS`, the serializer registry, the facade exports, the eval
registries — `TOOL_SUITES = { canvas, slides }`, `cases.ts`/`scoring.ts` one line each, `tool-path.ts` is byte-identical
on both sides); take S3-T's synthetic stand-in suite names in `scoring.test.ts`/`run.test.ts`; the base prompt's kinds
paragraph becomes "Document, App, Canvas or Slides". Then **regenerate both frozen catalogue snapshots** (`-u`) and
re-measure `CATALOGUE_TOKEN_CEILING` — one value for both kinds, measured, numbers in the merge commit message; the two
earlier raises are not additive. Your `node_modules` symlink points at `art-base`'s, which has the Canvas packages. Run
`npm run check` and the affected vitest files green before step 1, and commit the merge on its own.

## Step 1 · The fact check (ruling 66)

A `slides` fact-check module (under `services/artifacts/slides/`) called by the Slides create handler **before** the row
is written:
- Extract the deck's specifics — numbers, dates, times, prices, names, places — with the same deterministic extraction
  the suite-4 scorer uses (one implementation: move it where both can import it, the scorer keeps its tests), and drop
  the ones the user's material contains. The user's material is the conversation's own text and the sources this turn
  used, read through the existing ownership-scoped services (never a raw query; incognito stays contained).
- For the rest: a personal specific (a time, a price, a booking, a person) is removed; a general-knowledge specific is
  checked with `research_web` on the App verifier's pattern (bounded number of checks, its own deadline inside
  `create_artifact`'s 120 s, the abort signal honoured). A confirmed one stays with its source; an unconfirmed one is
  removed or neutrally rephrased by one bounded repair call that must not add a new specific (check the result the same
  way; if it did, drop the sentence instead). Out of time → remove what is unconfirmed; never fail the create.
- Speaker notes are checked like slide text. The deck must still pass `slidesDraftSchema` + `normalizeSlidesBody`
  afterwards (a slide emptied by removals keeps its layout's required fields or is dropped, reported).
- Record the result with the version (`metadata_json`, one small shape: checked, confirmed `{text, source}`, removed
  `{text, reason}`), and put it in the tool's model payload so Alfy can say what it removed. The shape is the panel
  agent's input: document it in your hand-off.
- Tests: extraction parity with the scorer; material-contained specifics untouched; a personal specific removed; a
  general one confirmed (mocked `research_web`) and kept with its source; a failed confirmation removed; the repair
  cannot introduce a new specific; the deadline and the abort path; incognito material stays scoped; the metadata shape.

## Step 2 · Suite 4 with the check, live

Run suite 4 through the real tool path **with the fact check applied to each deck the model makes**, web lookups
disabled in the eval (so every unconfirmed general specific is removed — the strictest mode; the confirmed-and-kept path
is covered by the unit tests), three repeats, reported as a rate against ruling 66's bar (zero unsupported specifics in
the written deck). Also report what the check costs: decks where it removed something, slides it emptied, the added
latency. Commit the recorded answers so `--replay` re-scores them. Numbers as measured.

## Proof

No UI. Full gates once at the end. Hand-off: the fact-check API and metadata shape, what the model payload says, the
suite numbers before/after, the re-run commands.
