# Agent 3b · Phone comments, the narrow-panel drawer, Versions and Download popovers (step 8 + §3.2's Versions)

Runs after agent 3a. Read the **hand-off sections** of `rd/rd1-report.md`, `rd/rd2-report.md`, `rd/rd5-report.md` and
`rd/rd3a-report.md` first and reuse what they name (the rail, `CommentCard` / `CommentThread`, the anchor decoration,
`ArtifactPanelHeader`'s buttons). Agents 4a/4b (the editing chain) come after you.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-rd3b`, branch
  `feat/artifacts-rd3b-sheets`, e2e port **5425**, label `rd3b`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/rd3b-report.md`
- Screenshots: `…/scratchpad/rd/shots/rd3b/` (same scratchpad as the report).
- Read first: `rd/common.md` next to this brief.

## Read in `redesign.md`

§3.2's "Phone" and "Versions" paragraphs (lines 225–234), §3.3–3.5 rows about phones, versions and focus (235–279),
§9.2 rows for `VersionsSheet.svelte` / `DownloadSheet.svelte` and `DocumentWorkspace.svelte`'s narrow-panel drawer
(784–786), §9.3 (794–811: `DialogShell` `phonePresentation="sheet"`, the `focusTrap` attachment with `onEscape`,
`restoreFocusOnCleanup`, `isTopmost`, `portalToBody`), §7.3. Mockup: `#history` / `.ver-list` (the Versions popover),
the phone Comments sheet.

## Step 8 · Comments on phones and in a narrow panel

- Phones: the header's Comments button (with the open count) opens a bottom sheet through `DialogShell`
  (`phonePresentation="sheet"`) holding the same rail content; tapping a highlighted phrase opens the sheet at that
  thread. Escape/close returns focus to what opened it.
- A narrow desktop panel (no room for the 300 px rail): the rail becomes a drawer, as §3.2 / §9.2 describe.

## Versions and Download

`VersionsSheet.svelte` and `DownloadSheet.svelte` become popovers anchored to their header buttons (the version button
`v6 ▾` and Download from agent 2's header), with the `focusTrap` attachment (`onEscape`, `restoreFocusOnCleanup`,
`isTopmost` so Escape closes only the innermost layer), `portalToBody` where the panel's overflow would clip them,
sheets on phones, the inline restore confirm (no modal), and avatars (`AvatarCircle` / Alfy's sparkle tile) per row.
This also completes the Document half of the hand-off's "focus-trap pass two" (the download sheet).

## Tests and screens

- Tests first: the sheet opens from the header and from a tapped highlight at the right thread; focus returns on close;
  the drawer appears below the width threshold; the Versions popover anchors, traps focus, closes on Escape without
  closing an outer layer, and restores inline; Download likewise.
- Playwright at the end (port 5425): `tests/e2e/artifact-document-comments.spec.ts`, `artifact-document.spec.ts`,
  `artifacts-panel.spec.ts`.
- Screenshots in Hungarian: the phone Comments sheet and the phone Versions sheet at 390×844 light; the Versions
  popover at 1440×900 light and dark.
