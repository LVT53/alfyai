// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import type { TurnAttempt } from "$lib/server/services/chat-turn/turn-ledger";
import type { NormalChatContinuationSnapshot } from "$lib/server/services/normal-chat-model";

let directory: string,
	database: typeof import("$lib/server/db"),
	module: typeof import("$lib/server/services/chat-turn/completion-lifetime");
const input = {
	userId: "u",
	conversationId: "c",
	requestId: "synthetic-request",
};
beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "reload-usage-"));
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
	module = await import("$lib/server/services/chat-turn/completion-lifetime");
});
afterEach(() => {
	database?.sqlite.close();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});
function snapshot(
	scope: ReturnType<typeof module.beginCompletionLifetime>["scope"],
	complete: boolean,
): NormalChatContinuationSnapshot {
	return {
		version: 1,
		fidelity: "exact",
		turnId: scope.turnId,
		segmentId: scope.segmentId,
		original: {
			providerId: "p1",
			providerBaseUrl: "https://test.invalid",
			modelName: "first",
			messages: [],
		},
		steps: [],
		prepared: { maxOutputTokens: 1000 },
		pendingImageEntries: [],
		executions: [],
		events: [],
		usage: [
			{
				turnId: scope.turnId,
				segmentId: scope.segmentId,
				attemptId: "a",
				phase: "working",
				providerId: "p1",
				modelId: "provider:p1:m1",
				responseModelId: "first",
				inputTokens: complete ? 100 : null,
				outputTokens: complete ? 20 : null,
				reasoningTokens: complete ? 5 : undefined,
				totalTokens: complete ? 120 : null,
				complete,
			},
		],
		sequence: 0,
		nextAttempt: 1,
		workingSteps: 1,
		closingSegments: [],
		deadlineAt: Date.now() + 10000,
		totalTimeoutMs: 10000,
		completion: {
			version: 1,
			turnId: scope.turnId,
			segmentId: scope.segmentId,
			phase: "working",
			outcome: "answered",
			stopCause: "natural_stop",
			workingStopCause: "natural_stop",
			closingAttempted: false,
		},
	};
}
const attempt = {
	attemptId: "a",
	phase: "working",
	providerId: "p1",
	modelId: "provider:p1:m1",
	providerModelName: "first",
} as const;

it("reload preserves a fully priced completion cost and usage", async () => {
	const life = module.beginCompletionLifetime(input);
	await life.register(attempt);
	database.db
		.insert(schema.messages)
		.values({
			id: "m",
			conversationId: "c",
			role: "assistant",
			content: "Canonical",
		})
		.run();
	life.capture(snapshot(life.scope, true));
	await life.finish("m");
	const analytics = await import("$lib/server/services/analytics");
	await analytics.recordMessageAnalytics({
		userId: "u",
		conversationId: "c",
		messageId: "m",
		model: "provider:p1:m1",
		turnSegmentId: life.scope.segmentId,
		generationTimeMs: 1000,
	});
	expect(await analytics.getMessageUsageState("u", "c", "m")).toMatchObject({
		status: "ready",
		costUsd: 0.00014,
	});
	const { listMessageWindow, listMessages } = await import(
		"$lib/server/services/messages"
	);
	const loaded = (await listMessageWindow("c")).messages.find(
		(row) => row.id === "m",
	);
	expect(loaded).toMatchObject({
		costUsd: 0.00014,
		responseTokenCount: 20,
		totalTokenCount: 120,
		thinkingTokenCount: 5,
	});
	const all = await listMessages("c");
	expect(all.find((row) => row.id === "m")).toMatchObject({
		costUsd: 0.00014,
		responseTokenCount: 20,
		totalTokenCount: 120,
		thinkingTokenCount: 5,
	});
});

