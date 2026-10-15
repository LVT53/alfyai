// The worker has to keep itself alive.
//
// What this file is about happened on the dev box: a 250-page PDF was `parsing`
// when the service restarted. Boot recovery reclaimed nothing (the attempt's
// heartbeat was ten seconds old), and then NOTHING else ever looked at the
// table: the drain only ran when an upload woke it, and the job sat `parsing`
// with a frozen heartbeat for 23 minutes until an unrelated upload arrived. When
// the sweep finally did requeue it behind a two-second backoff, the drain found
// nothing claimable and returned, and nothing re-armed.
//
// Every test here therefore does the same thing: it starts the engine, it never
// calls a wake it did not cause, and it only moves the clock.

import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootEngine, type EngineHarness } from "./testing/harness";
import { createTestKind, type TestKindControl } from "./testing/test-kind";
import { createWorkerId, parseWorkerId } from "./worker-identity";

/** A whole second, so a run time computed from it has no fraction to lose. */
const START = new Date("2026-03-01T12:00:00.000Z");
const HOST = parseWorkerId(createWorkerId("test"))?.hostname ?? "unknown";
const DEAD_WORKER = `test:${HOST}:999999:old-boot`;

/** The default config: a 1 s heartbeat is a 5 s idle tick (the floor). */
const IDLE_TICK_MS = 5_000;
const STALE_AFTER_MS = 4_000;

let h: EngineHarness;

beforeEach(async () => {
	h = await bootEngine("scheduler");
	h.control.config.heartbeatMs = 1_000;
	h.control.config.staleAfterMs = STALE_AFTER_MS;
	vi.useFakeTimers();
	vi.setSystemTime(START);
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	h.engine.stopJobs();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	h.cleanup();
});

function boot(control: TestKindControl = h.control, engine = h.engine) {
	return engine.startJobs([control.kind], {
		startInNonServingContextForTests: true,
		isProcessAlive: () => false,
	});
}

function inspect(name = "test") {
	const inspection = h.engine.inspectJobsForTests()[name];
	if (!inspection) throw new Error(`no scheduler state for ${name}`);
	return inspection;
}

function job(jobId: string) {
	const row = h.fixture.readJob(jobId);
	if (!row) throw new Error(`no job ${jobId}`);
	return row;
}

function enqueue(
	values: { label?: string } = {},
	extra: { runAfter?: Date } = {},
) {
	return h.engine.enqueue(h.control.kind, {
		values: { userId: h.userId, ...values },
		...extra,
	});
}

/** A handler that holds its job until the test lets it go. */
function gated() {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.control.run = async (ctx) => {
		h.control.ran.push(ctx.row.id);
		await gate;
		await ctx.succeed();
	};
	return release;
}

