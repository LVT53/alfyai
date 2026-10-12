# FB-5 report: rows, headers and the phone (F7, F21, F9, F26, F29, F28) — DONE_WITH_CONCERNS

Branch `fix/friction-rows` (worktree `.claude/worktrees/art-fb5`), from `feat/artifacts` (FB-1, FB-2, FB-3 merged).
Model: claude-sonnet-5-5. Ports 5400-5409.

## Status per item (updated as I go)

| Item | State | Commit |
|---|---|---|
| Step 0: eval types for `edit_artifact`'s `instruction` | done | 4d1ab882 |
| F7 Back closes the top layer | done: 14 e2e (390 touch + 1440) + 22 unit | f0b3ed0a |
| F26 count button on the phone | verified by e2e (X, then the count button brings the item back; also after a Back); nothing left to finish | in f0b3ed0a |
| F21 one header for a File | done | ed019f95 |
| F9 same-name rows | done | 6d58442c |
| F29 Regenerate progress in the list | done (desktop + phone) | 4080fbdc |
| F28 crumb "Vissza" (owner's instruction) + landing project card | done | 00f3814c |
| AGENTS.md bullets (history entries, rows and headers) | done | f0b3ed0a, 8a73ca06 |
| Agent gate | run 3 at ed9404c0: all green except 5 pre-existing failures (below) | 4d1ab882..ed9404c0 |

## Step 0
`svelte-check` had 3 errors on the base: `scripts/eval-artifact-contracts/suites/canvas-tools{,.test}.ts` did not know `instruction`.
Underneath was a real gap: the simulator's gate (`editGate`) never listed `instruction`, so zod stripped it, and the parity test's
call into the real tool did not forward it. Both sides ignored the field and FB-2's two new scenarios ("an instruction beside
ops", "an instruction for a board") passed for nothing. `appInstructionSchema` now lives in `tool-args.ts` (the database-free file
the eval already reads `jsonArrayArg` from): one object the model is shown, a call is validated with and the eval's gate reads
(ruling 62). Test red first (forwarded the field: 2 failures), then green. `npm run check`: 0 errors / 17 warnings.

## F7
`src/lib/client/panel-history.ts` (new, pure planner + controller, no Svelte/SvelteKit imports), wired in the chat page
(`panelLayer`, `applyPanelLayer`, `createPanelHistory`, one `onMount`, two `$effect`s). Entries live in SvelteKit's `page.state`
(`App.PageState.alfyPanel`). Layers: the panel (list, or an item opened straight from a card) = 1 entry; an item opened from the
list = a 2nd. Closing (X, Escape, outside press, count button, crumb) pops what it added; Back/Forward apply the entry's layer
through `openArtifactList` / `selectWorkspaceDocument` / `closeWorkspace`. Reload keeps the entry (read from `history.state`), so
after a reload Back still steps item, list, closed, leaves.
Tests: `tests/e2e/artifact-panel-history.spec.ts` (14: at 390 touch and 1440 mouse: Back x3, forward/back round trip, card-opened
item is one entry, the crumb, X and the count button leave no stale entry, count button brings back the item; Escape; reload) and
`src/lib/client/panel-history.test.ts` (22). Neighbouring specs on the change: artifacts-panel, popover-press, delete, swap: 27 passed.

## F21
A produced file opened from a chat card carried no `kind`, so the panel drew its older header ("AKTÍV DOKUMENTUM", title with an
arrow, an AI chip, an icon-only back) while the list's open of the same file got the standard one. `openWorkspaceDocument` (the one
place every open goes through) now gives a produced file that arrives with an artifact id the File kind and the moment/regenerable
flag of its row (`asArtifactFile` in the chat page). Atlas reports and uploaded/library documents carry no artifact id and keep
their header (they are not Files of the family). Existing test `page-runtime.test.ts` ("opens a produced file from its row...")
asserted the old provenance chip; it now asserts the standard header (intended change). Screenshot `f21-file-header-from-card-1440-hu.png`
(the preview body says "Failed to load file" only because my seeded bytes are markdown under a .docx name).

