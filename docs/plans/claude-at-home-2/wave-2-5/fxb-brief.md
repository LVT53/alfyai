# Fix agent B · The Document's layout, the phone composer and review bar, popovers, tabs (round F1)

The Opus review of the whole redesign (`rd/review-2-5.md`, same folder as this brief) found 3 Critical and 15 Important
defects. You fix the Document-layout ones. **Fix agent A runs at the same time** on the chat side and the review-state
flow (`ArtifactCard.svelte`, `ToolActivityRow.svelte`, the chat page, `ArtifactPanelHeader.svelte`,
`DocumentWorkspace.svelte`'s header props, `AppBody.svelte`, the artifacts read model): do not edit those. Agent A may add
one callback prop to `DocumentBody.svelte`; keep your `DocumentBody.svelte` changes to its layout, CSS and the parts your
findings name.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-fxb`, branch
  `fix/artifacts-rd-doc-layout`, e2e port **5485**, label `fxb`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/fxb-report.md`
- Screenshots: `…/scratchpad/rd/shots/fxb/` (same scratchpad as the report).
- Read first: `rd/common.md` (rules, environment, gates, report contract), then your findings in `rd/review-2-5.md` by
  line range, then only the hand-off sections of the build reports you need (`rd/rd3a-report.md`, `rd/rd3b-report.md`,
  `rd/rd4a-report.md`, `rd/rd4b-report.md`, `rd/rd2-report.md`).

## Your findings (`rd/review-2-5.md`)

1. **Critical** (27–37): on phones the Ask Alfy / Comment composer sheet opens behind the mobile panel.
2. **Critical** (45–56): on phones the review bar balloons to ~390 px; with it, the triage's "fix first" item: the review
   bar's prev/next reach 44 px on phones.
3. **Important** (87–97): "one scroll" is two nested scrollers, so rail cards drift from their words.
4. **Important** (98–108): the review bar scrolls away, covers the rail and hides the last lines.
5. **Important** (168–175): in the expanded panel the Versions popover is off-screen and under the panel; Download too.
6. **Important** (183–190): the tab `⋯` menu is clipped inside the tab strip; Rename/Delete are unreachable.
7. **Important** (191–197): a new tab shows the whole document (triage "fix first"; ruling 61: a tab shows only its
   section — an empty new tab shows an empty section with its placeholder).
8. **Important** (198–207): the selection pill is not reachable by keyboard.

## Proof

- Tests first for each (layering: the `elementFromPoint` pattern agent 3b introduced; geometry: wait for the panel to
  settle with `waitForStableBoundingBox`).
- Re-run the review's **phone pass** (its Verdict section) at 390×844 in Hungarian: both sheets topmost, a compact review
  bar, the pill and the last lines visible; and at 1440×900 the rail cards beside their words after scrolling a long
  document.
- Screenshots in Hungarian of each of those.