// These fixtures cross the real ledger/accounting/read seams; no owner is mocked.
function knownAttempt(
	id: string,
	overrides: Partial<TurnAttempt> = {},
): TurnAttempt {
	return {
		attemptId: id,
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
	};
}
async function saveSegment(id: string, attempts: TurnAttempt[], turnId = id) {
	const ledger = await import("./chat-turn/turn-ledger");
	const scope = {
		userId: "u",
		conversationId: "c",
		turnId,
		segmentId: `segment-${id}`,
	};
	ledger.admitTurn({ ...scope, ownerId: "synthetic-owner" });
	for (const attempt of attempts)
		await ledger.recordTurnAttempt(scope, attempt);
	database.db
		.insert(schema.messages)
		.values({
			id,
			conversationId: "c",
			role: "assistant",
			content: `Canonical ${id}`,
		})
		.run();
	const terminal = {
		phase: "working",
		outcome: "answered",
		stopCause: "natural_stop",
		workingStopCause: "natural_stop",
		closingAttempted: false,
		recoveryCount: 0,
		attemptIds: attempts.map((a) => a.attemptId),
		messageId: id,
	} as const;
	ledger.settleTurn(scope, terminal);
	const analytics = await import("./analytics");
	await analytics.recordMessageAnalytics({
		userId: "u",
		conversationId: "c",
		messageId: id,
		model: "provider:p1:m1",
		turnSegmentId: scope.segmentId,
		generationTimeMs: 9999,
	});
	return { scope, terminal, ledger, analytics };
}

it("projects multi-provider attempts once without mixing resumed segments or legacy replies", async () => {
	database.db
		.insert(schema.providers)
		.values({
			id: "p2",
			name: "second",
			displayName: "Second",
			baseUrl: "https://test.invalid",
			apiKeyEncrypted: "x",
			apiKeyIv: "x",
		})
		.run();
	database.db
		.insert(schema.providerModels)
		.values({
			id: "m2",
			providerId: "p2",
			name: "second",
			displayName: "Second",
			inputUsdMicrosPer1m: 3_000_000,
			outputUsdMicrosPer1m: 4_000_000,
		})
		.run();
	database.db
		.insert(schema.messages)
		.values({
			id: "legacy",
			conversationId: "c",
			role: "assistant",
			content: "Legacy",
		})
		.run();
	const analytics = await import("./analytics");
	await analytics.recordMessageAnalytics({
		userId: "u",
		conversationId: "c",
		messageId: "legacy",
		model: "provider:p1:m1",
		generationTimeMs: 700,
		providerUsage: {
			promptTokens: 10,
			completionTokens: 4,
			reasoningTokens: 1,
			totalTokens: 14,
			source: "provider",
		},
	});
	const attempts = [
		knownAttempt("work"),
		knownAttempt("fallback", {
			providerId: "p2",
			modelId: "provider:p2:m2",
			providerModelName: "second",
			inputTokens: 50,
			outputTokens: 10,
			totalTokens: 60,
			reasoningTokens: 2,
			generationTimeMs: 2000,
		}),
		knownAttempt("close", {
			phase: "closing",
			inputTokens: 20,
			outputTokens: 5,
			totalTokens: 25,
			reasoningTokens: 0,
			generationTimeMs: 500,
		}),
	];
	const first = await saveSegment("new", attempts, "shared-turn");
	await saveSegment("resumed", [knownAttempt("resume")], "shared-turn");
	database.db
		.insert(schema.messages)
		.values({ id: "user", conversationId: "c", role: "user", content: "Next" })
		.run();
	const readers = await import("./messages");
	const before = database.db.select().from(schema.usageEvents).all();
	for (const read of [
		() => readers.listMessages("c"),
		async () => (await readers.listMessageWindow("c")).messages,
	]) {
		const rows = await read();
		expect(rows.map((r) => r.id)).toEqual(["legacy", "new", "resumed", "user"]);
		expect(rows[0]).toMatchObject({
			costUsd: 0.000018,
			responseTokenCount: 4,
			thinkingTokenCount: 1,
			totalTokenCount: 14,
			generationDurationMs: 700,
		});
		expect(rows[1]).toMatchObject({
			costUsd: 0.00036,
			responseTokenCount: 35,
			thinkingTokenCount: 7,
			totalTokenCount: 205,
			generationDurationMs: 3500,
		});
		expect(rows[2]).toMatchObject({
			costUsd: 0.00014,
			responseTokenCount: 20,
			thinkingTokenCount: 5,
			totalTokenCount: 120,
		});
		expect(rows[3].costUsd).toBeUndefined();
	}
	// The usage endpoint gives the saved turn's duration the way the dashboard
	// does: the time its message recorded when the reply was saved (9999 here),
	// the attempts' sum (3500, which the history rows above show) only as the
	// fallback. The page keeps the time it was told at the end of the stream, so
	// the endpoint may not hand back a shorter sum.
	expect(await analytics.getMessageUsageState("u", "c", "new")).toMatchObject({
		status: "ready",
		costUsd: 0.00036,
		generationDurationMs: 9999,
		totalCostUsdMicros: 518,
		totalTokens: 339,
	});
	// Replay the real immutable facts and association; no second billed message aggregate.
	for (const attempt of attempts)
		await first.ledger.recordTurnAttempt(first.scope, attempt);
	first.ledger.settleTurn(first.scope, first.terminal);
	await analytics.recordMessageAnalytics({
		userId: "u",
		conversationId: "c",
		messageId: "new",
		model: "provider:p1:m1",
		turnSegmentId: first.scope.segmentId,
	});
	expect(database.db.select().from(schema.usageEvents).all()).toEqual(before);
	expect(before.map((row) => row.messageId).sort()).toEqual([
		"legacy",
		"turn-attempt:close",
		"turn-attempt:fallback",
		"turn-attempt:resume",
		"turn-attempt:work",
	]);
});

