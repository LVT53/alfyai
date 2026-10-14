# AGENTS.md

**Generated:** 2026-04-06 15:20 UTC  
**Commit:** 2322eed  
**Branch:** main  

This file is the canonical engineering map for AlfyAI. Read it before changing code. Public setup, deployment, and environment documentation live in [README.md](./README.md). Product and design notes in other docs are supplemental, not the source of truth for code placement.

## Mandatory Docs Check

- Before touching code, check current documentation through Context7 and the Svelte/SvelteKit MCP docs tools for the relevant framework or library surface.
- This is especially required for Svelte, SvelteKit, Tailwind, Vitest, Playwright, Drizzle, and any fast-moving integration used by this app.
- Do not write framework code purely from memory when an MCP-backed docs check can confirm the current API or recommended pattern.
- The goal is to avoid stale code, deprecated patterns, and implementations that drift away from the real versions used in this repo.
- If the Svelte MCP/docs tool is unavailable in the current session, use the best available official docs path before coding and call out that fallback explicitly.

## Fallow Audit Gate

- Fallow is pinned in `package.json` to one exact release (`fallow`, 3.33.1 today), and the gate runs that release whether or not `node_modules` has it: `npx -y fallow@<that version>`. A bare `npx fallow` runs whatever is installed, or the latest release where nothing is, and releases report differently. Bumping the pin and making the baseline again (below) are one change: `scripts/gates.test.ts` fails when the baseline was made by another release.
- Before calling a patch finished, run the Fallow step against the current worktree. It is one of the steps of `scripts/gates.sh agent <out-dir> ...` (see Mandatory Verification), and it runs alone with `scripts/gates.sh agent "$TMPDIR/alfyai-gates" --skip check,biome,migrations,vitest,build,chunks,playwright`. The raw report: `npx -y fallow@3.33.1 --no-cache --format json --quiet --score > "$TMPDIR/alfyai-fallow.json"`. The report is stdout: Fallow 3 refuses `--output-file` anywhere but inside the project root or the system temp dir, so never hand it a path of the caller's.
- The step compares the report's `check` section with the baseline committed in `.fallow/baseline.json`. A finding is its kind, path and name: its position, `finding_id`, `actions`, `effective_severity` and `reachability_caveats` are not part of it, so a finding that only moved is not new. A finding the baseline lacks fails the step, and so does a fifth circular dependency. The health score, duplication and lines of code on the step's summary line are information only; nothing reads them back.
- The baseline holds known architectural debt and nothing else (today: the four circular dependencies). Make it again only with a recorded reason, from a report made as above: `node -e 'const [f]=process.argv.slice(1),r=JSON.parse(require("fs").readFileSync(f));delete r.check.elapsed_ms;require("fs").writeFileSync(".fallow/baseline.json",JSON.stringify({check:r.check},null,"\t")+"\n")' "$TMPDIR/alfyai-fallow.json"`. `.fallow/` also holds Fallow's cache when it runs without `--no-cache`; Fallow ignores that with a `.gitignore` of its own, and the baseline is the one tracked file there.
- Treat new Fallow findings as regressions unless they are intentional public API, dynamic entry points, or known architectural debt documented in `.fallowrc.json`.
- Do not add broad `ignoreExports`, `ignorePatterns`, or rule suppressions just to make the report green. Every new ignore must describe a real public boundary, dynamic loader, standalone script, or false positive.
- If a change intentionally affects the remaining circular-dependency debt, rerun Fallow and report whether the four known cycle findings changed.

## Typecheck Gate

- Before calling a patch finished, run `npm run check` and keep it fully clean: 0 errors and 0 warnings.
- Treat new `svelte-check` diagnostics as regressions. Fix them in the same patch unless the user explicitly asks to defer them.
- If `npm run check` fails because of pre-existing diagnostics unrelated to the patch, report the exact current count and files, and do not introduce any new diagnostics.

## Svelte 5 Migration Rules

