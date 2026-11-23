// src/lib/server/config-store.memory-v2.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("memory v2 config", () => {
	beforeEach(() => {
		vi.resetModules();
	});
	afterEach(() => {
		for (const k of [
			"MEMORY_JUDGE_MODEL",
			"MEMORY_CONSOLIDATION_MODEL",
			"MEMORY_JUDGE_IDLE_MINUTES",
			"MEMORY_CONSOLIDATION_INTERVAL_MINUTES",
			"MEMORY_JUDGE_DRY_RUN",
			"MEMORY_RECALL_CORE_PERCENT",
			"MEMORY_RECALL_PROJECT_PERCENT",
			"MEMORY_TEMPORARY_EARLIER_DAYS",
			"MEMORY_ONGOING_QUIET_DAYS",
			"MEMORY_ONGOING_EARLIER_DAYS",
		])
			delete process.env[k];
	});

	it("aging thresholds default to three weeks, three weeks and three months", async () => {
		const { getMemoryAgingThresholds } = await import("./config-store");
		expect(getMemoryAgingThresholds()).toEqual({
			temporaryEarlierDays: 21,
			ongoingQuietDays: 21,
			ongoingEarlierDays: 90,
		});
	});

	it("aging thresholds come from the environment as whole days from 1 to 3650", async () => {
		process.env.MEMORY_TEMPORARY_EARLIER_DAYS = "14";
		process.env.MEMORY_ONGOING_QUIET_DAYS = "30";
		process.env.MEMORY_ONGOING_EARLIER_DAYS = "3650";
		const { getMemoryAgingThresholds } = await import("./config-store");
		expect(getMemoryAgingThresholds()).toEqual({
			temporaryEarlierDays: 14,
			ongoingQuietDays: 30,
			ongoingEarlierDays: 3650,
		});
	});

	it.each(["0", "3651", "abc", "-1", "2.5", "14days", ""])(
		"an aging threshold that is not a whole day count from 1 to 3650 (%j) keeps its default",
		async (value) => {
			process.env.MEMORY_TEMPORARY_EARLIER_DAYS = value;
			process.env.MEMORY_ONGOING_QUIET_DAYS = value;
			process.env.MEMORY_ONGOING_EARLIER_DAYS = value;
			const { getMemoryAgingThresholds } = await import("./config-store");
			expect(getMemoryAgingThresholds()).toEqual({
				temporaryEarlierDays: 21,
				ongoingQuietDays: 21,
				ongoingEarlierDays: 90,
			});
		},
	);

	it("recall shares default to a quarter for the basics and half for a project", async () => {
		const { getMemoryRecallShares } = await import("./config-store");
		expect(getMemoryRecallShares()).toEqual({
			corePercent: 25,
			projectPercent: 50,
		});
	});

	it("recall shares come from the environment and ignore values outside 0 to 100", async () => {
		process.env.MEMORY_RECALL_CORE_PERCENT = "40";
		process.env.MEMORY_RECALL_PROJECT_PERCENT = "250";
		const { getMemoryRecallShares } = await import("./config-store");
		expect(getMemoryRecallShares()).toEqual({
			corePercent: 40,
			projectPercent: 50,
		});
	});

	it.each(["abc", "-1", "2.5", "40abc", ""])(
		"a recall share that is not a whole percent (%j) keeps its default",
		async (value) => {
			process.env.MEMORY_RECALL_CORE_PERCENT = value;
			const { getMemoryRecallShares } = await import("./config-store");
			expect(getMemoryRecallShares().corePercent).toBe(25);
		},
	);

	it("defaults", async () => {
		const { getConfig } = await import("./config-store");
		const c = getConfig();
		expect(c.memoryJudgeModel).toBe("model1");
		expect(c.memoryConsolidationModel).toBe("model1");
		expect(c.memoryJudgeIdleMinutes).toBe(30);
		expect(c.memoryConsolidationIntervalMinutes).toBe(1440);
		expect(c.memoryJudgeDryRun).toBe(false);
	});

	it("env overrides", async () => {
		process.env.MEMORY_JUDGE_MODEL = "model2";
		process.env.MEMORY_JUDGE_IDLE_MINUTES = "5";
		process.env.MEMORY_JUDGE_DRY_RUN = "true";
		const { getConfig } = await import("./config-store");
		const c = getConfig();
		expect(c.memoryJudgeModel).toBe("model2");
		expect(c.memoryJudgeIdleMinutes).toBe(5);
		expect(c.memoryJudgeDryRun).toBe(true);
	});
});
