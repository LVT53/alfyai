# VC — capture how versions behave today (report only, for the versioning designer)

An Opus designer (VD) is designing a version history a person can follow across Document, App and Canvas. The owner's
verdict on today's: "versioning is still crazy and unfollowable." Your job is the evidence: a factual inventory of what
writes a version and what each one looks like, and real screenshots of today's version surfaces in realistic histories.
**You change no product code.** Read `docs/plans/claude-at-home-2/phase-5/common.md` and the two files it names first.

- Worktree: `.claude/worktrees/art-vc` (detached at `feat/artifacts`, `node_modules` linked, e2e DB prepared). Base port
  **5410** (`E2E_PORT=5410`). Anything you write to drive the app (a capture spec, a seeding script) stays uncommitted
  in this worktree; copy it to `<scratchpad>/p5/vc-scripts/` at the end so a build agent can reuse it.
- Output: `<scratchpad>/p5/vc-report.md` and `<scratchpad>/p5/vc-shots/*.png` (`<scratchpad>` is the path in common.md).
- Timebox: about an hour. The designer is waiting for this; a good partial report on time beats a perfect late one.

## Step 1 — the inventory (from the code, ~15 min)

Every path that writes `artifact_versions` (insert or in-place update): creation (by a tool, "Open as document", a
regenerate under the same id after a delete), the reader's saves (the ten-minute coalescing in `updateArtifactBody`,
ruling 47), `edit_artifact` on each kind, an `@Alfy` comment reply that edits (Document and Canvas), an App regenerate,
a restore, Undo of Alfy's change (Document: per-block restore as a user edit; Canvas: the parent body as a user
version, ruling 63), Keep (does it write a version or only move the review marker?), a Canvas merge of the reader's
unsaved step with a landing change. For each: the function and file, `author`, the `summary` written, whether the number
bumps, and what the history row shows in HU and EN (`version-summary.ts`, `src/lib/i18n/artifacts.ts`). One table.
Also: what the header's version trigger shows and when it changes, where the App and the Canvas show their history (or
do not), and what the reader's Ctrl/Cmd+Z is labelled (ruling 16) next to a version undo.

## Step 2 — realistic histories and screenshots (~45 min)

Drive the real app with Playwright (real clicks and typing; seeding through the API, the e2e fake provider or the DB is
fine where the UI cannot get there, e.g. backdating `created_at` to end a ten-minute burst — say which you did). Look at
`tests/e2e/artifact-versions.spec.ts`, `artifact-document-review-bar.spec.ts` and `artifact-canvas-review.spec.ts` for
how existing specs make Alfy edits and versions.
- **A Document with about a dozen moments**: Alfy's first draft; the reader types (one burst), later types again (a
  second burst); Alfy edits a section; the reader undoes Alfy's change; an `@Alfy` reply edits a paragraph; the reader
  restores an earlier version; a pending Alfy change under the review bar.
- **An App**: created, regenerated, edited by Alfy, restored.
- **A Canvas**: Alfy adds blocks (diagram/notes), the reader keeps them, the reader moves and edits blocks, Alfy changes
  the board again, the reader undoes that, then restores.
- **Screenshots, at most 14**, Hungarian unless noted, light unless noted: the header's version trigger (1440, panel
  docked); the Versions popover on the long Document history (1440; once more in EN); the phone sheet (390); whatever
  restore shows (confirm? preview? nothing?); the history right after an Undo of Alfy's change; the history next to a
  pending review bar; the App's and the Canvas's version surfaces after their histories; one dark. Name each file for
  what it shows (`doc-history-1440-hu.png`, …). **Look at every screenshot yourself** before you list it.

## Step 3 — the confusion log (in the report)

As you build each history, write down at each step what the header said, what the list showed (number, words, author,
time) and what a person would reasonably have expected instead. Facts, not design: e.g. "after Undo the header went
v7 → v8 and the top row says 'Undid Alfy's change' with no link to which change", "v9 restores v3: both rows say
nothing about holding the same text", "two typing bursts an hour apart are two rows both reading 'Edited'".

## Report

`vc-report.md`: the inventory table, the confusion log, the screenshot list (file → what it shows), the scripts' paths,
and anything surprising (a path that writes a version you did not expect, a surface with no history at all). Final reply
at most 10 lines: status, **your model ID**, where the report is, the three most confusing things you saw.
