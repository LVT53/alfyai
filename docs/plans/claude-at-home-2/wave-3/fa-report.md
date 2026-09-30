# F-A report · the Canvas protocol and the model's contract (RV-3 cluster A)

Fix agent F-A, model `claude-sonnet-5-5`. Worktree `art-fxa3`, branch `fix/artifacts-w3-protocol` (from `feat/artifacts` at
`281fbc3b`). Nothing pushed, merged or rebased; no subagent dispatched; no other worktree touched.

**Commits `5fd135a8`..`4a0d8927` (11):**

| Commit | What |
|---|---|
| `5fd135a8` | C1 — a checklist that repeats an item id no longer keeps a board from opening |
| `adacfd7a` | C2 — what Alfy adds is stored 190 wide, read/drawn/scored at the size its words make, tool text and example agree (catalogue + ceiling) |
| `344fd956` | I5 — ruling 67's allow-list for `update_node` on the five app-owned kinds |
| `0ac667dc` | I6 — ruling 67's `stale` refusal, from the turn's own read |
| `77e145eb` | Minor 5 — self-loop arrows, and ids a block and an arrow would share |
| `04f9c40f` | Minor 6 — the ops route writes the user's own version |
| `0189b977` | Minor 7 — one `parentsFirst`, one review-marker bootstrap, one marker read in a transaction |
| `f601ee8f` | C2's client half and Minor 7's third copy — `_lib/board.ts` measures an unmeasured block the way the model reads it and shares `parentsFirst` |
| `31216be7` | eval re-measured on the geometry the reader sees (first pass, estimate at 21 characters a line) |
| `d0741d8c` | calibration: 18 characters a line, from 50 natural notes measured in the browser |
| `4a0d8927` | eval re-measured and its committed run re-recorded on the final tool text |

## Per finding: the failing test, the fix, the commit

### C1 · duplicate ids brick the board — `5fd135a8`
- **Failing tests, each seen red first.**
  - `canvas-blocks.test.ts` (6): `repeatedEntryIds` / `withUniqueEntryIds` (new helpers).
  - `board-ops.test.ts` (3): an `add_node` checklist with two items of id `"1"` was accepted (the review's P3); so was an `update_node`
    leaving two items with one id; and the create path.
  - `canvas-body.test.ts` (3): `normalizeCanvasBody` keeps the block, makes the ids unique, reports it, and is a fixed point.
  - **e2e** (`artifact-canvas.spec.ts`, "opens a board whose checklist repeats an item id…"): seeds the review's bricked board. With the
    repair switched off it fails at `openCanvasPanel` (`canvas-board` never appears: the loading skeleton forever); with it, both
    checkboxes are there and the second is checked.
- **Fix.**
  - `canvas-blocks.ts`: `repeatedEntryIds(data)` and `withUniqueEntryIds(data)` for the three lists a block draws by id (a checklist's
    items, a photo block's pictures, a web block's links).
  - **Model door.** `board-ops.ts` refuses per op, `invalid_data`, naming the id and the fix ("checklist item ids must be unique: "1" is
    used more than once. Give every item its own id, for example "i1", "i2", "i3"."), on `add_node`, `update_node` and therefore the
    create path. **Deliberately not a zod refinement** on the advertised union: `boardDiffSchema` would then fail the *whole* diff
    (`invalid_diff`) instead of refusing one op, which breaks the "a batch applies partially" contract (the JSON Schema cannot say
    "unique" anyway). `BLOCK_SHAPES_HINT` says each id is used once.
  - **Read door.** `normalizeCanvasBody` keeps the block and every word: the first entry of an id keeps it, each later one gets
    `<id>-2`, `<id>-3` (never an id another entry has, inside the 128 cap). It returns a new `repaired: string[]` (the block ids it did
    this to); `prepareCanvasBoard` carries it too.
- **Not done here (cluster B):** the client's `each` keys and the optional `<svelte:boundary>`. Keys need no change to be safe: the client
  only ever meets normalized ids now.

### C2 · what Alfy makes is drawn the size Alfy is told — `adacfd7a`, `f601ee8f`, `d0741d8c`, `31216be7`, `4a0d8927`
- **Failing tests, seen red first.**
  - `applyOp` stores no width (`board-ops.test.ts`).
  - The estimator against heights measured in the browser (`canvas-blocks.test.ts`).
  - The read's heights (`canvas-model.test.ts`).
  - The eval's geometry: a 94-character note in a 200-high frame at y 100 now sticks out and covers the note 100 below (it counted 84 and
    passed); the create example passes its own rule.
  - **e2e** ("draws what Alfy adds inside its frame…"): a board built with Alfy's own ops, four notes from 13 to 176 characters in a
    420-wide frame, every note 190 wide, no taller than the estimate, inside its frame, clear of the note above it. Red without the
    stored width (`note-0 width` expected 190).
- **Fix.**
  1. `applyOp` `add_node` stores `width: NODE_WIDTH` (190) on every non-frame block the model adds; the create parse goes through
     `applyOp`, so a made board carries it. Frames keep their size.
  2. `estimatedNodeHeight(node)` (`canvas-blocks.ts`) is the one estimate of what the panel draws. The model's read reports it, the
     eval's `sizeOf` measures with it, `_lib/board.ts`'s `nodeRect` uses it, and the tool text is built from its constants
     (`NOTE_MIN_HEIGHT`, `NOTE_LINE_HEIGHT`, `charsPerLine()`, `CHECKLIST_*`).
  3. Tool text, both languages, `create_artifact`'s `body` field and the edit rule: "a block you add is 190 wide (a frame is the size you
     give it); a note is 64 tall for up to two lines (about 18 characters a line), plus 18 for each further line; a checklist is 74
     plus 26 an item".
  4. The create example's frame is 300×240 (the note "lunch" at y 150 ends at 214: inside it, 26 below "museum").
