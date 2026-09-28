# Fix agent A · The review state across the chat side, the card path, the App panel (round F1)

The Opus review of the whole redesign (`rd/review-2-5.md`, same folder as this brief) found 3 Critical and 15 Important
defects. You fix the chat-side ones and the review-state flow. **Fix agent B runs at the same time** on the Document's
layout (`document/DocumentBody.svelte`'s structure and CSS, `ReviewBar.svelte`, `SelectionBubble.svelte`, `Tabs.svelte`,
`VersionsSheet.svelte`, `DownloadSheet.svelte`, `extensions.ts`): do not edit those beyond, if you truly need it, **one
callback prop on `DocumentBody.svelte` and its call site** (say so in your report).

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-fxa`, branch
  `fix/artifacts-rd-shell`, e2e port **5480**, label `fxa`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/fxa-report.md`
- Screenshots: `…/scratchpad/rd/shots/fxa/` (same scratchpad as the report).
- Read first: `rd/common.md` (rules, environment, gates, report contract), then your findings in `rd/review-2-5.md` by
  line range, then only the hand-off sections of the build reports you need (`rd/rd5a-report.md`, `rd/rd5b-report.md`,
  `rd/rd4b-report.md`, `rd/rd2-report.md`).

## Your findings (`rd/review-2-5.md`)

1. **Critical** (lines 38–44): the App's "Módosítás…" regenerate sheet opens behind the phone panel.
2. **Important** (59–75): the chat card, the list row and the count-button dot ignore the review state, before and after
   a reload. This includes the triage's two "fix first" items: the dot must follow the **persisted** review state (ruling
   61; today it is session-only), and the card must show its "reviewed" state after Keep all instead of
   "1 módosítás vár rád". Do it at the source: the Document's pending count comes from the persisted review state through
   the artifacts read model (facade only — `services/artifacts/read-model.ts` / `index.ts`, reusing 4b's
   `computePendingReviewBlocks`), so the card, the list row and the dot read one number, and the client updates it after
   Keep / Undo / Keep all without a full reload.
3. **Important** (76–86, tagged [doc] but it is the card → document path): opening from the chat card counts each change
   twice.
4. **Important** (149–157): opened from the chat card, the Document header has no version button and no time (triage "fix
   first").
5. **Important** (158–167): in the expanded panel the App popover renders under the panel, and one Escape closes both the
   popover and the expanded view.
6. **Important** (176–182): the App panel's status row, Preview/Code and "Módosítás…" sit flush against the panel edges.

## Proof

- Tests first for each; the read-model change gets unit tests including ownership and an incognito conversation.
- An e2e for the review's **live card flow** (its Verdict section): an Alfy edit with the panel closed (fake provider,
  `AI_SMOKE_EDIT_ARTIFACT_MARKER`) → "Átnézés ›" → one change counted → "Mindet megtartom" → the card shows it reviewed and
  the dot is gone → reload → nothing pending.
- Screenshots in Hungarian: the card after Keep all; the App regenerate sheet on a phone (390×844); the expanded App panel
  with its popover.
