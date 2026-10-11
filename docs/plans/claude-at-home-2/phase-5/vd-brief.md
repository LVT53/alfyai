# VD — the versioning design pass (Opus): make an artifact's history followable

You are a product designer with an engineer's knowledge of this codebase. You design; you do not build. Your output is a
spec and a click-through mockup that the owner reviews before a line of product code is written, exactly like the
approved redesign in `docs/design/artifacts-redesign/` (`redesign.md` + `index.html` + `current/`), which the owner
loved. Read `docs/plans/claude-at-home-2/phase-5/common.md` and the two files it names first (skip their build and gate
sections: you change no product code and run no product gates).

- Branch / worktree: `design/artifacts-versioning` in `.claude/worktrees/art-vd` (made for you, `node_modules` linked).
- Write only under `docs/design/artifacts-versioning/`. Report: `<scratchpad>/p5/vd-report.md`; captures of your own
  mockup for the orchestrator: `<scratchpad>/p5/vd-shots/` (`<scratchpad>` is the path in common.md).
- Commit as you go (`docs(design): …`), trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## The problem, in the owner's words

After walking everything of Feature 2 on ai.dev (2026-10-11): "seems fine … a little clanky … **versioning is still
crazy and unfollowable**." A person cannot tell from the history what happened to their Document, App or Canvas, in what
order, by whom, or which entry to go back to.

What we know makes it unfollowable (verify each against the code and the screenshots; add what you find):
- Everything mints a numbered version: Alfy's edits (`edit_artifact`), an `@Alfy` comment reply that edits, an App
  regenerate, a restore, and Undo of Alfy's change (it saves the parent body as a new **user** version, rulings 61/63).
  The header's version number climbs and says little.
- The reader's own typing coalesces into their newest version for ten minutes (ruling 47): the row keeps one number and
  its time moves; the burst's start is not kept. Two bursts are two rows that look alike ("Edited").
