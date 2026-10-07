# CV-C report: a laptop's touchpad drives the board like Figma

Agent: Sonnet 5.5 (`claude-sonnet-5-5`). Worktree `art-cvc`, branch `fix/canvas-touchpad`, from `feat/artifacts` `f6617fa9`.
Status: **DONE_WITH_CONCERNS** (concerns at the end: 18 B of editor-ceiling headroom left, no real touchpad here, Safari).

## Commits (`f6617fa9..ffd1946a`, four)

| commit | what |
| --- | --- |
| `886be1e3` | `canvas/_lib/wheel.ts` + `wheel.test.ts`: the wheel policy as one lazy part (pure `nextCamera`, `wheelKeeper`, `watchWheel`) |
| `26835422` | wiring in `CanvasBoard.svelte`, the new e2e spec, the two existing specs that zoomed with a plain wheel now pinch |
| `2dab5a73` | AGENTS.md: one bullet in the Canvas subsection (who owns the wheel, what a block must do to keep it) |
| `ffd1946a` | biome formatting of the two files I added |

## The gesture map, as built

Every wheel event over the pane (a capture listener on the flow's `.svelte-flow__zoom`, installed by the lazy part when the board mounts) is taken by the board; the flow library never sees it.

| input (what the browser sends) | the board does |
| --- | --- |
| two-finger scroll (`deltaX`, `deltaY`), no key | pans both axes by exactly what the fingers did (screen px, any zoom) |
| mouse wheel notch (`deltaY` 100) | pans (it is the same event shape) |
| Shift + vertical notch (`deltaY` only) | pans across (x), even when the system did not turn it; Shift with an event that already says `deltaX` is not turned twice; a diagonal keeps its dominant direction |
| pinch (the browser's Ctrl + wheel, small fractional deltas) | zooms about the pointer, in proportion to the gesture: `zoom *= 2^(-delta * 0.014)` |
| Ctrl + wheel, Cmd + wheel with a mouse (`deltaY` 100) | the same formula with the delta capped at 12 px per event, so one notch is one step of about 12% (1.12x), never a jump to the limit; ten events of 1 px = one event of 10 px (proportional) |
| zoom at the limits (0.2, 2) | clamped, the camera does not move there |
| over the board's pane, any event it takes | `preventDefault` + `stopImmediatePropagation`: no page scroll, no browser page zoom, no history swipe |
| a pinch over the board's own chrome (toolbar, zoom chip, overview: off the pane) | the page's zoom is cancelled there too (listener on the board root; the overview keeps its own wheel zoom) |
| `overscroll-behavior: none` on the board root | set inline by the lazy part (see numbers: a declaration in the board's CSS would sit in the first paint) |
| a block under the pointer that has `nowheel` (map, App, text field being typed in) | left untouched, events reach it and the library ignores them; only a page zoom (Ctrl/Cmd) is cancelled |
| a block under the pointer that scrolls the way the wheel goes (`overflow` auto/scroll, more than 1 px of room on the dominant axis) | the browser scrolls it; the library is kept off it; Ctrl/Cmd over it still zooms the board |
| Space + drag, the Hand tool, the middle button, touch | unchanged (library); covered by specs |

Library props left on: `panOnScroll` (it is the nearest thing before the part has loaded, and **it is what debounces the library's move-end to the end of a gesture**, so `restingZoom`/the handles are sized once per pinch and not every frame; the new "one gesture" spec holds it). `zoomOnScroll` was not turned off (dead config once the part is loaded; it cost bytes).

## Red first (real wheel events, `page.mouse.wheel`, modifiers held with `page.keyboard`)

`tests/e2e/artifact-canvas-touchpad.spec.ts`, run on the unfixed tree before any change (Mac user agent, because the library branches on `isMacOs()` and the owner is on a Mac; Playwright's Desktop Chrome claims Windows): **8 failed, 1 passed** (the passing one is the zoom-limit guard):

- two-finger scroll `(60, 90)`: the board zoomed instead (x off by 121 px);
- mouse notch pans: zoomed (x off by 68 px); Windows/Linux variant the same;
- Ctrl + wheel notch (`deltaY` -100) on a Mac: zoom ratio **2.25x** (the library scales a pinch by 10 on a Mac), expected 1.05 to 1.3;
- `overscroll-behavior` on the board: `auto`, expected `none`;
- Hand tool + wheel: zoomed instead of panned.

After the change: **10 passed** (8 Mac-UA tests, 2 Windows/Linux). Observation worth knowing: the library's wheel events are stopped before they reach `window` (d3's `stopImmediatePropagation`), so the "every event is cancelled" spec observes with a capture listener at `window` and reads `defaultPrevented` after the dispatch (`setTimeout 0`).

## Tests

- New unit: `canvas/_lib/wheel.test.ts`, 31 tests: pan, line/page `deltaMode`, Shift cases, proportional zoom, the cap, anchor stays under the pointer, limits, `nowheel`, scrollers (jsdom with stubbed layout), listener behaviour (cancel, stop, library not called, disposer, chrome pinch, overscroll style).
- New e2e: `tests/e2e/artifact-canvas-touchpad.spec.ts`, 10 tests: two-finger scroll (both axes, small steps, over a block); notch + Shift (Mac and Windows/Linux); pinch about the pointer, smooth/proportional; Ctrl and Cmd notch bounded (Mac and Windows/Linux); limits; page never scrolls (all 8 events cancelled incl. a pinch over the toolbar, `overscroll-behavior` none, document not scrolled); one gesture = handles sized once (`--canvas-inv-zoom` changes <= 2 times over 60 events and ends at `1/zoom`); Space+drag and the Hand tool still pan.
- Updated (intended change of what a plain wheel does): `artifact-canvas-keyboard.spec.ts` ("a pan happens once per focus") and `artifact-tours-arrival.spec.ts` ("a camera that is theirs") zoomed with a plain wheel; they now pinch (Control + wheel). `artifact-canvas-pill.spec.ts` already used Control + wheel and passes unchanged (one capped step now instead of a jump to the limit).
- Not covered end to end: "a scroll inside a block that scrolls". **No block in the tree scrolls today** (the shell clips with `overflow: hidden`), so the rule is unit-tested only; it will matter for the editors CV-B adds.

## Lines I changed in `CanvasBoard.svelte` (for the merge with CV-B), 17 lines, three hunks

1. new lines **591-601**, right after `const ZOOM_STEP = 1.2;`: `const MIN_ZOOM = 0.2; const MAX_ZOOM = 2;` and `function takeWheel(board)` (dynamic `import("./_lib/wheel")` then `watchWheel(board, flow, MIN_ZOOM, MAX_ZOOM)`).
2. new line **1135**, on the board root `<div class="canvas-board" ...>`, between `onfocusincapture` and `style:--canvas-board-width`: `{@attach takeWheel}`.
3. **1173-1175**, the flow's props: `minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM}` replace `minZoom={0.2} maxZoom={2}`, and a new `panOnScroll` line above `{panOnDrag}`.

Nothing else in the file, and no style change (the `overscroll-behavior` is set by the part). I did not touch `touched`/`followsPane`/`fitted`: a wheel pan or zoom changes the camera, so the existing camera guard already stops the board following its pane (`onmoveend` reports `event = null` for these moves, which only matters before the library's first fit has ended).

## Numbers (this machine, base = `f6617fa9`)

| | base | mine | limit |
| --- | --- | --- | --- |
| editor first paint (exclusive closure) | **71,594 B gzip** | **71,662 B** (+68) | ceiling 71,680 (not moved; **18 B left**) |
| `CanvasEditor` chunk alone | 63,286 | 63,354 (+68) | 65,000 |
| chat route | 543,153 (+2,020 over its 541,133 baseline) | 543,160 (+2,027) | 541,133 + 2,048 (not moved) |

The chat route moves by chunk-name noise only (builds of my own varied 543,126 to 543,160; my code is not in its closure). First-paint growth is the loader (`import()` through Vite's preload wrapper, about 100 raw bytes), two constants, `panOnScroll` and the attach; I measured the first draft at +124 and cut it: no `.catch`, no destructuring of the import, no `panOnScrollSpeed`, plain constants (a `{min,max}` object made Svelte compile getters), and the `overscroll-behavior` set from the lazy part instead of the board's CSS. Build warnings unchanged: 32 `Unused CSS selector` + 2 `must have an ARIA role`.

## Gates (once, at the end, on the final tree)

- `npm run check`: 0 errors, 17 warnings (the pre-existing 17).
- `npx biome check src scripts tests`: clean (after formatting the two new files).
- `npm test`: 1028 files, **16,876 passed**, 2 skipped, 0 failed.
- `npm run build`: exit 0, warnings as above. `npm run check:artifact-chunks`: **exit 0** (numbers above).
- Playwright on port 5450, `artifact*.spec.ts artifacts-*.spec.ts knowledge chat conversation`: **526 passed, 23 skipped, 0 failed**, no retries (40.5 min). Three transient `page.goto: net::ERR_ABORTED` at login happened in iterative runs (a production build or a dev-server reload running beside the tests) and passed on rerun; none in the final full run.
- Fallow: **124 issues, 4 circular** (the baseline), none in my files.
- `npm run check:migrations`: ok.

## Screenshots (looked at each one), `scratchpad/w4/shots/cv-c/`

`01-fitted.png` (1440x900, light), `02-pinched-in-on-note-4.png` (14 Control+wheel events with the pointer on Note 4: 200%, Note 4 is still centred under the pointer, zoom chip and overview follow), `03-two-finger-scrolled.png` (10 scroll events of (14, 9): the board moved exactly (-140, -90) from the previous shot). No UI string or layout was added, so no Hungarian or phone shot applies; the phone specs (refit, keyboard) pass.

## Decisions and deviations

- **A custom handler, not just library props.** With `panOnScroll`/`zoomOnPinch` alone the library gets four things wrong for the brief: a Mac's Ctrl + mouse notch zooms 4x per notch; Cmd + wheel depends on a tracked key state (`zoomActivationKey`) rather than on the event; Shift + wheel is only turned on non-Mac systems (a CDP or Windows-style event stays vertical on a Mac); and a block that scrolls but lacks `nowheel` has its scroll cancelled. The part is lazy so the first paint pays about 68 B for all of it.
- **Zoom gain:** 0.014 octaves per px (about 1% per px, in line with other canvas editors) with a 12 px cap per event. The library's Mac gain was 0.02. I could not test a real touchpad (see concerns), so the numbers are a judgement; the cap makes the worst case a bounded 12% step per event, and both are two constants at the top of `wheel.ts`.
- The brief said `overscroll-behavior` on the board; it is on the board root, set by the lazy part (inline), because the CSS declaration would cost 17 B of the 86 B the editor had left.

## Concerns and hand-off

1. **Ceiling headroom is 18 B** (base had 86). CV-A and CV-B will add their own first-paint growth; the orchestrator will have to decide at the merge (move the ceiling with a recorded reason, or trim). The chat-route tolerance is also at +2,027 of 2,048, which is chunk-name noise on this machine (the base measured +2,020), not growth.
2. **No real touchpad was available.** Playwright sends exactly the events a browser dispatches (`wheel` with `deltaX/deltaY`, `ctrlKey`), but not a pinch's real delta profile, momentum after lift-off, or the OS swipe-to-go-back. A 3-minute check on the owner's Mac before release: two-finger scroll over a note pans; pinch zooms about the cursor and feels smooth; the back-swipe over the board does nothing; Shift + mouse wheel pans across; Cmd + mouse wheel zooms about 12% per notch; a pinch with the pointer on the toolbar does not zoom the page.
3. **Safari** sends a trackpad pinch as `gesturestart/gesturechange/gestureend`, not as a wheel; the board does not take those (a pinch there zooms the page). It needs a real Safari to test, so I did not build it blind (it could double-zoom if Safari sends both). It is the one known gap and is written in the AGENTS.md bullet.
4. **For CV-B / CV-B2:** `nodes/InlineTextField.svelte`'s textarea carries `nowheel`, so with the pointer on a note being typed in, the wheel does nothing (it never did anything there). Its textarea is sized to its text and never scrolls; with the wheel now meaning pan, dropping `nowheel` there would let the board pan from over a note being edited (my keeper rule already hands real scrollers to the browser). A new editor that scrolls (a diagram's source) needs nothing; a block that handles the wheel itself needs `nowheel`.
5. `touched` is not set by a wheel (only a pointer/focus is); the camera guard covers it. Noted in case TR-D3's wording is revisited.
