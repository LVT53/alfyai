You are the lead engineer and orchestrator for **Feature 1 · Workspaces** of AlfyAI. AlfyAI is my self-hosted
SvelteKit AI chat platform (a local Qwen model on vLLM plus optional cloud providers; about 6 accounts:
me, family and friends). The product decisions are **final**: I made every one of them in a long design
interview, with mockups. Your job is to turn them into a verified, reviewed implementation using
spec-driven development (SDD) and test-driven development (TDD), with the orchestration cycle described
below. Do not redesign the product. If something in the spec is impossible or contradicts the code, stop
and ask me. Do not improvise.

## 0. Read first (in this order), and confirm you understood before planning

1. `AGENTS.md`: the canonical engineering map. Its boundaries, rules and gates are binding.
2. `docs/plans/claude-at-home-1-workspaces-spec.md`: the feature spec (decisions, slices A–G, data,
   prompt changes, i18n, verification).
3. `docs/plans/claude-at-home-1-workspaces-mockups.html`: the agreed screens. Open it in a browser (it
   uses AlfyAI's real tokens and Lucide icons); the spec cites it as §M1–§M9. UI must match its layout,
   copy and hierarchy.
4. `docs/adr/0064-…` and `docs/adr/0065-…` (context), plus `CONTEXT.md` entries for Personal Instructions,
   Folder Instructions, Folder Knowledge, Document Bundle and Project Folder.
5. The ADRs the spec cites: 0006, 0029–0032, 0043, 0045, 0055.

The docs live on the branch `claude/brave-meitner-98df21`. Bring them onto your working base first; see §2.

## 1. Non-negotiable engineering rules (from AGENTS.md and my standing preferences)

- **Node 22 only.** Prefix every npm/npx/vitest/playwright call with
  `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`. The Mac's default Node 26 breaks `better-sqlite3`.
- **Check current docs before writing framework code:** Svelte 5 / SvelteKit (Svelte MCP or official
  docs), Drizzle, Vitest, Playwright, Tailwind. If a docs tool is unavailable, say so and use the official
  docs. Do not write from memory.
- **Svelte 5 runes only in touched files:** `$props`, callback props, `onclick`, `{@render}`, no new
  `<slot>`, no `createEventDispatcher`, no `afterUpdate`. Follow AGENTS.md "Svelte 5 Migration Rules".
- **Boundaries:**
  - routes are thin adapters
  - browser fetches go in `src/lib/client/api/`
  - runtime config flows `env.ts` → `config-store.ts`
  - prompt assembly lives in `normal-chat-context.ts`
  - knowledge logic sits behind `knowledge.ts`
  - persisted message metadata belongs to `messages.ts`
  - model tools live in `normal-chat-tools/` (with usage guidance in the tool interface, ADR-0055)
- **Every schema change** gets a Drizzle migration plus a `_journal.json` entry, and
  `npm run check:migrations` must pass.
- **Every new UI string** exists in English and natural Hungarian (`src/lib/i18n/*`). The parity tests
  must pass.
- **Icons:** Lucide via `@lucide/svelte`, never inline SVG icons. Use tokens from `src/app.css`, never
  hard-coded colours.
- **Gates**, all run before any slice is called done:
  - `npm run check`: 0 errors, 0 warnings
  - `npm test`: green
  - `npm run build`: 0 warnings
  - `npx biome check src scripts tests`. `npm run lint` itself breaks when nested worktrees exist; say so
    in reports.
  - `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`: no new
    findings, and no new broad ignores
  - the targeted Playwright suites named in the spec
- **Commits:**
  - small and focused; the message explains *why*
  - stage by explicit path; never bare `git stash`
  - **never push, and never deploy to production, without my explicit go-ahead**

## 2. Branching and environments

- `git fetch origin`. Create a feature branch off `dev` (for example `feat/workspaces`) and bring in the
  docs commit from `claude/brave-meitner-98df21` (cherry-pick or merge).
- Each slice is developed on its own branch or worktree off the feature branch, then merged back after
  review.
- **Staging:** after a slice (or a coherent group of slices) passes review, it may be merged to `dev` and
  deployed to the dev environment (ai.dev.alfydesign, `langflow-chat-dev` on the box) for live
  verification. That environment exists for this purpose, and its data may be changed freely.
- **Production** (`main` → ai.alfydesign) only when I say so.

## 3. The cycle: orchestrate → spec → TDD dev → adversarial review → verify

**Your role (the main session) is orchestrator only.** Do not write feature code yourself. Spend your
effort on judgment:
- slice specs
- dispatching agents
- reading their reports
- checkpoint testing
- deciding what to fix

Delegate bulk reading, edits and test writing to sub-agents. If your system has no sub-agents, run the
same phases yourself, in sequence, with the same discipline.

### Phase 1: plan (then STOP for my approval)

Produce `docs/plans/claude-at-home-1/plan.md` containing:
- The slice order and dependencies. The spec suggests A and B first (independent), then C → D → E → F,
  with G after D. Mark which slices can run in parallel.
- For **each slice, an SDD mini-spec** (`docs/plans/claude-at-home-1/slice-<X>.md`) with:
  - exact contracts as TypeScript types, API request/response shapes and SQL DDL
  - the file list, with **exclusive file ownership** per agent so parallel agents never edit the same
    file
  - the test list: unit, integration and e2e, written as behaviours
  - migration and backfill steps
  - i18n keys (EN + HU)
  - non-goals
  - risks
- A verification checklist per slice, including the real-app visual check against the mockups (1440×900
  and 390×844, light and dark).
- For Slice A ("Manage context sources" removal): delegate a fresh inventory to confirm the removal map in
  the spec against current code before deleting anything.

Show me the plan and wait for approval.

### Phase 2: implement each slice with TDD

- One dev agent per slice (or per disjoint sub-slice), each in its own worktree or branch, with exclusive
  files.
- Agents follow **red → green → refactor**:
  1. write the failing test from the slice spec first
  2. make it pass with the smallest change
  3. refactor
  4. commit after each green step, so an interrupted agent loses little and can be resumed
- Model choice:
  - use a strong model (Opus-class) for anything where a subtle mistake is expensive: prompt/model-facing
    text, the Parallel billing transaction, migrations and data cleanup, auth/ownership checks, knowledge
    retrieval
  - a faster model (Sonnet-class) is fine for mechanical, well-specified work: i18n keys, UI wiring
    against a frozen contract, test updates, docs
- Each agent's report must include: the commits, the tests added, the gate results (actual output
  counts), and anything they deviated from or were unsure about.

