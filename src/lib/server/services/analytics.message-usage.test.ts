// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import type { TurnAttempt } from "$lib/server/services/chat-turn/turn-ledger";

let directory: string, database: typeof import("$lib/server/db");
beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "analytics-usage-"));
	const path = join(directory, "scratch.sqlite");
	const sqlite = new Database(path);
	migrate(drizzle(sqlite), { migrationsFolder: "./drizzle" });
	sqlite.close();
	vi.resetModules();
	vi.stubEnv("DATABASE_PATH", path);
	database = await import("$lib/server/db");
	database.db
		.insert(schema.users)
		.values({ id: "u", email: "synthetic@test.invalid", passwordHash: "x" })
		.run();
	database.db
		.insert(schema.conversations)
		.values({ id: "c", userId: "u", title: "Synthetic" })
		.run();
	database.db
		.insert(schema.providers)
		.values({
			id: "p1",
			name: "first",
			displayName: "First",
			baseUrl: "https://test.invalid",
			apiKeyEncrypted: "x",
			apiKeyIv: "x",
		})
		.run();
	database.db
		.insert(schema.providerModels)
		.values({
			id: "m1",
			providerId: "p1",
			name: "first",
			displayName: "First",
			inputUsdMicrosPer1m: 1_000_000,
			outputUsdMicrosPer1m: 2_000_000,
		})
		.run();
});
afterEach(() => {
	database?.sqlite.close();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

async function segment(
	id: string,
	overrides: Partial<TurnAttempt> = {},
	count = 1,
) {
	const ledger = await import("./chat-turn/turn-ledger");
	const scope = {
		userId: "u",
		conversationId: "c",
		turnId: id,
		segmentId: `segment-${id}`,
	};
	ledger.admitTurn({ ...scope, ownerId: "synthetic-owner" });
	const attempts: TurnAttempt[] = Array.from({ length: count }, (_, n) => ({
		attemptId: `${id}-${n}`,
		phase: "working",
		providerId: "p1",
		modelId: "provider:p1:m1",
		providerModelName: "first",
		safeStopCause: null,
		outcome: null,
		inputTokens: 100,
		outputTokens: 20,
		totalTokens: 120,
		reasoningTokens: 5,
		generationTimeMs: 1000,
		usageFinal: true,
		...overrides,
	}));
	for (const attempt of attempts)
		await ledger.recordTurnAttempt(scope, attempt);
	database.db
		.insert(schema.messages)
		.values({
			id,
			conversationId: "c",
			role: "assistant",
			content: "Synthetic",
		})
		.run();
	ledger.settleTurn(scope, {
		phase: "working",
		outcome: "answered",
		stopCause: "natural_stop",
		workingStopCause: "natural_stop",
		closingAttempted: false,
		recoveryCount: 0,
		attemptIds: attempts.map((a) => a.attemptId),
		messageId: id,
	});
	return { ledger, scope, attempts };
}

it("batches scoped saved-assistant projections without writing or charging a message aggregate", async () => {
	await segment("one", {}, 2);
	await segment("two");
	const analytics = await import("./analytics");
	const before = database.db.select().from(schema.usageEvents).all();
	const changes = () =>
		database.sqlite.prepare("SELECT total_changes() AS n").get();
	const beforeChanges = changes();
	const select = vi.spyOn(database.db, "select");
	const ids = [
		"one",
		"two",
		"one",
		...Array.from({ length: 1200 }, (_, n) => `absent-${n}`),
	];
	const projections = await analytics.getNormalChatMessageUsageProjections(
		"c",
		ids,
	);
	expect(select.mock.calls.length).toBeLessThanOrEqual(3);
	select.mockRestore();
	expect([...projections.keys()].sort()).toEqual(["one", "two"]);
	expect(projections.get("one")).toEqual({
		status: "ready",
		costUsdMicros: 280,
		generationTimeMs: 2000,
		completionTokens: 40,
		reasoningTokens: 10,
		totalTokens: 240,
	});
	expect(projections.get("two")).toEqual({
		status: "ready",
		costUsdMicros: 140,
		generationTimeMs: 1000,
		completionTokens: 20,
		reasoningTokens: 5,
		totalTokens: 120,
	});
	expect(
		await analytics.getNormalChatMessageUsageProjections(
			"another-conversation",
			["one"],
		),
	).toEqual(new Map());
	const emptySelect = vi.spyOn(database.db, "select");
	expect(await analytics.getNormalChatMessageUsageProjections("c", [])).toEqual(
		new Map(),
	);
	expect(emptySelect).not.toHaveBeenCalled();
	emptySelect.mockRestore();
	expect(changes()).toEqual(beforeChanges);
	expect(database.db.select().from(schema.usageEvents).all()).toEqual(before);
});

// The number under a reply must not change when its accounting settles: the
// page keeps the time it was told at the end of the stream, which is the
// message's own (request start to save, context preparation included) and
// longer than the attempts' sum. So the usage read gives the message's recorded
// time, and null (the page keeps its own) when that row is not there yet or
// recorded none: never the attempts' sum. The dashboard, which has no page to
// keep a number for, still falls back to the sum.
it("reads a saved turn's duration from its message's recorded time, never from the attempts' sum", async () => {
	await segment("saved", { generationTimeMs: 700 }, 2); // attempts sum 1400
	await segment("blank", { generationTimeMs: 700 }, 2); // row without a time
	await segment("none", { generationTimeMs: 700 }, 2); // no row at all
	database.db
		.insert(schema.messageAnalytics)
		.values([
			{
				id: "ma-saved",
				messageId: "saved",
				userId: "u",
				model: "m",
				generationTimeMs: 2600,
			},
			{
				id: "ma-blank",
				messageId: "blank",
				userId: "u",
				model: "m",
				generationTimeMs: null,
			},
		])
		.run();
	const analytics = await import("./analytics");
	for (const [id, expected] of [
		["saved", 2600],
		["blank", null],
		["none", null],
	] as const) {
		expect(await analytics.getMessageUsageState("u", "c", id)).toMatchObject({
			status: "ready",
			generationDurationMs: expected,
		});
	}
	// The dashboard averages the same three turns with the fallback: the sums
	// would average to 1400, the recorded time lifts the first to 2600.
	const dashboard = await analytics.getAnalyticsDashboardReadModel({
		user: { id: "u", role: "user" },
	});
	expect(dashboard.personal.avgGenerationMs).toBe((2600 + 1400 + 1400) / 3);
});

// A reload reads the same number as the live usage read: the message's recorded
// time, and none (never the attempts' sum) when that row is missing or empty.
it("shows a reloaded ledger turn the message's recorded time, and none when there is none", async () => {
	await segment("saved", { generationTimeMs: 700 }, 2);
	await segment("blank", { generationTimeMs: 700 }, 2);
	await segment("none", { generationTimeMs: 700 }, 2);
	database.db
		.insert(schema.messageAnalytics)
		.values([
			{
				id: "ma-saved",
				messageId: "saved",
				userId: "u",
				model: "m",
				generationTimeMs: 2600,
			},
			{
				id: "ma-blank",
				messageId: "blank",
				userId: "u",
				model: "m",
				generationTimeMs: null,
			},
		])
		.run();
	const analytics = await import("./analytics");
	const ids = ["saved", "blank", "none"];
	const history = await analytics.getMessageReadUsageProjections("c", ids);
	expect(
		history.availability === "resolved" &&
			ids.map((id) => history.projections.get(id)?.generationTimeMs),
	).toEqual([2600, null, null]);
});

// schema.ts declares a unique index on message_analytics.message_id that no
// migration ever created, so a message can have two rows (a replayed save). The
// recorded time is then the last row's, as the dashboard's map reads it, and the
// accounting beside it is untouched.
it("reads the last of two analytics rows for a message", async () => {
	await segment("twice", { generationTimeMs: 700 }, 2);
	database.db
		.insert(schema.messageAnalytics)
		.values([
			{
				id: "ma-first",
				messageId: "twice",
				userId: "u",
				model: "m",
				generationTimeMs: 5000,
			},
			{
				id: "ma-second",
				messageId: "twice",
				userId: "u",
				model: "m",
				generationTimeMs: 2600,
			},
		])
		.run();
	const analytics = await import("./analytics");
	expect(await analytics.getMessageUsageState("u", "c", "twice")).toMatchObject(
		{ status: "ready", costUsd: 0.00028, generationDurationMs: 2600 },
	);
});

it("keeps unpriced final usage pending with NULL aggregate fields", async () => {
	await segment("unpriced", {
		modelId: "provider:p1:absent",
		providerModelName: "unpriced",
	});
	const analytics = await import("./analytics");
	expect(
		(
			await analytics.getNormalChatMessageUsageProjections("c", ["unpriced"])
		).get("unpriced"),
	).toEqual({
		status: "pending",
		costUsdMicros: null,
		generationTimeMs: null,
		completionTokens: null,
		reasoningTokens: null,
		totalTokens: null,
	});
	expect(await analytics.getMessageUsageState("u", "c", "unpriced")).toEqual({
		status: "pending",
	});
	expect(database.db.select().from(schema.usageEvents).all()).toEqual([]);
});

it("distinguishes a sealed ready empty manifest from unobserved pending usage", async () => {
	await segment("empty", {}, 0);
	await segment("unobserved", {
		inputTokens: null,
		outputTokens: null,
		totalTokens: null,
		usageFinal: false,
	});
	const analytics = await import("./analytics");
	const rows = await analytics.getNormalChatMessageUsageProjections("c", [
		"empty",
		"unobserved",
	]);
	expect(rows.get("empty")).toEqual({
		status: "ready",
		costUsdMicros: 0,
		generationTimeMs: 0,
		completionTokens: null,
		reasoningTokens: null,
		totalTokens: null,
	});
	expect(rows.get("unobserved")).toEqual({
		status: "pending",
		costUsdMicros: null,
		generationTimeMs: null,
		completionTokens: null,
		reasoningTokens: null,
		totalTokens: null,
	});
	expect(await analytics.getMessageUsageState("u", "c", "empty")).toMatchObject(
		{ status: "ready", costUsd: 0, generationDurationMs: null },
	);
});

it("does not expose a linked row after its message is gone or outside assistant scope", async () => {
	await segment("deleted");
	await segment("user-role");
	database.db
		.delete(schema.messages)
		.where(eq(schema.messages.id, "deleted"))
		.run();
	database.db
		.update(schema.messages)
		.set({ role: "user" })
		.where(eq(schema.messages.id, "user-role"))
		.run();
	const analytics = await import("./analytics");
	expect(
		await analytics.getNormalChatMessageUsageProjections("c", [
			"deleted",
			"user-role",
		]),
	).toEqual(new Map());
	expect(
		await analytics.getMessageUsageState("u", "c", "user-role"),
	).toBeNull();
});

it("preserves live authorization and incognito untracked behavior", async () => {
	await segment("private");
	const analytics = await import("./analytics");
	expect(
		await analytics.getMessageUsageState("other-user", "c", "private"),
	).toBeNull();
	expect(
		await analytics.getMessageUsageState("u", "other-conversation", "private"),
	).toBeNull();
	database.db
		.update(schema.conversations)
		.set({ memoryIncognito: true })
		.where(eq(schema.conversations.id, "c"))
		.run();
	expect(await analytics.getMessageUsageState("u", "c", "private")).toEqual({
		status: "untracked",
	});
	expect(
		await analytics.getNormalChatMessageUsageProjections("c", ["private"]),
	).toEqual(new Map());
});
