# TR-D1 report: the tour card arrives without moving what the reader is looking at (RC-T I-1, Minors 5, 6, 7, 8b, 11)

Agent TR-D1, model `claude-sonnet-5-5`. Worktree `.claude/worktrees/art-trd1`, branch `fix/tours-reader` (from `feat/artifacts-tours` `4956efb3`),
e2e port 5410, label `trd1`. Commits `4956efb3..fb066407` (twelve). Nothing pushed, merged or rebased; no other branch or worktree touched; no
subagent. Twice I used `git reset --soft` on my own unpublished commits (once to drop a hand-written transition that turned out to be pointless, once to
correct a byte figure in a commit message); no history that anyone else has was rewritten.

**Status: DONE_WITH_CONCERNS.** Both steps are built and proved with real input, red first; every gate is green (numbers below). The concerns are at the end
(a flaky Canvas undo test that is not mine, the first-open flash that a cache cannot remove, an observation about the sidebar after an in-tab login, one file
outside the brief's list that I touched, and 164 B of headroom in the Canvas editor's first paint).

## What was wrong, measured before touching anything

Written first as `tests/e2e/artifact-tours-arrival.spec.ts` (answer held on the wire until the item can be read, so the card lands late on any machine; the page's
own animation loop sampled frame by frame) and run on the unfixed tree:

| Case | Before |
|---|---|
| Document, late card | the editor moved **190 px in one frame** (`movingFrames` 1, so the largest step is the whole shift) |
| 21-note board, card up | notes 16 to 21 (**6 of 21**) outside the pane / under the toolbar |
| Window 1440x900 to 1180x640, untouched board | notes 13 to 21 (**9 of 21**) hidden: nothing fits the board again |
| Second Document of the page load | a second `GET /api/artifact-tours/document` |
| Row menu | `role="menu"` but focus on "Bezárás", ArrowDown ignored |
| Next on the card | live region said "Step 2 of 3", no title; Hungarian read "1. lépés, összesen 3" |

One finding changed the plan: **the ask already leaves in the same flush that opens the item**, before the body has painted (`asked at 1664 ms, the page painted
at 1763 ms` in dev, with the answer delayed 250 ms; test `the tour is asked for as the item opens, before its page has painted`). So "ask as early as the panel
knows the kind" needed no change, only a test that pins it. What the reader sees move is the answer itself arriving after a network round trip and then the
card's chunk after another, which no earlier ask removes on a slow link. So the card has to arrive gracefully and the Canvas has to follow it.

## Step 1: how the card arrives now

**Numbers, same test, same machine, after the fix.**

| Case | After |
|---|---|
| Document, late card | **190 px over 26 frames in 208 ms, largest single-frame step 17.9 px** (9% of the move); leaving: -190 px, 26 frames, largest step 17.9 px |
| Document, reduced motion | the move takes 2 frames or fewer and under 60 ms, both ways (instant) |
| 21-note board | **21 of 21 visible** before the card, with the card up and after it closes; the camera goes zoom 0.4968 (50%) -> 0.3631 (36%) -> **0.4968, same x and y**, so closing the card puts it back exactly where it was |
| Board the reader panned and zoomed (middle-button drag, wheel) | camera identical to 0.1 px through the card's arrival and its exit |
| Window resize, untouched board | 21 of 21 visible at 1180x640 and again at 1440x900; after a pan, a resize leaves the camera alone |
| Second Document of the page load | no request, no card (finished or skipped); a tour closed half-way is met again from the answer in hand, still one request |

**What changed and where.**

- `src/lib/client/api/artifact-tours.ts` **(the session cache, Minor 11 and so Minor 7).** The module keeps the answer per kind for the page load, as the
  promise (two opens share a request on the wire; a failed read is not kept). Finishing or skipping marks the kind seen *at once*, before the write lands; a
  refused (409) or failed write forgets the kind, so the next ask is the server's (the "failed write shows again next time" and "409 starts at slide one" tests
  keep working). A replay uses the new `refreshArtifactTour` (it shows the copy as it is now and keeps what comes back). A `fetchImpl` a caller hands in is
  never kept. **`keepArtifactToursFor(userId)`**: login and logout are client-side navigations (`goto`), so a module outlives a reader; the panel names the
  reader (`currentUser?.id`) before it asks and a different one starts clean. I found that hole myself while checking how the page changes hands; it is not in
  RC-T's report.
