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
			itemId: item?.id ?? "",
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
				subjectId: item?.id ?? "",
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

	it("admits explicit durable memory-profile fact wrappers as about-you facts", async () => {
		const { getMemoryProfileReadModel, listMemoryReworkTelemetry } =
			await import("./index");
		const { intakePostTurnMemory } = await import("./intake");

		await expect(
			intakePostTurnMemory({
				userId: "user-1",
				conversationId: "conv-1",
				userMessage:
					"Please remember this as a durable Memory Profile fact: my live memory verification codeword is codex-live-memory-test.",
				userMessageId: "user-message-codeword",
			}),
		).resolves.toEqual(
			expect.objectContaining({
				status: "admitted",
				category: "about_you",
			}),
		);

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.categories[0]?.items).toEqual([
			expect.objectContaining({
				category: "about_you",
				statement:
					"My live memory verification codeword is codex-live-memory-test.",
				scope: { type: "global" },
			}),
		]);
		expect(profile.review.visibleItems).toEqual([]);
		const telemetry = await listMemoryReworkTelemetry({ userId: "user-1" });
		expect(telemetry).toEqual([
			expect.objectContaining({
				eventName: "memory_intake_admitted",
				category: "about_you",
				status: "admitted",
				metadata: expect.objectContaining({
					parserRule: "remember_that",
					userMessageId: "user-message-codeword",
				}),
			}),
		]);
		expect(JSON.stringify(telemetry)).not.toContain("codex-live-memory-test");
	});

	it("resolves bare remember-this commands from the prior user-authored chat context", async () => {
		const { sqlite, db } = openSeedDatabase();
		const now = new Date();
		db.insert(schema.conversations)
			.values({
				id: "conv-1",
				userId: "user-1",
				title: "Contextual memory chat",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		sqlite.close();

		const { createMessage, listMessages } = await import("../messages");
		const { getMemoryProfileReadModel, listMemoryReworkTelemetry } =
			await import("./index");
		const { intakePostTurnMemory } = await import("./intake");

		await createMessage(
			"conv-1",
			"user",
			"My live memory verification codeword is codex-contextual-memory.",
		);
		await createMessage(
			"conv-1",
			"assistant",
			"Thanks, I can use that in this conversation.",
		);
		const trigger = await createMessage("conv-1", "user", "Remember this.");
		const assistant = await createMessage(
			"conv-1",
			"assistant",
			"I will remember that.",
		);

		await expect(
			intakePostTurnMemory({
				userId: "user-1",
				conversationId: "conv-1",
				userMessage: "Remember this.",
				assistantMessage: "I will remember that.",
				userMessageId: trigger.id,
				assistantMessageId: assistant.id,
				recentMessages: await listMessages("conv-1"),
			}),
		).resolves.toEqual(
			expect.objectContaining({
				status: "admitted",
				category: "about_you",
			}),
		);

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.categories[0]?.items).toEqual([
			expect.objectContaining({
				category: "about_you",
				statement:
					"My live memory verification codeword is codex-contextual-memory.",
				scope: { type: "global" },
			}),
		]);
		expect(JSON.stringify(profile)).not.toContain("Remember this");
		expect(await listMemoryReworkTelemetry({ userId: "user-1" })).toEqual([
			expect.objectContaining({
				eventName: "memory_intake_admitted",
				category: "about_you",
				status: "admitted",
				metadata: expect.objectContaining({
					parserRule: "remember_this_context",
					userMessageId: trigger.id,
					assistantMessageId: assistant.id,
				}),
			}),
		]);
	});

	it("does not skip an unclassifiable nearest prior user message to admit older stale context", async () => {
		const { getMemoryProfileReadModel, listMemoryReworkTelemetry } =
			await import("./index");
		const { intakePostTurnMemory } = await import("./intake");

		await expect(
			intakePostTurnMemory({
				userId: "user-1",
				conversationId: "conv-1",
				userMessage: "Remember this.",
				userMessageId: "trigger-message",
				recentMessages: [
					{
						id: "old-memory-candidate",
						role: "user",
						content: "I prefer very concise answers.",
					},
					{
						id: "nearest-question",
						role: "user",
						content: "What is the capital of France?",
					},
					{
						id: "trigger-message",
						role: "user",
						content: "Remember this.",
					},
				],
			}),
		).resolves.toEqual({
			status: "deferred",
			reason: "explicit_memory_unclassified",
		});

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.categories.flatMap((group) => group.items)).toEqual([]);
		expect(await listMemoryReworkTelemetry({ userId: "user-1" })).toEqual([
			expect.objectContaining({
				eventName: "memory_intake_deferred",
				status: "deferred",
				reason: "explicit_memory_unclassified",
				metadata: expect.objectContaining({
					parserRule: "remember_this_context",
					userMessageId: "trigger-message",
				}),
			}),
		]);
	});

	it("strips assistant-style reply instructions from explicit memory facts", async () => {
		const { getMemoryProfileReadModel, listMemoryReworkTelemetry } =
			await import("./index");
		const { intakePostTurnMemory } = await import("./intake");

		await expect(
			intakePostTurnMemory({
				userId: "user-1",
				conversationId: "conv-1",
				userMessage:
					"Please remember this as a durable Memory Profile fact: my live memory verification codeword is codex-live-memory-clean. Reply with one short sentence confirming you will remember it.",
				userMessageId: "user-message-codeword-tail",
			}),
		).resolves.toEqual(
			expect.objectContaining({
				status: "admitted",
				category: "about_you",
			}),
		);

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.categories[0]?.items).toEqual([
			expect.objectContaining({
				category: "about_you",
				statement:
					"My live memory verification codeword is codex-live-memory-clean.",
				scope: { type: "global" },
			}),
		]);
		expect(JSON.stringify(profile)).not.toContain("Reply with");
		expect(profile.review.visibleItems).toEqual([]);
		const telemetry = await listMemoryReworkTelemetry({ userId: "user-1" });
		expect(telemetry).toEqual([
			expect.objectContaining({
				eventName: "memory_intake_admitted",
				category: "about_you",
				status: "admitted",
				metadata: expect.objectContaining({
					parserRule: "remember_that",
					userMessageId: "user-message-codeword-tail",
				}),
			}),
		]);
		expect(JSON.stringify(telemetry)).not.toContain("codex-live-memory-clean");
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

	it("admits stable first-party self-statements without an explicit remember command", async () => {
		const { getMemoryProfileReadModel, listMemoryReworkTelemetry } =
			await import("./index");
		const { intakePostTurnMemory } = await import("./intake");

		await expect(
			intakePostTurnMemory({
				userId: "user-1",
				conversationId: "conv-1",
				userMessage: "I live in Amsterdam.",
				assistantMessage: "Thanks for sharing.",
				userMessageId: "user-message-location",
				assistantMessageId: "assistant-message-location",
			}),
		).resolves.toEqual(
			expect.objectContaining({
				status: "admitted",
				category: "about_you",
			}),
		);

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.categories[0]?.items).toEqual([
			expect.objectContaining({
				category: "about_you",
				statement: "I live in Amsterdam.",
			}),
		]);
		expect(profile.review.visibleItems).toEqual([]);
		const telemetry = await listMemoryReworkTelemetry({ userId: "user-1" });
		expect(telemetry).toEqual([
			expect.objectContaining({
				eventName: "memory_intake_admitted",
				category: "about_you",
				status: "admitted",
				metadata: expect.objectContaining({
					parserRule: "direct_user_self_statement",
					userMessageId: "user-message-location",
				}),
			}),
		]);
		expect(JSON.stringify(telemetry)).not.toContain("Amsterdam");
	});

	it("scopes ongoing-work intake to the current conversation instead of global profile memory", async () => {
		const {
			getActiveMemoryProfileContext,
			getMemoryProfileReadModel,
			listPendingMemoryDirtyEntries,
		} = await import("./index");
		const { intakePostTurnMemory } = await import("./intake");

		await expect(
			intakePostTurnMemory({
				userId: "user-1",
				conversationId: "conv-1",
				userMessage: "I am working on the onboarding rewrite.",
				userMessageId: "user-message-working",
			}),
		).resolves.toEqual(
			expect.objectContaining({
				status: "admitted",
				category: "goals_ongoing_work",
			}),
		);

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		const goals = profile.categories.find(
			(group) => group.category === "goals_ongoing_work",
		);
		expect(goals?.items).toEqual([
			expect.objectContaining({
				statement: "Working on the onboarding rewrite.",
				scope: { type: "conversation", id: "conv-1" },
			}),
		]);

		await expect(
			getActiveMemoryProfileContext({ userId: "user-1" }),
		).resolves.toMatchObject({ items: [] });
		await expect(
			getActiveMemoryProfileContext({
				userId: "user-1",
				applicableScopes: [{ type: "conversation", id: "conv-1" }],
			}),
		).resolves.toMatchObject({
			items: [
				expect.objectContaining({
					statement: "Working on the onboarding rewrite.",
					scope: { type: "conversation", id: "conv-1" },
				}),
			],
		});

		await expect(
			listPendingMemoryDirtyEntries({ userId: "user-1" }),
		).resolves.toEqual([
			expect.objectContaining({
				reason: "honcho_reconciliation",
				scope: { type: "conversation", id: "conv-1" },
				metadata: expect.objectContaining({
					intakeStatus: "admitted",
					userMessageId: "user-message-working",
				}),
			}),
		]);
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
		expect(profile.review.visibleItems).toEqual([]);

		const dirty = await listPendingMemoryDirtyEntries({ userId: "user-1" });
		expect(dirty).toEqual([
			expect.objectContaining({
				reason: "deferred_intake",
				metadata: expect.objectContaining({
					intakeStatus: "deferred",
					userMessageId: "user-message-2",
				}),
			}),
		]);
		const serializedDirty = JSON.stringify(dirty);
		expect(serializedDirty).not.toContain("tax return");
		expect(serializedDirty).not.toContain("1200");
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

	it("defers first-person tax paper, receipt, and uploaded PDF source claims without review items", async () => {
		const {
			getMemoryProfileReadModel,
			listMemoryReworkTelemetry,
			listPendingMemoryDirtyEntries,
		} = await import("./index");
		const { intakePostTurnMemory } = await import("./intake");
		const sourceClaims = [
			{
				id: "tax-papers",
				message:
					"Please remember that my tax papers show a deductible office expense.",
				forbidden: "deductible office expense",
			},
			{
				id: "receipts",
				message:
					"Please remember that my receipts are for the cycling equipment.",
				forbidden: "cycling equipment",
			},
			{
				id: "uploaded-pdf",
				message:
					"Please remember that my uploaded PDF contains the signed lease.",
				forbidden: "signed lease",
			},
		];

		for (const claim of sourceClaims) {
			await expect(
				intakePostTurnMemory({
					userId: "user-1",
					conversationId: "conv-1",
					userMessage: claim.message,
					userMessageId: `user-message-${claim.id}`,
				}),
			).resolves.toEqual(
				expect.objectContaining({
					status: "deferred",
					reason: "document_related_claim",
				}),
			);
		}

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.categories.flatMap((group) => group.items)).toEqual([]);
		expect(profile.review.visibleItems).toEqual([]);
		const dirty = await listPendingMemoryDirtyEntries({ userId: "user-1" });
		expect(dirty).toEqual([
			expect.objectContaining({
				reason: "deferred_intake",
				count: sourceClaims.length,
				metadata: expect.objectContaining({
					intakeStatus: "deferred",
					userMessageId: "user-message-uploaded-pdf",
				}),
			}),
		]);
		const serializedDirty = JSON.stringify(dirty);
		for (const claim of sourceClaims) {
			expect(serializedDirty).not.toContain(claim.forbidden);
		}
		const serializedTelemetry = JSON.stringify(
			await listMemoryReworkTelemetry({ userId: "user-1" }),
		);
		for (const claim of sourceClaims) {
			expect(serializedTelemetry).not.toContain(claim.forbidden);
		}
	});

	it("rejects attached-document chat wording without explicit durable intent", async () => {
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
					"I attached the vendor contract PDF for context; it says renewal notice is due by 30 June.",
				assistantMessage: "I will use it as context for this chat.",
				userMessageId: "user-message-attached-contract",
				assistantMessageId: "assistant-message-attached-contract",
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
		const telemetry = await listMemoryReworkTelemetry({ userId: "user-1" });
		expect(telemetry).toEqual([
			expect.objectContaining({
				eventFamily: "intake",
				eventName: "memory_intake_rejected",
				status: "rejected",
				reason: "no_explicit_durable_intent",
				metadata: expect.objectContaining({
					userMessageId: "user-message-attached-contract",
				}),
			}),
		]);
		expect(JSON.stringify(telemetry)).not.toContain("vendor contract");
		expect(JSON.stringify(telemetry)).not.toContain("30 June");
	});

	it("admits clear durable document-format preferences instead of treating them as source claims", async () => {
		const { getMemoryProfileReadModel } = await import("./index");
		const { intakePostTurnMemory } = await import("./intake");

		await expect(
			intakePostTurnMemory({
				userId: "user-1",
				conversationId: "conv-1",
				userMessage: "Please remember that I prefer PDF invoices.",
				userMessageId: "user-message-pdf-invoices",
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
				statement: "Prefers PDF invoices.",
			}),
		]);
		expect(profile.review.visibleItems).toEqual([]);
	});

	it("defers explicit document-family workflow wording when no document family id is available", async () => {
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
				userMessage: "For this document family, always use UK spelling.",
				userMessageId: "user-message-document-family-uk-spelling",
			}),
		).resolves.toEqual({
			status: "deferred",
			reason: "explicit_memory_unclassified",
		});

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.categories.flatMap((group) => group.items)).toEqual([]);
		expect(profile.review.visibleItems).toEqual([]);
		const dirty = await listPendingMemoryDirtyEntries({ userId: "user-1" });
		expect(dirty).toEqual([
			expect.objectContaining({
				reason: "deferred_intake",
				scope: { type: "conversation", id: "conv-1" },
				metadata: expect.objectContaining({
					intakeStatus: "deferred",
					userMessageId: "user-message-document-family-uk-spelling",
				}),
			}),
		]);
		const telemetry = await listMemoryReworkTelemetry({ userId: "user-1" });
		expect(telemetry).toEqual([
			expect.objectContaining({
				eventName: "memory_intake_deferred",
				status: "deferred",
				reason: "explicit_memory_unclassified",
				metadata: expect.objectContaining({
					parserRule: "document_family_workflow",
					userMessageId: "user-message-document-family-uk-spelling",
				}),
			}),
		]);
		expect(JSON.stringify(dirty)).not.toContain("UK spelling");
		expect(JSON.stringify(telemetry)).not.toContain("UK spelling");
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

	it("coalesces admitted dirty work without losing item or message identifiers", async () => {
		const { listPendingMemoryDirtyEntries } = await import("./index");
		const { intakePostTurnMemory } = await import("./intake");

		const first = await intakePostTurnMemory({
			userId: "user-1",
			conversationId: "conv-1",
			userMessage: "Please remember that I prefer concise answers.",
			userMessageId: "user-message-first",
			assistantMessageId: "assistant-message-first",
		});
		const second = await intakePostTurnMemory({
			userId: "user-1",
			conversationId: "conv-1",
			userMessage: "Please remember that I prefer PDF invoices.",
			userMessageId: "user-message-second",
			assistantMessageId: "assistant-message-second",
		});
		expect(first.status).toBe("admitted");
		expect(second.status).toBe("admitted");

		const dirty = await listPendingMemoryDirtyEntries({ userId: "user-1" });
		expect(dirty).toEqual([
			expect.objectContaining({
				reason: "honcho_reconciliation",
				count: 2,
				metadata: expect.objectContaining({
					itemIds: [
						first.status === "admitted" ? first.itemId : "",
						second.status === "admitted" ? second.itemId : "",
					],
					userMessageIds: ["user-message-first", "user-message-second"],
					assistantMessageIds: [
						"assistant-message-first",
						"assistant-message-second",
					],
				}),
			}),
		]);
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

	it("rejects one-off response style instructions instead of storing global constraints", async () => {
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
				userMessage: "Don't use bullet points in this answer.",
				assistantMessage: "Understood.",
				userMessageId: "user-message-one-off-style",
				assistantMessageId: "assistant-message-one-off-style",
			}),
		).resolves.toEqual({
			status: "rejected",
			reason: "one_off_instruction",
		});
		await expect(
			intakePostTurnMemory({
				userId: "user-1",
				conversationId: "conv-1",
				userMessage: "Do not be formal for this reply.",
				assistantMessage: "Got it.",
				userMessageId: "user-message-one-off-tone",
				assistantMessageId: "assistant-message-one-off-tone",
			}),
		).resolves.toEqual({
			status: "rejected",
			reason: "one_off_instruction",
		});

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.categories.flatMap((group) => group.items)).toEqual([]);
		expect(profile.review.visibleItems).toEqual([]);
		expect(await listPendingMemoryDirtyEntries({ userId: "user-1" })).toEqual(
			[],
		);
		const telemetry = await listMemoryReworkTelemetry({ userId: "user-1" });
		expect(telemetry).toEqual([
			expect.objectContaining({
				eventFamily: "intake",
				eventName: "memory_intake_rejected",
				status: "rejected",
				reason: "one_off_instruction",
				metadata: expect.objectContaining({
					userMessageId: "user-message-one-off-style",
				}),
			}),
			expect.objectContaining({
				eventFamily: "intake",
				eventName: "memory_intake_rejected",
				status: "rejected",
				reason: "one_off_instruction",
				metadata: expect.objectContaining({
					userMessageId: "user-message-one-off-tone",
				}),
			}),
		]);
		expect(JSON.stringify(telemetry)).not.toContain("bullet points");
		expect(JSON.stringify(telemetry)).not.toContain("formal");
	});

	it("rejects bare response style constraints without durable language", async () => {
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
				userMessage: "Don't use bullet points.",
				userMessageId: "user-message-bare-style",
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
				eventName: "memory_intake_rejected",
				status: "rejected",
				reason: "no_explicit_durable_intent",
			}),
		]);
	});

	it("admits strongly phrased durable response constraints", async () => {
		const { getMemoryProfileReadModel, listMemoryReworkTelemetry } =
			await import("./index");
		const { intakePostTurnMemory } = await import("./intake");

		await expect(
			intakePostTurnMemory({
				userId: "user-1",
				conversationId: "conv-1",
				userMessage: "Always avoid bullet points in responses.",
				userMessageId: "user-message-durable-style",
			}),
		).resolves.toEqual(
			expect.objectContaining({
				status: "admitted",
				category: "constraints_boundaries",
			}),
		);

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		const constraints = profile.categories.find(
			(group) => group.category === "constraints_boundaries",
		);
		expect(constraints?.items).toEqual([
			expect.objectContaining({
				category: "constraints_boundaries",
				statement: "Always avoid bullet points in responses.",
			}),
		]);
		expect(await listMemoryReworkTelemetry({ userId: "user-1" })).toEqual([
			expect.objectContaining({
				eventName: "memory_intake_admitted",
				category: "constraints_boundaries",
				status: "admitted",
				metadata: expect.objectContaining({
					parserRule: "direct_user_self_statement",
					userMessageId: "user-message-durable-style",
				}),
			}),
		]);
	});

	it("admits remembered never-want instructions as durable constraints", async () => {
		const { getMemoryProfileReadModel, listMemoryReworkTelemetry } =
			await import("./index");
		const { intakePostTurnMemory } = await import("./intake");

		await expect(
			intakePostTurnMemory({
				userId: "user-1",
				conversationId: "conv-1",
				userMessage: "Remember that I never want bullet points.",
				userMessageId: "user-message-never-want-style",
			}),
		).resolves.toEqual(
			expect.objectContaining({
				status: "admitted",
				category: "constraints_boundaries",
			}),
		);

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		const constraints = profile.categories.find(
			(group) => group.category === "constraints_boundaries",
		);
		expect(constraints?.items).toEqual([
			expect.objectContaining({
				category: "constraints_boundaries",
				statement: "Never want bullet points.",
			}),
		]);
		expect(await listMemoryReworkTelemetry({ userId: "user-1" })).toEqual([
			expect.objectContaining({
				eventName: "memory_intake_admitted",
				category: "constraints_boundaries",
				status: "admitted",
				metadata: expect.objectContaining({
					parserRule: "remember_that",
					userMessageId: "user-message-never-want-style",
				}),
			}),
		]);
	});
});
