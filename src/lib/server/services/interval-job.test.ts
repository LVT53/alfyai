import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntervalJob } from "./interval-job";

describe("createIntervalJob", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("start() schedules the run on the configured period and is idempotent", async () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const run = vi.fn().mockResolvedValue(undefined);
		const job = createIntervalJob({ name: "TEST", periodMinutes: 5, run });

		job.start();
		job.start(); // idempotent — a second start must not add a second interval
		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(setIntervalSpy).toHaveBeenCalledWith(
			expect.any(Function),
			5 * 60_000,
		);
		expect(vi.getTimerCount()).toBe(1);

		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("does not start when the period is zero, negative, or nullish", () => {
		const run = vi.fn().mockResolvedValue(undefined);
		createIntervalJob({ name: "ZERO", periodMinutes: 0, run }).start();
		createIntervalJob({ name: "NEG", periodMinutes: -3, run }).start();
		createIntervalJob({ name: "NULL", periodMinutes: () => null, run }).start();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reads the period from a function at start time", () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const run = vi.fn().mockResolvedValue(undefined);
		let period = 10;
		const job = createIntervalJob({
			name: "FN",
			periodMinutes: () => period,
			run,
		});
		period = 7;
		job.start();
		expect(setIntervalSpy).toHaveBeenCalledWith(
			expect.any(Function),
			7 * 60_000,
		);
	});

	it("calls unref on the interval handle so it never keeps the process alive", () => {
		const unref = vi.fn();
		vi.spyOn(globalThis, "setInterval").mockReturnValue({
			unref,
		} as unknown as ReturnType<typeof setInterval>);
		const run = vi.fn().mockResolvedValue(undefined);
		createIntervalJob({ name: "UNREF", periodMinutes: 5, run }).start();
		expect(unref).toHaveBeenCalledTimes(1);
	});

	it("stop() clears the interval", () => {
		const run = vi.fn().mockResolvedValue(undefined);
		const job = createIntervalJob({ name: "STOP", periodMinutes: 5, run });
		job.start();
		expect(vi.getTimerCount()).toBe(1);
		job.stop();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("run-guard: does not start an overlapping run while one is in flight", async () => {
		let resolveRun: (() => void) | undefined;
		const run = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const job = createIntervalJob({ name: "GUARD", periodMinutes: 5, run });
		job.start();

		// First tick starts a run that does not resolve yet.
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(run).toHaveBeenCalledTimes(1);

		// Second tick fires while the first run is still in flight → skipped.
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(run).toHaveBeenCalledTimes(1);

		// Once the in-flight run settles, the next tick runs again.
		resolveRun?.();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(run).toHaveBeenCalledTimes(2);
	});
});
