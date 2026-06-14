import { beforeEach, describe, expect, it } from "vitest";
import {
	getAllMetrics,
	getOrCreateMetrics,
	getUserMetrics,
	recordStepFailure,
	recordStepStart,
	recordStepSuccess,
	resetMetrics,
} from "./maintenance-metrics";

beforeEach(() => {
	resetMetrics();
});

describe("getOrCreateMetrics", () => {
	it("creates a new metrics entry for a user", () => {
		const metrics = getOrCreateMetrics("user-1");
		expect(metrics.userId).toBe("user-1");
		expect(metrics.steps).toEqual({});
	});

	it("returns the same entry on subsequent calls", () => {
		const first = getOrCreateMetrics("user-1");
		(first.steps as Record<string, unknown>)["test-step"] = {};
		const second = getOrCreateMetrics("user-1");
		expect(second).toBe(first);
		expect(second.steps["test-step"]).toBeDefined();
	});

	it("creates separate entries for different users", () => {
		const user1 = getOrCreateMetrics("user-1");
		const user2 = getOrCreateMetrics("user-2");
		expect(user1.userId).toBe("user-1");
		expect(user2.userId).toBe("user-2");
		expect(user1).not.toBe(user2);
	});
});

describe("recordStepStart", () => {
	it("initializes step metrics and returns a timestamp", () => {
		const startTime = recordStepStart("user-1", "cleanup");
		expect(startTime).toBeGreaterThan(0);

		const metrics = getOrCreateMetrics("user-1");
		const step = metrics.steps.cleanup;
		expect(step).toBeDefined();
		expect(step.stepName).toBe("cleanup");
		expect(step.totalRuns).toBe(1);
		expect(step.totalSuccesses).toBe(0);
		expect(step.totalFailures).toBe(0);
	});

	it("increments totalRuns on subsequent starts", () => {
		recordStepStart("user-1", "cleanup");
		recordStepStart("user-1", "cleanup");
		recordStepStart("user-1", "cleanup");

		const metrics = getOrCreateMetrics("user-1");
		expect(metrics.steps.cleanup.totalRuns).toBe(3);
		expect(metrics.steps.cleanup.totalSuccesses).toBe(0);
		expect(metrics.steps.cleanup.totalFailures).toBe(0);
	});
});

describe("recordStepSuccess", () => {
	it("records a success and updates counters", () => {
		const startTime = recordStepStart("user-1", "embedding-repair");
		recordStepSuccess("user-1", "embedding-repair", startTime);

		const metrics = getOrCreateMetrics("user-1");
		const step = metrics.steps["embedding-repair"];
		expect(step.totalRuns).toBe(1);
		expect(step.totalSuccesses).toBe(1);
		expect(step.totalFailures).toBe(0);
		expect(step.lastDurationMs).not.toBeNull();
		expect(step.lastDurationMs).toBeGreaterThanOrEqual(0);
		expect(step.lastRunAt).not.toBeNull();
		expect(step.lastError).toBeNull();
	});

	it("tracks rowsAffected", () => {
		const startTime = recordStepStart("user-1", "dedup");
		recordStepSuccess("user-1", "dedup", startTime, 42);

		const metrics = getOrCreateMetrics("user-1");
		const step = metrics.steps.dedup;
		expect(step.totalRowsAffected).toBe(42);
	});

	it("accumulates rowsAffected across runs", () => {
		let start = recordStepStart("user-1", "dedup");
		recordStepSuccess("user-1", "dedup", start, 10);

		start = recordStepStart("user-1", "dedup");
		recordStepSuccess("user-1", "dedup", start, 20);

		const metrics = getOrCreateMetrics("user-1");
		expect(metrics.steps.dedup.totalRowsAffected).toBe(30);
	});

	it("updates lastRunAt and lastDurationMs", () => {
		const startTime = Date.now() - 5000;
		recordStepStart("user-1", "slow-step");
		recordStepSuccess("user-1", "slow-step", startTime);

		const metrics = getOrCreateMetrics("user-1");
		const step = metrics.steps["slow-step"];
		expect(step.lastRunAt).toBeGreaterThan(0);
		expect(step.lastDurationMs).toBeGreaterThanOrEqual(4000);
	});
});