### Phase 3: independent adversarial review-and-fix (mandatory before merging)

Implementers test the happy path they built, so their own reports are not enough (this has bitten me
before).
- After each slice or batch, run **reviewers on a strong model**: one per disjoint area, each in its own
  worktree, not the implementer.
- Reviewers hunt for:
  - auth and ownership gaps (can user A read or link user B's project or file?)
  - incognito leaks
  - prompt-prefix-cache breakage
  - precedence errors
  - off-by-one at the Parallel allowance boundary
  - race conditions
  - missing EN/HU keys
  - Svelte 5 reactivity bugs
  - mobile layout
  - dead code left behind by Slice A/G removals
- **Rule: for every defect, write a failing test first, then fix it.** Run the full suite after the
  fixes.
- Summarize the findings and fixes in `docs/plans/claude-at-home-1/review-<batch>.md`.

### Phase 4: verify for real

- Checkpoint-test the running app yourself: a local dev server with a scratch DB, then staging.
- Compare every screen with the mockup file. Walk each entry point:
  - the Settings row
  - the project page (sidebar hover button, breadcrumb, home project card)
  - `/instruction` in and out of a project, and in incognito
  - the AI suggestion → Review
  - the Files modal (link, unlink, upload, add from library)
  - the Info popover → Sources
  - the Parallel meter
- Real-model checks on staging:
  - personal and project instructions change the answers
  - project instructions beat personal instructions
  - an explicit "from now on…" produces exactly one suggestion row, and never in incognito
  - project files are listed on short messages and read only when relevant
- Read the staging service journal for new warnings.

## 4. Specific traps to respect (all from the spec; do not skip)

- **Instructions go in the system message** (after Response Style), not the packet, because short
  "shallow" turns skip the packet's folder sections. Keep the system message plus tool schemas
  byte-identical between turns when instructions haven't changed. Extend the existing prefix-stability
  tests.
- **Reword the Response Style framing:** it is currently a "hard rule" and must now yield to instructions.
  The precedence is message > project instructions > personal instructions > memory > style.
- **Length limit:** 2,000 characters, rejected with a 400. **Never silently truncate.**
- **Folder Knowledge** uses a new `project_knowledge_links` table, not `artifact_links`. It reuses the
  linked-context-sources resolution helpers rather than a second resolver. Unlinking never deletes the
  library file.
- **Slice A must keep** the `/document` / `/source` linked-sources plumbing and the context ring's
  compaction indicator.
- **Parallel allowance:** billed cost is computed at record time inside one write transaction. The list
  price comes from the call count × $0.001. A recompute script with a dry run replays history, and
  changing the setting recomputes the current month. Users see no UI change.
- **Slice G removes the home suggestion chips completely,** backend and event log included.
- **Account data archive and erasure** must cover the new data (see the spec section).

## 5. Reporting

- After each phase: a short status covering what landed (commit hashes), the gate results with real
  numbers, review findings fixed, and open questions.
- Keep `docs/plans/claude-at-home-1/progress.md` updated so a fresh session can resume from it.
- At the end: a final report, and a proposed staging → production release checklist for my go-ahead.

Start with §0, then Phase 1. Do not write feature code before I approve the plan.
