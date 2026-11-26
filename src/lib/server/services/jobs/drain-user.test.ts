// `drainUser`: an operator's drain of one account's jobs (the Memory drain
// tool), over the engine's test kind.

import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootEngine, type EngineHarness } from "./testing/harness";
import { createTestKind } from "./testing/test-kind";

let h: EngineHarness;

beforeEach(async () => {
	h = await bootEngine("drain-user");
});

afterEach(() => {
	vi.useRealTimers();
	h.cleanup();
});

/** Queued again after an attempt, as the failure policy leaves a job: started once, error still on it. */
function seedPutBack(
	overrides: Partial<Parameters<EngineHarness["fixture"]["seedJob"]>[0]> = {},
) {
	return h.fixture.seedJob({
		userId: h.userId,
		status: "queued",
		attemptCount: 1,
		startedAt: new Date(Date.now() - 600_000),
		errorCode: "test_waiting",
		retryable: true,
		...overrides,
	});
}

// A kind runs one job at a time box-wide, and a drain claims its next job the
// moment one ends, so without giving way it held every other account's work
// behind the whole drain (a 2,000-message import: two days).
describe("giving way to other accounts", () => {
	it("waits while another user's job is due, then takes its own once that one is taken up", async () => {
		vi.useFakeTimers();
		const other = h.fixture.seedUser("user-2");
		const theirs = await h.engine.enqueue(h.control.kind, {
			values: { userId: other },
		});
		const mine = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
		});

		const draining = h.engine.drainUser(h.control.kind, h.userId, {
			giveWayForMs: 60_000,
		});
		await vi.advanceTimersByTimeAsync(5_000);
		expect(h.control.ran).toEqual([]);

		// Their own worker takes their job.
		await h.engine.drainUser(h.control.kind, other);
		await vi.advanceTimersByTimeAsync(5_000);
		await draining;

		expect(h.control.ran).toEqual([theirs.row.id, mine.row.id]);
	});

	it("stops giving way to a due job nobody takes up once the limit has passed", async () => {
		vi.useFakeTimers();
		const other = h.fixture.seedUser("user-2");
		const theirs = await h.engine.enqueue(h.control.kind, {
			values: { userId: other },
		});
		const mine = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
		});

		const draining = h.engine.drainUser(h.control.kind, h.userId, {
			giveWayForMs: 60_000,
		});
		await vi.advanceTimersByTimeAsync(30_000);
		expect(h.control.ran).toEqual([]);
		await vi.advanceTimersByTimeAsync(35_000);
		await draining;

		expect(h.control.ran).toEqual([mine.row.id]);
		expect(h.ledger.readJobRow(h.control.kind, theirs.row.id)?.status).toBe(
			"queued",
		);
	});

	it("does not wait for another user's job that is not due yet", async () => {
		const other = h.fixture.seedUser("user-2");
		await h.engine.enqueue(h.control.kind, {
			values: { userId: other },
			runAfter: new Date(Date.now() + 10 * 60_000),
		});
		const mine = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
		});

		await h.engine.drainUser(h.control.kind, h.userId, {
			giveWayForMs: 60_000,
		});

		expect(h.control.ran).toEqual([mine.row.id]);
	});

	it("does not wait for another user's due job the kind's own claim condition refuses", async () => {
		// Nobody can claim a job with no label, so no worker will take it up.
		const labelled = createTestKind(h.engine.defineJobKind, {
			name: "labelled",
			claimable: (jobs) => sql`${jobs.label} is not null`,
		});
		const other = h.fixture.seedUser("user-2");
		const refused = await h.engine.enqueue(labelled.kind, {
			values: { userId: other },
		});
		const mine = await h.engine.enqueue(labelled.kind, {
			values: { userId: h.userId, label: "ready" },
		});
		const dueSince = () =>
			h.ledger.otherUserJobDue(
				labelled.kind,
				h.userId,
				Date.now(),
				Date.now() - 60_000,
			);
		expect(dueSince()).toBe(false);

		await h.engine.drainUser(labelled.kind, h.userId, { giveWayForMs: 60_000 });
		expect(labelled.ran).toEqual([mine.row.id]);

		// Once the kind lets it through, it is a job to give way to.
		h.fixture.sqlite
			.prepare("update test_jobs set label = 'ready' where id = ?")
			.run(refused.row.id);
		expect(dueSince()).toBe(true);
	});
});

