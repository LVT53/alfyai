You are the lead engineer and orchestrator for **Feature 2 · Artifacts** of AlfyAI, my self-hosted
SvelteKit AI chat platform (a local Qwen model on vLLM plus optional cloud providers; about six accounts:
me, family and friends). The product decisions are **final** — they came from a design interview with
mockups and three throwaway feasibility prototypes. Your job is to turn them into a verified, reviewed
implementation with spec-driven development and TDD. Do not redesign the product. If the spec is impossible
or contradicts the code, stop and ask me.

## 0. Read first, then confirm you understood before planning

1. `docs/plans/claude-at-home-2-artifacts-spec.md` — the feature spec. §2 (decisions) is locked.
2. `docs/plans/claude-at-home-2-prototype-findings.md` — what the three prototypes measured, including the
   traps. Treat its numbers as fact; they were reproduced independently.
3. `docs/plans/claude-at-home-2/` — `plan.md` and `slice-0.md` … `slice-6.md`: the per-slice specs you will
   execute, plus two binding companions: **`decisions.md`** (43 rulings that override the slices where they
   disagree — rulings win, and a ruling that contradicts a slice is a slice bug) and
   **`review-consistency.md`** (the record of the consistency pass across all seven). If a slice contradicts
   the parent spec, the parent spec wins; report the conflict.
4. The agreed UI: `docs/plans/claude-at-home-2-artifacts-mockups.html` (App, File),
   `claude-at-home-2-artifact-types-mockups.html` (Canvas, Document, Slides) and
   `claude-at-home-2-artifact-surfaces-mockups.html` (where artifacts live, the panel's list, the tour).
   Open them in a browser; they use AlfyAI's real tokens and Lucide icons.
5. `docs/adr/0066-artifacts-are-a-family-of-five-types.md` (the decision), plus ADR-0064 (the roadmap) and
   ADR-0065 (editing in place, amended by 0066). `CONTEXT.md` defines the vocabulary — Artifact, Artifact
   Card, Artifact Panel, Artifact Block, Artifact Patch, Artifact Comment, Artifact Version, Artifact Tour,
   Poster Frame.
6. `AGENTS.md` — the canonical engineering map. Its boundaries are binding.

**The prototypes are your reference implementation for the hard parts.** They are throwaway branches off
`dev` and must never be merged, but their code answers most "how do we do this in Svelte 5?" questions:
- `proto/artifact-apps-quality` — the App contract, the generation harness and gallery pattern
- `proto/artifact-document-editor-r2` — Tiptap v3 in Svelte 5, Markdown with persisted block ids, hash
  refusal, comments, versions
- `proto/artifact-canvas-agent` — Svelte Flow board, the drawing layer, `_lib/pane-rect.ts`, comment pins,
  the BoardDiff
Read them; do not copy them wholesale (they are prototypes: single-session state, canned "Alfy" edits, no
server).

**Feature 1 dependency.** Feature 1 (Workspaces: personal/project instructions, folder knowledge, the
project page) is in flight on `feat/workspaces`. Feature 2's project-bundle work (slice 5) needs its project
page. Base Feature 2 on `dev` and land the first slices independently; rebase or merge Feature 1's work
before slice 5.

## 1. Non-negotiable rules

- **Node 22 only:** prefix every npm/npx/vitest/playwright call with
  `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`. The Mac's default Node 26 breaks `better-sqlite3`.
- **Check current docs before writing framework code:** Tiptap v3, `@xyflow/svelte` (v1 differs from React
  Flow in ways that fail silently — read the v1 docs, never code from React Flow memory), Svelte 5,
  Drizzle, Vitest, Playwright. If the docs tool is unavailable, say so and use official docs.
- **Svelte 5 runes only in touched files:** `$props`, callback props, `onclick`, `{@render}`; no new
  `<slot>`, `createEventDispatcher`, `afterUpdate`.
- **Boundaries:** routes are thin adapters; browser fetches in `src/lib/client/api/`; runtime config through
  `config-store.ts`; prompt assembly in `normal-chat-context.ts`; model tools in `normal-chat-tools/` with
  their usage guidance in the tool interface (ADR-0055); the artifact service behind one facade
  (`src/lib/server/services/artifacts/`), never spread across routes.
- **Every schema change** gets a Drizzle migration plus a `_journal.json` entry; `npm run check:migrations`
  must pass.
- **Every new UI string** exists in English and natural Hungarian. **Never show the word "artifact" in the
  UI** — the interface says Document, App, Canvas, Slides (HU: Dokumentum, Alkalmazás, Tábla, Diasor).
- **Icons** from `@lucide/svelte`; colours, spacing and radii from the tokens in `src/app.css`.
- **Dependencies:** MIT/ISC/BSD only, pinned. No paid editor extensions.
- **Gates before any slice is done:** `npm run check` (0 errors, 0 new warnings), `npm test` green,
  `npm run build` clean, `npx biome check src scripts tests` (`npm run lint` itself breaks when nested
  worktrees exist — say so in reports), `npx fallow --no-cache --format json --quiet --score` with no new
  findings, plus the targeted Playwright suites and the eval harness named in the slice.
- **Commits:** small and focused, message explains *why*, staged by explicit path, no bare `git stash`.
  **Never push, and never deploy to production, without my explicit go-ahead.**

## 2. Where the risk lives (the spec's §8, condensed)

1. **Only the App contract has been tested against the real model.** Document patches, canvas diffs and
   slides were *canned* in the prototypes. The model-contract eval harness is therefore a **gate on each
   type's slice**, not an afterthought. If the model proves weak at a type, the design for that type changes
   (Alfy proposes, I approve) — do not argue the evidence away.
2. **Apps generate with thinking OFF** and are fact-checked before the card appears. Both come from measured
   failures: thinking on burned 24,000 tokens and returned nothing, twice, and 3 of 10 apps shipped a quiet
   content error that every automated check passed.
3. **Block ids must be minted or absorbed immediately after parse** — before hashing, snapshotting or
   rendering. The prototype's worst bug was reading the document first and then refusing every patch with
   "no hash to check".
4. **A pointer-capturing overlay must be sized to the visible pane**, not the board's box: at 163 nodes a
   pad sized to the board caught 6 of 144 sample points and every other press dragged a node.
5. **Portal content cannot be styled from its parent**, and frame children carry `z-index: 1`, so overlays
   need `2`.
6. **Svelte Flow v1's silent API differences** (`onbeforeconnect` not `onconnect`, library-side `addEdge`,
   no `snapToGrid`, the selection-wrapper pointer-events trap) and its lack of frame reparenting — the app
   owns that hit-test.
