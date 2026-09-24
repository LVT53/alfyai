# Wave 4 adversarial review — Slice E (Folder Knowledge)

**Date:** 2026-09-24. **Reviewer:** one, in its own worktree, not the implementer.
**Branch under review:** `feat/workspaces-e` (13 commits, 64 files, migration `…109`).
**Review branch:** `feat/workspaces-e-review`, eleven commits, merged as `e0275a04`.

This was the longest review of the run and it found the most consequential defects: a table pointing at real
library files is where a mistake costs a user their data.

## Defects found and fixed

| # | Defect | Evidence |
|---|---|---|
| 1 | **A race that could resurrect a removed row.** The project page assigned the file list from whichever read resolved *last*, so a read that started before a removal could land after it and put the removed row back — with its Remove button. Fixed with the house sequence pattern; the e2e test holds the first read open via `route.fetch()` plus a release gate, because merely delaying `continue()` would fetch the post-removal answer and reproduce nothing. | failed on the resurrected row before, passes after (`45d645bd`) |
| 2 | **The Files modal had no phone layout.** The slice shipped desktop-only CSS for §M5. A phone treatment and an e2e test were added; the test fails against the removed media query. | `80139c3b` |
| 3 | **An order-sensitive CSS rule that nothing would have caught.** `.info-popover-forced-closed` must follow the `@media (hover: hover)` rule — order, not specificity, makes the press win. Worse, the obvious guard would have matched the *comment* that quotes the hover selector, so the test is anchored to the real rule position instead. Verified by deliberately reordering: fails with `expected 61364 to be greater than 61839`. | `cb1e0f3d` |
| 4 | **Five incognito allow-list exemptions were dead** — they could never be consulted (two files read none of the guarded tables, one selects by nothing, two already carry the scope marker). A dead exemption silently goes live the moment somebody writes the query it covers. Removed, and the honesty test now *requires* every entry to be reachable, so a stale exemption fails the suite. | `b07c7553` |
| 5 | A comment claimed a UI that does not render the "more" label; the EN/HU key is contract-mandated, so the comment was corrected rather than the key deleted. | `637bb923` |

## Cleared, with evidence

- **Ownership, end to end.** Every write is scoped by a server-derived `userId` and validated before any row is
  written. Constructed and pinned: another user's artifact, another user's project, a nonexistent artifact (all
  404 with **zero rows written**), another user's files unreadable, another user's file not resolvable by name,
  upload into another user's project refused, and — new — **a second user cannot unlink the owner's link**, not
  even through a project of its own.
- **Non-destruction, verified on disk.** Unlink issues exactly one `DELETE` against the link table, never
  `artifacts` and never the filesystem; a second unlink is a no-op; project deletion cascades links and keeps
  library files; deleting a library file leaves no dangling link. The byte checks read
  `data/knowledge/<userId>/<artifactId>.<ext>` before and after — the filesystem, not just the rows.
- **The "+N more" cap.** One walk produces both the body and the counts, so `+N more` is always
  `files.length - listed` and can never disagree with the list. Attacked at the exact 1500-character boundary, a
  name longer than the whole budget (dropped, counted, never clipped), zero files, 30 exactly, 31, newlines and
  U+2028 in names, and under packet pressure — `protected: true` holds.
- **The failing-open mention path** (`context-selection.ts:708-713`) is **deliberate degradation, not a hole**:
  the `.catch(() => [])` wraps only resolution, and every policy gate (ownership, prompt-readiness, attachment
  dedupe) runs downstream, awaited with no catch, still failing the turn with its 409. Only infrastructure errors
  reach the catch, and the worst outcome is "the model did not receive a file the user named" — never an added
  source. Residual: the swallow is silent, with no log.
- **Prompt-prefix determinism:** a total sort order (name, then `linkedAt` desc, then artifact id) is shared by
  the Files modal, the prompt section and the read targets.
- **Svelte 5 reactivity** in both new dialogs: effects read only `open`, every write inside is `untrack`ed.

## Reported, not fixed — and now being fixed separately

- `upload-intake.ts:352` rethrows any non-`ProjectKnowledgeError`, and the link is awaited at `:403` **before**
  `registerUploadExtraction` at `:413`. An unexpected failure therefore 500s an upload whose bytes are already
  saved **and** skips extraction registration, so the file never becomes prompt-ready — the opposite of the
  function's doc comment. The reviewer reasoned this from the code without reproducing it, so a separate agent
  has been dispatched with the instruction to **reproduce it or prove it impossible before changing anything**.
- `knowledge/_components/DocumentsList.svelte:1470-1475` renders the search *label* as the no-match empty state.
  Same agent, same "confirm first" rule.
- The unlink delete's `userId` term is **defence in depth, not the load-bearing guard** — removing it by mutation
  did not fail the cross-user test, because the delete is already pinned to a project the caller proved is theirs.
  Recorded in its commit rather than claimed as pinned.

## Gate numbers

`npm run check`: 0 errors, 17 pre-existing warnings. Biome: clean. `npm test`: **11 924 passed / 2 skipped**, 785
files. `npm run build`: exit 0, 34 baseline warning lines. Migrations pass; the table is registered in
`user-scoped-tables.ts` (erasure cascade, resets workspace) and `prepare-db.ts`. Fallow: 4 cycles, 124 issues,
unchanged. Playwright `project-files.spec.ts`: 10 passed.

**One caveat the reviewer raised and could not attribute:** a single vitest run printed `Errors 1 error` alongside
identical pass counts, and the immediate re-run was clean. **The orchestrator re-ran the full suite on the merged
branch and it did not reproduce** — 11 886 passed, 2 skipped, no error line. Treated as a flake, not a defect, and
recorded here so a future reader who sees it knows it was investigated rather than ignored.

## Deployed

`dev` pushed `3aeea01f..6a5b8fe8`; deployed as `6a5b8fe8`.
