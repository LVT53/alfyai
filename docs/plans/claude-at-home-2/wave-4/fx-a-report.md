# FX-A · I-1: Alfy's board edit never overwrites the reader's newer words, even when their save coalesced

Agent: `claude-sonnet-5-5` · worktree `art-fxa4`, branch `fix/artifacts-w4-stale-read` (from `feat/artifacts` at
`65b9beb3`, which is `ce62e412` plus the RV-F dispatch note) · port 5400 · 2026-10-07.

**Status: DONE** (details and one deviation below). Commits `7de0f98b..5af3c6ef` (five, on top of `65b9beb3`).

## What was wrong (RV-F I-1, confirmed)

The edit tool judged ruling 67's "the reader changed it after you read the board" by naming the VERSION the model last
read (`lastKnownBoardVersion`, a version id) and the envelope (`applyArtifactOps`) looked at that version's body only
when its id differed from the newest. The reader's own saves within ten minutes are written INTO their newest version
(ruling 47, the body route's default `coalesce !== false`): when that is the version the model read, its id is
unchanged and its words are not. The envelope then saw "nothing changed since the read", and `update_node`, `move` and
`remove_node` landed on the reader's new words. FU-1 had fixed exactly this for the `@Alfy` comment reply (it holds the
body it showed the model, `readBody`) and left the tool path, the far more common one, on the version id.

It was worse than RV-F's probe showed: the same hole sat in how the model's *own* edit moved "what it knows" forward
(`parentVersionId === known`): with a coalesced reader save between the read and the model's first edit (on another
block), that edit looked as if it had landed directly on what the model knew, moved `known` to its own version, and
the NEXT edit then overwrote the reader's words. Both are closed.

## The fix, by step

**Step 1 · red.** `canvas-stale-read.test.ts` calls the REAL tools: `createNormalChatTools({ userId, conversationId,
turnId })` → `tools.read_artifact.execute` / `tools.edit_artifact.execute` (the real `executeToolWithEnvelope`, the
real recorder, the real migrated test database), with the reader's save made the way the body route makes it
(`saveCanvasBoard({ coalesceUserEdits: true })`; the test first asserts the save did coalesce: the newest version's id
is unchanged). On the unfixed tree: **3 failed | 5 passed** (log: `w4/fx-a-red.log`):

