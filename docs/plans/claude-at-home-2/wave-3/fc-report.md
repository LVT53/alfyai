# F-C report · the App inside a board, and the reader's unsaved step (RV-3 cluster C)

Model: `claude-sonnet-5-5`. Worktree `art-fxc3`, branch `fix/artifacts-w3-app-save`, base `47e5e622`
(`feat/artifacts` after S3-X and F-A). Commits `47e5e622..7890fc54` (7, below). Port 5570, label `fc`.

## Commits (`git log 47e5e622..7890fc54`)

- `47fbcbdc` Stop taking a moved App frame for an App that leaves its sandbox (I1: `AppFrame`, its tests, the app-drag e2e)
- `7138791b` Save the open board's pending step before a chat turn starts (I2a: flush, `onFlushReady`, `prepareTurn`, tests)
- `19237c90` Put the reader's unsaved step on top of Alfy's change instead of refusing it (I2b: `rebase-board.ts`, editor, notice, i18n, e2e)
- `97762129` Give the canvas notices a 44 px button on phones, and cover the merge code's late arrival
- `a30da3ec` Keep the send gate tick-for-tick as it was when no artifact holds a step back (+ the page-level test)
- `0fcb993b` Carry less of the rebase glue in the editor's first paint
- `7890fc54` Leave a board that waits for Reload alone, word the Hungarian notice naturally, and test the notice

**Status: DONE_WITH_CONCERNS.** I2 is fixed end to end (flush before a turn, and a rebase instead of a refusal). I1's
*false alarm* is fixed at its root and the tripwire is proven to still catch a real self-navigation, but the App still
reloads when the library has to move its wrapper (a frame listed after the App adopts it). Keeping the iframe mounted
through that is a change to `CanvasBoard.svelte` (F-B's file); I proved a 12-line patch for the reader's own frame
insertion and did **not** commit it (see Concerns 1). The editor's first-paint closure is 99 B over ruling 68's prose
budget, under the enforced guard (Concerns 2).

## What I found, per finding

### I1 · an App dragged into a frame

Root cause, measured in Chromium (a MutationObserver on `.svelte-flow__nodes` and a load listener on the original
`<iframe>`): the drop makes `handleNodeDragStop` call `parentsFirst`, which re-lists the nodes so the frame comes
before the App. `@xyflow/svelte`'s `NodeRenderer` is a keyed `{#each}` over `nodeLookup`, and Svelte 5's reconcile
moves one wrapper with `dest.before(node)`. With `[app, frame]` becoming `[frame, app]` it is the *App's* wrapper that
moves (a one-item jump ties, and the tie moves the skipped item). A browser destroys an iframe's browsing context when
its ancestor is removed and makes a new one on insertion: `load` fires again **on the same element**, in a **new
window** (`contentWindow` differs). `trackFrameLoad` counted "a second load on the same element" as the App navigating
itself.

Fix (`app/AppFrame.svelte`): the tripwire arms on the frame's *window*, not on "one load per element". The first load,
or the first load in a window the element did not have before, is the page's own (it took the element out and put it
back); only another load in the SAME window is an app navigating itself (a frame's WindowProxy outlives every
navigation of it, cross origin too, and an app has no reach into the page to take its own element out and back). A
`load` with no window is ignored. Nothing about the sandbox string, the CSP or the message-listener clauses changed.

- Unit (`AppFrame.test.ts`, 3 new, seen red before the fix): a moved frame does not trip; a self-navigation after a
  move still trips; the bridge serves the moved frame's new document and not the torn-down one.