describe("a wake", () => {
	it("is honoured after the drain it arrived in", async () => {
		await boot();
		await vi.advanceTimersByTimeAsync(0);
		// Counted from here: the boot's own drain is over.
		const before = inspect().drainRuns;
		const release = gated();
		const a = await enqueue();
		await vi.advanceTimersByTimeAsync(0);
		expect(inspect().drainRuns).toBe(before + 1);

		// A is running; B's wake finds a drain in flight and must be remembered,
		// not dropped and not run beside it.
		const b = await enqueue();
		expect(inspect().drainRuns).toBe(before + 1);
		release();
		await vi.advanceTimersByTimeAsync(0);

		expect(job(a.row.id).status).toBe("succeeded");
		expect(job(b.row.id).status).toBe("succeeded");
		expect(inspect().drainRuns).toBe(before + 2);
	});

	it("that lands after the drain's last claim is not lost", async () => {
		await boot();
		const first = await enqueue();
		let late: string | null = null;
		const realLease = h.control.definition.lease;
		h.control.definition.lease = () => {
			// Read once the drain has run the first job and looked for another: the
			// enqueue and its wake land AFTER the last claim, before the drain ends.
			if (late === null && h.control.ran.includes(first.row.id)) {
				late = "pending";
				void enqueue().then((result) => {
					late = result.row.id;
				});
			}
			return realLease();
		};
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);

		// No timer was advanced: only the remembered wake can have run it.
		expect(late).not.toBeNull();
		expect(h.control.ran).toHaveLength(2);
		expect(job(late as unknown as string).status).toBe("succeeded");
	});

	it("is counted and runs nothing before startJobs, even where the serving check passes", async () => {
		// Outside vitest's non-serving guard. A script that reopens a job from a
		// CLI must never become a second worker.
		vi.stubEnv("VITEST", "");
		vi.stubEnv("NODE_ENV", "development");
		const { row } = await enqueue();

		h.engine.wake(h.control.kind);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(inspect().wakeRequests).toBeGreaterThanOrEqual(2);
		expect(inspect().drainRuns).toBe(0);
		expect(h.control.ran).toEqual([]);
		expect(job(row.id).status).toBe("queued");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("is dropped, counted, outside a serving process unless the test started the engine", async () => {
		await h.engine.startJobs([h.control.kind]);
		const { row } = await enqueue();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(inspect()).toMatchObject({
			running: false,
			idleTickArmed: false,
			drainRuns: 0,
		});
		expect(inspect().wakeRequests).toBe(1);
		expect(job(row.id).status).toBe("queued");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("starts the engine in a serving process", async () => {
		vi.stubEnv("VITEST", "");
		vi.stubEnv("NODE_ENV", "production");
		await h.engine.startJobs([h.control.kind]);
		const { row } = await enqueue();
		await vi.advanceTimersByTimeAsync(0);

		expect(inspect().running).toBe(true);
		expect(job(row.id).status).toBe("succeeded");
	});
});

describe("starting", () => {
	it("starts a kind with its idle tick armed, unref'd, and its boot follow-up sweep", async () => {
		await boot();

		expect(inspect()).toMatchObject({
			running: true,
			idleTickArmed: true,
			idleTickMs: IDLE_TICK_MS,
			idleTickRefed: false,
			bootSweepArmed: true,
			bootSweepRefed: false,
		});
	});

	it("clamps the idle tick between 5 and 60 seconds", async () => {
		h.control.config.heartbeatMs = 100;
		await boot();
		expect(inspect().idleTickMs).toBe(5_000);
		h.engine.stopJobs();
		h.engine.resetJobsForTests();

		h.control.config.heartbeatMs = 120_000;
		await boot();
		expect(inspect().idleTickMs).toBe(60_000);
	});

	it("gives a disabled kind only the idle tick", async () => {
		h.control.config.enabled = false;
		const { row } = await enqueue();

		await boot();
		await vi.advanceTimersByTimeAsync(2_000);

		expect(inspect()).toMatchObject({
			running: false,
			idleTickArmed: true,
			bootSweepArmed: false,
			backoffArmed: false,
			drainRuns: 0,
		});
		expect(job(row.id).status).toBe("queued");
		expect(h.control.ran).toEqual([]);
	});

	it("keeps one scheduler when it is started twice, and when the module is evaluated again", async () => {
		await boot();
		const timers = vi.getTimerCount();
		expect(timers).toBeGreaterThan(0);

		await boot();
		expect(vi.getTimerCount()).toBe(timers);

		// A hot reload: a fresh module instance, the same process.
		const second = await h.bootSecondProcess();
		await boot(second.control, second.engine);

		expect(vi.getTimerCount()).toBe(timers);
		expect(second.engine.inspectJobsForTests().test).toMatchObject({
			running: true,
			idleTickArmed: true,
		});
	});

	it("reclaims a dead worker's attempt at boot, at once, and runs the job again", async () => {
		const { jobId } = h.fixture.seedRunningJob({
			userId: h.userId,
			workerId: DEAD_WORKER,
			heartbeatAgeMs: 0,
		});
		h.control.decide = () => ({ requeue: true, delayMs: 0 });

		await boot();
		await vi.advanceTimersByTimeAsync(0);

		expect(h.fixture.readAttempts(jobId).map((a) => a.status)).toEqual([
			"failed",
			"succeeded",
		]);
		expect(job(jobId).status).toBe("succeeded");
		expect(console.warn).toHaveBeenCalledWith(
			"[TEST] Reclaimed attempts from a dead worker",
			{ recovered: 1, requeued: 1 },
		);
	});

	it("takes back a running job with no attempt at boot, however fresh it is", async () => {
		const id = h.fixture.seedJob({
			userId: h.userId,
			status: "running",
			attemptCount: 1,
			currentAttemptId: crypto.randomUUID(),
		});
		h.control.decide = () => ({ requeue: true, delayMs: 0 });

		await boot();
		await vi.advanceTimersByTimeAsync(0);

		expect(job(id).status).toBe("succeeded");
	});

	it("survives a boot sweep that throws and still arms its tick", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		h.control.definition.lostAttempt = () => {
			throw new Error("bad words");
		};
		h.fixture.seedRunningJob({
			userId: h.userId,
			workerId: DEAD_WORKER,
		});

		await boot();

		expect(error).toHaveBeenCalled();
		expect(inspect()).toMatchObject({ running: true, idleTickArmed: true });
	});
});

describe("the sweeps", () => {
	it("runs the boot follow-up sweep staleAfterMs after start", async () => {
		// Fresh at boot, stale four seconds later: the attempt a restart orphaned
		// looks healthy to the sweep AT boot.
		h.control.config.heartbeatMs = 5_000; // a 10 s tick, so only the follow-up can find it
		const { jobId } = h.fixture.seedRunningJob({
			userId: h.userId,
			workerId: "worker-that-died",
			heartbeatAgeMs: 1_000,
		});
		h.control.decide = () => ({ requeue: false, retryable: true });

		await boot();
		expect(job(jobId).status).toBe("running");

		await vi.advanceTimersByTimeAsync(STALE_AFTER_MS - 1_000);
		expect(job(jobId).status).toBe("running");

		await vi.advanceTimersByTimeAsync(1_500);
		expect(console.warn).toHaveBeenCalledWith(
			"[TEST] Reclaimed stale attempts",
			expect.objectContaining({
				reason: "boot-followup",
				recovered: 1,
				staleAttemptMs: STALE_AFTER_MS,
			}),
		);
		expect(job(jobId).status).toBe("failed");
	});

	it("drains the job behind a stale one the boot follow-up sweep settles, without waiting for the tick", async () => {
		// File production never requeues: the sweep SETTLES the stale attempt that
		// held the only slot, and that frees the slot as surely as a requeue would.
		h.control.config.global = 1;
		h.control.config.heartbeatMs = 5_000; // a 10 s tick, so only the follow-up can find it
		h.control.decide = () => ({ requeue: false, retryable: true });
		const { jobId: stale } = h.fixture.seedRunningJob({
			userId: h.userId,
			workerId: "worker-that-died",
			heartbeatAgeMs: 1_000,
		});
		const behind = h.fixture.seedJob({ userId: h.userId });

		await boot();
		await vi.advanceTimersByTimeAsync(0);
		expect(job(behind).status).toBe("queued");

		await vi.advanceTimersByTimeAsync(STALE_AFTER_MS + 100);

		expect(job(stale).status).toBe("failed");
		expect(job(behind).status).toBe("succeeded");
	});

	it("goes on draining when its own sweep settles the stale job that held the only slot", async () => {
		h.control.config.global = 1;
		h.control.decide = () => ({ requeue: false, retryable: true });
		const { jobId: stale } = h.fixture.seedRunningJob({
			userId: h.userId,
			workerId: "worker-that-died",
			heartbeatAgeMs: 60_000,
		});
		const behind = h.fixture.seedJob({ userId: h.userId });

		// Not started: an explicit drain, whose first empty claim sweeps.
		await h.engine.drain(h.control.kind);

		expect(job(stale).status).toBe("failed");
		expect(job(behind).status).toBe("succeeded");
	});

	it("reclaims an attempt that only goes stale later, on the idle tick", async () => {
		await boot();
		const { jobId } = h.fixture.seedRunningJob({
			userId: h.userId,
			workerId: "worker-that-died",
			heartbeatAgeMs: 0,
		});
		h.control.decide = () => ({ requeue: false, retryable: true });

		await vi.advanceTimersByTimeAsync(STALE_AFTER_MS + 500);
		expect(job(jobId).status).toBe("running");

		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS);
		expect(console.warn).toHaveBeenCalledWith(
			"[TEST] Reclaimed stale attempts",
			expect.objectContaining({ reason: "idle-tick", recovered: 1 }),
		);
		expect(job(jobId).status).toBe("failed");
		expect(inspect().wakeRequests).toBe(0);
	});

	it("sweeps on the idle tick only when a running row exists", async () => {
		await boot();
		// Past the boot follow-up sweep, which is not what this is about.
		await vi.advanceTimersByTimeAsync(STALE_AFTER_MS + 100);
		const transactions = vi.spyOn(h.sqlite, "transaction");

		// An idle box: three ticks, one aggregate read each, no write transaction.
		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS * 3);
		expect(transactions).not.toHaveBeenCalled();

		h.fixture.seedRunningJob({
			userId: h.userId,
			workerId: "healthy",
			heartbeatAgeMs: 0,
		});
		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS);
		expect(transactions).toHaveBeenCalled();
	});

	it("says nothing about an idle tick", async () => {
		await boot();
		vi.mocked(console.info).mockClear();
		vi.mocked(console.warn).mockClear();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS * 5);

		expect(console.info).not.toHaveBeenCalled();
		expect(console.warn).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
	});

	it("leaves a fresh running row with no attempt alone on the idle tick and takes back an old one", async () => {
		h.control.config.staleAfterMs = 30_000;
		await boot();
		h.control.decide = () => ({ requeue: false, retryable: true });
		const fresh = h.fixture.seedJob({
			userId: h.userId,
			status: "running",
			attemptCount: 1,
			currentAttemptId: crypto.randomUUID(),
		});
		const old = h.fixture.seedJob({
			userId: h.userId,
			status: "running",
			attemptCount: 1,
			currentAttemptId: crypto.randomUUID(),
			updatedAt: new Date(START.getTime() - 120_000),
		});

		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS);

		expect(job(fresh).status).toBe("running");
		expect(job(old).status).toBe("failed");
		expect(console.warn).toHaveBeenCalledWith(
			"[TEST] Reclaimed jobs whose attempt state was lost",
			expect.objectContaining({ reason: "idle-tick", recovered: 1 }),
		);
	});

	it("starts a drain for claimable work nobody woke", async () => {
		await boot();
		const id = h.fixture.seedJob({ userId: h.userId });

		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS);

		expect(job(id).status).toBe("succeeded");
		expect(inspect().wakeRequests).toBe(0);
	});

	it("leaves a job the kind's claim condition holds back alone: no drain per tick for it", async () => {
		// Atlas: a job whose reply message is not linked yet cannot be claimed, and
		// the tick must not wake a drain for it every time it looks.
		const labelled = createTestKind(h.engine.defineJobKind, {
			name: "labelled",
			claimable: (jobs) => sql`${jobs.label} is not null`,
		});
		await boot(labelled);
		const held = await h.engine.enqueue(labelled.kind, {
			values: { userId: h.userId },
		});
		await vi.advanceTimersByTimeAsync(0);
		const drains = h.engine.inspectJobsForTests().labelled?.drainRuns;

		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS * 4);
		expect(h.engine.inspectJobsForTests().labelled?.drainRuns).toBe(drains);
		expect(h.engine.inspectJobsForTests().labelled?.backoffArmed).toBe(false);
		expect(job(held.row.id).status).toBe("queued");

		// Once it is let through, the next tick runs it.
		h.fixture.sqlite
			.prepare("update test_jobs set label = 'linked' where id = ?")
			.run(held.row.id);
		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS);
		expect(job(held.row.id).status).toBe("succeeded");
	});
});

