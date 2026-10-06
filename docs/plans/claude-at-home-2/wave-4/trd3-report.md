# TR-D3 report: a board stops re-fitting itself the moment the reader touches it

Agent TR-D3, model `claude-sonnet-5-5`. Worktree `.claude/worktrees/art-trd3`, branch `fix/canvas-refit-interaction` (from `dev` `61901f8e`), e2e port 5490, label `trd3`.
Commits `61901f8e..ef95d3d3` (four). Nothing pushed, merged or rebased; no other branch or worktree touched; no subagent.

**Status: DONE_WITH_CONCERNS.** The rule is built and proved with real input, red first; every gate is green. The one concern that matters is at the top of
"Concerns": with the camera staying put, a note lower than the keyboard's top edge is hidden behind the keyboard while the reader types in it.

## The rule as built

The camera stays the fit's, and a pane that changes size re-fits the board, only until the reader's first touch of it: a pointer or touch down anywhere in the board
or the focus entering it (two capture listeners on the board's root set `touched`); nothing but the Fit button clears the flag, and Fit fits and is the reference
again until the next touch. The camera guard TR-D1 built stays beside it, for what moves the camera without a press in the board.

## What was wrong, measured on the unfixed component (final spec, `tests/e2e/artifact-canvas-refit.spec.ts`)

Every flow is real input: a finger's double tap (`page.touchscreen.tap` twice opens a note's textarea: it fires `dblclick`), `locator.tap()`, `page.mouse.click`,
Tab and Enter, `page.keyboard.type`; the keyboard is `page.setViewportSize` shorter by 336 px, which is what `interactive-widget=resizes-content` does to the page.
The note's place is measured from the board's own top left, because on a desktop the panel is right anchored and moves with the window.

| Test | Unfixed component | Fixed |
|---|---|---|
| phone 390x844, double tap note 4, keyboard opens | camera x 32 -> **83.25**, y 173.3 -> 40, zoom 0.741 -> **0.508** (the board zooms out and moves), back when it closes | camera and note identical to 0.1 px open, typing and closed |
| phone, tap on empty ground, no pan | same | unchanged |
| phone, Insert -> Note from the toolbar (opens for typing), keyboard opens | x 32 -> **147.06** (the re-fit also takes in the new note) | unchanged |
| desktop, click a block, window 1440x900 -> 1180x640 -> back | x 252.5 -> **223.37** | unchanged both ways |
| desktop, Tab through the toolbar to a note, Enter, type, resize | same | unchanged |
| desktop, Fit hands the camera back | red at its first step (touched board followed the window) | Fit follows the window again, and the next touch stops it |
| control, phone, a board nobody touched | follows the pane (zoom drops, returns) | **the same: passes before and after** |

All six tests that touch the board were red on the unfixed component, each at a camera assertion (the control passed); the red/green runs above are of the final spec, swapping only
`CanvasBoard.svelte` for its `HEAD` version and back. My first runs also showed two bugs in my own tests, fixed before those numbers: a duplicate `artifact-panel-title` test id (the hidden
mobile shell has one too) and a note measured in viewport coordinates on a desktop whose panel moves with the window.

## What changed and where

- `src/lib/components/artifacts/canvas/_lib/board-model.ts`: **`followsPane(camera, fitted, touched)`**, the pure core: `!touched && fitted !== null && sameCamera(camera, fitted)`.
- `src/lib/components/artifacts/canvas/CanvasBoard.svelte`: `let touched = false` beside `fitted`; the re-fit effect asks `followsPane(...)` in place of `fitted && sameCamera(...)`;
  `onpointerdowncapture` and `onfocusincapture` on the board's root set `touched`; the Fit button's handler clears it before `fitBoard`.
  Why these two events: a capture listener on the root runs before anything the library does with the press (d3 stops propagation lower down); `focusin` also covers a
  Tab, a script moving the focus into a note, a screen reader's cursor and an App block's frame. A key reaches the board through the focus, so no `keydown` listener.
