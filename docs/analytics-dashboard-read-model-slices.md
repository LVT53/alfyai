# Analytics Dashboard Read Model Slices

Source: `docs/architecture-deepening-report.html`, Candidate 2: "Move Analytics Dashboard Read Model Out of the Route Adapter".

## Status

Issues 1 through 5 are implemented in the current worktree: `src/lib/server/services/analytics.ts` exposes `getAnalyticsDashboardReadModel(...)`, and `src/routes/api/analytics/+server.ts` now authenticates, parses `mock`, `month`, `systemMonth`, and `timeline`, delegates to that service interface, and returns JSON.

Issue 6 is documented here and in the route/service maps. Remote live testing is not recorded as complete in this file.

## Context

The analytics dashboard endpoint used to mix HTTP/auth handling with the full dashboard projection. `src/routes/api/analytics/+server.ts` imported `db`, `usageEvents`, `analyticsConversations`, `providers`, Drizzle query helpers, provider-model id parsing, runtime config, mock payloads, grouping helpers, summary reducers, timeline projection, system filtering, and per-user row shaping. That made the route a shallow interface over a broad implementation.

The server module `src/lib/server/services/analytics.ts` is now the durable analytics module for both write-side event ingestion and dashboard read-model projection. Event ingestion owns conversation snapshots, message usage events, cost calculation, and conversation cost summaries. `getAnalyticsDashboardReadModel(...)` owns the read model consumed by the Settings Analytics tab.

Architecture target: keep the analytics route as a SvelteKit route adapter that authenticates, parses query parameters, delegates to a server read-model interface, and returns JSON. The read model should preserve the browser response contract consumed by `fetchAnalytics(...)` in `src/lib/client/api/settings.ts`.

Docs checked before planning:

- `AGENTS.md`: routes are adapters; durable logic belongs in server services; `src/lib/client/api/settings.ts` owns reusable settings/admin/analytics browser calls; `analytics.ts` is the current analytics event-ingestion service.
- `src/lib/server/services/AGENTS.md`: `analytics.ts` is an active service consumed by chat-turn finalization.
- `CONTEXT.md`: **Account Erasure** removes person-linked analytics while allowing only non-identifying aggregate usage and cost totals to remain.
- `docs/adr/0029-account-erasure-keeps-only-anonymous-aggregates.md`: person-linked analytics rows are removed on erasure because pseudonymous per-user history is easy to reidentify.
- Context7 SvelteKit docs: `+server` files export HTTP verb handlers that take a `RequestEvent` and return a `Response`/`json(...)`, which supports keeping endpoint files transport-oriented.

No issue tracker configuration was found in this workspace, and the user asked for a local file, so these issues are recorded here rather than created remotely.

## Done Criteria

- `src/routes/api/analytics/+server.ts` is a thin adapter: it authenticates, reads `mock`, `month`, `systemMonth`, and `timeline`, calls the analytics read-model interface, and returns JSON.
- Analytics dashboard projection logic lives behind a server service interface, preferably in `src/lib/server/services/analytics.ts` or a narrow analytics submodule exported by that facade.
- The browser contract represented by `AnalyticsResponse` in `src/lib/client/api/settings.ts` remains stable unless a slice explicitly updates the frontend contract and tests.
- Admin-only fields (`system`, `perUser`, `systemAvailableMonths`) remain unavailable to non-admin users.
- Existing personal/month/system-month/timeline behavior remains unchanged.
- Account Erasure and Clear Workspace Data behavior remain aligned with ADR 0029 and current privacy-control tests.
- Tests cover the read model at the highest feasible service seam, while route tests focus on adapter behavior.
- `npm run check` and Fallow stay clean with no new diagnostics or findings.

## Issue 1: Extract Personal Analytics Read Model

Triage label: `architecture`

Dependencies: None

Move the personal analytics projection behind a server read-model interface while preserving the current `/api/analytics` response for ordinary users. This is the first tracer bullet because it proves the new interface can carry real dashboard behavior end to end without taking on admin complexity.

Acceptance criteria:

- A server service interface accepts the authenticated user identity plus parsed read parameters and returns the same personal analytics payload currently returned by `/api/analytics`.
- Personal analytics still includes model breakdown, provider breakdown, totals, average generation time, favorite model, chat count, monthly rows, available months, and optional timeline.
- The route no longer owns personal grouping, token/cost reducers, model/provider display-name resolution, month filtering, or timeline construction.
- The route still performs authentication and returns the same JSON shape for a non-admin user.
- The existing `fetchAnalytics(...)` browser call in `src/lib/client/api/settings.ts` continues to work without page/component changes.
- Service tests cover at least: no data, one user with multiple months, `month` filter, invalid/absent timeline, and provider display-name fallback.
- Route tests cover only auth, query parsing/delegation, and JSON response mapping for a non-admin user.

