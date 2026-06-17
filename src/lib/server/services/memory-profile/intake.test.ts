import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

describe("memory intake gate", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-memory-intake-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();

		const { sqlite, db } = openSeedDatabase();
		db.insert(schema.users)
			.values({
				id: "user-1",
				email: "memory-intake@example.com",
				passwordHash: "hash",
				name: "Memory Intake User",
			})
			.run();
		sqlite.close();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported in a failed test.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("admits an explicit user-authored preference with provenance and reconciliation work", async () => {
		const {
			getMemoryProfileItemDetail,
			getMemoryProfileReadModel,
			listMemoryReworkTelemetry,
			listPendingMemoryDirtyEntries,
		} = await import("./index");
		const { intakePostTurnMemory } = await import("./intake");

		await expect(
			intakePostTurnMemory({
				userId: "user-1",
				conversationId: "conv-1",
				userMessage: "Please remember that I prefer concise technical answers.",
				assistantMessage: "I will keep that in mind.",
				userMessageId: "user-message-1",
				assistantMessageId: "assistant-message-1",
			}),
		).resolves.toEqual(
			expect.objectContaining({
				status: "admitted",
				category: "preferences",
			}),
		);

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.categories[1]?.items).toEqual([
			expect.objectContaining({
				category: "preferences",
				statement: "Prefers concise technical answers.",
			}),
		]);

		const item = profile.categories[1]?.items[0];
		expect(item).toBeDefined();
		const detail = await getMemoryProfileItemDetail({
			userId: "user-1",
			itemId: item!.id,
		});
		expect(detail?.sourceChips).toEqual([
			expect.objectContaining({
				sourceType: "chat_user_message",
				label: "Chat",
				summary: "User explicitly asked AlfyAI to remember this.",
			}),
		]);

		expect(await listPendingMemoryDirtyEntries({ userId: "user-1" })).toEqual([
			expect.objectContaining({
				reason: "honcho_reconciliation",
				metadata: expect.objectContaining({
					conversationId: "conv-1",
					userMessageId: "user-message-1",
					assistantMessageId: "assistant-message-1",
					intakeStatus: "admitted",
				}),
			}),
		]);
		const telemetry = await listMemoryReworkTelemetry({ userId: "user-1" });
		expect(telemetry).toEqual([
			expect.objectContaining({
				eventFamily: "intake",
				eventName: "memory_intake_admitted",
				category: "preferences",
				status: "admitted",
				subjectId: item!.id,
				metadata: expect.objectContaining({
					conversationId: "conv-1",
					userMessageId: "user-message-1",
					assistantMessageId: "assistant-message-1",
					parserRule: "remember_that",
				}),
			}),
		]);
		expect(JSON.stringify(telemetry)).not.toContain(
			"concise technical answers",
		);
	});

	it("discards old-generation intake output when memory is reset before durable apply", async () => {
		const {
			advanceMemoryResetGeneration,
			getCurrentMemoryResetGeneration,
			getMemoryProfileReadModel,
			listMemoryReworkTelemetry,
			listPendingMemoryDirtyEntries,
		} = await import("./index");
		const { intakePostTurnMemory } = await import("./intake");

		const startedResetGeneration =
			await getCurrentMemoryResetGeneration("user-1");
		await advanceMemoryResetGeneration("user-1");

		const intake = intakePostTurnMemory({
			userId: "user-1",
			conversationId: "conv-1",
			userMessage:
				"Please remember that I prefer detailed implementation notes.",
			userMessageId: "user-message-reset",
			startedResetGeneration,
		});

		await expect(intake).resolves.toEqual({
			status: "rejected",
			reason: "stale_reset_generation",
		});
		await expect(
			getMemoryProfileReadModel({ userId: "user-1" }),
		).resolves.toMatchObject({
			resetGeneration: 1,
			categories: expect.arrayContaining([
				expect.objectContaining({ items: [] }),
			]),
			review: expect.objectContaining({ items: [] }),
		});
		await expect(
			listPendingMemoryDirtyEntries({ userId: "user-1" }),
		).resolves.toEqual([]);
		await expect(
			listMemoryReworkTelemetry({ userId: "user-1" }),
		).resolves.toEqual([]);
	});

	it("defers explicit document-related claims instead of making them user profile truth", async () => {
		const {
			getMemoryProfileReadModel,
			listMemoryReworkTelemetry,
			listPendingMemoryDirtyEntries,
		} = await import("./index");
		const { intakePostTurnMemory } = await import("./intake");

		await expect(
			intakePostTurnMemory({
				userId: "user-1",
				conversationId: "conv-1",
				userMessage:
					"Remember that the uploaded tax return says the refund is 1200 euros.",
				assistantMessage: "Noted.",
				userMessageId: "user-message-2",
				assistantMessageId: "assistant-message-2",
			}),
		).resolves.toEqual(
			expect.objectContaining({
				status: "deferred",
				reason: "document_related_claim",
			}),
		);

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.categories.flatMap((group) => group.items)).toEqual([]);
		expect(profile.review.visibleItems).toEqual([
			expect.objectContaining({
				subject: "Document-related memory request",
				question: "Should AlfyAI remember this as part of the user profile?",
			}),
		]);

		expect(await listPendingMemoryDirtyEntries({ userId: "user-1" })).toEqual([
			expect.objectContaining({
				reason: "deferred_intake",
				metadata: expect.objectContaining({
					intakeStatus: "deferred",
					userMessageId: "user-message-2",
				}),
			}),
		]);
		const telemetry = await listMemoryReworkTelemetry({ userId: "user-1" });
		expect(telemetry).toEqual([
			expect.objectContaining({
				eventFamily: "intake",
				eventName: "memory_intake_deferred",
				status: "deferred",
				reason: "document_related_claim",
			}),
		]);
		const serializedTelemetry = JSON.stringify(telemetry);
		expect(serializedTelemetry).not.toContain("tax return");
		expect(serializedTelemetry).not.toContain("1200");
	});

	it("marks duplicate work when an admitted memory already exists", async () => {
		const {
			getMemoryProfileReadModel,
			listMemoryReworkTelemetry,
			listPendingMemoryDirtyEntries,
		} = await import("./index");
		const { intakePostTurnMemory } = await import("./intake");

		await intakePostTurnMemory({
			userId: "user-1",
			conversationId: "conv-1",
			userMessage: "Please remember that I prefer concise technical answers.",
			userMessageId: "user-message-1",
			assistantMessageId: "assistant-message-1",
		});

		await expect(
			intakePostTurnMemory({
				userId: "user-1",
				conversationId: "conv-1",
				userMessage: "Please remember that I prefer concise technical answers.",
				userMessageId: "user-message-2",
				assistantMessageId: "assistant-message-2",
			}),
		).resolves.toEqual(
			expect.objectContaining({
				status: "admitted",
				duplicate: true,
			}),
		);

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.categories[1]?.items).toHaveLength(1);
		expect(await listPendingMemoryDirtyEntries({ userId: "user-1" })).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					reason: "honcho_reconciliation",
					count: 2,
				}),
				expect.objectContaining({
					reason: "possible_duplicate",
					metadata: expect.objectContaining({
						intakeStatus: "admitted",
						userMessageId: "user-message-2",
					}),
				}),
			]),
		);
		expect(await listMemoryReworkTelemetry({ userId: "user-1" })).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventName: "memory_intake_admitted",
					reason: "possible_duplicate",
					status: "admitted",
				}),
			]),
		);
	});

	it("rejects normal chat and non-durable first-person prose without creating profile or review work", async () => {
		const {
			getMemoryProfileReadModel,
			listMemoryReworkTelemetry,
			listPendingMemoryDirtyEntries,
		} = await import("./index");
		const { intakePostTurnMemory } = await import("./intake");

		await expect(
			intakePostTurnMemory({
				userId: "user-1",
				conversationId: "conv-1",
				userMessage: "What is the capital of France?",
				assistantMessage: "Paris.",
				userMessageId: "user-message-3",
				assistantMessageId: "assistant-message-3",
			}),
		).resolves.toEqual({
			status: "rejected",
			reason: "no_explicit_durable_intent",
		});
		await expect(
			intakePostTurnMemory({
				userId: "user-1",
				conversationId: "conv-1",
				userMessage: "I think Paris is the capital of France.",
				assistantMessage: "Correct.",
				userMessageId: "user-message-4",
				assistantMessageId: "assistant-message-4",
			}),
		).resolves.toEqual({
			status: "rejected",
			reason: "no_explicit_durable_intent",
		});

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.categories.flatMap((group) => group.items)).toEqual([]);
		expect(profile.review.visibleItems).toEqual([]);
		expect(await listPendingMemoryDirtyEntries({ userId: "user-1" })).toEqual(
			[],
		);
		expect(await listMemoryReworkTelemetry({ userId: "user-1" })).toEqual([
			expect.objectContaining({
				eventFamily: "intake",
				eventName: "memory_intake_rejected",
				status: "rejected",
				reason: "no_explicit_durable_intent",
			}),
			expect.objectContaining({
				eventFamily: "intake",
				eventName: "memory_intake_rejected",
				status: "rejected",
				reason: "no_explicit_durable_intent",
			}),
		]);
	});
});
