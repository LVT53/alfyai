# S3-A report: Alfy's change to a board lands, is reviewed as one change, and blocks can be selected

Agent: build agent S3-A, model `claude-sonnet-5-5`.
Worktree `.claude/worktrees/art-s3a`, branch `feat/artifacts-s3-review`, commits `cef58e10..f3568803` (11 commits, 65 files, +8,778 / -92).
Status: **DONE_WITH_CONCERNS** (concerns at the end: editor closure +1.8 kB gzip, Hungarian needs a native read, three deliberate deviations from the brief's wording).

Nothing was pushed, merged or rebased; no other worktree, `main`, `dev`, `feat/artifacts*` or `docs/plans/**` was touched; no subagent was used.

## Commits (oldest first)

| Commit | Why |
| --- | --- |
| `41656819` | Server: say what a change left waiting on a board, and keep it across reloads (Step 2, server half). |
| `1abf6a00` | Chat page hands a board's `edit_artifact` activity to its open panel (Step 1, the seam). |
| `642d5556` | Draw Alfy's change to a board, and let the reader decide it as one change (Step 1 and 2, the surface). |
| `528df9ab` | Show the board an edit of Alfy's, from the chat or a comment, and let the reader decide it (wiring in the editor). |
| `1f2f9b33` | Keep the editor's share of Alfy's change to glue, and check a Redo like an Undo (chunk budget, Redo guard). |
| `63649b99` | Selection pill and the toolbar's Ask Alfy (Step 3). |
| `e2187ed3` | Name what Alfy left alone when it refused every op of an edit (server failure metadata, builder branch). |
| `afa5fa92` | Two defects the screenshots showed: a see-through notice, a frame lit like a note. |
| `81aa5d2e` | Reach the review controller through named functions so Fallow sees the members (zero new findings). |
| `c2d84ce0` | Fake provider: read a board's scripted request from THIS turn's message, not from the bundle around it. |
| `f3568803` | Toolbar's tab order now ends at Ask Alfy before the blocks (test update). |

## Step 1: the change lands where the reader can see it

**The seam (chat page to panel), and exactly what changed there**

- `src/lib/components/artifacts/document/alfy-activity.ts`: `DocumentAlfyActivity` gained an optional `ops` (the model's raw board ops), a new `AlfyRawBoardOp` type, and two helpers were exported (`stringField`, `parseRefusedBlocks`) so the board's builder reuses them. Nothing else in the file changed; the Document's builder is untouched.
- `src/lib/components/artifacts/canvas/canvas-alfy-activity.ts` (new): `buildCanvasAlfyActivity(segment)`. A running call is recognised as a board's by `input.ops` (the server has not yet said what kind it is), a settled one by `metadata.artifactKind === "canvas"`. `appliedCount` excludes `highlight` ops (a highlight writes no version). A call in which every op was refused (`metadata.ok === false` with `refusedBlocksJson`) becomes status `"refused"` and names them. Also `acceptedCanvasOps`, `canvasOpTargets` (blocks already on the board that ops address: what the arranging frame surrounds), `highlightedByOps`.
- `src/routes/(app)/chat/[conversationId]/_helpers.ts`: `findLiveDocumentAlfyActivity` now returns `buildCanvasAlfyActivity(segment) ?? buildDocumentAlfyActivity(segment)`. **That is the only change in the chat page's files** (`+page.svelte` is untouched; the pass-through prop already existed).
- `src/lib/components/document-workspace/DocumentWorkspace.svelte`: **untouched** (it already forwards `alfyActivity` to every body).
- `src/lib/components/artifacts/artifact-bodies.ts`: **doc comment only** (says the Canvas body reads `alfyActivity` too).

**The landing** (all of it lazy; see "Chunk" below)

- `src/lib/shared/artifacts/board-diff.ts` (+ test): pure `diffBoards(before, after)`: added/removed/moved/reparented/changed nodes, edge deltas, `touched` in board order (ends of added/removed/changed arrows are touched). Used by the browser's landing and by the server's review, so both agree on what "touched" means.
- `canvas/_lib/alfy-landing.ts` (+ test): `planLanding` splits a change into structural ops (added/removed/reparented/changed, parents before children) and moves; `runLanding` applies structure, `await tick()`, glides moves for `MOVE_MS = 620` with ease-in-out, holds the highlight for `HIGHLIGHT_MS = 3200`. Reduced motion: no tween, no pulse (rings stay, static). `ARRANGING_MIN_MS = 600` so a fast tool is still seen arranging.
- `canvas/_lib/review-controller.svelte.ts` (+ test): `CanvasReviewController`. Holds `arranging`, the pending `change`, `pulseIds`, index/goto for stepping, the refusal and undo-refused notices, `busy`, an announcement for the live region, `replyChips`. Landings are serialized (`#enqueue`): a second one waits, never interleaves. `onActivity` de-duplicates by `${key}:${status}` (once per activity); `restore` (a body mounted after the activity settled reads the server's state instead of landing it: the Document's `settledActivityKeyAtMount` rule, so the change is never counted twice).
- `canvas/AlfyChangeLayer.svelte` (+ test): drawn inside the editor's own `ViewportPortal target="front"`: dashed arranging frame around the targets, one ring per touched node (`ring--pulse` while the highlight lasts, `ring--frame` a lighter ring for frames, `ring--active` for the one being stepped to), and the shared `ChangeBar` pill counter-scaled at the corner of the touched nodes' bounding box (`review-geometry.ts`, + test).
- `canvas/CanvasReviewNotices.svelte`: the "Alfy is arranging…" pill, the shared `RefusalNotice` for skipped ops and for a refused Undo, and an `sr-only` live region (`canvas-review-live`).
- `canvas/CanvasBoard.svelte`: new exported `current()`, `place()`, `hold()` and a `held` state: while a landing runs, the board's own commit is skipped and drag/connect/delete are disabled (a landing never fights the reader's hand).
- `canvas/CanvasToolbar.svelte`: **Ask Alfy** is disabled while Alfy is arranging (`alfyBusy`), with the reason as its title/announcement (`artifacts.canvas.ask.busy`).
- `canvas/CanvasEditor.svelte`: glue only (props `alfyActivity`, `onPendingReviewCountChange`; `ensureReview`, `restoreReview`, `adoptBoard`; the activity `$effect`; the layer snippet).
- Comment reply: an `@Alfy` reply's change goes through the same landing. `CanvasCommentsController` got `onreply`; the controller links the reply (`linkReply`) so the reply's card shows the change chip (`changeStateByCommentId`), and `onSeeChange` runs `seeChange` (steps to and centres the touched blocks).
- Server addition (tiny): `normal-chat-tools/artifact-tools/edit.ts` failure metadata now carries per-op `refusedBlocksJson`, so an edit in which every op was refused can still say which ones were left alone (asserted in `canvas-handlers.test.ts`).

## Step 2: Keep / Undo as ONE change, across reloads (ruling 63)

**Server** (behind the existing review route and facade; nothing route-local):

- `src/lib/shared/artifacts/canvas-review.ts` (+ test): pure `computeCanvasReview({ throughVersion, versions })` returns `{ changes, touchedIds, removedCount, count, latestAlfyVersion, undo }`. Pending = every Alfy version newer than the marker; touched ids = the diff of each version against its parent, per node "last change wins", only Alfy-owned nodes still on the board; a removal-only change counts 1. `undo` is `{ available: true, toVersion, toVersionId }` or `{ available: false, reason: "nothing_to_undo" | "user_edited" | "parent_missing" }`. Undo goes back to the version before the trailing unbroken run of Alfy versions newer than the marker; any reader version after them makes it unavailable.
- `src/lib/server/services/artifacts/canvas-review.ts` (+ test): `getCanvasReviewState`, `acknowledgeCanvasReview` (clamps `throughVersion` to the newest Alfy version at or below the request, never moves backwards, does not bump `updatedAt`), `computeCanvasPendingReviewCounts` (bulk, versions from the marker up). `readDocumentReviewMetadata` (existing marker reader) was exported from `document-ops.ts`.
- `src/lib/server/services/artifacts/review.ts` (new, exported by `index.ts`): `getArtifactReviewState` / `acknowledgeArtifactReview` dispatch on kind (Document: unchanged `{ ok, kind: "document", pending }`; Canvas: `{ ok, kind: "canvas", review }`; other kinds: not found).
- `read-model.ts`: `pendingReviewCount` now merges the board counts, so the in-chat card, the panel list row and the count button's dot read **one source**.
- Route `src/routes/api/artifacts/[id]/review/+server.ts` (+ `review.test.ts`, 9 tests): the same GET/POST; POST takes `{ blockIds }` (Document) or `{ throughVersion }` (board) and answers the recomputed state (`{ ok: true, ... }`). Ownership scope as everywhere; `?conversationId=` for an incognito chat; a missing id, another user's board, a kind with no review all answer the identical 404 body.
- `src/lib/client/api/artifacts.ts`: `fetchCanvasReviewState`, `acknowledgeCanvasReview`.

**Client**

- One `ChangeBar` pill at the corner of the touched nodes' bbox (`canvas-change-pill`) and the shared `ReviewBar` below the board (`canvas-review-bar`; prev/next centre the camera on the block). Keep / Undo apply to the whole change ("Keep all" / "Undo all").
- **Keep** moves the marker (`acknowledgeCanvasReview`) and the layer/dot follow. **Undo** saves the parent version's body back as a **user** version through `saveArtifactBody(..., { summaryKind })`, so the version's summary is the shared "Undid Alfy's change" (`version-summaries.ts`); if the reader changed the board after the change, the server says `user_edited` and the shared `RefusalNotice` explains it and offers **Open Versions**. A **Redo** (same rules, checked the same way against the guard) follows an Undo.
- Chord: the Document's shortcuts file owns it: `⌘/Ctrl+Alt+Z` (Undo Alfy's change), `+Shift` (Redo); never the reader's own undo (`⌘/Ctrl+Z`).
- Survives reload: after a reload the body reads the server's state (`restoreReview`) and draws the same one change; Keep then reload shows nothing pending.