- `src/lib/components/artifacts/tour/ArtifactTour.svelte` **(the transition).** The card is a `section` inside a `div.tour-reveal` wrapper with
  `transition:reveal|global` (`slide`, 250 ms = `MOTION_DURATION.emphasis`, cubic in-out written inline; instant under reduced motion through
  `reducedMotionAware`). The wrapper grows and shrinks, the card inside keeps its size, so its words never reflow while it arrives. `|global` because the panel
  removes the card and not the wrapper's own block, and the exit must still play. A new prop `animate` (default false) is the host asking for motion: the panel
  passes it, the admin's preview (a picture, keyed per slide) does not. Focus is handed back the moment the reader leaves (`leave()`), not when the exit has
  played.
- `DocumentWorkspace.svelte` `tourCard` snippet: **`{#key tourView}` around the card**. Found by the existing 409 e2e test failing after the transition landed:
  a card is on its way out for 250 ms, and an `{#if}` that turns true again in that time brings the *same* card back with its finished state and its slide
  (a 409 does exactly that). One card per presentation. Mutation-checked (unit test red without the key).
- `src/lib/components/artifacts/canvas/CanvasBoard.svelte` + `_lib/board-model.ts` `sameCamera` **(the re-fit rule).** The board keeps `fitted`, the camera its
  last fit produced: the library's own first fit (`onmoveend` with no pointer or key behind it, only when the board opened to be fitted) or `fitBoard` (the Fit
  button is one). On every change of the pane's size (`bind:clientWidth/Height`) it fits again, **instantly**, only while `sameCamera(flow.getViewport(), fitted)`
  (half a pixel, a thousandth of a zoom). Over the card's transition the size changes every frame, so the board follows a frame at a time. **There is no list of
  reader moves to keep in step: any pan, zoom, centring or auto-pan changes the camera, so it stops being the fit's, and nothing touches it again until they press
  Fit.** A board saved with a camera of its own has no fit to keep (`fitted` stays null); nothing is fitted while a picture of the board is drawn or Alfy's
  landing holds the board. Mutation-checked (always re-fitting fails both camera tests).
  Side effect worth knowing: on a phone the **review bar** arrives ~30 ms after a board with a pending Alfy change opens and shortens the pane by 153 px
  (720 -> 567; probed), so the board used to be fitted for a pane it never had. It now follows. That is what broke
  `artifact-canvas-floating.spec.ts:205` (below).

