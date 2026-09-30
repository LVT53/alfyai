# Small agent FT-2 · focus-trap pass two: the campaign modals

The owner asked (2026-09-26) for one shared focus trap. Pass one extracted it (`src/lib/utils/focus-trap.ts`, from
`DialogShell.svelte`'s behaviour: rendered-only focusables, topmost-only) and moved the app's dialogs onto it; Wave 2.5
moved the Document's More and Download sheets. Pass two is the two dialogs still hand-rolling their own trap:
`src/lib/components/campaigns/CampaignModal.svelte` (the announcement a user sees) and
`src/lib/components/campaign-admin/CampaignCropModal.svelte` (the admin's crop dialog).

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-ft2`, branch
  `fix/focus-trap-pass-two` (from `feat/artifacts`), e2e port **5580**, label `ft2`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/ft2-report.md`
- **Agent S3-X runs at the same time** on the Canvas (`src/lib/components/artifacts/**`, the export route,
  `package.json`); you touch none of that.

## Read first

`wave-3/common.md`; `src/lib/utils/focus-trap.ts` and its test (the one API); one existing caller that pass one moved
(grep `focusTrap` / `focus-trap` under `src/lib/components`) as the pattern; `progress.md` lines 402–406.

## Steps

1. Pin today's behaviour of both modals with tests first (Tab and Shift+Tab stay inside; Escape closes where it does
   today; focus returns to the opener on close; only the topmost dialog traps when two are stacked), then move each onto
   the shared utility and delete its hand-rolled trap. No visual change.
2. Grep the tree for any other hand-rolled trap (a `keydown` handler cycling `Tab` over focusables) outside pass one's
   list; list what you find in the report, and move it only if it is equally small and tested the same way.

Full gates once at the end (every artifact suite is not needed for this change: run `tests/e2e/chat.spec.ts`,
`conversation.spec.ts`, and any campaign/announcement e2e specs that exist).