- **Catalogue (ruling 62/23).** Descriptions 5,017 → 5,060 en (+43) and 8,139 → 8,187 hu (+48). `CATALOGUE_TOKEN_CEILING` 5043 → **5086** en
  and 8166 → **8214** hu (measured plus the same 26/27 margin). `edit_artifact` hu stays under the per-tool 750 (it was 769 with my first
  wording; the sentence was cut). Snapshots regenerated with `-u` twice (the wording, then 21 → 18: same token count). The numbers are
  in the C2 commit message and the note beside the ceiling.
- **Measured, not guessed.** Heights come from Chromium with the app's fonts. First pass (10 texts, 21 characters a line) put the
  estimate at "never too short". Then I looked at my own screenshot of an Alfy-made Hungarian board: a 99-character note took six
  lines (16.5 a line, long words waste the end of a line) where the estimate said five, and its frame fitted by a hair. I measured
  50 natural notes (15 Hungarian and 10 English sentences, whole and cut): 21 under-estimated 2, 20 one, **19 and 18 none**, so 18
  (mean 10 units over, at most two lines over). It is one constant (`NOTE_CHAR_WIDTH` 9.4) and a table of 12 natural notes with
  their drawn heights is in `canvas-blocks.test.ts`.
- **Client half.** `board.test.ts` has a test that the board's geometry and the model's read agree "to the number" for an unmeasured
  block. My change broke it (the read said 64, the board's `nodeRect` said 84), so `_lib/board.ts`'s `sizeOf` takes the same estimate
  (also better pill placement for a landing that is not measured yet). Two tests that pinned 190×84 for an unmeasured note pin
  190×64 and a one-line text 32 (`board.test.ts`, `review-geometry.test.ts`).

### I5 · `update_node` lets the model rewrite what the app vouches for — `344fd956`
- **Failing test (red first, 12).** The review's P2 probe as a table: a web block's sources+`fetchedAt`, `query`, `fetchedAt`; a photo
  block's `items`; a file block's `fileId`+`name` and `name` alone; an App block's `artifactId`; a map's and an App's `poster`; a map's
  route data; and a descriptive field together with an owned one (the whole op is refused). Each `invalid_data`, and the detail names what
  may change.
- **Fix (ruling 67, built as written).** `canvas-blocks.ts` `modelUpdatableFields(kind)`: the five note-shaped kinds keep every field but
  `kind`; on the others the model may change only a map's `label`/`route`/`meta` and an App's `title`. **A file, photo or web block has
  no field the model may change** (the ruling lists nothing for them); it can still move, highlight or remove them. `poster` is never
  model-writable (the note-shaped kinds have no such field, the others fail the allow-list). The refusal: `"sources" on a liveweb … is
  set by the app (the Insert menu, Refresh, the screenshot it takes), never by an op. You may change nothing on a liveweb block; you can
  still move it or remove it.`

### I6 · Alfy's edit overwrites what the reader changed after the read — `0ac667dc`
- **Failing test (the review's, red first).** `canvas-handlers.test.ts`: seed v1 → read it as a tool call → the reader saves a note (v2) →
  the edit handler's `update_node` on that note was applied as v3; now `modelPayload.success === false`, `refused[0].reason ===
  "stale"`, no v3, the reader's words stand. Plus the vocabulary (`board-ops.test.ts`), the envelope on a real database
  (`ops.test.ts`), the recorder-derived base (`canvas-model.test.ts`) and the wiring through `createNormalChatTools` (`index.test.ts`).
- **Fix.**
  - **The turn's read.** `read_artifact` on a board records the version it showed in the tool call's metadata (`versionId`; never in
    the model's answer). `lastKnownBoardVersion(entries, artifactId)` (`canvas-model.ts`, pure) is the last successful read, **moved
    forward by the model's own edits that landed directly on the version it knew** (`metadata.versionId` and `parentVersionId` on the
    edit's record) — so reading once and editing twice is not refused for its own changes — and **not** over a version the reader wrote
    in between (their change stays unseen).
  - **The seam, and the one `index.ts` edit.** The edit closure hands the handler `turnContext: { sources: recorder.getEntries() }`,
    the same shape and name S4-V's create seam uses. S4-V's commit `72d974e3` is on `feat/artifacts-slides`, not in this base
    (`turnContext` does not exist here), so this is the "no other way" case short of module-level state keyed by turn: 3 lines in
    `normal-chat-tools/index.ts`, tested in `index.test.ts`. On the merge with Slides the two hunks are in different places.
  - **The envelope.** `applyArtifactOps({ readVersionId })` (in-process only; the route never sets it) loads that version's body
    (`getVersionBody`, scoped) unless it is the newest; the shared mechanism hands the vocabulary the board as read
    (`runOps(..., context)`, `OpsJudgeContext.readDoc`, generic so Slides can use it).
  - **The judge.** `validateBoardDiff(diff, body, { readBoard })` refuses `update_node`, `move`, `remove_node` on a block that differs
    between the read board and now (changed, moved or re-homed: `diffBoards`, the review's own comparison) as **`stale`**: "The reader
    changed "x" after you read the board, so this update_node was not applied and their change stands. Call read_artifact to see the
    board as it is now, then send the change again if it still makes sense." The rest of the batch applies. A highlight and arrows take
    nothing from the reader and are not judged; a block the reader added is not stale; one they removed is the plain `unknown_id`.
    With no read in the turn the edit applies to the current board (ruling 67).
  - `stale` is in `BOARD_REFUSAL_REASONS`, `refusalLabelKey`, and `artifacts.canvas.refusal.stale` in English ("you changed it after Alfy
    looked at the board, so Alfy left it alone") and Hungarian ("a tábla megtekintése után módosítottad, ezért Alfy nem nyúlt hozzá").
- **Known, safe false positive.** If the reader saves between Alfy's read and Alfy's *first* edit, that edit lands on a version Alfy never
  read, so the base does not advance; a later edit in the same turn to a block Alfy itself changed in that first edit is refused
  `stale` and the model reads again. It needs the reader to edit mid-turn and Alfy to touch the same block twice.

### Minor 5 · self-loop arrows, node/arrow id collisions — `77e145eb`
- **Red first (the review's P6):** an arrow from a block to itself and an arrow whose id is a block's were accepted. Now `add_edge` refuses
  a self-loop (`invalid_data`, "An arrow joins two different blocks…"; a missing end is still reported first) and an id that is a
  block's; `add_node`/`add_frame` refuse an id that is an arrow's (`duplicate_id`, each saying which it clashes with); an id is free
  again once its owner is gone. Model door only: no stored board changes.

### Minor 6 · the ops route writes Alfy-authored versions with the caller's summary — `04f9c40f`
- Chose "write `author: "user"` from the route" over removing it (Slides' slice extends the route and its tests; a delete would
  collide with that merge). `applyArtifactOps` takes `author` (default `alfy`: the edit tool and the `@Alfy` reply); the route passes
  `user`, which writes the caller's own version with the ordinary summary `"Edited"` (the version vocabulary's; the caller's text is not
  stored) and **no review marker**. Red first: envelope and route tests (author, summary, no marker on the artifact).

### Minor 7 · duplicated logic — `0189b977`, `f601ee8f`
- **"Parents first"** was written three times. `parentsFirst` (`canvas-body.ts`, exported: same array when already in order, ancestors just
  before the child that needed them, a loop ends the walk, linear and non-recursive) is now what the body's frame settling returns, what the
  create parse uses (through a small adapter), and what `_lib/board.ts` re-exports (`CanvasBoard.svelte` still imports it from there).
  Stored boards settle in exactly the order they did (every hash depends on it), pinned by a test against `normalizeCanvasBody`.
  Red first: order, identity, loops, duplicates, 20,000 deep.
- **The review-marker bootstrap**: `reviewMarkerPatchFor(metadata, parentVersionNumber)` (`document-ops.ts`, next to the marker's reader) is
  used by `applyDocumentPatch` and the ops envelope (which had re-implemented the validity test inline). Red first.
- **The Fallow clone** (`canvas-review.ts` / `document-ops.ts`: the transaction read of an artifact's metadata and marker):
  `readReviewMarkerInTx`, returning the raw JSON too because both writes merge into it. Behaviour unchanged: the Document review tests,
  the board's review tests and the incognito containment suite pass untouched.

## Then measured: the canvas eval, live

`qwen3-6-27b` through the tunnel on **30060**, thinking off, sequential, the committed tool path (`run-tool-suite.ts --suite canvas`), 3
repeats of the six fixtures.

| | Answers | Good | Arrange | Add Sunday en / hu | Remove + connect | Create en / hu |
|---|---|---|---|---|---|---|
| S3-T final (scored on 84-tall notes) | 30 | **24** | 3/5 | 5/5 / 5/5 | 5/5 | 3/5 / 3/5 |
| F-A, first pass (estimate at 21 characters a line) | 18 | **15** | 2/3 | 2/3 / 3/3 | 3/3 | 3/3 / 2/3 |
| **F-A, final text (18 a line)** | 18 | **15** (+1 acceptable) | 3/3 | 2/3 / 1/3 | 3/3 | 3/3 / 3/3 |

- **Final: 15 good, 1 acceptable, 2 bad of 18 (83% good).** The two bad: an `add_edge` naming `"prunch"` for `"brunch"` (mended in the
  next step, the board passed), and a note at y 240 in a 300-high frame (its smallest size, 64, ends at 304). The acceptable one is a
  Hungarian edit made without reading the board first. The committed run, re-recorded on the same text: 6 of 6 good (one run, not a rate).
- What this number is: **not a better model, a different measurement.** S3-T's 24/30 (80%) scored boards against 84-tall notes the reader
  never sees, and the app drew Alfy's notes as wide as their words ran. The same rubric now measures what is drawn; it holds at about the
  same rate with samples of 18 and 30, which is inside the noise of either. The remaining misses are arithmetic in frames and one
  mistyped id — the same two S3-T named.
- The first pass and the final text are both committed with their numbers (`31216be7`, `4a0d8927`); the README's last row says which is
  which and that earlier rows are not comparable.

## Gates (final tree `4a0d8927`, run once at the end)

1. `npm run check`: **0 errors**, 17 warnings (the pre-existing ones: `ToolActivityRow` 10, `ThinkingBlock` 6, `RouteItinerary` 1).
2. `npx biome check src scripts tests`: clean (2,386 files).
3. `npm test`: 985 files passed + 1 skipped; **15,631 tests passed**, 2 skipped.
4. `npm run build`: exit 0, 32 `Unused CSS selector` + 2 `must have an ARIA role` lines (the baseline), no new warning. CanvasEditor chunk
   67.9 kB gzip, 74.2 kB with what it loads (unchanged by me; S3-X's).
5. Playwright, port 5550, `tests/e2e/artifact*.spec.ts tests/e2e/artifacts-*.spec.ts knowledge chat conversation`: **314 passed, 9 skipped, 1 failed of 324** (23.2 min). The one failure is
   `artifact-canvas.spec.ts:413` "moves between the menu's rows with the arrow keys, one tab stop" (`getByRole('menuitem')` counted 6, expected
   5), a test I did not write and that passed in the earlier full run of this tree (315 passed, 9 skipped, before the calibration commit).
   Rerun alone it passes 3 of 3, and the whole `artifact-canvas.spec.ts` alone passes 29 of 29: a flake in the combined run (a second
   `menuitem` on the page), not a regression I can attribute. My new e2e tests (`opens a board whose checklist repeats an item id…`,
   `draws what Alfy adds inside its frame…`) pass in both runs.
6. Fallow: **124 issues, 4 circular**, identical to the review's baseline (a set comparison by file and name finds no new finding).
7. `npm run check:migrations`: passes.

Screenshots (looked at, not committed; `…/scratchpad/w3/shots/fa/`): `1440-hu-alfy-board.png` and `390-hu-alfy-board.png` — a Hungarian
itinerary built with Alfy's own ops (two frames, six notes of 22 to 99 characters), after the calibration. Notes 190 wide, wrapped inside
their frames, no overlap and about a line of slack below the last note; the phone view fits at 37%. The first screenshot (estimate at 21)
is what showed the 99-character note fitting by a hair, which is why there is a second calibration commit.

## Deviations, and decisions the orchestrator should look at

1. **C2 stores a width, not the 190×84 "footprint".** `NodeShell` clips at a stored height (`overflow: hidden`, `block-meta.ts` says a
   stored height is for frames and Apps only), so storing 84 would cut a five-line note. The review's own fix says `width: NODE_WIDTH` and
   "say the truth about height in the tool text"; I did both, and made the read and the eval agree with what is drawn.
2. **I6 touches `normal-chat-tools/index.ts`** (3 lines, `turnContext` on the edit call) for the reason above. The alternative, per-turn
   state in a module-level map, was worse.
3. **I5: a file, photo or web block has no updatable field.** Ruling 67 names descriptive fields only for a map and an App. If the owner
   wants e.g. a file block's display `label` changeable, it is one entry in `APP_OWNED_UPDATABLE_FIELDS`.
4. **Minor 6 keeps the route** (author `user`) instead of removing it; the client `applyArtifactOps` and the route tests stay.
5. **I edited `canvas/_lib/board.ts`, `board.test.ts` and `review-geometry.test.ts`** (client geometry and two tests). They are not in
   cluster B's or S3-X's file lists; my C2 change made the invariant test in `board.test.ts` fail, and Minor 7's third copy of
   `parentsFirst` lives there. Small, and F-B can rebase over it.
6. **The @Alfy comment path has the same overwrite risk and is not covered:** it applies model ops through the same envelope but passes no
   `readVersionId` (its read and its write are seconds apart). It is one `listVersions` call and one argument in `canvas-comments.ts` when
   wanted; ruling 67 names only the edit handler.

## Open questions and concerns

- The estimate is calibrated on Chromium with the app's web fonts. The e2e that pins it (never taller than the estimate + 2, at most two
  lines shorter) would fail if a font failed to load and text wrapped differently.
- Until cluster B's `toFlowNodes` draws an unsized *legacy* node at `NODE_WIDTH`, a stored board without widths (older Alfy boards) is
  still drawn as wide as its words. Everything Alfy adds now stores the width.
- The cached prompt prefix changes (the catalogue is in it): +43 en / +48 hu description tokens, and the two `-u` snapshots.
- `AGENTS.md`'s Artifacts section could name `estimatedNodeHeight`, `parentsFirst` and `OpsJudgeContext` (I did not touch it: conflict-prone,
  the orchestrator's merge).

## Hand-off

- **Shared, browser-safe** (`src/lib/shared/artifacts/`):
  - `canvas-blocks.ts`: `NODE_WIDTH`, `estimatedNodeHeight(node)`, `charsPerLine(width?)`, `NOTE_MIN_HEIGHT`, `NOTE_LINE_HEIGHT`,
    `CHECKLIST_BASE_HEIGHT`, `CHECKLIST_ROW_HEIGHT`, `repeatedEntryIds`, `withUniqueEntryIds`, `modelUpdatableFields`. `DEFAULT_NODE_HEIGHT`
    is now only the fallback for kinds whose height the app decides.
  - `canvas-body.ts`: `parentsFirst(nodes)`; `normalizeCanvasBody(raw)` → `{ body, dropped, repaired }`.
  - `board-ops.ts`: `"stale"` in `BOARD_REFUSAL_REASONS`; `validateBoardDiff(diff, body, { readBoard })`.
  - `ops.ts`: `OpsJudgeContext<TDoc>`, `runOps(vocabulary, doc, diff, context?)`, `OpsVocabulary.validate(ops, doc, context?)` — Slides'
    `deck-ops.ts` can take the same `readDoc`.
- **Server:** `applyArtifactOps({ …, readVersionId?, author? })`; `document-ops.ts`: `reviewMarkerPatchFor`, `readReviewMarkerInTx`;
  `prepareCanvasBoard(...).repaired`; `canvas-model.ts`: `lastKnownBoardVersion(entries, artifactId)`; `EditArtifactHandlerParams.turnContext`
  and `EditArtifactHandlerSuccess.baseVersionId`; `read_artifact`'s tool-call metadata carries `versionId` for a board.
- **For F-B:** `artifacts.canvas.refusal.stale` exists in EN and HU (the panel's refusal list already reads every board refusal reason).
  The client never meets a duplicate entry id now (the normaliser repairs); `_lib/board.ts` re-exports the shared `parentsFirst`;
  `nodeRect` uses `estimatedNodeHeight`.
- **For S3-X / later:** a model-writable `poster` cannot exist (I5), so a poster's `fileId` still needs its own check where it becomes an
  `<img>` path, but the model can no longer put one there.
