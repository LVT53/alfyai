# FX-F report: RC-F's four Important findings and its cheap Minors (the last pass before the deploy)

Agent FX-F, model `claude-sonnet-5-5`. Worktree `.claude/worktrees/art-fxf4`, branch `fix/artifacts-w4-final` (from `feat/artifacts` `7b969fd2`), e2e port 5510.
Commits `7b969fd2..5387738e` (nine). Nothing pushed, merged or rebased; no other branch or worktree touched; no subagent; no size baseline or ceiling moved; no new string.
Working tree clean at `5387738e`; my dev server on 5510 is stopped.

**Status: DONE_WITH_CONCERNS.** Every Important finding was red first with real input (pointer, keyboard, touch), is fixed, and is green; every gate is green. Concerns are at the end (none blocks the merge).

## The four Important findings

### IMP-1 · A freshly made board is fitted before a block has drawn its real size

- **Red** (`tests/e2e/artifact-canvas-fit-growth.spec.ts`, a board written the way Alfy writes it, flowchart with a width and no height; real model not needed): at 1440x900 / 1280x800 / 1100x800 docked the content's bottom was **1054 / 937 / 861 px against a palette top of 843 / 743 / 743**, and the camera did not move for the 6 s the test waited (RC-F's numbers, reproduced). 4 of 4 red.
- **Cause.** The only re-fit was an effect on `[boardWidth, boardHeight]`. Mermaid lays the diagram out a moment after the block was measured empty, so the block grew downwards after the one fit, and nothing looked at the blocks again.
- **Fix** (`CanvasBoard.svelte`, the one effect): it now also reads `nodes`, `held`, `pictures` and `fitted` (state now, so a fit that finished after the block had grown, and the end of a landing's or a picture's hold, are looked at), and fits again, instantly, when the room the blocks take (`flow.getNodesBounds(nodes)`) or the pane differs from what the last fit was told (`fitKey`, which is also what keeps the nodes the fit itself replaces from being a loop), under TR-D3's rule unchanged: `followsPane(camera, fitted, touched)`. Never after a touch.
- **Proof.** 1440/1280/1100: everything is in the room the fit leaves AND the first picture equals what the Fit button gives (camera compared to 0.05 px). The control types into the lowest note (a double click: a touch), which grows it; the camera stays (checked with a mutation: ignoring `touched` turns it red, x 77.09 -> 94.37). Neighbours green: refit, floating, keyboard, arrival (33 tests).
- **Not red on the old tree, kept out:** a second Alfy change landing on an open board under the review bar (RC-F's screenshot 08). My fake-provider run of it never landed the second change on the open board, on the unfixed tree either (see Concerns 3), so it could not discriminate; I did not ship it.

### IMP-2 · A press inside the panel's own popover closes the panel (Knowledge, and the chat's expanded panel)

- **Red** (`tests/e2e/artifact-panel-popover-press.spec.ts`, 1440x900, real clicks on the popover's padding): Knowledge, Download: the press closed popover AND panel. Chat expanded, Download and Versions: the press **docked** the expanded panel and left the popover floating (screenshot). RC-F's D2.1 said the chat host kept the panel open: its "panel open" check was any title on screen, and a docked panel has one. The brief's wording (both hosts) was right. 3 of 3 red.
- **Cause.** `handleDocumentPointerdown` answered only while the panel was the topmost layer *of the dialog stack*, which only a panel over a dialog is on (FX-B2's gate was `overDialog && !isTopmostDialog`).
- **Fix** (`DocumentWorkspace.svelte`, one line): `if (overDialog ? !isTopmostDialog(stackId) : hasOpenDialog()) return;`, Escape's own rule. A panel on a page now leaves a press to the popover (or a confirm dialog) above it.
- **Proof.** Press inside the popover keeps popover and expanded panel; Escape closes the popover only and hands focus back to Download; with nothing above it, the next outside press closes the panel (Knowledge) / docks it (chat). Unit: a panel on a page leaves a press to a layer above it and answers the next.

### IMP-3 · A block's edit form low on the board: Save off-screen, the palette over the form

- **Red** (`artifact-canvas-edit-reveal.spec.ts`, 1440x900, a flowchart and a chart at y 420 with a stored camera, selected by a click on the head, Edit by a click): Save/Cancel half under the palette ("something is over Save"), and a chart at the right edge under the palette (3 of 4 red; the "form already in view moves nothing" control was green and stays so).
- **Cause.** The form is drawn in the block at the board's zoom and makes the block taller; nothing moved the camera for it (CV-B2 gave phones a sheet, desktop kept the in-block form).
- **Fix.** When a form in the block opens (not on a phone: its sheet needs no help), `BlockEditForm` loads `revealForm` (`keyboard-reveal.ts`) a frame later and asks the board, through a new context member `panBy`, for ONE pan: TR-D4's arithmetic (`revealPan`, now taking several obstacles) brings the block (the union of the block and its form: an overlay form may reach past it) whole into the room the pane leaves, clear of the palette AND the overview, or just the form's buttons when the block is taller than that room; nothing when the form is where it can be used. 200 ms, instant under reduced motion, never a zoom. The zoom control steps aside from a selected block by itself and is deliberately not an obstacle.
- **Proof.** Mermaid and chart, at 1440x900 and a docked 1100x800 (8 tests): Save and Cancel whole inside the pane, topmost at their centres, the form clear of every drawn layer, a real click on Save keeps the title typed (read back from the stored board); the right-edge block (needs a pan along x too); mutation: dropping the overview from the obstacles turns the right-edge test red.

### IMP-4 · At 1100 docked the palette covers the zoom-out button

- **Red** (`artifact-canvas-floats-narrow.spec.ts`, the window swept 1000..1600 in both languages): palette meets the zoom control at 1100 (pane 713) in Hungarian (palette 517 px wide) AND English (429 px); at 1200 (pane 781) the Hungarian palette also meets it and the overview sits on the zoom control once the chip is lifted. 2 of 2 red.
- **Cause.** `STACK_ZOOM_BELOW` (the zoom stands over the palette instead of beside it) was 680; the Hungarian palette and the zoom (140 px + 12 px) meet below 517 + 2 x 152 = 821 px.
- **Fix.** `STACK_ZOOM_BELOW = 830` (derived in the constant's comment; the sweep spec guards it, so a button added to the palette fails a test, not a reader) and the overview steps up with the lifted zoom (`margin-bottom` 108 instead of 52 while stacked), because it is shown from 720 px and the two would sit on each other between 720 and 830. 1280 docked (836) is unchanged: palette and zoom side by side, 7 px apart.
- **Proof.** At every width in both languages: no two of palette / zoom / overview meet, zoom-out, zoom-in and fit are topmost at their centres, and a real click on zoom-out at 1100 zooms out. Mutation: dropping the overview step turns it red at 1200.

## FX-B2's (b) and the Minors

- **MIN-4 (taken, required).** After a ring press, focus was on the dialog's scrim button, not the row that opened the panel: the panel hands focus back at the press, then the browser focuses the pressed button. `DialogShell`'s scrim now cancels the focus a mousedown would give it (3 lines); `project-panel-over-dialog.spec.ts` gained the test (red, then green: the row is focused, the dialog is on top, Escape closes it). Unit: the scrim's mousedown is cancelled.
- **MIN-1 (taken).** On a phone with the keyboard up the selection pill overlapped the node toolbar by 4 px: the pill hung a fixed 60 px over the block's top, the room for a 36 px toolbar, and a finger's is 52 tall. `selectionPillPlacement` now says how much higher than 60 px (`lift`, the variable the pill below a block already used) when the toolbar above the block is taller. Red with RC-F's numbers (pill 266.6..318.6 against toolbar 314.6..366.6), green with a 6 px gap. Unit + `artifact-canvas-pill-phone.spec.ts`.
- **MIN-2 (taken).** The opened-documents rail named a Canvas "UNSUPPORTED" (the preview's file type); an item of the artifact family that is not a file is named by its kind (`artifacts.type.*`, existing strings). Unit, red on HEAD's rail.
- **Left, with reasons.** MIN-3 (no version pill from Knowledge / the Files dialog): the version number reaches the header only through the chat's list; plumbing, not a few lines. MIN-5 and MIN-6 (Alfy repeats placement numbers; "next to Y" moved three blocks): a prompt and placement decision that needs the live eval. MIN-7 (dangling separator in the phone header's meta line): the clean fixes either force a two-row header at every phone width or clip the version pill's focus ring; cosmetic. MIN-8 (restored panel for a deleted Document under a live header): panel state, not a few lines. MIN-9 (Hungarian "Diagram" / "Ábra"): a terminology decision for the owner. MIN-10 (size budget): numbers below.

## Size (production build, exact gzip bytes, same machine; the base is `7b969fd2` built unchanged)

| | base | mine (`5387738e`, src identical to `094f3892`) | limit |
|---|---|---|---|
| editor first paint (exclusive closure) | 72,440 B | **72,559 B (+119)** | ceiling 72,704 (not moved): **145 B left** |
| `CanvasEditor` chunk alone | 64,210 B | 64,333 B (+123) | 65,000 |
| chat route first load | 543,822 B | **543,858 B (+36)** | baseline 542,004 + 2,048 = 544,052 (not moved): **194 B left** |

Where the editor's +119 is: the effect (+50), the stacking constant and the overview's margin (~+14), the context's `panBy` (~+55). The form's arithmetic, `revealForm` and the union are in the lazy `keyboard-reveal` part, loaded only when a form opens. The chat route's +36 is DocumentWorkspace's guard, the scrim's handler and the rail's label (no string added). `npm run check:artifact-chunks` exits 0.

## Gates (once, on the finished tree)

| Gate | Result |
|---|---|
| `npm run check` | 8,411 files, **0 errors, 17 warnings** (the baseline) |
| `npx biome check src scripts tests` | clean, 2,549 files |
| `npm test` | 1,035 files + 1 skipped; **17,408 passed**, 2 skipped |
| `npm run build` | exit 0; 32 `Unused CSS selector` + 2 `must have an ARIA role` (the baseline) |
| `npm run check:artifact-chunks` (own step) | **exit 0**, numbers above |
| Playwright, port 5510 | 727 tests in 68 files (every `artifact*` and `artifacts-*` spec, knowledge, chat, conversation, project-panel-over-dialog, project-files, project-page, dialog-focus-trap, home-projects, instructions-dialog, search-modal, settings-admin, admin-users-campaigns, auth, login): **704 passed, 23 skipped, 0 failed** (44.8 min + 3.4 min); after the last, test-only refactor the 17 tests of the four specs it touched were re-run: 17 passed |
| Fallow | **124 issues, 4 circular** (the baseline); no clone instance in any file this pass added (the first run found four clone groups in my specs, folded into shared helpers) |
| `npm run check:migrations` | clean |

## Screenshots (`scratchpad/w4/shots/fx-f/`, each looked at; "before" are the red runs' failure frames and one run with the two constants reverted)

- IMP-1: `imp1-before-{1440x900,1280x800,1100x800}-docked-en.png` (flowchart cut off at the bottom, a band of nothing above: 1440: content 295..1054 in a pane that ends at 900) and `imp1-after-{1440x900,1280x800,1100x800}-docked-hu.png` (the whole board in view at 78% / 65% / 65%, clear of the palette; at 1100 the zoom is above the palette).
- IMP-2: `imp2-before-1440x900-knowledge-after-press-in-download-popover-en.png` (panel and popover gone), `imp2-before-1440x900-chat-expanded-after-press-in-download-popover-en.png` (docked, popover orphaned), `imp2-after-1440x900-{knowledge,chat-expanded}-after-press-in-popover-hu.png` (expanded panel and the "Bécsi jegyzetek letöltése" popover both there).
- IMP-3: `imp3-before-1440x900-{mermaid-low,chart-low,chart-right}-en.png` (buttons half under the palette), `imp3-after-1-selected-hu.png` (the flowchart low, selected), `imp3-after-2-form-open-hu.png` (form whole, Mégse / Mentés 16 px above the palette, toolbar and pill above it).
- IMP-4: `imp4-before-{1100x800,1200x800,1280x800,1440x900}-docked-hu.png` (1100: the palette over "-"; 1200: "-" covered, the overview right over the zoom) and `imp4-after-*` (1100 and 1200: the zoom above the palette's right end, the overview above it; 1280 and 1440 unchanged).
- MIN-1: `min1-after-390x508-keyboard-up-hu.png` (pill and node toolbar stacked with a gap).

## Concerns and open points

1. **RC-F's D2.1 log misled** (see IMP-2): "panel open" counted a docked panel. Worth knowing for any later walk: assert `.workspace-shell-expanded`, not the title.
2. **`STACK_ZOOM_BELOW = 830` is a number tied to the Hungarian palette's width (517 px).** English lifts the zoom a little earlier than it has to (it needs 733). At the owner's 1280 docked (836) the palette and the zoom are 7 px apart, unchanged; a measured rule would adapt, at about 120 B of the 145 B left in the editor. The sweep spec is the guard.
3. **Observation, not mine and not fixed:** with the fake provider (the `unsaved-step` spec's harness), a SECOND `edit_artifact` while the first is pending review left the card at "v3, 2 changes to review" but the open board never showed the second change within 45 s; identical on the unfixed tree. RC-F's live run did land its second change, so I could not tell a harness artefact from a real gap in the live landing path. Repro: board open and untouched, send two edits through the composer. Worth a look before concluding the live landing is fully sound.
4. **The camera stays where the form's reveal left it** when the form closes (TR-D4's rule for the keyboard; Fit gives the fit back), and a pan is saved with the next step like any pan.
5. **The scrim change is in `DialogShell`, so it is for every dialog:** a press on a scrim no longer moves focus to the scrim button. The shared suites that use it (dialog-focus-trap, instructions-dialog, settings-admin, admin-users-campaigns, search-modal, auth, login) are green.
6. **No real tablet or phone seen:** the form's reveal runs on any pointer (a coarse pointer at 640 px and up draws the form in the block), proven by desktop windows only; the phone sheet is untouched.
7. **Dev-server flake, as TR-D3 recorded:** the first navigation after a source or file change in the worktree often fails with `net::ERR_ABORTED` at `page.goto("/")` (it hit me about ten times; a warm request first avoids it; every one passed alone). A `vite build` running beside the dev server in one worktree makes it persistent: restart the dev server after the build.
8. **Headroom:** editor 145 B, chat route 194 B. The next change to the editor's first paint needs a trim or a recorded raise.

## Hand-off

- `CanvasBoard.svelte`: the fit effect (`fitKey`, `fitted` as state), `STACK_ZOOM_BELOW` and the overview's margin, the context's `panBy`.
- `_lib/keyboard-reveal.ts`: `revealPan(block, field, room, toolbar | toolbars[], margin)`; new `revealForm(form)` returning `{ x, y, ms } | null` (loaded by `BlockEditForm`, not by `group-parts`).
- `_lib/board-context.ts`: `panBy?(pan, ms)`. `_lib/selection-pill-placement.ts`: `lift` for the side `above`.
- Tests: `artifact-canvas-fit-growth`, `-edit-reveal`, `-floats-narrow`, `-pill-phone`, `artifact-panel-popover-press` (new), `project-panel-over-dialog` (+1); shared in `artifact-canvas-helpers.ts`: `TRIP_FLOWCHART`, `TRIP_COSTS`, `screenBoxOf`, `boxesMeet`, `isTopmostAtCentre`.
- AGENTS.md: the four Canvas / panel bullets say what changed (one commit).

## Commits (`7b969fd2..5387738e`)

```
f3f029c0 A board that was fitted before a block drew its real size is fitted again, until the reader touches it
ca17b494 Keep the board's palette off the zoom control at the widths a docked panel gives it
adc68ba4 A block's edit form opens where it can be used: the camera pans, once, to bring it in view
df6ac61f A press inside the panel's own popover is the popover's, on a page as over a dialog; a ring press leaves focus on the row
7f13f95d The selection's pill clears a toolbar as tall as a finger's, not only one as tall as a pointer's
3e2a3742 The opened-documents rail names a Document, an App and a Canvas by their kind
1d47bc03 Say in AGENTS.md what the last pass changed: the fit follows blocks, the zoom stacks at 830, the form is revealed, one press one layer
094f3892 Reveal the form itself, not only its block, and prove the reveal at 1100 as well as 1440
5387738e Keep the new specs free of clones: one board's constants and one set of screen-box helpers
```
