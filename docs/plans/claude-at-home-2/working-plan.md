# Feature 2 · Artifacts — the working plan (orchestration)

> **For agentic workers:** this file is the *orchestration* layer. The task-level plans are `slice-0.md` …
> `slice-6.md` (REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans,
> checkbox steps). Read in this order: `plan.md` → **this file** → `decisions.md` (rulings win over slices) →
> `review-consistency.md` → your slice file → your dispatch brief. Where this file and a slice disagree, the
> rulings in `decisions.md` (including 43–46 once approved) win, then this file, then the slice.

**Status:** APPROVED by the owner 2026-09-25, with these answers (§12): Sonnet 5 for all implementation and Opus 5.5
only for the four riskiest reviews (revised after the restart, §4); build surfaces 4 and 6 (Slice 7, ruling 46); the other group has
finished and pushed `dev`, so this run owns `dev` and **deploys to the dev environment only** — production
(`main`) waits until owner and orchestrator both call the system polished, and ships with a new announcement
campaign. Rulings 43–46 are in `decisions.md`. A **Wave 0** of six Feature 1 follow-ups was added (§3a).

**Goal:** land Feature 2 (Document, App, Canvas, Slides, File behind one card and one panel) as reviewed,
verified, TDD-built slices on an integration branch, without disturbing Feature 1's in-flight work, and hand the
owner a release checklist for staging → production.

**Architecture of the work:** one integration branch `feat/artifacts` (cut from `dev` at `c6264d34`, plus the
consistency-pass docs), one branch + worktree per slice agent cut from it, adversarial review of each slice
**before** it merges, integration gates after every merge, `dev` merged *into* `feat/artifacts` at wave
boundaries so Feature 1's fixes flow in, and **nothing merged into `dev`, pushed or deployed without the owner's
word**.

**Tech stack:** as `plan.md` (SvelteKit + Svelte 5 runes, Drizzle/better-sqlite3, AI SDK tools + Zod, Tailwind
tokens, Lucide, Tiptap 3.31.3, `@xyflow/svelte` 1.7.0, Vitest, Playwright, Biome, Fallow), Node 22.23.

**Spec:** [`../claude-at-home-2-artifacts-spec.md`](../claude-at-home-2-artifacts-spec.md) (§2 locked),
[`plan.md`](./plan.md), [`decisions.md`](./decisions.md), [`review-consistency.md`](./review-consistency.md),
the three mockup files, ADR-0064/0065/0066, `CONTEXT.md`, `AGENTS.md`.

---

## 0. What §0 established (the "I understood" check)

Read in full: the parent spec, the prototype findings, `plan.md`, `decisions.md`, `review-consistency.md`, the
handoff prompt, the deepening brief, every slice's header, gates, file-ownership table and task list, the
mockups' section structure (13 surfaces), ADR/`CONTEXT.md` pointers, and the three prototype branches'
layout. Findings that change how the work must be run:

1. **The consistency pass was not on `dev`.** Commit `3977867c` (it corrects rulings 28, 31 and 39 and edits all
   seven slices) lived only on `feat/workspaces`. It is cherry-picked onto `feat/artifacts` as `b73ea102`; the
   `dev` copies of the slice files are the pre-pass text and must not be used.
2. **`dev` moved after the pass** in 23 files (the live citation-audit and evidence fixes: `messages.ts`, the
   chat `+page.svelte`, `ProjectFilesDialog.svelte`, `config-store.ts`, `client/api/conversations.ts`, the
   evidence route, …). Slice `path:line` citations are therefore **hints**: every implementer re-locates an
   anchor by symbol before editing. Example: `CATALOGUE_TOKEN_CEILING` is now `index.test.ts:4873`
   (`{ en: 4160, hu: 6850 }`), not `:4825`.
3. **Four seams the pass left contradictory** — resolved by proposed rulings 43–46 below (they need approval):
   who owns the three model tools (slices 1, 2 and 5 each claim them, and slice 5's own T2/T3 tests call slice
   1/3/4 validators, so they cannot land before those slices); who owns the eval harness runner and the
   per-type suites (slices 0, 1, 2, 4, 5 overlap, and **slice 3 has no eval task at all** although its gate is
   `--suite canvas`); where the anchor/comment types and `CommentCard.svelte` live (slices 0, 1, 3); and
   **surfaces 4 and 6 of the agreed surfaces mockup have no owner** (Knowledge → Documents with all five kinds;
   Workspace Search finding every kind — slice 0 lists them as a non-goal, `plan.md` and the handoff walk them).
4. **Ruling 39 (amended) already overrides slice text:** every artifact route uses `requireApiUser`
   (`src/lib/server/api/auth.ts:14`, throws `error(401)`); slices 0–5 still say `requireAuth` in places. The
   ruling wins; briefs say so.
5. **Slice 4's ownership table omits** the two append-only rows every type slice has: its `artifact-bodies.ts`
   loader line and its `ArtifactCard.svelte` preview branch (spec §5: "a slide thumbnail"). Added to its brief.
