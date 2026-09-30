# Feature 2 · Artifacts — hand-off to the Wave 3 session

Rewritten 2026-09-29 by the Wave 2.5 orchestrator, after the owner approved the polished redesign on ai.dev. Start here,
then read `progress.md` (the full record; its "Wave 2.5" and "Wave 2.5 polish" sections are the latest), `working-plan.md`
(waves, ports, gates, review plan) and `decisions.md` (rulings 1–61; rulings win over slice specs).

## Where things stand

- **ai.dev runs `dev` = `f6701fce`**: Waves 0–2 plus Wave 2.5 — the owner-approved redesign of every Artifact surface
  (`docs/design/artifacts-redesign/`, ruling 61) and the polish after the owner's walk (comment list that stays in view
  and toggles from the header, laptop fit, the Versions popover, one live version number, Delete with deleted states and
  Regenerate, keyboard undo/redo, the review's remaining findings). Release gates: 14,219 unit tests, **Playwright
  177/177**, Fallow 124/4 with 0 new. **The owner walked it and said "All good" (2026-09-29).** Production (`main`) is
  untouched.
- **`feat/artifacts`** (worktree `.claude/worktrees/art-base`, real `node_modules` with Tiptap) = `dev` + docs. Branch
  Wave 3 work from it.
- **Not merged, waiting:** `feat/artifacts-s6` (Slice 6's T1/T2/T5: the tours table migration `1777140000112`, types,
  admin seeding). **Next free migration: `1777140000113`** (assign one per slice before dispatch; the journal's last
  entry on `feat/artifacts` is idx 124, `1777140000111_artifacts_spine`).
- **Sub-agents:** `model: "sonnet"` now resolves to **`claude-sonnet-5-5`** (the owner asked for Sonnet 5.5 for all
  Sonnet work, 2026-09-29); have each agent state its model ID in its reply.

## What Wave 3 and 4 do (working-plan §3)

