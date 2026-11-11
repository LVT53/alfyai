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

it.each([
	{ step: "assignment", wasStopped: false, lateStop: false },
	{ step: "selection", wasStopped: false, lateStop: false },
	{ step: "file read", wasStopped: false, lateStop: false },
	{ step: "assignment", wasStopped: true, lateStop: false },
	{ step: "assignment", wasStopped: false, lateStop: true },
])("preserves model truth but exposes durable $step failure (stopped=$wasStopped) after saving", async ({
	step,
	wasStopped,
	lateStop,
}) => {
	vi.doMock("./finalize-steps", () => ({
		persistUserTurnAttachments: vi.fn(async () => undefined),
		persistAssistantTurnState: vi.fn(async () => ({
			activeWorkingSet: [],
			taskState: null,
			contextDebug: null,
		})),
		persistAssistantEvidence: vi.fn(async () => undefined),
		runPostTurnTasks: vi.fn(async () => undefined),
		recordAssistantTurnAnalytics: vi.fn(async () => undefined),
		nameConversationAfterTurn: vi.fn(),
	}));
	const life = module.beginCompletionLifetime(input);
	await life.register(attempt);
	const state = snapshot(life.scope, true);
	if (!state.completion) throw new Error("Fixture missing completion");
	state.events = [
		{
			version: 1,
			...life.scope,
			attemptId: "a",
			stepId: "step",
			phase: "working",
			sequence: 0,
			type: "completion",
			completion: state.completion,
		},
	];
	life.capture(state);
	await life.finish(); // The real model result has already sealed before finalization.
	const beforeAttempts = database.db
		.select()
		.from(schema.normalChatAttempts)
		.all();
	const { finalizeChatTurn } = await import("./finalize");
	const failure = new Error("association fault");
	let assignmentEntered = () => {};
	let rejectAssignment: (reason: unknown) => void = () => {};
	const entered = new Promise<void>((resolve) => {
		assignmentEntered = resolve;
	});
	const held = new Promise<void>((_resolve, reject) => {
		rejectAssignment = reject;
	});
	const completion = finalizeChatTurn({
		turnKind: "stream",
		responseLanguage: "en",
		userId: "u",
		conversationId: "c",
		streamId: input.requestId,
		persistUserMessage: false,
		userMessageContent: "Make file",
		normalizedMessage: "Make file",
		upstreamMessage: "Make file",
		assistantResponse: "Actual canonical answer",
		assistantMetadata: { wasStopped },
		attachmentIds: [],
		activeDocumentArtifactId: null,
		contextStatus: null,
		initialTaskState: null,
		initialContextDebug: null,
		analytics: null,
		assistantMirrorContent: "Actual canonical answer",
		maintenanceReason: "chat_stream",
		completionTurn: {
			segmentId: life.scope.segmentId,
			getSnapshot: life.getSnapshot,
			finish: life.finish,
		},
		generatedOutputReconciliation: {
			fileProductionToolCalls: [
				{
					name: "produce_file",
					input: {},
					status: "failed",
					metadata: { jobId: "new" },
				},
			],
			getFileProductionJobs: async () => {
				if (step === "selection") throw failure;
				return [{ id: "new", files: [] }];
			},
			assignFileProductionJobsToAssistantMessage: async () => {
				if (step === "assignment") {
					if (lateStop) {
						assignmentEntered();
						await held;
					} else throw failure;
				}
			},
			getChatFilesForAssistantMessage: async () => {
				if (step === "file read") throw failure;
				return [];
			},
		},
	});
	const rejected = expect(completion).rejects.toMatchObject({
		message: failure.message,
		cause: failure,
	});
	if (lateStop) {
		await entered;
		const { requestActiveChatStreamStop, registerActiveChatStream } =
			await import("./active-streams");
		registerActiveChatStream({
			streamId: input.requestId,
			userId: "u",
			conversationId: "c",
			controller: new AbortController(),
		});
		expect(await module.observeCompletionTurn(input)).toMatchObject({
			state: "pending",
		});
		requestActiveChatStreamStop({ streamId: input.requestId, userId: "u" });
		rejectAssignment(failure);
	}
	await rejected;
	const saved = database.db.select().from(schema.messages).get();
	expect(saved?.content).toBe("Actual canonical answer");
	if (!saved?.metadataJson) throw new Error("Missing saved assistant metadata");
	const marker = {
		version: 1,
		status: "failed",
		cause: "file_association_failed",
		wasStopped: wasStopped || lateStop,
	};
	expect(JSON.parse(saved.metadataJson).normalChatFinalization).toEqual(marker);
	expect(JSON.parse(saved.metadataJson).normalChatOutput.events).toEqual(
		state.events,
	);
	const messages = await import("../messages");
	expect((await messages.listMessages("c"))[0]).toMatchObject({
		id: saved.id,
		content: "Actual canonical answer",
		normalChatFinalization: marker,
	});
	const observed = await module.observeCompletionTurn(input);
	expect(observed).toMatchObject({
		state: "terminal",
		assistantMessageId: saved.id,
		normalChatFinalization: marker,
		modelCompletion: state.completion,
		completion: { outcome: wasStopped || lateStop ? "stopped" : "failed" },
	});
	const ledger = await import("./turn-ledger");
	ledger.recordFileAssociationFailure({
		mode: "tracked",
		...life.scope,
		messageId: saved.id,
		wasStopped,
	});
	await life.finish(saved.id); // Late ordinary finish must not erase failure or conflict.
	expect(await module.observeCompletionTurn(input)).toEqual(observed);
	expect(database.db.select().from(schema.normalChatTurns).get()).toMatchObject(
		{ outcome: "answered", messageId: saved.id, accountingStatus: "ready" },
	);
	expect(database.db.select().from(schema.normalChatAttempts).all()).toEqual(
		beforeAttempts,
	);
	const wire = await observeWire();
	expect(wire.observation).toEqual(observed);
	vi.doUnmock("./finalize-steps");
});

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
				providerName: provider.name,
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
			outcome: closing && row.phase === "working" ? "incomplete" : "answered",
			safeStopCause:
				closing && row.phase === "working" ? "length" : "natural_stop",
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
		completion: saved
			? { outcome: "answered", stopCause: "natural_stop" }
			: { outcome: "failed", stopCause: "uncertain_execution" },
		...(!saved ? { modelCompletion: { outcome: "answered" } } : {}),
	});
	expect(result.chunks).not.toContain("data-waiting");
	if (saved) {
		database.db.delete(schema.messages).run();
		expect((await observeWire()).observation).toMatchObject({
			state: "terminal",
			assistantMessageId: null,
			completion: { outcome: "failed" },
			modelCompletion: { outcome: "answered" },
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

it("records each attempt's terminal facts after priced usage without copying the closing result", async () => {
	const life = module.beginCompletionLifetime(input);
	const registration = {
		attemptId: "a",
		phase: "working" as const,
		providerId: "p1",
		modelId: "provider:p1:m1",
		providerModelName: "first",
	};
	await life.register(registration);
	const next = snapshot(life.scope, true);
	life.capture(next);
	await life.register({ ...registration, attemptId: "b", phase: "closing" });
	Object.assign(next.usage[0], {
		safeStopCause: "transport_error",
		outcome: "failed",
	});
	next.usage.push({
		...next.usage[0],
		attemptId: "b",
		phase: "closing",
		...{ safeStopCause: "natural_stop", outcome: "answered" },
	});
	next.completion = {
		version: 1,
		turnId: life.scope.turnId,
		segmentId: life.scope.segmentId,
		phase: "closing",
		outcome: "answered",
		stopCause: "natural_stop",
		workingStopCause: "transport_error",
		closingAttempted: true,
	};
	life.capture(next);
	await life.finish();
	const rows = database.db.select().from(schema.normalChatAttempts).all();
	expect(rows.find((r) => r.attemptId === "a")).toMatchObject({
		outcome: "failed",
		safeStopCause: "transport_error",
		usageFinal: true,
		inputTokens: 100,
		outputTokens: 20,
	});
	expect(rows.find((r) => r.attemptId === "b")).toMatchObject({
		outcome: "answered",
		safeStopCause: "natural_stop",
		usageFinal: true,
	});
	expect(rows.every((r) => r.costUsdMicros !== null)).toBe(true);
});

it("keeps absent legacy attempt facts unknown instead of inventing the segment result", async () => {
	const life = module.beginCompletionLifetime(input);
	await life.register({
		attemptId: "a",
		phase: "working",
		providerId: "p1",
		modelId: "provider:p1:m1",
		providerModelName: "first",
	});
	life.capture(snapshot(life.scope, true));
	await life.finish();
	expect(
		database.db.select().from(schema.normalChatAttempts).get(),
	).toMatchObject({ outcome: null, safeStopCause: null });
});

it("publishes the admission deadline before preparation and never extends it from a model snapshot", async () => {
	const deadlineAt = Date.now() + 5000;
	const life = module.beginCompletionLifetime({ ...input, ...{ deadlineAt } });
	expect(await module.observeCompletionTurn(input)).toMatchObject({
		state: "pending",
		deadlineAt,
	});
	const next = snapshot(life.scope, false);
	next.usage = [];
	delete next.completion;
	next.deadlineAt = deadlineAt + 10000;
	life.capture(next);
	expect(await module.observeCompletionTurn(input)).toMatchObject({
		state: "pending",
		deadlineAt,
	});
	next.deadlineAt = deadlineAt - 1000;
	life.capture(next);
	expect(await module.observeCompletionTurn(input)).toMatchObject({
		state: "pending",
		deadlineAt: deadlineAt - 1000,
	});
	await life.finish();
});
