# CV-B2 report: CV-B's loose ends (toolbar at the top, File block, phone form, Safari's pinch, the note's wheel)

Status DONE_WITH_CONCERNS (concerns in section 7; nothing blocks the merge). Model: claude-sonnet-5-5 (Sonnet 5.5).
Worktree `art-cvb2`, branch `fix/canvas-edit-polish`, from `feat/artifacts` d69432e7 (CV-A, CV-B, CV-C, LANG-2 merged). Port 5490.
Commits `d69432e7..65fe72f0` (10):

```
57b4e387 The wheel pans the board from over a note being typed in                              (5)
f2d7e767 Safari's trackpad pinch zooms the board about the pointer                              (4)
a30cd21f Check on the real board that Safari's gesture events are wired to the camera           (4)
68a057f9 A File block is picked by a click like every block, and opened by a double click, Enter or its Open button   (2)
377df2ca A selected block's toolbar stays in the pane: below the block when there is no room above   (1)
c951cd70 On a phone a block's edit form is the app's sheet, with its buttons in view            (3)
3188579b Mark the end of a File block's row as something that opens                             (2)
1c3a9258 Keep the toolbar's geometry out of the editor's first paint                            (1, size)
4125afc8 AGENTS.md: the toolbar's place, Safari's pinch, a File block's click and the phone's edit sheet
65fe72f0 Test that every kind opens its form as a sheet on a phone and keeps its content        (3)
```

## 1. The toolbar of a selected block stays in the pane

**Red (real input, Playwright, 1440 and 390):** a note whose top is 14 px under the pane's top, selected by a click: its toolbar was
17.5 px outside the pane at the left and cut off at the top; a frame at the top: toolbar top at 84.5 against the pane's 120.5; a frame
taller than the pane with its top out of view: toolbar at -315; on a phone a note near the left edge: toolbar 52.5 px outside the pane
(Edit and Delete unpressable). Guards that stayed green: a block with room keeps its toolbar above it.

**What changed.**
- `canvas/_lib/floating.ts`: `placeToolbar(block, pane, size, avoid)` (pure, unit-tested in the new `floating.test.ts`, 16 tests):
  above the block `TOOLBAR_OFFSET` (12) clear of it; below it when there is no room above; slid in from the pane's sides (8 px gap, the left
  edge wins in a pane narrower than the toolbar); held at the top of the pane over a block taller than the pane; clear of the board's own
  toolbar along the bottom (`BOARD_TOOLBAR_CLEARANCE`) and off the change pill (`avoid`).
- `CanvasBoard.svelte`: `toolbarPlaced` (derived, for the one picked editable block, from the blocks, the camera, the pane and the toolbar's
  measured size). The library keeps placing the toolbar; the board only tells the shell how far to nudge it (`board.toolbarShift`, the
  toolbar's CSS `translate`) and the layers where it ended up (`BoardLayerApi.toolbarBox`). `NodeShell` reports the toolbar's size
  (`board.measureToolbar`) when it is drawn and when its buttons change (the form's Edit arrives with the block's chunk).
- **Off the other layers:** the selection's pill hangs under the block, exactly where a toolbar that flipped below now is.
  `selectionPillPlacement` takes the toolbar's rect (`toolbar` option): below the block it stands under the toolbar (`lift`, an extra CSS
  offset), otherwise as before. Red for this part: with the flip and without it, the pill sat on the toolbar.
- **The geometry is a lazy part** (the board `import()`s `floating.ts` when it mounts, as it does the wheel): the first version was 41 B over
  the editor's ceiling (see section 5). Until the part arrives the library's own place stands.

Tests: `floating.test.ts` (16), `selection-pill-placement.test.ts` (+4), e2e in `artifact-canvas-edit-polish.spec.ts` (6: a note at the top
with Edit and Delete pressed by real clicks; a block with room keeps it above; the pill is under the toolbar and neither is out of the pane;
a frame at the top; a frame taller than the pane; a phone with a tap and 44 px buttons). The old selection-pill spec asserted "the block's own
toolbar is above the block"; with this fix that holds only where there is room, so it now asserts the pill is clear of the toolbar and the
toolbar is on one side of the block (the one deliberate change to an existing assertion).

