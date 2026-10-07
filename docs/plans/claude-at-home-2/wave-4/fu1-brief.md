# Agent FU-1 · two Canvas gaps the owner asked to close: `@Alfy` on a board never overwrites newer words; every Delete takes the posters

The owner (2026-10-05) pulled the Wave 3 bug follow-ups into the final round. This touches deletion and ownership, so an
Opus reviewer will read your diff: keep it small and explicit.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-fu1`, branch
  `fix/artifacts-w4-canvas-gaps` (from `feat/artifacts`), e2e port **5460**, label `fu1`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/fu1-report.md`.
- Read first: `docs/plans/claude-at-home-2/wave-4/common.md` (+ the Wave 3 rules it points to); rulings 14, 51, 62, 63,
  64, 67 in `decisions.md`; `wave-3/rc3-report.md` (N8, by `grep -n N8`), `wave-3/fd-report.md` (`## N2`), AGENTS.md's
  Artifacts section ("Delete, the deleted state and Regenerate") and its Canvas subsection ("Alfy never overwrites…").

## Steps

1. **N8 — the `@Alfy` reply on a board refuses a stale op.** `runCanvasAlfyReply` (`services/artifacts/canvas-comments.ts`)
   reads the board, asks the model, and applies its ops through `applyArtifactOps` — with no `readVersionId`, so a note the
   reader changed in the seconds between the read and the apply is overwritten. Pass the version it read (ruling 67:
   `stale` for `update_node`, `move`, `remove_node` on a block that differs since; the rest of the batch applies), and let
   the reply say what it left alone in the reader's language. Red first: `canvas-comments.test.ts`, change a note between
   the model's read and the apply, expect `stale`. Check the Document's `@Alfy` path has the equivalent protection (its
   patch engine's hash/version checks) and say what you found; change it only if it lacks one.
2. **Every Delete takes a board's posters.** Knowledge → Documents' Delete (`DELETE /api/knowledge/[id]` →
   `deleteArtifactForUser`) leaves a deleted board's poster files behind, while the panel's Delete (the facade's
   `deleteArtifact` cascade) removes them. Make both paths remove exactly the same things through **one** cascade (no
   second copy of `deleteBoardPosters`' rule), with ownership unchanged: a stranger's file of the same name, a file that
   hangs from a reply, and another board's posters stay. Red first: a test per path; a Playwright case that deletes a
   board from the Knowledge tab by real clicks and then finds its posters gone (read through the API or the DB the e2e
   runner can reach).
3. **The live-check script reads comments from the comments route.** `~/.cache/alfyai-artifacts/live-checks/verify-canvas-w3.mjs`
   (outside the repo, with its offline self-test beside it) reads a board's comments from `GET /api/artifacts/[id]`, which
   does not carry them, so its alfy-comment check reports FAIL while the product works. Point it at the comments route and
   prove it with the self-test. Do not copy the script into the repo (Fallow counts it as unused files).

Then the full gates once (Wave 3 rules' list; every artifact suite and `knowledge.spec.ts`).

**Runs beside you:** W4-B (the project bundle and doc fixes) and later W4-E (evidence rows: `message-evidence.ts`,
`MessageEvidenceDetails.svelte`). You may share only the containment suite (append one `describe`).