- Prefer Svelte 5 callback props over `createEventDispatcher` for component-to-parent communication.
- Prefer `$props()` and typed `PageProps` / `LayoutProps` in SvelteKit route components.
- Prefer modern event attributes like `onclick` and `onsubmit` over legacy `on:` directives in touched files.
- In rune components, declare `bind:this` refs with `$state(...)` when the ref is later read by effects or handlers.
- Touch event attributes are passive by default in Svelte 5. If a handler truly needs `preventDefault()` (for example custom touch dragging), attach a non-passive listener via an action or explicit `addEventListener`, not legacy event modifiers.
- Prefer `{@render children()}` in layouts over legacy route `<slot />` usage.
- Do not introduce new `afterUpdate` or `beforeUpdate` calls; use a modern effect- or action-based approach instead.
- Do not introduce new legacy `<slot>` usage in app components; prefer explicit props or snippets when composition is needed.
- Legacy syntax that still exists in untouched files is migration debt, not a pattern to copy forward.

## Purpose

- Use the existing boundaries in this file before inventing new ones.
- Optimize for reliability, low duplication, and clear ownership.
- Keep behavior stable at the route, SSE, DB, and component-contract layers unless the change is explicitly intended to alter those contracts.
- Prefer extending an existing subsystem over adding a new top-level service, store, or client helper.

## Core Rules

- Routes are adapters. Durable logic belongs in server services, client API modules, stores, or shared helpers.
- Shared behavior should exist once. Do not copy logic between `send` and `stream`, between multiple stores, or between multiple services.
- Composer command and skill work belongs in explicit app-owned boundaries: composer UI in `src/lib/components/chat/MessageInput.svelte` and related chat command components, browser fetch logic in `src/lib/client/api/skills.ts`, durable skill/session/note behavior in `src/lib/server/services/skills/`, chat-turn parsing and prompt integration in `src/lib/server/services/chat-turn/`, and Skill Note artifact behavior through the knowledge service boundary. Do not hide skill persistence, note writes, command parsing, or Skill Control Envelope handling in route-local closures.
- Runtime config flows through `src/lib/server/config-store.ts`. Do not bypass it in code that should respect admin overrides.
- New Composer Command, Skill, Skill Session, Skill Note, and Linked Source UI labels, errors, confirmations, empty states, and accessibility strings must be localized in both English and Hungarian.
- `src/lib/server/env.ts` owns environment parsing, including `getDatabasePath()` for DB bootstrap-only access. Do not read `DATABASE_PATH` directly anywhere else.
## App Map

### Config And Environment

- Environment parsing:
  - [`src/lib/server/env.ts`](./src/lib/server/env.ts)
- Runtime merge and normalization:
  - [`src/lib/server/config-store.ts`](./src/lib/server/config-store.ts)
- Admin config route:
  - [`src/routes/api/admin/config/+server.ts`](./src/routes/api/admin/config/+server.ts)
- Admin user-management routes:
  - [`src/routes/api/admin/users/+server.ts`](./src/routes/api/admin/users/+server.ts)
  - [`src/routes/api/admin/users/[id]/+server.ts`](./src/routes/api/admin/users/[id]/+server.ts)
  - [`src/routes/api/admin/users/[id]/sessions/+server.ts`](./src/routes/api/admin/users/[id]/sessions/+server.ts)
- Settings loaders:
  - [`src/routes/(app)/settings/+page.server.ts`](<./src/routes/(app)/settings/+page.server.ts>)
  - [`src/routes/api/settings/+server.ts`](./src/routes/api/settings/+server.ts)
- Two-scope instruction resolution: [`src/lib/server/services/instructions.ts`](./src/lib/server/services/instructions.ts)

Notes:

- `env.ts` also owns `getDatabasePath()` for bootstrap-only DB path access.
- Title-generator prompt variants flow through `env.ts`, `config-store.ts`, and the admin system settings UI. Keep English/Hungarian base prompts and code-only appendices aligned across those layers.
- TEI endpoint/model tuning also flows through `env.ts` plus `config-store.ts`. Keep API keys env-only, and keep runtime overrides on the non-secret fields.
- `config-store.ts` remains the override-aware runtime config boundary. `getDatabasePath()` is for early DB/bootstrap code, not for general runtime settings reads.
- Context token limits are admin-configurable via `config-store.ts`:
  - `MAX_MODEL_CONTEXT` (default: 262144) - Maximum tokens the model context window supports
  - `COMPACTION_UI_THRESHOLD` (default: 209715) - UI warning threshold at 80% of max
  - `TARGET_CONSTRUCTED_CONTEXT` (default: 157286) - Target context size at 60% of max
  - Use getter functions in `config-store.ts` (e.g., `getMaxModelContext()`, `getCompactionUiThreshold()`, `getTargetConstructedContext()`) to read these values with admin overrides applied.