describe("recordStepFailure", () => {
	it("records a failure and updates counters", () => {
		const startTime = recordStepStart("user-1", "flaky-step");
		recordStepFailure("user-1", "flaky-step", startTime, new Error("bang"));

		const metrics = getOrCreateMetrics("user-1");
		const step = metrics.steps["flaky-step"];
		expect(step.totalRuns).toBe(1);
		expect(step.totalSuccesses).toBe(0);
		expect(step.totalFailures).toBe(1);
		expect(step.lastError).toBe("Error: bang");
		expect(step.lastRunAt).not.toBeNull();
		expect(step.lastDurationMs).not.toBeNull();
	});

	it("handles non-Error errors", () => {
		const startTime = recordStepStart("user-1", "flaky-step");
		recordStepFailure("user-1", "flaky-step", startTime, "string error");

		const metrics = getOrCreateMetrics("user-1");
		expect(metrics.steps["flaky-step"].lastError).toBe("string error");
	});

	it("accumulates failure counts across runs", () => {
		let start = recordStepStart("user-1", "flaky-step");
		recordStepFailure("user-1", "flaky-step", start, new Error("fail 1"));

		start = recordStepStart("user-1", "flaky-step");
		recordStepFailure("user-1", "flaky-step", start, new Error("fail 2"));

		const metrics = getOrCreateMetrics("user-1");
		const step = metrics.steps["flaky-step"];
		expect(step.totalFailures).toBe(2);
		expect(step.totalRuns).toBe(2);
		expect(step.lastError).toBe("Error: fail 2");
	});
});

describe("mixed success/failure scenarios", () => {
	it("tracks both successes and failures for the same step", () => {
		// First run succeeds
		let start = recordStepStart("user-1", "mixed-step");
		recordStepSuccess("user-1", "mixed-step", start, 5);

		// Second run fails
		start = recordStepStart("user-1", "mixed-step");
		recordStepFailure("user-1", "mixed-step", start, new Error("intermittent"));

		// Third run succeeds
		start = recordStepStart("user-1", "mixed-step");
		recordStepSuccess("user-1", "mixed-step", start, 3);

		const metrics = getOrCreateMetrics("user-1");
		const step = metrics.steps["mixed-step"];
		expect(step.totalRuns).toBe(3);
		expect(step.totalSuccesses).toBe(2);
		expect(step.totalFailures).toBe(1);
		expect(step.totalRowsAffected).toBe(8);
		expect(step.lastError).toBeNull();
	});

	it("isolates metrics between different users", () => {
		recordStepStart("user-1", "cleanup");
		recordStepSuccess("user-1", "cleanup", Date.now(), 10);

		recordStepStart("user-2", "cleanup");
		recordStepFailure(
			"user-2",
			"cleanup",
			Date.now(),
			new Error("user 2 fail"),
		);

		const user1Metrics = getOrCreateMetrics("user-1");
		const user2Metrics = getOrCreateMetrics("user-2");

		expect(user1Metrics.steps.cleanup.totalSuccesses).toBe(1);
		expect(user1Metrics.steps.cleanup.totalFailures).toBe(0);
		expect(user2Metrics.steps.cleanup.totalSuccesses).toBe(0);
		expect(user2Metrics.steps.cleanup.totalFailures).toBe(1);
	});
});

describe("getAllMetrics", () => {
	it("returns empty array when no metrics exist", () => {
		expect(getAllMetrics()).toEqual([]);
	});

	it("returns all user metrics", () => {
		getOrCreateMetrics("user-1");
		getOrCreateMetrics("user-2");
		recordStepStart("user-1", "step-a");
		recordStepStart("user-2", "step-b");

		const all = getAllMetrics();
		expect(all).toHaveLength(2);
		expect(all.map((m) => m.userId).sort()).toEqual(["user-1", "user-2"]);
	});
});

describe("getUserMetrics", () => {
	it("returns null for unknown user", () => {
		expect(getUserMetrics("nobody")).toBeNull();
	});

	it("returns metrics for known user", () => {
		getOrCreateMetrics("user-1");
		recordStepStart("user-1", "step-a");

		const metrics = getUserMetrics("user-1");
		expect(metrics).not.toBeNull();
		expect(metrics?.userId).toBe("user-1");
		expect(metrics?.steps["step-a"]).toBeDefined();
	});
});

describe("resetMetrics", () => {
	it("clears all stored metrics", () => {
		getOrCreateMetrics("user-1");
		getOrCreateMetrics("user-2");
		recordStepStart("user-1", "step-a");

		expect(getAllMetrics()).toHaveLength(2);

		resetMetrics();

		expect(getAllMetrics()).toHaveLength(0);
		expect(getUserMetrics("user-1")).toBeNull();
	});

	it("allows fresh creation after reset", () => {
		getOrCreateMetrics("user-1");
		resetMetrics();

		const fresh = getOrCreateMetrics("user-1");
		expect(fresh.userId).toBe("user-1");
		expect(fresh.steps).toEqual({});
	});
});