Technical notes:

- Current route projection starts at `src/routes/api/analytics/+server.ts:147` and continues through `src/routes/api/analytics/+server.ts:500`.
- Current browser response type lives in `src/lib/client/api/settings.ts`.
- `usage_events` and `analytics_conversations` schema fields live around `src/lib/server/db/schema.ts:1367` and `src/lib/server/db/schema.ts:1396`.
- Avoid duplicating the cost conversion already implicit in current route behavior; if a helper is extracted, keep it inside the analytics module interface.

Suggested verification:

- `npm run test:unit -- src/routes/api/analytics/analytics.test.ts`
- Add or run a focused service test for the new analytics read model.
- `npm run check`
- `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-analytics-read-model-fallow.json`

## Issue 2: Add Admin System Analytics Read Model

Triage label: `architecture`

Dependencies: Issue 1

Move the admin-only system projection behind the same analytics read-model interface. This slice completes the broadest existing dashboard behavior while keeping admin exposure explicit at the service boundary.

Acceptance criteria:

- Admin requests still receive `personal`, `system`, `perUser`, `availableMonths`, and `systemAvailableMonths`.
- Non-admin requests cannot receive `system`, `perUser`, or `systemAvailableMonths`, even if `systemMonth` is supplied.
- `systemMonth` continues to filter system analytics independently from personal `month`.
- `totalUsers` counts users represented by system usage or system conversation rows for the selected system month.
- `totalConversations` counts selected system conversation rows.
- `perUser` rows preserve display-name/email fallback behavior from usage rows, conversation rows, and user id.
- `perUser` remains sorted by descending message count.
- Tests preserve the existing admin month-filter case from `src/routes/api/analytics/analytics.test.ts` and add a non-admin `systemMonth` denial case.

Technical notes:

- Current admin projection starts around `src/routes/api/analytics/+server.ts:503`.
- The current route reads all rows and filters in memory. The first extraction can preserve that implementation for behavior stability; query optimization is a later issue only if measured.
- Keep the service interface explicit about `isAdmin` or accept a narrower caller role type so admin-only fields are not an accidental caller convention.

Suggested verification:

- `npm run test:unit -- src/routes/api/analytics/analytics.test.ts`
- Focused read-model tests for admin system month, per-user display fallback, and non-admin field exclusion.

## Issue 3: Move Mock Analytics Behind The Same Interface

Triage label: `architecture`

Dependencies: Issue 1

Keep the route adapter from owning the large demo/mock payload by moving mock response selection behind the analytics module. This is independently useful because it removes another block of implementation from the route without changing database-backed behavior.

Acceptance criteria:

- `mock=1` still returns mock personal analytics for non-admin users.
- `mock=1` still returns mock personal, system, `systemAvailableMonths`, and `perUser` data for admins.
- The route does not contain the `MOCK_ANALYTICS` object.
- Mock response selection is covered by service tests or compact route tests that prove admin and non-admin visibility.
- The mock payload stays compatible with `AnalyticsResponse`.

Technical notes:

- Current mock data occupies `src/routes/api/analytics/+server.ts:14` through `src/routes/api/analytics/+server.ts:142`.
- This can land before or after Issue 2. If done before Issue 2, keep the database-backed admin projection in the route temporarily and only move the mock branch.

Suggested verification:

- `npm run test:unit -- src/routes/api/analytics/analytics.test.ts`
- `npm run check`

## Issue 4: Thin The Route Tests Around The Adapter Interface

Triage label: `testing`

Dependencies: Issues 1 and 2

Reshape route tests so they guard the route adapter contract instead of duplicating read-model implementation setup. The service should carry projection tests; the route should prove auth, parameter parsing, delegation, and JSON behavior.

Acceptance criteria:

- Route tests mock the analytics read-model interface for adapter-specific cases.
- Route tests verify unauthenticated handling through `requireAuth` behavior where the existing test style allows it.
- Route tests verify parsed parameters for `mock`, `month`, `systemMonth`, and `timeline`.
- Route tests verify user role/identity is passed to the read-model interface.
- Projection-heavy fixture setup moves to read-model service tests.
- The existing SQLite-backed integration-style test can either move to the service test suite or remain as a smoke test, but it should not be the only protection for the read-model behavior.

Technical notes:

- Existing test fixture is `src/routes/api/analytics/analytics.test.ts`.
- If ESM module mocking is awkward, prefer direct service tests for projection and one route smoke test that imports the real route, matching nearby repo test style.

