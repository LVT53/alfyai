# OW-2 report · select several blocks, move, resize and delete them together

Agent: OW-2, model `claude-sonnet-5-5`. Worktree `art-ow2`, branch `feat/canvas-multi-select` (from `b4e3489a`, i.e. `feat/artifacts` with OW-1 and OW-C merged), e2e port 5630.
Commits `b4e3489a..b4ebdfd9` (oldest first, ten):

| Commit | What |
|---|---|
| `329f2e0b` | the pure arithmetic of a group resize (`_lib/group-scale.ts`, 13 unit tests) |
| `9b27e81c` | the feature: Shift/Cmd/Ctrl pick, full-enclosure marquee, ONE box with eight handles and a toolbar for two or more picked blocks, a finger's long press, i18n EN+HU, 21 e2e tests |
| `d18d83b4` | the box keeps out of a drag's way; unit tests for the box and for the long-press state machine |
| `9fa6b4d9` | the editor's first paint trimmed (see Size) |
| `a04c0e63` | a held group drag ends if the box goes; Shift+Space test; the board's header says how several blocks work |
| `ba15013c` | the box is hidden while the library's marquee is on screen |
| `0e5cb2d4` | AGENTS.md: the group paragraph and `group-parts.ts` in the lazy-entry list |
| `63a0f124` | the selection pill hangs clear of the group box's handles |
| `6932eddc` | lint (assignments in expressions) and biome's format for the new Svelte files |
| `b4ebdfd9` | a finger gets the four corners only; the pill keeps one reach for every pointer (found by the full run, see below) |

## What I found on the old code (measured before building anything)

The library already did more than the brief assumed: a marquee (`selectionOnDrag` with the Select tool on a pointer), a multi-drag, Delete on all and the arrow-key nudge. What was wrong or missing, each seen red in a real-input test first:

1. **The marquee picked a frame it only crossed.** The installed `@xyflow/svelte` 1.7.0 `.d.ts` says `selectionMode` defaults to `'full'`; the runtime default is `SelectionMode.Partial` (`store/initial-store.svelte.js`). A marquee drawn inside a frame (it starts on the empty board, a frame lets the pointer through) picked the frame together with its notes, so the next drag moved the frame.
2. **Shift-click did not add.** The library's multi-selection key is Cmd on a Mac, Ctrl elsewhere, never Shift (Shift only starts a marquee).
3. **A picked block wore its own controls.** N picked blocks showed N sets of four corners, four connection anchors and a toolbar whose Delete deletes THAT ONE block (`flow.deleteElements({ nodes: [{ id }] })`). There was nothing to resize the group by, and a click on the wrong Delete took one block of a selection.
4. **A modifier-click on a frame's ground replaced the selection** (OW-1's `handlePaneClick` did not read modifiers, as its hand-off said).
5. Already fine: multi-drag (any picked block moves all), the arrow keys (the library moves every picked block by the snap step, **5 px a press, 20 with Shift**), Delete on all, adoption by `reparentOnDrop` for every dragged block. Tested as guards.

## What changed, by step

