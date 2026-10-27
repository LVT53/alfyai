// @vitest-environment node
//
// Waiting for a take: the engine's verdict wait plus a once-a-second heartbeat.
// Fake timers drive the clock; the take is a row in a real migrated database,
// settled by an UPDATE the way another process would settle it.

import { eq } from "drizzle-orm";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import * as schema from "$lib/server/db/schema";
import {
	createImageFixture,
	type ImageFixture,
	warmModules,
} from "./testing/fixture";

const userId = "user-1";
const conversationId = "conv-1";
const cardId = "card-1";
const takeId = "take-1";

let fixture: ImageFixture;

beforeAll(async () => {
	await warmModules([() => import("./wait")]);
}, 30_000);

beforeEach(async () => {
	fixture = createImageFixture("image-wait");
	fixture.seedUser(userId);
	fixture.seedConversation(conversationId, userId);
	fixture.seedCard({ id: cardId, userId, conversationId });
	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
	const { db } = await import("$lib/server/db");
	db.insert(schema.imageJobs)
		.values({
			id: takeId,
			userId,
			status: "queued",
			cardId,
			conversationId,
			origin: "turn",
			requestJson: "{}",
			seed: 1,
		})
		.run();
	vi.useFakeTimers();
});

afterEach(async () => {
	vi.useRealTimers();
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The database module was never imported.
	}
	fixture.cleanup();
	vi.restoreAllMocks();
});

async function setRow(set: Partial<typeof schema.imageJobs.$inferInsert>) {
	const { db } = await import("$lib/server/db");
	db.update(schema.imageJobs)
		.set(set)
		.where(eq(schema.imageJobs.id, takeId))
		.run();
}

describe("waitForTake", () => {
	it("ticks at least once a second while the take is waiting, and stops when it settles", async () => {
		const { waitForTake } = await import("./wait");
		const onTick = vi.fn();
		const waiting = waitForTake(takeId, {
			budgetMs: 60_000,
			signal: new AbortController().signal,
			onTick,
		});

		await vi.advanceTimersByTimeAsync(3_500);
		expect(onTick).toHaveBeenCalledTimes(3);

		await setRow({
			status: "succeeded",
			resultFileId: null,
			measuresJson: JSON.stringify({
				chainSinceAnchor: 1,
				anchorIsResult: false,
			}),
		});
		await vi.advanceTimersByTimeAsync(1_000);
		const snapshot = await waiting;
		expect(snapshot).toMatchObject({
			takeId,
			status: "succeeded",
			errorCode: null,
			measures: { chainSinceAnchor: 1, anchorIsResult: false },
		});

		const ticksAtSettle = onTick.mock.calls.length;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(onTick).toHaveBeenCalledTimes(ticksAtSettle);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("gives the take back still running when the budget is out", async () => {
		await setRow({ status: "running", phase: "rendering" });
		const { waitForTake } = await import("./wait");
		const waiting = waitForTake(takeId, {
			budgetMs: 2_000,
			signal: new AbortController().signal,
		});
		await vi.advanceTimersByTimeAsync(2_000);
		expect(await waiting).toMatchObject({
			status: "running",
			phase: "rendering",
			resultFileId: null,
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("ends at once on the caller's signal", async () => {
		const { waitForTake } = await import("./wait");
		const controller = new AbortController();
		const waiting = waitForTake(takeId, {
			budgetMs: 60_000,
			signal: controller.signal,
		});
		controller.abort();
		expect(await waiting).toMatchObject({ status: "queued" });
	});

	it("reads a failure's code and whether it can be tried again", async () => {
		await setRow({
			status: "failed",
			errorCode: "image_render_failed",
			retryable: true,
		});
		const { waitForTake } = await import("./wait");
		expect(
			await waitForTake(takeId, {
				budgetMs: 1_000,
				signal: new AbortController().signal,
			}),
		).toMatchObject({
			status: "failed",
			errorCode: "image_render_failed",
			retryable: true,
		});
	});
});