describe("backoff", () => {
	it("arms one timer for the earliest run time and fires a drain one second after it", async () => {
		// A long tick, so the timer is the only thing that can find the work.
		h.control.config.heartbeatMs = 30_000;
		await boot();
		const later = await enqueue(
			{},
			{ runAfter: new Date(START.getTime() + 20_000) },
		);
		const sooner = await enqueue(
			{},
			{ runAfter: new Date(START.getTime() + 10_000) },
		);
		await vi.advanceTimersByTimeAsync(0);

		expect(inspect().backoffArmed).toBe(true);
		expect(inspect().backoffRefed).toBe(false);
		// Ten seconds and the one-second margin that covers the stored second.
		expect(inspect().backoffFiresInMs).toBe(11_000);

		await vi.advanceTimersByTimeAsync(10_900);
		expect(job(sooner.row.id).status).toBe("queued");

		await vi.advanceTimersByTimeAsync(200);
		expect(job(sooner.row.id).status).toBe("succeeded");
		expect(job(later.row.id).status).toBe("queued");

		// And it re-arms for the next one by itself.
		expect(inspect().backoffArmed).toBe(true);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(job(later.row.id).status).toBe("succeeded");
	});

	it("does not stack timers when drains repeat", async () => {
		await boot();
		await enqueue({}, { runAfter: new Date(START.getTime() + 30_000) });
		await vi.advanceTimersByTimeAsync(0);
		const timers = vi.getTimerCount();

		await enqueue({}, { runAfter: new Date(START.getTime() + 40_000) });
		await enqueue({}, { runAfter: new Date(START.getTime() + 35_000) });
		await vi.advanceTimersByTimeAsync(0);

		expect(vi.getTimerCount()).toBe(timers);
		expect(inspect().backoffFiresInMs).toBe(31_000);
	});

	it("carries a requeued job all the way to succeeded on its own timers", async () => {
		// The second half of the live failure: a sweep requeued the job behind a
		// backoff, the drain found nothing claimable, and nothing re-armed.
		h.control.decide = (_failure, history) =>
			history.attempts < 2
				? { requeue: true, delayMs: 5_000 }
				: { requeue: false, retryable: true };
		h.control.run = async (ctx) => {
			if (ctx.attempt.number === 1) {
				await ctx.fail({ code: "flaky", message: "Flaky.", retryable: true });
				return;
			}
			h.control.ran.push(ctx.row.id);
			await ctx.succeed();
		};
		await boot();
		const { row } = await enqueue();
		await vi.advanceTimersByTimeAsync(0);
		expect(job(row.id).status).toBe("queued");
		expect(inspect().backoffArmed).toBe(true);

		await vi.advanceTimersByTimeAsync(6_500);

		expect(job(row.id).status).toBe("succeeded");
		expect(h.fixture.readAttempts(row.id)).toHaveLength(2);
	});
});