## 2. A File block is picked by a click, opened by a double click, Enter or its Open button

**Red:** 4 of 4 new specs failed on the unfixed tree: a click opened the file (the block was gone after it, so it was never "selected");
no Open button; no tooltip.

**What changed.**
- `NodeShell`: a new `open` prop (the other verb beside `edit`): a double-click anywhere on the block's box (not only on its row; the
  resize corners do not open it), Enter or F2 while it has focus (also on a board that cannot change: looking changes nothing; `activate`
  stays gated by `editable`), and an Open button before Delete in the toolbar (`canvas-node-open`, named "Open <file>", an `ExternalLink`
  icon). The button is the way in for a finger: on a zoomed-out phone board the row inside the block is a few pixels tall.
- `lazy-nodes.ts` `LazyShell.open`; `LazyNode` hands it to the shell; `fileShell` returns it instead of `activate`.
- `FileNode`: the row is plain content now (no `<button>`), with the tooltip `artifacts.canvas.file.hint` ("Double-click to open" /
  "Dupla kattintással megnyílik") and a small muted open mark at its end, only where the panel can open the file.
- Existing tests whose contract this changes: `chat-block-nodes.test.ts` (File section rewritten, +6), `artifact-canvas-wobble.spec.ts`
  (a wandering click picks the file, a wandering double click opens it; `press` takes a count), `artifact-canvas-blocks.spec.ts` (opens on a
  double-click).

## 3. On a phone the edit form is the app's sheet

