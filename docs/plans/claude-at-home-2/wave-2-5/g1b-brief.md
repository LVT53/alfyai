# Polish agent G1-B · Versions: the popover and one version number; the count button; the toast; Undo's summary

The owner walked the redesign on ai.dev (`1e755e0b`) and said:
> "The version popup is clunky, not very nice. And the small button itself which opens the document sidebar could be
> pushed a bit more to the right."

See it as they did: `rd/shots/review/03-d-versions-light.png` (same folder as this brief): the popover opens to the left
over the chat column instead of under its `v3 ▾` button, rows have uneven gaps (the hidden Restore button reserves its
space), the rows are loose and plain. The count button ("⊞ 2", `artifact-count-button`) sits left of the chat header's
right edge.

**Agent G1-A runs at the same time** on the comment margin (`MarginPanel.svelte`, `CommentCard.svelte`,
`CommentThread.svelte`, `CommentsSheet.svelte`, `RefusalNotice.svelte`, `DocumentBody.svelte`'s rail layout,
`DocumentWorkspace.svelte`'s comment toggle, `margin-layout.ts`): do not edit those. If you must touch
`DocumentBody.svelte` (Undo's summary), keep it to that call.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-g1b`, branch
  `polish/artifacts-versions`, e2e port **5505**, label `g1b`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/g1b-report.md`
- Screenshots: `…/scratchpad/rd/shots/g1b/` (same scratchpad as the report).
- Read first: `rd/common.md`; then the hand-off sections of `rd/rd3b-report.md` (the popover/sheet pattern), `rd/fxb-report.md`
  (popover z-index convention), `rd/fxc-report.md` (avatars, localized version summaries), `rd/rd5a-report.md` and
  `rd/fxd-report.md` (cards); the mockup's Versions popover (`index.html`: `#history`, `.pop-head`, `.ver-list`) and chat
  header (`#madeBtn`) are the visual reference the owner approved.

## 1 · The Versions popover (owner: "clunky, not very nice")

Rebuild `document/VersionsSheet.svelte`'s desktop popover to the mockup: anchored under its version button and kept
inside the panel (flip/shift; never over the chat column), about 320–360 px wide with a max height and its own scroll;
compact two-line rows — avatar (the real user avatar / Alfy's sparkle), name, version tag, relative time on line one, a
muted localized summary on line two — even padding, hover and focus states, the current version marked with a small pill;
Restore revealed on hover/focus without reserving space (review 261–264), with the inline confirm taking the row's action
area. Phone: the same rows in the sheet. Keep the `focusTrap`/Escape/focus-return behaviour and its tests. Make Download's
popover match it where they share parts.

## 2 · Undo's version summary (review 269–271)

Undoing Alfy's change saves as "Edited"; it must save with its own summary ("Undid Alfy's change" / "Alfy módosításának
visszavonása"), shown localized in the Versions list.

## 3 · The count button (owner: "pushed a bit more to the right")

Move `artifact-count-button` to the right end of the chat header as the mockup places `#madeBtn`, at every width where the
header shows it, without shifting the title or other header controls; keep its pressed state and dot.

## 4 · The toast's slide-out (left earlier: "Svelte out: transitions never complete in jsdom")

`Toast.svelte` gets its exit motion per §7 (reduced path: none). Test the exit as a pure transition function in vitest and
its visible behaviour in Playwright (it animates out and leaves the DOM), instead of waiting for jsdom to finish it.

## 5 · One version number everywhere (owner, later the same day)

> "the version numbers are all over the place. In the overview for one document I see v5, but inside it's only v3, but in
> the versions tab I also see a v4 but no v5."

Find where each surface gets its number (the panel list row / chat card summary, the header's version button, the
Versions list) and why they disagree (think of ruling 47's coalesced user saves that keep a version number, Alfy versions,
restores, the review-state writes, stale snapshots). Make **one source of truth** — the artifact's current version as the
Versions list shows it — used by every surface and kept live after saves, Alfy edits, Undo and restores. Test-first,
including an e2e that walks create → user edits → Alfy edit → Undo → restore and checks all surfaces agree at each step.
(The in-chat card's "deleted" state moved to a later agent together with Delete.)

## Proof

Tests first for 2, 4, 5 and the popover's placement/keyboard rules; every artifact suite at the end (`rd/common.md` gate 4).
Screenshots in Hungarian, and **look at each one yourself against the mockup**: the Versions popover at 1440×900 light and
dark and at 1280×800, the phone Versions sheet, the chat header with the count button at 1280×800 and 1440×900, and the three version surfaces agreeing.