describe("a policy that never gives up", () => {
	it("ends a drain that keeps claiming the same job, and the next tick carries on", async () => {
		// A policy that requeues with no delay, for a handler that always fails:
		// without a limit this is a loop that writes the database as fast as it can.
		h.control.decide = () => ({ requeue: true, delayMs: 0 });
		h.control.run = async (ctx) => {
			await ctx.fail({ code: "flaky", message: "Flaky.", retryable: true });
		};
		await boot();
		const { row } = await enqueue();
		await vi.advanceTimersByTimeAsync(0);

		expect(job(row.id)).toMatchObject({ status: "queued", attemptCount: 10 });
		expect(console.warn).toHaveBeenCalledWith(
			"[TEST] Job claimed 10 times in a row; ending this drain",
			{ jobId: row.id },
		);

		// It is not abandoned: the next tick drains again, ten attempts at a time.
		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS);
		expect(job(row.id).attemptCount).toBe(20);
	});

	it("does not mind many jobs, or a job that is retried a few times", async () => {
		let calls = 0;
		h.control.decide = (_failure, history) =>
			history.attempts < 4
				? { requeue: true, delayMs: 0 }
				: { requeue: false, retryable: true };
		h.control.run = async (ctx) => {
			calls += 1;
			if (ctx.attempt.number < 4) {
				await ctx.fail({ code: "flaky", message: "Flaky.", retryable: true });
				return;
			}
			await ctx.succeed();
		};
		await boot();
		const ids = [] as string[];
		for (let n = 0; n < 15; n += 1) ids.push((await enqueue()).row.id);
		await vi.advanceTimersByTimeAsync(0);

		for (const id of ids) expect(job(id).status).toBe("succeeded");
		expect(calls).toBe(15 * 4);
		expect(console.warn).not.toHaveBeenCalledWith(
			expect.stringContaining("in a row"),
			expect.anything(),
		);
	});
});

