# MFG report: the fast gates merged into the artifacts line, then VB-3 on top

Status: **DONE** (one concern worth reading: section "A test that was not part of the merge").
Model: `claude-sonnet-5-5` (Sonnet 5.5). Worktree `.claude/worktrees/art-mfg`, branch `merge/fast-gates`.
Nothing pushed. `src/` is untouched: `git diff feat/artifacts HEAD -- src` is empty. `feat/artifacts`, `dev`, `main` and the other
worktrees were only read. Ports 5500-5509 only; no server left listening.

Commit range `2a008dc3..379b1e28` (first-parent line):

| commit | what |
|---|---|
| `522fe9b5` | Merge `infra/fast-gates` (`59de2ff7`) into the History line (parents `2a008dc3` + `59de2ff7`); 2 conflicting specs |
| `3f858598` | `artifact-history.spec.ts` asks for an empty conversation (11 sites + import): the conventions test named it |
| `4a3bb8fb` | Merge `feat/artifacts` (VB-3; head `2b767d48` = `52868879` + one `progress.md` line) (parents `3f858598` + `2b767d48`); 2 conflicting files |
| `379b1e28` | `artifact-history.spec.ts` T9 and T4 wait for the preview to load before checking what it holds (a load flake, below) |

## Merge 1: `infra/fast-gates` into `2a008dc3`

Only two files conflicted (as predicted); `AGENTS.md` and six more specs auto-merged. VB-2's side wins on substance, FG's mechanical
changes are re-applied to what remains.

**`tests/e2e/artifact-versions.spec.ts`**, 5 hunks:
1. Imports: VB-2's names with `createEmptyConversation`. `waitForMotionToSettle` stays out: VB-2 had already dropped its only
   callers, and FG added no new call to this file (it was in the base import).
2. The walk test's header: VB-2's History-based title and body (`setViewportSize`, 300 s), plus FG's `{ tag: "@smoke" }`. It is the
   History-era form of the one-version-number walk FG tagged, so the smoke count stays 25 in the same 18 files.
3. The walk's conversation: `createEmptyConversation(page)` (FG's exact form for this file, which dropped the title argument).
4. The big hunk (FG's side only): the Versions popover tests at two viewports, popover rows, the phone Versions sheet, `boxOf`,
   `restoreOldestVersion`, `dismissToastAndWatch`. All of it tested the removed popover; **stays removed**.
5. The toast-exit test: VB-2's History-based `watchToastLeave` version, `createEmptyConversation(page)`.
   The result differs from VB-2's file only by FG's mechanical changes (checked with `git diff HEAD` against the VB-2 side).

**`tests/e2e/artifact-document-comments.spec.ts`**, 2 hunks:
1. "Download over drawer" (VB-2's rename of the Versions-popover stacking test): VB-2's conversation name, `createEmptyConversation`.
2. "restores a version from the Versions popover with an inline confirm, closes, and offers Undo": **stays removed** (History's restore
   is proved in `artifact-history.spec.ts`); VB-2's `historyButton` focus assertion closes the test above it.
   Not a conflict but the same spec: VB-2's new "History over drawer" test used `createConversation`; it now uses
   `createEmptyConversation` like the other 15 sites in the file, so the file is consistent (and passes the conventions test alone).
   The merged file differs from VB-2's only by FG's mechanical replacements.

**Auto-merged specs, checked for the same mismatch** (`artifact-canvas`, `-card-narrow`, `-chat-card`, `-document`, `-panel-names`,
`-panel-swap`, and `-popover-press`, which only VB-2 touched): none calls `createConversation` any more; the 25 `@smoke` tags are in
the same files and counts as on FG's branch; FG added no `waitForMotionToSettle`/`waitForStableBoundingBox` call to any spec VB-2 also
changed (the only FG change there is an import list in `card-narrow`); `editWhileOpen(page)` in `panel-swap` (FG dropped a title
parameter) has no caller left with the old arity. A scratch `tsc` over `tests/e2e` (they are not in `tsconfig`, so `npm run check`
never sees them) shows 36 errors, all older patterns (`process.env` strings, map-route fixture types, `never` narrowing), none a
missing name or a wrong arity from the merge.

**Conventions test** (`tests/integration/e2e-conventions.test.ts`) after merge 1: exactly one file, `artifact-history.spec.ts` (VB-2's
new spec): 11 `createConversation(page, title)` calls, a spec that clears `pending-chat-message`. Same titles, `createEmptyConversation`
(Hungarian T8 sets the language through `users.uiLanguage`, not through the first message, so it is safe).

## Merge 2: `feat/artifacts` (VB-3)

- **`AGENTS.md`**, the "editor is one chunk plus lazy entries" bullet was rewritten on both sides. FG's version stays (the chat route
  is held by a rule, the fixed-byte baseline and the sentence about it are gone) and VB-3's bold sentences about
  `canvas/history-parts.ts` (reached only through `CanvasEditor.svelte`'s module script, `loadHistoryPreview`, because Rolldown
  splits a module two lazy entries both import) are inserted after "as little of the editor as it can." No other mention of the old
  baseline is left in `AGENTS.md`, `README.md`, `tests/AGENTS.md` or the script.
- **`artifact-history.spec.ts`**: imports are VB-3's list (`openCanvasPanel`, `openChatAndReload` from `artifact-canvas-helpers`,
  `waitForHydration`) with `createEmptyConversation`; VB-3's 7 new `createConversation` calls (board T7, App T6 x3, library cell, two phone
  tests) get the same change; none of them wants a first turn (each seeds rows and clears the pending message, and the file now also
  imports a helper that clears it). The result differs from `feat/artifacts` only by those replacements.
