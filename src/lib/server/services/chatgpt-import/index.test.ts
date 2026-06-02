import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import type { BranchInfo, ParsedConversation, ParsedMessage } from "./parser";

let dbPath: string;

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

function readForks(sourceConversationId: string) {
	const sqlite = new Database(dbPath);
	const db = drizzle(sqlite, { schema });
	const rows = db
		.select()
		.from(schema.conversationForks)
		.where(eq(schema.conversationForks.sourceConversationIdSnapshot, sourceConversationId))
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
	overrides: Partial<ParsedConversation> & { messages?: ParsedMessage[] } = {},
): ParsedConversation {
	return {
		id: randomUUID(),
		title: "Test Conversation",
		createdAt: new Date("2024-01-15T12:00:00Z"),
		updatedAt: new Date("2024-01-15T12:30:00Z"),
		gizmoId: null,
		messages: [
			{ role: "user", content: "Hello", createdAt: new Date("2024-01-15T12:00:00Z") },
			{ role: "assistant", content: "Hi there!", createdAt: new Date("2024-01-15T12:00:05Z") },
			{ role: "user", content: "How are you?", createdAt: new Date("2024-01-15T12:01:00Z") },
		],
		...overrides,
	};
}

vi.mock("./parser", async () => {
	const actual = await vi.importActual<typeof import("./parser")>("./parser");
	return {
		...actual,
		parseConversationsJson: vi.fn(),
	};
});

vi.mock("./embeddings", () => ({
	generateImportEmbeddings: vi.fn(async () => undefined),
}));

