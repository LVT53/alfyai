import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import type {
	BranchInfo,
	ParsedConversation,
	ParsedMessage,
	ParseEntryError,
} from "./parser";

type ImportOptions = {
	projectId?: string | null;
	onProgress?: (processed: number, total: number) => void;
};

type RunImportConversationsOptions = {
	userId?: string;
	zipName?: string;
	conversations?: ParsedConversation[];
	errors?: ParseEntryError[];
	parseError?: Error;
	importOptions?: ImportOptions;
};

export function createChatGptImportTestHarness(dbPath: string) {
	function openSeedDatabase() {
		const sqlite = new Database(dbPath);
		sqlite.pragma("foreign_keys = ON");
		const db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: "./drizzle" });
		return { sqlite, db };
	}

	function seedUser(userId = "test-user", email = "test@example.com") {
		const { sqlite, db } = openSeedDatabase();
		db.insert(schema.users)
			.values({
				id: userId,
				email,
				passwordHash: "hash",
			})
			.run();
		sqlite.close();
	}

	function seedProject(userId: string, projectId: string, name: string) {
		const { sqlite, db } = openSeedDatabase();
		db.insert(schema.projects)
			.values({
				id: projectId,
				userId,
				name,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();
		sqlite.close();
	}

	/** An `import_jobs` row as an earlier import (or a stopped one) left it. */
	function seedImportJob(row: {
		id: string;
		userId?: string;
		status: string;
		updatedAt?: Date;
		totalConversations?: number;
		processedConversations?: number;
		errorLog?: string | null;
	}) {
		const { sqlite, db } = openSeedDatabase();
		const updatedAt = row.updatedAt ?? new Date();
		db.insert(schema.importJobs)
			.values({
				id: row.id,
				userId: row.userId ?? "test-user",
				status: row.status,
				totalConversations: row.totalConversations ?? 0,
				processedConversations: row.processedConversations ?? 0,
				errorLog: row.errorLog ?? null,
				createdAt: updatedAt,
				updatedAt,
			})
			.run();
		sqlite.close();
	}

	/**
	 * A conversation as the import leaves it: its messages carry
	 * `import_source = 'chatgpt'` (unless `imported` is false, a chat of the
	 * person's own), and nothing else has written to it yet.
	 */
	function seedImportedConversation(row: {
		id: string;
		userId?: string;
		title?: string;
		createdAt?: Date;
		incognito?: boolean;
		imported?: boolean;
		messages?: { role: string; content: string }[];
	}) {
		const { sqlite, db } = openSeedDatabase();
		const createdAt = row.createdAt ?? new Date();
		db.insert(schema.conversations)
			.values({
				id: row.id,
				userId: row.userId ?? "test-user",
				title: row.title ?? "Imported Conversation",
				memoryIncognito: row.incognito ?? false,
				createdAt,
				updatedAt: createdAt,
			})
			.run();
		const messages = row.messages ?? [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there!" },
		];
		db.insert(schema.messages)
			.values(
				messages.map((message, index) => ({
					id: `${row.id}-m${index + 1}`,
					conversationId: row.id,
					messageSequence: index + 1,
					role: message.role,
					content: message.content,
					importSource: row.imported === false ? null : "chatgpt",
					createdAt,
				})),
			)
			.run();
		sqlite.close();
	}

	/** An imported fork of `sourceId`, as `importConversationBranches` makes it. */
	function seedImportedFork(forkId: string, sourceId: string) {
		seedImportedConversation({ id: forkId, title: "Fork" });
		const { sqlite, db } = openSeedDatabase();
		db.insert(schema.conversationForks)
			.values({
				id: `${forkId}-link`,
				forkConversationId: forkId,
				userId: "test-user",
				sourceConversationId: sourceId,
				sourceConversationIdSnapshot: sourceId,
				sourceAssistantMessageIdSnapshot: "chatgpt:div-1",
				copiedForkPointMessageId: `${forkId}-m1`,
				sourceTitle: "Source",
				forkSequence: 1,
			})
			.run();
		sqlite.close();
	}

	function seedSummary(
		conversationId: string,
		summary: string,
		userId = "test-user",
	) {
		const { sqlite, db } = openSeedDatabase();
		db.insert(schema.conversationSummaries)
			.values({ conversationId, userId, summary, source: "model" })
			.run();
		sqlite.close();
	}

	/** What a Clear Memory leaves behind: a newer reset generation, and when. */
	function seedMemoryReset(
		resetGeneration: number,
		advancedAt: Date,
		userId = "test-user",
	) {
		const { sqlite, db } = openSeedDatabase();
		db.insert(schema.memoryResetGenerations)
			.values({ userId, resetGeneration, advancedAt })
			.onConflictDoUpdate({
				target: schema.memoryResetGenerations.userId,
				set: { resetGeneration, advancedAt },
			})
			.run();
		sqlite.close();
	}

	function deleteConversation(conversationId: string) {
		const { sqlite, db } = openSeedDatabase();
		db.delete(schema.conversations)
			.where(eq(schema.conversations.id, conversationId))
			.run();
		sqlite.close();
	}

	function markIncognito(conversationId: string) {
		const { sqlite, db } = openSeedDatabase();
		db.update(schema.conversations)
			.set({ memoryIncognito: true })
			.where(eq(schema.conversations.id, conversationId))
			.run();
		sqlite.close();
	}

	function readSummary(conversationId: string) {
		const sqlite = new Database(dbPath);
		const db = drizzle(sqlite, { schema });
		const row = db
			.select()
			.from(schema.conversationSummaries)
			.where(eq(schema.conversationSummaries.conversationId, conversationId))
			.get();
		sqlite.close();
		return row;
	}

	function readImportJob(jobId: string) {
		const sqlite = new Database(dbPath);
		const db = drizzle(sqlite, { schema });
		const job = db
			.select()
			.from(schema.importJobs)
			.where(eq(schema.importJobs.id, jobId))
			.get();
		sqlite.close();
		return job;
	}

	function readImportJobsForUser(userId = "test-user") {
		const sqlite = new Database(dbPath);
		const db = drizzle(sqlite, { schema });
		const rows = db
			.select()
			.from(schema.importJobs)
			.where(eq(schema.importJobs.userId, userId))
			.all();
		sqlite.close();
		return rows;
	}

	function readMessages(conversationId: string) {
		const sqlite = new Database(dbPath);
		const db = drizzle(sqlite, { schema });
		const rows = db
			.select()
			.from(schema.messages)
			.where(eq(schema.messages.conversationId, conversationId))
			.orderBy(schema.messages.messageSequence)
			.all();
		sqlite.close();
		return rows;
	}

	function readConversation(conversationId: string) {
		const sqlite = new Database(dbPath);
		const db = drizzle(sqlite, { schema });
		const conversation = db
			.select()
			.from(schema.conversations)
			.where(eq(schema.conversations.id, conversationId))
			.get();
		sqlite.close();
		return conversation;
	}

	function countConversations(userId = "test-user") {
		const sqlite = new Database(dbPath);
		const db = drizzle(sqlite, { schema });
		const rows = db
			.select({ id: schema.conversations.id })
			.from(schema.conversations)
			.where(eq(schema.conversations.userId, userId))
			.all();
		sqlite.close();
		return rows.length;
	}

	/** The conversations the memory judge's sweep will read. */
	function readConversationsQueuedForJudge(userId = "test-user") {
		const sqlite = new Database(dbPath);
		const db = drizzle(sqlite, { schema });
		const rows = db
			.select({ scopeId: schema.memoryDirtyLedger.scopeId })
			.from(schema.memoryDirtyLedger)
			.where(
				and(
					eq(schema.memoryDirtyLedger.userId, userId),
					eq(schema.memoryDirtyLedger.reason, "deferred_intake"),
					eq(schema.memoryDirtyLedger.scopeType, "conversation"),
					eq(schema.memoryDirtyLedger.status, "pending"),
				),
			)
			.all();
		sqlite.close();
		return rows.map((row) => row.scopeId).sort();
	}

	function readForks(sourceConversationId: string) {
		const sqlite = new Database(dbPath);
		const db = drizzle(sqlite, { schema });
		const rows = db
			.select()
			.from(schema.conversationForks)
			.where(
				eq(
					schema.conversationForks.sourceConversationIdSnapshot,
					sourceConversationId,
				),
			)
			.orderBy(schema.conversationForks.forkSequence)
			.all();
		sqlite.close();
		return rows;
	}

	function makeBranch(
		divergenceNodeId: string,
		branchNodeId: string,
		weight: number,
		messages: ParsedMessage[],
	): BranchInfo {
		return { divergenceNodeId, branchNodeId, weight, messages };
	}

	function makeParsedConversation(
		overrides: Partial<ParsedConversation> & {
			messages?: ParsedMessage[];
		} = {},
	): ParsedConversation {
		return {
			id: randomUUID(),
			title: "Test Conversation",
			createdAt: new Date("2024-01-15T12:00:00Z"),
			updatedAt: new Date("2024-01-15T12:30:00Z"),
			gizmoId: null,
			messages: [
				{
					role: "user",
					content: "Hello",
					createdAt: new Date("2024-01-15T12:00:00Z"),
				},
				{
					role: "assistant",
					content: "Hi there!",
					createdAt: new Date("2024-01-15T12:00:05Z"),
				},
				{
					role: "user",
					content: "How are you?",
					createdAt: new Date("2024-01-15T12:01:00Z"),
				},
			],
			...overrides,
		};
	}

	async function runImportConversations({
		userId = "test-user",
		zipName = "fake-zip",
		conversations = [],
		errors = [],
		parseError,
		importOptions,
	}: RunImportConversationsOptions = {}) {
		const { parseConversationsJson } = await import("./parser");
		if (parseError) {
			vi.mocked(parseConversationsJson).mockRejectedValue(parseError);
		} else {
			vi.mocked(parseConversationsJson).mockResolvedValue({
				conversations,
				errors,
			});
		}

		const { importConversations } = await import("./index");
		return importConversations(userId, Buffer.from(zipName), importOptions);
	}

	function cleanup() {
		try {
			unlinkSync(dbPath);
		} catch {
			// Best-effort cleanup for the temp database file.
		}
	}

	return {
		cleanup,
		countConversations,
		deleteConversation,
		makeBranch,
		makeParsedConversation,
		markIncognito,
		readConversation,
		readConversationsQueuedForJudge,
		readForks,
		readImportJob,
		readImportJobsForUser,
		readMessages,
		readSummary,
		runImportConversations,
		seedImportedConversation,
		seedImportedFork,
		seedImportJob,
		seedMemoryReset,
		seedProject,
		seedSummary,
		seedUser,
	};
}