### Selecting several
- `CanvasBoard.svelte`: `multiSelectionKey={["Shift","Meta","Control"]}` (Shift, Cmd, Ctrl add a block or take a picked one out; Shift+Space does the same from the keyboard, the library's own, now tested) and `selectionMode={SelectionMode.Full}`.
- **Which marquee, said as the brief asks: FULL (what it encloses), not partial.** Figma and Miro take what the marquee touches, and I would have picked that, but on this board the library's partial default demonstrably picks a frame the marquee only crosses (point 1), which is the common case (notes live in frames). Full never grabs a frame or a big block by accident, and a marquee inside a frame picks exactly its notes (what draw.io, PowerPoint and Excalidraw do). Touch-style picking for non-frame blocks plus Figma's "a frame is picked only when enclosed" needs a marquee of our own (see Open questions).
- A modifier-click on a frame's ground adds the frame to what was picked (`handlePaneClick` reads `shiftKey/metaKey/ctrlKey` and what was picked BEFORE the microtask, because the library puts it all down after `onpaneclick`).
- Escape: with two or more picked it puts the whole selection down in one press (the box's handler, capture phase, runs before the pill's own and stops it); with one picked block it is unchanged (the pill hides first). Typing in a field keeps its own Escape.
- Panning is unchanged and tested not to select: Hand tool, Space+drag, middle button (the two fingers/trackpad paths are the library's and untouched).

### Moving together
The library's multi-drag, nudge and Delete already work (guards in the spec); a move into or out of a frame reparents each dragged block by `reparentOnDrop`, as for a single drag (tested both ways with two notes). **A resize does not re-adopt blocks** into frames (a single block's resize does not either); a move does.

### Resizing together: ONE box, eight handles (`canvas/GroupBox.svelte`, lazy)
- Two or more picked blocks (Select tool, editable board) give up their own corners, anchors and toolbar (`grouped` on the board context, read in `NodeShell`) to one box drawn in **screen space** (handles are button-sized at any zoom, no counter-scaling): eight handles (16 px hit, 8 px mark) and one toolbar above it (the count, **Delete for all**, named "Delete N blocks", clamped inside the pane). Each picked block keeps its own outline. The library's own rectangle round a picked set is not drawn (the wrapper stays for keyboard focus).
- `canvas/_lib/group-scale.ts` (pure, unit-tested): the box is the union of the PICKED blocks as drawn; a handle scales it about the opposite corner (an edge handle: one way, the other part of the drag ignored); every block's place and size scale with it; a picked frame takes its notes along (picked or not); a picked note in a frame that is not picked is re-based against the frame where it is; whole numbers; each block in the space it is stored in.
- **What is clamped, as the brief asks:** each kind's `BLOCK_META.minSize` (the very floor a single block's corner stops at: note 96 x 64, text 80 x 32, checklist 180 x 80, chart 240 x 160, frame 160 x 120, ...). The group takes ONE factor per axis, no smaller than the one at which the first block reaches its minimum, so nothing is squeezed past readable, the arrangement keeps its shape and no block overlaps because of a clamp. A block already below its minimum (a note Alfy made small) does not force the group to grow. A note with no stored height gets one, as a single-block resize gives it.
- **One gesture, one step, one save.** The board holds its settle timer while `resizing` (`onresizestart`/`onresizeend`), so a drag with a pause longer than the 350 ms settle delay is still one undo entry and ONE save (tested by counting the body route's requests). If the box goes mid-drag (a landing starts, the panel closes) it ends the gesture as it goes and the board clears the hold on destroy, so a held drag can never stop later steps from settling. Escape in the drag puts every block back (originals kept, a block that had no size goes back without one).
- The box hides while the library's live marquee is on screen (CSS `:has`, because the box can mount in the marquee's last move) and while a pointer drags blocks (a pointer-move rule); it is back when the pointer lets go.
- The selection pill hangs 15 px further from several picked blocks, clear of the box's handles.

### On a phone: a long press starts a selection, taps add and remove (not the toolbar)
Chosen over a Select mode in the toolbar because the compact toolbar has no room and a long press is what a finger already means. `canvas/_lib/touch-select.ts` (lazy, loaded at once on a coarse pointer): a 450 ms still press on a block adds it to what was picked and starts the picking mode (announced to a screen reader: "Selection started. Tap blocks to add or remove them."); then a tap on a block adds it or, when picked, takes it out; a tap on the empty board puts everything down and taps are plain again; a touch that moves (>10 px) is a drag or a pan, never a pick; taps on a button, field or link keep their meaning. The selection is set after the lift and again after the click the library handles (the board's copy lags the library's by a beat, and a pick made first is not seen as a change).
**Touch targets:** the box offers the **four corners only, 44 px each**, and its toolbar (count + Delete) is 48 px tall with a 44 px Delete. Edge handles are mouse-only: a 44 px target in the middle of a side sat on the blocks, the toolbar and the selection's pill (the full run's one failure was a tap on a block missing because I had moved the pill a fingertip down to clear such a handle; corners-only plus one 15 px reach fixed both).

## Tests