## Step 3: selecting blocks (Ask Alfy, Comment)

- `canvas/CanvasSelectionPill.svelte` (+ test) in the existing lazy `comment-parts.ts`: the pill "Ask Alfy · Comment" appears below the selection (`selection-pill-placement.ts`, + test), hides on Escape (capture-phase window listener, so it wins over the board's own Escape), both actions reachable by keyboard (Tab to the pill's buttons and Enter, or the chords Ask = Ctrl+Alt+A / ⌥⌘A and Comment = Ctrl+Alt+M / ⌥⌘M, written on the buttons and in `aria-keyshortcuts`; the shared shortcuts file owns them: `selectionChordFor`, `selectionChordLabel`, `selectionChordAriaKeyShortcuts`).
- **Comment** opens S3-C's composer on the selected node (on the first one when several are selected; the thread's header says "New comment on: X and N more").
- **Ask Alfy** does what the Document's selection bubble "Ask Alfy" does: it opens the same composer with `@Alfy ` prefilled; posting it makes the server's comment hook (S3-C `runCanvasAlfyReply`) answer, and the reply's change lands through Step 1 (with the reply's change chip). With several blocks selected the posted text carries a scope line ("About these blocks: …", `artifacts.canvas.comment.scopeLine`) so the request names them. The toolbar's **Ask Alfy** with nothing selected asks about the whole board (point anchor at the view centre, header "New comment on: the whole board").
- Ask is disabled while Alfy is arranging (pill and toolbar).

