# Slice B — Parallel free monthly allowance

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Parallel API call free of charge to users while the whole server's list-price spend for the
current calendar month is at or below an admin-configurable allowance (`PARALLEL_FREE_MONTHLY_USD`, default
`5`), and charge only the part of a call that crosses that line.

**Architecture:** Billed cost is computed *at record time*, inside one write transaction, from the running
count of that month's `parallel:*` rows in `usage_events`. No new column and no read-side change is needed,
because every existing total already sums `cost_usd_micros`. One idempotent replay script rewrites history;
the admin analytics "Parallel API" tab gains an allowance meter, a "Counted as cost" tile and per-month
free/counted columns.

**Tech Stack:** SvelteKit, Drizzle ORM on better-sqlite3 (synchronous), Vitest, Playwright, TypeScript.

**Spec:** `docs/plans/claude-at-home-1-workspaces-spec.md` §"Slice B — Parallel free monthly allowance"
(lines 116–159) and mockups §M9 (`docs/plans/claude-at-home-1-workspaces-mockups.html`, section 9).
Mockup copy is the source of truth for the UI strings in the i18n table below.

## Global Constraints

- **Node 22 only.** Prefix every npm/npx/vitest/playwright call with
  `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`. Node 26 on this Mac breaks `better-sqlite3`.
- **Svelte 5 runes only** in touched files: `$props`, callback props, `onclick`, `{@render}`; no new
  `<slot>`, no `createEventDispatcher`, no `afterUpdate`/`beforeUpdate`.
- **Icons:** Lucide via `@lucide/svelte` only. No inline `<svg>` icon elements.
- **Tokens only:** colours/spacing/radii from `src/app.css`; no hard-coded hex values.
- **Runtime config** flows `env.ts` → `config-store.ts`. Never read `process.env` in override-aware code.
- **No broad Fallow ignores.** New findings are regressions unless they are a documented public boundary.
- **Commits** are small, focused, and explain the *why*. Stage by explicit path. **Never** bare `git stash`.
  End every commit message with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- **Never push and never deploy** without the owner's explicit go-ahead.
- **Every new UI string** ships in English and Hungarian, in the same commit.

## Gates (run before calling any task done)

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check                     # 0 errors, 0 warnings
npx biome check src scripts tests # npm run lint breaks under nested worktrees
npm test
npm run build                     # 0 warnings
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
```

## Review Focus

The failure modes this slice's own tests will not catch on their own. Each has a test assigned below, in the
task named next to it.

1. **A call that crosses the allowance boundary** must be billed only for the portion above it — a
   full-price charge on the crossing call, or a free crossing call, are both wrong (Task 2).
2. **Two calls recorded when the allowance covers exactly one of them**: the month's total billed micros must
   come out exactly right under interleaving, because the count and the insert are in one transaction
   (Task 2).
3. **A fractional allowance** (e.g. `2.5`, or an env value of `0.001`) must not be rounded into a different
   allowance than the admin set, and `0` must mean "charge everything", not "invalid, fall back to 5"
   (Task 1, Task 2).
4. **A month boundary** mid-recompute: rows in the last minute of one month and the first minute of the next
   must not be summed into the same running total (Task 5).
5. **The replay script run twice** must be idempotent — the second run must preview zero changes (Task 5).

---

## Contracts

### TypeScript — config

```ts
// src/lib/server/env.ts — added to the exported env config object
parallelFreeMonthlyUsd: number; // default 5

