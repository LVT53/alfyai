# F-B report · the Canvas board UI (RV-3 cluster B)

Fix agent F-B, model `claude-sonnet-5-5`. Worktree `art-fxb3`, branch `fix/artifacts-w3-board` (from `feat/artifacts` at `47e5e622`, with S3-X
and F-A merged). Nothing pushed, merged or rebased; no subagent dispatched; no other worktree touched; nothing under `docs/plans/**`.
**Commits `304ff3c8`..`1cda86a4` (15).** No migration.

| Commit | What |
|---|---|
| `304ff3c8` | the two flaky Insert-menu e2e checks wait for what they measure |
| `e7db76ec` | C2 (board): a block stored with no width is drawn at `NODE_WIDTH` |
| `f2a0cafb` | C1 (board): keys that cannot collide, and a boundary so one bad block is a notice, never the board's error |
| `8e23125e` | I3: Redo keeps Alfy's change (pill, card and server agree) |
| `6cf0b907` | Minor 1: Insert puts a note on free ground |
| `cf46258c` | I4: the Comment tool comments on the block that is clicked |
| `77fc768a` | I2's banner wording, Minor 8 (Hungarian), Minor 9 (zoom name) |
| `8afb1c60` | Minor 4: arrowheads |
| `8c8de8a5` | Minor 10 (frame ring clears its name) and Minor 11 (rings only while a change waits) |
| `581adb14` | Minor 2: the pill keeps off untouched blocks; a landing out of view brings the camera to it |
| `bdbbbc43` | Minor 3: finger-sized hit areas on a selected block's anchors and resize corners |
| `9a7c31bf` | S3-X's open question: a kept PNG shows in the chat's list at once (**the one commit that touches the chat page**) |
| `85990104` | ruling 68: `--max-gzip 68608`, and what it took to fit under it |
| `cd87663f` | a screenshot found the pill lying over a note after Undo: it follows its blocks after a decision, only the rings go |
| `1cda86a4` | `AppNode` narrows the new `files` change (svelte-check found it) |

## Per finding: the failing test, the fix

