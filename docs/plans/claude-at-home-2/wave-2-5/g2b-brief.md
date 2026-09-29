# Polish agent G2-B · The Document's phone touch targets and prose details

Findings from the Opus review (`rd/review-2-5.md`) the owner asked to finish now ("Please also do the 'Knowingly left for
later' parts"). **Agent G2-A runs at the same time** on Delete, the deleted state and Regenerate (the artifacts routes and
service, `DocumentWorkspace.svelte`'s header actions, `ArtifactCard.svelte`, `ToolActivityRow.svelte`, the file cards,
the read model): stay out of those. Tabs (`Tabs.svelte`) belong to a later agent: leave them.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-g2b`, branch
  `polish/artifacts-doc-polish`, e2e port **5515**, label `g2b`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/g2b-report.md`
- Screenshots: `…/scratchpad/rd/shots/g2b/` (same scratchpad as the report).
- Read first: `rd/common.md`; the hand-off sections of `rd/rd1-report.md` (prose), `rd/fxb-report.md` (layout),
  `rd/g1a-report.md` (the comment margin, merged just before you).

## Items (`rd/review-2-5.md`)

1. (233–238) Phone touch targets at 44 px: the mobile toolbar buttons (36 → 44), the chip selects (22 px), the task
   checkboxes (17 px; keep the visual size and give them an `::after` hit area, as the change pill does). Tabs are not
   yours.
2. (251–255) Prose: adjacent task lists collapse their margins so a checklist reads as tight as the mockup's; the status
   chip select is as wide as its chosen value, not its longest option.

## Proof

Tests first where behaviour changes (hit-area geometry with Playwright at 390×844 via `elementFromPoint` or box sizes;
the task-list spacing measured against the mockup's). Every artifact suite at the end (`rd/common.md` gate 4).
Screenshots in Hungarian, looked at yourself against the mockup: a Document with a checklist and a tracker table at
1440×900 and 390×844.