describe("importConversations", () => {
	beforeEach(async () => {
		dbPath = `/tmp/alfyai-chatgpt-import-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		vi.clearAllMocks();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// DB module may not have been imported
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Best-effort cleanup
		}
	});

	it("imports a single conversation with messages", async () => {
		seedUser();
		const parsed = makeParsedConversation();

		const { parseConversationsJson } = await import("./parser");
		vi.mocked(parseConversationsJson).mockResolvedValue({
			conversations: [parsed],
			errors: [],
		});

		const { importConversations } = await import("./index");

		const result = await importConversations("test-user", Buffer.from("fake-zip"));

		expect(result.conversationIds).toHaveLength(1);
		expect(result.errors).toHaveLength(0);
		expect(result.jobId).toEqual(expect.any(String));

		const job = readImportJob(result.jobId);
		expect(job?.status).toBe("completed");
		expect(job?.totalConversations).toBe(1);
		expect(job?.processedConversations).toBe(1);

		const convId = result.conversationIds[0];
		const msgs = readMessages(convId);
		expect(msgs).toHaveLength(3);
		expect(msgs[0].messageSequence).toBe(1);
		expect(msgs[0].role).toBe("user");
		expect(msgs[0].content).toBe("Hello");
		expect(msgs[0].importSource).toBe("chatgpt");
		expect(msgs[1].messageSequence).toBe(2);
		expect(msgs[2].messageSequence).toBe(3);
	});

	it("imports multiple conversations", async () => {
		seedUser();
		const parsed1 = makeParsedConversation({ title: "First" });
		const parsed2 = makeParsedConversation({ title: "Second" });

		const { parseConversationsJson } = await import("./parser");
		vi.mocked(parseConversationsJson).mockResolvedValue({
			conversations: [parsed1, parsed2],
			errors: [],
		});

		const { importConversations } = await import("./index");

		const result = await importConversations("test-user", Buffer.from("fake-zip"));

		expect(result.conversationIds).toHaveLength(2);
		expect(result.errors).toHaveLength(0);

		const job = readImportJob(result.jobId);
		expect(job?.totalConversations).toBe(2);
		expect(job?.processedConversations).toBe(2);
	});

	it("assigns conversations to a project when projectId is provided", async () => {
		seedUser();
		seedProject("test-user", "proj-1", "Import Project");
		const parsed = makeParsedConversation();

		const { parseConversationsJson } = await import("./parser");
		vi.mocked(parseConversationsJson).mockResolvedValue({
			conversations: [parsed],
			errors: [],
		});

		const { importConversations } = await import("./index");

		const result = await importConversations("test-user", Buffer.from("fake-zip"), {
			projectId: "proj-1",
		});

		expect(result.conversationIds).toHaveLength(1);
		expect(result.errors).toHaveLength(0);

		const sqlite = new Database(dbPath);
		const db = drizzle(sqlite, { schema });
		const conv = db
			.select()
			.from(schema.conversations)
			.where(eq(schema.conversations.id, result.conversationIds[0]))
			.get();
		sqlite.close();

		expect(conv?.projectId).toBe("proj-1");
	});

	it("preserves original ChatGPT timestamps on messages", async () => {
		seedUser();
		const parsed = makeParsedConversation({
			messages: [
				{
					role: "user",
					content: "Test",
					createdAt: new Date("2023-06-15T08:00:00Z"),
				},
			],
		});

		const { parseConversationsJson } = await import("./parser");
		vi.mocked(parseConversationsJson).mockResolvedValue({
			conversations: [parsed],
			errors: [],
		});

		const { importConversations } = await import("./index");

		const result = await importConversations("test-user", Buffer.from("fake-zip"));
		const msgs = readMessages(result.conversationIds[0]);

		expect(msgs[0].createdAt).toEqual(new Date("2023-06-15T08:00:00Z"));
	});

	it("uses current time when message has no createdAt", async () => {
		seedUser();
		const before = new Date();
		const parsed = makeParsedConversation({
			messages: [
				{ role: "user", content: "No timestamp" },
			],
		});

		const { parseConversationsJson } = await import("./parser");
		vi.mocked(parseConversationsJson).mockResolvedValue({
			conversations: [parsed],
			errors: [],
		});

		const { importConversations } = await import("./index");

		const result = await importConversations("test-user", Buffer.from("fake-zip"));
		const after = new Date();

		const msgs = readMessages(result.conversationIds[0]);
		expect(msgs[0].createdAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
		expect(msgs[0].createdAt!.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
	});

	it("calls onProgress callback for each conversation", async () => {
		seedUser();
		const parsed1 = makeParsedConversation({ title: "A" });
		const parsed2 = makeParsedConversation({ title: "B" });
		const parsed3 = makeParsedConversation({ title: "C" });

		const { parseConversationsJson } = await import("./parser");
		vi.mocked(parseConversationsJson).mockResolvedValue({
			conversations: [parsed1, parsed2, parsed3],
			errors: [],
		});

		const { importConversations } = await import("./index");

		const progressCalls: { processed: number; total: number }[] = [];
		await importConversations("test-user", Buffer.from("fake-zip"), {
			onProgress: (processed, total) => progressCalls.push({ processed, total }),
		});

		expect(progressCalls).toEqual([
			{ processed: 1, total: 3 },
			{ processed: 2, total: 3 },
			{ processed: 3, total: 3 },
		]);
	});

	it("handles parser errors gracefully", async () => {
		seedUser();

		const { parseConversationsJson } = await import("./parser");
		vi.mocked(parseConversationsJson).mockRejectedValue(new Error("Invalid ZIP format"));

		const { importConversations } = await import("./index");

		const result = await importConversations("test-user", Buffer.from("corrupt"));

		expect(result.conversationIds).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].reason).toContain("Invalid ZIP format");

		const job = readImportJob(result.jobId);
		expect(job?.status).toBe("failed");
		expect(job?.errorLog).toContain("Invalid ZIP format");
	});

	it("returns parser-level errors alongside successful conversations", async () => {
		seedUser();
		const parsed = makeParsedConversation({ title: "Valid" });

		const { parseConversationsJson } = await import("./parser");
		vi.mocked(parseConversationsJson).mockResolvedValue({
			conversations: [parsed],
			errors: [
				{ rawId: "bad-id", rawTitle: "Bad Conv", reason: "No messages" },
			],
		});

		const { importConversations } = await import("./index");

		const result = await importConversations("test-user", Buffer.from("fake-zip"));

		expect(result.conversationIds).toHaveLength(1);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].conversationTitle).toBe("Bad Conv");
		expect(result.errors[0].reason).toBe("No messages");
	});

	it("handles empty conversations result", async () => {
		seedUser();

		const { parseConversationsJson } = await import("./parser");
		vi.mocked(parseConversationsJson).mockResolvedValue({
			conversations: [],
			errors: [],
		});

		const { importConversations } = await import("./index");

		const result = await importConversations("test-user", Buffer.from("empty-zip"));

		expect(result.conversationIds).toHaveLength(0);
		expect(result.errors).toHaveLength(0);

		const job = readImportJob(result.jobId);
		expect(job?.status).toBe("completed");
		expect(job?.totalConversations).toBe(0);
	});

	it("continues processing remaining conversations when one fails", async () => {
		seedUser();
		const parsed1 = makeParsedConversation({ title: "Valid" });
		const parsed2 = makeParsedConversation({ title: "Also Valid" });

		const { parseConversationsJson } = await import("./parser");
		vi.mocked(parseConversationsJson).mockResolvedValue({
			conversations: [parsed1, parsed2],
			errors: [],
		});

		const { importConversations } = await import("./index");

		const result = await importConversations("test-user", Buffer.from("fake-zip"));

		expect(result.conversationIds).toHaveLength(2);
		expect(result.errors).toHaveLength(0);
	});

	it("uses 'Imported Conversation' as fallback title when conversation has no title", async () => {
		seedUser();
		const parsed = makeParsedConversation({ title: "" });

		const { parseConversationsJson } = await import("./parser");
		vi.mocked(parseConversationsJson).mockResolvedValue({
			conversations: [parsed],
			errors: [],
		});

		const { importConversations } = await import("./index");

		const result = await importConversations("test-user", Buffer.from("fake-zip"));

		expect(result.conversationIds).toHaveLength(1);

		const sqlite = new Database(dbPath);
		const db = drizzle(sqlite, { schema });
		const conv = db
			.select()
			.from(schema.conversations)
			.where(eq(schema.conversations.id, result.conversationIds[0]))
			.get();
		sqlite.close();

		expect(conv?.title).toBe("Imported Conversation");
	});

	it("sets importSource on all messages", async () => {
		seedUser();
		const parsed = makeParsedConversation({
			messages: [
				{ role: "user", content: "Q1" },
				{ role: "assistant", content: "A1" },
				{ role: "user", content: "Q2" },
				{ role: "assistant", content: "A2" },
			],
		});

		const { parseConversationsJson } = await import("./parser");
		vi.mocked(parseConversationsJson).mockResolvedValue({
			conversations: [parsed],
			errors: [],
		});

		const { importConversations } = await import("./index");

		const result = await importConversations("test-user", Buffer.from("fake-zip"));
		const msgs = readMessages(result.conversationIds[0]);

		expect(msgs).toHaveLength(4);
		for (const msg of msgs) {
			expect(msg.importSource).toBe("chatgpt");
		}
	});

	it("sets correct message sequence numbers starting from 1", async () => {
		seedUser();
		const parsed = makeParsedConversation({
			messages: [
				{ role: "user", content: "First" },
				{ role: "assistant", content: "Second" },
				{ role: "user", content: "Third" },
			],
		});

		const { parseConversationsJson } = await import("./parser");
		vi.mocked(parseConversationsJson).mockResolvedValue({
			conversations: [parsed],
			errors: [],
		});

		const { importConversations } = await import("./index");

		const result = await importConversations("test-user", Buffer.from("fake-zip"));
		const msgs = readMessages(result.conversationIds[0]);

		expect(msgs[0].messageSequence).toBe(1);
		expect(msgs[1].messageSequence).toBe(2);
		expect(msgs[2].messageSequence).toBe(3);
	});

	it("creates a new import job for each import call", async () => {
		seedUser();
		const parsed = makeParsedConversation();

		const { parseConversationsJson } = await import("./parser");
		vi.mocked(parseConversationsJson).mockResolvedValue({
			conversations: [parsed],
			errors: [],
		});

		const { importConversations } = await import("./index");

		const result1 = await importConversations("test-user", Buffer.from("zip1"));
		const result2 = await importConversations("test-user", Buffer.from("zip2"));

		expect(result1.jobId).not.toBe(result2.jobId);

		const job1 = readImportJob(result1.jobId);
		const job2 = readImportJob(result2.jobId);
		expect(job1).toBeTruthy();
		expect(job2).toBeTruthy();
		expect(job1?.id).not.toBe(job2?.id);
	});

	it("creates a fork conversation for each detected branch", async () => {
		seedUser();
		const branchMessages: ParsedMessage[] = [
			{ role: "user", content: "Hello", createdAt: new Date("2024-01-15T12:00:00Z") },
			{ role: "assistant", content: "Alternative response", createdAt: new Date("2024-01-15T12:00:05Z") },
		];
		const parsed = makeParsedConversation({
			branches: [
				makeBranch("div-n1", "branch-n1", 0.5, branchMessages),
			],
		});

		const { parseConversationsJson } = await import("./parser");
		vi.mocked(parseConversationsJson).mockResolvedValue({
			conversations: [parsed],
			errors: [],
		});

		const { importConversations } = await import("./index");

		const result = await importConversations("test-user", Buffer.from("fake-zip"));

		expect(result.conversationIds).toHaveLength(1);
		expect(result.errors).toHaveLength(0);

		const primaryMsgs = readMessages(result.conversationIds[0]);
		expect(primaryMsgs).toHaveLength(3);
		expect(primaryMsgs[0].content).toBe("Hello");
		expect(primaryMsgs[1].content).toBe("Hi there!");

		const forks = readForks(result.conversationIds[0]);
		expect(forks).toHaveLength(1);
		expect(forks[0].forkSequence).toBe(1);
		expect(forks[0].sourceTitle).toBe("Test Conversation");
		expect(forks[0].sourceConversationIdSnapshot).toBe(result.conversationIds[0]);

		const forkMsgs = readMessages(forks[0].forkConversationId);
		expect(forkMsgs).toHaveLength(2);
		expect(forkMsgs[0].content).toBe("Hello");
		expect(forkMsgs[0].importSource).toBe("chatgpt");
		expect(forkMsgs[1].content).toBe("Alternative response");
		expect(forkMsgs[1].importSource).toBe("chatgpt");
	});

	it("sets fork point to the last shared message", async () => {
		seedUser();
		const branchMessages: ParsedMessage[] = [
			{ role: "user", content: "Hello", createdAt: new Date("2024-01-15T12:00:00Z") },
			{ role: "assistant", content: "Branch-only reply", createdAt: new Date("2024-01-15T12:00:05Z") },
		];
		const parsed = makeParsedConversation({
			messages: [
				{ role: "user", content: "Hello", createdAt: new Date("2024-01-15T12:00:00Z") },
				{ role: "assistant", content: "Primary reply", createdAt: new Date("2024-01-15T12:00:05Z") },
				{ role: "user", content: "Follow-up", createdAt: new Date("2024-01-15T12:01:00Z") },
			],
			branches: [
				makeBranch("div-n1", "branch-n1", 0.5, branchMessages),
			],
		});

		const { parseConversationsJson } = await import("./parser");
		vi.mocked(parseConversationsJson).mockResolvedValue({
			conversations: [parsed],
			errors: [],
		});

		const { importConversations } = await import("./index");

		const result = await importConversations("test-user", Buffer.from("fake-zip"));

		const forks = readForks(result.conversationIds[0]);
		expect(forks).toHaveLength(1);

		const forkMsgs = readMessages(forks[0].forkConversationId);
		const forkPointMsg = forkMsgs.find((m) => m.id === forks[0].copiedForkPointMessageId);
		expect(forkPointMsg).toBeTruthy();
		expect(forkPointMsg?.content).toBe("Hello");
		expect(forkPointMsg?.role).toBe("user");
	});

	it("creates multiple forks from multiple branches", async () => {
		seedUser();
		const branch1Messages: ParsedMessage[] = [
			{ role: "user", content: "Hello", createdAt: new Date() },
			{ role: "assistant", content: "Branch 1 answer", createdAt: new Date() },
		];
		const branch2Messages: ParsedMessage[] = [
			{ role: "user", content: "Hello", createdAt: new Date() },
			{ role: "assistant", content: "Branch 2 answer", createdAt: new Date() },
		];
		const parsed = makeParsedConversation({
			branches: [
				makeBranch("div1", "br1", 0.5, branch1Messages),
				makeBranch("div1", "br2", 0.3, branch2Messages),
			],
		});

		const { parseConversationsJson } = await import("./parser");
		vi.mocked(parseConversationsJson).mockResolvedValue({
			conversations: [parsed],
			errors: [],
		});

		const { importConversations } = await import("./index");

		const result = await importConversations("test-user", Buffer.from("fake-zip"));

		const forks = readForks(result.conversationIds[0]);
		expect(forks).toHaveLength(2);
		expect(forks[0].forkSequence).toBe(1);
		expect(forks[1].forkSequence).toBe(2);

		const fork1Msgs = readMessages(forks[0].forkConversationId);
		expect(fork1Msgs[1].content).toBe("Branch 1 answer");

		const fork2Msgs = readMessages(forks[1].forkConversationId);
		expect(fork2Msgs[1].content).toBe("Branch 2 answer");
	});

	it("does not create forks when there are no branches", async () => {
		seedUser();
		const parsed = makeParsedConversation();

		const { parseConversationsJson } = await import("./parser");
		vi.mocked(parseConversationsJson).mockResolvedValue({
			conversations: [parsed],
			errors: [],
		});

		const { importConversations } = await import("./index");

		const result = await importConversations("test-user", Buffer.from("fake-zip"));

		expect(result.conversationIds).toHaveLength(1);
		const forks = readForks(result.conversationIds[0]);
		expect(forks).toHaveLength(0);
	});

	it("calls generateImportEmbeddings for each imported conversation", async () => {
		seedUser();
		const parsed = makeParsedConversation({
			title: "Embeddable Chat",
			messages: [
				{ role: "user", content: "Q1" },
				{ role: "assistant", content: "A1" },
			],
		});

		const { parseConversationsJson } = await import("./parser");
		vi.mocked(parseConversationsJson).mockResolvedValue({
			conversations: [parsed],
			errors: [],
		});

		const { importConversations } = await import("./index");
		const { generateImportEmbeddings } = await import("./embeddings");
		const mockGenerate = vi.mocked(generateImportEmbeddings);

		const result = await importConversations("test-user", Buffer.from("fake-zip"));

		expect(mockGenerate).toHaveBeenCalledTimes(1);
		expect(mockGenerate).toHaveBeenCalledWith(
			result.conversationIds[0],
			"test-user",
			"Embeddable Chat",
			parsed.messages,
		);
	});
});