Suggested verification:

- `npm run test:unit -- src/routes/api/analytics/analytics.test.ts`
- Run the new analytics read-model test file directly.

## Issue 5: Preserve Analytics Privacy Boundaries

Triage label: `privacy`

Dependencies: Issue 2

Add explicit coverage that the read model does not weaken existing Account Erasure and Clear Workspace Data expectations. This slice is valuable because the new read-model interface will make it tempting to treat person-linked analytics as a stable admin history.

Acceptance criteria:

- Clear Workspace Data still preserves historical person-linked analytics for the continuing account, matching the current `clearWorkspaceData` behavior.
- Account Erasure still removes `usage_events` and `analytics_conversations` rows for the erased user.
- The analytics read model returns no per-user row for an erased user after erasure cleanup has run.
- The read model does not invent pseudonymous user ids, retained emails, retained names, retained conversation titles, or retained message ids for erased accounts.
- Tests reference ADR 0029 behavior through assertions, not comments alone.

Technical notes:

- Current privacy cleanup deletes person-linked analytics in `src/lib/server/services/privacy-controls/index.ts:134`.
- Current tests cover Clear Workspace Data preserving analytics and Account Erasure removing analytics in `src/lib/server/services/privacy-controls/privacy-controls.test.ts`.
- This issue may be a targeted addition to read-model tests rather than a production-code change if existing cleanup already guarantees the behavior.

Suggested verification:

- `npm run test:unit -- src/lib/server/services/privacy-controls/privacy-controls.test.ts`
- Run the new analytics read-model privacy case directly.

## Issue 6: Document The Analytics Dashboard Read Model Boundary

Triage label: `docs`

Dependencies: Issues 1 and 2

Status: Complete for local documentation. Remote live testing remains outside this issue and should not be inferred from this status.

Record the new interface once it exists so future route work does not move projection logic back into `/api/analytics`.

Acceptance criteria:

- `AGENTS.md` or the nearest existing route/service map states that the analytics dashboard read model owns `/api/analytics` payload assembly.
- `src/lib/server/services/AGENTS.md` distinguishes analytics event ingestion from analytics dashboard read-model projection if both live in the same service file.
- Documentation says the route remains an adapter for auth, query parameters, and JSON response mapping.
- Documentation references the existing Account Erasure privacy boundary and ADR 0029 instead of creating a second analytics privacy policy.
- A repo search shows the analytics route no longer imports `db`, `usageEvents`, `analyticsConversations`, `providers`, or Drizzle grouping helpers.

Technical notes:

- Do not add a new ADR unless implementation reveals a hard-to-reverse trade-off. The existing route-adapter rule and ADR 0029 are enough for the current plan.
- A short update to `AGENTS.md` may be more useful than adding product glossary language to `CONTEXT.md`, because "Analytics Dashboard Read Model" is an implementation boundary rather than a user-facing concept.

Suggested verification:

- `rg "analytics dashboard read model|Analytics Dashboard Read Model|getAnalyticsDashboardReadModel|/api/analytics" AGENTS.md src/lib/server/services/AGENTS.md docs/analytics-dashboard-read-model-slices.md`
- `rg "usageEvents|analyticsConversations|providers|drizzle-orm|\\$lib/server/db" 'src/routes/api/analytics/+server.ts'`

## Suggested Implementation Order

1. Issue 1: Extract Personal Analytics Read Model.
2. Issue 2: Add Admin System Analytics Read Model.
3. Issue 4: Thin The Route Tests Around The Adapter Interface.
4. Issue 3: Move Mock Analytics Behind The Same Interface.
5. Issue 5: Preserve Analytics Privacy Boundaries.
6. Issue 6: Document The Analytics Dashboard Read Model Boundary.

Issue 3 can move earlier if a smaller first patch is desired, but it should not distract from the main value: removing database-backed projection from the route.

## Open Questions To Grill Before Implementation

- Should the new interface live directly in `src/lib/server/services/analytics.ts`, or should `analytics.ts` become a facade over `analytics/read-model.ts` and write-side internals? The current file is only 370 lines, so a submodule is useful only if it improves locality without adding a shallow wrapper.
- Should the read model keep the current "read all rows then filter in memory" implementation for behavior parity, or should the first implementation move filtering into Drizzle queries? Behavior-preserving extraction is safer; query optimization should be justified by measured data volume.
- Should `timeline` reject invalid values or preserve the current cast-and-ignore behavior? The first slice should preserve current behavior unless the frontend contract intentionally changes.
- Should mock analytics remain a route feature at all? If it stays, it belongs behind the same analytics interface so the route does not regain a second implementation path.
