import { describe, expect, it, vi } from "vitest";
import {
	isTerminalFileProductionJobStatus,
	waitForFileProductionJobVerdict,
} from "./job-wait";
import type { FileProductionJob, FileProductionJobStatus } from "./types";

function job(status: FileProductionJobStatus): FileProductionJob {
	return {
		id: "job-1",
		conversationId: "conv-1",
		title: "Report",
		status,
		createdAt: 0,
		updatedAt: 0,
		files: [],
		warnings: [],
		dismissed: false,
		error: null,
		sourceMode: null,
	};
}

// A clock the test advances only through the sleeps the wait asks for, so the
// loop's bound is exercised without any real time passing.
function fakeClock(startMs = 0) {
	let nowMs = startMs;
	const sleeps: number[] = [];
	return {
		now: () => nowMs,
		sleeps,
		sleep: async (ms: number) => {
			sleeps.push(ms);
			nowMs += ms;
		},
	};
}

describe("waitForFileProductionJobVerdict", () => {
	it("treats succeeded, failed and cancelled as terminal and queued/running as not", () => {
		expect(isTerminalFileProductionJobStatus("succeeded")).toBe(true);
		expect(isTerminalFileProductionJobStatus("failed")).toBe(true);
		expect(isTerminalFileProductionJobStatus("cancelled")).toBe(true);
		expect(isTerminalFileProductionJobStatus("queued")).toBe(false);
		expect(isTerminalFileProductionJobStatus("running")).toBe(false);
	});

	it("returns the first terminal observation without sleeping again", async () => {
		const clock = fakeClock();
		const getJob = vi
			.fn<() => Promise<FileProductionJob | null>>()
			.mockResolvedValueOnce(job("queued"))
			.mockResolvedValueOnce(job("running"))
			.mockResolvedValueOnce(job("succeeded"));

		const verdict = await waitForFileProductionJobVerdict({
			getJob,
			timeoutMs: 20_000,
			pollIntervalMs: 400,
			now: clock.now,
			sleep: clock.sleep,
		});

		expect(verdict).toEqual({ settled: true, job: job("succeeded") });
		expect(getJob).toHaveBeenCalledTimes(3);
		expect(clock.sleeps).toEqual([400, 400]);
	});

	it("gives up at the bound and reports the last non-terminal job", async () => {
		const clock = fakeClock();
		const getJob = vi.fn().mockResolvedValue(job("running"));

		const verdict = await waitForFileProductionJobVerdict({
			getJob,
			timeoutMs: 1_000,
			pollIntervalMs: 400,
			now: clock.now,
			sleep: clock.sleep,
		});

		expect(verdict).toEqual({ settled: false, job: job("running") });
		// 400 + 400 + the 200ms remainder — the last sleep never overshoots.
		expect(clock.sleeps).toEqual([400, 400, 200]);
	});

	it("polls exactly once when the bound is zero", async () => {
		const getJob = vi.fn().mockResolvedValue(job("queued"));

		const verdict = await waitForFileProductionJobVerdict({
			getJob,
			timeoutMs: 0,
			pollIntervalMs: 400,
			now: fakeClock().now,
			sleep: async () => {
				throw new Error("must not sleep");
			},
		});

		expect(verdict).toEqual({ settled: false, job: job("queued") });
		expect(getJob).toHaveBeenCalledTimes(1);
	});

	it("retries a lookup that throws instead of reporting it as a verdict", async () => {
		const clock = fakeClock();
		const getJob = vi
			.fn<() => Promise<FileProductionJob | null>>()
			.mockRejectedValueOnce(new Error("SQLITE_BUSY"))
			.mockResolvedValueOnce(job("failed"));

		const verdict = await waitForFileProductionJobVerdict({
			getJob,
			timeoutMs: 20_000,
			pollIntervalMs: 400,
			now: clock.now,
			sleep: clock.sleep,
		});

		expect(verdict).toEqual({ settled: true, job: job("failed") });
	});

	it("stops on abort and reports the job as unsettled", async () => {
		const controller = new AbortController();
		const clock = fakeClock();
		const getJob = vi.fn().mockImplementation(async () => {
			controller.abort();
			return job("running");
		});

		const verdict = await waitForFileProductionJobVerdict({
			getJob,
			timeoutMs: 20_000,
			pollIntervalMs: 400,
			now: clock.now,
			sleep: clock.sleep,
			signal: controller.signal,
		});

		expect(verdict.settled).toBe(false);
		expect(getJob).toHaveBeenCalledTimes(1);
	});

	it("reports a job that never appears as unsettled rather than throwing", async () => {
		const clock = fakeClock();

		const verdict = await waitForFileProductionJobVerdict({
			getJob: async () => null,
			timeoutMs: 800,
			pollIntervalMs: 400,
			now: clock.now,
			sleep: clock.sleep,
		});

		expect(verdict).toEqual({ settled: false, job: null });
	});
});
