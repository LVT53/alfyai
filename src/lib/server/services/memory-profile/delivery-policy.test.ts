import { describe, expect, it } from "vitest";
import type { FailureHistory, JobFailure } from "../jobs/types";
import {
	countedDeliveryAttempt,
	decideMemoryDeliveryFailure,
	freshDeliveryAttempts,
	NATIVE_WAIT_CODES,
	parseDeliveryRetryState,
} from "./delivery-policy";

const waits = { retainMs: 30 * 60_000, consolidationMs: 60 * 60_000 };
const failure = (
	code: string,
	extra: Partial<JobFailure> = {},
): JobFailure => ({
	code,
	message: "Memory preparation could not complete.",
	retryable: true,
	...extra,
});

/** Runs a sequence of failures through the policy as the engine would. */
function run(
	failures: Array<{ failure: JobFailure; atMs: number }>,
	start: { attempts?: number; state?: unknown } = {},
) {
	let attempts = start.attempts ?? 0;
	let state: unknown = start.state ?? null;
	const decisions = [];
	for (const { failure: f, atMs } of failures) {
		attempts += 1;
		const history: FailureHistory = { attempts, state, nowMs: atMs };
		const decision = decideMemoryDeliveryFailure(f, history, waits);
		if (decision.state !== undefined) state = decision.state;
		decisions.push(decision);
	}
	return { decisions, state, attempts };
}