describe("the switch", () => {
	it("stops new claims while a running attempt finishes, and resumes at the next tick", async () => {
		await boot();
		const release = gated();
		const a = await enqueue();
		await vi.advanceTimersByTimeAsync(0);
		expect(job(a.row.id).status).toBe("running");

		// Off: nothing in flight is touched, and the next claim is declined.
		h.control.config.enabled = false;
		const b = await enqueue();
		release();
		await vi.advanceTimersByTimeAsync(0);
		expect(job(a.row.id).status).toBe("succeeded");
		expect(job(b.row.id).status).toBe("queued");

		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS);
		expect(inspect().running).toBe(false);
		expect(console.info).toHaveBeenCalledWith(
			"[TEST] Worker paused by configuration",
		);
		expect(job(b.row.id).status).toBe("queued");

		// On again: a full start, sweeps included, at the next tick.
		h.control.config.enabled = true;
		h.control.run = null;
		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS);
		expect(inspect().running).toBe(true);
		expect(job(b.row.id).status).toBe("succeeded");
	});

	it("is on for the next wake once it is turned on, without waiting for the tick", async () => {
		// Every kind before the engine read its switch when it was woken, so an
		// admin who turned a worker on saw the next job start at once. A wake that
		// only trusted the tick's last look would leave it queued for a whole tick
		// (30 s on a 15 s heartbeat), and drop every wake in between.
		h.control.config.heartbeatMs = 30_000; // a 60 s tick: only a wake can start it in time
		h.control.config.enabled = false;
		await boot();
		await vi.advanceTimersByTimeAsync(0);
		expect(inspect().running).toBe(false);

		h.control.config.enabled = true;
		const { row } = await enqueue();
		await vi.advanceTimersByTimeAsync(0);

		expect(inspect().running).toBe(true);
		expect(job(row.id).status).toBe("succeeded");

		// The same once the tick has paused it and it is turned on again.
		h.control.config.enabled = false;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(inspect().running).toBe(false);
		h.control.config.enabled = true;
		const again = await enqueue();
		await vi.advanceTimersByTimeAsync(0);
		expect(job(again.row.id).status).toBe("succeeded");
	});

	it("still drops a wake while it is off", async () => {
		h.control.config.enabled = false;
		await boot();
		await vi.advanceTimersByTimeAsync(0);
		const drains = inspect().drainRuns;

		const { row } = await enqueue();
		await vi.advanceTimersByTimeAsync(0);

		expect(inspect()).toMatchObject({ running: false, drainRuns: drains });
		expect(job(row.id).status).toBe("queued");
	});

	it("comes on after being off from the start", async () => {
		h.control.config.enabled = false;
		await boot();
		const { row } = await enqueue();
		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS);
		expect(job(row.id).status).toBe("queued");

		h.control.config.enabled = true;
		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS);

		expect(inspect().running).toBe(true);
		expect(job(row.id).status).toBe("succeeded");
		expect(console.info).toHaveBeenCalledWith(
			"[TEST] Worker started",
			expect.objectContaining({ maxConcurrency: expect.any(Number) }),
		);
	});
});