### The two flaky Insert-menu checks (`304ff3c8`)
- **What they were.** `:291` and `:413` are the *same* test, "moves between the menu's rows with the arrow keys", seen in two trees (S3-Y's, F-A's;
  F-A's tree had +122 lines of e2e above it). S3-X had already changed its count from 5 to 6. The menu grows after it opens: "From this chat" is
  a chunk of its own (a dev server transforms it on first use) and then a read of the chat. Counting or driving the rows before both landed
  measured a menu still changing: 5 rows, then 6 (`counted 6, expected 5`), or `End` landing on the last of 5 rows and `ArrowDown` then going to
  the row that arrived (`menuitem.first() not focused`).
- **Red, seen.** With the section held back 6.5 s by a route (a loaded machine's cold transform), the old check fails: `Expected 6, Received 5`
  after its 5 s (scratch spec, deleted).
- **Fix.** `openInsertMenu(page)` in `artifact-canvas.spec.ts`: opens the menu and waits for "From this chat" to be there and its read to have
  settled (`aria-busy="false"`), with a 20 s timeout. Used by the three menu checks. What they assert is unchanged. With the same 6.5 s delay the
  three now pass. In the full run of this branch (350 tests) none failed.

### C1, the board's half (`f2a0cafb`)
- **Red, seen (5 vitest).** `ChecklistNode` with two items of id `"1"` threw `each_key_duplicate` (the review's exact error); a `NodeShell` whose
  content throws threw out of `render` (4 tests); photo and web-source tests red on the old keys (checked by reverting the two files).
- **Fix.**
  - `ChecklistNode`, `PhotoNode`, `LiveWebNode` key by place and id (`` `${index}:${id}` ``): cannot collide. A checklist row acts on its place in
    the list (`toggle(index)`, `rename(index, …)`, `remove(index)`), so a repeated id still ticks one item at a time.
  - `NodeShell` wraps a block's content in `<svelte:boundary>`; the `failed` card ("Ezt a blokkot nem sikerült megrajzolni." /
    "This block could not be drawn." + Try again) is `nodes/NodeNotice.svelte`, now the same card `LazyNode`'s failed load draws. The console
    names the block. Anchors, name and toolbar stay, and the rest of the board is untouched.
- **Not needed:** annotations and nodes with repeated ids are dropped on read by `normalizeCanvasBody` (F-A), so the client never meets them.
- **Deliberately not caught:** an error thrown by a node component's own script or by `NodeShell`'s own template above the boundary. Content
  is where the review's failure was; a wrapper around every node type would have changed `boardNodeTypes` and its tests.

### C2, the board's half (`e7db76ec`)
- **Red, seen.** Unit: `toFlowNodes` gave an unsized note no width. E2E ("draws a board stored with no widths…"): a 100-character note in a
  420-wide frame was drawn **755** wide (the review's 861).
- **Fix.** `toFlowNodes` gives any unsized non-frame block `style: "width: 190px;"` (`NODE_WIDTH`, what the model reads). **A style, not a
  `width` on the node** (deviation, below): `diffBoards` compares width, so a width in the live state would ring every legacy block on the next
  landing. A resize sets a real width, which the library appends after the style.

### I3 (`8e23125e`)
- **Red, seen.** E2E: land, Undo, Redo, then the pill read "Alfy Keep Undo" (pending again) while the server said nothing waits.
- **Fix: the review's second option.** Redo writes Alfy's board back as the reader's version (as before) and the change is **Kept**: pill
  "Megtartva/Kept", count 0 (the server's number at every step and after a reload), the Undo that the server would refuse is no longer offered.
  Unit tests updated where they pinned "pending again" (3).
- **Not the first option, and why (see Deviations 2):** an Alfy-authored redo needs the body route to write `author: "alfy"`, which is server work
  outside cluster B. So "Undo, Redo, Undo" is not a sequence the pill offers; Versions is the way back.

### I4 (`cf46258c`)
- **Red, seen.** E2E: insert a note (auto-selected), press Comment: the catcher never showed, because the note had taken the comment.
- **Fix.** The board remembers the block an Insert selected (`insertSelectedId`), clears it on a click on a block, and when the Comment tool is
  armed lets go of that selection so the tool waits for the click. A block the reader clicked themselves still takes the comment at once (the
  existing e2e "a block that is selected when the tool is armed…" passes). The phone works the same way (no sheet opens on the new note).
  All in `CanvasBoard.svelte`: `CanvasEditor` is F-C's and is not touched.

### I2's banner, Minor 8, Minor 9 (`77fc768a`)
- **Red, seen.** Three new vitest in `artifacts.test.ts` (the Hungarian, the banner, the zoom names).
- **Banner.** EN: "Alfy or another window changed the board, so your last step was not saved. Reload to see the newest version." HU: "A táblát Alfy
  vagy egy másik ablak módosította, ezért az utolsó lépésedet nem sikerült elmenteni. Töltsd újra a legfrissebb változathoz." It names the usual
  cause and the loss. Three e2e that pinned the old sentence say the new one.
- **Minor 8.** Saját lépés ismét; offline notice; "Megjegyzés indítva — írd meg a listában."; "Alfy dolgozik a táblán…" (and the summary form);
  Elavult; "A blokk már nem létezik."; "Az itt kipipált elemeket a táblával együtt mentjük."; "{left} módosítást kihagyott". (`Nem élő alaptérkép`
  is a different string and stays.)
- **Minor 9.** HU `zoom` (the group) is "Nagyítás mértéke"; the zoom-in button stays "Nagyítás". English already differed.
- New keys: `artifacts.canvas.block.drawFailed` (EN+HU, in a block at the end of each language, "after the Canvas review").

### Minor 1 (`6cf0b907`)
Red e2e: the inserted note overlapped the one in the middle. Every insert but a frame now uses `placeBesideBlocks` (free ground); a frame is still
staggered off the others.

### Minor 4 (`8afb1c60`)
Red e2e: the edge path had no `marker-end`. `defaultEdgeOptions={{ markerEnd: ArrowClosed }}`; the head takes the edge's colour from the
`--xy-edge-stroke` token the board already sets (light and dark).

### Minor 10 and 11 (`8c8de8a5`, corrected by `cd87663f`)
- 10: a frame's ring stands 14 units outside the frame all round (`FRAME_RING_PADDING`), clear of the name chip that sits across its top edge.
  Red: the ring began on the frame's own edge.
- 11: only a change that still waits is ringed (`waiting`). **My first version dropped the touched blocks from the layer altogether, and a
  screenshot showed the consequence:** after Undo the "Visszavonva · Újra" pill stayed at its old corner while the blocks glided back under it,
  over the museum note's words. `cd87663f` gives the layer the touched blocks always and a separate `waiting` flag, so the pill follows its
  blocks at every stage and a decided change has no ring.

### Minor 2 (`581adb14`)
- **Pill.** `changePillAnchor` (`review-geometry.ts`): the top-right corner of the box that holds the change when nothing is under the pill
  there, else the corner of a touched block with the least under it, highest first; a frame is a backdrop and is not in the way. Red: the pill
  sat at 700 over an untouched block.
- **Landing out of view.** The controller counts settled landings (`landed`); the layer, when none of the change is on the pane, calls
  `oncenter` on the first touched block. A change already there when the layer comes up (a reload) is shown as it is. Red: e2e, a note added at
  (3200, 2200) stayed off the pane (checked by wiring `landed` off).
- **Phone pill buttons.** Already met: `ChangeBar`'s `::after` (≤ 480 px) gives Keep and Undo a 44 px hit area though they draw 20 px. A new e2e
  measures it (`elementFromPoint` 20 px above and below each button's centre); it passes, so it is a guard, not a fix.

### Minor 3 (`bdbbbc43`)
Under `(pointer: coarse)` a selected block's anchors and resize corners get an invisible `::after` hit area of about 24 **screen** px: sized from
`--canvas-inv-zoom` (1 / zoom), which the board sets from the zoom the camera last came to rest at (`onmoveend`, not every frame of a pinch). A
mouse keeps the small ones (e2e). **Red, three ways:** CSS off, both touch tests fail; zoom scaling off, only the zoomed-out one fails; the
first attempt showed that on a tiny note the neighbouring corner's hit area covers a mid-side anchor, so the test uses blocks whose handles are
apart (a note fitted large, and a frame on a board zoomed far out).

### PNG export → the list at once (`9a7c31bf`, `1cda86a4`)
`subscribeArtifactChanges` gets a third change, `{ type: "files"; conversationId }`, announced by `announceChatFilesChanged` (artifacts.ts) once
`exportBoardPng` has kept the picture (not before, not on failure, not for a board with no chat). The chat page reads what the chat made again with
the light refresh it already uses after a keep-as-document. Red: the count button stayed "1" until a reload; now "2" and the File card appear at once.
`AppNode`'s own subscription narrows on the type (svelte-check caught it).

### Ruling 68 (`85990104`)
`--max-gzip` is **68608** in `check:artifact-chunks`. See "The budget".

## The budget
| | S3-X (its own tree) | this branch's first build | final |
|---|---|---|---|
| what the editor loads on its own (gzip, guard's honest measure) | 67,872 B | 68,711 B (**over**) | **68,595 B**, 11 chunks |
| the chunk that holds `CanvasEditor` | 60,776 B | 61,029 B | 59.5 KiB |
| chat route without a board open | +1,160 B | | +1,123 B (2,048 allowed) |

The guard **passes with 13 B to spare**. What put it over (the branch's own board changes: boundary, arrowheads, default width, insert rule, the
touch hit areas, and F-A's shared code that was already in the base) and what took it back: the failed-block card is one shared component; the
layer works out what is on screen itself, because importing `pane-rect` had split a new shared chunk out of the first paint; the resting zoom
comes from `onmoveend`, not an effect with a timer; a shorter console line and two shorter selectors. Chart.js and MapLibre stay out.
**F-C's `CanvasEditor.svelte` changes are in this closure and will not fit in 13 B**: see Open questions.

## Gates (final tree `1cda86a4`, run once)
1. `npm run check`: **0 errors, 17 warnings** (the pre-existing ones; it had 3 errors before `1cda86a4`).
2. `npx biome check src scripts tests`: clean (2,413 files).
3. `npm test`: **991 files passed + 1 skipped; 15,797 tests passed**, 2 skipped.
4. `npm run build`: exit 0; **32** `Unused CSS selector` + **2** `must have an ARIA role` (the baseline); the guard passes (above).
5. Playwright, port 5560, the 29 files of the gate set (`artifact*.spec.ts`, `artifacts-*.spec.ts`, `knowledge`, `chat`, `conversation`):
   **337 passed, 13 skipped, 0 failed, 0 flaky of 350** (24.8 min, one run, exit 0). The two Insert-menu checks passed in it.
6. Fallow: **124 issues, 4 circular** (identical to the baseline), zero added.
7. `npm run check:migrations`: passes.

## Tests added or changed
- vitest: `board-model.test.ts` (3), `nodes.test.ts` (checklist duplicate ids; the boundary: 4), `live-block-nodes.test.ts` (photo, web
  duplicates; the stale badge's HU changed), `review-controller.test.ts` (Redo kept; what the layer rings: 2), `AlfyChangeLayer.test.ts` (frame ring,
  pill placement 2, landing pan 4, decided change), `review-geometry.test.ts` (`changePillAnchor`: 5), `export-png.test.ts` (announce: 2),
  `artifacts.test.ts` (wording: 3). Helpers `_test/BrokenContent.svelte`, `_test/ShellWithBrokenContent.svelte`, `_test/broken-content.ts`.
- e2e: `artifact-canvas.spec.ts` (`openInsertMenu`; unsized board; free ground; arrowhead; mouse and two touch hit-area tests),
  `artifact-canvas-review.spec.ts` (Redo kept; no rings after Undo; landing out of view; phone pill hit area),
  `artifact-canvas-comments.spec.ts` (Comment after an Insert), `artifact-canvas-export.spec.ts` (the File without a reload); the three specs
  that pinned the old banner sentence.

## Screenshots (looked at each; Hungarian; not committed) — `…/scratchpad/w3/shots/fb/`
1. `1440-hu-legacy-board-arrows.png` — a board stored without widths: notes 190 wide inside "Szombat", arrowheads on both arrows.
2. `1440-hu-broken-block.png` — the checklist chunk made to throw: its card says it could not be drawn, with "Újra"; the rest of the board and
   its header are intact.
3. `1440-hu-alfy-landed-light.png` — Alfy's change landed: the "Vasárnap" frame's ring stands outside its name; the pill hangs above the museum in
   free ground; the card counts 3.
4. `1440-hu-redo-kept-dark.png` — after Undo then Redo: "Megtartva" follows the museum; the card says "Átnézve". (I also looked at the Undone
   state, which is where the defect above showed; that shot is not kept, to stay at 8.)
5. `1440-hu-refused-save-banner.png` — the new banner and its "Újratöltés"; the checklist hint reads "Az itt kipipált elemeket…".
6. `390-hu-alfy-pill-dark.png` — phone, dark: the change fitted, ringed, the pill clear of blocks, the bar below.
7. `1440-hu-insert-then-comment.png` — an inserted note on free ground, and the Comment tool armed and waiting (no composer opened on the note).
8. `390-hu-selected-handles.png` — phone, a selected block: the handles look as before (their hit area is invisible by design).

## Deviations and decisions the orchestrator should look at
1. **I touched the chat page (`+page.svelte`), F-C's file**, in one isolated commit (`9a7c31bf`, plus `1cda86a4` for `AppNode`): a branch in the
   `subscribeArtifactChanges` callback and a 6-line `refreshConversationFiles`, away from the send path I2 changes. Reason: the brief's "announce
   it" has no consumer otherwise, and widening the channel's union makes the page's callback stop compiling unless it narrows. If it conflicts with
   F-C, revert both commits as a pair; the only loss is that the export's File shows after a reload again (S3-X's state).
2. **I3 is the review's second option** (Redo = Kept), not the first (Alfy-authored redo). The pill no longer offers Undo after Redo. If the owner
   wants Undo and Redo to toggle freely, the body route must write a redo as `author: "alfy"` (with a check that the body is an existing Alfy
   version), which is server work.
3. **C2 draws the default width as a style, not a width on the node** (see above); the review and F-A both said "`toFlowNodes` gives the node a
   width". A stored width in the live state would make `diffBoards` (which compares width) report every legacy block as changed at the next landing.
4. **Minor 2's phone-pill bullet needed no change** (guard test only).
5. **A landing's pan is "none of the change is on screen"**, the review's "at least". A change partly under the toolbar is not moved.
6. `changeLayerProps` now also passes `paneSize` and `landed`, and `waiting`; `BoardLayerApi` and `CanvasEditor` are unchanged.

## Open questions and concerns
- **The budget has 13 B of room, F-C's `CanvasEditor` changes are in the same closure.** Whoever merges second will be over. Options: raise the
  ceiling by a ruling, or take one of S3-X's four cuts (note-shaped kinds lazy ≈ 1.5 KiB, our own dot background ≈ 0.4, a pruned `base.css`
  ≈ 0.4, the minimap). I cut what I could without a visible change.
- The touch hit areas overlap when a block is tiny on screen (a one-line note at a far-out zoom: a mid-side anchor sits 8 px from a corner).
  The topmost handle wins there; zooming in separates them. Not changed.
- The two bullets of Minor 12 (Insert popover's first focus, photo lightbox trap) and Minor 13 are not assigned to B and untouched. Minor 5–7
  were cluster A's.
- `AGENTS.md`'s Artifacts section could name `announceChatFilesChanged` / the `files` change, `NodeNotice`, `changePillAnchor` and the `waiting`
  flag. I did not touch it (conflict-prone; the orchestrator's merge).

## Hand-off
- **Components/props.** `canvas/nodes/NodeNotice.svelte` (`message`, `testid`, `retry`; used by `LazyNode` and `NodeShell`'s boundary);
  `AlfyChangeLayer` props `waiting` (default true), `paneSize`, `landed`; `NodeShell` draws `data-testid="canvas-node-broken"` for a block whose
  content throws.
- **Modules/exports.** `review-geometry.ts` `changePillAnchor({ touched, obstacles, zoom })`; `review-controller.svelte.ts`
  `CanvasReviewController.landed` and `changeLayerProps` (`touched` always, `waiting`, `paneSize`, `landed`); `board-model.ts` `toFlowNodes` (the
  unsized-width style); `client/api/artifacts.ts` `announceChatFilesChanged(conversationId)` and `ArtifactChange` `{ type: "files"; conversationId }`.
- **CSS.** `--canvas-inv-zoom` on `.canvas-board` (1 / the zoom at rest); the coarse-pointer hit areas are in `NodeShell.svelte`.
- **Test ids.** `canvas-node-broken`; the e2e helper `openInsertMenu` lives in `artifact-canvas.spec.ts` (the blocks and live specs have their own).
- **For the next agent.** A new kind's content is inside the boundary for free; a new keyed list of stored data should key by place and id.