If you add a new runtime-configurable setting:

1. add env parsing/default handling in `env.ts` if it is environment-backed
2. add runtime normalization and override support in `config-store.ts`
3. expose it to the relevant settings/admin loaders and routes
4. update [README.md](./README.md) and [`.env.example`](./.env.example)

Do not:

- read directly from `process.env` or `env.ts` inside services that should respect admin overrides
- read `process.env.DATABASE_PATH` directly outside `env.ts`
- import override-aware runtime config into bootstrap code that only needs the DB file path
- document a config variable publicly without confirming it exists in real code paths
- add admin-configurable behavior in the UI without threading it through `config-store.ts`

## Known Traps

- If you touch chat send/stream behavior, you are changing a multi-file contract:
  - server route
  - `chat-turn/*`
  - browser stream consumer
  - related tests
- Admin settings can override env-backed defaults. A change that looks correct in `.env` may still be superseded at runtime.
- Auxiliary services such as title generation and context summarization should degrade gracefully. Do not make them hard dependencies of the core chat path unless that behavior change is intentional.
- Do not restore deleted `project-memory.ts`-style architecture or add duplicate DB wrapper files. New persistence should stay in the owning service unless a narrow compatibility shim belongs in `db/compat.ts`.

## Change Placement Guide

- New chat request/shared turn logic:
  - `src/lib/server/services/chat-turn/`
- New Normal Chat prompt/model/tool behavior:
  - `src/lib/server/services/normal-chat-context.ts`
  - `src/lib/server/services/normal-chat-model/`
  - `src/lib/server/services/normal-chat-tools/`
  - `src/lib/server/services/normal-chat-control-model.ts`
  - `src/lib/server/services/normal-chat-failover.ts`
- New admin-managed user account behavior:
  - `src/lib/server/services/user-admin.ts`
- New knowledge artifact or context behavior:
  - `src/lib/server/services/knowledge/`
- New artifact-family (Document/App/Canvas/Slides/File) behavior:
  - `src/lib/server/services/artifacts/`
  - `src/lib/components/artifacts/`
- New chat-generated file behavior:
  - `src/lib/server/services/chat-files.ts`
  - `src/lib/server/services/sandbox-execution.ts`
- New continuity or evidence-context logic:
  - `src/lib/server/services/task-state.ts`
- New profile-memory behavior:
  - `src/lib/server/services/memory-judge/` (intake), `memory-consolidation/` (maintenance), `memory-profile/` (projection)
- New reusable browser API call:
  - `src/lib/client/api/`
- New client state transition:
  - `src/lib/stores/`
- New landing/chat handoff behavior:
  - `src/lib/client/conversation-session.ts`
- New environment-backed runtime setting:
  - `src/lib/server/env.ts` and `src/lib/server/config-store.ts`

## Commit and Push Discipline

- Commit in small, focused chunks. Each commit should contain one logical change — a single feature, a single fix, or a single refactoring — so that `git bisect` and `git revert` remain useful tools.
- Write commit messages that explain the *why*, not just the *what*.
- Never push to any remote branch without explicit user request. The local commit history is the source of truth until the user explicitly asks for a push.
- Do not batch unrelated changes into a single commit just because they happen in the same session.

## Build and Runtime Warning Discipline

- A clean build is a required invariant. `npm run build` must produce **zero warnings** from Vite, Svelte, TypeScript, or any compiler plugin.
- Every warning must be fixed or explicitly suppressed with a comment explaining why suppression is safe.
- In Svelte 5, `state_referenced_locally` warnings indicate a prop is being read inside `$state()` initialisation and will not react to future changes. When capturing an initial value is intentional, wrap the read in `untrack(() => ...)` to make the intent explicit and silence the compiler.
- Do not ignore warnings because the app "still works." Warnings are often early signals of stale data, missed reactivity, or future breaking changes.
- If a dependency upgrade introduces new warnings that cannot be immediately resolved, pin the dependency and file a tracked follow-up task. Do not leave unpinned warnings in the build output.


