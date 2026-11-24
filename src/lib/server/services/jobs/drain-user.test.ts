// `drainUser`: an operator's drain of one account's jobs (the Memory drain
// tool), over the engine's test kind.

import { afterEach, beforeEach, expect, it } from "vitest";
import { bootEngine, type EngineHarness } from "./testing/harness";

let h: EngineHarness;

beforeEach(async () => {
	h = await bootEngine("drain-user");
});

afterEach(() => {
	h.cleanup();
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
