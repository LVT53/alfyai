// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";
import type { NormalChatContinuationSnapshot } from "../normal-chat-model";

let directory: string,
	database: typeof import("../../db"),
	module: typeof import("./completion-lifetime");
const input = {
	userId: "u",
	conversationId: "c",
	requestId: "synthetic-request",
};
beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "task2b-lifetime-"));
	const path = join(directory, "scratch.sqlite");
	const sqlite = new Database(path);
	migrate(drizzle(sqlite), { migrationsFolder: "./drizzle" });
	sqlite.close();
	vi.resetModules();
	vi.stubEnv("DATABASE_PATH", path);
	database = await import("../../db");
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
	module = await import("./completion-lifetime");
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
it("keeps delayed message accounting pending until late registered usage settles once", async () => {
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
	life.capture(snapshot(life.scope, false));
	await life.finish("m");
	const analytics = await import("../analytics");
	await analytics.recordMessageAnalytics({
		userId: "u",
		conversationId: "c",
		messageId: "m",
		model: "provider:p1:m1",
		turnSegmentId: life.scope.segmentId,
	});
	expect(await analytics.getMessageUsageState("u", "c", "m")).toMatchObject({
		status: "pending",
	});
	life.capture(snapshot(life.scope, true));
	await life.finish("m");
	life.capture(snapshot(life.scope, true));
	await life.finish("m");
	expect(await analytics.getMessageUsageState("u", "c", "m")).toMatchObject({
		status: "ready",
		costUsd: 0.00014,
	});
	expect(database.db.select().from(schema.usageEvents).all()).toHaveLength(1);
});
it("observes an accepted ownerless resumed segment using its durable parent without generating", async () => {
	const life = module.beginCompletionLifetime({
		...input,
		turnId: "parent-turn",
	});
	await life.register(attempt);
	database.sqlite.close();
	vi.resetModules();
	module = await import("./completion-lifetime");
	database = await import("../../db");
	const interrupted = await module.observeCompletionTurn(input);
	expect(interrupted).toMatchObject({
		state: "terminal",
		assistantMessageId: null,
		completion: {
			turnId: "parent-turn",
			segmentId: life.scope.segmentId,
			outcome: "incomplete",
			stopCause: "uncertain_execution",
		},
	});
	const settled = database.db.select().from(schema.normalChatTurns).get();
	expect(settled?.attemptIdsJson).toBe('["a"]');
	expect(await module.observeCompletionTurn(input)).toEqual(interrupted);
	expect(
		database.db.select().from(schema.normalChatTurns).get()?.settledAt,
	).toEqual(settled?.settledAt);
	expect(() =>
		module.beginCompletionLifetime({ ...input, turnId: "parent-turn" }),
	).toThrow(/existing/i);
});

it("accepts priced final usage before a later terminal snapshot", async () => {
	const life = module.beginCompletionLifetime(input);
	await life.register(attempt);
	const before = snapshot(life.scope, true);
	delete before.completion;
	life.capture(before);
	life.capture(snapshot(life.scope, true));
	await expect(life.finish()).resolves.toBeUndefined();
	expect(
		database.db.select().from(schema.normalChatAttempts).get(),
	).toMatchObject({
		usageFinal: true,
		costUsdMicros: 140,
		outcome: null,
		safeStopCause: null,
	});
	expect(database.db.select().from(schema.normalChatTurns).get()).toMatchObject(
		{
			outcome: "answered",
			stopCause: "natural_stop",
		},
	);
	const conflictingUsage = snapshot(life.scope, true);
	conflictingUsage.usage[0].inputTokens = 101;
	life.capture(conflictingUsage);
	await expect(life.finish()).rejects.toMatchObject({
		code: "turn_ledger_conflict",
	});
});

it.each([
	false,
	true,
])("settles priced SDK calls with terminal facts separate from attempts (closing=%s)", async (closing) => {
	const { MockLanguageModelV3 } = await import("ai/test");
	const { runNormalChatCompletion } = await import(
		"../normal-chat-model/completion"
	);
	const life = module.beginCompletionLifetime(input);
	let generations = 0;
	const model = new MockLanguageModelV3({
		doGenerate: async () => {
			const truncated = closing && generations++ === 0;
			return {
				content: [
					{ type: "text" as const, text: truncated ? "Partial" : "Answer" },
				],
				finishReason: {
					unified: truncated ? ("length" as const) : ("stop" as const),
					raw: truncated ? "length" : "stop",
				},
				usage: {
					inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				},
				warnings: [],
				response: { id: "synthetic", timestamp: new Date(), modelId: "first" },
			};
		},
	});
	const provider = {
		id: "p1",
		name: "first",
		displayName: "First",
		baseUrl: "https://test.invalid",
		modelName: "first",
		apiKey: "synthetic",
		maxOutputTokens: 1000,
		maxModelContext: 32000,
	};
	const driver = runNormalChatCompletion(
		{
			provider,
			modelId: "provider:p1:m1",
			messages: [{ role: "user", content: "Synthetic request" }],
			completionPolicy: {
				...life.scope,
				deadlineAt: Date.now() + 10000,
				totalTimeoutMs: 10000,
				onSnapshot: life.capture,
				forAttempt: async (context) => {
					await life.register({
						attemptId: context.attemptId,
						phase: context.phase,
						providerId: context.provider.id,
						modelId: context.modelId,
						providerModelName: context.provider.modelName,
					});
					return {};
				},
			},
		},
		{
			model,
			maxModelContext: 32000,
			providerOptions: undefined,
			stopWhen: undefined,
			metadata: (name) => ({
				modelId: "provider:p1:m1",
				providerId: "p1",
				displayName: "First",
				requestedModelName: "first",
				responseModelName: name,
			}),
			mapUsage: () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
		},
		false,
	);
	for (;;) {
		const next = await driver.next();
		if (next.done) break;
	}
	await expect(life.finish()).resolves.toBeUndefined();
	const rows = database.db.select().from(schema.normalChatAttempts).all();
	expect(rows).toHaveLength(closing ? 2 : 1);
	expect(rows.map((row) => row.phase)).toEqual(
		closing ? ["working", "closing"] : ["working"],
	);
	for (const row of rows)
		expect(row).toMatchObject({
			usageFinal: true,
			costUsdMicros: 3,
			outcome: null,
			safeStopCause: null,
		});
	expect(database.db.select().from(schema.usageEvents).all()).toHaveLength(
		closing ? 2 : 1,
	);
	expect(database.db.select().from(schema.normalChatTurns).get()).toMatchObject(
		{
			outcome: "answered",
			stopCause: "natural_stop",
			workingStopCause: closing ? "length" : "natural_stop",
		},
	);
});