it("keeps message page limits and offsets independent of attempt multiplicity", async () => {
	for (let n = 0; n < 5; n++)
		await saveSegment(`m${n}`, [
			knownAttempt(`a${n}`),
			knownAttempt(`b${n}`, { phase: "closing" }),
		]);
	const readers = await import("./messages");
	const pages = await Promise.all(
		[0, 2, 4].map((offset) =>
			readers.listMessageWindow("c", { limit: 2, offset }),
		),
	);
	expect(pages.map((p) => p.messages.map((m) => m.id))).toEqual([
		["m3", "m4"],
		["m1", "m2"],
		["m0"],
	]);
	expect(pages.map((p) => p.hasMoreBefore)).toEqual([true, true, false]);
	for (const row of pages.flatMap((p) => p.messages))
		expect(row).toMatchObject({
			costUsd: 0.00028,
			responseTokenCount: 40,
			thinkingTokenCount: 10,
			totalTokenCount: 240,
		});
	expect(pages.toReversed().flatMap((p) => p.messages)).toEqual(
		await readers.listMessages("c"),
	);
});

it("keeps a pending segment unknown despite known children and legacy latency until late usage is final", async () => {
	const unknown = knownAttempt("late", {
		inputTokens: null,
		outputTokens: null,
		totalTokens: null,
		reasoningTokens: null,
		generationTimeMs: null,
		usageFinal: false,
	});
	const { scope, ledger, analytics } = await saveSegment("pending", [
		knownAttempt("known"),
		unknown,
	]);
	const readers = await import("./messages");
	expect(await analytics.getMessageUsageState("u", "c", "pending")).toEqual({
		status: "pending",
	});
	const pending = (await readers.listMessageWindow("c")).messages[0];
	expect(pending.costUsd).toBeUndefined();
	expect(pending.responseTokenCount).toBeUndefined();
	expect(pending.thinkingTokenCount).toBeUndefined();
	expect(pending.totalTokenCount).toBeUndefined();
	expect(pending.generationDurationMs).toBeUndefined();
	await ledger.recordTurnAttempt(scope, knownAttempt("late"));
	expect(
		await analytics.getMessageUsageState("u", "c", "pending"),
	).toMatchObject({ status: "ready", costUsd: 0.00028 });
	expect((await readers.listMessageWindow("c")).messages[0]).toMatchObject({
		costUsd: 0.00028,
		responseTokenCount: 40,
		thinkingTokenCount: 10,
		totalTokenCount: 240,
		generationDurationMs: 2000,
	});
});

it("preserves ready zero values and unknown optional observations without legacy fallback", async () => {
	await saveSegment("zero", [
		knownAttempt("free", {
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			reasoningTokens: 0,
			generationTimeMs: 0,
		}),
	]);
	await saveSegment("optional", [
		knownAttempt("observed"),
		knownAttempt("missing", { reasoningTokens: null, generationTimeMs: null }),
	]);
	const { listMessages } = await import("./messages");
	const rows = await listMessages("c");
	expect(rows[0]).toMatchObject({
		costUsd: 0,
		responseTokenCount: 0,
		thinkingTokenCount: 0,
		totalTokenCount: 0,
		generationDurationMs: 0,
	});
	expect(rows[1]).toMatchObject({
		costUsd: 0.00028,
		responseTokenCount: 40,
		totalTokenCount: 240,
	});
	expect(rows[1].thinkingTokenCount).toBeUndefined();
	expect(rows[1].generationDurationMs).toBeUndefined();
});