- `AGENTS.md`: the Canvas paragraph (TR-D1's "the board is fitted again...") rewritten for the rule, the reason (the viewport meta), and the known gap below; the tour paragraph says
  "a Canvas that the reader has not touched re-fits".
- Tests: `tests/e2e/artifact-canvas-refit.spec.ts` (7 tests), `board-model.test.ts` (+4 for `followsPane`: untouched at the fit; touched at the fit; moved camera, touched or not; no fit),
  `settledCamera` moved into `artifact-canvas-helpers.ts` and used by TR-D1's arrival spec too (it was 17 duplicated lines; Fallow flagged the clone).
- No new string, no migration, nothing outside the Canvas editor, its tests and AGENTS.md.

## TR-D1's change to `artifact-canvas-floating.spec.ts:205`: it still applies

It moved the drag's aim from 20 to 40 px under the zoom control. Under the new rule the review bar still arrives ~30 ms after a board with a pending Alfy change opens, which is
before the reader's first touch (the drag), so the untouched board still follows the bar and sits where the shortened pane puts it. With the original aim of 20 the test fails
deterministically on the new rule too (2 of 2 runs: "the note is under where the control is"). I left the 40.

## Gates (once, on the finished tree, `ef95d3d3`)

| Gate | Result |
|---|---|
| `npm run check` | 0 errors, 17 warnings (the baseline: ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1) |
| `npx biome check src scripts tests` | clean, 2,484 files |
| `npm test` | 1,015 files + 1 skipped; **16,609 passed**, 2 skipped (run before the last two commits, which change a comment and e2e helper files vitest does not run) |
| `npm run build` | exit 0; 32 `Unused CSS selector` + 2 `must have an ARIA role` (the baseline, nothing new) |
| `npm run check:artifact-chunks` (own step) | **exit 0.** Editor first paint **71,572 B of 71,680** (108 B left). Same machine, unfixed component: 71,539 B, so the rule costs +27 to +33 B gzip (hash noise between builds). Chat route 541,615 B, +2,007 of 2,048 (unfixed: 541,604; my change is in the lazy editor chunk, the difference is hash noise); the baseline 539,608 is unchanged and so is the 2 KiB budget's 41 B of headroom |
| Playwright, port 5490 | chat, conversation, knowledge and every artifact suite, 521 tests in 43 files: **498 passed, 23 skipped, 0 failed** (see the note below), including TR-D1's 11 arrival tests, the three tours specs, the floating spec and my 7 |
| Fallow | 124 issues, 4 circular: identical to the baseline; nothing added |
| `npm run check:migrations` | clean |

Playwright ran in two parts because my own dev server (started with the default 30-minute background limit) was killed by the harness mid-run, at test 298, and every test after
it failed in ~100 ms with the server gone. Part 1: the files before `artifact-canvas.spec.ts`, 239 passed + 23 skipped, 0 failed. Part 2, on a fresh warmed server: `artifact-canvas.spec.ts` and every file
after it (24 files), **259 passed**, 0 failed, 15.3 min. The union is the full set once. The known `settings-admin.spec.ts:411` failure is outside the gate set.

## Screenshots (HU, 390x844 light; the keyboard is a 508 px tall viewport), each looked at

In `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/shots/trd3/` (throwaway spec kept as `../../zz-trd3-shots.spec.ts.txt`, not in the tree):

- `phone-after-1-fitted.png` (and `-before-1-`): the board of six notes fitted at 74%, all six clear of the toolbar. Identical before and after, as it should be.
- `phone-before-2-keyboard-open-note-6.png`: the unfixed board with the keyboard open: zoomed out to 51% and moved, note 6 (being edited) visible above the toolbar. This is the owner's bug.
- `phone-after-2-keyboard-open-note-4.png` and `-note-6.png`: the fixed board with the keyboard open: notes 1 and 2 exactly where they were (the board did not move), **but note 4 sits under the toolbar and its pill, and note 6 is entirely below the pane** (see Concerns).

## Concerns

1. **A note below the keyboard's top edge is hidden while the reader types in it. This is the price of the rule as written, and I did not build a fix.** Measured on the six-note board at 390x844 with the
   keyboard at 336 px (pane bottom at 508): note 6 top 624, bottom 671, i.e. 116 px below the pane; note 4 spans 461 to 508, behind the toolbar and the selection pill. The unfixed board showed every note
   because it zoomed the whole board out (which is what the owner saw move). The browser cannot rescue it: Android Chrome scrolls a focused field into view through every scrollable ancestor, but
   `@xyflow/svelte`'s wrapper undoes any scroll of its own (`Wrapper.svelte`, `wrapperOnScroll`: "preventing viewport from shifting when nodes outside of it are focused"), so the note stays where it is.
   Read from the library's source, not seen on a device. AGENTS.md records this as the known gap. **Suggested follow-up if you want it** (a separate step, because it moves the camera under the reader once,
   which the brief's sentence forbids): when a block's text field has the focus and the pane then shrinks (or the field takes the focus into a pane that already hides it), pan the camera, never zoom, by the least
   amount that puts the block inside the pane clear of the toolbar inset (88 compact / 112) and of its own pill above it; once per focus; instant under reduced motion. About 20 lines in `CanvasBoard.svelte`,
   +150 to 250 B gzip against the 108 B left, so a recorded ceiling raise to about 71,900, and one phone e2e (tap a bottom note, shrink, the note is inside the pane and the camera's zoom is unchanged).
2. **Not on a real Android keyboard.** Playwright's keyboard is a shorter viewport: it proves the layout effect (the one `interactive-widget=resizes-content` has) and not the IME. Worth one pass on the
   owner's phone: tap a note near the top (board must not move; typed text visible), then a note near the bottom (the gap above).
3. A board nobody has touched still re-fits when a text field **outside** the board takes the keyboard (the comment composer in the phone sheet, for instance): the rule is "the first touch of the board". It re-fits to the
   shorter pane and back to the same frame when the keyboard closes, behind the sheet. Not built; the same two listeners could be given to the panel's sheet if you want it.
4. A Tab that merely passes through the board's toolbar is a touch (the focus entering it). A keyboard reader who then wants the board to follow a window resize presses Fit.
5. 108 B of headroom in the editor's first paint, so the next editor change needs a recorded raise.
6. The dev server's first navigation after a source edit or a restart sometimes fails with `net::ERR_ABORTED` at `page.goto("/")` (seen on the first test of five runs; passes alone). Not mine.

## Hand-off

- `followsPane` (`canvas/_lib/board-model.ts`) is the one place the rule is decided; `touched` lives in `CanvasBoard.svelte` next to `fitted`, set by the root's capture listeners, cleared only by `onfit`. A new way of
  fitting goes through `fitBoard`; a new way of touching the board needs nothing (anything inside the root is a touch). Do not add a second record of the camera or a resize listener.
- `settledCamera(page)` in `tests/e2e/artifact-canvas-helpers.ts`; `tests/e2e/artifact-canvas-refit.spec.ts` for the phone and desktop flows (`placeInPane`, `tabTo` are local).
- Chunk baseline: editor 71,572 / 71,680, chat route baseline unchanged (539,608).

## Commits (`61901f8e..ef95d3d3`)

```
d7c7d98f A board follows its pane only until the reader touches it
b164c0a4 Say in AGENTS.md when a board stops following its pane
0f045e4d Keep one settledCamera helper for the two camera specs
ef95d3d3 Make the board's follow-the-pane comment match the two listeners
```
