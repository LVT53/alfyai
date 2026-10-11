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
