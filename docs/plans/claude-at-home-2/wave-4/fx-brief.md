# Fix round after RV-F (the Opus final review) · three agents, three disjoint clusters

RV-F reviewed `feat/artifacts` at `ce62e412`: **ready after fixes**, 0 Critical, 3 Important, 11 Minor
(`docs/plans/claude-at-home-2/wave-4/rvf-review.md`). **Read your cluster's findings in it in full** (with their
reproductions and file:line), and its "Fix plan". Each agent takes ONE cluster below; the three run at the same time on
disjoint files.

- Common: `wave-4/common.md` (+ the Wave 3 rules it points to). Red first with real input for anything a person sees
  (Playwright: pointer, keyboard, touch), a test that fails on the unfixed tree for anything else. Full gates once at the
  end (Wave 3 rules' list; Playwright with every artifact suite and the specs your cluster touches). Reports to
  `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/fx-<a|b|c>-report.md`,
  screenshots beside them in `…/w4/shots/fx-<a|b|c>/`.
- **The chat route's size budget has ~55 B of headroom.** Do not move `--chat-baseline` yourself: measure your growth
  against your base (build both) and report the two numbers; the orchestrator records the move (ruling 68's notes).

## FX-A · I-1: Alfy's board edit never overwrites the reader's newer words, even when their save coalesced

Worktree `.claude/worktrees/art-fxa4`, branch `fix/artifacts-w4-stale-read` (from `feat/artifacts`), port **5400**.
Files: `normal-chat-tools/artifact-tools/read.ts`, `edit.ts`, `canvas-model.ts` and their tests (ruling 67; FU-1's
`readBody` on the `@Alfy` path is the precedent). The red test is RV-F's probe: a reader's save that coalesces into the
version the model read (ruling 47), then the model's edit — refused as `stale` for the changed block, the rest applies.
Keep the board body the turn read (moved forward by the turn's own landed edits) and pass it as `readBody`, with
`readVersionId` as the fallback. Prove the tool path on the real tool envelope, not a mock of it.

## FX-B · I-2, I-3, M-6, M-11: the panel over a project's Files dialog; the tours' reader; the dialog's footer

Worktree `.claude/worktrees/art-fxb4`, branch `fix/artifacts-w4-project-panel` (from `feat/artifacts`), port **5410**.
Files: `projects/[projectId]/_components/ProjectFilesDialog.svelte`, the project `+page.svelte`, `DocumentWorkspace.svelte`
(the dialog-stack hook only), `client/session-boundary.ts`, `client/api/artifact-tours.ts`, `i18n/projects.ts`, a new e2e
spec. Red first in Playwright with real keys: an item opened from the Files dialog keeps Tab inside the panel, and one
Escape closes only the topmost layer; the panel joins the one dialog stack (FT-2/FU-2's pattern) while it sits over a
dialog. Then: the panel's tour reader is named (`currentUser`) wherever the panel is hosted, and logout drops the tours'
page-load cache (an in-tab sign-out → another user's first open shows their own tour, red first). M-6: the footer promises
removal only when a removable row exists. M-11: the "EZ A BESZÉLGETÉS" crumb does not show where the panel has no list.

## FX-C · M-1, M-2, M-3, M-7: the Sources rows tell the truth; one list of shipped kinds; the card's meta line

Worktree `.claude/worktrees/art-fxc4`, branch `fix/artifacts-w4-sources` (from `feat/artifacts`), port **5420**.
Files: `chat/MessageEvidenceDetails.svelte`, the chat `+page.svelte` (prop threading only), `shared/artifacts/kinds.ts`,
`chat-turn/finalize-steps.ts`, `i18n/artifacts.ts`, the chat card's meta line (`ArtifactCard.svelte`, CSS only). M-1: a
deleted item's "Made in this chat" row shows the deleted state through the same `DeletedArtifacts` prop the cards use
(red first, real clicks: delete from Knowledge, the row says so and does not pretend to open). M-2: a fork's copied Sources
say the item was made in the original chat (the card's own wording). M-3: one browser-safe `SHIPPED_ARTIFACT_KINDS` in
`kinds.ts`; the tours' list derives from or is checked against it, and the evidence guard reads it. M-7: "1 fül" never
wraps apart in the card's meta line ("Dokumentum · 1 fül · v1").
