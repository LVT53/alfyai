import { beforeEach, describe, expect, it, vi } from "vitest";

// What is particular to Atlas, as the engine reads it from the kind's definition.
// The behaviour that follows from it (a claim, a take-back, a requeue) is tested
// through the engine in `research-runner.test.ts`; this file holds the values and
// the pure policy.

const mocks = vi.hoisted(() => ({ getConfig: vi.fn() }));

vi.mock("$lib/server/config-store", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/server/config-store")>();
	return { ...actual, getConfig: mocks.getConfig };
});

import { internalsOf } from "$lib/server/services/jobs/define";
import { atlasResearchJob } from "./research-job";

const definition = () => internalsOf(atlasResearchJob).definition;

function history(attempts: number) {
	return { attempts, state: null, nowMs: Date.now() };
}

const LOST = {
	code: "atlas_worker_heartbeat_timeout",
	message: "Atlas worker heartbeat timed out before completion.",
	retryable: true,
};

beforeEach(() => {
	mocks.getConfig.mockReset();
	mocks.getConfig.mockReturnValue({
		atlasWorkerEnabled: true,
		atlasGlobalActiveLimit: 2,
	});
});

describe("the Atlas kind's definition", () => {
	it("is named for its worker ids and its log lines", () => {
		expect(atlasResearchJob).toMatchObject({
			name: "atlas",
			logPrefix: "[ATLAS]",
		});
	});

	it("follows the admin switch, and is on when the setting is absent", () => {
		expect(definition().enabled()).toBe(true);

		mocks.getConfig.mockReturnValue({ atlasWorkerEnabled: false });
		expect(definition().enabled()).toBe(false);

		mocks.getConfig.mockReturnValue({});
		expect(definition().enabled()).toBe(true);
	});

	it("takes its global cap from the admin setting, never below one, and runs one job per user", () => {
		expect(definition().limits()).toEqual({ global: 2, perUser: 1 });

		mocks.getConfig.mockReturnValue({
			atlasWorkerEnabled: true,
			atlasGlobalActiveLimit: 5,
		});
		expect(definition().limits()).toEqual({ global: 5, perUser: 1 });

		mocks.getConfig.mockReturnValue({
			atlasWorkerEnabled: true,
			atlasGlobalActiveLimit: 0,
		});
		expect(definition().limits().global).toBe(1);

		mocks.getConfig.mockReturnValue({ atlasWorkerEnabled: true });
		expect(definition().limits().global).toBe(2);
	});

	it("beats every 15 seconds and takes an attempt back after 120 without one", () => {
		expect(definition().lease()).toEqual({
			heartbeatMs: 15_000,
			staleAfterMs: 120_000,
		});
	});

	it("names a lost attempt the same way, whatever took it back", () => {
		for (const reason of ["stale", "dead-worker", "state-lost"] as const) {
			expect(definition().lostAttempt(reason), reason).toEqual({
				code: LOST.code,
				message: LOST.message,
			});
		}
	});

	it("claims only a job whose reply message is linked", () => {
		expect(definition().claimable).toBeTypeOf("function");
		expect(definition().userRetry).toBeUndefined();
		expect(definition().phases).toBeUndefined();
	});

	it("settles a pipeline failure as final and retryable, as it always did", () => {
		for (const code of [
			"atlas_pipeline_failed",
			"atlas_v3_no_answer",
			"job_failed",
			"no_verdict",
		]) {
			expect(
				definition().onFailure(
					{ code, message: "x", retryable: true },
					history(1),
				),
				code,
			).toEqual({ requeue: false, retryable: true });
		}
	});

	it("requeues a lost attempt at once until the job has lost three", () => {
		expect(definition().onFailure(LOST, history(1))).toEqual({
			requeue: true,
			delayMs: 0,
		});
		expect(definition().onFailure(LOST, history(2))).toEqual({
			requeue: true,
			delayMs: 0,
		});
		// The third lost attempt settles it, retryable: a job that kills the
		// process is not run again at every restart.
		expect(definition().onFailure(LOST, history(3))).toEqual({
			requeue: false,
			retryable: true,
		});
		expect(definition().onFailure(LOST, history(7))).toEqual({
			requeue: false,
			retryable: true,
		});
	});
});