describe("the Memory delivery failure policy", () => {
	it("names the codes that mean Hindsight is still working", () => {
		expect(NATIVE_WAIT_CODES).toEqual({
			native_retain_waiting: "retain",
			native_consolidation_waiting: "consolidation",
			native_retain_resubmit_due: "retain",
		});
	});

	it("requeues a job that waited on Hindsight without spending an attempt", () => {
		const start = 1_000_000;
		const { decisions } = run(
			Array.from({ length: 10 }, (_, i) => ({
				failure: failure("native_consolidation_waiting", {
					diagnostics: { waitStartedAt: start },
				}),
				atMs: start + (i + 1) * 5 * 60_000,
			})),
		);
		// Ten waits of five minutes: fifty minutes, inside the hour.
		for (const decision of decisions)
			expect(decision).toMatchObject({
				requeue: true,
				delayMs: 5_000,
				code: "native_consolidation_waiting",
				retryable: true,
			});
	});

	it("still allows three real failures after any number of waits", () => {
		const t = 2_000_000;
		const waited = Array.from({ length: 10 }, (_, i) => ({
			failure: failure("native_retain_waiting", {
				diagnostics: { waitStartedAt: t },
			}),
			atMs: t + i * 60_000,
		}));
		const real = Array.from({ length: 3 }, (_, i) => ({
			failure: failure("native_unavailable"),
			atMs: t + 20 * 60_000 + i * 60_000,
		}));
		const { decisions } = run([...waited, ...real]);
		expect(decisions.at(-3)).toMatchObject({ requeue: true, delayMs: 5_000 });
		expect(decisions.at(-2)).toMatchObject({ requeue: true, delayMs: 10_000 });
		expect(decisions.at(-1)).toMatchObject({
			requeue: false,
			retryable: true,
		});
	});

	it("ends the job native_operation_timeout once the whole wait has passed, retryable", () => {
		const t = 3_000_000;
		const { decisions, state } = run([
			{
				failure: failure("native_retain_waiting", {
					diagnostics: { waitStartedAt: t },
				}),
				atMs: t + 5 * 60_000,
			},
			{
				failure: failure("native_retain_waiting", {
					diagnostics: { waitStartedAt: t + 5 * 60_000 + 7_000 },
				}),
				atMs: t + 29 * 60_000,
			},
			{
				failure: failure("native_retain_waiting", {
					diagnostics: { waitStartedAt: t + 29 * 60_000 + 7_000 },
				}),
				// The streak began at t: thirty minutes have passed.
				atMs: t + 30 * 60_000,
			},
		]);
		expect(decisions[0]).toMatchObject({ requeue: true });
		expect(decisions[1]).toMatchObject({ requeue: true });
		expect(decisions[2]).toEqual({
			requeue: false,
			retryable: true,
			code: "native_operation_timeout",
			state: { waits: 3, waiting: null, since: null, firstWaitAt: null },
		});
		expect(state).toEqual({
			waits: 3,
			waiting: null,
			since: null,
			firstWaitAt: null,
		});
	});

	it("starts a new streak when the job moves on from a retain to a consolidation", () => {
		const t = 4_000_000;
		const { decisions } = run([
			{
				failure: failure("native_retain_waiting", {
					diagnostics: { waitStartedAt: t },
				}),
				atMs: t + 25 * 60_000,
			},
			{
				// The retain finished; the consolidation has waited five minutes.
				failure: failure("native_consolidation_waiting", {
					diagnostics: { waitStartedAt: t + 50 * 60_000 },
				}),
				atMs: t + 55 * 60_000,
			},
		]);
		expect(decisions[1]).toMatchObject({
			requeue: true,
			state: { waits: 2, waiting: "consolidation", since: t + 50 * 60_000 },
		});
	});

	it("waits as long as the failure asks when it names a delay (a resubmission)", () => {
		const t = 5_000_000;
		const { decisions } = run([
			{
				failure: failure("native_retain_resubmit_due", {
					retryAfterMs: 60_000,
					diagnostics: { waitStartedAt: t },
				}),
				atMs: t,
			},
		]);
		expect(decisions[0]).toMatchObject({
			requeue: true,
			delayMs: 60_000,
			code: "native_retain_resubmit_due",
		});
	});

	it("keeps today's limit of three for a job that never waited", () => {
		const { decisions } = run(
			[1, 2, 3].map((i) => ({
				failure: failure("native_unavailable"),
				atMs: i,
			})),
		);
		expect(decisions.map((d) => d.requeue)).toEqual([true, true, false]);
		expect(
			run([
				{
					failure: failure("memory_source_missing", { retryable: false }),
					atMs: 1,
				},
			]).decisions[0],
		).toMatchObject({ requeue: false, retryable: false });
	});

	it("gives a deliberately reopened job three fresh attempts and keeps its waits", () => {
		// Three real failures ended the job; an operator reopens it.
		const ended = run(
			[1, 2, 3].map((i) => ({
				failure: failure("native_unavailable"),
				atMs: i,
			})),
		);
		const reopened = freshDeliveryAttempts(ended.state, ended.attempts);
		expect(parseDeliveryRetryState(reopened)).toEqual({
			waits: 3,
			waiting: null,
			since: null,
			firstWaitAt: null,
		});
		const { decisions } = run(
			[4, 5, 6].map((i) => ({
				failure: failure("native_unavailable"),
				atMs: i,
			})),
			{ attempts: ended.attempts, state: reopened },
		);
		expect(decisions.map((d) => d.requeue)).toEqual([true, true, false]);
	});

	it("reads a missing or unreadable state as empty", () => {
		for (const state of [null, undefined, "x", 3, [], { waits: "2" }])
			expect(parseDeliveryRetryState(state)).toEqual({
				waits: 0,
				waiting: null,
				since: null,
				firstWaitAt: null,
			});
		expect(
			parseDeliveryRetryState({ waits: 2.7, waiting: "retain", since: 9 }),
		).toEqual({ waits: 2, waiting: "retain", since: 9, firstWaitAt: null });
	});

	it("counts an attempt by the real tries before it, waits left out", () => {
		expect(countedDeliveryAttempt({ retryState: null }, 1)).toBe(1);
		expect(
			countedDeliveryAttempt(
				{
					retryState: JSON.stringify({
						waits: 4,
						waiting: "consolidation",
						since: 1,
					}),
				},
				6,
			),
		).toBe(2);
		expect(countedDeliveryAttempt({ retryState: "not json" }, 3)).toBe(3);
	});

	it("bounds the whole wait when the job keeps switching between a retain and a consolidation", () => {
		const t = 6_000_000;
		const kinds = ["native_retain_waiting", "native_consolidation_waiting"];
		// A wait every 20 minutes, each kind's streak restarting with the switch.
		const failures = Array.from({ length: 8 }, (_, i) => ({
			failure: failure(kinds[i % 2], {
				diagnostics: { waitStartedAt: t + i * 20 * 60_000 },
			}),
			atMs: t + i * 20 * 60_000 + 5 * 60_000,
		}));
		const { decisions } = run(failures);
		const ended = decisions.findIndex((d) => !d.requeue);
		// Retain 30 plus consolidation 60: never more than 90 minutes of waiting in all.
		expect(ended).toBeGreaterThan(0);
		expect(failures[ended].atMs - t).toBeGreaterThanOrEqual(90 * 60_000);
		expect(failures[ended].atMs - t).toBeLessThan(110 * 60_000);
		expect(decisions[ended]).toMatchObject({
			requeue: false,
			retryable: true,
			code: "native_operation_timeout",
		});
	});

	it("gives a resubmission a retain wait of its own", () => {
		const t = 7_000_000;
		const { decisions } = run([
			{
				failure: failure("native_retain_waiting", {
					diagnostics: { waitStartedAt: t },
				}),
				atMs: t + 26 * 60_000,
			},
			{
				// The retain failed at minute 26; it is held back, then resubmitted.
				failure: failure("native_retain_resubmit_due", {
					retryAfterMs: 60_000,
					diagnostics: { waitStartedAt: t + 26 * 60_000 },
				}),
				atMs: t + 26 * 60_000,
			},
			{
				failure: failure("native_retain_waiting", {
					diagnostics: { waitStartedAt: t + 27 * 60_000 },
				}),
				// Past the first retain's 30 minutes, inside the resubmission's own.
				atMs: t + 40 * 60_000,
			},
		]);
		expect(decisions.map((d) => d.requeue)).toEqual([true, true, true]);
	});
});