7. **Poster frames:** an embedded App or a map block cannot be exported or rendered offline; it exports as a
   poster image.
8. **Heavy editors are lazy-loaded.** The Document editor was 147 kB gzip; it must not tax every chat page.
9. **Single user, permanently.** No sharing, permissions or real-time co-editing anywhere — not as a
   deferred option either.

## 3. The cycle

**You are the orchestrator; do not write feature code yourself.** Spend your effort on judgment: slice
specs, dispatching agents, reading reports, checkpoint testing, deciding what to fix. If your system has no
sub-agents, run the same phases yourself in sequence with the same discipline.

**Phase 1 — plan (stop for my approval).** Turn `docs/plans/claude-at-home-2/plan.md` into a working plan:
slice order and parallelism, one worktree per slice, exclusive file ownership per agent, and the gate list.
Show me the plan and wait.

**Phase 2 — implement each slice with TDD.** One dev agent per slice or per disjoint sub-slice, in its own
worktree off `dev`. Red → green → refactor: the failing test from the slice spec comes first, then the
smallest change, then the refactor, committing after each green step so an interruption loses little.
Use a strong model for anything where a subtle mistake is expensive (the patch protocol and hash refusal,
the sandbox bridge and CSP, migrations and data ownership, the BoardDiff application path, prompt text);
a faster model is fine for mechanical, well-specified work (i18n keys, UI wiring against a frozen contract,
test updates, docs). Each agent reports commits, tests added, real gate output, and anything it deviated on.

**Phase 3 — independent adversarial review before merging.** Implementers test the happy path they built;
their own reports are not enough. One reviewer per disjoint area, in its own worktree, never the
implementer. Look for: ownership gaps (can user A read, edit, comment on or export user B's artifact?),
incognito leaks, patch-refusal bypasses, sandbox escapes or a bridge that hands the artifact a privileged
global, block-id loss across reloads, canvas pointer-event conflicts, missing EN/HU keys, Svelte 5
reactivity bugs, mobile layout, and dead code. **For every defect: write a failing test first, then fix
it.** Summarize in `docs/plans/claude-at-home-2/review-<batch>.md`.

**Phase 4 — verify for real.** Checkpoint-test the running app yourself (local dev server with a scratch DB,
then the dev environment). Walk every surface against the mockups: create each type from chat, tick a
checklist in the card, an Alfy edit with Keep and Undo, a reload that keeps ids and still refuses a stale
patch, a comment with @Alfy producing an applied change, drawing on a canvas and exporting it, the panel's
list, the Knowledge Documents tab, a project bundle, the tour on first open. Then real-model checks on the
dev environment with the eval harness.

## 4. Reporting

- After each phase: a short status with commit hashes, real gate numbers, review findings fixed, open
  questions. Keep `docs/plans/claude-at-home-2/progress.md` current so a fresh session can resume.
- At the end: a final report and a staging → production release checklist for my go-ahead.

Start with §0, then Phase 1. Do not write feature code before I approve the plan.
