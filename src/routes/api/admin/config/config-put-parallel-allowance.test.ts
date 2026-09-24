// Moving the Parallel free allowance changes what the running month should
// have been charged, so the write endpoint replays that month — and only that
// month, and only when the number actually moved. A PUT that touches any other
// key must never rewrite billing rows.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/db", () => ({
	db: {
		select: () => ({ from: () => Promise.resolve([]) }),
		delete: () => ({ where: () => Promise.resolve() }),
		insert: () => ({
			values: () => ({ onConflictDoUpdate: () => Promise.resolve() }),
		}),
	},
}));

vi.mock("drizzle-orm", () => ({
	eq: (_column: unknown, value: string) => ({ key: value }),
}));

vi.mock("$lib/server/db/schema", () => ({
	adminConfig: { key: "key" },
}));

vi.mock("$lib/server/prompts", () => ({
	normalizeSystemPromptReference: (value: string) => value,
}));

// The allowance the running config reports. `refreshConfig()` is where the
// route's write becomes visible to it, exactly as it does in production.
const configState = vi.hoisted(() => ({
	allowanceUsd: 5,
	nextAllowanceUsd: null as number | null,
}));

vi.mock("$lib/server/config-store", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/config-store")
	>("$lib/server/config-store");
	return {
		...actual,
		refreshConfig: vi.fn(async () => {
			if (configState.nextAllowanceUsd !== null) {
				configState.allowanceUsd = configState.nextAllowanceUsd;
			}
		}),
		getParallelFreeMonthlyUsd: () => configState.allowanceUsd,
		getEnvDefaults: () => ({}),
		getResolvedAdminConfigValues: () => ({}),
	};
});

const recompute = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("$lib/server/services/analytics", () => ({
	recomputeParallelBillingForMonth: recompute,
	toBillingMonth: (date: Date) => date.toISOString().slice(0, 7),
}));

import { PUT } from "./+server";

type RouteEvent = Parameters<typeof PUT>[0];

function makeEvent(body: Record<string, unknown>): RouteEvent {
	return {
		request: new Request("http://localhost/api/admin/config", {
			method: "PUT",
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
		}),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: {},
		url: new URL("http://localhost/api/admin/config"),
		route: { id: "/api/admin/config" },
	} as RouteEvent;
}

function currentMonth(): string {
	return new Date().toISOString().slice(0, 7);
}

describe("PUT /api/admin/config and the Parallel allowance", () => {
	beforeEach(() => {
		configState.allowanceUsd = 5;
		configState.nextAllowanceUsd = null;
		recompute.mockClear();
	});

	it("replays the running month when the allowance moves", async () => {
		configState.nextAllowanceUsd = 0;

		const response = await PUT(makeEvent({ PARALLEL_FREE_MONTHLY_USD: "0" }));

		expect(response.status).toBe(200);
		expect(recompute).toHaveBeenCalledTimes(1);
		expect(recompute).toHaveBeenCalledWith(currentMonth(), 0, {
			apply: true,
		});
	});

	it("replays it with the environment default when the override is cleared", async () => {
		configState.allowanceUsd = 2.5;
		configState.nextAllowanceUsd = 5;

		const response = await PUT(makeEvent({ PARALLEL_FREE_MONTHLY_USD: "" }));

		expect(response.status).toBe(200);
		expect(recompute).toHaveBeenCalledWith(currentMonth(), 5, {
			apply: true,
		});
	});

	it("does not replay when the value it writes is the value it already had", async () => {
		configState.nextAllowanceUsd = 5;

		const response = await PUT(makeEvent({ PARALLEL_FREE_MONTHLY_USD: "5" }));

		expect(response.status).toBe(200);
		expect(recompute).not.toHaveBeenCalled();
	});

	it("does not replay for a patch about some other key", async () => {
		const response = await PUT(makeEvent({ TEI_TIMEOUT_MS: "500" }));

		expect(response.status).toBe(200);
		expect(recompute).not.toHaveBeenCalled();
	});

	it("does not replay for a patch it refused", async () => {
		const response = await PUT(makeEvent({ PARALLEL_FREE_MONTHLY_USD: "-1" }));

		expect(response.status).toBe(400);
		expect(recompute).not.toHaveBeenCalled();
	});
});