- `refuses an update to a note the reader rewrote after the read, though their save coalesced…`: got `applied: 2`, no
  refusal (the reader's words overwritten), expected `applied: 1` + `refused: [{ note-museum, stale }]`;
- `writes nothing when the only op was on the note the reader rewrote`: got `success: true`, expected `false`;
- `still protects the reader's words when their save coalesced before the model's first edit…`: second edit
  `success: true`, expected refused.

The five that pass on the unfixed tree are the ones that were already right and must stay right (the reader's save
AFTER the model's own edit; reading once and editing twice; reading again; no read in the turn; no body in the record).

**Step 2 · the fix** (commit `7de0f98b`).

- `canvas-model.ts` (pure, no module state): `KnownBoards` + `createKnownBoards(max = MAX_KNOWN_BOARDS_PER_TURN = 8)`:
  the stored body of each board the turn was shown, `get` / `remember`, insertion-ordered so a board read again is the
  newest and the one forgotten is the one learned of longest ago. In memory only.
- `read.ts`: the Canvas read handler returns `readBody: record.body` (the very row `blocks` was built from);
  `runReadArtifactTool(…, turnContext?: { knownBoards })` remembers it, unless the signal had already fired (the
  envelope called the read failed: the model was not shown it). `readBody` is not in the model's payload and not in the
  tool call's metadata (only `versionId` is, as before).
- `edit.ts`: the Canvas handler passes the turn's words as `readBody` and the turn's last read version as
  `readVersionId` (the fallback), straight into `applyArtifactOps`, which already prefers `readBody` (FU-1). After an
  edit LANDS (`outcome.changed`), `moveKnownBoardForward` moves the store to the new version's body only if the
  version the edit landed on had exactly the words the model knew (`getVersionBody(base) === known`); otherwise what
  the reader wrote in between is still unseen and the words it read stay. Not moved either when the signal had fired
  (a call the envelope has told the model failed). Read AFTER the write from the two immutable versions: Alfy's is the
  newest now, so the reader's next save is a version of its own and the base's words are final; the write itself carries
  `baseHash`, so it had been refused had they moved since the envelope read them.
- `normal-chat-tools/index.ts` (three spots, see Deviations): one `createKnownBoards()` per `createNormalChatTools`
  call, next to the other same-turn state (`sameTurnProduceFileVerdicts`, `totalCreateArtifactCalls`), handed to the
  read and the edit runner through `turnContext`.

**Step 3 · tests that pin each rule** (commit `f23dffb2`; each seen to fail with its guard removed):
`canvas-model.test.ts` (the store: bound, replacement, re-read moves to the end, per-store isolation, default 8),
`read.test.ts` (what the turn keeps of a read, nothing from a cut-off read, nothing for a missing id, no store is
fine, words on neither the answer nor the record), `canvas-handlers.test.ts` (the real Canvas handler hands over the
stored words word for word; the refusal with the version id still the newest; the store moves forward only when the
edit landed on the board it knew; not for a highlight; the version-id fallback for an empty store),
`canvas-stale-read.test.ts` (+ a later turn starts with no read), and `canvas-stale-read-cutoff.test.ts` (the stop
arrives while the edit is written: the write lands, the model is told it failed, and the block it changed reads as
changed since until the board is read again; arranged by a pass-through wrapper on the facade's `listVersions` that
aborts the turn's signal, everything else real).

**Step 4 · docs.** `AGENTS.md` (the ruling 67 bullet now says the judge is the body, where the store lives, when it moves,
and why a version id alone cannot be the judge) and a comment in `artifacts/ops.ts` (`readBody` doc names the edit tool
too). Commits `c7a2bab6`, `6fafc777`. `5af3c6ef` types one cast in the cut-off test that svelte-check refused.

## Gates

| Gate | Result |
|---|---|
| `npm run check` | **0 errors, 17 warnings** (ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1: the pre-existing set) |
| `npx biome check src scripts tests` | clean (2,496 files) |
| `npm test` (full vitest) | **1021 files passed, 1 skipped; 16,779 tests passed, 2 skipped** (+~35 new tests) |
| `npm run build` | exit 0; **32 `Unused CSS selector` + 2 `must have an ARIA role`**, the same lines as RV-F's base build (`rvf-build.log`) |
| `npm run check:artifact-chunks` | exit 0. Editor first paint 69.9 kB gzip (ceiling 71,680 B); Chart.js, MapLibre, Mermaid out. Chat route below |
| `npx fallow …` | **124 issues / 4 circular**, identical to RV-F's run on the base by name (no new export, file or cycle) (`w4/fallow-fxa.json`) |
| `npm run check:migrations` | passes unchanged |
| Playwright (every `artifact*.spec.ts`, knowledge, chat, conversation) on :5400 | **509 passed, 23 skipped, 0 failed** (39.8 min; log `w4/fx-a-e2e.log`). The known `settings-admin.spec.ts:411` failure is outside this set |

**Chat route's size (the two numbers the brief asks for).** This change touches no client module (everything is under
`src/lib/server/…` plus tests, `AGENTS.md` and one server comment), so it moves no chat-route bytes. Measured in this
worktree, building each twice because two builds of the SAME commit differ (the build's default version name is a
timestamp, which sits in entry chunks and changes content hashes):

| Build | Chat route, gzip | vs baseline 540,485 |
|---|---|---|
| base `65b9beb3`, build 1 | 542,488 | +2,003 |
| base `65b9beb3`, build 2 | 542,501 | +2,016 |
| mine `5af3c6ef`, build 1 | 542,515 | +2,030 |
| mine `5af3c6ef`, build 2 | 542,489 | +2,004 |
| (RV-F, base `ce62e412`) | 542,478 | +1,993 |

Growth attributable to this change: **0** (the spread between identical-code builds is about ±15 to 25 B, larger than the
difference between any base and any mine build). **For the orchestrator:** that spread means the "55 B of headroom" is
really 18 to 45 B in this environment (I saw +2,030 of the 2,048 allowed on one of my own builds), so FX-B/FX-C's
growth, if any, will tip it. No baseline moved by me.

## Deviations and decisions

1. **The store is a closure of the tool set, not a module-level map keyed by turn.** RV-F suggested "a small per-turn,
   in-process map keyed by turn and artifact (bounded, dropped at turn end; the `regenerating` map in `recreate.ts` is
   the precedent)". `createNormalChatTools` is called once per model run and its closure already holds the turn's other
   same-turn state (`sameTurnProduceFileVerdicts`, `totalCreateArtifactCalls`), and provider failover re-runs the model
   with the same tools. A module-level map has no turn-end hook to drop it from (an aborted turn would leak a body of up
   to 2 MiB), needs a key that can collide, and could in principle be read by another turn; a closure is dropped with the
   tools by construction and cannot be reached from another turn. Bounded at eight boards (a body is at most 2 MiB).
2. **Files beyond the brief's list.** `normal-chat-tools/index.ts` (the wiring: an import, one `createKnownBoards()`, and
   `turnContext` on the two runners; 12 lines), `artifacts/ops.ts` (a doc comment only), `AGENTS.md` (the one bullet). The
   brief named read.ts, edit.ts, canvas-model.ts and their tests; the store cannot reach both tools without the factory.
   None of these is in FX-B's or FX-C's lists.
3. **The model's own edits move the store only on an exact match of words** (string equality of the stored bodies, the
   exact analogue of the old `parentVersionId === known`). A reader's change the guard itself would ignore (a camera
   move, an arrow, a freehand mark, a block they added) also stops it from moving, so the model must read again before
   re-editing a block its own earlier edit changed. That is the old rule's cost too ("an extra read when the reader and
   Alfy touch the same block in one turn", ruling 67), kept deliberately: a looser rule would have needed a second notion
   of "changed" beside `changedSince`.
