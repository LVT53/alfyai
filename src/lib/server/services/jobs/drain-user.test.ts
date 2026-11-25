// `drainUser`: an operator's drain of one account's jobs (the Memory drain
// tool), over the engine's test kind.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootEngine, type EngineHarness } from "./testing/harness";

let h: EngineHarness;

beforeEach(async () => {
	h = await bootEngine("drain-user");
});

afterEach(() => {
	vi.useRealTimers();
	h.cleanup();
});

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