## Tests added

About **198 unit/integration tests** (161 in new files, about 37 added to existing ones) and **21 Playwright tests** (+1 updated). They were written before the code they cover, as the brief asks. The last defect found (the fake provider hijacking later specs, Deviation 9) was seen failing twice: in the e2e pair run, and in the new integration test run against the old harness.

New unit files (tests each):

- `src/lib/shared/artifacts/board-diff.test.ts` (13): the diff both sides share (adds, removals, moves, reparenting, edges, order, arrows' ends).
- `src/lib/shared/artifacts/canvas-review.test.ts` (14): pending set, per-node "last change wins", removal-only counts 1, highlight-only is not pending, Undo target and every `undo.reason`.
- `src/lib/server/services/artifacts/canvas-review.test.ts` (10): service state, acknowledge (clamped, never backwards), bulk counts, ownership scope, incognito.
- `src/routes/api/artifacts/[id]/review/review.test.ts` (9): GET/POST for a board and a Document, another user's board 404s with the identical body, `?conversationId=`.
- `canvas/canvas-alfy-activity.test.ts` (13): running/applied/refused/failed, highlight not counted, fully refused, a Document's edit is not a board's.
- `canvas/_lib/alfy-landing.test.ts` (12): structure first (parents before children), `tick()`, 620 ms glide, 3200 ms highlight, reduced motion, abort.
- `canvas/_lib/review-controller.test.ts` (37): once-only per activity, the second landing waits, restore after settle, Keep, Undo (user version, shared summary), Undo refused after a reader's edit, Redo guard, reply chips, chord, notices, count reporting.
- `canvas/_lib/review-geometry.test.ts` (6), `canvas/_lib/selection-pill-placement.test.ts` (4).
- `canvas/AlfyChangeLayer.test.ts` (17): frame, rings, pulse/no pulse, counter-scaled pill, focus follows the decision.
- `canvas/CanvasReviewSurface.test.ts` (10): the bar, notices, live region.
- `canvas/CanvasSelectionPill.test.ts` (16): appears on selection, Escape hides, chords, Ask disabled while busy.

Existing files extended: `client/api/artifacts.test.ts` (+3), `CommentComposer.test.ts` (+1, `initialText`), `RefusalNotice.test.ts` (+2, `actionLabel`/`onAction`), `ReviewBar.test.ts` (+1), `canvas/CanvasComments.test.ts` (+5), `canvas/CanvasToolbar.test.ts` (+5, Ask Alfy), `canvas/_lib/comments-controller.test.ts` (+10), `document/keyboard-shortcuts.test.ts` (+5, selection chords), `_helpers.test.ts` of the chat page (+3, one rewritten for the App kind), `canvas-handlers.test.ts` (per-op `refusedBlocksJson` assertion), `tests/integration/openai-compatible-provider.test.ts` (+3, the fake provider's board scenario).

Playwright (`tests/e2e/`):

- `artifact-canvas-review.spec.ts` (12): frames what Alfy arranges, structure first, glide, rings; steps through touched blocks with the camera centred; names skipped ops in the shared notice; a fully refused edit (nothing to review, no version); a highlight rings and writes no version; Ask Alfy waits while arranging and says why; **not drawn a second time by a body built later, survives a reload as the same one change**; the count button's dot follows Keep and the reload; Keep then reload shows nothing pending; Undo writes the earlier board as the reader's own version and Redo puts it back; Undo refused after the reader changed the board (writes nothing, points to Versions); the chord is Alfy's change, never the reader's own undo.
- `artifact-canvas-selection.spec.ts` (9): the pill appears under the selection and hides on Escape; not there with nothing selected, follows several blocks; Comment opens an empty box on the block and the pill steps aside; Ask Alfy starts with the name, names every selected block, and the change lands as one change to review; toolbar Ask about the whole board / about the selected block; the chords; both buttons work from the keyboard; an answer to a request lands where the board's own record can be read again.
- `artifact-canvas.spec.ts`: the tab-order test now includes the new Ask Alfy stop.

## Gates (once, at the end)

All run once at the end on the final commit (`f3568803`), Node 22 (`/opt/homebrew/opt/node@22`).

| Gate | Result |
| --- | --- |
| `npm run check` | **0 errors, 17 warnings** (ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1: the pre-existing ones) |
| `npx biome check src scripts tests` | clean (2,339 files) |
| `npm test` | **965 files passed, 1 skipped; 15,212 tests passed, 2 skipped** (was 15,209 before the 3 fake-provider tests) |
| `npm run build` | 0 errors; **32 `Unused CSS selector` + 2 `must have an ARIA role`** (baseline unchanged); `check:artifact-chunks` passes |
| Playwright, port 5510: `artifact*.spec.ts`, `artifacts-*.spec.ts`, `knowledge`, `chat`, `conversation` | **285 passed, 0 failed, 0 flaky** (19.9 min). The first full run had 4 failures, both causes fixed: the tab-order test (Ask Alfy is a new toolbar stop) and 3 chat-card `create_artifact` tests that failed only after my specs (fake-provider bundle bug, Deviation 9) |
| `npx fallow ... --output-file /tmp/fallow-s3a.json` | **124 issues, 4 circular: identical to the baseline, zero added** (health score 70.6, B) |
| `npm run check:migrations` | passes unchanged (no migration in this slice) |

Editor chunk: see below (editor 65.8 kB gzip, closure 70.9 kB gzip).

## Chunk (editor)

| | editor chunk | editor + its own exclusive closure |
| --- | --- | --- |
| before (`cef58e10`) | 220.8 kB raw / **65.9 kB gzip** | 2 chunks, 229.4 kB raw / **69.1 kB gzip** |
| after | 221.2 kB raw / **65.8 kB gzip** | 3 chunks, 234.7 kB raw / **70.9 kB gzip** |

Everything new loads on demand. The editor keeps only glue (its own chunk is 0.1 kB gzip **smaller** than before); the closure is +1.8 kB gzip because the review/landing code is one extra lazy chunk behind `canvas/review-parts.ts` (guard: `--allow-entry review-parts` in `package.json`), and the selection pill sits in the existing lazy `comment-parts.ts`. The closure was already above the 65 kB figure before this slice (69.1); I did not fix that, the slice adds 1.8 on top.

## Screenshots (looked at each one myself; Hungarian; not committed)

Folder `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/shots/s3a/`

1. `01-arranging-desktop-hu-light.png`: the dashed arranging frame around the blocks Alfy addresses and the "Alfy épp rendezi…" pill.
2. `02-landed-pulse-desktop-hu-light.png`: the highlighted result, the pill at the corner of the touched blocks.
3. `03-review-desktop-hu-dark.png`: the review bar, dark.
4. `04-review-phone-hu-light.png`: the review bar at 390x844 (44 px targets).
5. `05-undo-refused-desktop-hu-light.png`: the refused-Undo card pointing to "Változatok megnyitása".
6. `06-selection-pill-desktop-hu-light.png`: the selection pill.
7. `07-ask-composer-desktop-hu-light.png`: Ask Alfy's composer with `@Alfy ` prefilled.
8. `08-selection-pill-phone-hu-light.png`: the selection pill at 390x844.

Defects the screenshots showed, fixed in `afa5fa92`: the refusal notice was see-through (the board showed through it; now a solid `--surface-page` card), and the arranging frame pulsed as loudly as a touched note (now a lighter `ring--frame` keyframe).

## Deviations from the brief, and why

1. **"Ask Alfy sends the chat a request"**: the Document's selection "Ask Alfy" does not send a chat message; it opens the comment composer with `@Alfy ` and the server answers in the thread (that is the path the brief tells me to reuse). The board does the same, and the change lands through Step 1. If the owner wants a chat message instead, it is a different path (composer prefill in the chat page) and touches the chat page.
2. **The landing is diff-based** (`diffBoards(before, after)`), not an interpretation of the op list. The browser gets no per-op server answers (only flat metadata), and a comment reply's change arrives as a version, not as ops; one function now serves the chat's edit, a comment reply's edit and the review after a reload, and the server's review uses the same function.
3. **Count = touched blocks**; a removal-only change counts 1 (nothing to step to, only "removed N"). Highlights never count (they write no version).
4. **Undo goes back to the version before the trailing unbroken run of Alfy versions newer than the marker.** It is unavailable (and the shared refusal card says why) when a reader's version comes after Alfy's (`user_edited`, as ruling 63 says), when there is nothing to undo (`nothing_to_undo`) or when the parent version is gone (`parent_missing`).
5. **The selection pill sits below the selection**, not above, so it never covers the change pill or the node handles.
6. **Redo** exists (the brief names only Undo): an Undo of Alfy's change would otherwise be one-way; it is checked like an Undo (against the guard) and has the `+Shift` chord.
7. **Optional additions to shared components** (Document callers unchanged): `ReviewBar` (`summary`, `regionLabel`), `RefusalNotice` (`actionLabel`, `onAction`), `CommentComposer` (`initialText`), `document/keyboard-shortcuts.ts` (`selectionChordFor`, `selectionChordLabel`, `selectionChordAriaKeyShortcuts`).
8. **A server-side change in the tool** (`edit.ts`): a fully-refused edit's failure metadata now carries `refusedBlocksJson`. Additive; nothing read it before.
9. **Test infrastructure** (`tests/mocks/ai-provider/openai-compatible-provider.ts`, `tests/fixtures/ai/openai-compatible-scenarios.ts`): a scripted board edit scenario (`AI_SMOKE_CANVAS_EDIT_MARKER`, `encodeCanvasEditScenarioPayload`). The first version of it hijacked the chat-card specs run after it: the app sends ONE user message that is a context bundle whose retrieved evidence carries the finished tasks of the user's OTHER conversations (request text included), so the board's marker turned up in the next spec's message and won the dispatch. It is now read from the bundle's `## Current User Message` section only (`currentTurnText`), covered by three integration tests in `tests/integration/openai-compatible-provider.test.ts`, seen failing before the change.

## Open questions and concerns

- **Editor closure +1.8 kB gzip** (70.9 vs 69.1; the editor's own chunk is 0.1 smaller). The lazy entry is one chunk; splitting further does not lower the total.
- **Hungarian needs a native read.** Judgement calls: "Alfy 3 blokkot módosított.", "Alfy módosítása itt nem vonható vissza, mert azóta megváltozott a tábla.", "Alfy épp rendezi:", "Ezekről a blokkokról:", "Új megjegyzés az egész táblához", "Új megjegyzés ehhez: {target} és még {count}" (no ICU plural: a Hungarian noun stays singular after a number).
- **The camera does not move on a landing or a restore**, so a touched block can be off-screen; the review bar's prev/next (and the chip's "see change") centre it. Whether the landing should pan by itself is a product choice I did not make.
- **Whole-board Ask leaves a pin at the view centre** (a point anchor). It is a comment thread like any other; deleting the thread removes it.
- **The review is recomputed from the version bodies newer than the marker on each read.** Cheap for a normal board; a board with hundreds of Alfy versions since the last Keep would read them all. A cached diff per version is possible later.
- **A removal-only change** counts 1 and has nothing to step to.
- **The refusal notice overlays the top-centre of the board** and can cover blocks until dismissed.
- **A landing while the reader has unsaved edits** shows the existing conflict banner (the reader's edit is never overwritten).
- **Undo/Redo window is lost if the panel closes** (the Redo state lives in the controller); the Undo itself is a saved version and stays in Versions.
- **The comments column narrows the board without moving the camera** (S3-C's open question, unchanged).
- A baseline canvas e2e test, "moves between the menu's rows", is flaky in full runs (passes alone); not related.

## Hand-off

**For S3-Z / S3-R1 / the merge**

- Files most likely to conflict: `canvas/CanvasEditor.svelte` (glue: `reviewHost`, `ensureReview`, `restoreReview`, `adoptBoard`, the `boardLayers` snippet, `handleWindowKeydown`, `askAlfy`), `canvas/CanvasBoard.svelte` (`current()`, `place()`, `hold()`, `held`, `onselect`, `onask`, `askBusy`), `CanvasToolbar.svelte` (Ask Alfy last), `src/lib/i18n/artifacts.ts` (my keys are one block per locale, `artifacts.canvas.arranging` .. `artifacts.canvas.comment.scopeLine`), `package.json` (`--allow-entry review-parts`).
- Seam: `DocumentAlfyActivity.ops?` and `AlfyRawBoardOp` in `document/alfy-activity.ts`; the chat page's `_helpers.ts` (`findLiveDocumentAlfyActivity`). Keep both sides on merge.

**Modules and exports**

- Lazy entry `canvas/review-parts.ts`: `CanvasReviewController`, `changeLayerProps`, `reviewSummary`, `reviewActivity`, `reviewRestore`, `reviewReply`, `reviewKey`, `reviewEnd` (typed wiring functions, because Fallow only recognises class-member use through typed params in `.ts` files or `$props`-typed props), `AlfyChangeLayer`, `CanvasReviewBar`, `CanvasReviewNotices`. Nothing in it may import `@xyflow/svelte`; the editor may not import it statically.
- Lazy entry `canvas/comment-parts.ts` gained `selectionPillProps` and `CanvasSelectionPill`.
- Pure: `shared/artifacts/board-diff.ts` (`diffBoards`, `isEmptyDelta`), `shared/artifacts/canvas-review.ts` (`computeCanvasReview`, `EMPTY_CANVAS_REVIEW`, types `CanvasReviewVersion`, `CanvasReviewChange`, `CanvasUndo`, `CanvasReviewState`), `canvas/_lib/alfy-landing.ts`, `review-geometry.ts` (`rectsOf`, `boxOf`, `padded`), `selection-pill-placement.ts`.
- Server facade (`services/artifacts/index.ts`): `getArtifactReviewState`, `acknowledgeArtifactReview`, type `ArtifactReviewResult`; `read-model.ts` merges canvas counts into `pendingReviewCount`.
- Client API: `fetchCanvasReviewState`, `acknowledgeCanvasReview`.
- `CanvasReviewController` host contract: `ReviewHost { artifactId, conversationId, board(), saveNow(), guard(), saved(), adopt(), openVersions(), reportCount() }`; `LandingPort { land, place, hold }` is what `CanvasBoard` implements.
- `CanvasEditor` props: `alfyActivity?: DocumentAlfyActivity | null`, `onPendingReviewCountChange?: (count: number) => void`.
- Comment side (S3-C's controller): `onreply`, `placeOnBlocks`, `placeOnBoard`, `draftAsk/draftScope/draftWhole/draftToken`, `selectionPillProps`.
- Test ids: `canvas-arranging`, `canvas-arranging-frame`, `canvas-alfy-ring`, `canvas-change-pill`, `canvas-review-bar`, `canvas-review-live`, `canvas-selection-pill`, `canvas-selection-ask`, `canvas-selection-comment`, `canvas-tool-ask`.
- e2e scenario: `AI_SMOKE_CANVAS_EDIT_MARKER` + `encodeCanvasEditScenarioPayload({ artifactId, summary, ops })` scripts a real `edit_artifact` call; it is read from `## Current User Message` only. **Any new fake-provider scenario must do the same** (or it will be hijacked by, and will hijack, other specs through the context bundle).

**Suggested AGENTS.md paragraph (Artifacts section; I did not edit AGENTS.md)**

- **Alfy's change to a Canvas** (Slice 3 S3-A, ruling 63). One change, reviewed once: the server's `review.ts` dispatches on kind and `canvas-review.ts` computes the pending change from the versions newer than the review marker (`metadata.review.throughVersion`); the same `diffBoards` (`shared/artifacts/board-diff.ts`) decides what is "touched" for the server's count and the browser's landing. The count feeds card, list row and the count button's dot from `read-model.ts`, never from a client copy. The landing, the ring layer, the review bar and the notices are ONE lazy entry (`canvas/review-parts.ts`); the editor keeps glue only and never imports it statically. Keep moves the marker; Undo saves the parent version's body as a **user** version with the shared summary and is refused once the reader has changed the board (the shared refusal card points to Versions). Ask Alfy on blocks or the board is the comment path (`@Alfy` thread), not a chat message. Fake-provider scenarios read the bundle's `## Current User Message` section only.

## Commit list

See the table at the top (`cef58e10..f3568803`).
