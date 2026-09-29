# Slides agent S4-D · the deck model, Alfy's create path, and the suite-4 gate (Slice 4 T1 + T7's create half)

Slides is the one kind nobody prototyped, and `slice-4.md` makes eval suite 4 a **hard precondition**: if the model
cannot write a valid deck in the right language without inventing facts, the design changes (ADR-0066) and that is the
owner's decision. So you build, in this order, the deck model, the `create_artifact` handler that lets Alfy make a deck,
and the suite that measures whether it can — **before** anyone builds the panel. No UI in this agent.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-s4d`, branch
  `feat/artifacts-s4-deck` (from **`feat/artifacts-slides`**, ruling 65: Slides waits on its own branch until it is
  whole), e2e port **5410**, label `s4d`, model tunnel local port **30010**.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/s4d-report.md`
- **Agent S3-P runs at the same time** on `feat/artifacts`: the Canvas body (`src/lib/shared/artifacts/canvas*.ts`,
  `serialize/canvas.ts`), `src/lib/shared/artifacts/ops.ts` and `board-ops.ts`, `services/artifacts/ops.ts`, the ops
  route. Stay out of those; you consume none of them yet (Slides' patches come in a later agent, after Canvas's ops
  mechanism merges). Files you both append to — keep your additions in their own block:
  `services/artifacts/serialize/index.ts` (one registry line), `services/artifacts/index.ts` (one export block),
  `src/lib/i18n/artifacts.ts`.

## Read first

`docs/plans/claude-at-home-2/wave-3/common.md`. Rulings (`decisions.md`): 2, 3, 12, 50, 53, 55, 59, **62, 65**.
`slice-4.md` by range: 1–63 (goal, feasibility), 64–135 (constraints, gates, review focus), 136–431 (the deck body, the
layout contract the model must emit, text fields as blocks), 808–854 (failure modes, limits), 929–975 (file paths),
978–1043 (T1), 1347–1410 (T7). `slice-5.md` by range: 155–240 (the three tools' contract), 669–788 (the eval harness:
suites, fixtures, known-bad, responses). The existing suites are your pattern: `scripts/eval-artifact-contracts/suites/`
(`document.ts`, `apps.ts`) and `cases.ts`, `scoring.ts`; the Document and App entries in
`normal-chat-tools/artifact-tools/create.ts` and `document-handlers.test.ts` are the handler pattern.

## Step 1 · The deck model (T1)

`src/lib/shared/artifacts/slides.ts` (types), `slides-layouts.ts` (the seven ids, no zod — client-safe),
`slides-schema.ts` (`slideDraftSchema`, `slidesDraftSchema`, the caps), `slides-theme.ts` (the one place slide hex
lives), and `src/lib/server/services/artifacts/serialize/slides.ts` (validate-never-throw `normalizeSlidesBody` with its
`dropped` report, the caps, `slidesBodyHash` over a canonical form — ruling 12 — and the serializer registry entry).
Tests: T1's list (987–1007). The panel-side helpers of `_lib/deck.ts` (add, remove, reorder, first slide) belong to the
agent that builds the panel and uses them: create only what a non-test module needs now (Fallow counts an unused
export) — `emptyDeck`/id minting only if the handler uses them.

## Step 2 · Alfy can make a deck (the `create_artifact` handler)

- Register `slides` in `CREATE_ARTIFACT_HANDLERS` (ruling 50): parse the model's `body` (the deck JSON) through
  `slidesDraftSchema` + `normalizeSlidesBody`, mint the slide and bullet ids server-side (the model never mints ids),
  set the deck's language from the handler's `language` (ruling 55), check the abort signal before the write (ruling 53),
  honour `artifactId` (Regenerate), and write through the facade's `createArtifact` with `author: "alfy"`.
- **Ruling 62.** The slides part of `create_artifact`'s description is generated from `slides-layouts.ts` /
  `slides-schema.ts` (the layout ids and each layout's fields), not hand-written, and carries **one compact worked
  example** that a unit test parses through `slidesDraftSchema` and `normalizeSlidesBody` with nothing dropped. A
  refused body tells the model what to fix: the valid layout ids, the field it got wrong, the cap it hit. Update
  `kind-prose.ts`'s slides lines to match; its edit lines stay (the edit handler comes later).
- Registering the handler advertises Slides: re-measure the catalogue, raise `CATALOGUE_TOKEN_CEILING` in
  `normal-chat-tools/index.test.ts` by the measured cost plus the existing margin, numbers in the commit message, and
  update the frozen catalogue snapshots in the same commit (the test's own note describes this).
- Tests: the example round trip; an unknown layout id, a forbidden field, an over-cap deck and a non-object body are
  refused with a message naming the fix; the language comes from the turn, not from the text; abort before write writes
  nothing; `artifactId` is honoured; the tool-call metadata (`artifactId`, `artifactKind`, `artifactTitle`) is recorded.

## Step 3 · Suite 4's create cases, run live (T7)

- `suites/slides.ts`, `fixtures/slides/`, its scorer and its `cases.ts` entry, following the existing suites. Fixtures:
  `vienna-5` in **Hungarian and English** ("Készíts 5 diás diasort a bécsi útról" / "Make a 5-slide deck about the
  Vienna trip", with a short trip note as source material), `itinerary` (an itinerary as source), `danube-facts` (numbers
  that exist only in the source). Each fixture **declares its language**; the scorer checks the deck against it (ruling
  65), not `detectLanguage`. The edit case (`existing-deck`) lands with the edit handler later.
- Scoring (slice-5's suite-4 row): zod validity, registered layout ids, the layout's declared fields and no forbidden
  one, the caps, the declared language, and **no invented number or proper noun** (a deterministic extraction checked
  against the source, allowing direct arithmetic relations). Known-bad fixtures (slice-5 line 769's three) are
  hand-written responses served from disk, never model calls (ruling 59); the run refuses to count scores until they
  fail.
- **The live run goes through the real tool** (ruling 62): the model is called with the real `create_artifact`
  description and schema as the app sends them, not a hand-written prompt. If the harness cannot do that today, make it
  do so for your suite without editing `run.ts`, `config.ts` or `client.ts` (ruling 44), or stop and report. Commit the
  recorded `responses/` (from `qwen3-6-27b` only) so `--replay` re-scores them in CI.
- Run it live through the tunnel (`common.md`), sequentially. **Report the numbers as they are.** If the suite misses its
  bar, do not tune the scorer or the fixtures to pass: record the result and the failing decks in the report, and stop —
  the design decision is the owner's. Tuning the tool description (ruling 62's example, clearer field words) is fair
  game, measured before and after.

## Proof

No UI, so no screenshots. The full gates once at the end (`common.md`). The report's hand-off lists the deck types and
schema exports, the handler's behaviour, and the suite's per-fixture results (valid / layouts / language / invented
facts / caps), with the exact commands to re-run it live and in replay.
