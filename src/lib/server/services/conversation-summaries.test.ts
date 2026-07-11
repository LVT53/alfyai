import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
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

describe("conversation summaries", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-conversation-summary-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
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

	it("upserts a compact summary after meaningful turn activity", async () => {
		const { sqlite, db } = openSeedDatabase();
		const now = new Date("2026-05-14T09:00:00.000Z");
		db.insert(schema.users)
			.values({
				id: "user-1",
				email: "summary@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(schema.conversations)
			.values({
				id: "conv-1",
				userId: "user-1",
				title: "Launch planning",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		sqlite.close();

		const { getConversationSummary, refreshConversationSummary } = await import(
			"./conversation-summaries"
		);

		const refreshed = await refreshConversationSummary({
			userId: "user-1",
			conversationId: "conv-1",
			userMessage:
				"We need to capture the durable launch planning decisions for the beta rollout.",
			assistantResponse:
				"The conversation established a beta launch plan focused on invite-only rollout, onboarding copy, analytics review, and a follow-up checklist for stakeholder approval.",
		});

		expect(refreshed).toEqual(
			expect.objectContaining({
				conversationId: "conv-1",
				userId: "user-1",
				source: "deterministic",
			}),
		);
		expect(refreshed?.summary).toContain("beta launch plan");
		expect(refreshed?.summary.length).toBeLessThanOrEqual(700);

		await refreshConversationSummary({
			userId: "user-1",
			conversationId: "conv-1",
			userMessage: "Add that analytics review is the first follow-up.",
			assistantResponse:
				"Updated: analytics review is the first follow-up before stakeholder approval.",
		});

		const stored = await getConversationSummary({
			userId: "user-1",
			conversationId: "conv-1",
		});

		expect(stored?.summary).toContain("analytics review");
		expect(stored?.summary).toContain("first follow-up");
	});

	it("returns null if the conversation was deleted before summary insert", async () => {
		const { sqlite, db } = openSeedDatabase();
		const now = new Date("2026-05-14T09:00:00.000Z");
		db.insert(schema.users)
			.values({
				id: "user-1",
				email: "summary@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		sqlite.close();

		const { refreshConversationSummary } = await import(
			"./conversation-summaries"
		);

		await expect(
			refreshConversationSummary({
				userId: "user-1",
				conversationId: "deleted-conv",
				userMessage:
					"This turn is long enough that the summary refresh would normally persist.",
				assistantResponse:
					"The assistant response is also long enough to exercise the insert path.",
			}),
		).resolves.toBeNull();
	});

	it("does not persist stale summary work after memory reset advances", async () => {
		const { sqlite, db } = openSeedDatabase();
		const now = new Date("2026-05-14T09:00:00.000Z");
		db.insert(schema.users)
			.values({
				id: "user-1",
				email: "summary@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(schema.conversations)
			.values({
				id: "conv-1",
				userId: "user-1",
				title: "Launch planning",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		sqlite.close();

		const { advanceMemoryResetGeneration, getCurrentMemoryResetGeneration } =
			await import("./memory-profile/reset-generation");
		const { getConversationSummary, refreshConversationSummary } = await import(
			"./conversation-summaries"
		);

		const startedResetGeneration =
			await getCurrentMemoryResetGeneration("user-1");
		await advanceMemoryResetGeneration("user-1");

		const refreshed = await refreshConversationSummary({
			userId: "user-1",
			conversationId: "conv-1",
			userMessage:
				"This summary refresh began before Clear Memory and Knowledge reset the user.",
			assistantResponse:
				"The stale refresh output must be discarded so cleared memory context is not rehydrated.",
			startedResetGeneration,
		});

		expect(refreshed).toBeNull();
		await expect(
			getConversationSummary({
				userId: "user-1",
				conversationId: "conv-1",
			}),
		).resolves.toBeNull();
	});

	it("includes stable facts or preferences instruction in the summary system prompt", () => {
		const source = readFileSync(
			"./src/lib/server/services/conversation-summaries.ts",
			"utf-8",
		);
		expect(source).toContain(
			"stable facts or preferences the user has expressed",
		);
	});
});
