# Canvas agent S3-T · Alfy's three tools for Canvas, and the canvas eval (ruling 43's per-kind part + Slice 3 T10)

S3-P built the board body, the ops mechanism and the envelope (read its report first). You make Canvas a kind **Alfy
can make, read and change** through `create_artifact` / `read_artifact` / `edit_artifact`, and you measure whether the
real model can hold that contract. Wave 2's lesson is the whole point of this agent: the Document's edit contract passed
its eval and then failed live, because the description did not match the validator (the model guessed op names seven
times, then duplicated the document). Ruling 62 is your definition of done.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-s3t`, branch
  `feat/artifacts-s3-tools` (from `feat/artifacts` after S3-P's merge), e2e port **5420**, label `s3t`, model tunnel local
  port **30020**.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/s3t-report.md`
- **Agent S3-B runs at the same time**: the new npm dependencies, `src/lib/components/artifacts/canvas/**`,
  `artifact-bodies.ts`, `ArtifactCard.svelte`, `src/app.css`, `tailwind.config.ts`, `tests/e2e/artifact-canvas*.spec.ts`,
  `scripts/check-artifact-chunks.mjs`. Stay out of those. You both append to `src/lib/i18n/artifacts.ts` (your own block,
  if you need UI strings at all — you should not).

## Read first

`wave-3/common.md`; `…/scratchpad/w3/s3p-report.md` (its hand-off: the exports, one valid diff). Rulings: 43, 50, 53,
55, 59, **62, 64**, 23. `slice-5.md` by range: 155–318 (the three tools: payloads, refusals, metadata), 669–788 (the
harness; suite 3's row at 724, known-bad at 768). `slice-3.md` 584–670 (the vocabulary and its rule order). The Document's
entries are your pattern: `normal-chat-tools/artifact-tools/{create,read,edit}.ts`, `kind-prose.ts`
(`EDIT_ARTIFACT_DOCUMENT_EXAMPLE`, `editArtifactExampleClause`, `editArtifactOpsFieldDescription`),
`document-handlers.test.ts`, `recreate.ts`; the eval pattern is `scripts/eval-artifact-contracts/suites/document.ts`.

**Reuse S4-D's real-tool eval path — do not build a second one.** S4-D (Slides, on `feat/artifacts-s4-deck`, not merged
into `feat/artifacts` until Slides is whole) added a generic path that sends a case through the real catalogue:
`scripts/eval-artifact-contracts/tool-path.ts` (+ its test) and `run-tool-suite.ts` (+ test). Bring the generic files into
your branch with `git checkout feat/artifacts-s4-deck -- <paths>` (list them with `git diff --stat
feat/artifacts...feat/artifacts-s4-deck -- scripts/eval-artifact-contracts/`; take nothing Slides-specific — no
`suites/slides.ts`, no `fixtures/slides/`), register `canvas` in `run-tool-suite.ts`'s `TOOL_SUITES` in place of `slides`,
and keep `tool-path.ts` byte-identical unless you must change it (say so in the report: the orchestrator merges the two
branches later). Read S4-D's report §4 (`…/scratchpad/w3/s4d-report.md`, lines 69–158) first: the model opens with lookups
(`memory_context`, `use_skill`, `image_search`, `read_generated_file`) that the path answers and follows; ~14.6k prompt
tokens per case; thinking off; a 12-answer run has a spread of about ±2, so run 3 repeats and report a rate; commit the
scorer before the first live run, and put any scorer change made after seeing answers in its own commit with a before/after
re-score of the recorded answers. S4-D also measured that about 1 in 10 first attempts fumbles **JSON inside the `body`
string**: if Canvas's create body shows the same, prefer guidance that creates the board small and then places blocks with
`edit_artifact` ops (structured, schema-checked), and measure it.

## Step 1 · The Canvas handlers

- **create**: `body` is the board JSON (nodes with `id`, `type`, `position`, `data`, optional `parentId`; `edges`) or
  empty for an empty board. Parse through S3-P's `normalizeCanvasBody` with the five model-creatable kinds' schemas
  (ruling 64); a node the model may not make, or data that fails its schema, refuses the create with a message that
  names the fix — never a silently thinner board. Abort before write (53), `artifactId` honoured (Regenerate), metadata
  recorded, `author: "alfy"`.
- **read**: `blocks` = `[{ id, kind, label, x, y, parentId }]` (slice-5's shape) where `label` is the node's human text
  (a sticky's or text's words, a frame's label, a checklist's label and items, a chart's label), clipped; plus width and
  height if the model needs them to avoid overlaps (say so in the report). `detail: "full"` returns the canonical body
  under ruling 53's read bound.
- **edit**: advertise `ops` with S3-P's `boardOpsArraySchema` in `buildEditArtifactModelInputSchema` — the same schema
  the handler parses (ruling 62), replacing today's `z.array(z.unknown())`. The handler calls the facade's
  `applyArtifactOps` in-process against the current version (the model addresses ids, not versions), and turns every
  refusal into model-facing text that names what would have worked (the valid op names, the five kinds it may add, the
  ids that exist on the board). Widen `ArtifactRefusalReason` with `BoardRefusalReason` (never redeclare).
- **The description**: `kind-prose.ts`'s canvas lines must match the vocabulary exactly (check every op name), and the
  canvas gets **one compact worked example** (like `EDIT_ARTIFACT_DOCUMENT_EXAMPLE`) that a test parses through
  `boardOpsArraySchema` **and** `validateBoardDiff` against a fixture board with zero refusals. Do the same for the
  create body example.
- Registering Canvas advertises it: raise `CATALOGUE_TOKEN_CEILING` by the measured cost plus the existing margin,
  numbers in the commit message, and update the frozen catalogue snapshots in the same commit (ruling 62; the test's
  note). Keep the words few: the schema carries the shape.
- Tests: `document-handlers.test.ts`'s cases for Canvas (scope, unknown id with candidates, refusal text naming the fix,
  abort, metadata, Regenerate through `recreate.ts` under the same id), the example round trips, and an edit whose ops
  are half refused applying the other half.

## Step 2 · The canvas eval, live (T10)

- `suites/canvas.ts`, `fixtures/canvas/` with committed `responses/`, the rubric scorer, its `cases.ts` entry. Fixtures:
  a real stored board + "arrange Saturday" (the prototype's scenario: slice-3 1183–1202 names it), a board + "add a
  frame for Sunday with three stickies", a board + "remove the museum note and connect lunch to the walk", and one create
  ("make me a board for planning a weekend in Vienna"), each in EN and one in HU. Rubric (slice-5 line 724): every diff
  parses; zero `invalid_data`/`cycle` refusals where the fixture should apply; every requested item on the board; ids
  resolvable; nothing moved out of its frame; no two nodes overlap after arranging; labels non-empty; nothing removed
  the request did not name. Known-bad (line 768): recorded responses, never model calls (ruling 59).
- **The live run goes through the real tool** (ruling 62): the model gets the real `read_artifact` payload and the real
  `edit_artifact` / `create_artifact` description and schema, exactly as the app sends them. If the harness cannot do
  that, make it do so for your suite without editing `run.ts`, `config.ts` or `client.ts` (ruling 44), or stop and report.
- Run it live through the tunnel, sequentially. Report the numbers as measured. Tuning the description or the example is
  fair (measure before and after); tuning the scorer or fixtures to pass is not. A miss is reported, not argued away.

## Proof

No UI. Full gates once at the end. The report lists the final model-facing description text for Canvas (EN and HU), the
catalogue numbers before/after, and the per-fixture eval results with the re-run commands (live and `--replay`).