- e2e (`tests/e2e/artifact-canvas-app-drag.spec.ts`, new, 3 tests + 1 gated screenshot). Test 1 (drag into a frame
  listed after the App) is **red on the old `AppFrame`** (`role=alert` count 1, from the review's probe A) and green now.
  Test 2 (into a frame listed before it, and out again: no reorder, so **the same document keeps running**: the boot id
  in the App is unchanged and its count is 1) is green on both. Test 3 (a runaway App on a board: alert with the
  sandbox sentence, frame torn down, "Reload the app" brings a fresh frame) is green on both, so the tripwire still
  catches a real self-navigation, in a real browser, on a board. The App's storage: the counter App writes its count to
  `window.alfy.storage`; after the drag the DB row still says 2 and the App shows 2 again, and it counts on to 3.

What still happens: dragging an App into a frame **listed after it** reloads the App (its `window.alfy.storage` value
comes back, in-memory-only state does not). See Concerns 1.

### I2 · the reader's unsaved step and Alfy's change

Red first: `tests/e2e/artifact-canvas-unsaved-step.spec.ts` test 1 (type in a note, ask Alfy at once, through the real
chat with the fake provider) failed on the old code exactly as the review said: banner "Someone changed the board while
you were drawing", read-only board, the chat card at `v2 · 2 changes to review`.

1. **Flush before a turn.** The Canvas body registers `flush: saveBoardNow` with the panel (an optional `flush` in
   `ArtifactPanelBodyActions`, next to `openVersions`); `DocumentWorkspace` hands the open body's flush to the page
   through a new prop `onFlushReady(flush | null)`; the chat page awaits it, bounded to 2 s and never rejecting
   (`awaitOpenStepSave` in `_helpers.ts`), in a new `prepareTurn()` that replaces `ensureCloudWarningAcked` at the six
   places every fresh turn already passed (composer `beforeSend`, regenerate, edit, retry, Atlas, landing bootstrap).
   With nothing open that holds a step back it is the cloud check alone, tick for tick (24 page-runtime tests failed
   when I first awaited unconditionally; fixed and covered).
2. **Rebase on a stale save or a landing that meets an unsaved step.** `canvas/rebase-board.ts` (new, lazy): a three-way
   merge by block, connection and mark. `base` is the last board the server acknowledged (`savedJson`), `server` is the
   newer version, `reader` is the board as drawn. A side that did not change a thing takes the other's; both changed the
   same thing: the reader's stands and the block is named. A block is merged as: where it is (frame and place in it,
   one unit), how big it is, and each field of its content one by one (a note's words and its colour are separate).
   Result goes through `normalizeCanvasBody`, so a block Alfy put in a frame the reader deleted stays, out of the frame.
   The editor (`CanvasEditor.svelte`):
   - `adoptBoard`: a `conflict` verdict no longer stops; it commits the board's settle-window step first
     (`boardApi.flush()`), rebases, draws the merged board through the same landing (`controller.landChange`), and
     saves it as the reader's own version (`autosave.schedule`). A step still inside the 350 ms settle delay is no
     longer overdrawn by a landing either.
   - `recoverFromRefusal`: a save refused `version_conflict`/`stale` reads the board again and goes through the same
     path. Refusals for a step that a later step or a landing has superseded are ignored. A refusal with nothing newer
     on the server is a race with the reader's own save: the step goes once more with the guards it has now; a second
     one in a row keeps the old banner (`giveUp`), so the fallback stays honest (the two existing mocked-409 tests
     still pass unchanged).
   - The merge code loads with the first step (`handleBoardChange` primes it), and when a conflict arrives before it is
     there the read waits for it and is taken up again (e2e: chunk delayed 3 s, both steps still end up on the board).
   - A dismissible notice (`canvas-rebased-notice`, `role=status`) says how many blocks the reader's version stood over
     a different newer one: `artifacts.canvas.rebasedKept`, English and Hungarian.

- Unit: `rebase-board.test.ts` (21; mutation-checked: "server wins on conflict" fails 4 of them), `_helpers.test.ts`
  (+4, `awaitOpenStepSave` with fake timers), `DocumentWorkspace.test.ts` (+2, `onFlushReady`; red without the
  hand-off), `page-runtime.test.ts` (+1: the message is not dispatched until the open body's save answers; red without
  the `beforeSend` wiring).
- e2e (`artifact-canvas-unsaved-step.spec.ts`, 5 tests + 3 gated screenshots; the review's failing test is test 1):
  1. type, ask at once: both survive, versions `[user, user, alfy]`, no conflict banner (red before);
  2. Alfy's version written while the step is in the browser: both on the board and in the saved one, versions
     `[user, alfy, user]`, the board keeps saving after (red on the old editor);
  3. both changed the same words: the reader's words stand, the notice names 1 block, Dismiss removes it (red before);
  4. merge code delayed 3 s: the newer version waits, both land, one chunk fetch;
  5. a refusal with nothing newer (mocked once): the step lands on the retry with nothing to reload.
  `artifact-canvas-comments.spec.ts`: the test that pinned the old behaviour ("not lost silently... offers Reload") is
  rewritten for the new one (both on the board and saved, versions end with a user version). It is the only existing
  test whose premise I changed.

## Gates (once, at the end, on the final tree)

All on the final tree (`7890fc54`, clean), Node 22 from Homebrew:

1. `npm run check`: **0 errors, 17 warnings** (`ToolActivityRow` 10, `ThinkingBlock` 6, `RouteItinerary` 1: the baseline), 8,320 files.
2. `npx biome check src scripts tests`: clean, 2,416 files.
3. `npm test`: 993 files passed (1 skipped), **15,802 tests passed**, 2 skipped, 0 failed.
4. `npm run build`: exit 0; **32** `Unused CSS selector` + **2** `must have an ARIA role` lines (the baseline), nothing new.
   The build runs `check:artifact-chunks` and it passes: CanvasEditor's own chunk 59.7 KiB / 61,076 B gzip (`--max-target-gzip 65000`),
   what opening a board downloads **68,707 B gzip** (67.1 KiB; enforced `--max-gzip 69000`; ruling 68's prose budget is 68,608 B, so
   99 B over), chat route +1,431 B against its baseline (2,048 allowed).
5. Playwright on port 5570, `artifact*.spec.ts artifacts-*.spec.ts knowledge chat conversation` (354 tests in 31 files): **336 passed, 18 skipped, 0 failed**
   (24.7 min; the skips are the FC_SHOTS/S3*_SHOTS-gated screenshot suites and pre-existing skips). The cold first test of a run
   sometimes times out in `login` (Vite optimising): I reran alone and it passed; nothing failed in the final run.
6. `npx fallow --no-cache --format json --quiet --score`: **124 issues, 4 circular**, and the finding set is identical to S3-X's and RV-3's
   runs (no new finding, none gone). `rebase-board.ts`'s exports are used (`rebaseOnto` by the editor, `rebaseBoard` by it and its tests).
7. `npm run check:migrations`: passes unchanged.

## Screenshots (looked at each; `…/scratchpad/w3/shots/fc/`, Hungarian, not committed)

- `1440-light-app-in-frame.png`: the counter App inside the "Sunday" frame after the drag, running (count 3), no alarm,
  sandbox bar in Hungarian.
- `1440-light-board-after-raced-send.png`: the board after typing and asking at once: the reader's note "(két főre)",
  Alfy's new note and the moved museum note, the "Alfy · Megtartom · Visszavonom" pill and the review bar, no conflict
  banner, chat card `v3 · 2 módosítás vár rád`.
- `1440-light-board-kept-notice.png`: the notice after a true conflict: "Alfy 1 olyan blokkot… A te változatod maradt
  meg." with Elrejtés, the reader's words on the note, Alfy's new note ringed, "Mentve".
- `390-light-board-kept-notice.png`: the same on a phone: three lines, the Elrejtés button is 44 px tall (the shared
  notice class had 25 px buttons; the fix is under the canvas's own phone query).
- `1440-dark-board-kept-notice.png`: the same in the dark: amber notice on the warning tint, legible, Elrejtés outlined,
  the reader's note and Alfy's ringed note in the dark paper tones.

## Concerns and deviations

1. **I1's reload, and a patch I did not commit.** The brief says to keep the frame mounted through a reparent.
   Nothing inside `AppFrame` can: the browser reloads an iframe whose ancestor the library moves, and the move is the
   keyed `{#each}` reconcile of a re-listed `nodes` array. The only durable fix is to not re-list: keep frames in front
   of the other blocks. That lives in `CanvasBoard.svelte`'s `insertBlock` (and, for boards a frame was added to by
   Alfy or before this fix, the landing), which is F-B's file, so I stayed out of it. I proved the insert half and
   left it as a patch, not a commit: `…/scratchpad/w3/frames-first-insert.full.patch` (the 12-line `insertBlock` hunk in
   `CanvasBoard.svelte` plus one e2e test for `artifact-canvas-app-drag.spec.ts`; `git apply --check` is clean on
   `7890fc54`; `frames-first-insert.patch` is the hunk alone). With it, an App dragged into a frame the reader inserted
   after it keeps the very same document (probe: boot id unchanged, count kept; the test is red without the hunk: the
   count resets to 0). Apply it after F-B merges; if F-B changed the `nodes = [...]` statement there, the hunk is three
   lines to redo by hand. Boards stored with the frame after the App (Alfy-made frames, older boards) still reload once
   on adoption, with no alarm; a fix for those is a frames-first normalisation on load and landing, which touches
   `judgeServerBoard`'s order-sensitive comparison, so I would not rush it.
2. **Editor first paint.** `check:artifact-chunks` passes (the enforced `--max-gzip 69000`), but the closure is 68,707 B
   against ruling 68's prose "67 KiB (68,608 B)": 99 B over (the guard's number and the ruling's differ by 392 B already). The glue cost ~0.9 KiB at first; I moved the parsing and
   the merge into the lazy module and trimmed the rest. What is left is `recoverFromRefusal`, the `adoptBoard` merge
   branch and the notice state. If the ruling is to be held literally, the next cut is the same-version retry or moving
   `recoverFromRefusal` behind the lazy module with a host object (about the same bytes again). Chat route: +1,431 B
   against the baseline (2,048 allowed): the page wiring, `awaitOpenStepSave`, the workspace effect and the two strings.
3. **F-B's banner string.** The conflict banner now appears only when a refusal cannot be reconciled (a second refusal
   with nothing newer on the server, or the merge code cannot load); the reader's step is on screen and unsaved and
   Reload takes it away, which the wording should say. Two existing assertions read the old text and must follow the new
   wording: `artifact-canvas.spec.ts` ("says so when another writer got there first…") and `artifact-canvas-frames.spec.ts`
   ("a drop on a stale version says so…"); the third one, in `artifact-canvas-comments.spec.ts`, was in the test I
   rewrote (it no longer expects a banner, so F-B's edit of that assertion should be dropped in the merge).
4. `_lib/server-board.ts`'s doc for `conflict` ("cannot be merged") is now stale (the editor merges); I left F-B's
   directory alone.
5. Not covered on purpose: a queued follow-up that the runtime drains after the running turn bypasses `prepareTurn`
   (the runtime is not one of my files); the rebase is what covers it. A save refused at the *same version* by hash only
   (two tabs saving inside the coalescing window) ends in the honest banner after one retry. A checklist's `items` or a
   photo block's `items` are one field: both sides editing different items of one list counts as a conflict, the
   reader's list stands, and Alfy's version is in History.

## Hand-off (for F-B, the orchestrator and the next agent)

- `src/lib/components/artifacts/artifact-bodies.ts`: `ArtifactPanelBodyActions.flush?: () => Promise<void>`. A body
  that wants its pending step saved before a chat turn registers it beside `openVersions`. Only the Canvas does.
- `DocumentWorkspace.svelte`: prop `onFlushReady?: (flush | null) => void`. The chat page's `prepareTurn()` /
  `saveOpenArtifactStep` / `awaitOpenStepSave` (`_helpers.ts`) are the one seam every fresh turn passes.
- `canvas/rebase-board.ts`: `rebaseBoard(base, server, reader) => { body, kept }` and `rebaseOnto(savedJson, server,
  reader | json)`. Pure, tested, lazy. `CanvasBanners.svelte`: props `keptCount`, `ondismisskept`. i18n key
  `artifacts.canvas.rebasedKept` (both languages), placed after `artifacts.canvas.dismiss`.
- e2e helpers for the next Canvas test: `artifact-canvas-unsaved-step.spec.ts` has `openBoardOnly` (no model) and
  `writeAlfyVersion(artifactId, change)` (writes an Alfy version through `updateArtifactBody`, the way its tool does),
  and `artifact-canvas-app-drag.spec.ts` has `openBoard(page, nodesFor)` (a chat with two seeded Apps and a board),
  `dragBlockOnto` / `dragBlockBy`.
