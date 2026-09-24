// The keys the admin System redesign promoted out of "edit the .env and
// restart". Each one must (a) be writable as an admin_config row and (b) show
// up in the resolved values the settings page renders, or the Advanced page
// would offer a control that quietly does nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ADVANCED_KEY_SPEC_BY_KEY,
	validateAdminConfigValue,
} from "$lib/config/admin-config-registry";

const rows: Array<{ key: string; value: string }> = [];

vi.mock("./db", () => ({
	db: {
		select: () => ({ from: () => Promise.resolve(rows) }),
	},
}));

vi.mock("./services/available-models", () => ({
	getAvailableModelsWithProvidersForSettings: () => Promise.resolve([]),
	projectBuiltInAvailableModels: () => [],
	modelIconUrl: () => null,
}));

const PROMOTED = [
	"TEI_TIMEOUT_MS",
	"MEMORY_MAINTENANCE_INTERVAL_MINUTES",
	"ATTACHMENT_TRACE_DEBUG",
	"NORMAL_CHAT_DEBUG_OUTBOUND",
	"CONCURRENT_STREAM_LIMIT",
	"PER_USER_STREAM_LIMIT",
	// Changes billing behaviour, so an admin has to be able to move it without
	// a redeploy and a restart.
	"PARALLEL_FREE_MONTHLY_USD",
] as const;

describe("promoted admin config keys", () => {
	beforeEach(() => {
		rows.length = 0;
		vi.resetModules();
	});

	afterEach(() => {
		rows.length = 0;
	});

	it("accepts every promoted key as an admin config key", async () => {
		const { ADMIN_CONFIG_KEYS } = await import("./config-store");
		for (const key of PROMOTED) {
			expect(ADMIN_CONFIG_KEYS as readonly string[], key).toContain(key);
		}
	});

	it("reports a resolved value for every promoted key", async () => {
		const { getResolvedAdminConfigValues } = await import("./config-store");
		const values = getResolvedAdminConfigValues();
		for (const key of PROMOTED) {
			expect(values[key], key).toBeTypeOf("string");
			expect(values[key], key).not.toBe("");
		}
	});

	it("applies an admin_config row over the env default", async () => {
		rows.push(
			{ key: "TEI_TIMEOUT_MS", value: "12000" },
			{ key: "MEMORY_MAINTENANCE_INTERVAL_MINUTES", value: "15" },
			{ key: "ATTACHMENT_TRACE_DEBUG", value: "true" },
			{ key: "NORMAL_CHAT_DEBUG_OUTBOUND", value: "true" },
			{ key: "CONCURRENT_STREAM_LIMIT", value: "9" },
			{ key: "PER_USER_STREAM_LIMIT", value: "4" },
		);

		const { getConfig, refreshConfig } = await import("./config-store");
		await refreshConfig();
		const config = getConfig();

		expect(config.teiTimeoutMs).toBe(12000);
		expect(config.memoryMaintenanceIntervalMinutes).toBe(15);
		expect(config.attachmentTraceDebug).toBe(true);
		expect(config.normalChatDebugOutbound).toBe(true);
		expect(config.concurrentStreamLimit).toBe(9);
		expect(config.perUserStreamLimit).toBe(4);
	});

	it("clamps a value the server would otherwise be hurt by", async () => {
		rows.push(
			{ key: "TEI_TIMEOUT_MS", value: "1" },
			{ key: "CONCURRENT_STREAM_LIMIT", value: "0" },
			{ key: "MEMORY_MAINTENANCE_INTERVAL_MINUTES", value: "-5" },
		);

		const { getConfig, refreshConfig } = await import("./config-store");
		await refreshConfig();
		const config = getConfig();

		expect(config.teiTimeoutMs).toBe(100);
		expect(config.concurrentStreamLimit).toBe(1);
		expect(config.memoryMaintenanceIntervalMinutes).toBe(0);
	});

	it("reads the debug flag's env spelling as well as the UI's", async () => {
		rows.push({ key: "NORMAL_CHAT_DEBUG_OUTBOUND", value: "1" });

		const { getConfig, refreshConfig } = await import("./config-store");
		await refreshConfig();

		expect(getConfig().normalChatDebugOutbound).toBe(true);
	});

	it("removing the row reverts to the env default", async () => {
		rows.push({ key: "CONCURRENT_STREAM_LIMIT", value: "7" });
		const { getConfig, refreshConfig } = await import("./config-store");
		await refreshConfig();
		expect(getConfig().concurrentStreamLimit).toBe(7);

		rows.length = 0;
		await refreshConfig();
		expect(getConfig().concurrentStreamLimit).toBe(3);
	});

	it("reads a fractional Parallel free allowance as written", async () => {
		rows.push({ key: "PARALLEL_FREE_MONTHLY_USD", value: "2.5" });

		const { getParallelFreeMonthlyUsd, refreshConfig } = await import(
			"./config-store"
		);
		await refreshConfig();

		expect(getParallelFreeMonthlyUsd()).toBe(2.5);
	});

	it("reads an override of 0 as zero, not as unset", async () => {
		// The override appliers treat `undefined` as "no override"; 0 must
		// survive that check or an admin could not switch the allowance off.
		rows.push({ key: "PARALLEL_FREE_MONTHLY_USD", value: "0" });

		const { getParallelFreeMonthlyUsd, refreshConfig } = await import(
			"./config-store"
		);
		await refreshConfig();

		expect(getParallelFreeMonthlyUsd()).toBe(0);
	});

	it("projects the allowance in a form the admin endpoint accepts back", async () => {
		// The System screen seeds the row's draft from the RESOLVED value (this
		// projection) and sends that draft back on the next save, so a resolved
		// string the write endpoint refuses is a field that cannot be saved:
		// `String(0.0000001)` is "1e-7", and the allowance's `number` control
		// has no "e" in its accepted spelling. The projection has to be the same
		// plain decimal the registry stores.
		rows.push({ key: "PARALLEL_FREE_MONTHLY_USD", value: "0.0000001" });

		const { getResolvedAdminConfigValues, refreshConfig } = await import(
			"./config-store"
		);
		await refreshConfig();

		const allowanceSpec = ADVANCED_KEY_SPEC_BY_KEY.get(
			"PARALLEL_FREE_MONTHLY_USD",
		);
		if (!allowanceSpec)
			throw new Error("no spec for PARALLEL_FREE_MONTHLY_USD");
		const resolved = getResolvedAdminConfigValues().PARALLEL_FREE_MONTHLY_USD;

		expect(resolved).toBe("0.0000001");
		expect(validateAdminConfigValue(allowanceSpec, resolved)).toEqual({
			ok: true,
			value: "0.0000001",
		});
	});
});