- `artifact-app.spec.ts` and `artifact-canvas-review.spec.ts` merged cleanly: VB-3 changed copy only ("Rebuild", History instead of
  Versions, the Undo/Redo summaries), FG its helper and tags; the `@smoke` tags of both are intact.

## A test that was not part of the merge: VB-2's T9 and T4 (fixed in `379b1e28`)

The whole-suite run on the merged tree (`4a3bb8fb`) had **one** failure in 1036 tests: `artifact-history.spec.ts` T9 ("the rail is a
listbox of sentences that arrow keys walk"), `not.toContainText("then a cafe")` after End. Alone: 6 of 6 green, so load. The cause is in
the assertion, not in the app: History makes the preview anew for every moment (`{#key selected.versionId}` in `HistoryMode.svelte`) and a
new preview is an empty skeleton (`aria-busy="true"`) for the ~30 ms its bodies take. The first draft has no parent, so it is shown
against now, and the seeded versions have different block ids, so the loaded preview holds the struck "then a cafe" too: the absence is
true only in the skeleton. Measured with a temporary instrumented copy of the test (deleted): +0 ms text empty and busy, +30 ms all
eight blocks, unchanged at +1000 ms. On a quiet machine the first poll lands in the skeleton; under load it does not. The phone test
T4 has the same assertion after `older.tap()` twice (same measurements, had not failed yet). Both now wait for `aria-busy="false"`,
check the label names the first draft, and look for the draft's own last line ("Belvedere in the morning."). That checks that the
preview followed the selection, which the absence never did. T9 22/22 and T4 10/10 repeated on four workers. I scanned the other
absence assertions in the file: the rest follow a positive assertion that waits for the load, or are true in both states.

## Gates

| # | tree | run | result |
|---|---|---|---|
| 1 | `3f858598` | `npm test` | 1,054 files passed (1 skipped), 17,728 tests passed (2 skipped), exit 0, 2m29s (includes the conventions test) |
| 2 | `3f858598` | `gates.sh agent --port 5500 --workers 4 --skip vitest` + 10 specs (versions, document-comments, history, canvas, card-narrow, chat-card, document, panel-names, panel-popover-press, panel-swap) | ALL GATES PASSED, 3m37s; Playwright 142 passed, 0 failed, 0 flaky. Vitest skipped only because run 1 had just run on the identical tree |
| 3 | `4a3bb8fb` | `npm test` | 1,055 files passed (1 skipped), 17,753 tests passed (2 skipped), exit 0, 2m24s |
| 4 | `4a3bb8fb` | `gates.sh agent --port 5500 --workers 4`, every step, 12 specs (the 10 + `artifact-app` + `artifact-canvas-review`) | **ALL GATES PASSED**, 6m05s: check 0 errors / 17 warnings (= baseline), biome clean (2,606 files), migrations ok, vitest 1,055 / 17,753, build 32 + 2 (= baseline), chunks exit 0, Fallow 124 / 4 cycles / 0 new vs baseline, Playwright 174 passed, 0 failed, 0 flaky |
| 5 | `4a3bb8fb` | `gates.sh release --skip check,biome,migrations,vitest,fallow,chunks` (the whole suite) | 975 passed, 60 skipped, **1 failed** (T9 above), 0 flaky, 6 workers, 8m18s; rerun alone 6/6; cause found, fixed |
| 6 | `379b1e28` (final) | `gates.sh release --port 5500`, every step | **ALL GATES PASSED**, 8m36s: check 0 / 17, biome clean, migrations ok, vitest 1,055 / 17,753 (7m17s: it runs on three threads beside the e2e in this schedule), build 32 + 2, chunks exit 0, Fallow 124 / 4 / 0 new, **Playwright 976 passed, 60 skipped, 0 failed, 0 flaky on 6 workers** (8m19s) |

Logs: `p5/mfg-gate-1 .. mfg-gate-4` (`summary.txt` in each), `p5/mfg-npm-test*.log`.

## VB-3's chunk question

- `npm run check:artifact-chunks` exits **0** on the merged build (also inside runs 4 and 6). The chat route's byte baseline no longer
  exists: its line now reads "82 chunk(s), 550,946 bytes gzip (information only, no budget)" (VB-3's tree: 550,950) and what holds
  it is the forbidden-library rule (`chart.js`, `maplibre-gl`, `mermaid`, `@xyflow`, `prosemirror-view`/`-model`, `@tiptap/core` may not be
  reachable by static imports from `/(app)/chat/[conversationId]`), which passes. VB-3's one FAIL line (the inherited +8,9xx B) is gone.
- Editor: target chunk 62.9 kB gzip (limit 65,000 B); exclusive closure **72,621 B** on the final build (70.9 kB in the script's
  KiB-labelled output; 72,629 B on the run-4 build; VB-3 left 72,623) against the **72,704 B ceiling: about 80 B of headroom**. The
  figure wobbles by a few bytes between builds (chunk-hash text inside the gzip), so any further change to the editor's first paint
  needs a measurement before it is believed; I measured with VB-3's `p5/vb3-closure.mjs`.

## Concerns and things for the orchestrator

1. T9/T4 above is a VB-2 test defect that only a loaded, parallel run exposes; fixed here, but anything VB-side that asserts an absence
   right after a keyed re-creation (History, the Canvas preview) has the same shape and passes only by luck. Worth a line in the specs'
   author brief.
2. The editor ceiling has ~80 B of headroom (above).
3. FG's two hand-offs to the orchestrator are not done here: `phase-5/common.md` "Your Playwright scope is tiered" and `wave-3/common.md`
   gate 5 should be replaced by the `scripts/gates.sh agent ...` command; the M3 baselines in `common.md` are unchanged (check 0 / 17,
   build 32 + 2, Fallow 124 / 4); vitest is now 17,753 tests in 1,055 files; Playwright 976 + 60 skipped.
4. The `AGENTS.md` chunk bullet was combined by hand: one paragraph worth reading before the branch is taken.
5. Every gate above ran with other agents' load on the Mac (load 9-17 at times); the one load-sensitive failure was reproduced and
   explained, not retried away. Run 6 is the clean number for the final tree, which has no known flake left.