- A newer version can hold older content (a restore, an Undo), so "v9" may equal "v3".
- Summaries are a thin vocabulary (`src/lib/shared/artifacts/version-summaries.ts`: "Edited", "Undid Alfy's change",
  "Restored vN", "Alfy wrote the first draft", plus Alfy's own free-text summaries), localized in
  `components/artifacts/document/version-summary.ts`.
- Two different undos exist by design (ruling 16): the reader's in-session Ctrl/Cmd+Z, and undoing an Alfy change or
  anything older, which is a version restore. They must stay distinguishable.

## Starting points (test them, do not just adopt them)

A timeline of named moments ("You edited · 3 min", "Alfy added the Rainy day frame", "Undone", "Restored to …"); the
reader's typing as one entry with its span; an undo shown on the change it undid rather than as a new top entry; no
bare version number in the header (what replaces it?); named versions the reader saves ("Before the client call");
preview before restore, with what changed highlighted; grouping by day; what a pending Alfy change (review bar, change
pill) looks like in the history. Reject any of these that do not survive a real scenario, and say why.

## What to deliver

1. **`docs/design/artifacts-versioning/versioning.md`** — the spec, in the redesign's shape: the problems observed (with
   the evidence: code paths, screenshots), the principles, then per surface (the header, the history list/popover, the
   phone sheet, preview, restore, the moment rows, the review bar and pill's relation to history, empty/one/long
   histories with paging, a deleted item, an incognito chat, an item made in another chat, a read-only fork) with
   **States, Accessibility (roles, names, focus order, keyboard, screen-reader announcements), Hungarian allowance**
   (HU strings run ~30 % longer; give HU copy for every string), motion (reuse the redesign's §7 vocabulary and reduced
   motion), and **per kind**: Document, App, Canvas (what a "moment" is for each; what a preview shows — a Document diff,
   an App's source and a running preview, a board's changed blocks).
   - **Server vs presentation, explicitly:** a table of what `artifact_versions` keeps today (`version_number`, `author`,
     `summary`, `body`, `body_hash`, `created_at`; no parent, no event kind, no label, no burst start — check
     `src/lib/server/db/schema.ts`), what each moment in your design is derived from, and what cannot be derived.
     **Prefer presentation over the existing rows.** Propose a migration only where the design truly needs a fact the
     rows do not hold (for example a reader-given name, or a burst's start), with the exact columns, the backfill for old
     rows, and the cost; then give the no-migration fallback for the same moment.
   - **Rulings:** rulings 1, 13, 14, 16, 47, 61, 63, 67 bind this area (`docs/plans/claude-at-home-2/decisions.md`; read
     them by range). Where your design needs a ruling or an AGENTS.md rule changed (for example AGENTS.md's "One version
     number on every surface", or ruling 47's coalescing), write it as a **proposed amendment**: the old text, the new
     text, the cost. Keep what those rules protect: one source for what a surface shows (today
     `subscribeArtifactChanges` + `src/lib/client/artifact-versions.ts`), the save guard (`expectVersion`), the review
     marker and Keep/Undo, Regenerate under the same id, the deletion cascade, the incognito scope.
   - **Implementation map:** the modules and components to change (server: `services/artifacts/versions.ts`, `record.ts`'s
     `updateArtifactBody`, `review.ts`, the restore path, the version-summary vocabulary; browser:
     `ArtifactPanelHeader.svelte`'s version trigger, `document/VersionsSheet.svelte`, the App's and Canvas's version
     surfaces — find them with `grep -rn`), the i18n keys (`src/lib/i18n/artifacts.ts`, EN + HU), the tests to write
     (red-first real-input Playwright per flow), and a suggested split into two or three build agents on disjoint files.
   - **Open questions for the owner**, each with your recommended answer, so the owner can reply in one message.
2. **`docs/design/artifacts-versioning/index.html`** — a click-through mockup, one self-contained file (inline CSS and
   JS, no network, no CDN; opens from `file://` and on a phone), using the app's tokens (copy the custom properties you
   need from `src/app.css`; UI chrome in the Nimbus Sans L stack, content in Libre Baskerville; Lucide-shaped icons drawn
   as inline SVG are fine in a mockup). It must have:
   - **A scenario the owner steps through**, the core of the review: e.g. Alfy writes a draft → you type for a few
     minutes → Alfy adds a section → you undo it → you type again the next day → you restore an older moment → Alfy edits
     through an `@Alfy` reply. At each step, **today** (the real screenshots from `current/`, or a faithful drawing where
     no screenshot exists, labelled as such) beside **the new design**. One scenario per kind (Document, App, Canvas),
     or one Document scenario in depth plus shorter App and Canvas ones.
   - Toggles: kind; Today / New; width (1440 with the panel docked, 1100 docked, 390 phone); light / dark; HU / EN (HU
     first: the owner walks in Hungarian).
   - Real interactions in the new design: open the history, move through moments with mouse and keyboard, preview a
     moment with its changes highlighted, restore (and what the history shows afterwards), Undo shown on the change it
     undid, name a moment, the phone sheet.
   - Screenshots referenced relatively from `current/` (not base64), so the file stays readable and diffable.
3. **`docs/design/artifacts-versioning/current/`** — the screenshots of today you use, copied from
   `<scratchpad>/p5/vc-shots/` (see below), renamed meaningfully.
4. **`<scratchpad>/p5/vd-shots/`** — at most 8 PNG captures of your own mockup at its key states (1440 and 390, HU,
   light, one dark), taken with Playwright against `file://…/index.html` (`npx playwright screenshot` or a throwaway
   script in the scratchpad), so the orchestrator can look without clicking through.

## Today's screenshots arrive while you work

A Sonnet agent (VC) is seeding realistic histories in the running app right now and capturing today's version surfaces
(header, Versions popover, phone sheet, restore, App and Canvas, HU and EN) with a factual inventory of every path that
writes a version and what each row shows. It writes `<scratchpad>/p5/vc-report.md` and `<scratchpad>/p5/vc-shots/`
within about an hour. Start with the code, the rulings and the redesign's language; the orchestrator will message you
when VC's report is in. Do not run the app yourself unless VC's material leaves a gap you cannot design without, and
then only briefly (port 5440, `E2E_PORT=5440`; the worktree's e2e DB is prepared).

## Inputs (read by range)

- `docs/design/artifacts-redesign/redesign.md`: §2 (design language), §4 (editing feedback: the change pill, the review
  bar), §5 (panel shell), §7 (motion), §8 (shared parts for Canvas), §9 (implementation map's shape). Its `index.html` is
  570 kB with embedded images: grep its structure and CSS, never read it whole.
- `AGENTS.md`'s Artifacts section (in your context): the one-version-number rule, Delete/Regenerate, the Document's
  keyboard (two undo families), the Canvas review paragraphs.
- Code: `src/lib/server/services/artifacts/{versions,record,review}.ts`, `src/lib/shared/artifacts/version-summaries.ts`,
  `src/lib/components/artifacts/document/{VersionsSheet.svelte,version-summary.ts}`, `ArtifactPanelHeader.svelte`,
  `src/lib/client/artifact-versions.ts`, `src/lib/client/api/artifacts.ts` (`subscribeArtifactChanges`), the restore
  route under `src/routes/api/artifacts/`, `normal-chat-tools/artifact-tools/recreate.ts`, the Canvas review parts
  (`components/artifacts/canvas/review-parts.ts` and what it loads). `tests/e2e/artifact-versions.spec.ts` shows how
  versions are made and listed today.

## Budget and stop

Aim for about two and a half hours. You are on Opus because the owner trusts an Opus design pass; spend the tokens on
judgment, not on reading: targeted greps, no whole large files. When the spec, the mockup and the captures are
committed, write the report (what you designed and why in ten lines, the decisions the owner must make with your
recommendation for each, the proposed rule amendments, the build split, what you could not verify) and stop. Final
reply at most 12 lines: status, **your model ID**, commit range, where to look first, open questions count.