// A job an attempt put back (queued again by the failure policy: waiting on
// Hindsight, a counted retry) is in flight. Its wait budget runs while it sits,
// so the drain that started it takes it up the moment it is due.
describe("resuming what an attempt put back", () => {
	it("resumes its own put-back job at once while another account's job is due, and still gives way for a new one", async () => {
		vi.useFakeTimers();
		const other = h.fixture.seedUser("user-2");
		const theirs = await h.engine.enqueue(h.control.kind, {
			values: { userId: other },
		});
		// Lower priority than the new job: only resuming first puts it ahead.
		const resumable = seedPutBack({ priority: 10 });
		const fresh = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
		});

		const draining = h.engine.drainUser(h.control.kind, h.userId, {
			giveWayForMs: 60_000,
		});
		await vi.advanceTimersByTimeAsync(5_000);
		expect(h.control.ran).toEqual([resumable]);

		// The new job waits for the other account's, which their worker now takes.
		await h.engine.drainUser(h.control.kind, other);
		await vi.advanceTimersByTimeAsync(5_000);
		await draining;

		expect(h.control.ran).toEqual([resumable, theirs.row.id, fresh.row.id]);
	});

	it("resumes a put-back job the moment it falls due while the drain is giving way", async () => {
		vi.useFakeTimers();
		const other = h.fixture.seedUser("user-2");
		const theirs = await h.engine.enqueue(h.control.kind, {
			values: { userId: other },
		});
		const resumable = seedPutBack({ runAfter: new Date(Date.now() + 10_000) });

		const draining = h.engine.drainUser(h.control.kind, h.userId, {
			giveWayForMs: 60_000,
		});
		await vi.advanceTimersByTimeAsync(8_000);
		expect(h.control.ran).toEqual([]);
		await vi.advanceTimersByTimeAsync(7_000);
		// Not after the whole give-way: their job is still due and still waited on.
		expect(h.control.ran).toEqual([resumable]);
		expect(h.ledger.readJobRow(h.control.kind, theirs.row.id)?.status).toBe(
			"queued",
		);

		await vi.advanceTimersByTimeAsync(60_000);
		await draining;
		expect(h.control.ran).toEqual([resumable]);
	});

	it("claims with resumeOnly only a job the failure policy queued again", async () => {
		const claim = () =>
			h.ledger.claimNext(h.control.kind, {
				workerId: "w1",
				userId: h.userId,
				resumeOnly: true,
			});
		// Never attempted.
		await h.engine.enqueue(h.control.kind, { values: { userId: h.userId } });
		// An error but no attempt: nothing to resume.
		h.fixture.seedJob({
			userId: h.userId,
			status: "queued",
			errorCode: "test_waiting",
		});
		// Reopened by a person or an operator: started once, but the reopening
		// cleared the error, so it is a job to start over, not one in flight.
		const settled = h.fixture.seedJob({
			userId: h.userId,
			status: "failed",
			attemptCount: 2,
			startedAt: new Date(Date.now() - 600_000),
			errorCode: "test_failed",
			retryable: true,
			completedAt: new Date(),
		});
		const reopened = await h.engine.reopen(h.control.kind, settled, {
			userId: h.userId,
			from: ["failed"],
		});
		expect(reopened).toMatchObject({
			status: "queued",
			errorCode: null,
		});
		expect(reopened?.startedAt).not.toBeNull();

		expect(claim()).toBeNull();

		const resumable = seedPutBack();
		expect(claim()?.row.id).toBe(resumable);
		expect(claim()).toBeNull();
		// Another user's put-back job is not this drain's.
		const other = h.fixture.seedUser("user-2");
		seedPutBack({ userId: other });
		expect(claim()).toBeNull();
	});

	it("drains only the put-back jobs with resumeOnly, and never gives way", async () => {
		const other = h.fixture.seedUser("user-2");
		const theirs = await h.engine.enqueue(h.control.kind, {
			values: { userId: other },
		});
		const fresh = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
		});
		const resumable = seedPutBack();
		const gaveWay = vi.fn(async () => {
			throw new Error("The drain gave way.");
		});

		await h.engine.drainUser(h.control.kind, h.userId, {
			giveWayForMs: 60_000,
			resumeOnly: true,
			clock: { now: () => Date.now(), sleep: gaveWay },
		});

		expect(gaveWay).not.toHaveBeenCalled();
		expect(h.control.ran).toEqual([resumable]);
		for (const id of [fresh.row.id, theirs.row.id])
			expect(h.ledger.readJobRow(h.control.kind, id)?.status).toBe("queued");
	});

	it("ends after claiming the same put-back job ten times in a row", async () => {
		h.control.decide = () => ({ requeue: true, delayMs: 0 });
		h.control.run = async (ctx) => {
			await ctx.fail({ code: "again", message: "Again.", retryable: true });
		};
		const { row } = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
		});

		await h.engine.drainUser(h.control.kind, h.userId);

		// The first claim is a new job's; every later one resumes it.
		expect(h.fixture.readAttempts(row.id)).toHaveLength(10);
		expect(h.fixture.readJob(row.id)).toMatchObject({
			status: "queued",
			errorCode: "again",
		});
	});
});

it("runs every claimable job of that user and no one else's", async () => {
	const other = h.fixture.seedUser("user-2");
	const mine = [
		await h.engine.enqueue(h.control.kind, { values: { userId: h.userId } }),
		await h.engine.enqueue(h.control.kind, { values: { userId: h.userId } }),
	];
	const theirs = await h.engine.enqueue(h.control.kind, {
		values: { userId: other },
	});
	await h.engine.drainUser(h.control.kind, h.userId);
	expect(h.control.ran).toEqual(mine.map((job) => job.row.id));
	expect(h.ledger.readJobRow(h.control.kind, theirs.row.id)?.status).toBe(
		"queued",
	);
});

it("takes nothing while the kind is switched off", async () => {
	await h.engine.enqueue(h.control.kind, { values: { userId: h.userId } });
	h.control.config.enabled = false;
	await h.engine.drainUser(h.control.kind, h.userId);
	expect(h.control.ran).toEqual([]);
});
