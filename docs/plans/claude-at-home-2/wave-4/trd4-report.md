# TR-D4 report: on a phone, the block being typed in stays in view when the keyboard opens

Agent TR-D4, model `claude-sonnet-5-5`. Worktree `.claude/worktrees/art-trd4`, branch `fix/canvas-keyboard-reveal` (from `feat/artifacts` `86a736b5`), e2e port 5490, label `trd4`.
Commits `86a736b5..761b292f` (seven). Nothing pushed, merged or rebased; no other branch or worktree touched; no subagent; no size ceiling edited.

**Status: DONE_WITH_CONCERNS.** The rule is built and proved with real touch, keyboard and wheel input, red first; every gate is green apart from the chat-route budget that was already over on the base
(see Gates). Concerns that matter are at the end: nothing was seen on a real phone, and the camera stays panned after the keyboard closes (as the rule says) and is saved with the next step.

## The rule as built

When a text field in a block has the focus and what the reader can see of the pane SHRINKS over it (the pane gets shorter, as an Android `resizes-content` keyboard does, or `window.visualViewport` does, as an iOS
overlaid keyboard does), the camera pans, once per opening of the keyboard, by the least distance along each axis that puts the block whole inside the visible part, clear of the board's measured toolbar, with a 16 px
margin (the field being typed in instead, when the block is too big for the room it has left); never a zoom, a 200 ms glide (instant under reduced motion), only on a coarse pointer, and nothing when the block is in
view, when the keyboard closes, or when a field takes the focus with nothing changing around it.

## What was wrong, measured on the unfixed tree (390x844 touch, keyboard 336 px, the six-note board of TR-D3)

Pane bottom 508, toolbar top 442. Note 6: top 624, 116 px below the pane, hidden; note 4: 461 to 508, behind the toolbar. The new spec on the unfixed `CanvasBoard.svelte` (the one effect removed): **8 of 9 failed**, each at "the
note is whole inside the pane and above the toolbar" (never true in 5 s); the desktop control passed (nothing moves on a desktop, before or after).

Fixed, same flows: the camera pans y 173.29 -> **-71.92** (-245.2 px) with x 32 and zoom 0.7409 unchanged; note 6 ends at 379 to 426, **16 px above the toolbar's top (442)**; typing leaves the camera alone; closing the
keyboard leaves it (note 6 at the same place, to 0.1 px). A 16-row checklist (taller than the room): camera y 16 -> -213.1, the row typed in (item 14) at 405 to 426, 16 px above the toolbar; the list itself is not whole in view,
by design. The pan starts about 120 ms after the resize (the 100 ms settle plus a frame) and ends 200 ms later (frame recorder: 121 -> 322 ms).

## What changed and where

- `src/lib/components/artifacts/canvas/_lib/keyboard-reveal.ts` (new, pure + one watcher): `visibleRoom(pane, visualViewport | null)`, `revealPan(block, field, room, toolbar, margin)` (the arithmetic: least distance per axis; the toolbar's box
  lowers the floor only where it stands under the block's columns once it has panned along x; a block taller or wider than the room it has left is swapped for the field; a field too big itself starts at the margin, or stays when it
  already fills the room; returns `{ x, y }` and nothing else, so it cannot zoom), and `watchKeyboardReveal(root, flow, isField)`: focusin/focusout (capture) on the board, a `ResizeObserver` on it, `visualViewport` resize and scroll; a
  100 ms settle (a keyboard that opens in steps gets one pan, to where it ends); `panned` is spent by a pan, and given back when the visible room GROWS (the keyboard went), which is how a field that keeps its focus after Android's Back key
  gets its second keyboard; a focus that arrived before the part loaded is read at attach.