4. **No Playwright test.** Nothing a person sees changes: it is a model-tool path, so the red test is a failing test on
   the real tool envelope (the brief's "a test that fails on the unfixed tree for anything else"). The e2e specs that
   script `edit_artifact` on a board through the fake model (`artifact-canvas-pill`, `-review`, `-unsaved-step`,
   `artifact-chat-card`, `artifact-versions`) run through the new wiring in the real dev server and pass.
5. **Screenshots:** none (no UI). `w4/shots/fx-a/` not created.

## Open questions / residual risk

- **The fallback still has the old hole**, for a board the store no longer holds: more than eight boards read in one
  turn (the oldest is forgotten) or a tool set rebuilt mid-turn (nothing does that today: one `createToolPack` per model
  run, and failover reuses it). There the edit is judged against the version the model read, and a reader's coalesced
  save into that version slips past exactly as before. Closing it would need the body in a persisted record, which RV-F
  and ruling 67 rule out, or refusing every op on such a board, which would be worse than the hole.
- **A parallel pair of tool calls on one board** (the model emits a read and an edit in the same step, or two edits): the
  edit judged before the read has been recorded sees no read and applies to the board as it is, as it always did; two
  concurrent edits each judge against the words they started with, and only an exact match moves the store, so the worst
  case is an extra read.
- `read_artifact` bounds what the model SEES (`boundReadOutput`: `omittedBlocks`) but the store keeps the whole stored
  body, so a block the model never saw but guessed the id of is still protected from what the reader changed since.

## Hand-off (for whoever builds on this)

- `KnownBoards`, `createKnownBoards`, `MAX_KNOWN_BOARDS_PER_TURN` in `artifact-tools/canvas-model.ts`; `ReadArtifactHandlerResult.readBody`;
  `runReadArtifactTool({ turnContext: { knownBoards } })`; `EditArtifactHandlerParams.turnContext.knownBoards`;
  `moveKnownBoardForward` (private, `edit.ts`).
- A new kind whose edit is judged against a whole body adds `readBody` to its read handler and passes
  `readBody`/`readVersionId` to `applyArtifactOps` exactly as the Canvas handler does; nothing else changes.
- The one place that decides what the model "knows" after its own edit is `moveKnownBoardForward`; do not add a second.
- The through-the-tools harness (`canvas-stale-read.test.ts`: `turn()`, `readerWrites()`, `seedBoard()`) is the template for
  any future test that needs the real envelope plus a reader's coalescing save.
