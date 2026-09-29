# Review · the whole Artifacts redesign (Wave 2.5, redesign step 16) — visual, accessibility, correctness

You are the one independent review of the redesign before it reaches the owner. Eight Sonnet agents built it in
order (1 foundation, 2 panel shell, 5a cards, 5k Knowledge chips, 5b App panel + card states, 3a comment cards and rail,
3b phone comments + Versions/Download popovers, 4a selection pill + Alfy writing + refusal, 4b change pill + review bar +
pending review across reloads). Each branch passed the full automated gates. Their own screenshot checks were **not**
reliable: agent 1 reported inline task checkboxes while its own screenshot showed them stacked, and agent 3b found phone
sheets painted behind a backdrop that every role-based test passed. So look for yourself.

**Report only — do not change product code or tests.** A cheaper agent fixes your findings afterwards.

- Worktree (detached at the head under review): `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/rv-rd`,
  e2e/dev-server port **5450**. `node_modules` is linked; the Playwright DB is prepared. Every shell:
  `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`.
- Review package (commit list, stat, full diff `d933e2f8..HEAD`): the path given in your dispatch. Read it by file, not
  all at once.
- Sources: `docs/design/artifacts-redesign/redesign.md` (by section), the mockup `docs/design/artifacts-redesign/index.html`
  (open it in Playwright; toggles `#themeDark`, `#langHu`, `#devMobile`, `#reducedToggle`), `docs/plans/claude-at-home-2/decisions.md`
  ruling 61 (the owner's answers: pending review survives a reload; the rail shows Open by default with a quiet toggle to
  All; tabs show only their own section while search, export, the card preview and Alfy's reads cover the whole
  document), and `AGENTS.md` (in your context).
- The agents' reports (each with a Deviations and a Hand-off section) are in `docs/plans/claude-at-home-2/wave-2-5/rd*-report.md`
  — use them to know what was built and what was knowingly left out, not as proof that it works.
- Findings file: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/review-2-5.md`
- Your screenshots: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/shots/review/`

## What to check

1. **Every surface against the mockup, in Hungarian**, at 1440×900 and 390×844, light and dark: the chat's count button;
   the panel list; the shared header; a Document (tabs, toolbar, prose, task items, tracker table, chips); the comment
   rail and cards (open/resolved/removed-text/other tabs; reply → Ask Alfy); the phone Comments sheet and the narrow
   drawer; Versions and Download popovers/sheets; the selection pill and composer (and its phone bar); "Alfy is writing"
   in place; the pinned refusal; the change pill, review bar, Keep/Undo/Redo and Keep all/Undo all; **a pending change
   after a reload**; the in-chat cards in each state; the App panel (status row, Preview/Code, regenerate popover, busy
   veil, v2 toast); Knowledge → Documents chips. Seed screens with the e2e suites' helpers and the fake provider
   (`AI_SMOKE_EDIT_ARTIFACT_MARKER`, `AI_SMOKE_CREATE_ARTIFACT_MARKER`) as the spec's Appendix describes; keep throwaway
   capture specs out of git.
2. **Accessibility:** roles and accessible names; keyboard reach to everything (tabs with arrow keys, toolbar roving
   tabindex, rail filter, pill, popovers); focus order, focus return and Escape closing only the innermost layer; visible
   focus rings; 44 px touch targets on phones; contrast of text on every tint in both themes; `inert` on the App's busy
   v1; status changes announced; decorative dots hidden with an equivalent text.
3. **Motion (§7):** the tokens' durations/easings used; every animation has the §7.3 reduced path; nothing measures or
   acts mid-animation in a way a user could hit.
4. **Correctness of the risky new logic:** 4b's pending-review persistence (ownership scope, `?conversationId=` for
   incognito, foreign/missing id → same 404, the pending-set rules, no marker → nothing pending, user edit acknowledges,
   Undo as a user edit per ruling 47); the tab-section decoration versus whole-document search/export/card/Alfy reads; the
   comment-anchor linking; the App's toast Undo (`restoreArtifactVersion`) and busy veil; sheet/popover layering.
5. **Triage the deferred items** listed under "Wave 2.5" in `docs/plans/claude-at-home-2/progress.md` and in each report's
   Deviations: for each, "fix before the owner walks it" or "can wait", with one line of reason.

## Findings file format

One section per finding, most severe first: `### <Critical|Important|Minor> · <surface> · <one-line claim>`, then
evidence (screenshot path or `file:line`), what the spec/mockup/ruling says, and the fix direction. Tag each finding
**[doc]** (Document body, comments, selection, review — `components/artifacts/document/`, `CommentCard`, `ReviewBar`,
`RefusalNotice`) or **[shell]** (panel, header, list, chat cards, App, Knowledge, chat page, tokens) so two fix agents can
split the work without touching the same files. End with the deferred-items triage table and a verdict (ready for the
owner after fixes / not ready).

## Economy

Opus is the most expensive seat: be targeted. Read the diff by file; at most ~24 screenshots, each looked at once; no
full vitest run (the gates already ran); run a Playwright spec only to reproduce a suspected defect. Do not dispatch
subagents.