**Design choices I weighed and did not take.** A hover/focus warm-up of the tour on list rows: the ask already precedes the paint, the in-chat card (the
common first open) is the chat page's and out of reach, and it costs chat-route bytes. A "hold the body until the tour is known" window: it taxes every
reader's first open of a kind on a slow link to protect only the new reader. Writing the transition by hand: I did it, then measured two builds of the same tree
(541,567 B with `slide`, 541,575 B written by hand), concluded the premise was false (`slide` is tree-shaken into the card's own chunk) and went back.
`cubicInOut` from `svelte/easing` *does* cost the shell 59 B (that module is static there), so the easing is inline.

## Step 2: the small ones

- **Minor 6.** A live region of the card's own (`artifact-tour-live`, `aria-live="polite"`, `aria-atomic`, `sr-only`) says `"<step line>. <title>"` after Next or
  Back ("Step 2 of 3. Draw on it, and place things"); empty until the reader moves. The visible step line is plain text (no longer `aria-live`), so nothing is read
  twice. No new string: the announcement reuses `artifacts.tour.stepOf`.
- **Minor 5. I picked "behave as a menu".** `ArtifactDeletePopover`'s row menu opens on its first item, ArrowDown/ArrowUp wrap, Home/End go to the ends, it is named
  for the item (`aria-label`), Escape closes it and gives the focus back to the "..." button (the shell already did that). Six existing e2e tests find these
  items by `role="menuitem"`, which this keeps. `AnchoredPopover.svelte` gets an optional `initialFocus` (see concerns). **A race I made and fixed:** the
  popover moves focus on a timer once its content is in; my keyboard test failed in 2 of 5 runs because that timer could fire after a quick ArrowDown and pull the
  reader back to the first item. The timer now keeps focus where it already is inside the menu (10 of 10 runs after; a fake-timer unit test pins it and was
  mutation-checked).
- **Minor 8(b).** Hungarian `artifacts.tour.stepOf` is `{n}. lépés / {m}`; English is unchanged.

## Tests

- New `tests/e2e/artifact-tours-arrival.spec.ts` (11 tests, no hard-coded waits): the Document slides in and out (frame sampler); reduced motion is instant; the
  ask precedes the paint; the 21-note board shows every note before, with and after the card; a moved camera survives the card; a resize re-fits an untouched
  board and leaves a moved one alone; one answer per kind per page load (two tests); the live region; the Hungarian step line; the menu with the keyboard.
  `tests/e2e/artifact-tours-helpers.ts`: `bigBoard()`, `seedItem({ board })`, `finishTour` reads the newest card.
- Existing e2e adapted where my change is meant to change what they check: `artifact-tours.spec.ts` (the second open of a kind no longer asks; measuring waits for the
  slide; the 409 test picks the card that says "Step 1 of 3" because the old card is still leaving), `artifact-canvas-floating.spec.ts:205` (see concerns).
- Unit: `artifact-tours.test.ts` (+9: cache, sharing, failure not kept, replay refresh, optimistic seen, 409/failure forget, injected fetch, reader scope),
  `ArtifactTour.test.ts` (+4 and the live-region test rewritten: Hungarian, slide-in only when asked, none under reduced motion, focus before the exit),
  `DocumentWorkspace.tour.test.ts` (+4: enters collapsed / leaves and is gone when the exit has played, instant under reduced motion, a 409 during an exit brings a
  new card at slide one, the reader named before the ask; the file now runs under reduced motion except the new describe), `ArtifactDeletePopover.test.ts` (+5),
  `board-model.test.ts` (+2).

## Gates (once, on the finished tree)

| Gate | Result |
|---|---|
| `npm run check` | 0 errors, 17 warnings (ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1: the baseline) |
| `npx biome check src scripts tests` | clean, 2,476 files |
| `npm test` | 1,011 files + 1 skipped; **16,284 passed**, 2 skipped |
| `npm run build` | exit 0; 32 `Unused CSS selector` + 2 `must have an ARIA role` (the baseline, nothing new) |
| `npm run check:artifact-chunks` (own step) | **exit 0. Chat route 541,624 B gzip, +2,016 against the new baseline 539,608** (2,048 allowed). Editor first paint **71,529 B of 71,680** (69.9 kB; 151 B left) |
| Playwright, port 5410 | chat, conversation, knowledge and every artifact suite (the tours' three specs, the new arrival spec, the Canvas, Document, App, panel, delete and versions suites): **491 passed, 23 skipped, 0 failed** (42.4 min; the skip count equals the baseline's), run on a warmed server |
| Fallow | 124 issues, 4 circular: identical to the baseline and TR-C's file, nothing added (an unused export would count; `client/api/*` exports are ignored by `.fallowrc.json`, `sameCamera` and `bigBoard` are used) |
| `npm run check:migrations` | clean |

**Chat-route baseline (ruling 68's note).** Measured in this worktree on one machine: 541,158 B at `4956efb3` -> **541,624 B** at this head = **+466 B gzip**
(the page-load cache and the reader scope, the panel's key and refresh call, the row menu's keyboard handling, the optional `initialFocus`; the card, its slide
and its easing are lazy). `--chat-baseline` moved 539,142 -> 539,562 -> **539,608** (+420, then +46 when the reader scope landed; two commits, numbers in
their messages), so the gate reads +2,016 of 2,048 as it did before: **32 B of headroom, as before the patch.** The next agent whose strings or panel code grow the
route moves it by its own measured growth, or the orchestrator re-baselines to regain the 2 KiB.

## Screenshots (HU, 1440x900, light), each looked at

In `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/shots/trd1/`
(throwaway spec kept as `../../zz-trd1-shots.spec.ts.txt`, not committed):

- `board-before-card-hu-1440-light.png`: the 21 notes in 3 columns at 50%, centred in the pane, all above the toolbar.
- `board-card-up-hu-1440-light.png`: the card ("1. lépés / 3", "Egy tábla, bármire", `Kihagyás` / `Tovább`, the Canvas drawing) over the content area; the board
  re-fitted to the shorter pane at 36%, **all 21 notes visible** above the toolbar, none cut.
- `board-card-closed-hu-1440-light.png`: identical to the first (50%, same positions): closing the card puts the board back exactly.
- `document-card-hu-1440-light.png`: the Document with its card settled above the toolbar and the page; no clipping of the card's border or shadow (the wrapper's
  `overflow` is `visible` again after the entrance: probed), focus ring on the header button from the Tab I pressed.
The Document mid-entrance is proved with numbers in the test, as agreed.

## Deviations and concerns

1. **`artifact-canvas-floating.spec.ts:205` (phone, the zoom control steps aside) failed deterministically after the re-fit, and I changed the test, not the
   product.** Cause measured: a drag ends about one step short of where the pointer goes (the first step only starts it); the board now sits where the final pane
   puts it (the review bar shortens the pane after the first fit), so the note started higher and was a longer step short: it stopped 0 px under the control (it
   passed before by 5.5 px of luck). The test now aims 40 px under the control instead of 20; same claim, with room.
2. **`artifact-canvas-undo.spec.ts:418` (the Mac chord, a moved note and a deleted block) is flaky and I believe not mine.** It failed once in the 153-test Canvas run
   and passed 2 of 3 on a rerun. Its board has a stored camera, so `fitted` stays null and my code is inert there. **It passed in the final full run** (491 passed,
   0 failed). I did not prove it flaky on the base (that needs a second server and database).
3. **First-open flash of the dictionary line (Minor 7) is only removed from the second open on.** A cache cannot know the answer before the first one arrives; a
   first open of an *empty* item whose copy an admin edited, with a slow answer, still shows the dictionary line first. Invisible with the shipped copy
   (`empty-state.test.ts` keeps it equal). Removing it needs a "pending" signal into the three bodies, outside this brief's files.
4. **A late card still moves the page**, now as a quarter-second transition; only an earlier answer or holding the body back could avoid that, and I chose neither
   (see the design section).
5. **Touched outside the brief's list:** `AnchoredPopover.svelte` (one optional prop, `initialFocus`, 5 lines, additive; the other popovers pass nothing),
   `package.json` (the baseline, as asked), `AGENTS.md` (the Tours section and the Canvas rule), and test files. The re-fit is in `CanvasBoard.svelte`, i.e. in the
   Canvas editor's first paint: **+about 250 B gzip; the closure is 71,529 B of its 71,680 B ceiling (151 B left)**, so the next editor change needs a recorded raise.
6. **Not built:** an end-to-end test of the reader scope. A second reader who logs in in the same tab has to reach a chat without a reload, and in the harness their
   sidebar said "No conversations yet" although they had one (seen once, not investigated; it might be a stale conversation list after an in-tab login, which
   would be an existing problem outside tours). The scope is covered by the module and panel unit tests.
7. The dev server's first navigation after a restart or a source edit sometimes fails with `net::ERR_ABORTED` at `page.goto("/")`: the first test of a run
   fails and passes alone. I ran the final suite against a warmed server.

## Hand-off

- `client/api/artifact-tours.ts`: `getArtifactTour` (kept per page load), `refreshArtifactTour`, `markArtifactTourSeen` (marks seen at once, forgets on failure),
  `keepArtifactToursFor(userId)`. A host that wants the cache to be right passes `currentUser` to the panel (the chat and Knowledge pages do; the project files
  dialog does not, so it starts clean).
- `ArtifactTour.svelte`: prop `animate`; wrapper `.tour-reveal`; test ids `artifact-tour-live`; the card is keyed per presentation by the panel, never reuse one.
- `CanvasBoard.svelte`: `fitted`, `fitBoard(duration)`, `sameCamera` in `_lib/board-model.ts`. A new camera-moving feature needs nothing; a new way of fitting should
  go through `fitBoard`.
- `AnchoredPopover.svelte`: `initialFocus?: () => HTMLElement | null | undefined`.
- e2e: `tests/e2e/artifact-tours-arrival.spec.ts` (frame sampler, `holdTourAnswers`), `bigBoard()` and `seedItem({ board })` in the tours helpers.

## Commits (`4956efb3..fb066407`)

```
a1f2f391 Ask for each kind's tour once per page load, and a replay asks again
2b8432ab The tour card slides in and out instead of jumping the page, and says its steps aloud
e7a1efda Fit a board again when its pane changes size, while the camera is where the last fit left it
688ef5ff The list row's menu is a menu: it opens on its first item and the arrows move in it
1f11d2c5 Nest the tour card under the wrapper that reveals it, and say what slide costs
a89dc5e3 Keep the card's easing in the lazy chunk
0c37da5a Move the chat-route baseline by the 420 B gzip this patch adds
fc0fad03 Say in AGENTS.md how the tour card arrives, what the row menu does and when a board is fitted again
26f99d22 Prove how the tour card arrives with real pointer and keyboard input
7062d06d A tab that changes hands asks again: the page-load tour answers are the named reader's
dce1eda2 Move the chat-route baseline by the 46 B the reader scope adds
fb066407 Let the workspace test helper take a currentUser
```
