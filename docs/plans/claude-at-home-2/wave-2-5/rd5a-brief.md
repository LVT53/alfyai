# Agent 5a · Task-item fix, in-chat cards, Knowledge chips (step 0 + redesign steps 12 and 14)

Third build agent (after agents 1 and 2, both merged). Read the **hand-off sections** of `rd/rd1-report.md` (tokens,
`reducedMotionAnimate`, prose classes) and `rd/rd2-report.md` (`ArtifactPanelHeader`, `ArtifactCard chrome="row"`, the
panel motion, the count button) first, and reuse what they name. The App panel (step 13) is **not** yours: agent 5b
does it later. Leave the comment rail, the selection bubble, the change bar and the review bar alone as well.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-rd5a`, branch
  `feat/artifacts-rd5a-cards`, e2e port **5440**, label `rd5a`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/rd5a-report.md`
- Screenshots: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/shots/rd5a/`
- Read first: `rd/common.md` next to this brief.

## Budget (binding)

The owner's weekly limit is almost used up. Work in as few steps as you can: targeted reads, targeted tests while
iterating, each e2e spec run **once** at the end (rerun only a spec whose failure your change caused, after fixing it),
the full vitest suite once. Do the steps in the order below and **commit after each one**. If the orchestrator sends
you a message saying to stop, finish the edit in hand, make sure the branch builds and its tests pass for what is
committed, write the report, and reply — do not start the next step.

## Step 0 · Inline task items (a defect from agent 1)

Task items render with the checkbox on its own line **above** the text (see `shots/rd2/document-hu-desktop-light.png`,
next to your report folder); spec §1/§5 and the mockup's `.tasks` put the checkbox on the text's line. Fix it in the
`.document-content` styles, test-first with a Playwright check that a task's checkbox and its first text line share one
line (vertical centres within a few px) at 1440×900 and 390×844. Nothing else in the Document.

## Step 12 · In-chat cards

Read `redesign.md` §5.1's card items and §5.2 "In-chat cards" (lines 421–445 skim, 489–505), §5.3–5.5's card rows
(506–537), §7's card arrival (649–722), §9.2 rows for `ArtifactCard.svelte` (standalone), `ToolActivityRow.svelte`
and the chat page's composer placeholder (787–789). Mockup: `.a-card` (`#cardDoc`, `#cardApp`, `#cardFile`).
Build: standalone cards below the tool-row group, outside the collapsible thinking area (`ToolActivityRow.svelte` and
its host message component); no millisecond timing for artifact tools; every state (creating, open in panel, to review,
failed, deleted); the edit card with "Review ›"; 44 px task ticks on phones; plural fixes
(`artifacts.document.cardSubtitle` "1 tab"); the composer placeholder names the open item. Restyle `ArtifactCard`'s
standalone chrome only; leave `chrome="row"` (agent 2's) and `chrome="body"` as they are. The App card's fact-check
line needs an App preview field on the card summary that does not exist: add it only if it is a small read-model change
through `services/artifacts/read-model.ts` (facade only) with a test; otherwise leave it and say so in the report.

## Step 14 · Knowledge chips (only if no stop message has come)

Read `redesign.md` §6.1's Knowledge items and §6.2 "Knowledge chips" (538–569 skim, 605–616), §6.3–6.5's Knowledge rows
(617–648), §9.2's `DocumentsList.svelte` row (791). Mockup: "d" → Go to Files. In
`src/routes/(app)/knowledge/_components/DocumentsList.svelte`: zero-count chips dimmed and disabled with a reason; the
file-type row attached to Files with an "All files" chip (ruling 60's families; server counts unchanged); the row's
reveal animation (reduced path per §7.3); one count source (the "7 documents" pill disagrees with "All 10"); ICU plurals
for the summary ("1 app"). The summary's "N uploaded" beside the "Files" chip is an open owner question: follow the spec
if it words it, otherwise keep it and say so.

## Tests and screens

- Tests first for: the inline task check (step 0); card states and "Review ›", the plurals in both languages, the
  placeholder naming the open item (step 12); disabled zero chips with their reason, the attached file-type row, the
  single count (step 14).
- Playwright at the end (port 5440), each once: `tests/e2e/artifact-document.spec.ts`, `artifact-chat-card.spec.ts`,
  `artifacts-panel.spec.ts`, `chat.spec.ts`, `conversation.spec.ts`, and `knowledge.spec.ts` if you did step 14.
- Screenshots in Hungarian (at most 5): a Document with task items at 1440×900; the chat with the cards at 1440×900
  light and dark and 390×844 light; the Knowledge Documents tab with Files chosen (if step 14).
