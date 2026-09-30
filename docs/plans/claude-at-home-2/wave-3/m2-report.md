# M2 report · F-C merged onto the board F-B fixed

Model: `claude-sonnet-5-5`. Worktree `art-fxc3`, branch `fix/artifacts-w3-app-save`, e2e port 5570, label `m2`.
Start: F-C's tip `7890fc54`. **Final tip `12caab13`** (tree clean). Range `7890fc54..12caab13`; my own commits:

| Commit | What |
|---|---|
| `50243ca2` | the one merge, `git merge feat/artifacts` (its tip then: `96544867`); one conflict, resolved (below) |
| `0fd576d9` | a newly inserted frame is listed in front of the blocks, so an App dragged into it is not reloaded (F-C's patch, redone by hand) |
| `02763b5f` | the stale `conflict` doc in `canvas/_lib/server-board.ts` |
| `28769433` | `check:artifact-chunks` `--max-gzip` 68608 -> **69632** (ruling 68, as amended) |
| `12caab13` | **not in the brief**: `artifact-canvas-live.spec.ts` looks at the block on the board, not at a copy (below) |

**Status: DONE_WITH_CONCERNS.** Every gate is green on the final tree. The concerns are the one commit the brief did not
ask for (and why the merged tree needed it), what I could not establish about it, and two items F-C left open.

## Step 1 · the merge (`50243ca2`)

- **One conflict**, `tests/e2e/artifact-canvas-comments.spec.ts`, a 7-line hunk inside "a step the reader takes while
  Alfy is answering is not lost…". F-C's side had deleted the banner assertion (its rewritten premise: the step is put on
  top of Alfy's change, so `canvas-conflict` must have count 0, which the test asserts right after). F-B's side had
  only reworded that same assertion for the old premise. Resolution: **F-C's side**, so F-C's rewritten test is untouched
  and no assertion was dropped that the new premise still needs; F-B's new "Comment tool comments on the block that is
  clicked, even right after an Insert" test (auto-merged, above it) came along. The reworded sentence stays pinned where
  the banner still appears.
- **The other two banner assertions needed no edit.** `artifact-canvas.spec.ts` ("says so when another writer got there
  first…") and `artifact-canvas-frames.spec.ts` ("a drop on a stale version says so…") already say F-B's sentence after
  the merge (F-B had updated them; F-C had not touched them). No other file mentions the old text
  (`grep "Someone changed the board while you were drawing"` over `src` and `tests`: none). Both tests are **green with
  F-C's editor** (a mocked 409 twice gives F-C's `giveUp`, hence the banner): seen in the targeted run below.
- The merge commit holds only the resolution. `feat/artifacts` had gained one docs-only commit (`96544867`, the D1 brief)
  between my reading it and the merge; it came in with the merge.

## Step 2

**Frames first (`0fd576d9`).** `git apply --check` of `frames-first-insert.full.patch` failed on the `CanvasBoard.svelte`
hunk, as F-C predicted: F-B added `insertSelectedId = added.id;` directly above the `nodes = [...]` statement. I applied the
e2e half with `git apply --include`, **saw it red**, then redid the code hunk by hand around F-B's line.
- Red without the code change: `artifact-canvas-app-drag.spec.ts:338` ("…INSERTED after it is not reloaded either")
  fails at the boot-id check (`counter-boot` `8302127854666813` -> `9823444471160637`: the document was reloaded).
- Green with it: the whole app-drag spec, 4 passed, 1 skipped (the `FC_SHOTS`-gated screenshot).
- The hunk is F-C's exactly: a frame is inserted before the first non-frame block; anything else is appended as before.

**Stale doc (`02763b5f`).** `judgeServerBoard`'s `conflict` said "cannot be merged … refused as stale". It now says what the
editor does (rebases the reader's steps onto the newer version with `rebaseBoard`, saves the result as their own step) and
names `CanvasEditor.adoptBoard`, where the verdict is applied (`adoptServerBoard` only draws the result). Doc only.

**Ceiling (`28769433`).** `--max-gzip 69632`; nothing else in the script line changed (`--max-target-gzip 65000`, the
forbid list, the chat baseline 535771 and its 2,048 allowance are as before). No other file names the old number outside
`docs/plans`.

## Step 3 · proof

### The targeted run found one failure, on the merged tree only

`artifact-canvas*.spec.ts artifacts-panel*.spec.ts` (196 tests, 17.8 min): **177 passed, 18 skipped, 1 failed**:
`artifact-canvas-live.spec.ts:884` "leaves the snapshot exactly as it was when a refresh fails, says so, saves nothing,
and works on the next try". The five tests this merge is about all passed in that run (F-C's frames-first test, F-B's
Insert-then-Comment, F-C's rewritten "not lost" test, and the two banner tests).

Alone, on this tree, it failed **3 runs in 4**, always the same: `strict mode violation: getByTestId('canvas-liveweb-status')
resolved to 2 elements`, the first inside a `canvas-node`, the second not.

**What the second element is** (a scratch copy of the spec with a DOM dump, deleted, never committed): the ancestor chain
of the second one is `p < div[canvas-liveweb] < div.canvas-node__content < div < body`. It is the **still-image copy**:
`pictures-controller.svelte.ts` captures a poster "from a COPY of the block's content" mounted off screen on `body`
(`aria-hidden`, `inert`, `left:-100000px`), 800 ms (`CAPTURE_DEBOUNCE_MS`) after a block first shows, and removes it in a
`finally` when `capturePoster` returns. The copy keeps the block's test ids on purpose (`stillify` looks up
`[data-testid="canvas-app"]` in it), so product code stays as it is.

**Why it collides.** The autosave of the step that inserted the block is also an 800 ms debounce (`createDocumentAutosave`,
`delayMs ?? 800`) from the same step. Timeline, measured with a MutationObserver (ms from the board opening; four of the
five instrumented runs read alike): picked ~157, copy added **~975**, "Saved" visible **~1035**, copy removed **~1045**,
Refresh clicked **~1052**. The test waits for "Saved", reads two DB rows, clicks Refresh and asserts at once, so it acts
inside, or within a few ms of, the ~70 ms the copy lives. The instrumented runs passed 5 of 5; they put extra `evaluate`
calls between the steps, which (I infer, I did not time an uninstrumented run) moved the click just past the copy's removal.
The first scratch spec (DOM dump at +0, +30, +100, +300, +800 ms after the click, then the assertion, so its runs passed)
found a second `canvas-liveweb-status` alive at +0 or +30 ms in 3 of 3 runs and gone by +100 ms.

**What I did not establish:** why the merged tree lands in the window when neither parent's own gate run did (F-B: 337
passed, 0 failed; F-C: 336, 0 failed). Both parents add work at a board's first step; I did not bisect (that needs the
parents' trees, in worktrees I may not touch) and I have not put a guess in a commit message.