6. **i18n registration changed under us:** after `1e5a32df` and `2a30d85c` (Feature 1's last review), the
   validator and the parity test **discover** namespaces from what `src/lib/i18n/index.ts` merges instead of
   hand-kept lists. Slice 0 registers `artifacts` in `index.ts` and then *verifies* the discovery covers it
   (the new `scripts/validate-i18n.test.ts` fails if the validator stops watching a namespace); it adds a
   hand-kept entry only where one still exists.
7. **AGENTS.md's "five known circular-dependency findings" is stale:** the baseline has **four**.
8. **Tooling in this session:** no Context7 and no Svelte MCP docs tool is available. Fallback, stated in every
   brief: the official docs through WebFetch (svelte.dev/docs, tiptap.dev/docs, svelteflow.dev/api-reference,
   orm.drizzle.team/docs, vitest.dev, playwright.dev) **and** the installed package's own `.d.ts` in
   `node_modules`, which is the version-exact truth.
9. **Real-model access without credentials in files:** the P1 harness read a key from
   `~/.config/opencode/opencode.json`; reading that file is (rightly) blocked. Live eval runs and local
   real-model checks instead go straight to vLLM on the box through an SSH tunnel
   (`-L 30000:192.168.1.96:30000 alfyroot`, model `qwen3-6-27b`), with `EVAL_ARTIFACTS_BASE_URL` set
   explicitly. This is the production model shared with the family: runs stay sequential, one retry, stop after
   two 429/5xx. The tunnel must live in the same command as the process that uses it.
10. **Staging deploys fetch a branch from origin** (`scripts/deploy-dev.sh`, `DEPLOY_BRANCH` default `dev`).
    Owner, 2026-09-25: this run now owns `dev`; after a reviewed wave, `feat/artifacts` merges into `dev`, `dev`
    is pushed, and the dev environment (ai.dev.alfydesign, `langflow-chat-dev` on the box) is deployed. `main`
    and production are untouched until the owner says so.
11. **A fresh worktree cannot run Playwright until its E2E DB exists**: Playwright starts the web server before
    `globalSetup`, the server boots on an empty DB (`no such table: admin_config`) and the health wait times out
    at 120 s. Recipe in §6.

## 1. Global constraints for this run (in addition to `plan.md` §Global Constraints)

- **Node 22:** `export PATH=/opt/homebrew/opt/node@22/bin:$PATH` before every npm/npx/vitest/playwright/tsx.
- **Branch hygiene:** never switch branches in the main checkout, never touch `feat/workspaces*` or the old
  `ws-*`/`fix-*` worktrees, never write into the main checkout's `node_modules`, never `git stash` (shared
  stack). Agents never merge, push or deploy; the orchestrator merges into `dev`, pushes `dev` and deploys the
  **dev environment only** (owner, 2026-09-25). `main`, production and `scripts/deploy.sh` are off-limits.
- **Branching:** slices branch from `feat/artifacts` (not `dev`: they need the spine). The handoff's "off `dev`"
  is honoured at the integration level: `feat/artifacts` is `dev` plus Feature 2 only.
- **Ports (owner: Playwright on 5400 and up):** every agent exports its own `E2E_PORT` (table §4); a second
  server in the same worktree uses the next port in its block.
- **`node_modules`:** worktrees symlink `.claude/worktrees/art-base/node_modules` (a real `npm ci` install
  owned by the orchestrator). A slice that **adds a dependency** (S1: `@tiptap/*`; S3: `@xyflow/*`,
  `perfect-freehand`, `html-to-image`) first replaces the symlink with its own `npm ci`, then installs with
  `--save-exact`. Nobody runs `npm install` through a symlink. After a merge that changes the lockfile the
  orchestrator re-runs `npm ci` in `art-base`.
- **Docs before framework code:** see §0.8; a brief that touches Svelte Flow says "v1 docs and the installed
  `.d.ts` only — never React Flow memory".
