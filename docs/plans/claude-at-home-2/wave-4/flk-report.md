# FLK report: why `artifact-canvas-undo.spec.ts:418` fails one run in four

Model: claude-sonnet-5-5. Worktree `.../worktrees/flk`, branch `fix/canvas-undo-regression`, from `dev` `b179456b`.
Commit range: `b179456b..08c29097` (one commit, test code only: `tests/e2e/artifact-canvas-undo.spec.ts`, +11 / -1 lines).
Status: DONE.

## Verdict in five lines

1. The failure is a race between the test's pace and one frame. After a Redo (or any undo) the board's blocks are
   `visibility: hidden`, so they take no pointer, for the 5 to 8 ms until the next rendering update has measured them
   again. The delete scene started 6 to 10 ms after the Redo that ended the scene before it, so in some runs its click
   landed on the empty board (`.svelte-flow__pane`): nothing was picked, `Delete` deleted nothing, the card stayed.
2. Nothing moves and nothing reloads between `nodeBox` and the click. The hypotheses in the brief do not hold: see
   "What the brief guessed" below.
3. No line of `ca145566` (or any sampling commit) is the cause. The same test, run now with the same command, fails 10 of
   40 at `27274c0e` (before the merge) and 6 of 40 at `b179456b`. The bisect's 14 / 14 at `27274c0e` was a streak (0.75^14
   is under 2 %) or a slower runner (see "Why tracing hides it").
4. The product is right: the blocks come back inside the same rendering update that follows, so no frame is painted with
   them hidden, and a person cannot click within 8 ms of pressing Undo. The fix is in the test: wait until the card is
   what the click point hits, with the existing `expectTopmost` helper, then click.
5. Proof: 40 / 40 on the fixed tree (it failed 10 / 40 before), the whole spec 11 / 11, all gates green.

## Evidence

All runs: `-g "on a Mac"`, `--retries=0`, one worker, e2e port 5490, the machine shared with other agents' runs
(load 6 to 8). Results are in `w4/flk-probe/<name>/run.log`.

