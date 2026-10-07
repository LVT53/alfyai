# Fix agent TR-D3 · a board stops re-fitting itself the moment the reader touches it

TR-D1 (merged; `wave-4/trd1-report.md`, "RE-FIT RULE") made `CanvasBoard` re-fit on every pane size change while the camera
still equals its last fit, so the tour card arriving or leaving never leaves a board mis-framed. The orchestrator found a
case that rule gets wrong: the app's viewport meta says `interactive-widget=resizes-content` (`src/app.html`), so on Android
Chrome **the on-screen keyboard resizes the page**. A reader who opens a board and taps a note to type — without panning
first — gets a board that re-fits (zooms and moves) as the keyboard opens, and again when it closes; anything else that
shortens the pane mid-work (the review bar, a sheet) does the same. A person working on a board must never have it move
under them.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-trd3`, branch
  `fix/canvas-refit-interaction` (from `dev` `61901f8e`: the tours, not yet deployed), e2e port **5490**, label `trd3`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/trd3-report.md`.
- Read first: `docs/plans/claude-at-home-2/wave-4/common.md` (+ the Wave 3 rules it points to) from the `art-base` worktree;
  TR-D1's report (the re-fit rule, its tests, and why it changed `artifact-canvas-floating.spec.ts:205`); AGENTS.md's Canvas
  subsection.

## The rule (orchestrator)

The camera becomes the reader's at their **first interaction with the board** — a pointer or touch down on the pane or a
block, a key the board handles, a selection, an edit, a drag — not only at a pan or zoom. Until then a pane size change
re-fits (the tour card arriving or leaving, a window resize, a bar appearing on a board nobody has touched); after it,
nothing re-fits by itself. The Fit button fits and makes the fitted camera the reference again, as today.

## Steps

1. **Red first, real input.** Playwright at 390×844 with touch: open a board, tap a note to edit it (a real tap), then
   shrink the viewport's height the way a keyboard does (`page.setViewportSize`), type, and restore the height: the camera
   (x, y, zoom) and the note's place on screen do not change. The same on desktop: click a block, resize the window, nothing
   moves. And the tour cases still hold: a 21-note board nobody touched shows every note with the card up and after it
   closes (TR-D1's tests stay green).
2. **The fix, smallest that holds**, in `CanvasBoard.svelte` (or wherever TR-D1 keeps `fitted`), with a unit test for the
   rule if it has a pure core. Revisit TR-D1's change to `artifact-canvas-floating.spec.ts:205` under the new rule and say
   whether it still applies.

Then the full gates once (Wave 3 rules' list; Playwright with every artifact suite including the tours'). Your final reply
is at most 10 lines: status, your model ID, the commit range, the rule as built in one sentence, a one-line gate summary
(with the chunk numbers), concerns.