- **TDD:** the failing test first, seen failing, then the smallest change, then refactor; commit after every
  green step with the slice's own message (house style: explain *why*); stage by explicit path; end commits
  with `Co-Authored-By: Claude Code <noreply@anthropic.com>` (`plan.md`'s convention).
- **Migrations:** the next free number *at branch time* (today: `1777140000111`, journal idx 124). On every
  `dev → feat/artifacts` merge the orchestrator checks `drizzle/` for a number collision and renumbers ours
  (file, `_journal.json` idx/tag/when) inside the merge.

## 2. Rulings 43–46 (approved 2026-09-25; the binding text is in `decisions.md`)

These only apply the existing rulings (40, 41, 11, 35, 31) and the spec's gate rule to seams the slices
describe inconsistently. None changes product behaviour. Summary as proposed:

**43. One owner for the three tools: Slice 5, landed early as "5a".**
- 5a lands `normal-chat-tools/artifact-tools/{create,read,edit}.ts` exactly as `slice-5.md §The three tools`
  specifies (advertised vs executed schemas, `summary` — not `label`, payload shapes, `ArtifactRefusal`,
  tool-call metadata), their registration in `index.ts`, the **final family-wide EN+HU descriptions** in
  `TOOL_I18N` (the task's real content, ADR-0055), **all three** `TOOL_TIMEOUTS_MS` rows (`create_artifact:
  120_000`, `edit_artifact: 20_000`, `read_artifact: 10_000`), the one measured catalogue-ceiling raise
  (ruling 23), the gating test, and a **per-kind dispatch seam** into the artifacts service with no creatable
  kind registered yet (reading a File-type id already answers with its type).
- Each type slice appends **only** its kind's handler entry per tool, its member of `ArtifactRefusalReason`, and
  its kind's tests (slice-5 T2/T3's type-specific cases plus its own: S1 T4's scope/refusal/link tests, S2
  A7's, S3's `unknown_id`, S4's `layout_dropped_field`). **No type slice edits `normal-chat-tools/index.ts` or
  `shared.ts`.**
- Superseded: slice-1's `normal-chat-tools/artifacts.ts`, its `label` field, its description table and its two
  timeout rows; slice-2's "Slice 1 creates it; Slice 5 moves it" rows (the App branch goes straight into 5a's
  `create.ts`); slice-5's reading that T2/T3's per-type tests land with the shell.
- Why: ruling 41's landing order (5 → 2 → 1) and ruling 40's single row are only satisfiable if the registry
  exists before the first type, and the per-type halves cannot precede the validators they call.

**44. The harness core lands early; each type slice owns — and runs — its own suite.**
- 5a lands, on slice 0's skeleton, the core of `slice-5.md §The eval harness`: `config.ts`, `client.ts` (the only
  reader of a key), `run.ts` with its flag table (`--suite`, `--replay`/`--skip-model`, `--limit`, `--only`,
  `--out`, `--help`), the known-bad-first refusal, the per-suite scorer dispatch in `scoring.ts`, the
  results-leak test, the `.gitignore` line and the `eval:artifacts` / `eval:artifacts:replay` scripts.
- Each type slice writes `suites/<suite>.ts`, `fixtures/<suite>/**` (with `known-bad/` and committed
  `responses/`), its scorer and its `cases.ts` entry, per slice-5's suite table, **and runs its live gate
  before it is called done**: S1 `document`; S2 `app` + `verification`; **S3 `canvas` (a new task T10 for
  slice 3, content from slice-5 §The eval harness, suite 3)**; S4 `slides`. No type slice edits `run.ts`,
  `config.ts` or `client.ts`. Slice 5b's T9 is the all-suite real run and the README's numbers.
- Superseded: slice-1 T13's file list (`document.ts`, `run.ts` → `suites/documents.ts`), slice-5 T8 writing
  every suite. Why: spec §4 and §8.1 make each suite the gate *of its type's slice*, and a weak result must
  change that type's design while its slice is still open.

**45. One home per shared comment/anchor symbol; Slice 1 creates the comment card.**
- `src/lib/shared/artifacts/anchor.ts`: slice 0 declares `Anchor`; slice 1 appends the interface pieces
  (`AnchorResolution`, `AnchorState`, `AnchorTone` and the pure helpers its ownership table lists). The Document
  text resolver stays in `src/lib/shared/artifact-document/anchor.ts` (ruling 35).
- Slice 3's `src/lib/shared/artifacts/comments.ts` imports those and never redeclares them; it holds the resolver
  interface, any comment-thread type not already declared by slices 0/1, and the canvas node/point resolver.
- `CommentCard.svelte` lives at the shared root `src/lib/components/artifacts/CommentCard.svelte`, **created by
  slice 1** (it lands first; its T10 margin needs it) and consumed by slice 3's pins — the `RefusalNotice.svelte`
  pattern. Rule: every exported symbol is declared once in the tree; later slices import it.

**46. Surfaces 4 and 6 get an owner: Slice 7** *(only if the owner answers Q2 "yes")*.
- Knowledge → Documents lists all five kinds with type chips and a Version column (surfaces mockup §4);
  Workspace Search finds every kind as flat rows labelled with the kind (§6). Both obey the containment rules
  (never an incognito artifact, never another user's, never outside `getArtifactOwnershipScope`).
- Specified as `slice-7.md` in the house format from the mockup (a docs agent drafts, the orchestrator reviews),
  implemented after slice 0 in wave 3, reviewed like any slice. Slice 0's non-goal line stays true for slice 0.

## 3. Waves, dependencies and dispatch points

```
D0  Wave 0  W0-A ∥ W0-B ∥ W0-C  (from dev) ────────► review ×3 ─► merge into dev ─► deploy dev env
            ─► merge dev into feat/artifacts                                          (runs beside wave 1)
D1  Wave 1  S0  spine ─────────────────────────────► review ×2 ─► merge            (no other slice starts)
            S7-spec drafted in parallel (docs only)
D2  Wave 2  S5a tools + catalogue + harness core ──► review ×1 ─► merge ──┐
            S1  Document  (T1–T3, T5–T9, T11, T12 first; T4, T10, T13 after S5a merges) ─► review ×2 ─► merge
            S2  App       (A1–A6, A10 first;  A7, A8's tool branch, A9 after S5a merges) ──► review ×2 ─► merge
D3  Wave 3  S3  Canvas (+ T10 canvas suite)  ──────► review ×2 ─► merge ──┐
            S4  Slides (T1, T2, T5, T6 first; T3, T4, T7, T8 after S3 merges) ─► review ×1 ─► merge
            S6  Tours  (T1, T2, T5 first;     T3, T4, T6, T7 after S4 and S5b merge)
            S7  Knowledge tab + Search (ruling 46; spec drafted during wave 1)
D4  Wave 4  S5b evidence (T4), bundle (T5), doc fixes (T6), all-suite real run (T9) — after S1–S4 merge and
            after `dev` is merged in (Feature 1's project files move under it) ─► review ×1 ─► merge
            S6  remainder ─► review ×1 ─► merge                                     (ruling 31: 5 before 6)
D5  Final   whole-branch review ×1, Phase 4 full walk, staging (if Q3), release checklist
```

### 3a. Wave 0 — six Feature 1 follow-ups (owner, 2026-09-25), in parallel with Wave 1

Branched from **`dev`** (they are Feature 1's, not Feature 2's), reviewed, merged into `dev`, deployed to the
dev environment, then merged into `feat/artifacts`. Evidence: `docs/plans/claude-at-home-1/progress.md`.

| # | Item | Decision (orchestrator, owner may overrule) | Agent |
|---|---|---|---|
| 1 | "Project files read" under-reports: the count is project files *selected as evidence*; a tool read (`read_generated_file` and any other file-reading tool) never counts because tool evidence rows carry no artifact id | **Make the row true, not vaguer:** the reading tool records the artifact id it actually resolved on its tool-call entry (`metadata`, as ruling 43's tools do); finalize unions those ids with the selected-evidence ids before the existing intersection with `listProjectKnowledgeArtifactIds`, counting a file once across its display/normalised siblings. No argument-guessing — only ids the tool resolved | W0-B (Sonnet) |
| 2 | `home-summary.ts:48` reads `process.env.HOME_SUMMARY_CACHE_TTL_MS` | Parse it in `env.ts` (default unchanged, still `0`-able for Playwright), read it through the env accessor; `config-store.ts` only if it is meant to be admin-overridable (it is not today) | W0-C (Sonnet) |
| 3 | ~17 tool descriptions ride the cached prompt prefix unasserted | **One catalogue snapshot per locale** (the rendered descriptions + schemas exactly as sent), not 17 × 2 hand assertions: any prefix change fails with a message naming the deliberate-update command, and a deliberate change costs one snapshot update in the same commit. Feature 2's 5a updates it once, with ruling 23's measured raise | W0-C (Sonnet) |
| 4 | The library picker's search box says "Search files in this project" but searches the library | Placeholder **and** accessible name name the library, EN + natural HU | W0-C (Sonnet) |
| 5 | The Files modal briefly says "No files yet." inside its fetch window (`projects/[projectId]/+page.svelte:203` collapses `null` into `[]`) | Thread "not loaded" through to the modal: a loading state while `null`, the empty state only for a real `[]` | W0-C (Sonnet) |
| 6 | The chat loads at the top, not the latest message, when content overflows (pre-existing, `MessageArea.svelte` bottom alignment) | Fix in `MessageArea.svelte` (it owns conversation scrolling, AGENTS.md); loads at the latest message on desktop and at 390 px, never hijacks a user who scrolled up, keeps streaming follow and the landing handoff | W0-A (**Opus**: touches every chat flow) |

| 7 | **Owner, 2026-09-25:** replies come back in Hungarian although the owner writes English; "fix it deeply". The per-message heuristic `detectLanguage` scores English words with Hungarian-looking letter pairs as Hungarian and flips a message on any accented letter; send and stream decide separately | Root cause proven first (corpus + dev-DB evidence + real-model before/after); then one resolver in `language.ts` for every caller: the latest message's language when clear, else the conversation's established language, then the UI language; context never decides; stated in turn guidance, never in the cached system prompt | W0-D (**Opus**: prompt text, every chat turn) |

Wave 0 reviewers (Opus): RV-W0-A (#6), RV-W0-B (#1), RV-W0-C (#2–#5), RV-W0-D (#7).

**Why this shape.** Slice 0 is reviewed *before* anything builds on it — a scope bug there is inherited by every
table. 5a is small and unblocks the tool-facing tasks of S1 and S2, which otherwise run in parallel with it on
disjoint files. S3 needs S1 (refusal notice, comment card, the panel's content area) and S2 (the App block,
the sandbox route). S4's model/layout/export work does not need S3; its ops tasks do (ruling 14: slice 3 owns
the ops mechanism). S6's table/types/admin work does not need the types; its panel trigger and empty states
need all four editors and land after S5b (ruling 31). S5b's evidence work is last of the product tasks by its
own spec ("against merged code").

**Blocked-task rule for parallel agents.** An agent whose remaining tasks wait on another slice's merge checks
`git log feat/artifacts --oneline --merges`; if the merge is there, it merges `feat/artifacts` into its branch
and continues; if not, it finishes every unblocked task, then **stops and reports "blocked on <slice>"** with
its state committed. The orchestrator resumes it (same agent, context intact) after the merge.

## 4. Agents, worktrees, ports, model class

| Agent | Scope | Branch | Worktree (`.claude/worktrees/…`) | `E2E_PORT` | Model |
|---|---|---|---|---|---|
| W0-A | Wave 0 #6 (chat scroll) | `fix/w0-chat-scroll` (from `dev`) | `w0-scroll` | 5710 | sonnet |
| W0-B | Wave 0 #1 (project files read) | `fix/w0-project-files-read` (from `dev`) | `w0-pfr` | 5720 | sonnet |
| W0-C | Wave 0 #2–#5 | `fix/w0-small` (from `dev`) | `w0-small` | 5730 | sonnet |
| W0-D | Wave 0 #7 (reply language) | `fix/w0-language` (from `dev`) | `w0-lang` | 5740 | sonnet |
| S0 | slice-0 all | `feat/artifacts-s0` | `art-s0` | 5400 | sonnet |
| S7-spec | draft `slice-7.md` from the surfaces mockup | `feat/artifacts-docs` | `art-docs` | — | sonnet |
| S5a | slice-5 T1, T2/T3 shell (ruling 43), T7/T8 core (ruling 44) | `feat/artifacts-s5a` | `art-s5a` | 5410 | sonnet |
| S1 | slice-1 all (+ its kind's T2/T3 cases) | `feat/artifacts-s1` | `art-s1` | 5420 | sonnet |
| S2 | slice-2 all (+ its kind's T2 cases) | `feat/artifacts-s2` | `art-s2` | 5430 | sonnet |
| S3 | slice-3 all + T10 canvas suite | `feat/artifacts-s3` | `art-s3` | 5440 | sonnet |
| S4 | slice-4 all (+ bodies line, card branch) | `feat/artifacts-s4` | `art-s4` | 5450 | sonnet |
| S6 | slice-6 all | `feat/artifacts-s6` | `art-s6` | 5460 | sonnet |
| S5b | slice-5 T4, T5, T6, T9 | `feat/artifacts-s5b` | `art-s5b` | 5470 | sonnet |
| S7 | slice-7 | `feat/artifacts-s7` | `art-s7` | 5480 | sonnet |
| Reviewers | per §7 | `<branch>-review-<area>` | `rv-<slice>-<area>` | 5500, 5510, … (one block each) | **opus** for RV-W0-A, RV-0A, RV-1A, RV-2A; **sonnet** for every other review |
| Fix batches | copy/i18n-only review fixes | the slice branch | the slice worktree | its port | sonnet |
| Orchestrator checkpoints | Phase 4 | — | `art-base` | dev server 5600 | — |

Owner, 2026-09-25, revised after the app restart (Opus agents were eating the owner's token limit): **Sonnet 5 for all
implementation**, heavy slices included; **Opus 5.5 only for the adversarial reviews where a missed bug is expensive**
— RV-W0-A (chat scroll touches every chat flow), RV-0A (Slice 0 data ownership), RV-1A (Slice 1 patch protocol and
hash refusal), RV-2A (Slice 2 sandbox and CSP); Sonnet for every other review.

**Setup (every agent, in its brief):**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
cd /Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai
git worktree add .claude/worktrees/art-<x> -b feat/artifacts-<x> feat/artifacts
cd .claude/worktrees/art-<x>
ln -s ../art-base/node_modules node_modules          # S1/S3: `npm ci` instead, before adding deps
mkdir -p data
DATABASE_PATH="$PWD/data/playwright-e2e-chat.db" npm run db:prepare   # once, before the first Playwright run
export E2E_PORT=<port>
```

**Every dispatch brief carries:** role and the "never" list (§1); the reading order (header of this file); the
rulings that override its slice text (39 amended, 43–46 as they apply); its exclusive files and its append-only
files with landing order (§5); its blocked tasks (§3); the gates and baseline (§6); the report format (commits
with hashes, tests added, real gate output with numbers, eval result, chunk sizes, deviations, open
questions).

## 5. File ownership

**Exclusive files** are each slice's own rows in its `slice-N.md §File ownership` table, amended by rulings
43–45. Nobody else writes them. **Shared, append-only files** and their landing order:

| File | Order | Rule |
|---|---|---|
| `src/lib/server/db/schema.ts`, `drizzle/*`, `_journal.json`, `scripts/prepare-db.ts` (`requiredExistingTables`) | S0, then S6 | next free number at branch time; renumber on a `dev` collision |
| `src/lib/server/services/artifacts/index.ts` (facade) | S0 creates; S5a, S1, S2, S3, S4, S5b append | one export block per slice |
| `normal-chat-tools/index.ts`, `normal-chat-tools/shared.ts` | **S5a only** (ruling 43) | type slices never touch them |
| `normal-chat-tools/artifact-tools/{create,read,edit}.ts` | S5a creates; S1/S2 (wave 2 merge order), S3, S4 append their kind's entry | one entry per kind per tool |
| `scripts/eval-artifact-contracts/cases.ts`, `scoring.ts` (dispatch), `README.md` | S0 skeleton → S5a core → S1/S2 → S3 → S4 → S5b | a suite file per type; `run.ts`/`config.ts`/`client.ts` are S5a-only |
| `src/lib/components/artifacts/artifact-bodies.ts` | S0 → S1 → S2 → S3 → S4 | one loader line each |
| `src/lib/components/artifacts/ArtifactCard.svelte` | S0 → S1 → S2 → S3 → S4 | one preview branch each |
| `src/lib/components/document-workspace/DocumentWorkspace.svelte` | S0 → S1 → S3 → S4 → S6 | never two open branches editing it at once; S2 does not touch it |
| `src/routes/(app)/chat/[conversationId]/+page.svelte` | S0 → S1 (→ S3/S4 only if their briefs need an open action) | re-anchor by symbol: `dev` changed it after the pass |
| `src/lib/i18n/artifacts.ts` + test | S0 creates `artifacts.type.*` (ruling 22); every slice appends its namespace | EN+HU in the same commit |
| `src/lib/i18n/index.ts`, `src/lib/i18n.test-helpers.ts`, `scripts/validate-i18n.ts` | S0 registers the module/prefix (and `artifacts` in the validator's `MODULES`); later slices add a prefix only if they open a new top-level namespace | — |
| `src/lib/client/api/artifacts.ts` + test | S0 creates; S1, S2, S3, S4, S6 append | — |
| `src/lib/shared/artifacts/anchor.ts` | S0 → S1 (ruling 45) → S3 imports | declared once |
| `src/lib/components/artifacts/RefusalNotice.svelte`, `CommentCard.svelte` | S1 creates both; S3, S4 consume | no copies |
| `src/lib/shared/artifacts/ops.ts`, `services/artifacts/ops.ts`, `api/artifacts/[id]/ops/+server.ts` | S3 creates; S4 adds the `slides` branch | ruling 14 |
| `tests/cross-cutting/incognito-artifact-containment.test.ts` | S0 extends; then S1, S2, S3, S4, S5b, S6 (S7) append | **no new `ALLOWED_WITHOUT_SCOPE` entry, ever** |
| `src/lib/server/services/account-data-archive/**`, `account-lifecycle/user-scoped-tables.ts` | S0; S2 (kv as text); S6 (tour states) | ruling 24, 33 |
| `src/lib/server/services/knowledge/types.ts` | S0 (`kind?` on `DocumentWorkspaceItem`, and `"artifact"` in `ArtifactType` — slice 0 writes `type: "artifact"` rows, so it cannot wait for slice 5's row, which becomes a no-op), S1–S4 per-kind fields | — |
| `package.json` / `package-lock.json` | S1 (tiptap), S3 (xyflow etc.), S5a (npm scripts only) | exact pins; lockfile conflicts are re-generated with `npm install`, never hand-merged |
| `AGENTS.md`, `src/lib/server/services/AGENTS.md` | S0 (boundary entry), S5b (ruling 5/21 corrections) | different paragraphs |
| `src/app.css`, `tailwind.config.ts` | S3 (canvas tokens); anyone else asks first | tokens, never hex in components |

A merge conflict in an append-only file is resolved by **keeping both sides**, never by taking one.

## 6. Gates, with the baseline they are measured against

Baseline measured on `feat/artifacts` at `00ef6d2a` (= `dev` `e1388193` + docs), 2026-09-25 11:13 (the first
measurement, at `b73ea102`, differed only by `dev`'s 13 new tests):

| Gate | Command | Baseline | A slice passes when |
|---|---|---|---|
| Types | `npm run check` | 0 errors, **17 warnings** in 3 files: `ToolActivityRow.svelte` 10, `ThinkingBlock.svelte` 6, `RouteItinerary.svelte` 1 | 0 errors, **no new warning** (S0 touches `ToolActivityRow.svelte`: its count may not grow) |
| Lint | `npx biome check src scripts tests` | clean, 1,883 files | clean. `npm run lint` is broken by the nested worktrees — say so |
| Unit | `npm test` | 794 files passed + 1 skipped; 11,981 tests passed + 2 skipped; 99 s | all green, counts up |
| Build | `npm run build` | exit 0; the same 17 warnings = 34 lines (32 `Unused CSS selector` + 2 `must have an ARIA role`; each printed twice) | no new warning — count those two phrases, never grep for "warn" |
| Migrations | `npm run check:migrations`; after schema changes also `npm run db:prepare` on a scratch DB | pass | pass, and the new tables are in `requiredExistingTables` (ruling 29) |
| Fallow | `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow-<x>.json` | 124 issues: unused files 13, exports 87, types 9, deps 4 (3 + 1 dev), class members 4, unlisted deps 2, duplicate exports 1, **circular 4**; JSON kept at `~/.cache/alfyai-artifacts/fallow-baseline-00ef6d2a.json` | no new issue entry; no new broad ignore; circular count reported |
| Containment | `npx vitest run tests/cross-cutting/incognito-artifact-containment.test.ts` | green | green with `ALLOWED_WITHOUT_SCOPE` unchanged |
| i18n | `npx vitest run src/lib/i18n.test.ts` + `npx tsx scripts/validate-i18n.ts` | green | green; no user-visible "Artifact" (EN or HU) |
| E2E | `E2E_PORT=<port> npx playwright test tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts <slice specs>` | **22 passed** (37 s) on port 5400, after the `db:prepare` step in §4 (without it: web-server timeout at 120 s) | green, pass count read from the output |
| Eval (type slices) | `npx tsx scripts/eval-artifact-contracts/run.ts --suite <suite>` through the tunnel; `--replay` in CI | — | known-bad set fails first; the suite's pass bar (slice-5 table) met; numbers in the report |
| Lazy load | the slice's chunk method (`scripts/check-artifact-chunks.mjs` from S3 on) | — | the slice's budget, method named |
| Visual | the orchestrator, at checkpoints: 1440×900 and 390×844, light and dark, against the named mockup surface | — | matches, or the difference is listed |

## 7. Review plan (Phase 3): one reviewer per disjoint area, never the implementer

Every reviewer works in its own worktree off the slice branch's HEAD, writes a **failing test first** for every
defect, fixes it, runs the full suite, and reports. Findings go into `review-<wave>.md`. Hunt order is
`plan.md §Phase 3`. Every reviewer also checks spec §6's cross-cutting rule, which slices 0, 1 and 5 never
mention: **telemetry and log lines carry no artifact content** (bodies, titles, comments, kv values, prompts).
The areas:

| Wave | Reviewer | Area |
|---|---|---|
| 1 | RV-0A | data and server: migration, three tables, facade, ownership scope, incognito, erasure/archive/Clear Memory, routes and 401, conversation-detail payload |
| 1 | RV-0B | client: the panel rebuild across its three callers, the card, File on the card with no regression, the list and the count button's surfacing rule, i18n + naming guard, Svelte 5, 390 px, dead code |
| 2 | RV-5a | prompt-prefix byte stability, no scope fields in schemas, EN/HU description parity and the budget raise, catalogue per conversation, harness key rule / replay / known-bad-first |
| 2 | RV-1A | Document engine and server: mint-before-hash, reload id stability, the canonical-hash gate, per-op refusal, snapshot transaction, `expectVersion`, route ownership, the `@Alfy` path, export ticks in four renderers (ruling 36) |
| 2 | RV-1B | Document editor: lazy chunk, Tiptap in Svelte 5, Keep/Undo exactness, the refusal notice, tabs/chips, the comment margin, the 137 px mobile toolbar, keyboard path |
| 2 | RV-2A | App sandbox: `sandbox` exactly `allow-scripts`, the exact CSP, the non-overridable bootstrap, `postMessage` source/origin checks, kv caps/ownership/incognito, `.html` as attachment only |
| 2 | RV-2B | App generation: thinking off at the provider boundary, verification before the card, repair rules, visible cost, regenerate versions, the `app`/`verification` eval results |
| 3 | RV-3A | Canvas client: the Svelte Flow v1 trap table, pane-sized overlays, z-index, reparenting, connectors, drawing layer, perf budgets; photos and live web first (ruling 16) |
| 3 | RV-3B | Canvas server/export: ops envelope, `validateBoardDiff`, canonical JSON hash, PNG + posters, the refresh route (outbound fetch: SSRF and ownership), the `canvas` eval |
| 3 | RV-4 | Slides: caps, patch refusal, the scoped ask call, the PPTX program in the sandbox, present mode, same-device notes, `slides` eval "no invented facts" |
| 3 | RV-7 | Knowledge tab + Search (if Q2): containment, ownership, labels, 390 px |
| 4 | RV-5b | evidence rows + `EvidenceSourceType` exhaustiveness, bundle provenance, AGENTS.md accuracy, dead `fileProductionToolsAvailable`, all-suite results |
| 4 | RV-6 | tours: the `getLatestPublishedCampaign` predicate fix, once per user per kind, incognito shows none, archive/erasure, admin seeding |
| 5 | RV-final | the whole branch: one refusal notice, one comment card, one anchor interface, one ops mechanism, one tool registry; Fallow diff vs baseline; i18n parity; no "Artifact" in the UI |

## 8. Merge protocol

1. The implementer finishes its tasks green, merges the latest `feat/artifacts` into its branch (append-only
   conflicts: keep both sides), re-runs the gates and reports.
2. Reviewers branch from that HEAD; their fix branches are merged into the slice branch by the orchestrator.
3. The orchestrator merges the slice with `git merge --no-ff feat/artifacts-<x>` inside `art-base`, runs
   `npm ci` if the lockfile moved, re-runs the integration gates, and records the numbers in `progress.md`.
   A non-trivial conflict goes back to the implementer; the orchestrator does not write feature code.
4. At each wave boundary the orchestrator merges `dev` into `feat/artifacts` (Wave 0's fixes and anything
   else on `dev`), checking `drizzle/` for a number collision (§1).
5. After a wave is reviewed, merged and green on `feat/artifacts`, the orchestrator merges `feat/artifacts`
   into `dev` (`--no-ff`), pushes `dev`, deploys the dev environment with the classifier-safe command
   (memory: staging verify harness), restarts `langflow-chat-dev` if the script could not, and runs the wave's
   real-model checks there. **`main` and production: only when owner and orchestrator both call it polished,
   together with a new announcement campaign.**

## 9. Verification (Phase 4)

**Checkpoints by the orchestrator** after waves 1, 2, 3 and at the end, on a local dev server in `art-base`
(port 5600, scratch DB) with the real model through the tunnel, walking the surfaces in the built-in browser at
1440×900 and 390×844, light and dark:

- after wave 1: a produced file renders through the new card and panel with no regression; the count button is
  absent in a chat that made nothing; the panel list (surfaces 1–3);
- after wave 2: "Írj egy checklistet a hétvégére" → a Document; tick in the card; an Alfy edit with Keep and
  Undo; reload keeps ids and still refuses a stale patch; a comment with `@Alfy` applies a change; "give me a
  PDF" still goes to `produce_file`; an App generates with thinking off, appears only after verification, runs
  offline, `window.alfy.storage` survives two openings; the cost display shows the extra calls;
- after wave 3: a Canvas diff applies with the arranging pill; drawing, then PNG export contains it; Slides:
  layouts, present mode, PPTX; the Knowledge tab and Search (if S7);
- final: everything above, plus the project bundle (§5), the tours once per kind and replayable from the panel
  (§7), the Knowledge Documents tab (§4), Workspace Search (§6), and every type's eval suite re-run live.

**Staging** (ai.dev.alfydesign): after every reviewed wave (§8.5) the same checks run there against the real
deployment, its data may be changed freely, and its service journal is read for new warnings. **Production**
only when owner and orchestrator both call the system polished; the final report ends with the staging →
production release checklist, which includes drafting the release's announcement campaign slides.

## 10. Reporting and resume

- `progress.md` (this directory) is the resume point: current wave, every agent's branch/worktree/state and
  last commit, merge hashes, gate numbers, open questions. Updated at every dispatch, report and merge.
- After each phase: a short status to the owner with commit hashes, real gate numbers, review findings fixed,
  open questions. `review-<wave>.md` per review batch.

## 11. Review Focus (the failure modes most likely to bite, beyond `plan.md`'s six)

1. **A tool description that disagrees with its validator.** The model writes what the description says; if
   5a's description and S1's `applyPatchSet` differ by one field name, every edit is refused *legally* and
   nothing looks broken. Pinned by S1's live `document` suite and a unit test in S1 that feeds the
   description's own example through the validator.
2. **An append-only file resolved by taking one side.** Parallel waves guarantee conflicts in the registry and
   dictionary files; a lost line is a type that silently has no body or no Hungarian. Pinned by the i18n parity
   test, a registry-completeness test (every `ArtifactKind` has a loader), and the orchestrator's post-merge
   gates.
3. **A migration number shared with `dev`.** The other group can land `1777140000111` too; drizzle then skips
   one of them on a DB that has the other. Pinned by the collision check at every `dev` merge and by
   `db:prepare` on a scratch DB in the integration gates.
4. **The shared model under eval load.** Live suites hit the family's production model. Runs are sequential,
   bounded, and stop after two 429/5xx (slice-5 cost discipline); the orchestrator schedules them, never two at
   once.
5. **A fresh worktree that "passes" without running E2E.** A Playwright run that timed out on an empty DB is not
   a pass. Pinned by the `db:prepare` step in every setup and by reading the pass count, not the exit code alone.

## 12. Owner answers (2026-09-25)

- **Q1 — sub-agent model:** the no-Claude rule is retracted; after the app restart the owner approved Sonnet 5 for all
  implementation and Opus 5.5 only for the four riskiest reviews (§4).
- **Q2 — surfaces 4 and 6:** build them — Slice 7, ruling 46.
- **Q3 — staging:** the other group has pushed everything to `dev`; this run works freely and deploys to the dev
  environment only. Production (`main`) when both call it polished, with a new announcement campaign.
- **Added:** Wave 0, six Feature 1 follow-ups (§3a).
- Defaults kept: Slides proceeds without a prototype (spec §9.1); English **Canvas**, Hungarian **Tábla**
  (ruling 20); commits carry `plan.md`'s trailer.