async function observeWire(requestId = input.requestId, userId = input.userId) {
	const { doReconnect } = await import("./stream-reconnect");
	const { decodeAiSdkUiStreamPayloads, extractAiSdkUiStreamMetadataData } =
		await import("$lib/services/ai-sdk-ui-stream-contract");
	const chunks: string[] = [];
	const subscribe = vi.fn(() => false);
	const close = vi.fn();
	await doReconnect(requestId, {
		userId,
		conversationId: input.conversationId,
		enqueueChunk: (chunk) => {
			chunks.push(chunk);
			return true;
		},
		closeDownstream: close,
		downstreamAbortSignal: new AbortController().signal,
		getStreamBuffer: () => undefined,
		subscribeToStream: subscribe,
		unsubscribeFromStream: vi.fn(),
		createSsePreludeComment: () => ": prelude\n\n",
		createSseHeartbeatComment: () => ": heartbeat\n\n",
	});
	const metadata = decodeAiSdkUiStreamPayloads(chunks.join(""))
		.map(extractAiSdkUiStreamMetadataData)
		.find(Boolean);
	expect(subscribe).not.toHaveBeenCalled();
	expect(close).toHaveBeenCalledOnce();
	return { chunks: chunks.join(""), observation: metadata?.observation };
}

it("returns an abandoned unsaved ledger terminal over the observer wire after restart", async () => {
	const life = module.beginCompletionLifetime({ ...input, turnId: "parent" });
	await life.register(attempt);
	database.sqlite.close();
	vi.resetModules();
	module = await import("./completion-lifetime");
	database = await import("../../db");
	const result = await observeWire();
	expect(result.observation).toMatchObject({
		version: 1,
		streamId: input.requestId,
		conversationId: "c",
		state: "terminal",
		assistantMessageId: null,
		completion: {
			turnId: "parent",
			segmentId: life.scope.segmentId,
			outcome: "incomplete",
			stopCause: "uncertain_execution",
		},
	});
	expect(result.chunks).not.toContain("data-waiting");
	expect(result.chunks).toContain('"type":"finish"');
	expect(result.chunks).toContain("[DONE]");
});

it.each([
	false,
	true,
])("observes a settled turn with its actual saved reference (saved=%s)", async (saved) => {
	const life = module.beginCompletionLifetime(input);
	await life.register(attempt);
	if (saved)
		database.db
			.insert(schema.messages)
			.values({
				id: "saved",
				conversationId: "c",
				role: "assistant",
				content: "Canonical",
			})
			.run();
	life.capture(snapshot(life.scope, false));
	await life.finish(saved ? "saved" : undefined);
	const result = await observeWire();
	expect(result.observation).toMatchObject({
		state: "terminal",
		assistantMessageId: saved ? "saved" : null,
		completion: { outcome: "answered", stopCause: "natural_stop" },
	});
	expect(result.chunks).not.toContain("data-waiting");
	if (saved) {
		database.db.delete(schema.messages).run();
		expect((await observeWire()).observation).toMatchObject({
			state: "terminal",
			assistantMessageId: null,
		});
	}
});

it("observes an admitted live pending owner without sealing it or promising a saved row", async () => {
	const life = module.beginCompletionLifetime(input);
	const result = await observeWire();
	expect(result.observation).toMatchObject({
		state: "pending",
		turnId: life.scope.turnId,
		segmentId: life.scope.segmentId,
	});
	expect(result.chunks).toContain("data-waiting");
	expect(result.chunks).not.toContain('"type":"finish"');
	expect(
		database.db.select().from(schema.normalChatTurns).get()?.outcome,
	).toBeNull();
	await life.finish();
});

it("does not expose another user's terminal completion or saved reference", async () => {
	const life = module.beginCompletionLifetime(input);
	await life.finish();
	const result = await observeWire(input.requestId, "another-user");
	expect(result.observation).toEqual({
		version: 1,
		streamId: input.requestId,
		conversationId: "c",
		state: "unavailable",
	});
	expect(result.chunks).not.toContain(life.scope.segmentId);
	expect(result.chunks).not.toContain("data-waiting");
});

it("keeps a scoped live registry lifetime pending even before durable admission", async () => {
	const registry = await import("./active-streams");
	registry.registerActiveChatStream({
		streamId: input.requestId,
		userId: input.userId,
		conversationId: input.conversationId,
		controller: new AbortController(),
	});
	try {
		const result = await observeWire();
		expect(result.observation).toMatchObject({
			state: "pending",
			conversationId: "c",
			streamId: input.requestId,
		});
		expect(result.chunks).toContain("data-waiting");
		expect(
			database.db.select().from(schema.normalChatTurns).all(),
		).toHaveLength(0);
	} finally {
		registry.unregisterActiveChatStream(input.requestId);
	}
});
