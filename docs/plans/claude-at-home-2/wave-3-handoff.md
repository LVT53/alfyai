# Feature 2 · Artifacts — hand-off to the Wave 3 session

Written 2026-09-26 by the Waves 0–2 orchestrator. Start here, then read `progress.md` (the full record),
`working-plan.md` (waves, ports, gates, review plan) and `decisions.md` (rulings 1–59; rulings win over slice specs).

## Where things stand

- **ai.dev runs `dev` = `29a07688`** (after two owner-testing fixes on 2026-09-27: the selection bubble, ruling 60's file-type filter, per-worker test DBs; earlier `73ab3b07`) (Wave 2: the three artifact tools, Documents, Apps, the in-chat card, the
  Knowledge tab and Workspace Search for every kind, focus-trap pass one). Production (`main`) is untouched.
- **Live check:** `/root/verify-artifacts-w2.mjs` on the box, 14/14 on 2026-09-26 (see its header for usage). Model
  `qwen3-6-27b`; Alfy is only told about Document and App (`advertisedArtifactKinds()`, derived from
  `CREATE_ARTIFACT_HANDLERS`), so Canvas/Slides text returns automatically when their handlers register.
- **`feat/artifacts`** (worktree `.claude/worktrees/art-base`, real `node_modules` with Tiptap) = `dev` + docs.
  Branch Wave 3 slices from it.
- **Not merged, waiting:** `feat/artifacts-s6` (Slice 6's T1/T2/T5: the tours table `1777140000112`, types, admin
  seeding; T3/T4/T6/T7 need all four kinds' panels and Slice 5b).

## What Wave 3 and 4 do (working-plan §3)

- **S3 Canvas** (+ the canvas eval suite; no prototype survives) and **S4 Slides** (T1/T2/T5/T6 first, ops after S3
  merges). Each registers its create/read/edit handlers in `normal-chat-tools/artifact-tools/` (ruling 50), which makes
  the model text name the kind. **Migration numbers:** next free is `1777140000113` (assign one per slice before
  dispatch).
- **S6 remainder** (the tour panel, seen-tracking, empty states, i18n/archive) after S4 and S5b.
- **S5b** (Wave 4): artifacts as evidence rows, the project bundle, the AGENTS.md doc fixes (incl. "five" → four known
  cycles), the all-suite live run, and ruling 59 (known-bad fixtures are recorded answers, never model calls).
- **Focus-trap pass two:** the Document mobile "More" sheet, the download sheet, `campaigns/CampaignModal.svelte`,
  `campaign-admin/CampaignCropModal.svelte` onto `src/lib/utils/focus-trap.ts`.
- **Final:** whole-branch review (include focus-trap pass one, which had no independent review), the owner's own walk
  on ai.dev, the release checklist; production and the campaign only on the owner's word.

## Open items carried over

- The chat-file store is shared across vitest workers (`data/chat-files/`): `conversation-forks.test.ts` flaked with `ENOENT`; give it a per-worker directory like the DB (`fb5d2a7e`).
- The Documents summary line says "N uploaded" beside the renamed "Files" chip (ask the owner).

- Canonical form: Alfy-written Markdown that the editor re-spells gets a new hash on the first user save, so a patch
  built on an older read is refused (narrow window; consider canonicalising Alfy's text on write).
- A "full" `read_artifact` sends the text twice (up to ~200k characters).
- The App card in chat has no fact-check line (no App preview field on the card summary yet).
- The spec's `…/document/patches` route was never built (superseded by the shared body route: confirm).
- The Knowledge tab's chip-row position vs the mockup (check in the final walk).

## Lessons that must shape Wave 3

1. **A tool's advertised schema must come from its validator's own zod schema**, its description needs a real example
   that a test runs through the validator, and a refusal must name the valid ops. The Document edit shipped without
   this: the model guessed op names 7 times, then made a duplicate. Canvas `ops` and Slides `patches` must not repeat it.
2. **Every eval suite's live run goes through the real tool description and schema**, not a hand-written prompt (the
   document suite passed 7/7 while real edits failed).
3. **Keep agents small** (2–3 tasks each, a context-economy line in every brief): four long agents ran out of context.
   Check `get_usage` before each dispatch; the owner's weekly limit is the binding constraint (memory
   `alfyai-token-budget-pacing`).
4. Merges between parallel slices conflict in append-only files (i18n, registries, the containment suite, `record.ts`);
   integrate early on a scratch branch and let one agent resolve with tests.
5. Environment: Node 22 via `/opt/homebrew/opt/node@22/bin`; Playwright needs `db:prepare` in a fresh worktree; with
   SSH `ControlMaster`, close a tunnel with `ssh -O cancel -L <port>:192.168.1.96:30000 alfyroot`; a shared
   `node_modules/.vite` can be re-optimised by another worktree's dev server mid-run (rerun alone before calling a
   failure real); `npm run lint` breaks on nested worktrees, use `npx biome check src scripts tests`.