describe("stopping", () => {
	it("clears every timer and takes no new work", async () => {
		await boot();
		await enqueue({}, { runAfter: new Date(START.getTime() + 30_000) });
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBeGreaterThan(0);

		h.engine.stopJobs();

		expect(vi.getTimerCount()).toBe(0);
		expect(inspect()).toMatchObject({
			running: false,
			idleTickArmed: false,
			backoffArmed: false,
			bootSweepArmed: false,
		});

		const { row } = await enqueue();
		h.engine.wake(h.control.kind);
		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS * 3);
		expect(job(row.id).status).toBe("queued");
	});

	it("lets a running attempt finish but claims nothing after it", async () => {
		await boot();
		const release = gated();
		const a = await enqueue();
		await vi.advanceTimersByTimeAsync(0);
		const b = await enqueue();

		h.engine.stopJobs();
		release();
		await vi.advanceTimersByTimeAsync(0);

		expect(job(a.row.id).status).toBe("succeeded");
		expect(job(b.row.id).status).toBe("queued");
	});

	it("can be started again afterwards", async () => {
		await boot();
		h.engine.stopJobs();
		const { row } = await enqueue();

		await boot();
		await vi.advanceTimersByTimeAsync(0);

		expect(job(row.id).status).toBe("succeeded");
	});
});