- Vitest (new): `group-scale.test.ts` (13: the box, handles, opposite corner held, edge handles, the shared floor, a block under its minimum, whole numbers, a frame's notes, a re-based note, a zero-sized block), `touch-select.test.ts` (9), `GroupBox.test.ts` (12: box and handles, one block no box, announcements, corners-only on a finger, Delete, a handle's drag as one gesture, an edge's one-way drag, Escape restores and ends, a block without a size goes back without one, the box going mid-drag, Escape clears, typing keeps Escape); `CanvasSelectionPill.test.ts` (one expectation updated for the reach, +1).
- Playwright (new): `tests/e2e/artifact-canvas-multi-select.spec.ts`, 25 tests (24 run on a Mac): Shift-click add/remove, Cmd-click, Ctrl-click (skipped on darwin: a Ctrl-click is a right click there), Shift+Space, the marquee takes only what it encloses and leaves the camera, a marquee inside a frame takes its notes not the frame, Escape and the Hand tool, Space+drag and the middle button pan, the box (eight handles, own corners/toolbars gone, hugging the blocks, back to one block), group drag as one step and one save + undo/redo + stored positions, arrow nudge + undo, two notes out of a frame and two in, resize from se/nw/an edge with the numbers checked per block (position and size from the scale about the anchor, +-2 px), the floor (96 x 64) with the arrangement in proportion, a pause mid-drag is still one step and one save, Escape in the drag, a frame taken along, reload keeps the result, Delete on all (key and toolbar button) as one step, a deleted frame re-homing its notes, and two phone tests with real touch input (long press, taps add/remove/clear, plain tap unchanged, 44 px corners and Delete, no edge handles, a finger drags the group and resizes it from a corner).
- **Red first, seen:** the first run of the spec on untouched code was 21 of 21 red, but several were red because my tests asked for the impossible (a marquee around three notes of a square) and the library's drag/nudge numbers; I corrected those. After the implementation I re-ran the final spec against the BASE `src` (`git checkout b4e3489a -- src`, restored): **22 of 25 red, 1 skipped (Ctrl on a Mac), 2 green: the arrow-key nudge and the pan guard** (the library already did both; they are guards). The unit tests of `group-scale` were red first (module absent). `touch-select.test.ts` and `GroupBox.test.ts` were written after the code they test; the e2e covers the same behaviour red-first.

## Gates (last commit `b4ebdfd9`, everything below run on it)

1. `npm run check`: **0 errors, 17 warnings** (the pre-existing ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1).
2. `npx biome check src scripts tests`: **clean** (2,442 files).
3. `npm test`: **999 files passed (1 skipped), 15,977 tests passed (2 skipped).**
4. `npm run build`: 32 `Unused CSS selector` + 2 `must have an ARIA role` (the baseline), no new warning. **As its own step, `npm run check:artifact-chunks`: exit 0.** Editor first paint **71,267 B gzip** against the ceiling **71,680 B, NOT raised** (413 B headroom; 70,722 B before this work, so the feature spent 545 B); the chunk alone 62,958 B (limit 65,000); the chat route **+1,630 B** against its baseline (limit +2,048). The box, the arithmetic and the finger's gesture are one lazy chunk, `canvas/group-parts.ts`: **7,439 B raw, 3,052 B gzip**, loaded when a selection first has two blocks (at once on a coarse pointer).
5. Playwright on port 5630, the required list (every artifact suite plus knowledge, chat, conversation), 466 tests: **443 passed, 23 skipped, 0 failed** (35.8 min). An earlier full run on the previous commit had one failure (my own phone test, see above) and was stopped and redone from the start after the fix.
6. Fallow: **124 issues, 4 circular** (the baseline); this work adds none.
7. `npm run check:migrations`: passes.

## Size (ruling 68), for the record

First paint carries only the hooks: the keys and `selectionMode`, `grouped`, the loader and its two effects, the merge of a handle's patches, the `resizing` hold, the modifier rule on a frame's ground, two `!board.grouped` tests in `NodeShell`, and one CSS rule. The first build of the feature measured 71,515 B (165 B headroom); **a module the lazy box imported and the editor shares (`isTextEntry`) made the bundler split that module out of the editor's chunk (+230 B gzip, two extra chunks)**, so the board hands the check to the box as a prop (headroom 441 B at that point); the frame ground's rule and the measured-size merge were simplified first (209 B), and the final build leaves 413 B. Lesson for the next lazy entry: do not import from a module the editor already imports; take it as a prop, or measure.

## Deviations from the brief and why

1. Full marquee, not touch-style (above), with the measured reason.
2. A finger gets corner handles only (above).
3. I edited **AGENTS.md** (the Canvas bullet's lazy-entry list and one paragraph on the group); OW-1 left that to the orchestrator. Drop it if you prefer to fold it in yourself.
4. The pill moved: with several blocks picked it hangs 15 px further out (one block unchanged).
5. Ruling 68's ceiling is unchanged; nothing to record in `decisions.md` beyond "71,680 held, 71,267 used".

## Open questions

- **Touch-style marquee (Figma/Miro)** for non-frame blocks with "a frame is picked only when fully enclosed" needs our own marquee (the library gives only full or partial for all kinds). Roughly a day plus its first-paint cost; say if you want it.
- The selection's pill is still drawn while a marquee is being dragged; hiding it needs the same `:has` rule in `CanvasBoard`'s CSS (about 70 B of first paint).
- Group resize is pointer-only (like a single block's corners); Ctrl/Cmd+A (select all) is not built.
- Observation, not changed: `<svelte:window onkeydowncapture={...}>` did not run for the box's Escape (an explicit `addEventListener("keydown", fn, true)` in an effect does), while the pill's identical attribute works (its e2e passes). The box uses the explicit form. Worth a look if the pill's "capture phase" comment is ever relied on.
- The box (and with it the Escape that clears several) arrives a beat after the second block is picked (a lazy chunk); the e2e waits for it. In the first ~100 ms on a cold cache Escape is not heard.
- OW-1's open question about undo across closing the panel stands.

## Screenshots (Hungarian; I looked at each, on the final code)

`/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/shots/ow2/`
- `desktop-light-hu-marquee.png`: mid-marquee over four notes: the library's tinted rectangle, the four enclosed notes picked, the box and toolbar not drawn yet (they wait for the let-go).
- `desktop-light-hu-selection-box.png`: after it: one box 9 px out round the four notes with eight handles, the toolbar "4" + trash above, the Ask Alfy / Comment pill clear below.
- `desktop-light-hu-mid-resize.png`, `desktop-dark-hu-mid-resize.png`: the bottom-right handle dragged: all four notes scaled with the box (the unselected blue notes untouched, overlapped).
- `desktop-dark-hu-selection-box.png`: the box in the dark theme.
- `phone-light-hu-selection-box.png`: 390 x 844 after a long press and a tap: two notes, four corner handles, the 48 px toolbar above.
- `phone-light-hu-mid-resize.png`: a finger on the bottom-right corner, mid-resize (the right corners run past the pane's edge, as the blocks do).

## Hand-off

**Modules, exports, components, props** (all under `src/lib/components/artifacts/canvas/`)
- `_lib/group-scale.ts`: `groupOf(nodes)` (null below two picked; `{ box, items, origins }`), `resizeGroup(group, handle, delta)` (`{ box, patches }`, patches `{ position, width, height }` per block id), types `Group`, `GroupHandle`, `GroupPatch`.
- `GroupBox.svelte` props: `nodes`, `viewport`, `size`, `coarse`, `typing` (the board hands `isTextEntry`), `onresizestart`, `onresize(patches: Map<id, { position, width?, height?, measured? }>)`, `onresizeend`, `ondelete(ids)`, `onclear`, `onannounce`. Test ids `canvas-group-box`, `canvas-group-handle-<nw|n|ne|e|se|s|sw|w>`, `canvas-group-toolbar`, `canvas-group-delete`.
- `group-parts.ts` (lazy entry: `GroupBox`, `watchTouchSelection`), `_lib/touch-select.ts` (`watchTouchSelection`, `afterPress`, `HOLD_MS`, `TouchSelectionApi`).
- `CanvasBoard.svelte`: `MULTI_SELECTION_KEY`, `ensureGroup`, `pickedCount`, `grouped` (context getter `CanvasBoardContext.grouped?`), `resizing`, `applyGroupPatches`; `handlePaneClick` keeps what was picked for a modifier-click. `NodeShell`: corners, anchors and toolbar only while `!board.grouped`.
- `CanvasSelectionPill.svelte`: `GROUP_REACH` (15 px) for two or more picked blocks.
- i18n: `artifacts.canvas.group.label`, `.delete`, `.touchHint` (EN and HU).
- e2e helpers to reuse from the new spec: `pick`, `selectWithMarquee`, `marqueeAround`, `handleCentre`, `scaled`, `countSaves` (counts a gesture's saves), and the CDP `finger` helper for a long press.

**Suggested AGENTS.md text:** already in `AGENTS.md` (the "Several picked blocks are one group" bullet in Artifacts → Canvas, and `canvas/group-parts.ts` in the lazy-entry list). OW-1's three suggested paragraphs (undo, frames as groups, the pill's place) are still not in AGENTS.md.

## Environment notes for the next agents
- Playwright's Chromium on a Mac turns a Ctrl-click into a context menu and the library drops its held keys on `contextmenu`: test a modifier-click with Shift or Meta, and skip Ctrl on darwin.
- A touch drag in Chromium holds back about the first 15 px of a finger's travel as slop, and the library starts a mouse drag one step into the move: assert "all moved by the same amount", not the pointer's distance.
- `savedStatus` is satisfied by an earlier "Saved": when a test makes two saves, poll the stored board or count the body route's requests.
- To wait for a long run without `sleep`, use a bounded `until grep -q ...; do sleep 3; done` loop (about 580 s) and read the log; kill a run by PID (`lsof -iTCP:<port> -sTCP:LISTEN -t` and its parents), never `pkill -f playwright`.
