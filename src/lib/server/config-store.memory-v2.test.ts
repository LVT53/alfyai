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
		])
			delete process.env[k];
	});

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
