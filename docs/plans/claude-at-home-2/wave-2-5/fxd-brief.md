# Fix agent D · The chat-side minor findings (round F2)

Fix agent A is merged (the review state on the card, list and dot, the card path, the App panel): read the "per finding"
and hand-off parts of `rd/fxa-report.md` first. **Fix agent B is still running** on the Document's layout
(`document/DocumentBody.svelte`, `ReviewBar.svelte`, `SelectionBubble.svelte`, `Tabs.svelte`, `VersionsSheet.svelte`,
`DownloadSheet.svelte`, `document-editor.ts`, the document e2e specs, and possibly `DocumentWorkspace.svelte`'s expanded
presentation): do not edit those, and keep any `DocumentWorkspace.svelte` edit to the panel's focus/name. Later, **Fix
agent C will work** on the Document's review logic, versions, avatars and Hungarian strings
(`components/artifacts/document/**`, `CommentCard.svelte`, `ReviewBar.svelte`, `RefusalNotice.svelte`, the artifacts
review route/service, `src/lib/i18n/artifacts.ts`'s document/comment/review blocks): do not edit those. If you need a new
string, add it inside the card/App/header/Knowledge blocks of `artifacts.ts` (or `knowledge`'s own i18n), never at the
end of the `en`/`hu` objects.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-fxd`, branch
  `fix/artifacts-rd-shell-minor`, e2e port **5495**, label `fxd`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/fxd-report.md`
- Screenshots: `…/scratchpad/rd/shots/fxd/` (same scratchpad as the report).
- Read first: `rd/common.md`, then your findings in `rd/review-2-5.md` by line range, then only the hand-off sections of
  `rd/rd5b-report.md`, `rd/rd5a-report.md`, `rd/rd2-report.md`, `rd/rd5k-report.md` as you need them.

## Your findings (`rd/review-2-5.md`, all Minor, tagged [shell])

1. (233–238) the two [shell] phone touch targets under 44 px.
2. (276–279) panel focus and accessible name.
3. (280–283) App accessibility details.
4. (284–286) Knowledge chips on phones.
5. (287–290) `btn-primary` hover contrast (keep the contrast test from agent 1 green; extend it to the hover colour).
6. (291–293) the in-chat card's version is stale.
7. (294–296) header meta.
8. (297–304) motion details (the §7.3 reduced path stays correct for each).
9. **A flaky e2e (pre-existing, found by the orchestrator):** `tests/e2e/artifact-chat-card.spec.ts:190` "shows the card
   during the turn, Open reaches the panel on it…" fails about one run in three, on the reviewed head too — once at
   `toBeEnabled()` on `message-input`, once waiting for the Document workspace to show "Book the museum tickets.". Find the
   race (test or product) and make it deterministic; prove it with 5 consecutive green runs of that spec.

## Proof

Tests first where behaviour changes; Hungarian screenshots at 390×844 of the App panel and the Knowledge chips, and at
1440×900 of the header meta and a card after an edit.