// src/lib/server/config-store.ts
/** Admin-configurable. Non-secret. Allow 0 and fractional values. */
export function getParallelFreeMonthlyUsd(): number;
```

`env.ts` needs a **new** parser beside `parsePositiveIntegerEnv` (`env.ts:350-360`), because
`parsePositiveIntegerEnv` floors at `minimum = 1` and rejects `0`:

```ts
function parseNonNegativeNumberEnv(
	value: string | undefined,
	fallback: number,
): number {
	const parsed = Number.parseFloat(value ?? "");
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
```

`config-store.ts` has six mandatory touch points, all of which this slice edits (mirror the
`MAX_MODEL_CONTEXT` wiring exactly, at the line numbers given):

| Touch point | Location | What to add |
|---|---|---|
| `ADMIN_CONFIG_KEYS` array | `config-store.ts:93-94` (next to `PARALLEL_API_KEY`) | `"PARALLEL_FREE_MONTHLY_USD"` |
| `RuntimeConfig` field | `config-store.ts:287-288` | `parallelFreeMonthlyUsd: number;` |
| `buildDefaultConfig` | `config-store.ts:583` | `config.parallelFreeMonthlyUsd = envConfig.parallelFreeMonthlyUsd;` |
| `overrideAppliers` | `config-store.ts:618-621` (pattern) | new entry using a `parseFloatOverride` helper |
| getter export | `config-store.ts:1382-1386` (pattern) | `getParallelFreeMonthlyUsd()` |
| `getResolvedAdminConfigValues` | `config-store.ts:1629-1630` | `PARALLEL_FREE_MONTHLY_USD: String(config.parallelFreeMonthlyUsd),` |

Add `parseFloatOverride` beside `parseIntOverride` (`config-store.ts:376-379`):

```ts
function parseFloatOverride(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
```

Admin validation spec — `src/lib/config/admin-config-registry.ts`, `ADVANCED_KEY_SPECS`, group
`"integrations"`. The `int(...)` helper (`admin-config-registry.ts:76-83`) floors at 0 if constructed that
way; **verify the helper allows a fractional value**, and if it is integer-only, add a `number(0, …)` spec
instead so an admin can enter `2.5`. A key with no spec is stored raw and unvalidated
(`src/routes/api/admin/config/+server.ts:112-116`), which is not acceptable for a number that changes
billing.

### TypeScript — billing

```ts
// src/lib/server/services/analytics.ts

/** Flat list cost booked per Parallel API call: $1 per 1,000 calls = 1,000 micros. */
const PARALLEL_COST_USD_MICROS = 1000; // already exists at analytics.ts:2326

/** List-price micros for one call. Always derivable from the row count. */
export function parallelListMicrosForCalls(calls: number): number; // calls * PARALLEL_COST_USD_MICROS

/**
 * Billed micros for the call that moves a month's list spend from `listBeforeMicros`
 * to `listAfterMicros`, given the allowance. Pure, exported for tests.
 */
export function parallelBilledMicros(
	listBeforeMicros: number,
	listAfterMicros: number,
	allowanceMicros: number,
): number;

/** Cumulative billed micros for a month's ordered call list under the given allowance. */
export function parallelBilledSeries(
	calls: number,
	allowanceMicros: number,
): number[];

/** Recompute the billed cost of every `parallel:*` row in one billing month. Returns the row count changed. */
export async function recomputeParallelBillingForMonth(
	billingMonth: string,          // "YYYY-MM", same shape as usage_events.billing_month
	allowanceUsd: number,
	options?: { apply?: boolean }, // default false = dry run
): Promise<{ month: string; calls: number; changed: number; listUsd: number; billedBefore: number; billedAfter: number }>;
```

`parallelBilledMicros` is the whole rule, and it must be exactly this:

```ts
export function parallelBilledMicros(
	listBeforeMicros: number,
	listAfterMicros: number,
	allowanceMicros: number,
): number {
	const before = Math.max(0, listBeforeMicros - allowanceMicros);
	const after = Math.max(0, listAfterMicros - allowanceMicros);
	return Math.min(PARALLEL_COST_USD_MICROS, Math.max(0, after - before));
}
```

`allowanceMicros = Math.round(getParallelFreeMonthlyUsd() * 1_000_000)`. Rounding happens **once**, at the
config boundary, so the rule itself stays integer-only.

### `recordParallelUsage` after this slice

The existing body (`analytics.ts:2345-2384`) keeps every field it writes today except `costUsdMicros`, and
gains one transaction. Shape:

```ts
export async function recordParallelUsage(input: {
	userId: string;
	conversationId?: string | null;
	tool: "research_web" | "fetch_url";
}): Promise<void> {
	if (!input.userId) return;
	try {
		const model = PARALLEL_TOOL_MODEL[input.tool];
		const billingMonth = toBillingMonth(new Date());
		const allowanceMicros = Math.round(getParallelFreeMonthlyUsd() * 1_000_000);
		db.transaction((tx) => {
			const [{ calls }] = tx
				.select({ calls: count() })
				.from(usageEvents)
				.where(
					and(
						eq(usageEvents.billingMonth, billingMonth),
						like(usageEvents.modelId, "parallel:%"),
					),
				)
				.all();
			const costUsdMicros = parallelBilledMicros(
				parallelListMicrosForCalls(calls ?? 0),
				parallelListMicrosForCalls((calls ?? 0) + 1),
				allowanceMicros,
			);
			tx.insert(usageEvents).values({ /* unchanged fields */ costUsdMicros }).onConflictDoNothing().run();
		});
	} catch (error) {
		console.error("[ANALYTICS] Failed to record Parallel usage", error);
	}
}
```

The server-wide scope is deliberate: the `count()` is **not** filtered by `userId`. A test must pin that
(Personal and Project Instructions' "shared by the whole server" decision — spec line 119).

### Admin analytics payload

`ParallelUsageBreakdown` (`analytics.ts:234`) gains:

```ts
export interface ParallelAllowanceView {
	/** Admin-configured allowance in micros. */
	allowanceMicros: number;
	/** List-price micros for the current calendar month. */
	monthListMicros: number;
	/** Billed (counted-as-cost) micros for the current calendar month. */
	monthBilledMicros: number;
	/** Billing month the meter describes, "YYYY-MM". */
	month: string;
}

export interface ParallelMonthRow {
	month: string;          // "YYYY-MM"
	calls: number;
	listMicros: number;
	freeMicros: number;     // listMicros - billedMicros
	billedMicros: number;
}
```

extending `ParallelUsageBreakdown` with `allowance: ParallelAllowanceView` and `monthRows: ParallelMonthRow[]`.
Both are computed in `parallelBreakdown` (`analytics.ts:1183-1223`) from the rows it already iterates — do not
add a second query.

### SQL

**No migration and no DDL.** Slice B adds no column and no table: the list price is always
`calls × PARALLEL_COST_USD_MICROS`, so nothing needs to be stored beyond the billed cost that
`cost_usd_micros` already holds.

The only data mutation is the one-off replay in Task 5, which issues ordinary `UPDATE` statements:

```sql
-- per row, in created_at order within one billing_month
UPDATE usage_events
SET cost_usd_micros = ?
WHERE id = ? AND billing_month = ? AND model_id LIKE 'parallel:%';
```

### i18n keys (EN + HU)

All of these go in `src/lib/i18n/settings.ts` (EN block near `:1269`, HU block near `:3201`, matching the
existing `admin.*` grouping). HU copy below is a first pass; the implementer must read it against its
neighbours and make it read naturally, not literally.

| Key | EN | HU |
|---|---|---|
| `admin.parallelFreeMonthlyUsd` | `Parallel free monthly allowance` | `Parallel ingyenes havi keret` |
| `admin.parallelFreeMonthlyUsdDescription` | `Parallel calls cost nothing to users until the whole server's usage passes this amount in a calendar month. After that they count as normal. Set to 0 to always count them.` | `A Parallel hívások addig nem jelentenek költséget a felhasználóknak, amíg a szerver teljes havi használata egy naptári hónapban meg nem haladja ezt az összeget. Utána a szokásos módon számoljuk el. 0 esetén mindig elszámoljuk őket.` |
| `analytics.parallelAllowanceOf` | `of {allowance} free allowance used` | `felhasználva a {allowance} ingyenes keretből` |
| `analytics.parallelAllowanceResets` | `Resets 1 {month} · users are charged {charged}` | `Visszaáll: {month} 1. · a felhasználóknak felszámított összeg: {charged}` |
| `analytics.parallelCountedAsCost` | `Counted as cost` | `Költségként elszámolva` |
| `analytics.parallelFreeUsage` | `Free usage` | `Ingyenes használat` |
| `analytics.parallelCountedCost` | `Counted cost` | `Elszámolt költség` |
| `analytics.parallelMonthlyBreakdownCalls` | `Calls` | `Hívások` |

Reuse `analytics.parallelApi`, `analytics.parallelCost`, `analytics.monthlyBreakdown`, `analytics.totalCalls`
and the currency formatter `formatUsd` — do not add a second currency vocabulary.

---

## File ownership

**Exclusive to this slice.** No other slice in this feature may edit these files while Slice B is in flight.
No other slice touches any of them at all, so Slice B can run in parallel with A, C, D, E, F and G.

| File | Change |
|---|---|
| `src/lib/server/env.ts` | add `parseNonNegativeNumberEnv` + `parallelFreeMonthlyUsd` |
| `src/lib/server/config-store.ts` | six touch points + `parseFloatOverride` + getter |
| `src/lib/config/admin-config-registry.ts` | spec for `PARALLEL_FREE_MONTHLY_USD` in group `integrations` |
| `src/lib/server/services/analytics.ts` | billing rule, transaction, breakdown types, recompute function |
| `src/routes/api/admin/config/+server.ts` | recompute current month after a successful allowance write |
| `src/routes/(app)/settings/_components/system/IntegrationsPage.svelte` | new row under the Parallel API Key row |
| `src/routes/(app)/settings/_components/SettingsSystemAnalytics.svelte` | meter + tile + table columns |
| `src/scripts/recompute-parallel-billing.ts` | **create** — one-off replay script |
| `src/lib/i18n/settings.ts` | the eight keys above (EN + HU) |
| `README.md`, `docs/configuration.md`, `.env.example` | document the variable |

**Shared, serialise on it:** `src/lib/i18n/settings.ts` is also touched by Slice C (Settings → Profile row)
and Slice D (project page copy is elsewhere; the Settings-adjacent keys are not). Because the wave order below
runs B before C, this is a rebase hazard only, not a live conflict. If the orchestrator ever runs B and C
concurrently, `src/lib/i18n/settings.ts` must be assigned to exactly one of them and the other must defer its
keys to a follow-up commit.

**Must not be touched:** `src/lib/server/db/schema.ts`, `drizzle/**` (no schema change), `normal-chat-tools/*`
(Parallel *call* sites are unchanged), `atlas-v3/worker-bindings.ts` (already routes through
`recordParallelUsage`).

---

## Tasks

### Task 1: The config knob, end to end

**Files:**
- Modify: `src/lib/server/env.ts` (parser at `:350-360`, Parallel block at `:813-814`)
- Modify: `src/lib/server/config-store.ts` (the six touch points above)
- Modify: `src/lib/config/admin-config-registry.ts`
- Test: `src/lib/server/config-store.test.ts` (extend), `src/lib/server/env.test.ts` (extend)

**Interfaces:**
- Produces: `getParallelFreeMonthlyUsd(): number`; `EnvConfig.parallelFreeMonthlyUsd: number`; admin key
  `"PARALLEL_FREE_MONTHLY_USD"`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing tests**

In `src/lib/server/env.test.ts`:

```ts
it("defaults the Parallel free allowance to 5 USD", async () => {
	const env = await loadEnvConfig({});
	expect(env.parallelFreeMonthlyUsd).toBe(5);
});

it("accepts a zero Parallel free allowance", async () => {
	const env = await loadEnvConfig({ PARALLEL_FREE_MONTHLY_USD: "0" });
	expect(env.parallelFreeMonthlyUsd).toBe(0);
});

it("accepts a fractional Parallel free allowance", async () => {
	const env = await loadEnvConfig({ PARALLEL_FREE_MONTHLY_USD: "2.5" });
	expect(env.parallelFreeMonthlyUsd).toBe(2.5);
});

it("falls back to the default on a negative or garbage allowance", async () => {
	expect((await loadEnvConfig({ PARALLEL_FREE_MONTHLY_USD: "-1" })).parallelFreeMonthlyUsd).toBe(5);
	expect((await loadEnvConfig({ PARALLEL_FREE_MONTHLY_USD: "lots" })).parallelFreeMonthlyUsd).toBe(5);
});
```

Match the file's existing env-loading helper rather than inventing `loadEnvConfig` if one already exists.

In `src/lib/server/config-store.test.ts`, one test that an admin override of `PARALLEL_FREE_MONTHLY_USD`
reaches `getParallelFreeMonthlyUsd()`, and one that override `"0"` reaches it as `0` (not as "unset").

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/server/env.test.ts src/lib/server/config-store.test.ts`
Expected: FAIL — `parallelFreeMonthlyUsd` is `undefined`; `getParallelFreeMonthlyUsd` is not exported.

- [ ] **Step 3: Implement**

Add the parser, the env field, the six config-store touch points (with `parseFloatOverride`), and the
registry spec. Mirror `MAX_MODEL_CONTEXT`'s wiring line for line.

- [ ] **Step 4: Run the tests to verify they pass**

Run: same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/env.ts src/lib/server/env.test.ts src/lib/server/config-store.ts \
  src/lib/server/config-store.test.ts src/lib/config/admin-config-registry.ts
git commit -m "Let admins set the Parallel free allowance as a runtime setting

The allowance changes billing behaviour, so it has to flow through
config-store.ts like every other admin-overridable knob rather than
being read from the environment directly. Value 0 is meaningful (charge
everything), so the existing positive-integer parser could not be reused."
```

### Task 2: The billing rule and the record-time transaction

**Files:**
- Modify: `src/lib/server/services/analytics.ts` (`recordParallelUsage` at `:2325-2384`)
- Test: `src/lib/server/services/analytics.parallel-allowance.test.ts` (**create**)

**Interfaces:**
- Consumes: `getParallelFreeMonthlyUsd()` from Task 1.
- Produces: `parallelListMicrosForCalls(calls)`, `parallelBilledMicros(before, after, allowance)`,
  `parallelBilledSeries(calls, allowance)`.

- [ ] **Step 1: Write the failing tests**

Pure-rule tests (no DB):

```ts
describe("parallelBilledMicros", () => {
	it("books nothing while the month stays under the allowance", () => {
		expect(parallelBilledMicros(0, 1000, 5_000_000)).toBe(0);
	});

	it("books only the part above the allowance on the crossing call", () => {
		// allowance 5_000 micros = 5 calls; the 6th call crosses it.
		expect(parallelBilledMicros(5_000, 6_000, 5_000)).toBe(1000);
	});

	it("books a half-crossed call only for its remainder", () => {
		// allowance 5_500: call 6 goes 5_000 -> 6_000, so 500 micros are over the line.
		expect(parallelBilledMicros(5_000, 6_000, 5_500)).toBe(500);
	});

	it("books full price once the month is past the allowance", () => {
		expect(parallelBilledMicros(9_000, 10_000, 5_000)).toBe(1000);
	});

	it("behaves like today when the allowance is zero", () => {
		expect(parallelBilledMicros(0, 1_000, 0)).toBe(1000);
		expect(parallelBilledMicros(9_000, 10_000, 0)).toBe(1000);
	});

	it("never books a negative amount when the allowance exceeds the whole month", () => {
		expect(parallelBilledMicros(0, 1_000, 10_000_000)).toBe(0);
	});
});
```

DB-backed tests against a scratch database, using the existing analytics test setup in this repo:

```ts
it("is free for the first call of the month", async () => {
	await recordParallelUsage({ userId: "u1", tool: "research_web" });
	expect(await totalBilledMicros("u1")).toBe(0);
});

it("counts the whole server, not one user, against the allowance", async () => {
	// 0.002 USD = 2,000 micros = exactly two calls free, across users.
	await setAllowanceUsd(0.002);
	await recordParallelUsage({ userId: "u1", tool: "research_web" });
	await recordParallelUsage({ userId: "u2", tool: "fetch_url" });
	expect(await totalBilledMicros()).toBe(0);        // server-wide: nothing charged yet

	await recordParallelUsage({ userId: "u1", tool: "research_web" });
	expect(await totalBilledMicros()).toBe(1000);     // the third call only, whoever made it
	expect(await billedMicrosFor({ userId: "u2" })).toBe(0);
	expect(await billedMicrosFor({ userId: "u1" })).toBe(1000);
});

it("charges the crossing call for its remainder only", async () => {
	// The allowance is a dollar amount and need not land on a call boundary:
	// 0.0025 USD = 2,500 micros = two and a half calls.
	await setAllowanceUsd(0.0025);
	await recordParallelUsage({ userId: "u1", tool: "research_web" });   // list 0 -> 1000, billed 0
	await recordParallelUsage({ userId: "u1", tool: "research_web" });   // list 1000 -> 2000, billed 0
	await recordParallelUsage({ userId: "u1", tool: "research_web" });   // list 2000 -> 3000, billed 500
	expect(await totalBilledMicros()).toBe(500);
});

it("keeps the total exact when two calls are recorded back to back at the boundary", async () => {
	await setAllowanceUsd(0.001); // exactly one call
	await recordParallelUsage({ userId: "u1", tool: "research_web" });
	await recordParallelUsage({ userId: "u1", tool: "research_web" });
	expect(await totalBilledMicros("u1")).toBe(1000);
});
```

Write three small helpers for these tests, in the test file itself: `setAllowanceUsd(usd)` writes the
`PARALLEL_FREE_MONTHLY_USD` override through the config store; `totalBilledMicros()` sums `cost_usd_micros` over
every `parallel:%` row in the current billing month; `billedMicrosFor({ userId })` does the same for one user.
Keep them local to the suite — two callers do not justify a shared helper module.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/server/services/analytics.parallel-allowance.test.ts`
Expected: FAIL — `parallelBilledMicros` is not exported; recorded rows still carry 1000 micros.

- [ ] **Step 3: Implement the rule, then the transaction**

Implement `parallelBilledMicros` and `parallelListMicrosForCalls` first and re-run the pure tests. Only then
change `recordParallelUsage` to wrap its count and insert in `db.transaction(...)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: same command. Expected: PASS.

- [ ] **Step 5: Re-run the existing analytics suite for regressions**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/server/services/analytics`
Expected: PASS. The pre-existing tests that assert a Parallel row costs 1000 micros now depend on the
allowance; set the allowance to `0` in their setup rather than deleting them.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/services/analytics.ts src/lib/server/services/analytics.parallel-allowance.test.ts
git commit -m "Book Parallel calls at record time against the server's free allowance

The allowance is a running total over the whole server's month, so it can
only be applied where the running total is known: inside the same write
that adds the call. A read-side subtraction would need every consumer to
know the allowance and would break under two simultaneous calls."
```

### Task 3: The admin allowance row

**Files:**
- Modify: `src/routes/(app)/settings/_components/system/IntegrationsPage.svelte` (insert between `:167` and
  `:169`, inside `<div class="sys-rows">`, directly under the Parallel API Key `SettingRow`)
- Modify: `src/lib/i18n/settings.ts`
- Test: `tests/e2e/settings-admin-system.spec.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `PARALLEL_FREE_MONTHLY_USD` key and its registry spec.
- Produces: an editable allowance field the orchestrator can use for live staging checks.

- [ ] **Step 1: Write the failing test**

In `tests/e2e/settings-admin-system.spec.ts`, a behaviour test: sign in as admin → Settings → Administration →
System → Integrations → the "Parallel free monthly allowance" row is visible directly under the Parallel API
Key row, shows `$` and `5.00` by default, and saving `0` persists across a reload.

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx playwright test tests/e2e/settings-admin-system.spec.ts`
Expected: FAIL — no such row.

- [ ] **Step 3: Implement**

Add the row with `SettingRow` + `ValueField type="number"`, copying the MinerU loop's `int` branch
(`IntegrationsPage.svelte:241-249`) for the numeric field and its `toDisplayNumber`/`fromDisplayNumber`
imports from `$lib/config/admin-config-registry`. Use `label={$t('admin.parallelFreeMonthlyUsd')}`,
`meaning={$t('admin.parallelFreeMonthlyUsdDescription')}`, `configKey="PARALLEL_FREE_MONTHLY_USD"`. Add the
two EN and two HU strings.

- [ ] **Step 4: Run it to verify it passes**

Run: same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/routes/(app)/settings/_components/system/IntegrationsPage.svelte" \
  src/lib/i18n/settings.ts tests/e2e/settings-admin-system.spec.ts
git commit -m "Put the Parallel allowance next to the key that enables Parallel

It is a billing setting for the same integration, so it belongs in the
same Web research group rather than in a system-wide numbers card."
```

### Task 4: Recompute the current month when the allowance changes

**Files:**
- Modify: `src/lib/server/services/analytics.ts` (add `recomputeParallelBillingForMonth`)
- Modify: `src/routes/api/admin/config/+server.ts`
- Test: `src/lib/server/services/analytics.parallel-allowance.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's getter, Task 2's rule.
- Produces: `recomputeParallelBillingForMonth(billingMonth, allowanceUsd, { apply })` — Task 5's script and
  Task 6's meter both build on it.

- [ ] **Step 1: Write the failing tests**

```ts
it("recomputes only the requested month", async () => {
	// seed one charged row in 2026-08 and one in 2026-09
	const result = await recomputeParallelBillingForMonth("2026-09", 5, { apply: true });
	expect(result.month).toBe("2026-09");
	expect(await billedMicrosFor("2026-08")).toBe(1000); // untouched
	expect(await billedMicrosFor("2026-09")).toBe(0);
});

it("writes nothing in a dry run", async () => {
	const before = await billedMicrosFor("2026-09");
	const result = await recomputeParallelBillingForMonth("2026-09", 0, { apply: false });
	expect(result.changed).toBe(0);
	expect(await billedMicrosFor("2026-09")).toBe(before);
});
```

And a route-level test that a `PUT /api/admin/config` changing `PARALLEL_FREE_MONTHLY_USD` recomputes the
current month, while a PUT that does not change it recomputes nothing.

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/server/services/analytics.parallel-allowance.test.ts`
Expected: FAIL — `recomputeParallelBillingForMonth` is not exported.

- [ ] **Step 3: Implement**

Read the month's `parallel:*` rows ordered by `createdAt`, compute the cumulative billed series with
`parallelBilledSeries`, and update only the rows whose value changes. Wrap the updates in one
`db.transaction`. In the admin config route, after a successful write, compare the previous and new
`PARALLEL_FREE_MONTHLY_USD` and call the recompute for `toBillingMonth(new Date())` only when it changed.

- [ ] **Step 4: Run them to verify they pass**

Run: same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/analytics.ts src/routes/api/admin/config/+server.ts \
  src/lib/server/services/analytics.parallel-allowance.test.ts
git commit -m "Replay the running month when the allowance changes

Without this, editing the allowance would only affect calls made after the
edit, so the meter and the charged total would disagree for the rest of the
month."
```

### Task 5: The one-off replay script

**Files:**
- Create: `scripts/recompute-parallel-billing.ts`
- Test: `scripts/recompute-parallel-billing.test.ts`

**Interfaces:**
- Consumes: `recomputeParallelBillingForMonth` from Task 4.
- Produces: `npx tsx scripts/recompute-parallel-billing.ts` (dry run) and `… --apply`.

- [ ] **Step 1: Write the failing test**

Follow `scripts/backfill-extractions.test.ts:102`'s `apply:` pattern. Behaviours to pin:

```ts
it("previews the change without writing in a dry run", async () => { /* ... */ });
it("applies exactly the previewed values with --apply", async () => { /* ... */ });
it("is idempotent: a second run previews zero changes", async () => { /* ... */ });
it("replays months in ascending billing-month order", async () => { /* ... */ });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run scripts/recompute-parallel-billing.test.ts`
Expected: FAIL — script does not exist.

- [ ] **Step 3: Implement**

Copy the header/usage block and the `fail()` + explicit-`DATABASE_PATH` guard from
`scripts/sweep-orphan-generated-artifacts.ts:18-54` (dry run is the **default**; `--apply` opts in). Print a
final summary line in the style of `scripts/fix-rail-summaries.ts:80`, listing every month with calls, list
USD, billed before and billed after, and whether it was applied.

- [ ] **Step 4: Run it against a scratch copy of the dev database**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && DATABASE_PATH=./data/chat.db npx tsx scripts/recompute-parallel-billing.ts`
Expected: prints one line per month with Parallel calls, all `billed after = $0.00`, and says it was a dry
run. Then run it with `--apply` on the scratch copy and confirm the second dry run reports zero changes.

- [ ] **Step 5: Commit**

```bash
git add scripts/recompute-parallel-billing.ts scripts/recompute-parallel-billing.test.ts
git commit -m "Replay Parallel billing history under the new allowance

The owner asked for history to be recomputed rather than grandfathered, and
no past month came close to the allowance, so every historical Parallel call
becomes free. Dry run by default because it rewrites cost rows users can see."
```

### Task 6: The admin meter, tile and month columns

**Files:**
- Modify: `src/lib/server/services/analytics.ts` (`ParallelUsageBreakdown` at `:234`, `parallelBreakdown` at
  `:1183-1223`)
- Modify: `src/routes/(app)/settings/_components/SettingsSystemAnalytics.svelte` (tab at `:241-251`, tiles at
  `:301-304`, chart at `:664-680`, table at `:682+`, panel at `:1099-1129`)
- Modify: `src/lib/i18n/settings.ts`
- Test: `src/lib/server/services/analytics.test.ts` (extend) and
  `tests/e2e/settings-admin-system.spec.ts` (extend)

**Interfaces:**
- Consumes: Task 2's `cost_usd_micros` values, Task 1's getter.
- Produces: `parallel.allowance` and `parallel.monthRows` in the `/api/analytics` admin payload.

- [ ] **Step 1: Write the failing tests**

Server side:

```ts
it("reports the allowance, the month's list price and the month's billed total", async () => {
	// 3 calls in the current month with allowance 0.002 (2 calls free)
	const parallel = await breakdownForAdmin();
	expect(parallel.allowance.allowanceMicros).toBe(2_000);
	expect(parallel.allowance.monthListMicros).toBe(3_000);
	expect(parallel.allowance.monthBilledMicros).toBe(1_000);
});

it("returns one month row per month with Parallel calls, with free usage derived", async () => {
	const parallel = await breakdownForAdmin();
	const row = parallel.monthRows.find((r) => r.month === "2026-08")!;
	expect(row.freeMicros).toBe(row.listMicros - row.billedMicros);
});
```

E2E: the Parallel API tab renders the meter line, the "Counted as cost" tile, and the by-month table with
Free usage and Counted cost columns.

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/server/services/analytics.test.ts`
Expected: FAIL — `parallel.allowance` is undefined.

- [ ] **Step 3: Implement**

Derive everything inside the existing `parallelBreakdown` loop. In the Svelte component, add the meter inside
the existing `<StatGrid>`/cost card area and extend the existing `SortableTable` columns — do not add a second
table. Format money with the existing `formatUsd`; render the meter bar with token colours
(`--accent`-equivalent status tokens already used by the card), not hard-coded hex.

- [ ] **Step 4: Run them to verify they pass**

Run the vitest command above and then
`npx playwright test tests/e2e/settings-admin-system.spec.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/analytics.ts src/lib/server/services/analytics.test.ts \
  "src/routes/(app)/settings/_components/SettingsSystemAnalytics.svelte" src/lib/i18n/settings.ts \
  tests/e2e/settings-admin-system.spec.ts
git commit -m "Show the owner what the Parallel allowance is actually absorbing

Without a meter the allowance is invisible: the dashboard would show cost
tiles that no longer move while free usage silently grows."
```

### Task 7: Document the variable

**Files:**
- Modify: `README.md` (bullet block at `:65-81`)
- Modify: `docs/configuration.md` (`## Web Research And Image Search`, `:155-163`)
- Modify: `.env.example` (Parallel block at `:222-229`)

**Interfaces:** none.

- [ ] **Step 1: Add the doc rows**

In `docs/configuration.md`, one row in the existing table format:

```
| `PARALLEL_FREE_MONTHLY_USD` | No | `5` | Parallel calls are free to users until the whole server's monthly list price passes this amount | You want to change how much web research costs users | Admin overridable at runtime, like the other `admin_config` values |
```

In `README.md`, extend the existing `PARALLEL_API_KEY` bullet at `:75` in the same voice. In `.env.example`,
add a commented default next to `PARALLEL_API_KEY=` at `:226`, following the `# MAX_MODEL_CONTEXT=262144`
style at `:389`.

- [ ] **Step 2: Verify the documented name exists in code**

Run: `rg -n "PARALLEL_FREE_MONTHLY_USD" src/lib/server/env.ts src/lib/server/config-store.ts src/lib/config/admin-config-registry.ts`
Expected: three hits. AGENTS.md forbids documenting a variable that is not in a real code path.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/configuration.md .env.example
git commit -m "Document the Parallel free allowance where the other Parallel vars live"
```

---

## Non-goals

- **No per-user allowance.** One allowance, shared by the whole server (spec decision).
- **No new database column or table.** The list price is always derivable from the call count.
- **No change to Atlas or LLM/model billing.** `recordAtlasJobAnalytics` (`analytics.ts:2272-2318`) books
  model spend and is untouched; Atlas's *Parallel calls* already route through `recordParallelUsage` and are
  covered for free.
- **No change to what the user sees in their own analytics.** Users see `$0` until the allowance is used up,
  with no read-side change, because every total already sums `cost_usd_micros`.
- **No change to the Parallel call sites** in `normal-chat-tools/index.ts:690,744,887` or
  `atlas-v3/worker-bindings.ts:196-204`.
- **No metering of anything other than Parallel.** Brave image search, TEI and the local model are out of
  scope.

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| Floating-point drift between the admin's USD value and the allowance used at record time | A `$5` allowance that becomes `4.999999` micros charges a user one cent early | Convert USD → micros with `Math.round(usd * 1_000_000)` **once**, at the config boundary; the rule is integer-only and pure |
| Month-boundary ambiguity | `toBillingMonth` slices a UTC ISO string; a local-time implementation would move calls between months and change who gets charged | Reuse `toBillingMonth` (`analytics.ts:1780-1782`) everywhere; never call `getMonth()` |
| Concurrent calls overshoot the allowance | Two simultaneous calls could both see "under the allowance" and both book $0 | Count and insert inside one `db.transaction` (better-sqlite3 is synchronous, so the pair is atomic in-process); pinned by the back-to-back test in Task 2 |
| The replay script rewrites visible cost history | It is a one-way rewrite of rows users can see | Dry run is the default; the summary prints before/after per month; `--apply` is explicit |
| Pre-existing analytics tests assert `cost_usd_micros = 1000` | They will fail the moment the transaction lands, looking like a regression | Task 2 step 5 explicitly updates those fixtures to set the allowance to `0`, preserving their intent |
| A very large allowance appears to break the meter | `monthListMicros / allowanceMicros` division | Clamp the meter bar width to 100%; show "$X of $Y" regardless |

## Verification checklist

- [ ] Every task's tests are green, and each was seen failing before its implementation.
- [ ] `npm run check` — 0 errors, 0 warnings.
- [ ] `npx biome check src scripts tests` — clean. (`npm run lint` breaks under nested worktrees; report that
      explicitly instead of switching linters.)
- [ ] `npm test` — green, including the pre-existing analytics suite.
- [ ] `npm run build` — 0 warnings.
- [ ] `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json` — no new
      findings, no new broad ignores.
- [ ] `npm run check:migrations` — unchanged (this slice adds no table).
- [ ] `npx playwright test tests/e2e/settings-admin-system.spec.ts` — green.
- [ ] **Real-app visual check** against mockup §9 at **1440×900 and 390×844, light and dark**: the allowance
      row sits directly under the Parallel API Key row and matches the mockup's label, description, `$` field
      and mono key name; the meter shows "$X of $Y free allowance used", the reset line, the bar, the
      "Counted as cost" tile and the by-month table.
- [ ] **Live check on staging** (`ai.dev.alfydesign`, `langflow-chat-dev`): set the allowance to `0` and make
      one `research_web` call — the user's own cost shows `$0.001`; set it back to `5`, make another call, and
      the same user's month total drops back to `$0.000`.
- [ ] Read the staging service journal and confirm no new `[ANALYTICS]` warnings.

## Owner decisions (ratified 2026-09-24)

Both questions raised here were answered. `decisions.md` is the master record.

1. **Negative allowance: clamp in env, reject in the admin UI.** A negative env value falls back to the default
   `5`, matching `parsePositiveIntegerEnv`'s existing behaviour; the admin-config registry spec is the real gate
   and returns a `400`. `0` stays valid and means "charge everything". No hard `400` from the env path.
2. **"$Z" is the current month's counted total**, not the lifetime figure — the same line says "resets 1
   <Month>", so a lifetime number beside a monthly reset would read as a bug.
