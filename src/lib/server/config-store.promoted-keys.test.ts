// The keys the admin System redesign promoted out of "edit the .env and
// restart". Each one must (a) be writable as an admin_config row and (b) show
// up in the resolved values the settings page renders, or the Advanced page
// would offer a control that quietly does nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
	"ATLAS_V2_MAX_WORDS_OVERVIEW",
	"ATLAS_V2_MAX_WORDS_IN_DEPTH",
	"ATLAS_V2_MAX_WORDS_EXHAUSTIVE",
	"ATLAS_V2_MAX_SOURCES_OVERVIEW",
	"ATLAS_V2_MAX_SOURCES_IN_DEPTH",
	"ATLAS_V2_MAX_SOURCES_EXHAUSTIVE",
	"ATLAS_V2_ENTAILMENT_BATCH",
	"ATLAS_V2_WRITER_CONCURRENCY",
	"ATTACHMENT_TRACE_DEBUG",
	"NORMAL_CHAT_DEBUG_OUTBOUND",
	"CONCURRENT_STREAM_LIMIT",
	"PER_USER_STREAM_LIMIT",
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
			{ key: "ATLAS_V2_MAX_WORDS_IN_DEPTH", value: "3000" },
			{ key: "ATLAS_V2_MAX_SOURCES_EXHAUSTIVE", value: "60" },
			{ key: "ATLAS_V2_ENTAILMENT_BATCH", value: "4" },
			{ key: "ATLAS_V2_WRITER_CONCURRENCY", value: "6" },
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
		expect(config.atlasV2MaxWordsInDepth).toBe(3000);
		expect(config.atlasV2MaxSourcesExhaustive).toBe(60);
		expect(config.atlasV2EntailmentBatch).toBe(4);
		expect(config.atlasV2WriterConcurrency).toBe(6);
		expect(config.attachmentTraceDebug).toBe(true);
		expect(config.normalChatDebugOutbound).toBe(true);
		expect(config.concurrentStreamLimit).toBe(9);
		expect(config.perUserStreamLimit).toBe(4);
	});

	it("clamps a value the server would otherwise be hurt by", async () => {
		rows.push(
			{ key: "TEI_TIMEOUT_MS", value: "1" },
			{ key: "ATLAS_V2_ENTAILMENT_BATCH", value: "900" },
			{ key: "ATLAS_V2_WRITER_CONCURRENCY", value: "0" },
			{ key: "CONCURRENT_STREAM_LIMIT", value: "0" },
			{ key: "MEMORY_MAINTENANCE_INTERVAL_MINUTES", value: "-5" },
		);

		const { getConfig, refreshConfig } = await import("./config-store");
		await refreshConfig();
		const config = getConfig();

		expect(config.teiTimeoutMs).toBe(100);
		expect(config.atlasV2EntailmentBatch).toBe(25);
		expect(config.atlasV2WriterConcurrency).toBe(1);
		expect(config.concurrentStreamLimit).toBe(1);
		expect(config.memoryMaintenanceIntervalMinutes).toBe(0);
	});

	it("reads the debug flag's env spelling as well as the UI's", async () => {
		rows.push({ key: "NORMAL_CHAT_DEBUG_OUTBOUND", value: "1" });

		const { getConfig, refreshConfig } = await import("./config-store");
		await refreshConfig();

		expect(getConfig().normalChatDebugOutbound).toBe(true);
	});

	it("hands the Atlas v2 budget knobs to the pipeline resolver", async () => {
		rows.push(
			{ key: "ATLAS_V2_MAX_WORDS_OVERVIEW", value: "900" },
			{ key: "ATLAS_V2_MAX_SOURCES_OVERVIEW", value: "12" },
		);

		const { refreshConfig } = await import("./config-store");
		await refreshConfig();
		const { resolveAtlasV2Budget } = await import("./services/atlas-v2/config");
		const budget = resolveAtlasV2Budget("overview");

		expect(budget.maxWords).toBe(900);
		expect(budget.maxIndexedSources).toBe(12);
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
});
