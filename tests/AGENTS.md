# Test Organization

Unit tests co-located with source (`*.test.ts`). E2E tests in `e2e/` using Playwright.

## Structure

| Location | Type | Runner |
|----------|------|--------|
| `tests/e2e/*.spec.ts` | Playwright E2E (production build, a server and a database per worker; the `@smoke` subset: `npm run test:e2e:smoke`) | `npm run test:e2e`, `scripts/gates.sh` |
| `tests/integration/*.test.ts` | Vitest integration | `npm test` |
| `src/**/*.test.ts` | Vitest unit | `npm test` |
| `tests/mocks/` | Shared mocks | imported by tests |

## Where to Look

| Test Type | Location |
|-----------|----------|
| Chat/streaming | `tests/e2e/chat.spec.ts`, `tests/e2e/streaming.spec.ts` |
| Conversation lifecycle | `tests/e2e/conversation.spec.ts` |
| Settings/admin | `tests/e2e/settings-admin.spec.ts` |
| Auth/login | `tests/e2e/login.test.ts`, `tests/e2e/auth.spec.ts` |
| Knowledge | `tests/e2e/knowledge.spec.ts` |
| Search modal | `tests/e2e/search-modal.spec.ts` |
| Mobile/responsive | `tests/e2e/mobile-*.spec.ts`, `tests/e2e/responsive*.spec.ts` |
| Server routes | `src/routes/api/**/*.test.ts` |
| Services/stores | `src/lib/**/*.test.ts` |
| Components | `src/lib/components/**/*.test.ts` |

## Conventions

**E2E selectors**: Use `data-testid` attributes. Prefer `page.getByTestId('name')` or `page.getByRole()` over CSS selectors.

**E2E helpers**: Reuse `tests/e2e/helpers.ts` for login, logout, sendMessage, createConversation.

**Mocking**: Use `page.route()` to intercept API calls in E2E. Mock servers live in `tests/mocks/`.

**Test mode**: Playwright sets `PLAYWRIGHT_TEST=1`. Title endpoint returns `null` in this mode to avoid external service deps.

**Global setup**: `tests/e2e/global-setup.ts` makes one freshly migrated, freshly seeded SQLite file and one server (the production build) per worker slot, then checks that the build hydrates. A worker keeps its database from one spec file to the next, so a spec that changes shared state (an admin override, a language, a provider) puts it back in its own cleanup. A spec that only needs a conversation uses `createEmptyConversation`. The whole story: AGENTS.md, "Mandatory Verification".

**Snapshots**: Visual regression tests store snapshots in `tests/e2e/*.spec.ts-snapshots/`.

## Anti-Patterns

- Do not use hardcoded waits (`page.waitForTimeout`). Use explicit conditions or `expect().toBeVisible()`.
- Do not test implementation details in E2E. Test user-visible behavior.
- Do not duplicate mock setups. Reuse helpers or mock factories.
- Do not skip cleanup in integration tests. Use `beforeAll`/`afterAll` to manage test data.
- Do not rely on production services in tests. Mock external APIs.

## Running E2E Specs

- **Iterating on UI code** (a rebuild per change would be slower): `E2E_SERVER=dev E2E_PORT=<port> npx playwright test <spec>`: `vite dev`, one worker by default, one optimizer cache per server.
- **One or two specs on the build:** `E2E_PORT=<port> E2E_WORKERS=2 npx playwright test <spec> [<spec>]`. Beside one or two other agents use `E2E_WORKERS=4` at most; a run takes `E2E_WORKERS` ports from `E2E_PORT`.
- **The smoke tier** (25 tests tagged `@smoke` across sign in, chat and streaming, each artifact kind in the panel, a Document edit and its version, a Canvas block, a tour, knowledge, settings and projects; about 30 s): `E2E_PORT=<port> npm run test:e2e:smoke`.
- A spec that makes a conversation only to put things in it uses `createEmptyConversation` (no first message, so no first turn to a model the server cannot reach racing everything after it), not `createConversation`. A block that gets a poster (map, App, photos, live web) has a hidden copy of itself in `<body>` meanwhile: address it as `liveBlock(page, testId)`, not `page.getByTestId(testId)`. Both are held by `tests/integration/e2e-conventions.test.ts`, which names the file and the fix.

Playwright note:

- E2E runs set `PLAYWRIGHT_TEST=1` and `HOME_SUMMARY_CACHE_TTL_MS=0` on every server.
- In that mode, [`src/routes/api/conversations/[id]/title/+server.ts`](../src/routes/api/conversations/[id]/title/+server.ts) short-circuits and returns `title: null` so browser tests do not depend on a live title-generator service.
- Each server's log is `data/e2e-servers/slot-N.log`, every line with the seconds since that server started: a failing spec's server-side story is there. `PLAYWRIGHT_REUSE_EXISTING_SERVER=true` uses a server already listening on a slot's port (its database is reset in place); without it a busy port is an error. A SIGTERM or SIGHUP to the runner stops its servers and frees the run lock.
- The spec's own process seeds rows through the app's services into the file its server also writes, so both load `tests/e2e/sqlite-immediate.cjs` (transactions take their write lock at BEGIN): a deferred read-then-write transaction that meets the other process's commit fails at once with "database is locked", and the busy timeout does not help (one whole-suite run in ten).
- A spec that matches a request for a lazily loaded module by its source path (`vite dev` serves `/src/lib/...`) must ask `moduleUrlPattern` in `tests/e2e/build-assets.ts`: the build serves hashed chunks, which its manifest names.
