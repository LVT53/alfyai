import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

const mocks = vi.hoisted(() => ({
	sendJsonControlMessage: vi.fn(),
}));

vi.mock("./langflow", () => ({
	sendJsonControlMessage: mocks.sendJsonControlMessage,
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
		mocks.sendJsonControlMessage.mockReset();
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
		mocks.sendJsonControlMessage.mockResolvedValueOnce({
			text: `<thinking>Reasoning may quote payload JSON like {"task":"context_compression"} before the final answer.</thinking>${JSON.stringify(
				{
					goal: "Keep answering the user's original question.",
					currentState: "The assistant has answered the first exchange.",
					importantDecisions: [
						"Use the existing chat context compression boundary.",
					],
					importantFacts: [
						"The conversation has one user turn and one assistant turn.",
					],
					openTasks: [
						"Continue from the first answer when the user follows up.",
					],
					openQuestions: [],
					toolUseAndEvidenceRefs: [
						{
							kind: "source",
							label: "First exchange",
							messageIds: ["message-1", "message-2"],
						},
					],
					sourceCoverage: {
						messageIds: ["message-1", "message-2"],
						ranges: [
							{ startMessageId: "message-1", endMessageId: "message-2" },
						],
					},
				},
			)}`,
			modelId: "model2",
			modelDisplayName: "Selected Model",
			rawResponse: {},
		});
		const { listContextCompressionSnapshots, runContextCompression } =
			await import("./context-compression");

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

		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(1);
		const call = mocks.sendJsonControlMessage.mock.calls[0];
		expect(call?.[1]).toBe("model2");
		expect(call?.[2]).toMatchObject({
			systemPrompt: expect.stringContaining("Context compression"),
			thinkingMode: "on",
			maxTokens: 4096,
			jsonSchema: expect.objectContaining({
				name: "context_compression_snapshot",
				strict: true,
			}),
			allowReasoningFallback: true,
		});

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

	it("accepts a meaningful compression snapshot when the model omits app-owned empty fields and source coverage", async () => {
		seedConversationWithMessages();
		mocks.sendJsonControlMessage.mockResolvedValue({
			text: JSON.stringify({
				goal: "Keep answering the user's original question from the first exchange.",
				currentState:
					"The assistant has answered the initial question and future turns should continue from that answer.",
				importantFacts: [
					"The covered source contains one user question and one assistant answer.",
				],
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
			importantDecisions: [],
			openTasks: [],
			openQuestions: [],
			toolUseAndEvidenceRefs: [],
			sourceCoverage: {
				messageIds: ["message-1", "message-2"],
				ranges: [{ startMessageId: "message-1", endMessageId: "message-2" }],
			},
		});
		expect(result.sourceCoverage).toMatchObject({
			messageIds: ["message-1", "message-2"],
			ranges: [{ startMessageId: "message-1", endMessageId: "message-2" }],
		});
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(1);
	});

	it("derives a missing goal from meaningful current-state summary content", async () => {
		seedConversationWithMessages();
		mocks.sendJsonControlMessage.mockResolvedValue({
			text: JSON.stringify({
				currentState:
					"The first exchange established that the user asked an initial question and the assistant answered it; future turns should preserve that exchange as compact continuity.",
				importantFacts: [
					"The covered source contains one user question and one assistant answer.",
				],
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
			goal: "The first exchange established that the user asked an initial question and the assistant answered it; future turns should preserve that exchange as compact continuity.",
			currentState:
				"The first exchange established that the user asked an initial question and the assistant answered it; future turns should preserve that exchange as compact continuity.",
			sourceCoverage: {
				messageIds: ["message-1", "message-2"],
			},
		});
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(1);
	});

	it("derives a blank current state from meaningful goal content", async () => {
		seedConversationWithMessages();
		mocks.sendJsonControlMessage.mockResolvedValue({
			text: JSON.stringify({
				goal: "Keep the compacted conversation focused on the first user question and the assistant answer so later turns can continue without replaying raw history.",
				currentState: "   ",
				importantDecisions: [
					"Use the context compression snapshot as the prompt continuity source.",
				],
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
			goal: "Keep the compacted conversation focused on the first user question and the assistant answer so later turns can continue without replaying raw history.",
			currentState:
				"Keep the compacted conversation focused on the first user question and the assistant answer so later turns can continue without replaying raw history.",
			sourceCoverage: {
				messageIds: ["message-1", "message-2"],
			},
		});
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(1);
	});

	it("repairs or filters malformed evidence refs without rejecting a meaningful snapshot", async () => {
		seedConversationWithMessages();
		mocks.sendJsonControlMessage.mockResolvedValue({
			text: JSON.stringify({
				goal: "Keep the first exchange available as compact context.",
				currentState:
					"The assistant has answered the initial question and the next turn should preserve that answer.",
				importantDecisions: [],
				importantFacts: [
					"The first assistant answer is useful evidence for follow-up turns.",
				],
				openTasks: ["Continue from the initial answer if the user follows up."],
				openQuestions: [],
				toolUseAndEvidenceRefs: [
					{
						label: "First exchange evidence",
						messageIds: ["message-1"],
					},
					{
						kind: "tool",
						detail: "The assistant used the first answer as source evidence.",
						messageIds: ["message-2"],
					},
					{},
				],
				sourceCoverage: {
					messageIds: ["message-1", "message-2"],
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
		expect(result.snapshot.toolUseAndEvidenceRefs).toEqual([
			{
				kind: "source",
				label: "First exchange evidence",
				messageIds: ["message-1"],
			},
			{
				kind: "tool",
				label: "The assistant used the first answer as source evidence.",
				messageIds: ["message-2"],
				detail: "The assistant used the first answer as source evidence.",
			},
		]);
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(1);
	});

	it("retries once with repair instructions when the model output is invalid", async () => {
		seedConversationWithMessages();
		mocks.sendJsonControlMessage
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
					currentState:
						"The repaired snapshot now covers both source messages.",
					importantDecisions: ["Use the repaired structured snapshot."],
					importantFacts: ["Both source messages are represented in coverage."],
					openTasks: ["Continue from the first exchange."],
					openQuestions: [],
					toolUseAndEvidenceRefs: [],
					sourceCoverage: {
						messageIds: ["message-1", "message-2"],
						ranges: [
							{ startMessageId: "message-1", endMessageId: "message-2" },
						],
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
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(2);
		expect(String(mocks.sendJsonControlMessage.mock.calls[1]?.[0])).toContain(
			"Previous output was rejected",
		);
	});

	it("rejects schema-template placeholder snapshots and retries with the repaired output", async () => {
		seedConversationWithMessages();
		mocks.sendJsonControlMessage
			.mockResolvedValueOnce({
				text: JSON.stringify({
					goal: "string",
					currentState: "string",
					importantDecisions: ["string"],
					importantFacts: ["string"],
					openTasks: ["string"],
					openQuestions: ["string"],
					toolUseAndEvidenceRefs: [
						{
							kind: "tool|evidence|source",
							label: "string",
							messageIds: ["message-id"],
							detail: "string",
						},
					],
					sourceCoverage: {
						messageIds: ["all covered source message ids"],
						ranges: [{ startMessageId: "id", endMessageId: "id" }],
					},
				}),
				modelId: "model1",
				modelDisplayName: "Selected Model",
				rawResponse: {},
			})
			.mockResolvedValueOnce({
				text: JSON.stringify({
					goal: "Keep the actual first exchange available after compression.",
					currentState:
						"The repaired snapshot summarizes the real user question and assistant answer.",
					importantDecisions: [
						"Use semantic validation to retry placeholder compression output.",
					],
					importantFacts: [
						"The covered source messages are message-1 and message-2.",
					],
					openTasks: ["Continue from the real first exchange."],
					openQuestions: [],
					toolUseAndEvidenceRefs: [
						{
							kind: "source",
							label: "First exchange",
							messageIds: ["message-1", "message-2"],
						},
					],
					sourceCoverage: {
						messageIds: ["message-1", "message-2"],
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
		expect(result.snapshot.goal).toBe(
			"Keep the actual first exchange available after compression.",
		);
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(2);
		expect(String(mocks.sendJsonControlMessage.mock.calls[1]?.[0])).toContain(
			"placeholder",
		);
	});

	it("rejects explicit source coverage that does not match the expected source messages", async () => {
		seedConversationWithMessages();
		mocks.sendJsonControlMessage
			.mockResolvedValueOnce({
				text: JSON.stringify({
					goal: "Keep the real first exchange available after compression.",
					currentState:
						"The snapshot text is meaningful but the model cited the wrong coverage ids.",
					importantDecisions: [
						"Retry snapshots that claim coverage outside the source window.",
					],
					importantFacts: [
						"The real source messages are message-1 and message-2.",
					],
					openTasks: ["Continue from the validated source window."],
					openQuestions: [],
					toolUseAndEvidenceRefs: [],
					sourceCoverage: {
						messageIds: ["message-1", "ghost-message"],
					},
				}),
				modelId: "model1",
				modelDisplayName: "Selected Model",
				rawResponse: {},
			})
			.mockResolvedValueOnce({
				text: JSON.stringify({
					goal: "Keep the real first exchange available after compression.",
					currentState:
						"The repaired snapshot cites exactly the expected source messages.",
					importantDecisions: [
						"Accept only coverage that matches the source window.",
					],
					importantFacts: [
						"The real source messages are message-1 and message-2.",
					],
					openTasks: ["Continue from the validated source window."],
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
		expect(result.snapshot.currentState).toBe(
			"The repaired snapshot cites exactly the expected source messages.",
		);
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(2);
		expect(String(mocks.sendJsonControlMessage.mock.calls[1]?.[0])).toContain(
			"source coverage",
		);
	});

	it("keeps retrying transient empty control outputs before marking compression failed", async () => {
		seedConversationWithMessages();
		mocks.sendJsonControlMessage
			.mockRejectedValueOnce(
				new Error("Could not extract message text from control model response"),
			)
			.mockRejectedValueOnce(
				new Error("Could not extract message text from control model response"),
			)
			.mockResolvedValueOnce({
				text: JSON.stringify({
					goal: "Keep the discussion anchored after transient empty outputs.",
					currentState: "The third structured response produced valid JSON.",
					importantDecisions: ["Retry context compression control output."],
					importantFacts: ["Both source messages are represented."],
					openTasks: ["Continue from the repaired compression snapshot."],
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
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(3);
		expect(String(mocks.sendJsonControlMessage.mock.calls[2]?.[0])).toContain(
			"Previous output was rejected",
		);
	});

	it("marks the running snapshot failed when validation still rejects the repair", async () => {
		seedConversationWithMessages();
		mocks.sendJsonControlMessage
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
			})
			.mockResolvedValue({
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
		const { listContextCompressionSnapshots, runContextCompression } =
			await import("./context-compression");

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
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(4);

		const [stored] = await listContextCompressionSnapshots("conv-1");
		expect(stored).toEqual(
			expect.objectContaining({
				id: result.id,
				status: "failed",
				failureReason: expect.stringContaining("<thinking>"),
			}),
		);
	});

	it("marks the running snapshot failed when the compression model call throws", async () => {
		seedConversationWithMessages();
		mocks.sendJsonControlMessage.mockRejectedValue(
			new Error("Langflow unavailable"),
		);
		const { listContextCompressionSnapshots, runContextCompression } =
			await import("./context-compression");

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
		expect(result.failureReason).toContain("Langflow unavailable");
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(4);

		const [stored] = await listContextCompressionSnapshots("conv-1");
		expect(stored).toEqual(
			expect.objectContaining({
				id: result.id,
				status: "failed",
				failureReason: expect.stringContaining("Langflow unavailable"),
			}),
		);
	});
});
