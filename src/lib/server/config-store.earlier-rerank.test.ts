// The two floors of the Earlier gate's reranker check (`memory-context/
// earlier-rerank.ts`): from the environment, as admin_config rows, and read as
// one pair the gate can trust.
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

const KEYS = ["MEMORY_EARLIER_RERANK_MIN", "MEMORY_EARLIER_RERANK_WORD_MIN"];

describe("the Earlier reranker floors", () => {
	beforeEach(() => {
		rows.length = 0;
		vi.resetModules();
	});
	afterEach(() => {
		rows.length = 0;
		for (const key of KEYS) delete process.env[key];
	});

	it("default to 0.002 for a score on its own and 0.0005 when the words agree", async () => {
		const { getMemoryEarlierRerank } = await import("./config-store");
		expect(getMemoryEarlierRerank()).toEqual({ min: 0.002, wordMin: 0.0005 });
	});

	it("come from the environment as decimals from 0 to 1", async () => {
		process.env.MEMORY_EARLIER_RERANK_MIN = "0.01";
		process.env.MEMORY_EARLIER_RERANK_WORD_MIN = ".001";
		const { getMemoryEarlierRerank } = await import("./config-store");
		expect(getMemoryEarlierRerank()).toEqual({ min: 0.01, wordMin: 0.001 });
	});

	it("take 0 and 1 as the ends of the range", async () => {
		process.env.MEMORY_EARLIER_RERANK_MIN = "1";
		process.env.MEMORY_EARLIER_RERANK_WORD_MIN = "0";
		const { getMemoryEarlierRerank } = await import("./config-store");
		expect(getMemoryEarlierRerank()).toEqual({ min: 1, wordMin: 0 });
	});

	it.each([
		"abc",
		"-0.1",
		"1.5",
		"2",
		"0.5abc",
		"1e-3",
		"NaN",
		"Infinity",
		" ",
		"",
	])(
		"keep their defaults for %j, which is not a decimal from 0 to 1",
		async (value) => {
			process.env.MEMORY_EARLIER_RERANK_MIN = value;
			process.env.MEMORY_EARLIER_RERANK_WORD_MIN = value;
			const { getMemoryEarlierRerank } = await import("./config-store");
			expect(getMemoryEarlierRerank()).toEqual({ min: 0.002, wordMin: 0.0005 });
		},
	);

	it("never read the floor for agreeing words above the floor for a score alone", async () => {
		process.env.MEMORY_EARLIER_RERANK_MIN = "0.0001";
		const { getMemoryEarlierRerank } = await import("./config-store");
		expect(getMemoryEarlierRerank()).toEqual({ min: 0.0001, wordMin: 0.0001 });
	});

	it("never read a word floor set above the main floor as more than it", async () => {
		process.env.MEMORY_EARLIER_RERANK_WORD_MIN = "0.5";
		const { getMemoryEarlierRerank } = await import("./config-store");
		expect(getMemoryEarlierRerank()).toEqual({ min: 0.002, wordMin: 0.002 });
	});

	it("are admin settings: an admin_config row replaces the environment, and a bad one is ignored", async () => {
		const {
			ADMIN_CONFIG_KEYS,
			getMemoryEarlierRerank,
			getResolvedAdminConfigValues,
			refreshConfig,
		} = await import("./config-store");
		expect(ADMIN_CONFIG_KEYS as readonly string[]).toEqual(
			expect.arrayContaining(KEYS),
		);
		rows.push(
			{ key: "MEMORY_EARLIER_RERANK_MIN", value: "0.05" },
			{ key: "MEMORY_EARLIER_RERANK_WORD_MIN", value: "0.004" },
		);
		await refreshConfig();
		expect(getMemoryEarlierRerank()).toEqual({ min: 0.05, wordMin: 0.004 });
		const resolved = getResolvedAdminConfigValues() as Record<string, string>;
		expect(resolved.MEMORY_EARLIER_RERANK_MIN).toBe("0.05");
		expect(resolved.MEMORY_EARLIER_RERANK_WORD_MIN).toBe("0.004");
		for (const value of ["abc", "1.5", "-1", "1e-3", ""]) {
			rows.length = 0;
			rows.push(
				{ key: "MEMORY_EARLIER_RERANK_MIN", value },
				{ key: "MEMORY_EARLIER_RERANK_WORD_MIN", value },
			);
			await refreshConfig();
			expect(getMemoryEarlierRerank(), value).toEqual({
				min: 0.002,
				wordMin: 0.0005,
			});
		}
	});
});