## F9
`components/artifacts/row-facts.ts` (new, pure): a file row says its extension and size after its kind ("Fájl · DOCX · 122 B"), a row
whose name another row shares says when it was made ("Alkalmazás · 12:08", or the day and clock for another day) in the app's 24-hour
clock; no version number (ruling 76). `ArtifactCardView.rowFacts` carries it to the row and to its accessible name. The size
travels on `DocumentWorkspaceItem.sizeBytes` (set from the chat's generated files). Knowledge's rows and global search are separate
components (the row chrome is used only by the panel's list), so they are not touched here (FB-1 owns Knowledge).
Screenshots `f9-list-1440-hu.png`, `f9-list-390-hu.png`.

## F29
The panel's list shows an item being made again (Regenerate on a deleted card) as a row: `WorkspaceList.pending`, a spinner in the
kind's icon place, "Újragenerálás…" after the kind, no button until the item exists, not dimmed; titled/kinded from the chat's own
create call (`createdArtifactOf`, shared/artifacts/artifact-calls.ts); it gives way to the real row (no duplicate in between). Tests:
desktop (held regenerate request) and phone (list opened after the press). A "Document made by Open as document" has no create
call, so it has no pending row (its card button still shows the work). Screenshot `f29-regenerating-1440-hu.png`.

## F28 (and the owner's note on the crumb)
- Hungarian crumb "Ez a beszélgetés" -> **"Vissza"** (new key `artifacts.panel.crumb`); English stays "This chat" (it never wrapped).
  Accessible name says where it goes: "Vissza a beszélgetés elemeihez" / "Back to this chat's items" (`artifacts.panel.backA11y`).
- **The count is dropped from the crumb** (its prop `itemCount` and badge are gone): the list's own subtitle ("10 elem · legújabb
  elöl") already says how many, and "Vissza 1" reads oddly.
- The crumb has `white-space: nowrap`, so the phone crumb is one line (screenshot `f28-crumb-390-hu.png`).
- **Not changed, on purpose:** the list header's eyebrow ("EZ A BESZÉLGETÉS", above "Amit ez a beszélgetés készített"). It is a
  heading with no chevron and no action, not a way back, and "Vissza" there would be wrong. It uses the old key
  `artifacts.panel.eyebrow`; say so if the owner wants it shorter or gone too.
- Tests/screenshots that read the old label were updated: `ArtifactPanelHeader.test.ts`, 5 assertions in `DocumentWorkspace.test.ts`,
  the tours helper `backToList` (`tests/e2e/artifact-tours-helpers.ts`).
- Landing project card: the stats line ("1 csevegés · aktív: 3 órával ezelőtt") no longer ellipsises; it wraps (390 and 1440 tested;
  screenshot `f28-project-card-390-hu.png`).

## Notes for the next agent / concerns
- History mode of the panel (VB-2) is not a history layer: Back while History is open closes the item/panel, not History. A
  possible follow-up (FB-8 owns `history/HistoryMode.svelte`).
- The Knowledge page's and project dialog's panels are single-layer overlays outside the chat page; Back there still leaves the
  page. `createPanelHistory` is generic, so wiring them is small if wanted.
- Reload with a panel layer open: the entry survives (read from `history.state`), so Back still steps down; the first Back after a
  hard reload is a router "popstate" navigation to the same URL (SvelteKit's behaviour before it has navigated), which showed no
  visible side effect in the e2e.

## Gate (`scripts/gates.sh agent <out> --port 5400 --workers 4`, run 3 at `ed9404c0`; logs in `fb5-gates/`, run 1 in `fb5-gates-run1/`)
Specs named: artifact-panel-history, artifact-panel-rows, artifact-panel-motion, artifact-panel-names, artifact-panel-popover-press,
artifact-panel-swap, artifacts-panel, artifacts-panel-scope, artifact-chat-card, artifact-delete, project-panel-over-dialog,
home-projects (in full) + the `@smoke` set.
```
check      ok   0 errors, 17 warnings (baseline) in 8,469 files
biome      ok   2,633 files
migrations ok
vitest     ok   1,063 files, 18,038 tests passed, 2 skipped
build      ok   unused-css=32 aria=2 (baseline 32/2)
chunks     ok   editor closure 70.9 kB gzip; chat route first paint 554,753 B in 82 chunks (information only)
fallow     ok   total=124 circular=4 new_vs_baseline=0 gone_vs_baseline=0
playwright FAIL 134 passed, 0 skipped, 5 failed, 0 flaky (production build, 4 workers, 1m37s)
```
Run 1 (8a73ca06) had two vitest failures (two page-runtime tests looked the crumb up as /This chat/) and the e2e step refused to
start because I had edited a `src` test file during the run (the build-freshness guard); run 2 I stopped myself (by PID) when biome
flagged a missing format on that same test file; run 3 is the clean one.

**The 5 failures are not from this work.** All are in `tests/e2e/artifacts-panel-scope.spec.ts` (:161, :180, :244, :283, :313), in its
helper `goToChatInTheApp`: `ensureSidebarExpanded` presses "Expand sidebar" with a panel open (1280 x 720) and the sidebar stays a
rail. Reproduced alone in dev mode; reproduced with my history entries switched off; and **reproduced identically on the untouched base
commit `d4e5d3ad`** (a temporary worktree of mine, since removed: tests 1 and 4 pass, 2/3/5/6/7 fail). Cause, from the page snapshot and
`stores/ui.ts`: FB-3's `toggleSidebarCollapsed()` answers a press while `sidebarFoldedForPanel` is true by dismissing the fold only
(`sidebarFoldDismissed = true; sidebarFoldedForPanel.set(false)`), and leaves the reader's own `sidebarCollapsed` setting (collapsed,
here) alone, so the first press on the rail's button opens nothing: a reader whose sidebar is collapsed and who has a panel docked
under ~1300 px presses Expand and sees no change. FB-3's gate did not include this spec. Suggested fix (FB-3's file, not mine): do not
flag a fold while the sidebar is already collapsed (`setSidebarFoldNeeded(needed && !collapsed)`), or have the press also clear
`sidebarCollapsed`.