| tree | tracing | runs | failed |
|---|---|---|---|
| `b179456b` | `--trace on` | 30 (`head-a` 10, `head-b` 20) | **0** |
| `b179456b` | off | 20 (`head-c`) | 3 (repeats 6, 14, 19) |
| `b179456b` + in-page recorder | off | 20 (`probe-a`) | 3 (repeats 4, 9, 14) |
| `b179456b` + recorder that also hit-tests every frame | off | 20 (`probe-b`) | 0 (the recorder's own cost slows the page) |
| `27274c0e` (dev before the merge) | off | 40 (`old-a`) | **10**, all the same assertion (`:457`, `toHaveCount(0)`, received 1) |
| `b179456b`, click without `nodeBox`'s two round trips | off | 12 (`fast-nofix`) | **7** |
| same flow, `expectTopmost` before the click | off | 12 (`fast-fix`) | **0** |
| `08c29097` (the fix), the test as committed | off | 40 (`fixed-40`) | **0** |
| `08c29097`, the whole `artifact-canvas-undo.spec.ts` | | 11 tests (`whole-file`) | 0 |

### What the failing runs show

A recorder injected with `page.addInitScript` (copy: `w4/flk-probe/zz-flk-probe.spec.ts.txt`; it logs trusted pointer
and key events with their targets, every `fetch` with its body's node ids and the answer, and per frame the blocks, their
`visibility`, the card's rect, the save status, the focused element and the banner) gave, for each run:

- In every failing run the delete scene's `pointerdown` target is `div.svelte-flow__pane`; in every passing run it is
  `div.canvas-node__head<list-pack>`. After the click the sampler still shows the card at the same rect, the save status
  and the node count unchanged: the click picked nothing, `Delete` had nothing to delete (`prevented: false`, no
  `fetch` for it; the debounced save at +800 ms carries the unchanged board).
- The gap from the last Redo click to the next click decides it, with a clean threshold:

  | | gap Redo click -> Delete key |
  |---|---|
  | failing (3 in `probe-a`) | 8.8, 9.6, 9.7 ms |
  | failing (7 in `fast-nofix`) | 6.3 to 8.7 ms |
  | passing (`probe-a`, 17 runs) | 11.2 to 16.2 ms |
  | passing (`fast-nofix`, 5 runs) | 10.5 to 11.8 ms |
  | passing (`probe-b`, 20 runs) | 11.5 to 16.1 ms |
  | with `expectTopmost` (`fast-fix`, 12 runs) | 21.4 to 33.2 ms |

- Why the card is not hit: `CanvasBoard.restore()` (called by every undo and redo) assigns fresh node objects
  (`toFlowNodes`) with no `measured`. `@xyflow/system`'s `adoptUserNodes` rebuilds each internal node with
  `measured: { width: undefined, height: undefined }` ("if user re-initializes the node or removes `measured` ... we reset
  ... so that the node gets re-measured"), and `@xyflow/svelte`'s `NodeWrapper` sets
  `style:visibility={hasDimensions ? 'visible' : 'hidden'}` (a frame has an explicit width and height, so it stays
  visible; the sticky notes and the checklist go hidden). The per-frame sampler of `probe-b` shows it directly after
  every one of the four restores of a run: `vis=vNhhh hit=div.svelte-flow__pane` at the next frame, `vis=vNvvv
  hit=div.canvas-node__head<list-pack>` at the one after. A hidden element is not hit-tested, so the point falls through
  to the pane. `nodeBox` reads `boundingBox()`, which is the same rect for a hidden element, so the test could not tell.
- `w4/flk-probe/zz-flk-probe2.spec.ts.txt` + `probe2.mjs` time it with a mutation observer and `requestAnimationFrame`
  over 12 toolbar undo / redo clicks: the blocks go hidden 1.1 to 1.9 ms after the click and come back 4.6 to 7.1 ms
  later, every time 1.2 to 1.5 ms after the one `requestAnimationFrame` callback that ran while they were hidden, that is
  inside the same rendering update (rAF, layout, ResizeObserver, Svelte flush) before it paints. So the reader never sees a
  frame with the blocks hidden: no flash, nothing moved under a pointer, only a 5 to 8 ms window in which a pointer event
  would be hit-tested against hidden blocks.

### What the brief guessed, and what the recording says

- "Passport is ticked (1/2), so the click landed on its checkbox": the seed is `{ id: "i1", text: "Passport", done: true }`
  (`seededBoard()`, line 40 of the spec), so 1/2 is the board as seeded and unchanged. The click never reached the card.
- "A late banner moves the layout": the banner is in every run, passing or failing. It appears 278 ms after the chat page
  loads (`banner=true` at t = 278 ms), 2.5 s before the panel opens and 7 s before the click. The board's rect is
  `[444, 121, 836, 600]` from 160 ms after it is drawn (the panel's slide-in) to the end in both kinds of run, and the
  card's rect is `(860, 357)` throughout. No hydration, reload, banner or re-mount happens between the measure and the click (they are 2 to 4 ms
  apart: `Frame.waitForSelector` at 9144 ms, `Page.mouseClick` at 9149 ms in a passing trace).
- "A server change moved page timing": nothing in the failing path involves the server. The click, the restore and the
  re-measure are browser-side. `27274c0e` fails as often (10 / 40).

### Why tracing hides it (and why the bisect saw different rates)

With `--trace on` the same test passed 30 / 30 on `b179456b`, because the tracer's per-action snapshots stretch the
gap between two actions past the window (11.4 s per run instead of 10.3 s). Any extra cost between the Redo and the click
hides the race (the recorder that hit-tests every frame also passed 20 / 20), and anything that makes the runner quicker
(a quiet machine, no tracing) shows it. A loaded machine slows the Node runner more than the one browser frame, so the
bisect's batches at different loads would read as different rates. This is also why a failing Playwright trace of the
unfixed test could not be recorded as the brief asked: it does not fail with the trace on. The in-page recording above
replaces it.

A 4x CPU throttle through CDP (`thr-nofix`, 8 runs) did not reproduce it either: it slows the runner's round trips and
the frame together (the gap grew to 43 to 53 ms). What does reproduce it on demand is the same flow without `nodeBox`'s
two round trips (7 / 12), and with the wait below that goes to 0 / 12.

## The fix (`08c29097`)

`tests/e2e/artifact-canvas-undo.spec.ts`, the second scene of `on a Mac (⌘Z): a moved note and a deleted block`:

```ts
await expectTopmost(
	page.locator(`.svelte-flow__node[data-id="${LIST}"]`),
	{ message: "the checklist takes a pointer again after the redo" },
);
const box = await nodeBox(page, LIST);
await page.mouse.click(box.x + box.width / 2, box.y + 14);
```

`expectTopmost` (`tests/e2e/helpers.ts`) is the existing "this point hits this element" check: it waits for motion to
settle (two frames, which is the re-measure), then polls `document.elementFromPoint` at the card's header until it is the
card. No blind wait, no new helper. The click is still a real `page.mouse.click`, and the board code is untouched.

Why test code and not product: the product behaviour (a library block is hidden until measured, re-measured on the next
frame after every restore) has no user-visible effect (shown above), and changing `restore()` would be speculative in the
most delicate file of the board.

Only this test is exposed. The other coordinate clicks in the file (`:322`, `:348`, `clickEmptyBoard`) are the first
action after `openBoard` (which waits for no hidden block) or aim at the empty pane. The other specs that undo or redo
(`multi-select`, `frame-group`, `draw`) follow it with polls of boxes, not with a click.

## Gates (`08c29097`, run once, `w4/flk-gates/`)

| gate | result |
|---|---|
| `npm run check` | 0 errors, 17 warnings (the 17 known) |
| `npx biome check src scripts tests` | clean (2,446 files) |
| `npm test` | 1,002 files passed, 1 skipped; 16,053 tests passed, 2 skipped |
| `npm run build` | no new warning: 32 `Unused CSS selector` + 2 `must have an ARIA role` (baseline 32 / 2) |
| `npm run check:artifact-chunks` | exit 0; editor closure 69.6 kB gzip (ceiling 71,680 B); chat route +1,627 B of 2,048 |
| Fallow | 124 issues, 4 circular, 0 new against the baseline file |
| `npm run check:migrations` | passes |
| Playwright: chat, conversation, the 34 `artifact*.spec.ts`, knowledge, streaming | 453 passed, 23 skipped, 0 failed (37.7 min) |

## Open points and hand-off

- The temporary worktree `flk-old` (detached at `27274c0e`) was removed; no probe file is left in the tree
  (`git status` is clean).
- A fresh worktree needs `npx svelte-kit sync` (or one Vite start) before the first Playwright run, else the runner fails
  to load the specs with `Cannot find package '$lib'` and reports "No tests found". Worth adding to the worktree setup.
- Rule for the next e2e: a coordinate click (`page.mouse.click`, `dragBetween`) made right after an undo, a redo or a
  landing (`land`) must first wait with `expectTopmost` (or use `locator.click()`, which does this itself); `nodeBox`
  cannot see that a block is hidden. Do not confirm a flake fix with `--trace on`; use `--trace off --repeat-each=40`.
- Optional product follow-up, not done and not needed for this fix: `restore()` and `land()` could carry each unchanged
  block's `measured` over, so an undo does not drop and rebuild the measurements of every block (a per-restore cost that
  grows with the board; no visible effect today).
