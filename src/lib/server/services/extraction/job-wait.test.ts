import { describe, expect, it, vi } from "vitest";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import { waitForExtractionJobVerdict } from "./job-wait";

function job(
	overrides: Partial<DocumentExtractionJobDTO> = {},
): DocumentExtractionJobDTO {
	return {
		id: "job-1",
		sourceArtifactId: "artifact-1",
		normalizedArtifactId: null,
		status: "parsing",
		intakeRoute: "mineru",
		fileName: "report.pdf",
		attemptCount: 1,
		maxAttempts: 3,
		retryable: false,
		cancelable: true,
		error: null,
		createdAt: 0,
		updatedAt: 0,
		startedAt: 0,
		legacy: false,
		...overrides,
	};
}

function fakeClock() {
	let current = 0;
	return {
		now: () => current,
		sleep: async (ms: number) => {
			current += ms;
		},
	};
}

describe("waitForExtractionJobVerdict", () => {
	it("settles immediately on a terminal job without sleeping", async () => {
		const clock = fakeClock();
		const sleep = vi.fn(clock.sleep);
		const verdict = await waitForExtractionJobVerdict({
			getJob: async () => job({ status: "succeeded" }),
			timeoutMs: 5000,
			pollIntervalMs: 250,
			now: clock.now,
			sleep,
		});

		expect(verdict.settled).toBe(true);
		expect(verdict.job?.status).toBe("succeeded");
		expect(sleep).not.toHaveBeenCalled();
	});

	it("polls until the job goes terminal", async () => {
		const clock = fakeClock();
		const statuses: DocumentExtractionJobDTO["status"][] = [
			"queued",
			"parsing",
			"indexing",
			"succeeded",
		];
		let call = 0;
		const verdict = await waitForExtractionJobVerdict({
			getJob: async () => job({ status: statuses[call++] ?? "succeeded" }),
			timeoutMs: 5000,
			pollIntervalMs: 250,
			now: clock.now,
			sleep: clock.sleep,
		});

		expect(verdict.settled).toBe(true);
		expect(call).toBe(4);
	});

	it("gives up at the deadline and reports the last non-terminal job", async () => {
		const clock = fakeClock();
		const verdict = await waitForExtractionJobVerdict({
			getJob: async () => job({ status: "parsing" }),
			timeoutMs: 1000,
			pollIntervalMs: 250,
			now: clock.now,
			sleep: clock.sleep,
		});

		expect(verdict.settled).toBe(false);
		expect(verdict.job?.status).toBe("parsing");
	});

	it("treats a throwing lookup as 'not known yet', never as a failure", async () => {
		const clock = fakeClock();
		let call = 0;
		const verdict = await waitForExtractionJobVerdict({
			getJob: async () => {
				call += 1;
				if (call === 1) throw new Error("db busy");
				return job({ status: "succeeded" });
			},
			timeoutMs: 5000,
			pollIntervalMs: 250,
			now: clock.now,
			sleep: clock.sleep,
		});

		expect(verdict.settled).toBe(true);
	});

	it("stops on an already-aborted signal without calling the lookup", async () => {
		const controller = new AbortController();
		controller.abort();
		const getJob = vi.fn(async () => job());

		const verdict = await waitForExtractionJobVerdict({
			getJob,
			timeoutMs: 5000,
			pollIntervalMs: 250,
			signal: controller.signal,
		});

		expect(verdict).toEqual({ settled: false, job: null });
		expect(getJob).not.toHaveBeenCalled();
	});

	it("never sleeps past the deadline", async () => {
		const clock = fakeClock();
		const sleeps: number[] = [];
		await waitForExtractionJobVerdict({
			getJob: async () => job(),
			timeoutMs: 400,
			pollIntervalMs: 250,
			now: clock.now,
			sleep: async (ms) => {
				sleeps.push(ms);
				await clock.sleep(ms);
			},
		});

		expect(sleeps).toEqual([250, 150]);
	});

	it("treats a canceled job as settled, spelled with one l", async () => {
		const verdict = await waitForExtractionJobVerdict({
			getJob: async () => job({ status: "canceled" }),
			timeoutMs: 100,
			pollIntervalMs: 10,
		});
		expect(verdict.settled).toBe(true);
	});
});