## Mandatory Verification

Default verification after meaningful changes (an agent runs the whole of it **once, at the end**: the owner's speed rule):

```bash
scripts/gates.sh agent <out-dir> --port <base> [--workers N] <the e2e specs you changed or added>
```

It runs the static gates (`npm run check`, `npx biome check src scripts tests`, `npm run check:migrations`, `npm test`, `npm run build`, `npm run check:artifact-chunks`, Fallow against its baseline) side by side, then your specs in full plus the `@smoke` tests of every other file, and prints one screen with each step's exit code, numbers and duration (about 4 minutes; vitest is most of it). While iterating, run the single commands: `npm run check`, `npm test`, `npm run build`. In a worktree use `npx biome check src scripts tests`, not `npm run lint` (it stops at the nested worktrees' biome roots).

Name the specs that cover what you changed (they run in full; the `@smoke` set covers the rest of the app):

- chat send/stream behavior: `tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts`
- landing/chat draft handoff or composer behavior: `tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts`
- settings/admin/config behavior: `tests/e2e/settings-admin.spec.ts tests/e2e/login.test.ts`
- login/search/shell regressions: `tests/e2e/login.test.ts tests/e2e/search-modal.spec.ts`
- an artifact kind: its `tests/e2e/artifact*.spec.ts` files (the Document, App and Canvas ones are named by kind)

Playwright runs against the **production build** (`npm run build` first, about 15 s alone; a build older than `src/` is refused before any server starts, and a build that does not hydrate stops the run in two seconds), with one server and one SQLite file per worker slot: slot N is Playwright's `TEST_PARALLEL_INDEX` N, served on `E2E_PORT + N` with `data/playwright-e2e-chat-wN.db` and its own seeded admin, so spec files run side by side without meeting each other's rows. `tests/e2e/e2e-env.ts` says what a slot is, `tests/e2e/global-setup.ts` makes the databases and starts the servers, `playwright.config.ts` points each worker at its slot. **Never run `npm run check` or `npm test` while `npm run build` runs** (both run `svelte-kit sync`, which rewrites `.svelte-kit/` under the build: it still exits 0 and the app it made does not hydrate); `scripts/gates.sh` orders them for you.

