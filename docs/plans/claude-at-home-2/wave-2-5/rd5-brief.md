# Agent 5 · In-chat cards, App panel, Knowledge chips (redesign steps 12–14)

Third to run (after agents 1 and 2). Read the **hand-off sections** of `rd/rd1-report.md` (tokens, motion helper,
prose) and `rd/rd2-report.md` (the shared `ArtifactPanelHeader`, `ArtifactCard chrome="row"`, the panel motion, the
count button) before you start, and reuse what they name. Agents 3 (comments) and 4 (editing feedback) come after you:
leave the comment rail, the selection bubble, the change bar/pill and the review bar alone.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-rd5`, branch
  `feat/artifacts-rd5-cards`, e2e port **5440**, label `rd5`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/rd5-report.md`
- Screenshots: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/shots/rd5/`
- Read first: `rd/common.md` next to this brief.

## Read in `redesign.md`

§5.1 items about cards and §5.2 "In-chat cards" (lines 421–445 skim, 489–505), §5.3–5.5 card rows (506–537), §6 in
full (538–648), §7 (649–722, card arrivals, the chip-row reveal, the busy veil), §9.2 rows for `ArtifactCard.svelte`
(standalone), `ToolActivityRow.svelte`, the chat page's composer placeholder, `AppBody.svelte` / `AppFrame.svelte`,
`DocumentsList.svelte` and the i18n plurals (765–792). In the mockup: `.a-card` (`#cardDoc`, `#cardApp`, `#cardFile`),
the App panel ("d · App & Knowledge" → Open the App, Ask for v2) and the Knowledge chips ("d" → Go to Files).

## Step 12 · In-chat cards

Standalone cards below the tool-row group, outside the collapsible thinking area (`ToolActivityRow.svelte` and its host
message component); no millisecond timing for artifact tools; every state (creating, open in panel, to review,
failed, deleted); the edit card with "Review ›"; 44 px task ticks on phones; plural fixes (`artifacts.document.cardSubtitle`
"1 tab"); the composer placeholder names the open item. Restyle `ArtifactCard`'s standalone chrome; do not change
`chrome="row"` (agent 2's) beyond what a shared fix needs. Open item from Wave 2: the App card has no fact-check line
because the card summary has no App preview field — if the spec's App card shows one, add the field through the
artifacts read model (`services/artifacts/read-model.ts`, facade only) with a test; otherwise note it in the report.

## Step 13 · App panel

The status row under the header (verify line, Alfy's note toggle, glitch notices); a segmented Preview/Code control with
"Change this app…" beside it; the sandbox bar on the frame; the regenerate modal becomes a popover anchored to its
button (real button classes, the `focusTrap` attachment with `onEscape` and `restoreFocusOnCleanup`, a sheet on
phones); a non-blocking busy veil over a dimmed, `inert` v1 while v2 is made; a v2 toast with Undo; Download only in
the header (agent 2's `ArtifactPanelHeader` actions). Do not touch the frame's sandbox attribute, CSP or the bootstrap
(ruling 58's exact-string tests must stay green).
- **Decide the Open-documents rail for App and File.** §9.2 hides `OpenDocumentsRail` for every artifact kind; agent 2
  hid it for Documents only, because an App e2e security test switches between Apps through that rail (details in
  `rd/rd2-report.md`). Hide it for App and File too and move that test onto the panel list so it still proves the same
  thing — or keep the rail with a reason in your report.

## Step 14 · Knowledge chips

`src/routes/(app)/knowledge/_components/DocumentsList.svelte`: zero-count chips dimmed and disabled with a reason (a
tooltip/`title` plus an accessible description); the file-type row attached to Files with an "All files" chip (ruling
60's families, server counts unchanged); the row's reveal animation (reduced path per §7.3); one count source (the
"7 documents" pill disagrees with "All 10" — both must come from one number); ICU plurals for the Knowledge summary
("1 app"). The summary line's "N uploaded" beside the "Files" chip is an open owner question: follow the spec if it
words it; otherwise keep it and say so in the report.

## Tests and screens

- Tests first for: card states and the "Review ›" action, the plural strings in both languages, the placeholder
  naming the open item, the App status row / segmented control / popover focus behaviour / busy veil (`inert`) / toast
  Undo, the disabled zero chips with their reason, the attached file-type row and the single count source.
- Playwright at the end (port 5440): `tests/e2e/artifact-chat-card.spec.ts`, `artifact-app.spec.ts`,
  `knowledge.spec.ts`, `artifacts-panel.spec.ts`, `chat.spec.ts`, `conversation.spec.ts`.
- Screenshots in Hungarian: the chat with the three cards at 1440×900 light and dark and 390×844 light; the App panel
  (Preview, and the regenerate popover) at 1440×900; the Knowledge Documents tab with Files chosen at 1440×900.
