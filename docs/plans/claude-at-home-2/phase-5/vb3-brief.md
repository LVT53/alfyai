# VB-3 — versioning build, the Canvas and the App in History

The owner approved the versioning design (ruling 76). VB-1 built the server (moments, restore guard, naming, paging,
the old-App version route) and VB-2 built History mode, the latest moment on every surface and the Document's preview;
both are merged into your base. You build agent 3 of `versioning.md` §12: the board's and the App's previews in History,
and the end of the old Versions sheet. Read `phase-5/common.md` and the two files it names first, then ruling 76 (end of
`docs/plans/claude-at-home-2/decisions.md`), VB-1's and VB-2's reports (`<scratchpad>/p5/vb1-report.md`,
`vb2-report.md`, their hand-off sections first) and, from `docs/design/artifacts-versioning/versioning.md` (by range):
§3.1, §5.4 (the preview), §5.5, §5.10, §6 (per kind), §7, §8 (the strings), §10's browser table (the Canvas and App
rows), §11 (T6, T7). The mockup's Canvas and App stories (`index.html`, open it in a browser against `file://`; never
read it whole) are the visual reference.

- Branch / worktree: `feat/versioning-canvas-app` in `.claude/worktrees/art-vb3`, made for you from `feat/artifacts`
  after VB-2's merge. Ports 5440–5449.
- Report: `<scratchpad>/p5/vb3-report.md` (`<scratchpad>` is in common.md).

## What you build

1. **The board in History.** `canvas/history-parts.ts`, a new lazy entry, with `CanvasVersionPreview.svelte`: a
   read-only `CanvasBoard` at that version with the diff layer (`diffBoards`: changed blocks ringed in Alfy's or the
   reader's colour as the review landing rings them, added ones tagged New, removed ones as dashed ghosts, moved ones
   with a faint trail), "This version's changes / Compared with now", registered in VB-2's per-kind preview registry.
   It imports no `@xyflow/*` statically outside the board and no module the editor's first paint shares with it
   (ruling 68: measure with `npm run check:artifact-chunks`; the editor's ceiling does not move for this). The Canvas
   review pill's Redo saves with `summaryKind: "redid_alfy_change"` (VB-1's vocabulary) instead of "Edited".
   `CanvasEditor.svelte` drops its `VersionsSheet` mount; the header's history button opens History for a board.
   The restore question names the board, not "text" (today the Canvas reuses the Document's "A jelenlegi szöveged…").
2. **The App in History.** `app/AppVersionPreview.svelte`: Preview (an `AppFrame` pointed at VB-1's version route,
   storage read-only: a write inside the frame is refused) and Code (a line diff of the source), registered in the
   registry; the App's header opens History. **Security (VB-1's hand-off, a condition of the old-App route):** the
   preview frame's `src` is the version route (with `?conversationId=` in an incognito chat), the same
   `sandbox="allow-scripts allow-forms"` as the live App, and **the parent refuses every `alfy.storage` `set` message
   in preview mode** — a hostile old version can post raw messages whatever its bridge says; a 422 `not_runnable`
   answer means "Code only". The Opus review reads this part first. An App rebuild's Undo restores with the rebuild's
   number, as VB-1's report says. The regenerate flow's copy stops hard-coding versions: today "Make v2",
   "Now showing v2", the building and failure lines and the toast are literals (on a second regenerate the header said
   v3 and the toast v2), and the popover's "v1 stays in History" becomes true now that History exists. The App's delete
   confirmation names its versions like the Document's and the Canvas's (`artifacts.delete.body.app`).
3. **The old sheet goes.** Once nothing imports them, delete `document/VersionsSheet.svelte` and
   `document/version-summary.ts` (and their tests), and anything only they used (Fallow will tell you).

New strings in your own block of `src/lib/i18n/artifacts.ts`, EN and HU in the same commit (HU from §8). Reduced motion,
44 px phone targets, Lucide icons, semantic tokens.

## Tests and gates

Red first, real input: T6 (App: regenerate → History → the first version's preview runs with storage read-only → Code
shows the diff → Restore) and T7 (Canvas: an Alfy diff → Undo on the review bar → History folds it → the preview rings
the changed blocks → Restore), in `tests/e2e/artifact-history.spec.ts` beside VB-2's (append, keep both). Screenshots
you look at yourself, at most 6: the board preview and the App preview at 1440 docked and 390, HU, one dark. Gates once
at the end as common.md says; Playwright = `artifact-history.spec.ts`, `artifact-app.spec.ts`, `artifact-canvas*.spec.ts`
(the canvas suites are long: run them once), `artifact-versions.spec.ts`; `check:artifact-chunks` exit 0.

Final reply at most 12 lines: status, **your model ID**, commit range, gate summary, the screenshots to look at first,
concerns.