**Fix (`12caab13`).** `artifact-canvas-live.spec.ts` gets `onBoard(page) = page.getByTestId("canvas-node")` (with a comment
saying why) and this one test finds the block's `status`, `source`, `stale` through it. Every assertion is kept, same
texts; the phantom copy simply cannot count, which is the locator Playwright itself suggested. Evidence: the test alone
**8 of 8 green** (1 of 4 before); the whole live spec, three repeats, **48 passed, 18 skipped, 0 failed**.

**Exposure that remains, in principle:** any spec that acts within ~100 ms after "Saved" on a board with a photo, live-web,
App or map block and asserts through a `page`-wide test-id locator (`toHaveCount(3)` on `canvas-liveweb-source` would see
6). None failed in 48 spec runs plus the full gate, so I left them alone. If one starts to flake, `onBoard` is the fix.

### Build and the chunk guard (tree `12caab13`, `npm run build`, exit 0)

- Warnings: **32** `Unused CSS selector` + **2** `must have an ARIA role`: the baseline, nothing new.
- **First paint (what opening a board downloads): 68,934 B gzip, 11 chunks** (the guard prints it as 67.3 kB; the exact
  bytes come from running the guard once with `--max-gzip 1`, whose failure line prints them). Enforced ceiling 69,632:
  **698 B of headroom**. Ruling 68's original prose budget (68,608) is exceeded by 326 B; the amended ceiling is what
  holds. For reference: F-B's tree 68,595 B, F-C's tree 68,707 B.
