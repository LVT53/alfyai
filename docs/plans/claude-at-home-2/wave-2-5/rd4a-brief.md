# Agent 4a · Selection pill and composer, Alfy writing in place, the pinned refusal (steps 9 and 11)

Runs after agents 1, 2, 5a, 5k, 5b and 3a (all merged). **Agent 3b runs at the same time as you** and owns the phone
Comments sheet, the narrow-panel drawer, `VersionsSheet.svelte` and `DownloadSheet.svelte`. Put your new logic in your own
components and modules (new decorations in their own module, registered from `extensions.ts` with a small change), keep
your `DocumentBody.svelte` edits to mounts and handlers, and add i18n keys inside your existing blocks (selection bubble,
Alfy writing, refusal), never at the end of the `en`/`hu` objects. Read the **hand-off sections** of `rd/rd1-report.md`, `rd/rd2-report.md`, `rd/rd5a-report.md`, `rd/rd5b-report.md` and `rd/rd3a-report.md` first and
reuse what they name (tokens, `reducedMotionAnimate`, `ArtifactPanelHeader`, the rail and `CommentCard`/`CommentThread`,
the comment-anchor decoration). Agent 4b (the change pill, the review bar, pending review across reloads) comes after
you: leave `ChangeBar.svelte` and the review bar alone.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-rd4a`, branch
  `feat/artifacts-rd4a-compose`, e2e port **5430**, label `rd4a`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/rd4a-report.md`
- Screenshots: `…/scratchpad/rd/shots/rd4a/` (same scratchpad as the report).
- Read first: `rd/common.md` next to this brief.

## Read in `redesign.md`

§4.1 (280–310), §4.2 items 1–4 (lines 311–333) and the "Refusal" paragraph (351–364), §4.3–4.5 rows about the pill,
composer, Alfy writing and refusals (376–420), §8's selection-pill / `AlfyWriting` / `RefusalNotice` rows (735–737),
§9.2 rows for `SelectionBubble.svelte` + `bubble-placement.ts`, `AlfyWriting.svelte`, `RefusalNotice.svelte` and the
decorations in `extensions.ts` / `document-editor.ts` (771–780), §7 (the pill growing into the composer, the travel to
the margin, the writing state). Mockup: `#bubble` and its composer mode.

## Step 9 · Selection pill and composer

`document/SelectionBubble.svelte` (keep `data-testid="selection-bubble"`; keep `bubble-placement.ts`'s viewport
clamp and flip, now aware of the composer's height): a horizontal pill "Ask Alfy · Comment" above the selection (below
when there is no room); Ask grows into a 340 px composer anchored to the same spot with the quote, suggestions and the
effect line; Comment has the `@Alfy` switch; the selection keeps a pending highlight; on send the composer travels to
the new thread's place in the margin and becomes the card (§7, reduced path: no travel). Phones: a docked bar and a
sheet composer (`DialogShell` `phonePresentation="sheet"`).

## Step 11 · Alfy writing, the refusal, typing

- `document/AlfyWriting.svelte` in place: a block decoration (gutter bar, dimmed content, the "Alfy is writing: …"
  tag) and the dashed planned-section box for new sections, shown for **at least 600 ms** (test it with fake timers)
  instead of the grey banner above the text.
- The refusal ("your words win") as a warning card of the comment family pinned beside the refused line, with a dashed
  amber rule on the line, "Ask again" and "Dismiss" (keep `data-testid="refusal-notice"`); also export the one-line
  summary agent 4b's review bar will show.
- Alfy's typing placeholder in threads ("Alfy is reading…" then "Alfy is writing…") if agent 3a did not finish it.
- The in-chat card's **"1 part left alone"** pill (agent 5a's deviation list in `rd/rd5a-report.md`): the count of
  undismissed refusal notes, shown beside the existing "N changes to review" pill, fed from the same place your refusal
  summary comes from.

## Tests and screens

- Tests first: pill placement above/below and the composer-height-aware flip; Ask → composer → send creates the thread
  at the right place; Comment with `@Alfy`; the 600 ms minimum; the refusal card's actions and pinning; phone bar and
  sheet; reduced-motion paths; focus and accessible names.
- Playwright at the end (port 5430): `tests/e2e/artifact-document-selection-bubble.spec.ts`,
  `artifact-document.spec.ts`, `artifact-document-comments.spec.ts`, `artifacts-panel.spec.ts`.
- Screenshots in Hungarian: the pill and the open composer at 1440×900 light; the phone docked bar at 390×844; a
  pinned refusal at 1440×900 dark.