- **Iterating on UI code** (a rebuild per change would be slower): `E2E_SERVER=dev E2E_PORT=<port> npx playwright test <spec>`: `vite dev`, one worker by default, one optimizer cache per server.
- **One or two specs on the build:** `E2E_PORT=<port> E2E_WORKERS=2 npx playwright test <spec> [<spec>]`. Beside one or two other agents use `E2E_WORKERS=4` at most; a run takes `E2E_WORKERS` ports from `E2E_PORT`.
- **The smoke tier** (25 tests tagged `@smoke` across sign in, chat and streaming, each artifact kind in the panel, a Document edit and its version, a Canvas block, a tour, knowledge, settings and projects; about 30 s): `E2E_PORT=<port> npm run test:e2e:smoke`.
- **The release gate:** `scripts/gates.sh release <out-dir> --port <base>` runs the same static gates, then the whole Playwright suite minus `tests/e2e/quarantine.json` (6 workers by default; `--workers 8` on a quiet machine). About 8.5 minutes on this Mac against 51 before: the e2e run starts when the build is done and vitest runs beside it on three threads (`--schedule phased` runs the static gates first and the e2e run alone: 10.7 minutes). An agent's run is phased: a few spec files finish in a minute, and vitest on three threads would be its longest step. A new spec joins the gate by existing; a spec or test leaves it only through the quarantine list, by name, with its reason (a unit test refuses an entry without one).
- A flaky test is a bug in the test or the app: find the cause (shared state, a measurement taken mid-animation: `waitForStableBoundingBox`, `waitForMotionToSettle`, `expectTopmost` in `tests/e2e/helpers.ts`). Never a blanket retry, a longer global timeout or a weaker assertion. A worker keeps its database from one spec file to the next, so state a spec sets (an admin override, a provider, the user's model, a language) is put back in that spec's own cleanup (`clearAdminConfig`, `deleteProvidersWithPrefix` in `helpers.ts`).
- A spec that makes a conversation only to put things in it uses `createEmptyConversation` (no first message, so no first turn to a model the server cannot reach racing everything after it), not `createConversation`. A block that gets a poster (map, App, photos, live web) has a hidden copy of itself in `<body>` meanwhile: address it as `liveBlock(page, testId)`, not `page.getByTestId(testId)`. Both are held by `tests/integration/e2e-conventions.test.ts`, which names the file and the fix.
- Only one e2e run per worktree at a time (they share the databases and `build/`); a second one is refused with the holder's process id.

Playwright note:
- E2E runs set `PLAYWRIGHT_TEST=1` and `HOME_SUMMARY_CACHE_TTL_MS=0` on every server.
- In that mode, [`src/routes/api/conversations/[id]/title/+server.ts`](./src/routes/api/conversations/[id]/title/+server.ts) short-circuits and returns `title: null` so browser tests do not depend on a live title-generator service.
- Each server's log is `data/e2e-servers/slot-N.log`, every line with the seconds since that server started: a failing spec's server-side story is there. `PLAYWRIGHT_REUSE_EXISTING_SERVER=true` uses a server already listening on a slot's port (its database is reset in place); without it a busy port is an error. A SIGTERM or SIGHUP to the runner stops its servers and frees the run lock.
- The spec's own process seeds rows through the app's services into the file its server also writes, so both load `tests/e2e/sqlite-immediate.cjs` (transactions take their write lock at BEGIN): a deferred read-then-write transaction that meets the other process's commit fails at once with "database is locked", and the busy timeout does not help (one whole-suite run in ten).
- A spec that matches a request for a lazily loaded module by its source path (`vite dev` serves `/src/lib/...`) must ask `moduleUrlPattern` in `tests/e2e/build-assets.ts`: the build serves hashed chunks, which its manifest names.

Run these too when relevant:

- deployment/config/docs changes:
  - `npm run db:prepare`
  - keep `scripts/deploy.sh` and `npm start` aligned with the current DB migration story; deploys through that script should always run the idempotent `db:prepare` step before serving new code, and the production start command must not skip pending migrations
  - verify [`src/routes/api/health/+server.ts`](./src/routes/api/health/+server.ts) still matches docs and deploy expectations
- knowledge upload or extraction changes:
  - verify upload size expectations remain aligned with [README.md](./README.md) and deployment docs

## What Not To Reintroduce

- No new top-level `src/lib/server/services/*.ts` public boundary just because one file is getting large.
- No parallel memory subsystem beside `task-state.ts` (continuity) and the Memory Profile / Memory Judge / Consolidation stack (profile memory).
- No duplicated route-specific chat execution logic.
- No new raw `sessionStorage` protocol outside `conversation-session.ts`.
- No direct env reads in override-aware runtime services.
- No general runtime migrations in app bootstrap. If production safety ever requires a bounded additive compatibility shim, keep it isolated in `src/lib/server/db/compat.ts`, document it in the README, and continue treating `npm run db:prepare` as the real migration path.
- No duplicate DB repository wrappers. (Per-table wrappers stay forbidden. ONE query-execution
  seam is permitted under [ADR-0059](docs/adr/0059-db-execution-seam.md) — owning *how* a query
  runs, not *what* is queried.)
- No stores that also become API clients.
- No monolithic catch-all service file that mixes unrelated concerns again.
- No revival of deleted legacy files just because they reappear as untracked leftovers after merges or agentic runs; verify git history before restoring anything outside the tracked graph.
- No new hand-crafted inline `<svg>` icon elements. All UI icons must come from `@lucide/svelte` (see Visual System rules).

## Doc Map

- [README.md](./README.md)
  - public setup, deployment, stack, env vars, operational caveats
- [AGENTS.md](./AGENTS.md)
  - canonical engineering boundaries and placement rules
- Supplemental references
  - [deploy/README.md](./deploy/README.md)

If a supplemental doc conflicts with this file or the README, update the supplemental doc rather than copying the stale pattern back into the codebase.
