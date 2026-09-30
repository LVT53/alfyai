# S3-C report · comments on the board (Canvas, Slice 3 T5)

Agent S3-C, model `claude-sonnet-5-5`. Worktree `.claude/worktrees/art-s3c`, branch `feat/artifacts-s3-comments`, from `519095e5`
(`feat/artifacts` after S3-F's merge). Commits `a03e5815` … `207e3a98` (13, list at the end). Nothing pushed, merged or rebased; no other worktree touched.

STATUS: DONE_WITH_CONCERNS (all gates green; concerns: the editor's true initial chunk grew by 2.1 kB gzip, and the two decisions under Open questions 1-2 are the owner's).

## What I built, per step

### Step 1 · pins, the resolver, the Comment tool

- `src/lib/shared/artifacts/comments.ts` (new): `AnchorResolver<Context>` (the interface: `kinds` + a pure `resolve`), `canvasAnchorResolver`
  (node: `exact` while the block exists, `orphaned` + `reason: "node_missing"` once it does not; point: always `moved`, never invalidated by an
  edit; text: the shared `ORPHANED_ANCHOR_RESOLUTION`) and `mentionsAlfy`. It imports `Anchor`/`AnchorResolution` from `anchor.ts` and redeclares
  nothing (ruling 45). The resolver takes the board's nodes (`{ id }[]`), not the spec's `body: string | null`: the browser resolves against the
  blocks it is drawing, the server reads only `kinds`. `reason` is on an internal widened type because ruling 45's `AnchorResolution` has none.
- Intake: `createComment` (`services/artifacts/comments.ts`) refuses a `text` anchor on a canvas (`kindForArtifactRow` + `canvasAnchorResolver.kinds`);
  a Document still accepts what it accepted (existing tests use node anchors on Documents, unchanged).
- `canvas/_lib/comments.ts` (new, pure): `anchorPoint`/`pinAt` (top-right corner of the block as measured, else stored, through its frame; the point
  itself; `null` for an orphan or an unreadable anchor), `isOrphaned` (the resolver's answer, never a local does-it-exist check), `pinLabel` (list
  position, a resolved thread keeps its number, unknown id prints `?`), `threadCounts`, `nodeAt` (the block a click landed on; a frame is never the
  answer: its inside is board), `nodeWords` (the block's own words for the quote line).
- `CommentPins.svelte` + `CommentCatcher.svelte` (the brief's `CommentLayer.svelte`, split, see Deviations): 22 px numbered pins in board space,
  counter-scaled by the zoom so a pin is 22 px on screen at any zoom (the phone's fit zoom is 36-56 %), inline `z-index: 2` on a zero-size root, only
  the pin takes the pointer, a `::after` hit area of 44 px (measured in the e2e), `nopan`; a draft pin (dashed, the next number) for a comment placed
  and not yet written; a jump (`goto`) centres the camera and rings the pin (reduced motion: static ring). The catcher is a full-pane button
  **outside** the portal (there `inset: 0` is the pane), z-index 4 (under the library's panels at 5, so the zoom and the overview stay usable while
  armed), a click on a block comments on it, a click on empty board or inside a frame on a spot, a block that is selected when the tool is armed takes the
  comment at once (also the keyboard's way in; a key press on the catcher places a spot at the pane's centre), Escape lets go of the tool, the tool
  returns to Select after one click.
- Toolbar: a **Comment** tool (`MessageSquarePlus`, `aria-pressed`, `data-testid="canvas-tool-comment"`) between Draw and Undo; `Tool` gains
  `"comment"`. `CanvasBoard` gained a `layers` snippet (rendered inside the flow with `BoardLayerApi`: blocks as drawn, camera, tool, `setTool`,
  `toBoard`, `centerOn`, `announce`), `ontool`, and the exported `land(body)`.

### Step 2 · the list, the header toggle, the phone sheet

- The list is the Document's own parts. **Extracted and now shared** (MarginPanel and CommentsSheet use them; their DOM, class names, test ids and
  tests are unchanged): `CommentsSurface.svelte` (the phone `DialogShell` sheet and the drawer, lifted whole out of `CommentsSheet`),
  `CommentListHeader.svelte` (title, open count, the quiet "N resolved" / "Show open only" toggle, the drawer's close), `CommentFoldedGroup.svelte`
  (the fold for threads whose anchor is gone), `comment-list.css` (the card look; `MarginPanel` keeps its own `margin-panel-item` class beside it).
  New and shared: `CommentComposer.svelte` (the box a new thread is written in: "Post" turns into "Ask Alfy" with a hint the moment the words
  mention Alfy, Ctrl/Cmd+Enter, Escape, failure keeps the words). `CommentThread` gained optional `badge` (the pin's number), `alfyBusy`
  (typing dots while Alfy answers), `quoteLabel`, `replyPlaceholder`, `askAlfyHint`, `kind`; `CommentCard` gained `kind` and reads the new
  skipped-ops marker (Step 3).
- `CanvasComments.svelte` (lazy) composes them for a board: Open threads by default and the quiet toggle (ruling 61), resolved threads fold to one
  line, a thread whose block is gone is dimmed, in the fold "N comments on a block that was removed", and says "The block is gone."; the quote line
  names the block by its own words ("Museum, 14:00") or "a spot on the board", each card wears its pin's number; shown as a column beside the board
  (the Document's own `commentRailWidth` rule), a drawer over it when the panel is narrow, the phone sheet on a phone; the header's Comments button
  toggles it (`registerPanelActions.toggleComments`) and reports the open count and pressed state (`onCommentCountChange`, `onCommentsShownChange`).
  It starts **closed** on a board (a board's room is the board's); a pin press, the tool, a placed comment or the header's button opens it.
- Two-way linking: a pin press selects its thread (the list opens, brings the card into view and focuses it; on a phone it is the sheet); a card's
  quote line or a click on the card centres the camera on its pin and rings it (a drawer or sheet closes first: the board is what they came for);
  hovering a card turns its pin on.
- One state, one controller (`_lib/comments-controller.svelte.ts`): the pins and the list are two places that show one thing. The editor makes it
  only when comments are first needed (the board has threads, or the reader presses Comment / picks the tool), through **one lazy entry**
  (`comment-parts.ts`), so nothing of this loads for a board nobody comments on.

### Step 3 · `@Alfy` in a canvas comment

- `runAlfyCommentReply` dispatches on the artifact's kind: a canvas goes to `services/artifacts/canvas-comments.ts` (`runCanvasAlfyReply`), every
  other kind falls through to the Document's path unchanged. The thread's context (`AlfyThreadContext` in `types.ts`, built by `loadAlfyThread` in
  `comments.ts`) keeps the branch from opening the comment table; `AlfyCommentOutcome`/`AlfyCommentReplyResult` moved to `types.ts` and are
  re-exported (no cycle, same public names).
- The model gets the board **as `read_artifact` gives it** (`canvasReadBlocks`, bounded at 40,000 characters with "N more blocks are not shown"), the
  whole thread and the anchor (a block's own read entry, or "a spot ... not on any block"), the tool's own edit rule
  (`editArtifactRuleClause`), its ops description (`editArtifactOpsFieldDescription`), its worked example (`EDIT_ARTIFACT_CANVAS_EXAMPLE.ops`) and
  block hint (`BLOCK_SHAPES_HINT`), and answers `{ note, ops? }` where `ops` is **`boardOpsArraySchema` itself** (ruling 62: one object, never a
  twin; a test compares the advertised JSON schema with the tool's). The ops go through the facade's envelope (`applyArtifactOps`, one version,
  author `alfy`, summary "Alfy's comment reply", the ruling-63 review marker bootstrapped like a tool edit's), the reply is written under the
  thread's root, and a skipped op is named in it.
- **One correction round** (not in the spec): this hook has no tool loop, so an unreadable answer or one whose every op was refused gets the
  tool's own refusal text (`canvasEditFailureMessage`, `canvasEditOutcome`, `canvasOpsRequiredMessage`, each refusal's `detail`) once, in the next
  call; after that the reply is the "left it as it is" marker. A partly applied answer is never retried (it landed).
- A comment on a block that is gone is refused before any model call; abort and deadline as the Document's: the signal is checked before each call
  and before each write, and a call that was made is paid for (`recordControlModelUsage`, feature `artifact_comment_alfy`, once per call).
- Naming a skipped op: a new fixed marker beside the two Document ones (`withSkippedOps` / `splitSkippedOps` in `alfy-reply.ts`), written after
  Alfy's own note and read back by `CommentCard`, which renders "Part of this could not be applied safely." and one localized line per op
  ("Museum, 14:00: nothing is at that position any more"), never the raw marker; only Alfy's messages are read for it.
- The client: the controller saves the reader's board first (`beforeAsk` = flush the board and wait for the autosave), asks, reads the artifact again,
  and hands the read to the editor (`onserver` = `adoptServerBoard`), which draws a board Alfy changed with `CanvasBoard.land(body)` and adopts its
  version and hash; the reader's own undo is emptied by `land` (it could only take them back to before Alfy's change and save that over it).

## Tests added

Unit (156 new, all passing; ~14,980 in the full suite): `shared/artifacts/comments.test.ts` 8 (the three outcomes, `reason`, purity, `mentionsAlfy`),
`shared/artifact-document/alfy-reply.test.ts` 7 (the skipped-ops marker round trip), `services/artifacts/canvas-comments.test.ts` 33 (intake:
node/point kept, text refused on a board, replies, a Document still takes both, another user's board; the hook: applied as one Alfy version, on a
reply, on a spot, refused before any model call for a block that is gone, partial with the refusal named, question / empty ops / highlight only = no
version, one correction from the tool's own refusal text with the valid ops named, give-up after one, model unreachable, what the model is told
(board blocks, thread, the tool's edit rule and example), the advertised schema equals the tool's, bounded board, scope, abort before/during the call
with the cost still recorded, cost per call, following a replaced block), `_lib/comments.test.ts` 20, `_lib/comments-controller.test.ts` 21 (state, the
order save-before-ask, failure keeps the comment, the wiring functions), `_lib/server-board.test.ts` 5, `CommentPins.test.ts` 12,
`CommentCatcher.test.ts` 10, `CanvasComments.test.ts` 26, `CommentComposer.test.ts` 10, `CommentCard.test.ts` +8, `CanvasToolbar.test.ts` +2 (and one
updated assertion, the toolbar's tab order, which the new tool legitimately changes). Mutation-checked: three deliberate breaks in the layer (the zoom scale, the resolved filter, the block hit test) each failed a test.
e2e `tests/e2e/artifact-canvas-comments.spec.ts`, 18 cases (plus one changed assertion in `artifact-canvas.spec.ts`, the toolbar's names and tab order, which the new tool legitimately changes): the tool on a block / a spot / a selected block, Escape and the catcher's coverage of the pane
(the four inner corners and a block: a probe answers the catcher, the zoom stays above it), a pin above a frame's child, pin press and "show on the
board" (camera centred, pin rung), the fold for a removed block, deleting a block orphans its thread at once, resolve keeps the number, the drawer and
Escape, a phone sheet (44 px hit area, sheet box focused), a drawer's box focused, `@Alfy` (the reader's slow save lands before the ask; Alfy's change
is drawn without a reload; the reply is in the thread; undo is emptied; the next save is not refused), a step taken while Alfy answers is reported
as a conflict, Alfy unreachable, keyboard order (toolbar, blocks, pins), reduced motion, Hungarian.

## Gates (final tree)

| Gate | Result |
|---|---|
| `npm run check` | 0 errors, 17 warnings (the 17 pre-existing: `ToolActivityRow` 10, `ThinkingBlock` 6, `RouteItinerary` 1) |
| `npx biome check src scripts tests` | clean (2,309 files) |
| `npm test` | 952 files passed, 1 skipped; **14,978 tests passed**, 2 skipped (139 s) |
| `npm run build` | passes; 32 `Unused CSS selector` + 2 `must have an ARIA role` lines = the baseline, nothing new; chunk numbers below |
| Playwright (port 5460), `artifact*.spec.ts artifacts-*.spec.ts knowledge chat conversation`: 260 tests in 22 files | 259 passed in 16.8 min; the one failure was `artifact-canvas.spec.ts` "names every control ... keyboard reaches the toolbar before the blocks" (its tab order says Select, Pan, Draw, Insert; the Comment tool is now between Draw and Insert). I updated that assertion and reran the whole spec: 27/27 pass. No other failure, no flake in the combined run |
| Fallow (`--no-cache --score`) | 124 issues (baseline 124), **4 circular** (unchanged); zero new. Three things it flagged on the way and I fixed: exports reached through a lazy import's namespace, a type used only by its own file, class methods reached through a state variable |
| `npm run check:migrations` | passes unchanged (no migration; none needed) |

**The editor's chunk, before and after** (`npm run check:artifact-chunks`; sizes in the guard's own kB = KiB):

| | raw | gzip | own chunks / shared |
|---|---|---|---|
| Before (`519095e5`, S3-F's tree) | 224.7 kB (230,081 B) | **67.0 kB** (68,629 B) | 1 / 29 |
| After, the guard's default reading | 220.8 kB (226,129 B) | 65.9 kB (67,529 B) | 1 / 31 |
| After, like-for-like (`--allow-entry comment-parts`) | 229.4 kB | **69.1 kB** | 2 / 30 |
| The lazy comment code (loaded only for a board with threads, or on Comment) | 34.9 kB (35,714 B) | 12.0 kB (12,300 B) | 2 chunks |

Read this carefully: **the default figure fell to 65.9 kB only because the guard counts a chunk that the lazy comment code also imports as "not the
editor's"** (two small modules moved into shared chunks). What the editor really loads when it opens went from 67.0 to **69.1 kB gzip (+2.1 kB, +4.7 kB
raw)**: the toolbar's Comment button and its icon, the editor's toggle / count / adopt-a-changed-board glue, `land`, `centerOn` and the layers snippet in the board,
and the wrapper CSS. I could not make it zero (a toolbar button and a header toggle are static by nature); the comment layer, the list, the controller and
all `@Alfy` client code are lazy, and importing `ViewportPortal` from the lazy code briefly moved ~28 kB gzip of the library into a second chunk (the guard's exclusive number fell while the bytes loaded did not) (fixed: the editor wraps the pins
in the portal it already has). I added `--allow-entry comment-parts` to the `check:artifact-chunks` script in `package.json` so the guard's number stays like-for-like; `--max-gzip 65000` is
still not enforced (the editor is over the spec's 65 kB before and after).

## The live check

Recipe of `common.md`: `ssh -N -L 30040:192.168.1.96:30000 alfyroot` in the same command as its user (killed by pattern afterwards; no tunnel left), model `qwen3-6-27b`
(`MODEL_1_BASEURL=http://127.0.0.1:30040/v1 MODEL_1_NAME=qwen3-6-27b`, no key), through a temporary vitest file (in-memory database, the real
`runAlfyCommentReply` and the real `sendJsonControlMessage`; deleted, never committed). Board: `sampleBoard()`; thread on the `note-museum` sticky ("Museum, 14:00"),
comment "@Alfy make this a checklist of three items". Three invocations, each bounded:

1. **Failed before the model answered, and it was a real bug**: the request came back `400 Grammar error: Unimplemented keys: ["propertyNames"]`. vLLM compiles a `response_format: json_schema` into a grammar and
   refuses a keyword zod writes for a record (`update_node.data`), so with the edit tool's ops schema *every* canvas `@Alfy` comment would have answered "left the board as it is". The model-facing schema is now the validator's
   own less `$schema` and `propertyNames: {type: "string"}` (which only restate that keys are strings); a test proves that is the only difference from the tool's schema.
2. Same run with the error captured (the first swallowed it, as the Document's path does).
3. After the fix, **4.96 s, two model calls (3.3 s and 1.6 s), outcome `applied`, 2 ops, version 2 (author `alfy`, "Alfy's comment reply")**, reply "Converted the museum sticky into a checklist with three items."
   The first answer was the natural wrong guess, `update_node` with `data.kind: "checklist"`; the vocabulary refused it (`kind_mismatch`: "a block cannot change kind in place. Remove it and add the new one."), that text went back to the model as the
   correction, and the second answer was `remove_node` + `add_node` (a checklist with three items at the same position). This is what the correction round is for.

It also showed a consequence I then fixed: removing the block orphaned the thread that asked for the change, so a thread now follows the one block that replaces the block it was on
(remove + exactly one add; more than one is a guess, a spot has no block).

## Screenshots (`.../scratchpad/w3/shots/s3c/`, Hungarian, not committed; I looked at each one)

- `desktop-light-hu-pins-and-list.png`, `desktop-dark-hu-pins-and-list.png` (1440x900): pins 1-3 on the museum note's corner, the lunch note (inside a frame,
  above the frame's children) and a spot; the list open with the museum thread selected (its pin ringed), Alfy's reply with the skipped op named, the
  fold "1 megjegyzés egy törölt blokkon", the header count 4 and the quiet "1 lezárva" toggle.
- `desktop-light-hu-composer.png`: a comment placed on the tram note: the draft pin (dashed, the next number 6), the composer under "Új megjegyzés ehhez: Villamos 4-es, 9:30", "Alfy megkérdezése" once the words mention Alfy.
- `desktop-light-hu-orphan-and-reply.png`: the removed block's thread expanded in the fold, dimmed, "A blokk már nincs meg."
- `desktop-light-hu-alfy-checklist-reply.png`: what the live check produced, seeded: the note now a checklist, the thread on it with the pin, Alfy's reply.
- `drawer-light-hu.png` (1100x800): the list as a drawer over the board. `phone-light-hu-tool-armed.png`, `phone-light-hu-sheet-at-thread.png` (390x844): the tool armed
  (pins at the fit zoom, 22 px), and the sheet at a pressed pin's thread.
- Defects the screenshots showed, all fixed and re-shot: the pin/badge numbers were white on the dark theme's lighter accent (2.9:1) -> `--on-accent`
  (ink on accent, as the checkbox tick is); a comment column narrowed the board until the toolbar and the zoom touched -> the zoom goes above the
  toolbar below 680 px; the armed tool's hint was a four-line oval -> a small rounded box, fewer words; the removed block's quote line was cut off -> "A blokk már nincs meg.".
  Not visible in a screenshot, found by assertions I added: the drawer's and the phone sheet's own focus handling took the focus from the comment box
  (the reader's first words went nowhere) -> the drawer's trap leaves a focus already inside it alone, and the box asks again once after 60 ms.
- Observed, not changed: opening the list narrows the board pane without moving the camera, so a block near the right edge can end up outside the pane
  (a pin can only be pressed while visible; "show on the board" centres it). A refit or a pan on open/close is one line in `CanvasBoard` if wanted.

## Deviations from the spec / brief, and why

1. **`CommentLayer.svelte` is two components** (`CommentPins`, `CommentCatcher`) and the editor renders the `<ViewportPortal target="front">` around the pins. A single component that imported `ViewportPortal` made the flow
   library a module shared by the editor and the lazy comments chunk, and the bundler moved it into a chunk of its own (~28 kB gzip outside the editor's exclusive number).
2. **Shared parts were extracted from the Document** (brief: only if its tests stay green unchanged, and they did: MarginPanel 56, CommentsSheet 12, CommentThread, DocumentBody, and `artifact-document-comments.spec.ts` 23/23 e2e): `CommentsSurface`, `CommentListHeader`,
   `CommentFoldedGroup`, `comment-list.css`. `MarginPanel` itself is not forked and not reused for a board (blocks, tabs, text anchors).
3. **The open thread card in screen space next to the pin** (T5 / the spec's pin section) is not built: the brief's two-way linking replaces it (a pin press selects the thread in the list; on a phone that is the sheet).
   `CommentCard.svelte` is the shared `components/artifacts/CommentCard.svelte` (ruling 45), not a canvas copy.
4. **`shared/artifacts/comments.ts` holds the resolver interface, the canvas resolver and `mentionsAlfy`**, not the spec's `CommentAnchor`/`CommentThread` types: the family already has `Anchor`, `AnchorResolution` and `ArtifactComment`. The resolver
   resolves against nodes (`{ id }[]`) rather than `body: string | null`; `reason: "node_missing"` rides an internal widened type because ruling 45's `AnchorResolution` has no `reason`.
5. **Pins of resolved threads are hidden unless the list shows All** (the Document's highlight fades on resolve); a resolved thread keeps its number, and the "All" pin is dashed and quiet.
6. **The list starts closed on a board** (the Document's column is open whenever there is room). A board's room is the board's; a pin press, the Comment tool, a placed comment or the header's button opens it. Not persisted per device.
7. **Comment tool placement**: between Draw and Undo (and so the toolbar's tab order gained a stop: one existing unit assertion and one e2e assertion updated, both for exactly that).
8. **Zoom stacking below 680 px** (`STACK_ZOOM_BELOW` in `CanvasBoard`): S3-F's compact placement (zoom above the toolbar) now also applies to a board narrowed by the comment column.
9. **`@Alfy`: a bounded correction round and a follow-the-replaced-block rule**, neither in the spec (both explained above); the note is clipped at 4,000 characters; at most 5 skipped ops are named; the model's `ops: []` is accepted (the schema it is shown is unchanged).
10. **A new fixed marker** beside the Document's two (`[[alfy:skipped:...]]`), so the reply names what was skipped in the reader's language while the note stays Alfy's words.
11. **i18n keys**: the spec's `artifacts.canvas.comment*` names are `artifacts.canvas.comment.*` here, and the list reuses the Document's `artifacts.document.margin.*` / `.comment.*` words (one comment feature, one vocabulary).
12. `package.json`: `--allow-entry comment-parts` on the chunk guard (above). No dependency was added.

## Open questions and concerns

1. **The editor's chunk grew by 2.1 kB gzip** (like-for-like) although everything big is lazy; see the table. If the owner wants it back at 67.0, the levers are the toolbar button's icon (an icon already in a shared chunk) and moving `adoptServerBoard` behind the lazy entry with a small state port.
2. **Should the column open by default on a wide panel, as the Document's does?** I chose closed (deviation 6). Also: opening the list narrows the board pane without moving the camera, so a block near the right edge can leave the pane; a pan or refit on open/close is one line in `CanvasBoard`.
3. **Tool description**: `edit_artifact`'s ops description (S3-T's) does not say that a block cannot change kind in place, so the model's first try at "make this a checklist" is always refused and corrected on the second call, in the tool path as much as here.
   One clause in `editArtifactOpsFieldDescription` ("a block cannot change kind in place: remove it and add the new one") would save a call on both paths. I did not touch S3-T's prose (a second wording is exactly what ruling 62 forbids; this is a change to the one wording).
4. **A step the reader takes while Alfy is answering** (up to a few seconds) is reported as a conflict, and Reload discards it (their save would be refused as stale). Alfy's own version is never lost. A rebase of the reader's step onto Alfy's board is possible but is a merge feature, not a comment feature.
5. **The `propertyNames` finding is not specific to comments**: any use of the ops schema (or Slides' patches) as a `response_format` for a local model needs the same lossless strip. `forTheModel` is private to `canvas-comments.ts`; if Slides' comment reply needs it, extract it.
6. **Cost**: a canvas `@Alfy` comment sends the ops schema (~1.7k tokens) plus the board; measured 5 s and two calls for a conversion.
7. Hungarian strings are mine (natural Hungarian; "Megjegyzés" for Comment); worth one native read, especially "A blokk már nincs meg." and "Alfy megkérdezése".
8. Not built (S3-A): a change chip / highlight / review for a comment-driven change; an "Alfy is arranging" frame. The reader gets the redrawn board, the reply, the thread's typing dots while it works, and a polite announcement.

## Expected merge friction

- `src/lib/i18n/artifacts.ts`: my two blocks sit before S3-F's "Frames and reparenting" comment in each language (not at the end, so an append by S4-V does not touch them).
- `package.json`: one line (`check:artifact-chunks`). `services/artifacts/comments.ts` and `types.ts`: S4-D's Slides branch of the comment hook would dispatch beside `canvas` in `runAlfyCommentReply`.
- `CanvasToolbar.svelte` / `CanvasBoard.svelte` / `CanvasEditor.svelte`: S3-A adds `alfyActivity` and a review bar to the editor and the board; my additions are in separate hunks (the layers snippet, `ontool`, `land`, `centerOn`, the row wrapper).

## Hand-off

### For S3-A (the tween, the highlight, the review bar, Alfy's edits from the chat)

- **Where an Alfy change lands**: `CanvasEditor.adoptServerBoard(detail)` (called by the comment controller after every read of the artifact) decides with `judgeServerBoard` (`_lib/server-board.ts`: `unchanged | ours | conflict | land`)
  and on `land` calls `CanvasBoard.land(body)`. `land` replaces nodes / connections / marks at once, keeps the camera, sets `committedJson` (so it is not a step of the reader's) and **empties the reader's undo** (a stale snapshot would save the pre-Alfy board over Alfy's).
  That is the clean hook: extend `land` with the tween (`moveOps` / `structuralOps`), the highlight (`CanvasNode.highlight`) and the arranging frame. The previous nodes are still `boardNodes` in the editor at the moment `land` is called, if you need a before/after to find what was touched.
- **The "Alfy is working" state of a comment-driven change**: `CanvasCommentsController.asking` (the thread's root id) is set from just before `beforeAsk` until after the refresh; `CommentThread` already shows typing dots for it (`alfyBusy`).
- **The reply's change chip**: `CommentThread` takes `changeStateByCommentId` and `onSeeChange` (and `CommentCard` `changeState`); `CanvasComments.svelte` does not pass them yet. The version a comment reply writes has the summary "Alfy's comment reply" and goes through `applyArtifactOps`, which bootstraps the ruling-63 review marker, so
  the review read side sees a comment-driven change exactly like a tool edit's.
- Version bookkeeping after your Undo / Keep: use `judgeServerBoard`'s facts (`versionNumber`, `knownBodyHash`, `latestJson`, `savedJson` in the editor).
- The comment layer exposes `BoardLayerApi` (`_lib/board-layers.ts`: blocks as drawn, camera, tool, `setTool`, `toBoard`, `centerOn`, `announce`); a review bar's prev/next can use `centerOn`.

### For S3-R, S3-X, S3-Z

- Pins and the catcher need nothing from a new block kind: a pin sits on `nodeRect(node, all, node.measured)`. `nodeWords` (`_lib/comments.ts`) names a block for the quote line and already has cases for map (`route`), file (`name`), app (`title`), liveweb (`query`) and photo (none); it is unit-tested for sticky, text, frame and checklist only, so check those field names against the shipped data.
- An export that rasterises the viewport should leave out the pins (`.comment-pins`, inside `.svelte-flow__viewport-front`) and the catcher (`.catcher`, `[data-testid="canvas-comment-catcher"]`).
- The Comment tool disables itself with the rest of the toolbar when the board is read-only; existing pins stay pressable.

### Modules, exports, props (all under `src/lib/components/artifacts/` unless noted)

- `shared/artifacts/comments.ts` (`src/lib/shared/artifacts/`): `AnchorResolver<Context>`, `canvasAnchorResolver` (`kinds`, `resolve(anchor, nodes)`), `mentionsAlfy`.
- `canvas/_lib/comments.ts`: `anchorPoint(anchor, nodes)`, `pinAt(thread, nodes)`, `isOrphaned`, `pinLabel`, `threadCounts`, `nodeAt(point, nodes)`, `nodeWords(node)`.
- `canvas/_lib/comments-controller.svelte.ts`: `CanvasCommentsController({ artifactId, conversationId, threads, beforeAsk, onserver })` with state `threads nodes open draft selectedId hoverId focus goto filter orphanedOpen asking status notice`, getters `openCount activeId`,
  methods `show hide setNodes hover select goToThread place cancelDraft refresh post reply resolve`; functions `toggleComments(controller)`, `pinsProps(controller, api)`, `catcherProps(controller, api)`.
- `canvas/comment-parts.ts`: the one lazy entry (controller + the three functions + `CanvasComments`, `CommentCatcher`, `CommentPins`).
- `canvas/CommentPins.svelte` props: `threads nodes viewport activeId? draft? showResolved? goto? oncenter onselect`; `canvas/CommentCatcher.svelte`: `nodes tool toBoard ondraft ontoolchange onannounce`;
  `canvas/CanvasComments.svelte`: `controller panelWidth currentUser?`. Test ids: `canvas-tool-comment`, `canvas-comment-pins`, `canvas-comment-pin` (+ `data-thread-id`, `aria-current`), `canvas-comment-draft-pin`, `canvas-comment-catcher`, `canvas-comments-rail`, `canvas-comments-list`, `canvas-comment` (+ `data-comment-id`), `comment-composer`, `comments-drawer`, `margin-orphaned-group`.
- Shared: `CommentsSurface` (`presentation title onClose bottomInset? children`), `CommentListHeader` (`openCount resolvedCount filter ontogglefilter onClose?`), `CommentFoldedGroup` (`label open ontoggle children`), `CommentComposer` (`header placeholder alfyHint onsubmit oncancel`), `CommentThread` (+ `badge alfyBusy quoteLabel replyPlaceholder askAlfyHint kind`), `CommentCard` (+ `kind`, the skipped-ops lines).
- `CanvasBoard` props `layers ontool`, method `land(body)`; `CanvasEditor` props `onCommentCountChange onCommentsShownChange`.
- Server: `services/artifacts/canvas-comments.ts` `runCanvasAlfyReply` (facade name unchanged: `runAlfyCommentReply`), `types.ts` `AlfyThreadContext`, `AlfyCommentOutcome`, `AlfyCommentReplyResult`; `shared/artifact-document/alfy-reply.ts` `withSkippedOps`, `splitSkippedOps`, `AlfySkippedOp`.

### A paragraph for `AGENTS.md`'s Artifacts section (I did not touch it)

> **Canvas comments (Wave 3).** One comment feature on the artifacts backbone: threads are `artifact_comments` rows, never part of a board body (ruling 1). A board places `node` and `point` anchors only (`canvasAnchorResolver`, `src/lib/shared/artifacts/comments.ts`;
> intake refuses a Document's `text` anchor) and a thread whose block is gone is an orphan by the resolver's answer, never by a local existence check. The board's comment UI is ONE lazy entry, `canvas/comment-parts.ts` (the pins `CommentPins`, inside the editor's own
> `<ViewportPortal target="front">`; the tool's `CommentCatcher`, outside it; the list `CanvasComments`; the state they share, `_lib/comments-controller.svelte.ts`). The editor may not import any of it statically, and it may not import `@xyflow/svelte` (it would pull the library into a second chunk);
> `npm run check:artifact-chunks` passes `--allow-entry comment-parts`. The list is the Document's parts (`CommentThread`, `CommentCard`, `CommentListHeader`, `CommentFoldedGroup`, `comment-list.css`, `CommentsSurface`, `CommentComposer`); `MarginPanel` stays the Document's own.
> `@Alfy` on a board is `services/artifacts/canvas-comments.ts`, dispatched from `runAlfyCommentReply` by kind: the model answers `{ note, ops? }` in `boardOpsArraySchema` itself with the tool's own edit rule, example and refusal texts (ruling 62) and gets one correction; the ops land through `applyArtifactOps` (one version, author `alfy`);
> the editor saves the reader's board first, reads the artifact again and draws what Alfy changed with `CanvasBoard.land` (`judgeServerBoard` decides).

## Commits (`519095e5..HEAD`, oldest first)

- `a03e5815` Give a board its own anchor resolver, and refuse a Document's anchor on it
- `26f78219` Say where a comment's pin sits and which block a click landed on, as pure functions
- `d277eff6` Pin comments to the board, with a tool to place them and one state for the pins and the list
- `d13ea0b2` Show a board's comments in the Document's own list, column, drawer and sheet
- `66ed31a9` Let a comment on a board ask Alfy to change it, in the edit tool's own terms
- `5f651a26` Keep the flow library out of the lazy comments chunk
- `344d7076` Give Fallow no new findings, and keep the chunk guard's number like-for-like
- `0adff201` Fix what the screenshots showed: pin ink in the dark theme, a zoom that met the toolbar, a hint that was an oval
- `7755d014` Do not take the reader's own save for a conflict
- `1a5c4646` Keep the reader in the box they placed a comment to write
- `9063e4a2` Keep a comment on the block Alfy replaced
- `8944bfe1` Name the pins by what they are now in two comments
- `207e3a98` Say where the Comment tool sits in the toolbar's names and tab order