- **S3 Canvas** (+ the canvas eval suite; no prototype survives) and **S4 Slides** (T1/T2/T5/T6 first, ops after S3
  merges). Each registers its create/read/edit handlers in `normal-chat-tools/artifact-tools/` (ruling 50), which makes
  the model text name the kind (`advertisedArtifactKinds()`). Build their panels **from the shared redesign parts**
  (`redesign.md` §8, and AGENTS.md's Artifacts section, which now documents them): `ArtifactPanelHeader`, `CommentCard` /
  `CommentThread` and the comment column (`MarginPanel`: a sticky list with scroll-follow and the header toggle — see the
  §3.2 supersession note), `ReviewBar`, `ChangeBar` (the change pill), `RefusalNotice`, the Alfy-writing decorations,
  `AnchoredPopover` + `popover-placement`, the `DialogShell` sheet patterns, `document/keyboard-shortcuts.ts`, and the
  version announcement in `src/lib/client/api/artifacts.ts`. Extend Delete / the deleted and unreachable states /
  Regenerate (`artifact-tools/recreate.ts`, the conversation-detail read model) to the new kinds.
- **S6 remainder** (the tour panel, seen-tracking, empty states, i18n/archive) after S4 and S5b.
- **S5b** (Wave 4): artifacts as evidence rows, the project bundle, the AGENTS.md doc fixes (incl. "five" → four known
  cycles), the all-suite live run, and ruling 59 (known-bad fixtures are recorded answers, never model calls).
- **Focus-trap pass two:** `campaigns/CampaignModal.svelte` and `campaign-admin/CampaignCropModal.svelte` onto
  `src/lib/utils/focus-trap.ts` (the Document's More and Download sheets were done in Wave 2.5).
- **Final:** whole-branch review (include focus-trap pass one, which had no independent review), the owner's own walk
  on ai.dev, the release checklist; production and the campaign only on the owner's word.

## Tools

- Gate script: `docs/plans/claude-at-home-2/wave-2-5/gates.sh` (copy it to your scratchpad): `gates.sh <worktree> <port>
  <label> [extra specs]` → `/tmp/gates-<label>/summary.txt`; Fallow baseline
  `~/.cache/alfyai-artifacts/fallow-baseline-00ef6d2a.json` (124 issues / 4 circular). Pass **every** artifact suite:
  `$(ls tests/e2e/artifact*.spec.ts tests/e2e/artifacts-*.spec.ts) tests/e2e/knowledge.spec.ts` (chat and conversation
  run by default). A full run takes ~12 min.
- Integrate on the main checkout (it holds `dev`), gate in the detached `dev-int` worktree, push/deploy only when every
  gate is green with 0 new Fallow findings. Deploy: `ssh -T -o ConnectTimeout=8 -o BatchMode=yes alfyroot 'sudo -u
  alfydesign -H bash -c "cd /home/alfydesign/apps/langflow-chat-dev && APP_DIR=/home/alfydesign/apps/langflow-chat-dev
  ./current/scripts/deploy-dev.sh"'`. Live check: `/root/verify-artifacts-w2.mjs` (usage in its header) — **its edit
  scenario no longer triggers an edit** (the model writes the target items into the first draft); give it items a
  packing checklist cannot already hold before relying on its edit checks.
- Agent briefs, reports and reviews of Wave 2.5 are in `docs/plans/claude-at-home-2/wave-2-5/` (`common.md` is the shared
  rules file every build agent read; reuse it).

## Open items carried over

- From Wave 2.5 (details in `progress.md`): L3/L6 of the Delete security review (file-job and App regenerate follow their
  siblings' existing patterns); `regenerable` reads only the loaded message window; a refusal card is session-only and
  does not return after a re-mount; the workspace's F1/F2 seen-keys guard is partly redundant now; toolbar tooltips are
  native titles; Redo does not un-acknowledge server-side; Knowledge's legacy delete of a produced file leaves its
  chat-file row until the next Open.
- Older: the chat-file store is shared across vitest workers (`data/chat-files/`; `conversation-forks.test.ts` flaked
  with `ENOENT`) — give it a per-worker directory like the DB (`fb5d2a7e`); Alfy-written Markdown that the editor
  re-spells gets a new hash on the first user save (canonicalise on write?); a "full" `read_artifact` sends the text twice
  (up to ~200k characters); the spec's `…/document/patches` route was never built (superseded by the shared body route:
  confirm).

## Lessons that must shape Wave 3

1. **A tool's advertised schema must come from its validator's own zod schema**, its description needs a real example
   that a test runs through the validator, and a refusal must name the valid ops. Canvas `ops` and Slides `patches` must
   not repeat the Document edit's first failure (the model guessed op names 7 times, then made a duplicate).
2. **Every eval suite's live run goes through the real tool description and schema**, not a hand-written prompt.
3. **Small agents** (2–3 steps each, a context-economy line in every brief, a commit per step). The owner allows **two
   agents at a time**: pair agents whose files are disjoint and say in each brief which files the other owns; each adds
   i18n keys inside its own block. Merge conflicts were keep-both (AGENTS.md notes, i18n, imports).
4. **Look for yourself.** Agents' own screenshot checks missed real defects three times (stacked checkboxes, sheets under
   a backdrop, a review bar over the text). The orchestrator reads the key screenshots, and a **final re-check walks the
   flows the way the owner does** before release — in Wave 2.5 it caught a Critical (header controls lost after switching
   Documents) and an Alfy-edit replay that every automated gate had passed.
5. **Every build agent runs all artifact e2e suites at the end** (a narrower list let two stale suites slip through).
   A failure in a suite the agent did not touch: rerun it alone first (shared `.vite` cache). A test that fails only in
   combined runs is usually measuring mid-animation: wait for motion to settle (`waitForStableBoundingBox`,
   `waitForMotionToSettle` / `expectTopmost` in `tests/e2e/helpers.ts`).
6. **Opus only where a missed bug is expensive** (in Wave 2.5: the whole-redesign review and the Delete/Regenerate
   security review). Re-checks of fixes on Sonnet.
7. **Budget:** check `get_usage` before each dispatch. Two parallel Sonnet agents use ~20 % of the 5-hour window per hour —
   do not add an Opus seat beside them near that cap. Wave 2.5 plus its polish used ~40 % of a weekly limit.
8. Environment: Node 22 via `/opt/homebrew/opt/node@22/bin`; a fresh worktree needs `node_modules` linked to `art-base`'s
   and `DATABASE_PATH="$PWD/data/playwright-e2e-chat.db" npm run db:prepare` before Playwright; `npm run lint` breaks on
   nested worktrees, use `npx biome check src scripts tests`; the Context7/Svelte MCP docs tools are not available —
   agents use svelte.dev via WebFetch or the installed `.d.ts`.
