# Fix agent C · The Document's review logic, versions, avatars, Hungarian strings (round F2)

Round F1's fix agents are merged: A (the review state on the card, list and dot, the card path, the App panel) and B (the
Document's layout, the phone composer and review bar, popovers, tabs, pill keyboard). Read the hand-off/"per finding"
sections of `rd/fxa-report.md` and `rd/fxb-report.md` first. **Fix agent D runs at the same time** on the chat-side minor
findings (`ArtifactCard.svelte`, `ArtifactPanelHeader.svelte`, `DocumentWorkspace.svelte`'s panel focus/name, `AppBody.svelte`,
`AppFrame.svelte`, `knowledge/_components/DocumentsList.svelte`, `app.css`'s `btn-primary`, motion details in those files):
do not edit those.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-fxc`, branch
  `fix/artifacts-rd-doc-logic`, e2e port **5490**, label `fxc`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/fxc-report.md`
- Screenshots: `…/scratchpad/rd/shots/fxc/` (same scratchpad as the report).
- Read first: `rd/common.md`, then your findings in `rd/review-2-5.md` by line range, then only the hand-off sections of
  `rd/rd4b-report.md`, `rd/rd3a-report.md`, `rd/rd3b-report.md`, `rd/rd4a-report.md` as you need them.

## Your findings (`rd/review-2-5.md`)

Important (all four):
1. (109–121) Opening a Document with pending changes writes an empty "Edited" user version.
2. (122–129) The review stepper's next/previous never switch tabs; a change in another tab is unreachable.
3. (130–140) Ruling 61 persistence: a kept block that Alfy changes again is never pending again after a reload (kept block
   ids must be tied to the Alfy version that kept them). Server-side, through the artifacts facade, with tests.
4. (141–148) A user's own edit of a pending block does not acknowledge it in the session (ruling 61: it must).

Triage "fix first": (272–275) the user's avatar is a placeholder "U" next to "Te" in comment and Versions rows.

Minor, cheap and visible (fix these too):
- (256–260) English strings in the Hungarian UI — every one, EN and HU both in `src/lib/i18n/artifacts.ts`.
- (210–216) the change pill's group name has an empty quote; the HU names do not contain the visible labels.
- (217–222) status changes are not announced (one polite live region is enough).
- (223–228) tabs ARIA.
- (229–232) the composer's Escape only works from the textarea.

Not yours (recorded for later): the other [doc] minors — phone touch targets, the Comments sheet/drawer offsets, rail copy
and counts, prose details, Versions row details, refusal placement, Undo's version summary.

## Proof

Tests first for each; an e2e for findings 1–4 through the fake provider (`AI_SMOKE_EDIT_ARTIFACT_MARKER`); Hungarian
screenshots of a thread and a Versions list with the real avatar, and the stepper moving to another tab.