- The chunk that holds `CanvasEditor`: 59.9 kB gzip as the guard prints it (limit 65,000 B, `--max-target-gzip`); 3 more
  chunks (17.0 kB) are shared only with other lazy entries and not counted; Chart.js and MapLibre stay out.
- Chat route without a board open: 537,233 B gzip, **+1,462 B** against the 535,771 baseline (2,048 allowed).
- `npm run check:artifact-chunks` on its own: passes.

### The full gates, once, on `12caab13`

1. `npm run check`: **0 errors, 17 warnings** in 3 files (`ToolActivityRow` 10, `ThinkingBlock` 6, `RouteItinerary` 1), 8,324 files.
2. `npx biome check src scripts tests`: clean, 2,420 files.
3. `npm test`: 993 files passed (1 skipped), **15,832 tests passed**, 2 skipped, 0 failed.
4. `npm run build`: above (the tree did not change after that build).
5. Playwright, port 5570, `artifact*.spec.ts artifacts-*.spec.ts knowledge chat conversation`, one run:
   **346 passed, 18 skipped, 0 failed, no flaky** (25.8 min, exit 0). The skips are the `*_SHOTS`-gated screenshot suites
   and pre-existing skips (the same 18 as in the targeted run and in F-C's).
6. Fallow (`/tmp/fallow-m2.json`): **124 issues, 4 circular**; the finding set is **identical** to F-C's run (compared
   finding by finding, ignoring line numbers: 0 added, 0 gone).
7. `npm run check:migrations`: passes ("All schema tables have corresponding migrations").

Logs: `…/scratchpad/w3/m2/` (`e2e-canvas-panel.log`, `e2e-live-x3.log`, `build.log`, `check.log`, `vitest.log`,
`fallow.log`, `e2e-full.log`, the commit messages).

## Deviations and concerns

1. **`12caab13` is outside the brief** (three loose ends). I added it because the gate could not pass without it, and it
   changes only a test's locators. The brief said never weaken an assertion: none was; the locators are narrower.
2. **Root cause of the timing shift on the merged tree is not established** (above). The failure is real on this tree and
   fixed; a future flake of the same shape in a sibling spec is possible, and the fix is `onBoard`.
3. **`feat/artifacts` moved again after my merge**: `bf9b7bec` (Ruling 69, `decisions.md` and `progress.md`, docs only).
   I did not merge it (one merge allowed). No file overlaps mine, so the orchestrator's merge of this branch is clean
   (`git merge-base --is-ancestor` says it is not a fast-forward only because of that one commit).
4. **F-C's open items are unchanged**: a board stored with a frame *after* an App (Alfy-made frames, older boards) still
   reloads the App once when the App is adopted into it, with no alarm (a frames-first normalisation on load and landing
   would touch `judgeServerBoard`'s order-sensitive comparison, so not done here); and a queued follow-up that the
   runtime drains after the running turn bypasses `prepareTurn` (the rebase covers it).
5. Nothing under `docs/plans/**` was edited. No subagent was dispatched. Nothing was pushed, rebased, or touched in another
   worktree or branch.

## Hand-off (for the orchestrator's merge and for the docs agent)

- Merge `fix/artifacts-w3-app-save` (`12caab13`) into `feat/artifacts`; it contains `feat/artifacts` up to `96544867`.
  The enforced first-paint ceiling is now **69,632 B** (`package.json`); first paint is 68,934 B, so the next raise needs a
  recorded reason of the kind ruling 68's amendment gives.
- `CanvasBoard.svelte` `insertBlock`: a frame is listed before the first non-frame block; the reason (the library moves a
  block's wrapper when a later-listed frame adopts it, and a browser reloads an iframe whose ancestor moved) is in the code.
- `tests/e2e/artifact-canvas-live.spec.ts`: `onBoard(page)`. The poster copy on `body` carries the block's test ids for
  about 70 ms, 800 ms after a block first shows (an autosave lands at the same moment).
- For `AGENTS.md`'s Artifacts section, if the docs agent wants them: `judgeServerBoard`'s `conflict` verdict means "rebase,
  do not stop" (`CanvasEditor.adoptBoard`); `insertBlock` lists frames first.
