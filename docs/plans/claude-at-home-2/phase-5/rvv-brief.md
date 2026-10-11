# RV-V — Opus review of the versioning batch (VB-1, VB-2, VB-3), before `dev`

The owner approved the versioning design (ruling 76) and three Sonnet agents built it: VB-1 the server, VB-2 History
mode, the latest moment and the Document, VB-3 the Canvas and App previews and the old sheet's removal. You review the
batch adversarially before it reaches `dev`; **you fix nothing** (one fix agent follows from your report). Read
`phase-5/common.md` and the two files it names first (skip their build sections), then ruling 76 (end of
`decisions.md`), the three reports (`phase-5/vb1-report.md`, `vb2-report.md`, `<scratchpad>/p5/vb3-report.md`) and
`docs/design/artifacts-versioning/versioning.md` §3, §4, §5.5, §5.10, §9 (by range).

- Worktree: `.claude/worktrees/rv-v`, detached at the `feat/artifacts` head the orchestrator names in your prompt; e2e
  DB prepared. Port **5490**. The batch is `git diff 2e31b613..HEAD -- src tests drizzle scripts` (2e31b613 is
  `feat/artifacts` just before VB-1).
- Report: `<scratchpad>/p5/rvv-report.md`; screenshots `<scratchpad>/p5/rvv-shots/` (at most 10, each looked at).

## What to check, in this order (the expensive mistakes first)

1. **The old-App version route and its preview** (security, ruling 58 in full first):
   `src/routes/api/artifacts/[id]/versions/[versionId]/app/+server.ts`, its tests, `app/bootstrap.ts`
   (`APP_READONLY_BOOTSTRAP_SCRIPT`), the `APP_SERVED_ROUTE_PATTERN` change in `src/hooks.server.ts`, and VB-3's
   `AppVersionPreview.svelte` with the parent's refusal of `alfy.storage` `set` in preview mode. Can an old version
   (written by a prompt-injected turn) escape the sandbox, write storage, reach the network beyond what the live App
   may, read another App's or user's data, or be served for a version that is not the caller's own? Do the headers
   equal the live App route's, entry by entry? What happens with a version id of another artifact, of a deleted
   artifact, of an incognito chat's App without `?conversationId=`?
2. **Ownership and scope of every new or changed route** (`history`, `versions/[versionId]` PATCH, restore,
   the version app): `requireApiUser`, the scoped read (`readScopedArtifactRow`), byte-identical 404s for a foreign and
   a missing id, incognito with `?conversationId=` (ruling 51), the facade rule (nothing outside `services/artifacts/`
   queries the artifact tables), the account archive and Clear Memory with the new columns.
3. **The restore guard and the coalescing:** `restoreVersion` with `expectVersion`/`undoOf`, the restore toast's Undo,
   a restore racing an unsaved editor step (T5) and a landing Alfy change, ruling 47 as amended (A2: same summary, no
   label, last save under 10 min, burst under 30 min; `started_at`), the migration `1777140000113` and prepare-db's
   required pieces (ruling 29).
4. **What History says is true:** `deriveMoments` and the fold rules F1–F4 against the rows (no row hidden; time order
   kept where an Undo does not follow its change), `body_hash` markers, review statuses against ruling 61/63's marker
   and `computeCanvasReview`, the Document's pending computation cost when a change waits, the in-memory detail cache
   (labels of a deleted artifact kept until evicted: say whether that is acceptable).
5. **The chat-turn edges:** `create_artifact`/`edit_artifact` now put `versionId` (+ `parentVersionId`) in the tool
   call's metadata for "From the chat" (can a forked or another chat's message link reveal anything?); the Document now
   registers `flush`, so a fresh turn waits, bounded, for its autosave (does a stuck save ever block a turn?).
6. **The surfaces and the one source (A1):** no version number left on any surface but History's fine print (header,
   list rows, chat card, Knowledge table); the latest moment from `artifact-versions.ts` only; the lazy entries
   (`history-parts.ts`, `canvas/history-parts.ts`) and `check:artifact-chunks` (the editor's ceiling; no heavy library
   in the chat route).
7. **A walk like the owner's** (the real UI on a production build with the e2e fake provider; Hungarian; 1440 docked and
   390; light and dark; mouse, keyboard and touch): a Document with Alfy edits, an Undo, a restore and its toast Undo,
   a named version, paging; a board with an Alfy change undone and restored; an App rebuilt and its first version
   previewed. Note anything that reads oddly in Hungarian.

## Report

Findings by severity (**Critical** / **Important** / **Minor**), each with the file:line, the steps or input that shows
it, and why it matters; then a verdict (**ready for `dev`** / **ready after fixes** / **not ready**) and the screenshot
paths. Final reply at most 12 lines: verdict, **your model ID**, counts by severity, the top three findings.