describe("an inline run", () => {
	function inlineKind() {
		return createTestKind(h.engine.defineJobKind, {
			name: "quick",
			inline: { eligible: (row) => row.label === "inline" },
		});
	}

	it("runs an eligible job past the caps, within the budget, under its own worker id", async () => {
		const control = inlineKind();
		control.config.global = 1;
		h.fixture.seedRunningJob({ userId: h.userId, workerId: "foreign" });
		const { row } = await h.engine.enqueue(control.kind, {
			values: { userId: h.userId, label: "inline" },
		});

		await h.engine.runInline(control.kind, row.id, { budgetMs: 1_000 });

		expect(job(row.id).status).toBe("succeeded");
		expect(h.fixture.readAttempts(row.id)[0].workerId).toMatch(
			/^quick-inline:/,
		);
	});

	it("leaves an ineligible job queued", async () => {
		const control = inlineKind();
		const { row } = await h.engine.enqueue(control.kind, {
			values: { userId: h.userId, label: "pdf" },
		});

		await h.engine.runInline(control.kind, row.id, { budgetMs: 1_000 });

		expect(job(row.id).status).toBe("queued");
		expect(control.ran).toEqual([]);
	});

	it("leaves a kind with no inline rule alone", async () => {
		const { row } = await enqueue({ label: "inline" });

		await h.engine.runInline(h.control.kind, row.id, { budgetMs: 1_000 });

		expect(job(row.id).status).toBe("queued");
	});

	it("returns when the budget runs out and lets the run finish in the background", async () => {
		const control = inlineKind();
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		control.run = async (ctx) => {
			await gate;
			await ctx.succeed();
		};
		const { row } = await h.engine.enqueue(control.kind, {
			values: { userId: h.userId, label: "inline" },
		});

		let returned = false;
		const inline = h.engine
			.runInline(control.kind, row.id, { budgetMs: 500 })
			.then(() => {
				returned = true;
			});
		await vi.advanceTimersByTimeAsync(400);
		expect(returned).toBe(false);
		await vi.advanceTimersByTimeAsync(200);
		await inline;
		expect(returned).toBe(true);
		expect(job(row.id).status).toBe("running");

		release();
		await vi.advanceTimersByTimeAsync(0);
		expect(job(row.id).status).toBe("succeeded");
	});

	it("does not run when the budget is nothing, the signal is aborted, the kind is off or stopped", async () => {
		const control = inlineKind();
		const make = () =>
			h.engine.enqueue(control.kind, {
				values: { userId: h.userId, label: "inline" },
			});
		const none = await make();
		const aborted = await make();
		const off = await make();
		const stopped = await make();

		await h.engine.runInline(control.kind, none.row.id, { budgetMs: 0 });
		const controller = new AbortController();
		controller.abort();
		await h.engine.runInline(control.kind, aborted.row.id, {
			budgetMs: 1_000,
			signal: controller.signal,
		});
		control.config.enabled = false;
		await h.engine.runInline(control.kind, off.row.id, { budgetMs: 1_000 });
		control.config.enabled = true;
		h.engine.stopJobs();
		await h.engine.runInline(control.kind, stopped.row.id, { budgetMs: 1_000 });

		for (const { row } of [none, aborted, off, stopped]) {
			expect(job(row.id).status).toBe("queued");
		}
	});

	it("is cut short by the signal while it waits", async () => {
		const control = inlineKind();
		control.run = async (ctx) => {
			await new Promise<void>((resolve) =>
				ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
			);
		};
		const { row } = await h.engine.enqueue(control.kind, {
			values: { userId: h.userId, label: "inline" },
		});
		const controller = new AbortController();

		let returned = false;
		const inline = h.engine
			.runInline(control.kind, row.id, {
				budgetMs: 60_000,
				signal: controller.signal,
			})
			.then(() => {
				returned = true;
			});
		await vi.advanceTimersByTimeAsync(10);
		expect(returned).toBe(false);

		controller.abort();
		await inline;

		expect(returned).toBe(true);
		h.ledger.cancel(control.kind, row.id, { userId: h.userId });
	});
});