- `canvas/group-parts.ts`: re-exports `watchKeyboardReveal` (the lazy entry a coarse pointer loads at once); header comment says what it holds now.
- `canvas/CanvasBoard.svelte`: ONE effect (5 lines): `if (!coarsePointer || !groupParts || !boardEl) return; return groupParts.watchKeyboardReveal(boardEl, flow, isTextEntry);`
- `AGENTS.md`: the TR-D3 bullet's "known gap" is replaced by a pointer, and a new bullet records the rule, the lazy placement, what is not verified, and the "once per opening" semantics.
- Tests: `keyboard-reveal.test.ts` (34 unit tests: arithmetic, the toolbar box in five situations, a taller block, a wider one, the watcher with fake timers, a fake `visualViewport`, reduced motion, re-arm, cleanup; six hand-made
  mutations of the module were each caught); `tests/e2e/artifact-canvas-keyboard.spec.ts` (9 tests, below); `artifact-canvas-helpers.ts` gained `PHONE`, `KEYBOARD`, `sixNotes`, `Camera`, `expectCamera`, `placeInPane`, `centreOf`,
  `openBoard`, `PAN_WAIT_MS` (moved from TR-D3's spec, which now imports them).
- No new string, no migration, nothing outside the Canvas editor, its tests and AGENTS.md.

### The e2e spec (real input; the keyboard is `page.setViewportSize` 336 px shorter)

1. the lowest note: double tap, shrink, the note whole above the toolbar with a 8 to 24 px gap, zoom and x unchanged, y up; type; close: camera and the note's place unchanged.
2. the row the toolbar sits over (note 4) is lifted clear of it.
3. a keyboard that opens in two steps (two sizes sent at once): one glide, monotone, to where it ends.
4. once per focus: after the pan the reader zooms with the wheel (the field keeps the focus), the keyboard gets 60 px taller: the camera stays.
5. a 16-row checklist: tap row 14, the row is brought in and the list is not whole in view.
6. a note inserted from the toolbar (it is made left of the pane's edge, off screen): brought in whole by the one pan, zoom unchanged.
7. with motion: more than 2 distinct camera positions (a glide). 8. reduced motion (`emulateMedia`): exactly 2 (start, end), instant. 9. a desktop: a window that shrinks over the note being typed in (premise asserted: the note IS covered) moves nothing.

## Changes to TR-D3's spec, and why (it is green: 6 tests)

The brief says TR-D3's refit spec stays green; it does, but two of its seven tests checked exactly what this change is meant to change, so they changed:
- "a board the reader tapped a note on to type stays where it is" tapped **note 4**, which the keyboard covers, so the camera now (rightly) pans for it. It taps **note 2** (top row, still in view) and waits `PAN_WAIT_MS` (a pan that was going to
  happen has happened by then) before it asserts the camera is the fit's. On the new code the old version failed, as it had to (note 4 is the one the keyboard hides).
- "a note inserted from the toolbar opens for typing without the board moving for the keyboard" is removed: the note is made off the left edge, so it now moves, by design; its other half (the board does not ZOOM out to take the new note in) is
  assertion 6 of the new spec. (It only kept passing on the new code because the test closed the keyboard before the 100 ms settle ended.)

## Gates (once, on the finished tree `761b292f`)

| Gate | Result |
|---|---|
| `npm run check` | 0 errors, 17 warnings (the baseline: ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1). The first gate run found one type error in my own unit test (a mock typed `vi.fn()`); fixed and re-run clean |
| `npx biome check src scripts tests` | clean, 2,491 files |
| `npm test` | 1,018 files + 1 skipped; **16,707 passed**, 2 skipped |
| `npm run build` | exit 0; 32 `Unused CSS selector` + 2 `must have an ARIA role` (the baseline) |
| `npm run check:artifact-chunks` (own step) | **exit 1, only for the chat route, which was over on the base**: the editor budgets pass (no FAIL line for them). Numbers below |
| Playwright, port 5490 | chat, conversation, knowledge and every artifact suite (44 files) in three parts: **506 passed, 23 skipped, 0 failed** after one rerun: the first test of part A, `artifact-app.spec.ts:235`, failed at its login `waitForURL` (15 s, the cold dev server: TR-D3's concern 6) and passed alone; the keyboard, refit and floating specs were re-run on the final commit: 18 of 18 |
| Fallow | 124 issues, 4 circular: identical to the baseline; none in my files; 0 clone instances in my files (the spec's first draft had 7: folded into `keyboardOpens`, `expectSmallMargin`, `expectLifted`) |
| `npm run check:migrations` | clean |

### Chunk numbers (same machine; the base is `86a736b5` built unchanged, 71,567 measured with the gate's own flags set to 1 byte so that it prints exact numbers)

| | base | with the change | |
|---|---|---|---|
| editor first paint (exclusive closure), ceiling 71,680 | **71,567** (113 B left) | **71,582** (98 B left); another build of the same source gave 71,594 | +15 (+27) |
| the editor chunk alone, cap 65,000 | 63,264 | 63,276 (63,273 and 63,282 in other builds) | +12 |
| chat route first load, baseline 539,608 (2,048 allowed) | 542,049 (+2,441: over on the base, as the brief said) | 542,086 (542,066 and 542,086 in two builds of the same source) | **+37** (+17) |

The editor grows only by the one effect: the arithmetic, the watcher and the `$lib/utils/motion` import live in the lazy `group-parts` part (the chunk that holds the watcher is 9.3 kB raw, 3.8 kB gzip), which a desktop never
loads. The chat route does not import any of it; its +17 to +37 B is build-to-build noise in the preload lists of chunk names (the same source gave two different sizes), so I did not move `--chat-baseline` and did not touch any ceiling.

## Screenshots (HU, 390x844 light; the keyboard is a 508 px tall viewport), each looked at

In `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/shots/trd4/` (throwaway spec kept as `../../zz-trd4-shots.spec.ts.txt`, the checklist variant; the six-note
variant was the same code with `sixNotes`; neither is in the tree):

- `phone-1-before-keyboard-note-6.png`: the six notes fitted at 74%; note 6 (right column, bottom row) open for typing, its tone picker above and the Alfy/Comment pill below; the toolbar below that.
- `phone-2-keyboard-open-note-6.png`: the 508 px page: the board has glided up, notes 3 and 4 above, note 6 whole at the same x with "Jegyzet 6" legible, 16 px above the toolbar; its pills sit above it (no room below), the zoom control has stepped aside by itself.
- `phone-3-after-keyboard-note-6.png`: the keyboard gone: note 6 at exactly the same place, nothing jumped; the pills have moved below it again, the zoom control is back.
- `list-1-before-keyboard.png` and `list-2-keyboard-open.png`: a 16-row checklist at 80%; row 14 focused; with the keyboard the list has glided up so that row 14 ("Tétel 14") is whole just above the toolbar and the rows above it fill the pane (the list's top is off screen, as it cannot fit).

## Deviations from the brief, with reasons

1. **The trigger is a shrink, not the focus.** My first build also looked at focus time. The Insert flow showed why that is wrong: a note made off the left edge was panned in x at focus, which spent the single pan, and the keyboard that opened a moment later then
   found it under the toolbar. The pan now waits for the visible part to shrink (what the brief's sentence says: "stops covering"), and a field that takes the focus with the keyboard already up is left alone.
2. **"Once per focus" is "once per opening of the keyboard".** A pan uses the opening up; the visible room growing again (the keyboard went) gives the same focused field the next one. Without it a field that keeps its focus after Android's Back key (a checklist row does;
   a note's textarea is unmounted on blur) would not be revealed the second time the reader taps it. A taller keyboard, or the reader's own zoom or pan, after a pan is never fought (assertion 4).
3. **Desktop = a coarse pointer.** `watchKeyboardReveal` is in the lazy part that only a coarse pointer loads, so "nothing happens on desktop" holds by construction (a window that shrinks over a note being typed in moves nothing: spec 9).
4. TR-D3's two tests, above.

## Concerns

1. **Not on a real phone.** Playwright's keyboard is a shorter viewport: it proves the Android layout (`interactive-widget=resizes-content`) and not an IME. The iOS path (a visual viewport that shrinks and scrolls while the page does not resize) is covered by unit
   tests with a fake `visualViewport` only. Worth one pass on the owner's Android phone (tap a bottom note, then a bottom checklist row, then Insert > Note) and, if there is one, an iPhone.
2. **The camera stays panned when the keyboard closes (the rule), and a camera is saved with the next step like any pan.** Reopening the board later shows the panned camera (a board with a stored camera is not fitted), Fit gives the fit back. If the owner dislikes it,
   the cheapest change is to remember the pre-pan camera and restore it when the room grows back, which is a decision for the orchestrator (it contradicts "the camera stays").
3. A keyboard that opens in two steps more than 100 ms apart gets the first step's pan only (the second is the same opening). Android Chrome resizes once and iOS's events are closely spaced, so this is not expected in practice.
4. A field that takes the focus when the keyboard is already up and is partly under the toolbar is left where it is: nothing changed around it (deviation 1).
5. Only the toolbar is an obstacle (as briefed). The zoom control steps aside by itself when a selected block is under it; the selection's pills place themselves (screenshot 2: above the note, over the row above, which is fine but covers a neighbour).
6. 98 B left under the editor ceiling (71,680): the next change to the editor's first paint needs a recorded raise.
7. The first Playwright test after a dev-server start sometimes times out in `login` or in opening the panel (seen once in the gate run, twice during development); it passes alone.

## Hand-off

- The one place the rule is decided: `canvas/_lib/keyboard-reveal.ts` (`revealPan`, `visibleRoom`; constants `REVEAL_MARGIN` 16, `REVEAL_PAN_MS` 200, `REVEAL_SETTLE_MS` 100). The one place it is wired: the effect in `CanvasBoard.svelte` after the touch-selection one, through `group-parts.ts`.
  A new floating layer that should be an obstacle goes into `revealPan`'s `toolbar` argument (make it an array) and is read in `look()`; do not add a second camera record or listener beside it (AGENTS.md says so).
- A lazy part still imports nothing the editor shares and no flow library; the watcher is handed `getViewport`/`setViewport` and `isTextEntry`.
- Specs: `artifact-canvas-keyboard.spec.ts` (+ helpers `keyboardOpens`, `expectSmallMargin`, `expectLifted`, `inView`, `watchCameraY`, local); shared in `artifact-canvas-helpers.ts`: `PHONE`, `KEYBOARD`, `PAN_WAIT_MS`, `sixNotes`, `openBoard`, `expectCamera`, `placeInPane`, `centreOf`.
- The keyboard in a test is `page.setViewportSize` only; reduced motion is `page.emulateMedia` after the page is up (`test.use({ reducedMotion })` did not reach the page here).

## Commits (`86a736b5..761b292f`)

```
42d83f23 Add the pan that brings a block back over the keyboard
8fb0dcb5 Pan the board so the note being typed in stays above the keyboard
0a3052bb Say in AGENTS.md how a board keeps the note being typed in above the keyboard
2e7ff375 Keep the reveal's helper types private and its e2e waits on one constant
68b01d36 Type the watcher test's mock and say each keyboard step once in the spec
f6995080 Give the watcher test's setViewport mock the signature it stands in for
761b292f Say once in the keyboard spec what a lifted camera is
```
