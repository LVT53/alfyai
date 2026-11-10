// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";

let directory: string;
let ledger: typeof import("./turn-ledger");
let analytics: typeof import("../analytics");
let database: typeof import("../../db");
const scope = { userId: "u", conversationId: "c", turnId: "t", segmentId: "s" };
const terminal = {
	phase: "closing",
	closingAttempted: true,
	outcome: "failed",
	stopCause: "transport_error",
	workingStopCause: "tool_budget",
	recoveryCount: 1,
	attemptIds: ["a", "b"],
} as const;
const attempt = {
	attemptId: "a",
	phase: "working",
	providerId: "p1",
	modelId: "provider:p1:m1",
	providerModelName: "first",
	safeStopCause: "transport_error",
	outcome: "failed",
	inputTokens: 100,
	outputTokens: 20,
	totalTokens: 120,
	usageFinal: true,
} as const;

beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "turn-ledger-"));
	const path = join(directory, "db.sqlite");
	const sqlite = new Database(path);
	migrate(drizzle(sqlite), { migrationsFolder: "./drizzle" });
	sqlite.close();
	vi.resetModules();
	vi.stubEnv("DATABASE_PATH", path);
	database = await import("../../db");
	database.db
		.insert(schema.users)
		.values({
			id: "u",
			email: `${randomUUID()}@test.invalid`,
			passwordHash: "x",
		})
		.run();
	database.db
		.insert(schema.conversations)
		.values([
			{ id: "c", userId: "u", title: "Test" },
			{ id: "other", userId: "u", title: "Other" },
		])
		.run();
	for (const [id, name, input, output] of [
		["p1", "first", 1_000_000, 2_000_000],
		["p2", "second", 3_000_000, 4_000_000],
	] as const) {
		database.db
			.insert(schema.providers)
			.values({
				id,
				name,
				displayName: name,
				baseUrl: "https://test.invalid",
				apiKeyEncrypted: "x",
				apiKeyIv: "x",
			})
			.run();
		database.db
			.insert(schema.providerModels)
			.values({
				id: `m${id}`,
				providerId: id,
				name,
				displayName: name,
				inputUsdMicrosPer1m: input,
				outputUsdMicrosPer1m: output,
			})
			.run();
	}
	ledger = await import("./turn-ledger");
	analytics = await import("../analytics");
});
afterEach(() => {
	database?.sqlite.close();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

it("persists an admitted unsaved failure and makes admission and terminal replay idempotent", () => {
	expect(ledger.admitTurn({ ...scope, ownerId: "process1" }).status).toBe(
		"admitted",
	);
	expect(ledger.admitTurn({ ...scope, ownerId: "process2" }).status).toBe(
		"existing",
	);
	const settled = ledger.settleTurn(scope, { ...terminal, attemptIds: [] });
	expect(settled).toMatchObject({
		outcome: "failed",
		messageId: null,
		ownerId: "process1",
		phase: "closing",
		closingAttempted: true,
	});
	expect(ledger.settleTurn(scope, { ...terminal, attemptIds: [] })).toEqual(
		settled,
	);
	expect(ledger.observeTurn(scope)).toEqual(settled);
	expect(() =>
		ledger.settleTurn(scope, {
			...terminal,
			outcome: "answered",
			attemptIds: [],
		}),
	).toThrowError(/conflict/i);
});

it("denies cross-user/conversation scope and interrupts an abandoned owner without generation", () => {
	ledger.admitTurn({ ...scope, ownerId: "old" });
	expect(ledger.observeTurn({ ...scope, userId: "intruder" })).toBeNull();
	expect(ledger.observeTurn({ ...scope, conversationId: "other" })).toBeNull();
	expect(() =>
		ledger.settleTurn(
			{ ...scope, userId: "intruder" },
			{ ...terminal, attemptIds: [] },
		),
	).toThrowError(/scope/i);
	expect(ledger.observeAbandonedTurn(scope, ["old"])).toMatchObject({
		outcome: null,
	});
	expect(ledger.observeAbandonedTurn(scope, ["new"])).toMatchObject({
		outcome: "incomplete",
		stopCause: "uncertain_execution",
	});
	expect(ledger.admitTurn({ ...scope, ownerId: "new" }).status).toBe(
		"existing",
	);
});

it("prices failed and closing attempts once at their own rates and delays ready until the sealed aggregate reconciles", async () => {
	ledger.admitTurn({ ...scope, ownerId: "process" });
	database.db
		.insert(schema.messages)
		.values({
			id: "reply",
			conversationId: "c",
			role: "assistant",
			content: "answer",
		})
		.run();
	await analytics.recordMessageAnalytics({
		userId: "u",
		conversationId: "c",
		messageId: "reply",
		model: "model1",
		turnSegmentId: scope.segmentId,
	});
	await ledger.recordTurnAttempt(scope, attempt);
	await ledger.recordTurnAttempt(scope, attempt);
	expect(await analytics.getConversationCostSummary("c")).toEqual({
		totalCostUsdMicros: 140,
		totalTokens: 120,
	});
	ledger.settleTurn(scope, terminal);
	expect(await analytics.getMessageUsageState("u", "c", "reply")).toEqual({
		status: "pending",
	});
	await ledger.recordTurnAttempt(scope, {
		...attempt,
		attemptId: "b",
		phase: "closing",
		providerId: "p2",
		modelId: "provider:p2:m2",
		providerModelName: "second",
		outcome: "answered",
		safeStopCause: "natural_stop",
	});
	expect(await analytics.getMessageUsageState("u", "c", "reply")).toMatchObject(
		{
			status: "ready",
			costUsd: 0.00052,
			totalCostUsdMicros: 520,
			totalTokens: 240,
		},
	);
	await analytics.recordMessageAnalytics({
		userId: "u",
		conversationId: "c",
		messageId: "reply",
		model: "model1",
		promptTokens: 999,
	});
	expect(await analytics.getConversationCostSummary("c")).toEqual({
		totalCostUsdMicros: 520,
		totalTokens: 240,
	});
	expect(database.db.select().from(schema.usageEvents).all()).toHaveLength(2);
});

it("retains unknown usage as null and permits late reconciliation without charging cumulative updates twice", async () => {
	ledger.admitTurn({ ...scope, ownerId: "process" });
	await ledger.recordTurnAttempt(scope, {
		...attempt,
		inputTokens: null,
		outputTokens: null,
		totalTokens: null,
		usageFinal: false,
	});
	ledger.settleTurn(scope, { ...terminal, attemptIds: ["a"] });
	expect(ledger.observeTurn(scope)?.accountingStatus).toBe("pending");
	expect(
		database.db.select().from(schema.normalChatAttempts).get(),
	).toMatchObject({ inputTokens: null, costUsdMicros: null });
	expect(database.db.select().from(schema.usageEvents).all()).toHaveLength(0);
	await ledger.recordTurnAttempt(scope, attempt);
	expect(ledger.observeTurn(scope)?.accountingStatus).toBe("ready");
	await expect(
		ledger.recordTurnAttempt(scope, { ...attempt, inputTokens: 200 }),
	).rejects.toThrowError(/conflict/i);
	expect(await analytics.getConversationCostSummary("c")).toEqual({
		totalCostUsdMicros: 140,
		totalTokens: 120,
	});
});

it.each([
	"missing",
	null,
])("keeps an unknown or mismatched actual provider %s unpriced", async (providerId) => {
	ledger.admitTurn({ ...scope, ownerId: "process" });
	await ledger.recordTurnAttempt(scope, { ...attempt, providerId });
	expect(
		database.db.select().from(schema.normalChatAttempts).get()?.costUsdMicros,
	).toBeNull();
	expect(database.db.select().from(schema.usageEvents).all()).toHaveLength(0);
});

it("cascades content-free ledger rows on conversation and account deletion", async () => {
	ledger.admitTurn({ ...scope, ownerId: "process" });
	await ledger.recordTurnAttempt(scope, attempt);
	database.sqlite.prepare("DELETE FROM conversations WHERE id = ?").run("c");
	expect(database.db.select().from(schema.normalChatTurns).all()).toHaveLength(
		0,
	);
	expect(
		database.db.select().from(schema.normalChatAttempts).all(),
	).toHaveLength(0);
	ledger.admitTurn({
		...scope,
		conversationId: "other",
		segmentId: "s2",
		ownerId: "process",
	});
	database.sqlite.prepare("DELETE FROM users WHERE id = ?").run("u");
	expect(database.db.select().from(schema.normalChatTurns).all()).toHaveLength(
		0,
	);
});

it("leaves incognito untracked with no person-linked ledger or usage records", async () => {
	database.sqlite
		.prepare("UPDATE conversations SET memory_incognito = 1 WHERE id = ?")
		.run("c");
	expect(ledger.admitTurn({ ...scope, ownerId: "process" }).status).toBe(
		"untracked",
	);
	expect(database.db.select().from(schema.normalChatTurns).all()).toHaveLength(
		0,
	);
	expect(database.db.select().from(schema.usageEvents).all()).toHaveLength(0);
});

it("surfaces a typed storage failure instead of pretending admission succeeded", () => {
	database.sqlite.exec(
		"CREATE TRIGGER fail_turn BEFORE INSERT ON normal_chat_turns BEGIN SELECT RAISE(ABORT, 'offline'); END",
	);
	expect(() => ledger.admitTurn({ ...scope, ownerId: "process" })).toThrowError(
		ledger.TurnLedgerStorageError,
	);
});

it("keeps per-message latency analytics while suppressing the duplicate billed aggregate", async () => {
	ledger.admitTurn({ ...scope, ownerId: "process" });
	database.db
		.insert(schema.messages)
		.values({
			id: "reply",
			conversationId: "c",
			role: "assistant",
			content: "answer",
		})
		.run();
	await analytics.recordMessageAnalytics({
		userId: "u",
		conversationId: "c",
		messageId: "reply",
		model: "model1",
		turnSegmentId: scope.segmentId,
		firstByteMs: 15,
		firstTokenMs: 50,
		generationTimeMs: 200,
	});
	expect(
		database.db.select().from(schema.messageAnalytics).get(),
	).toMatchObject({ messageId: "reply", firstByteMs: 15, firstTokenMs: 50 });
	expect(database.db.select().from(schema.usageEvents).all()).toHaveLength(0);
});

it("rolls back both usage and attempt if billing storage fails and retries once", async () => {
	ledger.admitTurn({ ...scope, ownerId: "process" });
	database.sqlite.exec(
		"CREATE TRIGGER fail_usage BEFORE INSERT ON usage_events BEGIN SELECT RAISE(ABORT, 'offline'); END",
	);
	await expect(ledger.recordTurnAttempt(scope, attempt)).rejects.toThrowError(
		ledger.TurnLedgerStorageError,
	);
	expect(
		database.db.select().from(schema.normalChatAttempts).all(),
	).toHaveLength(0);
	database.sqlite.exec("DROP TRIGGER fail_usage");
	await ledger.recordTurnAttempt(scope, attempt);
	expect(await analytics.getConversationCostSummary("c")).toEqual({
		totalCostUsdMicros: 140,
		totalTokens: 120,
	});
});

it("preserves the terminal message reference when its assistant row is deleted and rejects unlisted late attempts", async () => {
	ledger.admitTurn({ ...scope, ownerId: "process" });
	database.db
		.insert(schema.messages)
		.values({
			id: "reply",
			conversationId: "c",
			role: "assistant",
			content: "answer",
		})
		.run();
	await analytics.recordMessageAnalytics({
		userId: "u",
		conversationId: "c",
		messageId: "reply",
		model: "model1",
		turnSegmentId: scope.segmentId,
	});
	ledger.settleTurn(scope, { ...terminal, attemptIds: [] });
	database.sqlite.prepare("DELETE FROM messages WHERE id = ?").run("reply");
	expect(ledger.observeTurn(scope)).toMatchObject({
		messageId: "reply",
		outcome: "failed",
	});
	await expect(ledger.recordTurnAttempt(scope, attempt)).rejects.toThrowError(
		/manifest conflict/i,
	);
});

it("keeps unknown final usage pending and allows only additive late facts", async () => {
	ledger.admitTurn({ ...scope, ownerId: "process" });
	await ledger.recordTurnAttempt(scope, {
		...attempt,
		inputTokens: null,
		outputTokens: null,
		totalTokens: null,
	});
	ledger.settleTurn(scope, { ...terminal, attemptIds: ["a"] });
	expect(ledger.observeTurn(scope)?.accountingStatus).toBe("pending");
	expect(
		database.db.select().from(schema.normalChatAttempts).get(),
	).toMatchObject({ costUsdMicros: null, inputTokens: null });
	await ledger.recordTurnAttempt(scope, attempt);
	expect(ledger.observeTurn(scope)?.accountingStatus).toBe("ready");
});

it("freezes all billed usage facts including previously absent cache breakdowns", async () => {
	ledger.admitTurn({ ...scope, ownerId: "process" });
	await ledger.recordTurnAttempt(scope, attempt);
	await expect(
		ledger.recordTurnAttempt(scope, { ...attempt, cachedInputTokens: 80 }),
	).rejects.toThrowError(/conflict/i);
});

it("types closed-database failures during observation", () => {
	database.sqlite.close();
	expect(() => ledger.observeTurn(scope)).toThrowError(
		ledger.TurnLedgerStorageError,
	);
});

it("observes a durable admission after reopening the process database and never re-admits it", async () => {
	ledger.admitTurn({ ...scope, ownerId: "old-process" });
	database.sqlite.close();
	vi.resetModules();
	database = await import("../../db");
	ledger = await import("./turn-ledger");
	expect(ledger.admitTurn({ ...scope, ownerId: "new-process" }).status).toBe(
		"existing",
	);
	expect(ledger.observeAbandonedTurn(scope, ["new-process"])).toMatchObject({
		outcome: "incomplete",
		stopCause: "uncertain_execution",
	});
});

it("keeps the legacy delayed message-cost read contract unchanged", async () => {
	database.db
		.insert(schema.messages)
		.values({
			id: "legacy",
			conversationId: "c",
			role: "assistant",
			content: "old answer",
		})
		.run();
	expect(await analytics.getMessageUsageState("u", "c", "legacy")).toEqual({
		status: "pending",
	});
	database.db
		.insert(schema.usageEvents)
		.values({
			id: "legacy-cost",
			messageId: "legacy",
			conversationId: "c",
			userId: "u",
			modelId: "model1",
			billingMonth: "2026-11",
			costUsdMicros: 1000,
			totalTokens: 55,
			generationTimeMs: 123,
		})
		.run();
	expect(await analytics.getMessageUsageState("u", "c", "legacy")).toEqual({
		status: "ready",
		costUsd: 0.001,
		totalCostUsdMicros: 1000,
		totalTokens: 55,
		generationDurationMs: 123,
	});
	expect(
		await analytics.getMessageUsageState("intruder", "c", "legacy"),
	).toBeNull();
	expect(() => {
		ledger.admitTurn({ ...scope, ownerId: "p" });
		ledger.settleTurn(scope, {
			...terminal,
			attemptIds: [],
			messageId: "legacy",
		});
	}).toThrowError(/already accounted/i);
});

it("counts failed-unsaved and linked attempts once in personal monthly analytics", async () => {
	ledger.admitTurn({ ...scope, ownerId: "process" });
	await ledger.recordTurnAttempt(scope, {
		...attempt,
		inputTokens: 100000,
		outputTokens: 20000,
		totalTokens: 120000,
	});
	ledger.settleTurn(scope, { ...terminal, attemptIds: ["a"] });
	const first = await analytics.getAnalyticsDashboardReadModel({
		user: { id: "u", role: "user" },
	});
	expect(first.personal.totalCostUsd).toBe(0.14);
	database.db
		.insert(schema.messages)
		.values({
			id: "reply",
			conversationId: "c",
			role: "assistant",
			content: "answer",
		})
		.run();
	await analytics.recordMessageAnalytics({
		userId: "u",
		conversationId: "c",
		messageId: "reply",
		model: "model1",
		turnSegmentId: scope.segmentId,
	});
	await analytics.recordMessageAnalytics({
		userId: "u",
		conversationId: "c",
		messageId: "reply",
		model: "model1",
		promptTokens: 999,
	});
	const linked = await analytics.getAnalyticsDashboardReadModel({
		user: { id: "u", role: "user" },
	});
	expect(linked.personal.totalCostUsd).toBe(0.14);
});

it.each([
	"model1",
	"model2",
])("preserves %s built-in name-based pricing and null billing-provider identity", async (modelId) => {
	ledger.admitTurn({ ...scope, ownerId: "process" });
	await ledger.recordTurnAttempt(scope, {
		...attempt,
		modelId,
		providerId: modelId,
	});
	expect(await analytics.getConversationCostSummary("c")).toEqual({
		totalCostUsdMicros: 140,
		totalTokens: 120,
	});
	expect(database.db.select().from(schema.usageEvents).get()).toMatchObject({
		providerId: null,
		modelId,
		providerModelName: "first",
	});
});

it.each([
	"analytics-first",
	"terminal-first",
])("hides message association and durable-accounting write order (%s)", async (order) => {
	ledger.admitTurn({ ...scope, ownerId: "process" });
	database.db
		.insert(schema.messages)
		.values({
			id: "ordered",
			conversationId: "c",
			role: "assistant",
			content: "answer",
		})
		.run();
	const saveAnalytics = () =>
		analytics.recordMessageAnalytics({
			userId: "u",
			conversationId: "c",
			messageId: "ordered",
			model: "model1",
			turnSegmentId: scope.segmentId,
		});
	const settle = () =>
		ledger.settleTurn(scope, {
			...terminal,
			attemptIds: ["a"],
			messageId: "ordered",
		});
	if (order === "analytics-first") {
		await saveAnalytics();
		settle();
	} else {
		settle();
		await saveAnalytics();
	}
	expect(await analytics.getMessageUsageState("u", "c", "ordered")).toEqual({
		status: "pending",
	});
	await ledger.recordTurnAttempt(scope, attempt);
	await saveAnalytics();
	settle();
	expect(
		await analytics.getMessageUsageState("u", "c", "ordered"),
	).toMatchObject({
		status: "ready",
		costUsd: 0.00014,
		totalCostUsdMicros: 140,
	});
	expect(database.db.select().from(schema.usageEvents).all()).toHaveLength(1);
});

it("derives dashboard message joins for multi-attempt billing without multiplying foreground metrics", async () => {
	const closingModel = "provider:p2:m2";
	const secondScope = { ...scope, turnId: "t2", segmentId: "s2" };
	database.db
		.insert(schema.messages)
		.values([
			{
				id: "question1",
				conversationId: "c",
				role: "user",
				content: "one",
				messageSequence: 1,
			},
			{
				id: "answer1",
				conversationId: "c",
				role: "assistant",
				content: "one",
				messageSequence: 2,
			},
			{
				id: "question2",
				conversationId: "c",
				role: "user",
				content: "two",
				messageSequence: 3,
			},
			{
				id: "answer2",
				conversationId: "c",
				role: "assistant",
				content: "two",
				messageSequence: 4,
			},
		])
		.run();
	for (const [
		turn,
		reply,
		failedIds,
		closeId,
		firstTokenMs,
		generationTimeMs,
		reasoningTokens,
	] of [
		[scope, "answer1", ["a", "a2", "a3"], "b", 100, 1000, 10],
		[secondScope, "answer2", ["c"], "d", 900, 9000, 90],
	] as const) {
		ledger.admitTurn({ ...turn, ownerId: "process" });
		for (const attemptId of failedIds) {
			await ledger.recordTurnAttempt(turn, {
				...attempt,
				attemptId,
				generationTimeMs: 100,
			});
		}
		await ledger.recordTurnAttempt(turn, {
			...attempt,
			attemptId: closeId,
			phase: "closing",
			providerId: "p2",
			modelId: closingModel,
			providerModelName: "second",
			outcome: "answered",
			safeStopCause: "natural_stop",
			generationTimeMs: 200,
		});
		ledger.settleTurn(turn, {
			...terminal,
			outcome: "answered",
			stopCause: "natural_stop",
			attemptIds: [...failedIds, closeId],
			messageId: reply,
		});
		await analytics.recordMessageAnalytics({
			userId: "u",
			conversationId: "c",
			messageId: reply,
			model: closingModel,
			turnSegmentId: turn.segmentId,
			promptTokens: 1000,
			reasoningTokens,
			firstTokenMs,
			generationTimeMs,
		});
	}
	const dashboard = await analytics.getAnalyticsDashboardReadModel({
		user: { id: "u", role: "admin" },
	});
	expect(dashboard.system).toMatchObject({
		totalMessages: 2,
		totalConversations: 1,
		modelCalls: 6,
		avgGenerationMs: 5000,
		favoriteModel: closingModel,
	});
	expect(dashboard.personal.favoriteModel).toBe(closingModel);
	expect(
		dashboard.system?.byModel.find((row) => row.model === attempt.modelId),
	).toMatchObject({
		firstTokenP50Ms: 100,
		firstTokenP90Ms: 900,
		generationP50Ms: 1000,
		avgReasoningTokens: 50,
	});
	expect(
		dashboard.latencyByPromptBucket?.find((row) => row.bucket === "<10k"),
	).toMatchObject({ n: 2, firstTokenP50Ms: 100, firstTokenP90Ms: 900 });
	for (const filter of [
		{ modelId: attempt.modelId },
		{ providerId: "p1" },
		{ providerId: "p2" },
	]) {
		const filtered = await analytics.getAnalyticsDashboardReadModel({
			user: { id: "u", role: "admin" },
			...filter,
		});
		expect(filtered.system).toMatchObject({
			totalMessages: 2,
			totalConversations: 1,
			avgGenerationMs: 5000,
		});
		expect(filtered.perUser?.find((row) => row.userId === "u")).toMatchObject({
			messageCount: 2,
			conversationCount: 1,
		});
		expect(
			filtered.latencyByPromptBucket?.find((row) => row.bucket === "<10k")?.n,
		).toBe(2);
	}
	const billed = database.db.select().from(schema.usageEvents).all();
	expect(billed).toHaveLength(6);
	expect(
		billed.every(
			(row) => row.id === row.messageId && row.id.startsWith("turn-attempt:"),
		),
	).toBe(true);
});

it("refines a preregistered alias to the authoritative billable response model before reconciliation", async () => {
	database.db
		.insert(schema.providerModels)
		.values({
			id: "response-rule",
			providerId: "p1",
			name: "resolved-version",
			displayName: "Resolved",
			inputUsdMicrosPer1m: 3_000_000,
			outputUsdMicrosPer1m: 4_000_000,
		})
		.run();
	ledger.admitTurn({ ...scope, ownerId: "process" });
	await ledger.recordTurnAttempt(scope, {
		...attempt,
		inputTokens: null,
		outputTokens: null,
		totalTokens: null,
		outcome: null,
		safeStopCause: null,
		usageFinal: false,
	});
	const startedAt = database.db
		.select()
		.from(schema.normalChatAttempts)
		.get()?.startedAt;
	const resolved = { ...attempt, providerModelName: "resolved-version" };
	await ledger.recordTurnAttempt(scope, resolved);
	const settled = ledger.settleTurn(scope, { ...terminal, attemptIds: ["a"] });
	expect(settled.accountingStatus).toBe("ready");
	await ledger.recordTurnAttempt(scope, resolved);
	expect(ledger.settleTurn(scope, { ...terminal, attemptIds: ["a"] })).toEqual(
		settled,
	);
	expect(
		database.db.select().from(schema.normalChatAttempts).get(),
	).toMatchObject({
		startedAt,
		providerModelName: "resolved-version",
		costUsdMicros: 380,
		priceRuleId: "response-rule",
	});
	expect(database.db.select().from(schema.usageEvents).all()).toMatchObject([
		{
			id: "turn-attempt:a",
			providerModelName: "resolved-version",
			costUsdMicros: 380,
			priceRuleId: "response-rule",
		},
	]);
	await expect(ledger.recordTurnAttempt(scope, attempt)).rejects.toThrowError(
		/conflict/i,
	);
	expect(await analytics.getConversationCostSummary("c")).toEqual({
		totalCostUsdMicros: 380,
		totalTokens: 120,
	});
});