**Red (390x844, a finger, a chart low in the pane):** Save visible 17% in the window (behind the board's toolbar); with the keyboard's
336 px taken off the page, 0%; at a board zoom of 0.4 the fields were 13.4 px (a phone zooms the page in on anything under 16 px) and
tiny on the screen; a tap on the page behind the form did not close it.

**Choice and why.** The brief offered "scroll it into view" or "the app's sheet". I took the sheet: the board's other phone surfaces
(Insert menu, comments, versions, download) are all `DialogShell` sheets, and a form drawn in the block is scaled by the camera, so
scrolling a block into view would still leave a form too small to read on a zoomed-out board.
- `BlockEditForm`: under 640 px (`isPhoneViewport`/`watchPhoneViewport`, like the app's other sheets) the same `<form>` and the same draft
  render inside `DialogShell` (`phonePresentation="sheet"`, `z-[150]` like `AnchoredPopover`, because the phone shell's backdrop is at 95),
  with Cancel and Save in the sheet's footer (Save is a submit of the form by its `form` attribute), 16 px fields (44 px input), a 180 px
  source. The title does not take the focus on open there (the keyboard would cover the sheet; Enter in the title saves). Wider windows keep
  the in-block form exactly as CV-B built it.
- What the block draws stays drawn behind the sheet: `ChartNode` and `MermaidNode` (whose form replaces their content) hand their content
  to the form as `children`; the other four kinds already kept it.
- Tests: `block-edit-form.test.ts` (+8 in a phone describe), `block-forms.test.ts` (+6: every one of the six kinds), e2e
  `artifact-canvas-edit-phone.spec.ts` (5: Save and Cancel whole in the window, 44 px, on top, a real tap saves; fields at zoom 0.4;
  the keyboard's shortened page; Cancel, Escape and a tap behind the sheet write nothing; a window that grows past a phone's leaves no sheet
  and no body lock behind). jsdom does not run the sheet's slide-out, so "the sheet is gone" is only asserted in the browser.

## 4. Safari's pinch (CV-C's concern 3) and the note's wheel (concern 4)

**Safari.** `wheel.ts` (`watchWheel`) now also listens on the board root for `gesturestart`/`gesturechange`/`gestureend`: one event zooms
about the pointer by `scale / lastScale` (one to one with the fingers) through a `zoomAbout` shared with the wheel pinch; the pointer is
`clientX/clientY` of the gesture (else the last pointer position, else the pane's middle); the page's own zoom is cancelled for all three
events over the whole board (its chrome too). Over a `nowheel` block or off the pane only the page zoom is cancelled. A touch that is
down means a finger's pinch (iOS Safari reports gestures for those too): nothing is zoomed or cancelled then, so touch screens are
unchanged; a mouse moving clears a touch flag that missed its `touchend`. Red: 8 of 10 new unit tests failed before the code (42 in the
file now). Playwright cannot drive Safari, so the logic is unit-tested with synthetic gesture events; one e2e sends the same event the
page's own way, only to check the wiring on the real board (a plain event with `scale`, the pointer, cancelled, zoom 1.5, the point under
the pointer stays).

**The note's wheel.** `InlineTextField`'s textarea dropped `nowheel` (it keeps `nodrag nopan`). Red: with the pointer on the words being
typed in, a scroll left the camera 40 px off and did nothing. Now a two-finger scroll pans and a pinch zooms from over the words, and the
field keeps the focus and what is typed. The keeper rule already hands a real scroller to the browser.

## 5. Size (production build, exact gzip bytes of what the editor loads that nothing else does)

| | base d69432e7 | mine 65fe72f0 | limit |
|---|---|---|---|
| editor first paint (exclusive closure) | 71,906 B | **72,437 B (+531)** | ceiling 72,704 (not moved): **267 B under** |
| `CanvasEditor` chunk alone | 63,682 B | 64,210 B (+528) | 65,000 |
| chat route first load | 542,891 B (+1,402 over its 541,489) | 543,068 B (+1,579) | 541,489 + 2,048 (not moved): 469 B under |

`npm run check:artifact-chunks` exits 0 (chunk count stays 12). History: after items 5, 4 and 2 the first paint was 72,027 (+121); the
toolbar's geometry then took it to 72,745, 41 B OVER the ceiling (importing `floating.ts` statically pulled the whole module, with
`rectsMeet` and `measuredBy`, out of the lazy parts and into the first paint). Loading `floating.ts` as a lazy part and reading the
toolbar's size with a small attachment instead of `measuredBy` took 308 B back. NodeShell therefore hangs the toolbar at the library's own
12 px gap (`offset={12}`) and `floating.test.ts` reads NodeShell's source to hold that number to `TOOLBAR_OFFSET`. The chat route's +177 B
is the one new string, in both languages. Everything else of this branch (the sheet, the gestures, the File mark) is in lazy chunks.

## 6. Gates (once, on the final tree 65fe72f0)

- `npm run check`: 0 errors, 17 warnings (the 17 pre-existing).
- `npx biome check src scripts tests`: clean.
- `npm test`: 1034 files passed, **17,254 passed**, 2 skipped, 0 failed (6 more tests, the six-kinds phone cases, were added after
  that run began; they pass in isolation, and so do their files).
- `npm run build`: exit 0, 32 `Unused CSS selector` + 2 `must have an ARIA role`, the same set as the base build. `npm run
  check:artifact-chunks`: exit 0 (numbers above).
- Playwright on port 5490, every `artifact*.spec.ts` plus knowledge, chat and conversation: **565 passed, 23 skipped, 0 failed** (44.5 min).
  Also run against the PRODUCTION build (`node build` on 5491): the 5 phone specs, the polish spec, wobble and CV-C's touchpad spec, 32/32.
- Fallow: 124 issues, 4 circular (the baseline), none new. `npm run check:migrations`: ok.

## 7. Screenshots (I looked at each; Hungarian; `scratchpad/w4/shots/cv-b2/`, retaken on the final tree)

- `1440-light-hu-toolbar-below-note.png`, `1440-dark-hu-toolbar-below-note.png`: a note at the top-left: toolbar (four tones, Edit, Delete)
  below it, slid in from the pane's left edge, the "Alfy megkérdezése / Megjegyzés" pill under the toolbar, nothing over anything.
- `1440-light-hu-toolbar-below-frame.png`: a frame at the top, Edit and Delete below it, pill under them.
- `1440-light-hu-file-toolbar-open.png`: a File block picked: Open and Delete above it (there is room), the row ends in the open mark.
- `390-light-hu-toolbar-below-note.png`: the same note on a phone: 44 px buttons whole in the pane, the pill stacked under.
- `390-light-hu-file-toolbar-open.png`: a File block on a phone, Open and Delete (44 px) above it.
- `390-light-hu-chart-selected.png`, `390-light-hu-edit-sheet-chart.png`: a chart low in the pane, then its form as the sheet over the dimmed
  board ("Szerkesztés", Cím, Diagram adatai (JSON), Mégse / Mentés pinned); `390-light-hu-edit-sheet-keyboard.png`: the same with the page
  shortened by the keyboard's 336 px, Save still whole.
What looking found: nothing to fix; the sheet's Save is the app's tinted-outline "positive" button, which reads pale next to Cancel but is
the shared look.

## 8. Concerns and open points

1. **Safari is untested on real hardware.** The gesture path is unit-tested with synthetic events and sends scale one to one. Worth the
   3-minute check on the owner's Mac: pinch over a note zooms about the cursor and the page does not zoom; pinch over the toolbar does
   not zoom the page. The iOS/iPadOS guard (a touch down means a finger's pinch) is by design, not observed. Over a `nowheel` block (a map,
   an App) a Safari pinch only cancels the page's zoom: MapLibre does not hear Safari's gestures, so the map does not zoom there.
2. The first paint has 267 B left under its ceiling (CV-C left 18, CV-B 0): a future change to the editor shell needs a recorded move or a trim.
3. **Desktop and tablet** keep the form in the block, so a block very low in a tall pane can still open its form with Save under the
   board's toolbar (the reader pans the board, or Ctrl/Cmd+Enter saves). The brief said phone; a reveal-by-camera for wider windows would
   have to answer TR-D1/D3's `followsPane`.
4. `BlockEditForm` still carries `nowheel` on the form itself (an in-block form): the wheel over its non-scrolling parts does nothing, as
   it did over a note before item 5. Not in the brief; the same one-class removal would do it if wanted (its source textarea scrolls natively).
5. On the phone sheet the title is not focused on open (the keyboard would cover it) and the sheet is plain "Szerkesztés"/"Edit" with no kind
   name. DialogShell sheets are fixed to the layout viewport, so on iOS an open keyboard still covers the footer (Enter in the title
   saves; this is the app's sheets in general, not new here and not checked on an iPhone).
6. A scroll or pinch with the pointer on the picked block's toolbar or the selection's pill (off the pane, like the zoom control) does
   nothing for the camera: a scroll then lands there after a pan moves the toolbar under a still pointer. CV-C's rule for the board's chrome.
7. I stopped my own production server with `pkill -f "node build"`, a broad pattern; the machine's other listening servers afterwards were
   the other agents' vite dev servers (5470, 5480, 5500), untouched, and no other `node build` was listening, but I should have used the pid.
8. The brief's "File block opens on a click" contract is gone on purpose; Enter and double-click work on a board that cannot change, the
   toolbar's Open does not exist there (no toolbar on a read-only board).

## 9. Hand-off

- `floating.ts`: `placeToolbar(block, pane, size, avoid)` returns `{ side: "above" | "below" | "over", rect }`; `TOOLBAR_OFFSET`.
  A new floating layer reports its rect through `BoardLayerApi` like `toolbarBox`.
- Board context: `toolbarShift` (`{ dx, dy, rect }` | null), `measureToolbar(size)`. `BoardLayerApi.toolbarBox`.
- `selectionPillPlacement(..., { toolbar })` and the `lift` it can answer with (the pill's `--lift` CSS variable).
- `NodeShell` `open`; `LazyShell.open`. Test ids: `canvas-node-open`, `canvas-file` (now a `div`, with `title`).
- `BlockEditForm` `children` (what the block draws, kept behind the phone sheet); `formId` (`$props.id()`) ties the footer's Save to the form;
  the in-block form is untouched at 640 px and up.
- `wheel.ts`: `watchWheel` takes gestures too; `zoomAbout` is internal. A block that handles the wheel itself still needs `nowheel`.
- e2e: `artifact-canvas-edit-polish.spec.ts` (wheel, Safari wiring, File, toolbar), `artifact-canvas-edit-phone.spec.ts` (the sheet).
