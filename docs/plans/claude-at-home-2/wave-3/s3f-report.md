# S3-F report · frames, reparenting, connectors and the drawing layer (Slice 3 T3 + T4)

Model: `claude-sonnet-5-5`. Worktree `.claude/worktrees/art-s3f`, branch `feat/artifacts-s3-frames`, e2e port 5440.
Commits `ef1d9b0e..HEAD` (see the table); no migration, nothing in `services/artifacts/`, nothing in S4-V's files.

| SHA | What |
|---|---|
| `ef1d9b0e` | drops `@xyflow/system` and `html-to-image` (package.json + lockfile alone) |
| `0c38055e` | the default node size declared once (`canvas-blocks.ts`), read by the board's geometry and the model |
| `f9fc98c0` | the canvas e2e helpers shared between the specs |
| `0bc2f3fb` | frames adopt what is dropped in them; a deleted frame keeps its notes; edges take the facing sides; `ids.ts` |
| `89079966` | the board's zoom buttons zoom (a defect in S3-B's board) |
| `8195f58f` | `pane-rect.ts` and `annotations.ts` with their tests; `canvas-body` exports the two rules the live pen shares with the save |
| `b35c58fa` | the drawing layer, the toolbar's Draw and tray, the board wiring, EN+HU strings, component tests, the drawing spec |
| `b31eb995` | `aria-controls` only while the tray exists |
| `f9a7833e` | the nested-frame cases |

## What I built, per step

### Step 0 · dependencies, and the one footprint

- `@xyflow/system` and `html-to-image` removed from `package.json` (lockfile regenerated with npm, committed alone: `ef1d9b0e`). `@xyflow/svelte` 1.7.0 depends on exactly `@xyflow/system` 0.0.83, so the pin holds through it; `html-to-image` comes back with the PNG export that imports it (`npm i --save-exact html-to-image@1.11.11`). `perfect-freehand` is imported now (the pen), which clears the third: Fallow is back at the baseline (see the gates).
- `NODE_WIDTH` (190) / `DEFAULT_NODE_HEIGHT` (84) are declared once, in `src/lib/shared/artifacts/canvas-blocks.ts`. `_lib/board.ts` imports them (`nodeRect`'s fallback) and `canvas-model.ts` imports them and re-exports them as `BOARD_NODE_WIDTH` / `BOARD_DEFAULT_NODE_HEIGHT`, because `scripts/eval-artifact-contracts/suites/canvas.ts` (S4-V's territory) imports those two names: a rename would have broken the eval. A test in `board.test.ts` pins the pair: `nodeRect` of a node with no stored size equals what `canvasReadBlocks` tells the model.

### Step 1 · frames, reparenting, connectors (T3)

