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

async function observeWire(requestId = input.requestId, userId = input.userId) {
	const { doReconnect } = await import("./stream-reconnect");
	const { decodeAiSdkUiStreamPayloads, extractAiSdkUiStreamMetadataData } =
		await import("$lib/services/ai-sdk-ui-stream-contract");
	const chunks: string[] = [];
	await doReconnect(requestId, {
		userId,
		conversationId: input.conversationId,
		enqueueChunk: (chunk) => {
			chunks.push(chunk);
			return true;
		},
		closeDownstream: vi.fn(),
		downstreamAbortSignal: new AbortController().signal,
		getStreamBuffer: () => undefined, // terminal paths clear the buffer
		subscribeToStream: vi.fn(() => false),
		unsubscribeFromStream: vi.fn(),
		createSsePreludeComment: () => ": prelude\n\n",
		createSseHeartbeatComment: () => ": heartbeat\n\n",
	});
	const metadata = decodeAiSdkUiStreamPayloads(chunks.join(""))
		.map(extractAiSdkUiStreamMetadataData)
		.find(Boolean);
	return { chunks: chunks.join(""), observation: metadata?.observation };
}

// Reviewer B reproducer: the model answered, finalization then failed to save the
// assistant row (strict mode), the live wire got backend_failure, and the
// orchestrator's finally (stream-orchestrator.ts:1280) plus the prepared generator's
// finally settle the lifetime with no message. A reconnecting observer must not be
// told the turn ended cleanly.
it("REVIEW-B: an answered turn whose assistant row could not be saved is not observed as a clean answered terminal", async () => {
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
	vi.doMock("../messages", async (importOriginal) => {
		const actual = await importOriginal<typeof import("../messages")>();
		return {
			...actual,
			createMessage: vi.fn(
				async (...args: Parameters<typeof actual.createMessage>) => {
					if (args[1] === "assistant")
						throw new Error("disk I/O error (synthetic)");
					return actual.createMessage(...args);
				},
			),
		};
	});
	const life = module.beginCompletionLifetime(input);
	await life.register(attempt);
	life.capture(snapshot(life.scope, true)); // model settled: answered / natural_stop
	const { finalizeChatTurn } = await import("./finalize");
	await expect(
		finalizeChatTurn({
			turnKind: "stream",
			responseLanguage: "en",
			userId: "u",
			conversationId: "c",
			streamId: input.requestId,
			persistUserMessage: false,
			userMessageContent: "Question",
			normalizedMessage: "Question",
			upstreamMessage: "Question",
			assistantResponse: "Answer that was never saved",
			assistantMetadata: {},
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: null,
			assistantMirrorContent: "Answer that was never saved",
			maintenanceReason: "chat_stream",
			completionTurn: {
				segmentId: life.scope.segmentId,
				getSnapshot: life.getSnapshot,
				finish: life.finish,
			},
		}),
	).rejects.toThrow(/disk I\/O error/);
	// What the orchestrator's finally does after the failed finalization.
	await life.finish();
	expect(database.db.select().from(schema.messages).all()).toHaveLength(0);

	const wire = await observeWire();
	expect(wire.observation).toMatchObject({
		state: "terminal",
		assistantMessageId: null,
		completion: { outcome: "failed" },
		modelCompletion: { outcome: "answered" },
	});
	// The client resolves `state: terminal` with a null assistantMessageId as a
	// settled turn (normal-chat-client-turn-runtime.ts:2083-2085) and, for an
	// answered completion, drains queued turns (…:2166-2171) with no error.
	expect(
		wire.observation?.state === "terminal" &&
			wire.observation?.assistantMessageId === null &&
			(wire.observation?.completion as { outcome?: string } | undefined)
				?.outcome === "answered",
	).toBe(false);
	vi.doUnmock("../messages");
	vi.doUnmock("./finalize-steps");
});
