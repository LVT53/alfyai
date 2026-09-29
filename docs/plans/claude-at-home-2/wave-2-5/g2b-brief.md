# Polish agent G2-B · The Document's phone touch targets and prose details

Findings from the Opus review (`rd/review-2-5.md`) the owner asked to finish now ("Please also do the 'Knowingly left for
later' parts"). **Agent G1-B runs at the same time** on the Versions popover, one version number, Undo's summary, the count button and the
toast (`VersionsSheet.svelte`, `DownloadSheet.svelte`, `Toast.svelte`, the chat page, the read model, the header's version
button); **agent G2-A comes later** on Delete, the deleted state and Regenerate (the artifacts routes and
service, `DocumentWorkspace.svelte`'s header actions, `ArtifactCard.svelte`, `ToolActivityRow.svelte`, the file cards,
the read model): stay out of those. Tabs (`Tabs.svelte`) belong to a later agent: leave them.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-g2b`, branch
  `polish/artifacts-doc-polish`, e2e port **5515**, label `g2b`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/g2b-report.md`
- Screenshots: `…/scratchpad/rd/shots/g2b/` (same scratchpad as the report).
- Read first: `rd/common.md`; the hand-off sections of `rd/rd1-report.md` (prose), `rd/fxb-report.md` (layout, review bar),
  `rd/rd4b-report.md` (review bar), `rd/g1a-report.md` (the comment margin, merged just before you).

## Items (`rd/review-2-5.md`)

1. (233–238) Phone touch targets at 44 px: the mobile toolbar buttons (36 → 44), the chip selects (22 px), the task
   checkboxes (17 px; keep the visual size and give them an `::after` hit area, as the change pill does). Tabs are not
   yours.
2. (251–255) Prose: adjacent task lists collapse their margins so a checklist reads as tight as the mockup's; the status
   chip select is as wide as its chosen value, not its longest option.

3. **Found by the orchestrator in G1-A's screenshots** (`rd/shots/g1a/01-laptop-1280x800-mid-hu-light.png`,
   `05-rail-hidden-1440x900-hu-light.png`): the review bar wraps to two rows at 1280–1512 wide in Hungarian beside the
   comment column, and text shows beneath it (the bar floats a strip above the bottom edge). Keep it one row at those
   widths (compact the stepper and labels before wrapping) and flush with the bottom of the text column, with nothing
   visible under it; the phone layout from fix B stays.
4. From G1-A's report: the Open/All filter resets when the comment column is toggled — keep it; and the refusal card's
   Dismiss has no exit motion (§7's item for it; reduced path: none).

## Proof

Tests first where behaviour changes (hit-area geometry with Playwright at 390×844 via `elementFromPoint` or box sizes;
the task-list spacing measured against the mockup's). Every artifact suite at the end (`rd/common.md` gate 4).
Screenshots in Hungarian, looked at yourself against the mockup: a Document with a checklist and a tracker table at
1440×900 and 390×844.
