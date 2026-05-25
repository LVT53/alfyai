import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

const mocks = vi.hoisted(() => ({
	sendMessage: vi.fn(),
}));

vi.mock("./langflow", () => ({
	sendMessage: mocks.sendMessage,
}));

vi.mock("./knowledge", () => ({
	listMessageAttachments: vi.fn(async () => new Map()),
}));

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

function seedConversationWithMessages() {
	const { sqlite, db } = openSeedDatabase();
	const now = new Date("2026-05-25T10:00:00.000Z");
	try {
		db.insert(schema.users)
			.values({
				id: "user-1",
				email: "context-compression@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(schema.conversations)
			.values({
				id: "conv-1",
				userId: "user-1",
				title: "Compression persistence",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(schema.messages)
			.values([
				{
					id: "message-1",
					conversationId: "conv-1",
					messageSequence: 1,
					role: "user",
					content: "First question",
					createdAt: now,
				},
				{
					id: "message-2",
					conversationId: "conv-1",
					messageSequence: 2,
					role: "assistant",
					content: "First answer",
					createdAt: new Date(now.getTime() + 1000),
				},
			])
			.run();
	} finally {
		sqlite.close();
	}
}

function seedConversationWithLegacyUnsequencedMessages() {
	const { sqlite, db } = openSeedDatabase();
	const now = new Date("2026-05-25T10:00:00.000Z");
	try {
		db.insert(schema.users)
			.values({
				id: "user-1",
				email: "context-compression-legacy@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(schema.conversations)
			.values({
				id: "conv-1",
				userId: "user-1",
				title: "Compression deletion cleanup",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(schema.messages)
			.values([
				{
					id: "message-1",
					conversationId: "conv-1",
					role: "user",
					content: "First question",
					createdAt: now,
				},
				{
					id: "message-2",
					conversationId: "conv-1",
					role: "assistant",
					content: "First answer",
					createdAt: new Date(now.getTime() + 1000),
				},
				{
					id: "message-3",
					conversationId: "conv-1",
					role: "user",
					content: "Follow-up question",
					createdAt: new Date(now.getTime() + 2000),
				},
				{
					id: "message-4",
					conversationId: "conv-1",
					role: "assistant",
					content: "Follow-up answer",
					createdAt: new Date(now.getTime() + 3000),
				},
			])
			.run();
	} finally {
		sqlite.close();
	}
}

describe("context compression snapshots", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-context-compression-${Date.now()}-${Math.random()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		mocks.sendMessage.mockReset();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("persists snapshots separately from raw chat messages", async () => {
		seedConversationWithMessages();
		const {
			createContextCompressionSnapshot,
			listContextCompressionSnapshots,
		} = await import("./context-compression");

		const created = await createContextCompressionSnapshot({
			conversationId: "conv-1",
			userId: "user-1",
			trigger: "manual",
			status: "valid",
			modelId: "model1",
			sourceStartMessageId: "message-1",
			sourceEndMessageId: "message-2",
			sourceStartMessageSequence: 1,
			sourceEndMessageSequence: 2,
			snapshot: {
				currentGoal: "Answer the original question",
				openQuestions: [],
			},
			sourceCoverage: {
				messageIds: ["message-1", "message-2"],
			},
			sourceRefs: [
				{ kind: "message_range", start: "message-1", end: "message-2" },
			],
			estimatedTokens: 42,
			sourceTokenEstimate: 210,
		});

		const snapshots = await listContextCompressionSnapshots("conv-1");

		expect(snapshots).toEqual([
			expect.objectContaining({
				id: created.id,
				conversationId: "conv-1",
				userId: "user-1",
				trigger: "manual",
				status: "valid",
				modelId: "model1",
				sourceStartMessageId: "message-1",
				sourceEndMessageId: "message-2",
				sourceStartMessageSequence: 1,
				sourceEndMessageSequence: 2,
				snapshot: {
					currentGoal: "Answer the original question",
					openQuestions: [],
				},
				sourceCoverage: {
					messageIds: ["message-1", "message-2"],
				},
				sourceRefs: [
					{ kind: "message_range", start: "message-1", end: "message-2" },
				],
				estimatedTokens: 42,
				sourceTokenEstimate: 210,
				failureReason: null,
			}),
		]);

		const { sqlite, db } = openSeedDatabase();
		try {
			const [messageCount] = db
				.select({ value: count() })
				.from(schema.messages)
				.all();
			const [snapshotCount] = db
				.select({ value: count() })
				.from(schema.contextCompressionSnapshots)
				.where(eq(schema.contextCompressionSnapshots.conversationId, "conv-1"))
				.all();

			expect(messageCount?.value).toBe(2);
			expect(snapshotCount?.value).toBe(1);
		} finally {
			sqlite.close();
		}
	});

	it("deletes snapshots affected by deleted or earlier message history", async () => {
		seedConversationWithLegacyUnsequencedMessages();
		const {
			createContextCompressionSnapshot,
			listContextCompressionSnapshots,
		} = await import("./context-compression");
		const { deleteMessages } = await import("./messages");

		const preserved = await createContextCompressionSnapshot({
			conversationId: "conv-1",
			userId: "user-1",
			trigger: "manual",
			status: "valid",
			modelId: "model1",
			sourceStartMessageId: "message-1",
			sourceEndMessageId: "message-2",
			sourceStartMessageSequence: 1,
			sourceEndMessageSequence: 2,
			snapshot: { currentGoal: "First exchange only" },
			sourceCoverage: { messageIds: ["message-1", "message-2"] },
		});
		const invalidated = await createContextCompressionSnapshot({
			conversationId: "conv-1",
			userId: "user-1",
			trigger: "automatic",
			status: "valid",
			modelId: "model1",
			sourceStartMessageId: "message-1",
			sourceEndMessageId: "message-4",
			sourceStartMessageSequence: 1,
			sourceEndMessageSequence: 4,
			snapshot: { currentGoal: "Whole conversation" },
			sourceCoverage: {
				messageIds: ["message-1", "message-2", "message-3", "message-4"],
			},
		});

		await deleteMessages(["message-3"]);

		const remaining = await listContextCompressionSnapshots("conv-1");

		expect(remaining.map((snapshot) => snapshot.id)).toEqual([preserved.id]);
		expect(remaining.map((snapshot) => snapshot.id)).not.toContain(
			invalidated.id,
		);
	});

	it("updates running snapshots to a terminal lifecycle status", async () => {
		seedConversationWithMessages();
		const {
			createContextCompressionSnapshot,
			listContextCompressionSnapshots,
			updateContextCompressionSnapshotStatus,
		} = await import("./context-compression");

		const running = await createContextCompressionSnapshot({
			conversationId: "conv-1",
			userId: "user-1",
			trigger: "manual",
			modelId: "model1",
			sourceStartMessageId: "message-1",
			sourceEndMessageId: "message-2",
			sourceStartMessageSequence: 1,
			sourceEndMessageSequence: 2,
			sourceCoverage: { messageIds: ["message-1", "message-2"] },
		});

		const updated = await updateContextCompressionSnapshotStatus({
			id: running.id,
			status: "failed",
			failureReason: "Validator rejected missing source coverage.",
		});

		expect(updated).toEqual(
			expect.objectContaining({
				id: running.id,
				status: "failed",
				failureReason: "Validator rejected missing source coverage.",
			}),
		);
		expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(
			running.updatedAt.getTime(),
		);

		const [stored] = await listContextCompressionSnapshots("conv-1");
		expect(stored).toEqual(
			expect.objectContaining({
				id: running.id,
				status: "failed",
				failureReason: "Validator rejected missing source coverage.",
			}),
		);
	});

	it("deletes conversation-owned snapshots when a conversation is deleted", async () => {
		seedConversationWithMessages();
		const {
			createContextCompressionSnapshot,
			listContextCompressionSnapshots,
		} = await import("./context-compression");

		await createContextCompressionSnapshot({
			conversationId: "conv-1",
			userId: "user-1",
			trigger: "automatic",
			status: "valid",
			modelId: "model1",
			sourceStartMessageId: "message-1",
			sourceEndMessageId: "message-2",
			sourceStartMessageSequence: 1,
			sourceEndMessageSequence: 2,
			snapshot: { currentGoal: "Temporary snapshot" },
			sourceCoverage: { messageIds: ["message-1", "message-2"] },
		});

		const { sqlite, db } = openSeedDatabase();
		try {
			db.delete(schema.conversations)
				.where(eq(schema.conversations.id, "conv-1"))
				.run();
		} finally {
			sqlite.close();
		}

		await expect(listContextCompressionSnapshots("conv-1")).resolves.toEqual(
			[],
		);
	});

	it("runs context compression through the selected response model and persists a validated snapshot", async () => {
		seedConversationWithMessages();
		mocks.sendMessage.mockResolvedValueOnce({
			text: `<thinking>Reasoning may quote payload JSON like {"task":"context_compression"} before the final answer.</thinking>${JSON.stringify({
				goal: "Keep answering the user's original question.",
				currentState: "The assistant has answered the first exchange.",
				importantDecisions: ["Use the existing chat context compression boundary."],
				importantFacts: ["The conversation has one user turn and one assistant turn."],
				openTasks: ["Continue from the first answer when the user follows up."],
				openQuestions: [],
				toolUseAndEvidenceRefs: [
					{ kind: "source", label: "First exchange", messageIds: ["message-1", "message-2"] },
				],
				sourceCoverage: {
					messageIds: ["message-1", "message-2"],
					ranges: [{ startMessageId: "message-1", endMessageId: "message-2" }],
				},
			})}`,
			modelId: "model2",
			modelDisplayName: "Selected Model",
			rawResponse: {},
		});
		const {
			listContextCompressionSnapshots,
			runContextCompression,
		} = await import("./context-compression");

		const result = await runContextCompression({
			conversationId: "conv-1",
			userId: "user-1",
			trigger: "manual",
			selectedModelId: "model2",
			sourceMessages: [
				{
					id: "message-1",
					role: "user",
					content: "First question",
					messageSequence: 1,
				},
				{
					id: "message-2",
					role: "assistant",
					content: "First answer",
					messageSequence: 2,
				},
			],
			sourceTokenEstimate: 24,
			targetTokenEstimate: 12,
		});

		expect(result.status).toBe("valid");
		expect(result.modelId).toBe("model2");
		expect(result.snapshot).toMatchObject({
			goal: "Keep answering the user's original question.",
			currentState: "The assistant has answered the first exchange.",
		});
		expect(result.sourceCoverage).toMatchObject({
			messageIds: ["message-1", "message-2"],
		});
		expect(result.sourceRefs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "message_range",
					startMessageId: "message-1",
					endMessageId: "message-2",
				}),
			]),
		);
		expect(result.estimatedTokens).toBeGreaterThan(0);
		expect(result.sourceTokenEstimate).toBe(24);

		expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
		const call = mocks.sendMessage.mock.calls[0];
		expect(call?.[2]).toBe("model2");
		expect(call?.[3]).toBeUndefined();
		expect(call?.[4]).toMatchObject({
			skipHonchoContext: true,
			skipDefaultRuntimeGuidance: true,
			systemPromptOverride: expect.stringContaining("Context compression"),
			thinkingMode: "on",
		});
		expect(call?.[4]?.systemPromptAppendix).toBeUndefined();

		const [stored] = await listContextCompressionSnapshots("conv-1");
		expect(stored).toEqual(
			expect.objectContaining({
				id: result.id,
				status: "valid",
				modelId: "model2",
				failureReason: null,
			}),
		);
	});

	it("retries once with repair instructions when the model output is invalid", async () => {
		seedConversationWithMessages();
		mocks.sendMessage
			.mockResolvedValueOnce({
				text: JSON.stringify({
					goal: "Too little",
					currentState: "Missing coverage",
					importantDecisions: [],
					importantFacts: [],
					openTasks: [],
					openQuestions: [],
					toolUseAndEvidenceRefs: [],
					sourceCoverage: {
						messageIds: ["message-1"],
					},
				}),
				modelId: "model1",
				modelDisplayName: "Selected Model",
				rawResponse: {},
			})
			.mockResolvedValueOnce({
				text: JSON.stringify({
					goal: "Keep the discussion anchored to the first exchange.",
					currentState: "The repaired snapshot now covers both source messages.",
					importantDecisions: ["Use the repaired structured snapshot."],
					importantFacts: ["Both source messages are represented in coverage."],
					openTasks: ["Continue from the first exchange."],
					openQuestions: [],
					toolUseAndEvidenceRefs: [],
					sourceCoverage: {
						messageIds: ["message-1", "message-2"],
						ranges: [{ startMessageId: "message-1", endMessageId: "message-2" }],
					},
				}),
				modelId: "model1",
				modelDisplayName: "Selected Model",
				rawResponse: {},
			});
		const { runContextCompression } = await import("./context-compression");

		const result = await runContextCompression({
			conversationId: "conv-1",
			userId: "user-1",
			trigger: "automatic",
			selectedModelId: "model1",
			sourceMessages: [
				{
					id: "message-1",
					role: "user",
					content: "First question",
					messageSequence: 1,
				},
				{
					id: "message-2",
					role: "assistant",
					content: "First answer",
					messageSequence: 2,
				},
			],
		});

		expect(result.status).toBe("valid");
		expect(result.failureReason).toBeNull();
		expect(result.snapshot).toMatchObject({
			goal: "Keep the discussion anchored to the first exchange.",
		});
		expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
		expect(String(mocks.sendMessage.mock.calls[1]?.[0])).toContain(
			"Previous output was rejected",
		);
	});

	it("marks the running snapshot failed when validation still rejects the repair", async () => {
		seedConversationWithMessages();
		mocks.sendMessage
			.mockResolvedValueOnce({
				text: "not json",
				modelId: "model1",
				modelDisplayName: "Selected Model",
				rawResponse: {},
			})
			.mockResolvedValueOnce({
				text: JSON.stringify({
					goal: "This still leaks <thinking>private</thinking> text.",
					currentState: "The validator must reject leaked reasoning tags.",
					importantDecisions: ["Do not persist invalid snapshots."],
					importantFacts: ["The raw transcript remains untouched."],
					openTasks: ["Surface the compression failure."],
					openQuestions: [],
					toolUseAndEvidenceRefs: [],
					sourceCoverage: {
						messageIds: ["message-1", "message-2"],
					},
				}),
				modelId: "model1",
				modelDisplayName: "Selected Model",
				rawResponse: {},
			});
		const {
			listContextCompressionSnapshots,
			runContextCompression,
		} = await import("./context-compression");

		const result = await runContextCompression({
			conversationId: "conv-1",
			userId: "user-1",
			trigger: "automatic",
			selectedModelId: "model1",
			sourceMessages: [
				{
					id: "message-1",
					role: "user",
					content: "First question",
					messageSequence: 1,
				},
				{
					id: "message-2",
					role: "assistant",
					content: "First answer",
					messageSequence: 2,
				},
			],
		});

		expect(result.status).toBe("failed");
		expect(result.failureReason).toContain("<thinking>");
		expect(mocks.sendMessage).toHaveBeenCalledTimes(2);

		const [stored] = await listContextCompressionSnapshots("conv-1");
		expect(stored).toEqual(
			expect.objectContaining({
				id: result.id,
				status: "failed",
				failureReason: expect.stringContaining("<thinking>"),
			}),
		);
	});
});