| Where | What |
|---|---|
| `_lib/board.ts` (new, pure) | `absoluteOf`, `nodeRect(node, all, measured?)`, `frameAt(point, all, exceptId?)`, `reparentOnDrop(node, all, measured?)` → `{ parentId, position, extent: undefined } \| null`, `rehomeOnRemoval`, `parentsFirst`, `facingHandles`, `withoutDanglingEdges`. |
| `CanvasBoard.svelte` | `onnodedragstop` (**lowercase**; a comment says what the camelCase spelling does: nothing, silently) applies `reparentOnDrop` to every dragged block (a marquee group joins together) and re-orders parents first; `onnodedrag` names the frame that would take the block (`dropTargetId` through the board context → `NodeShell`'s `dropTarget` → the frame lights up: solid accent border and tint, instant under reduced motion); `onbeforedelete` + `ondelete`; the announcement line says "Moved into the frame X." / "Kikerült a keretből: X." |
| `board-model.ts` | `toFlowEdges` (each stored edge takes the sides that face its ends), `bodyOfState` never saves an edge whose end is not on the board. |
| `_lib/ids.ts` | `newId(prefix)` (`${prefix}-${base36 time}-${counter}`), used for edges, new blocks and marks. |

Decisions (each is in the code's comments):

- **The drop point is the block's centre** (`nodeRect` from what the panel measured, else what the node stores, else the shared 190x84). A note half over the edge either way is decided by its centre (a test each way). A nudge inside its frame returns `null`: nothing is rewritten. `parentId` is always a named key in a patch (`undefined` = release), because `{ ...node, ...patch }` keeps the old parent if the key is absent; `extent: undefined` clears a stale extent.
- **Nested frames** (the protocol allows them; a reader never makes one). A nested frame is drawn by the library inside its parent and moves with it, its chip is its drag handle like any frame's. The UI never adopts a frame (`structural`), but dragging a nested frame out of its parent **releases** it to the board (a test); `frameAt` is innermost first by depth, then smallest area, then drawn later, and never answers with the block being dragged or anything inside it. `frameRect` is folded into `nodeRect(node, all)`: it has to be absolute for a nested frame, so a separate top-level-only function would have been wrong.
- **A deleted frame no longer takes the notes inside it** (the spec is silent; the ops protocol's `remove_node` re-homes children for the same reason, S3-P deviation 3). `onbeforedelete` takes the children nobody selected out of the library's cascade and `rehomeOnRemoval` moves them up to the nearest frame that survives (or the board) at the same place on screen, with their connections. A child that is itself selected goes with the frame.
- **A stored edge carries no handle ids**, so it ran bottom-to-top after every reload whichever side it was drawn from (S3-B's open note). I did not build a floating edge type: each stored edge takes the sides that face its ends when the board opens or restores (`facingHandles`), which the board's loose connection mode resolves on any of the four anchors. An edge drawn sideways is drawn sideways after a reload (a test measures the path against the two blocks).
- **One drag, one edge, one id**: `onbeforeconnect` stamps `newId("e")`; `onconnect` is not used (mutation-checked in S3-B's spec and left as it was). A drop connects to the side it lands near (the library's 20 px connection radius), not to the middle of a block: that is S3-B's behaviour and I left it.
- **Every structural gesture is one save** through the editor's `createDocumentAutosave` + `saveArtifactBody` with `expectVersion`, as S3-B built it: a reparent is exactly one new version (the spec seeds an Alfy version, the reader's first save is v2). I send no summary text: rulings and `version-summaries.ts` say a body save names a `summaryKind`, never text, so the spec's "Moved a note into Friday" is not sent.
- **A stale save shows the shared conflict line and saves nothing.** The brief says "undoes the gesture". S3-B's shipped, tested conflict behaviour keeps the reader's unsaved steps on screen and makes the board read-only until Reload (its spec asserts a ticked box stays ticked), and slice-3 T3 step 3 says "keeps the in-memory board ... never silently re-saves on top". I kept that: the gesture is not persisted (the spec checks the stored board and the version count), the line shows, the board takes no further steps, and Reload shows the server's board (the note is out of the frame). If the owner wants the on-screen gesture reverted too, it is one `undo()` on the `version_conflict` branch in `CanvasEditor.handleSaveResult`.

### Step 2 · the drawing layer (T4)

| Where | What |
|---|---|
| `_lib/pane-rect.ts` | `visibleBoardRect(pane, viewport, margin)`: the board rectangle the pane shows; all-zero before the pane is measured. |
| `_lib/annotations.ts` | The prototype's module rebuilt from the spec (the prototype branch does not exist): `Tool`, `DRAWING_TOOLS`, `isDrawingTool`, `INKS`/`DEFAULT_INK`, `baseSize`, `strokePath` (perfect-freehand, velocity pressure, `streamline: 0.5`, `last: true`; capsule/dab fallback), `dabPath`, `arrowHead`, `normRect`, `textWidth`, `annotationBounds`, `hitTest` (rect and ellipse on their stroke, not their fill), `pickAnnotation` (newest wins), `translate`. Not carried over: `normalizeAnnotations` (S3-P's `normalizeCanvasBody` already caps and thins; I export its `decimateStroke` and `ANNOTATION_TEXT_MAX_CHARS` and use `MAX_ANNOTATIONS_PER_BOARD` / `MAX_POINTS_PER_STROKE`), `describeAnnotation` (the layer says how many marks it holds instead). |
| `AnnotationLayer.svelte` | Mounted by the board inside `<ViewportPortal target="front">`. A zero-size root at the board's origin (`z-index: 2` inline), an SVG of the marks in board units, and the pad: `role="application"`, one tab stop, sized from `visibleBoardRect(paneSize, viewport, 24 px)`, `pointer-events: auto` only while a tool that draws (or the eraser) is active, all of it inline on the element that owns it. Pen, highlighter (`size` 14, 35 % opacity), line, arrow, rectangle, ellipse, text, eraser; a click is a dot with the pen and nothing with a shape; a second finger drops the stroke; strokes are rounded to 0.1 and thinned by distance past 1,200 points; at the 600-mark cap the stroke is refused and a visible notice says so. In Select a mark is picked by its own hit shape (at least 16 px wide at any zoom), moved by a drag, nudged by the arrows (1, 10 with Shift), edited (Enter or a double-click on text) and deleted from the keyboard; Escape is taken by the layer first (a stroke in progress, then the tool, then the selection; only then does it reach the panel). |
| `CanvasToolbar.svelte` | **Draw** opens a tray above the bar with the seven marks, the eraser and the four inks; it wraps to a phone's width with 44 px targets. The tray sits in the DOM between Draw and Undo, so the tab order is Select, Pan, Draw, tools, inks, Undo, Redo, Insert. Undo/Redo are named **"Undo your last step" / "Saját lépés visszavonása"** (ruling 16: they undo the reader's own steps; Alfy's change and an earlier session's are a version restore through History, named differently). |
| `CanvasBoard.svelte` | `tool: Tool`, `ink`, `setTool` (a tool that draws starts from a board with nothing picked: blocks are deselected), `panOnDrag` derived (a drawing tool owns the pointer; on touch it disables the library's pan so a finger draws), the layer's `onchange` seals a gesture as ONE step (`commit()` before and after), the phone's zoom chip hides while the tray covers it. |

Decisions:

- **One history, not a drawing-only one.** The brief and slice-3 say the toolbar's undo is "a bounded history of gestures, never node/edge/comment changes". Ruling 16 (which wins) says the canvas's in-session undo "reverses your own recent steps and strokes", and S3-B's brief (and merged code) built one 50-step history of the reader's steps for the toolbar to which "S3-F adds the drawing tools". I kept that one history: a stroke, a move and an erase are each one step in it, next to a dragged block or a typed note, sealed with `commit()` so a burst of strokes inside the 350 ms settle still undoes one at a time (a spec). Comments are not in it because they are not in a body (ruling 1). The spec's "never puts node, edge or comment changes into the annotation history" therefore has no separate history to apply to; what is asserted instead is that a gesture on marks leaves nodes and edges exactly as they were. **If the owner wants the drawing-only history, it is a second `createBoardHistory` fed by `handleAnnotations` and a different Ctrl+Z target: say so and I will not have to change the layer.**
- **Marks store a colour token**, `var(--ink-blue)`, not a hex: the four inks differ per theme (S3-B's tokens, contrast-tested), so a mark is drawn in the ink of whichever theme is showing. `readAnnotation` accepts any string up to 64 characters, so a hex from another writer still draws as itself. **For S3-X: the export probe's blue is theme-dependent** (`#2f6fd0` light, `#6ea1f0` dark); the spec's "same value on both themes" does not hold for S3-B's tokens.
- **The tray, not 17 buttons in the bar.** The spec's toolbar row (Select, Pan, seven tools, inks, Undo, Redo, Insert, Ask Alfy) does not fit a phone, and barely a side panel. Draw opens a second bar above the first; the keyboard meets its buttons in the spec's order.
- **The layer is a tab stop only when there is something for the keyboard to do** (a drawing tool on, or marks on the board), and it comes AFTER the blocks in the tab order, because it lives in the viewport's front layer, which the library draws after the nodes (the spec's numbered list puts it before the toolbar; S3-B moved the toolbar first in the DOM and asserted "toolbar before blocks", which I kept).
- **Touch.** While a tool that draws is active, `panOnDrag` is off, and the library's own filter then refuses every `touchstart` (`!panOnDrag && touchstart`), which includes a second finger: pinch is off while drawing on a touch device (Select and Pan keep it). A second finger drops the stroke in progress. The spec's pinch cases: **a pinch on empty board zooms** (a test), **a pinch that starts on a block zooms the board like any other pinch and does not drag the block** (a test; the spec says "no zoom", but Svelte Flow 1.7.0's d3-zoom reads every touch of the event, so a second finger makes it a pinch wherever the first landed; the block's stored position and the version count do not change).
- **Select and Pan.** "moves the camera when the Select tool marquee-drags" cannot be right as written (S3-B: a plain drag in Select is a marquee, the camera moves with the middle/right button or the Pan tool); the test asserts a Select drag marquee-selects and leaves the camera, and a Pan drag moves it.

## A defect in S3-B's board, found and fixed

**The zoom buttons did nothing.** `useSvelteFlow()` reads `zoomIn`/`zoomOut` off the store that exists when it is *called*; the board calls it above the `<SvelteFlow>` it renders, where that is the provider's placeholder (no pan/zoom instance), so both answered `false` (proved by logging the promise's result). Every other member of that object reads the live store, so wheel, pinch and Fit worked and nobody noticed. Fixed with `flow.setZoom(flow.getZoom() * 1.2)` and a spec that clicks the buttons and watches the camera (`89079966`). Worth remembering for S3-C/A: **never destructure `zoomIn`/`zoomOut` from a `useSvelteFlow()` called outside the flow's subtree.**

## Tests

- Vitest (new): `board.test.ts` 36 (the eight T3 cases plus corner-vs-centre, nested frames, re-homing, ordering, facing sides, dangling edges, the shared footprint pinned against the model's read), `board-model.test.ts` +3, `ids.test.ts` 3, `pane-rect.test.ts` 4, `annotations.test.ts` 26, `AnnotationLayer.test.ts` 27, `CanvasToolbar.test.ts` 11. Mutation-checked: the centre rule, the named `parentId` key, `pointer-events`, the pad's z-index, the second-finger rule, the pane-sized pad, Escape being consumed.
- Playwright (new): `artifact-canvas-frames.spec.ts` 16 (the T3 list: adoption with the drop highlight and exactly one new version, release, nudge, loose drop, frame to frame, a frame is never adopted, a stale drop, one drag = one edge and the reopened board draws it between the facing sides, a delete takes its edges and nothing else, a deleted frame keeps its notes and their edges, the marquee wrapper does not swallow a tick or a double-click, and five nested-frame cases); `artifact-canvas-draw.spec.ts` 22 (T4: pen in board coordinates, no pan, glued across a zoom, above a framed note, erase, place and edit text, Select marquee vs Pan, inks, one gesture = one step, reload, Escape, pick/nudge/delete, move, the 600-mark cap, **the pad-coverage gate at fit view, zoomed out and panned on a 150-block board (>= 95 % of the pane, and the pad's rectangle contains the pane)**, dots and clicks, the phone tray, the pinch cases, a finger drawing), plus a zoom-button case in S3-B's spec (27 there now) and its tab-order case updated for Draw. Mutation-checked: camelCase `onnodeDragStop` (the adoption tests fail), no `onbeforedelete`, plain edges, no z-index, pad not sized from the pane, coarse-pointer pan.
- `tests/e2e/artifact-canvas-helpers.ts` (new): seed, open, read what was saved, the camera, the version rows, drag helpers; S3-B's spec imports it now (its own copy removed), and it waits for the sliding panel to stop before anything is measured.

## Gates (final tree)

| Gate | Result |
|---|---|
| `npm run check` | 0 errors, 17 warnings (= baseline: ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1) |
| `npx biome check src scripts tests` | clean, 2283 files |
| `npm test` | 942 files passed (1 skipped), **14,816 tests passed** (2 skipped) (S3-B's tree: 14,513). The full run was on the tree before the last two commits (one attribute, and e2e cases); the artifact, shared and i18n subset was re-run on the final tree: 95 files, 2,170 tests, green |
| `npm run build` | passes on the final tree; 32 `Unused CSS selector` + 2 `must have an ARIA role` = baseline; `check:artifact-chunks` OK (`@xyflow` and `perfect-freehand` confined to the editor chunk; `html-to-image` not in the build). Editor chunk 224.7 kB raw / **67.0 kB gzip** (see Perf) |
| Playwright (5440), every artifact spec + chat + conversation + knowledge | **242 passed**, 0 failed (14.6 min; S3-B's tree: 203) |
| Fallow | **124 issues (= baseline), 4 circular (= baseline)**; no finding in a file I touched (the three unused dependencies S3-B left are gone: two removed, one now imported) |
| `npm run check:migrations` | passes unchanged |

## Screenshots (`.../scratchpad/w3/shots/s3f/`, Hungarian, not committed)

`1440-light-adopt.png` (a note held over Péntek: the frame is lit, the note's own toolbar above it, an edge with its label drawn between the facing sides), `1440-light-drawing-tray.png` (the tray open over the toolbar; a pen loop, a highlighter, a rectangle over a framed note, an arrow, a text mark; the note that was adopted is drawn inside Péntek), `1440-light-picked.png` (Select, one mark picked: dashed box), `1440-dark-adopt.png`, `1440-dark-drawing-tray.png` (the inks are the dark theme's), `390-light-adopt.png`, `390-light-drawing-tray.png` (the tray wraps: tools on one row, the four inks under them; 44 px targets). I looked at each against the spec. What looking found, all fixed: on the phone the zoom chip peeked out under the tray (it is hidden while the tray is open); after a drag the dragged block's toolbar and handles stayed over the drawing surface (a tool that draws now starts from a board with nothing picked); my first "picked" shot showed a note selected instead of a mark (my script's click landed on the note), which led to a real Select-picking assertion instead of a screenshot.
Not a defect but visible: an edge's label is the library's plain text with no background; two stacked notes have a very short edge between them; edges have no arrowheads (open question 1).

## Perf (my share; the measured gate is S3-X's)

One run, headless Chromium on this machine, a scripted Pan-tool drag back and forth across a board of 150 blocks and 200 pen strokes of 30 points at zoom 0.6: **242 frames, average 8.3 ms, p95 8.6 ms, max 9.4 ms** (the display's rate; nothing dropped). The spec (`artifact-canvas-draw.spec.ts`, "records the frame time...") prints the numbers and asserts only a ceiling of 80 ms on the average. The stroke paths are computed once per mark (a `WeakMap` keyed by the mark), so a pan only moves the viewport transform and the pad's box; the pad's four numbers change per frame, nothing else does.
**Editor chunk: 224.7 kB raw / 67.0 kB gzip** (S3-B: 193.1 / 57.2), one exclusive chunk plus 29 shared; `perfect-freehand` and `@xyflow` are both confined to it (the guard is green), `html-to-image` is not in the build. That is **2.0 kB past the spec's 65 kB gzip budget** with S3-C, S3-A, S3-R and the export still to add. What is in the +9.8 kB gzip: the layer and its geometry, `perfect-freehand`, the tray, the board's frame handling. Options for the owner: a ruling that raises the budget, or load `AnnotationLayer.svelte` (with `perfect-freehand` and `annotations.ts`, about 9 kB gzip of this) behind the first Draw or the first stored mark (the guard would need `--allow-entry` for it). I did not do either: neither was asked, and the second changes when strokes first appear.

## Deviations from the spec / brief, and why (summary)

1. One in-session history (steps and strokes), not a drawing-only one (ruling 16 and S3-B's shipped brief win over the T4 text).
2. A stale save does not revert the on-screen gesture (S3-B's tested conflict behaviour; nothing is persisted).
3. No version summary text ("Moved a note into Friday"): a body save names a `summaryKind`.
4. `frameRect` folded into `nodeRect(node, all)` (absolute for nested frames); `nodeRect`/`frameAt` take `all`.
5. Toolbar: a tray under Draw, not a single row; the layer is a tab stop only when it has something to do and comes after the blocks.
6. Marks store `var(--ink-*)`; the ink is theme-dependent.
7. Pinch: none while a drawing tool is active on touch; a pinch that starts on a block zooms (the library's behaviour, not "dropped whole").
8. The "moves the camera when Select marquee-drags" case asserts the opposite pair (see above).
9. Frame delete re-homes children (spec silent); edges take facing sides at load (spec silent on handles).
10. `BOARD_NODE_WIDTH`/`BOARD_DEFAULT_NODE_HEIGHT` kept as aliased re-exports (the eval imports them).
11. Biome's `--write` rewrote `import { INKS }` to `import { type INKS }` in `CanvasToolbar.svelte` because the script used it only in a type position and the each-block is in the markup (the repo turns `noUnusedImports` off for Svelte but not `useImportType`); the toolbar now uses `INKS` as a value in the script. Worth knowing before anyone runs `biome check --write` over Svelte files.

## Open questions

1. **Arrowheads on edges.** An edge's direction (source to target) is stored and Alfy's `add_edge` has it, but nothing draws it. `defaultEdgeOptions={{ markerEnd }}` is one line if the owner wants it; I did not add it (not asked, and a marker colour that follows the theme needs checking).
2. **A drop connects near a side, not on the middle of a block** (the library's connection radius, 20 px). A bigger radius, or a full-size target handle, would make "drop it on the note" work; S3-B's behaviour, unchanged.
3. `AGENTS.md`'s Artifacts section still wants its Canvas paragraph (S3-B and S3-P said so too): `canvas/` layout, `_lib/board.ts` (geometry and the reparent rules), the drawing layer's three traps, the one history, the chunk guard.
4. The panel-remembers-the-open-item-across-conversations observation from S3-B's open question 3 is untouched.

## Hand-off

### What is where (all under `src/lib/components/artifacts/canvas/`)

- `_lib/board.ts` (pure): `absoluteOf(node, all)`, `nodeRect(node, all, measured?)` (board-absolute; measured, else stored, else the shared 190x84), `frameAt(point, all, exceptId?)`, `reparentOnDrop(node, all, measured?)`, `rehomeOnRemoval(removedIds, all)`, `parentsFirst(nodes)`, `facingHandles(source, target, all)`, `withoutDanglingEdges(edges, nodes)`.
- `_lib/board-model.ts`: `toFlowEdges(edges, nodes)` (new), `bodyOfState` now drops an edge whose end is not on the board.
- `_lib/pane-rect.ts`: `visibleBoardRect(paneSize, viewport, margin)`.
- `_lib/annotations.ts`: `Tool`, `DrawingTool`, `DRAWING_TOOLS`, `isDrawingTool`, `INKS`, `DEFAULT_INK`, `baseSize`, the geometry and picking helpers.
- `_lib/ids.ts`: `newId(prefix)`.
- `AnnotationLayer.svelte` props: `annotations, viewport, paneSize, tool, ink, readonly?, toBoard, onchange(next), ontoolchange, onannounce, onlimit`. `CanvasToolbar.svelte` gained `ink` and `oninkchange`, and its `tool` is `Tool`. `NodeShell` gained `dropTarget`; the board context gained `dropTargetId`. Test ids: `canvas-tool-draw`, `canvas-tool-{pen,highlighter,line,arrow,rect,ellipse,text,eraser}`, `canvas-ink-{blue,red,green,graphite}`, `canvas-draw-tray`, `canvas-drawing-layer` (the pad), `canvas-annotations` (the layer's root), `canvas-ink` (its SVG), `canvas-mark`, `canvas-text-input`, `canvas-limit-notice`; attributes `data-annotation-chrome` (the selection box), `data-drop-target` (a frame that would take the block being dragged).
- E2E: `tests/e2e/artifact-canvas-helpers.ts` exports `seedCanvas`, `storedBoard`, `storedAnnotations`, `openChatAndReload`, `openCanvasPanel`, `nodeCount`, `savedStatus`, `versionRows`, `nodeBox`, `dragBetween`, `cameraOf`; use them rather than copying (they wait for the sliding panel to stop).

### For S3-C (pins on the same portal layer)

- Mount pins as their own `<ViewportPortal target="front">` child of `<SvelteFlow>` next to the layer's (`CanvasBoard.svelte`, right after `<Background>`). Give it the same three things: `z-index: 2` **inline** on its root (the library lifts frame children to 1), a zero-size root at the board's origin with `pointer-events: none`, and `pointer-events: auto` only on the pin itself. Nothing may depend on a selector from an ancestor: portal content is a sibling of the board's root.
- Anything that takes the pointer and must not pan the board, start a pinch or zoom on a double-click needs the library's `nopan` class (its zoom filter checks it); the wheel still works over it. The marks use it.
- Pane size for any overlay: the board binds `boardWidth`/`boardHeight` (`bind:clientWidth`/`clientHeight` on `.canvas-board`, which the flow's pane fills exactly; the coverage gate proves it) and `viewport` (`bind:viewport`). `visibleBoardRect(paneSize, viewport, margin)` is what a pointer-capturing overlay is sized from.
- Screen and board: `flow.screenToFlowPosition` (the layer takes it as `toBoard`), `flow.flowToScreenPosition` for the open card in screen space. **Never take `zoomIn`/`zoomOut` from `useSvelteFlow()` called outside the flow's subtree** (see "A defect in S3-B's board"); every other member reads the live store.
- Anchors: a point anchor is `{x, y}` in board units; a block anchor resolves through `nodeRect(node, all)` (absolute, so a note in a frame works and a block that has not been measured still has a footprint).
- A comment tool is one more `Tool` (`_lib/annotations.ts`): add it to the toolbar's tool list and to the board's `drawing` derived if it owns the pointer (that derived is what turns off the library's pan on touch and makes `setTool` deselect blocks). Escape: the layer takes it first (a stroke, then the tool, then the selection); give the open card the same courtesy.
- Tab order is toolbar, blocks, the drawing layer (a stop only while it has something to do), then pins.

### For S3-A (the tween, the highlight, the review bar)

- Landing a diff is replacing `nodes`/`edges` in the board (S3-B's `restore()` is the pattern: `toFlowNodes`, `toFlowEdges`, and set `committedJson` directly so it is not a step of the reader's). Keep parents first (`parentsFirst`), give edges their sides (`toFlowEdges`); `bodyOfState` drops an edge whose end is gone, so a landed `remove_node` cannot leave one. A landed `remove_node` of a frame re-homes its children exactly as `rehomeOnRemoval` does; that is also what the panel's own Delete does now.
- Adoption runs only from `onnodedragstop`, so a tween that sets `position` on live nodes never reparents anything.
- `NodeShell`'s `dropTarget` prop and `.canvas-node--drop` class are the pattern for a highlight ring beside the selection outline; `CanvasNode.highlight` is still not rendered.
- Marks (`annotations`) are untouched by any op (the model cannot draw); a Restore or a landing replaces them with the body's.
- The toolbar's Undo is named "Undo your last step" (ruling 16); the review bar's must say it undoes Alfy's change. `announce(message)` is the board's polite live region.

### For S3-X (export, perf)

- Marks are SVG in the viewport's front layer: `.svelte-flow__viewport-front .annotation-root > svg.annotation-ink`, one `<g class="mark" data-annotation-id>` each. The ink is a CSS variable (`var(--ink-*)`) with a theme-dependent value (light `#2f6fd0` `#c0392b` `#2e7d4f` `#59636e`; dark `#6ea1f0` `#ef7a6c` `#5ec98a` `#aab4be`): resolve it before rasterising, and expect the probe's blue to differ by theme.
- Leave out of an export: the selection box (`[data-annotation-chrome]`), a mark under the eraser (`.mark--sweep`), the hit shapes (`.hit`, invisible), the text field being typed in (`.annotation-text`), a frame with `data-drop-target`.
- `html-to-image` is not in `package.json`: `npm i --save-exact html-to-image@1.11.11` with your own `npm ci` first. The chunk guard already knows its fingerprint.
- The editor chunk is 67.0 kB gzip, past the 65 kB budget (see Perf). `--max-gzip 65000` is still not on the build script.

### For S3-R

- `reparentOnDrop` refuses to adopt any kind whose `BLOCK_META` row says `structural: true`, and reads a block's size from what the panel measured, so a new node component needs nothing in the geometry.
