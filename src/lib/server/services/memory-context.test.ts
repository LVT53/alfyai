import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

const mockGetProjectContext = vi.fn();
const mockRecallPersonaMemory = vi.fn();
let dbPath: string;

vi.mock("$lib/server/services/memory-context/project", () => ({
	getProjectContext: mockGetProjectContext,
}));

vi.mock("./honcho", () => ({
	recallPersonaMemory: mockRecallPersonaMemory,
}));

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

describe("memory context service", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-memory-context-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		vi.clearAllMocks();
		mockGetProjectContext.mockResolvedValue({
			success: true,
			mode: "summary",
			hasProjectContext: false,
			source: "none",
			project: null,
			siblings: [],
			omittedSiblingCount: 0,
			evidenceCandidates: [],
			audit: {
				conversationId: "conv-current",
				scope: "conversation",
				requestedMaxSiblings: null,
				appliedMaxSiblings: 5,
				includeEvidenceCandidates: true,
			},
		});
		mockRecallPersonaMemory.mockResolvedValue({
			status: "ok",
			source: "honcho_peer_chat",
			content: "The user prefers concise answers and cares about cycling gear.",
		});
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported in mock-only tests.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("delegates project mode to project context and exposes a stable memory_context shape", async () => {
		const { getMemoryContext } = await import("./memory-context");

		const result = await getMemoryContext({
			userId: "user-1",
			conversationId: "conv-current",
			mode: "project",
			query: "pricing",
			maxSiblings: 12,
			includeEvidenceCandidates: false,
		});

		expect(result).toMatchObject({
			success: true,
			mode: "project",
			projectMode: "summary",
			hasProjectContext: false,
		});
		expect(mockGetProjectContext).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-current",
			mode: "summary",
			query: "pricing",
			maxSiblings: 12,
			siblingConversationId: null,
			maxMessages: undefined,
			includeEvidenceCandidates: false,
		});
	});

	it("uses project report mode for folder-wide file/report requests", async () => {
		mockGetProjectContext.mockResolvedValueOnce({
			success: true,
			mode: "report",
			hasProjectContext: true,
			source: "project_folder",
			project: {
				id: "folder-almalinux",
				name: "AlmaLinux Server",
				authority: "project_folder",
			},
			siblings: [],
			omittedSiblingCount: 0,
			reportSiblings: [],
			evidenceCandidates: [],
			audit: {
				conversationId: "conv-current",
				scope: "conversation",
				requestedMaxSiblings: null,
				appliedMaxSiblings: 16,
				requestedMaxMessages: null,
				appliedMaxMessages: 6,
				reportConversationCount: 0,
				includeEvidenceCandidates: true,
			},
		});
		const { getMemoryContext } = await import("./memory-context");

		const result = await getMemoryContext({
			userId: "user-1",
			conversationId: "conv-current",
			mode: "project",
			query:
				"Generate a detailed PDF report with the content from AlmaLinux Server project folder",
		});

		expect(result).toMatchObject({
			success: true,
			mode: "project",
			projectMode: "report",
			project: { name: "AlmaLinux Server" },
		});
		expect(mockGetProjectContext).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "report",
				query:
					"Generate a detailed PDF report with the content from AlmaLinux Server project folder",
			}),
		);
	});

	it("returns Honcho-led persona recall with a memory evidence candidate", async () => {
		const { getMemoryContext } = await import("./memory-context");

		const result = await getMemoryContext({
			userId: "user-1",
			conversationId: "conv-current",
			mode: "persona",
			query: "What should I remember about the user?",
			userDisplayName: "Test User",
		});

		expect(result).toMatchObject({
			success: true,
			mode: "persona",
			status: "available",
			source: "honcho_peer_chat",
			content: "The user prefers concise answers and cares about cycling gear.",
			audit: {
				conversationId: "conv-current",
				query: "What should I remember about the user?",
			},
		});
		expect(result.evidenceCandidates).toEqual([
			{
				id: "memory-context:persona:user-1",
				title: "Honcho persona recall",
				snippet:
					"The user prefers concise answers and cares about cycling gear.",
				sourceType: "memory",
			},
		]);
		expect(mockRecallPersonaMemory).toHaveBeenCalledWith({
			userId: "user-1",
			userDisplayName: "Test User",
			query: "What should I remember about the user?",
		});
	});

	it("defaults omitted mode to Honcho-led persona recall", async () => {
		const { getMemoryContext } = await import("./memory-context");

		const result = await getMemoryContext({
			userId: "user-1",
			conversationId: "conv-current",
			query: "What durable preferences matter?",
		});

		expect(result).toMatchObject({
			success: true,
			mode: "persona",
			status: "available",
			source: "honcho_peer_chat",
			audit: {
				conversationId: "conv-current",
				query: "What durable preferences matter?",
			},
		});
		expect(mockRecallPersonaMemory).toHaveBeenCalledWith({
			userId: "user-1",
			userDisplayName: undefined,
			query: "What durable preferences matter?",
		});
		expect(mockGetProjectContext).not.toHaveBeenCalled();
	});

	it("degrades clearly when Honcho persona recall is disabled", async () => {
		mockRecallPersonaMemory.mockResolvedValueOnce({
			status: "disabled",
			source: "none",
			content: null,
		});
		const { getMemoryContext } = await import("./memory-context");

		const result = await getMemoryContext({
			userId: "user-1",
			conversationId: "conv-current",
			mode: "persona",
			query: "preferences",
		});

		expect(result).toMatchObject({
			success: true,
			mode: "persona",
			status: "disabled",
			source: "none",
			content: null,
			evidenceCandidates: [],
		});
	});

	it("degrades clearly when Honcho persona recall errors", async () => {
		mockRecallPersonaMemory.mockResolvedValueOnce({
			status: "error",
			source: "none",
			content: null,
			error: "Honcho unavailable",
		});
		const { getMemoryContext } = await import("./memory-context");

		const result = await getMemoryContext({
			userId: "user-1",
			conversationId: "conv-current",
			mode: "persona",
			query: "preferences",
		});

		expect(result).toMatchObject({
			success: true,
			mode: "persona",
			status: "error",
			source: "none",
			content: null,
			error: "Honcho unavailable",
			evidenceCandidates: [],
		});
	});

	it("returns multiple older non-project history hits for a topic without leaking other users or projects", async () => {
		const { sqlite, db } = openSeedDatabase();
		const now = new Date("2026-05-16T09:00:00.000Z");
		db.insert(schema.users)
			.values([
				{
					id: "user-1",
					email: "history@example.com",
					passwordHash: "hash",
					createdAt: now,
					updatedAt: now,
				},
				{
					id: "user-2",
					email: "other@example.com",
					passwordHash: "hash",
					createdAt: now,
					updatedAt: now,
				},
			])
			.run();
		db.insert(schema.conversations)
			.values([
				{
					id: "conv-current",
					userId: "user-1",
					title: "Current chat",
					createdAt: now,
					updatedAt: now,
				},
				...Array.from({ length: 5 }, (_, index) => ({
					id: `bike-${index + 1}`,
					userId: "user-1",
					title: `Bike chat ${index + 1}`,
					projectId: null,
					createdAt: new Date(2026, 4, 10 + index, 9),
					updatedAt: new Date(2026, 4, 10 + index, 10),
				})),
				{
					id: "bike-project",
					userId: "user-1",
					title: "Bike project chat",
					projectId: "project-1",
					createdAt: now,
					updatedAt: now,
				},
				{
					id: "bike-other-user",
					userId: "user-2",
					title: "Other bike chat",
					projectId: null,
					createdAt: now,
					updatedAt: now,
				},
			])
			.run();
		db.insert(schema.conversationSummaries)
			.values([
				...Array.from({ length: 5 }, (_, index) => ({
					conversationId: `bike-${index + 1}`,
					userId: "user-1",
					summary: `Discussed bike fitting, route planning, and pannier choice ${index + 1}.`,
					source: "deterministic",
					createdAt: new Date(2026, 4, 10 + index, 10),
					updatedAt: new Date(2026, 4, 10 + index, 10),
				})),
				{
					conversationId: "bike-project",
					userId: "user-1",
					summary:
						"Project bike memory should stay out of account history recall.",
					source: "deterministic",
					createdAt: now,
					updatedAt: now,
				},
				{
					conversationId: "bike-other-user",
					userId: "user-2",
					summary: "Other user bike memory should not leak.",
					source: "deterministic",
					createdAt: now,
					updatedAt: now,
				},
			])
			.run();
		db.insert(schema.messages)
			.values(
				Array.from({ length: 5 }, (_, index) => ({
					id: `msg-bike-${index + 1}`,
					conversationId: `bike-${index + 1}`,
					role: "user",
					content: `Bike detail ${index + 1}: compare commute setup and tire width.`,
					createdAt: new Date(2026, 4, 10 + index, 11),
				})),
			)
			.run();
		sqlite.close();

		const { getMemoryContext } = await import("./memory-context");
		const result = await getMemoryContext({
			userId: "user-1",
			conversationId: "conv-current",
			mode: "history",
			query: "bike",
			maxHistoryConversations: 10,
		});

		expect(result).toMatchObject({
			success: true,
			mode: "history",
			status: "available",
			source: "conversation_summaries",
			omittedConversationCount: 0,
		});
		expect(result.conversations.map((item) => item.conversationId)).toEqual([
			"bike-5",
			"bike-4",
			"bike-3",
			"bike-2",
			"bike-1",
		]);
		expect(result.conversations).toHaveLength(5);
		expect(JSON.stringify(result)).not.toContain("bike-project");
		expect(JSON.stringify(result)).not.toContain("bike-other-user");
		expect(result.evidenceCandidates).toHaveLength(5);
	});

	it("finds older matching history summaries beyond recent nonmatching chats and counts only matching omissions", async () => {
		const { sqlite, db } = openSeedDatabase();
		const now = new Date("2026-05-16T09:00:00.000Z");
		db.insert(schema.users)
			.values({
				id: "user-1",
				email: "older-history@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(schema.conversations)
			.values([
				{
					id: "conv-current",
					userId: "user-1",
					title: "Current chat",
					createdAt: now,
					updatedAt: now,
				},
				...Array.from({ length: 205 }, (_, index) => ({
					id: `recent-nonmatch-${index + 1}`,
					userId: "user-1",
					title: `Recent unrelated chat ${index + 1}`,
					projectId: null,
					createdAt: new Date(2026, 4, 16, 8, index % 60),
					updatedAt: new Date(2026, 4, 16, 9, index % 60),
				})),
				{
					id: "bike-old-1",
					userId: "user-1",
					title: "Older cycling setup",
					projectId: null,
					createdAt: new Date("2026-04-01T08:00:00.000Z"),
					updatedAt: new Date("2026-04-01T09:00:00.000Z"),
				},
				{
					id: "bike-old-2",
					userId: "user-1",
					title: "Older bike fit",
					projectId: null,
					createdAt: new Date("2026-04-02T08:00:00.000Z"),
					updatedAt: new Date("2026-04-02T09:00:00.000Z"),
				},
			])
			.run();
		db.insert(schema.conversationSummaries)
			.values([
				...Array.from({ length: 205 }, (_, index) => ({
					conversationId: `recent-nonmatch-${index + 1}`,
					userId: "user-1",
					summary: `Discussed unrelated admin topic ${index + 1}.`,
					source: "deterministic",
					createdAt: new Date(2026, 4, 16, 9, index % 60),
					updatedAt: new Date(2026, 4, 16, 9, index % 60),
				})),
				{
					conversationId: "bike-old-1",
					userId: "user-1",
					summary: "Bike storage and winter tire notes from an older chat.",
					source: "deterministic",
					createdAt: new Date("2026-04-01T09:00:00.000Z"),
					updatedAt: new Date("2026-04-01T09:00:00.000Z"),
				},
				{
					conversationId: "bike-old-2",
					userId: "user-1",
					summary: "Bike fit adjustments and saddle height from an older chat.",
					source: "deterministic",
					createdAt: new Date("2026-04-02T09:00:00.000Z"),
					updatedAt: new Date("2026-04-02T09:00:00.000Z"),
				},
			])
			.run();
		sqlite.close();

		const { getMemoryContext } = await import("./memory-context");
		const result = await getMemoryContext({
			userId: "user-1",
			conversationId: "conv-current",
			mode: "history",
			query: "bike",
			maxHistoryConversations: 1,
		});

		expect(result.conversations.map((item) => item.conversationId)).toEqual([
			"bike-old-2",
		]);
		expect(result.omittedConversationCount).toBe(1);
		expect(JSON.stringify(result)).not.toContain("recent-nonmatch");
	});

	it("ranks topic history ahead of generic stopword-heavy chats", async () => {
		const { sqlite, db } = openSeedDatabase();
		const now = new Date("2026-05-16T09:00:00.000Z");
		db.insert(schema.users)
			.values({
				id: "user-1",
				email: "stopwords-history@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(schema.conversations)
			.values([
				{
					id: "conv-current",
					userId: "user-1",
					title: "Current chat",
					createdAt: now,
					updatedAt: now,
				},
				...Array.from({ length: 4 }, (_, index) => ({
					id: `generic-${index + 1}`,
					userId: "user-1",
					title: `What do you know about my generic chat ${index + 1}`,
					projectId: null,
					createdAt: new Date(2026, 4, 16, 8, index),
					updatedAt: new Date(2026, 4, 16, 9, index),
				})),
				...Array.from({ length: 3 }, (_, index) => ({
					id: `bike-topic-${index + 1}`,
					userId: "user-1",
					title: `Cycling setup ${index + 1}`,
					projectId: null,
					createdAt: new Date(2026, 4, 12 + index, 8),
					updatedAt: new Date(2026, 4, 12 + index, 9),
				})),
			])
			.run();
		db.insert(schema.conversationSummaries)
			.values([
				...Array.from({ length: 4 }, (_, index) => ({
					conversationId: `generic-${index + 1}`,
					userId: "user-1",
					summary: `What do you know about my status update ${index + 1}: reviewed calendar admin and account preferences.`,
					source: "deterministic",
					createdAt: new Date(2026, 4, 16, 9, index),
					updatedAt: new Date(2026, 4, 16, 9, index),
				})),
				...Array.from({ length: 3 }, (_, index) => ({
					conversationId: `bike-topic-${index + 1}`,
					userId: "user-1",
					summary: `Discussed bike setup ${index + 1}: saddle height, tire pressure, and panniers.`,
					source: "deterministic",
					createdAt: new Date(2026, 4, 12 + index, 9),
					updatedAt: new Date(2026, 4, 12 + index, 9),
				})),
			])
			.run();
		sqlite.close();

		const { getMemoryContext } = await import("./memory-context");
		const result = await getMemoryContext({
			userId: "user-1",
			conversationId: "conv-current",
			mode: "history",
			query: "what do you know about my bike",
			maxHistoryConversations: 4,
		});

		expect(result.conversations.map((item) => item.conversationId)).toEqual([
			"bike-topic-3",
			"bike-topic-2",
			"bike-topic-1",
		]);
		expect(JSON.stringify(result)).not.toContain("generic-");
	});

	it("treats SQL LIKE wildcard characters in history queries as literal text", async () => {
		const { sqlite, db } = openSeedDatabase();
		const now = new Date("2026-05-16T09:00:00.000Z");
		db.insert(schema.users)
			.values({
				id: "user-1",
				email: "wildcard-history@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(schema.conversations)
			.values([
				{
					id: "conv-current",
					userId: "user-1",
					title: "Current chat",
					createdAt: now,
					updatedAt: now,
				},
				{
					id: "literal-token",
					userId: "user-1",
					title: "Literal bike_% token",
					projectId: null,
					createdAt: new Date("2026-05-14T08:00:00.000Z"),
					updatedAt: new Date("2026-05-14T09:00:00.000Z"),
				},
				{
					id: "wildcard-shaped",
					userId: "user-1",
					title: "Bike wildcard shaped text",
					projectId: null,
					createdAt: new Date("2026-05-15T08:00:00.000Z"),
					updatedAt: new Date("2026-05-15T09:00:00.000Z"),
				},
				{
					id: "literal-backslash",
					userId: "user-1",
					title: "Literal bike backslash token",
					projectId: null,
					createdAt: new Date("2026-05-13T08:00:00.000Z"),
					updatedAt: new Date("2026-05-13T09:00:00.000Z"),
				},
				{
					id: "backslash-shaped",
					userId: "user-1",
					title: "Bike no backslash token",
					projectId: null,
					createdAt: new Date("2026-05-12T08:00:00.000Z"),
					updatedAt: new Date("2026-05-12T09:00:00.000Z"),
				},
			])
			.run();
		db.insert(schema.conversationSummaries)
			.values([
				{
					conversationId: "literal-token",
					userId: "user-1",
					summary: "The exact saved label was bike_% for the frame bag.",
					source: "deterministic",
					createdAt: new Date("2026-05-14T09:00:00.000Z"),
					updatedAt: new Date("2026-05-14T09:00:00.000Z"),
				},
				{
					conversationId: "wildcard-shaped",
					userId: "user-1",
					summary: "Discussed bike setup and bikeABC frame bag notes.",
					source: "deterministic",
					createdAt: new Date("2026-05-15T09:00:00.000Z"),
					updatedAt: new Date("2026-05-15T09:00:00.000Z"),
				},
				{
					conversationId: "literal-backslash",
					userId: "user-1",
					summary: "The exact saved path was bike\\bag for commute notes.",
					source: "deterministic",
					createdAt: new Date("2026-05-13T09:00:00.000Z"),
					updatedAt: new Date("2026-05-13T09:00:00.000Z"),
				},
				{
					conversationId: "backslash-shaped",
					userId: "user-1",
					summary: "Discussed bikeXbag and bike bag labels without a slash.",
					source: "deterministic",
					createdAt: new Date("2026-05-12T09:00:00.000Z"),
					updatedAt: new Date("2026-05-12T09:00:00.000Z"),
				},
			])
			.run();
		sqlite.close();

		const { getMemoryContext } = await import("./memory-context");
		const result = await getMemoryContext({
			userId: "user-1",
			conversationId: "conv-current",
			mode: "history",
			query: "bike_%",
			maxHistoryConversations: 10,
		});

		expect(result.conversations.map((item) => item.conversationId)).toEqual([
			"literal-token",
		]);
		expect(JSON.stringify(result)).not.toContain("wildcard-shaped");

		const backslashResult = await getMemoryContext({
			userId: "user-1",
			conversationId: "conv-current",
			mode: "history",
			query: "bike\\bag",
			maxHistoryConversations: 10,
		});

		expect(
			backslashResult.conversations.map((item) => item.conversationId),
		).toEqual(["literal-backslash"]);
		expect(JSON.stringify(backslashResult)).not.toContain("backslash-shaped");
	});

	it("returns empty history instead of broad recall when a query has no salient terms", async () => {
		const { sqlite, db } = openSeedDatabase();
		const now = new Date("2026-05-16T09:00:00.000Z");
		db.insert(schema.users)
			.values({
				id: "user-1",
				email: "low-signal-history@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(schema.conversations)
			.values([
				{
					id: "conv-current",
					userId: "user-1",
					title: "Current chat",
					createdAt: now,
					updatedAt: now,
				},
				{
					id: "unrelated-memory",
					userId: "user-1",
					title: "Unrelated account history",
					projectId: null,
					createdAt: new Date("2026-05-15T08:00:00.000Z"),
					updatedAt: new Date("2026-05-15T09:00:00.000Z"),
				},
			])
			.run();
		db.insert(schema.conversationSummaries)
			.values({
				conversationId: "unrelated-memory",
				userId: "user-1",
				summary: "Discussed invoices, groceries, and a calendar reminder.",
				source: "deterministic",
				createdAt: new Date("2026-05-15T09:00:00.000Z"),
				updatedAt: new Date("2026-05-15T09:00:00.000Z"),
			})
			.run();
		sqlite.close();

		const { getMemoryContext } = await import("./memory-context");
		const result = await getMemoryContext({
			userId: "user-1",
			conversationId: "conv-current",
			mode: "history",
			query: "what do you know about my % _ \\",
			maxHistoryConversations: 10,
		});

		expect(result).toMatchObject({
			success: true,
			mode: "history",
			status: "empty",
			conversations: [],
			omittedConversationCount: 0,
			evidenceCandidates: [],
		});
	});

	it("expands one selected history conversation with bounded messages and omitted counts", async () => {
		const { sqlite, db } = openSeedDatabase();
		const now = new Date("2026-05-16T09:00:00.000Z");
		db.insert(schema.users)
			.values({
				id: "user-1",
				email: "detail@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(schema.conversations)
			.values([
				{
					id: "conv-current",
					userId: "user-1",
					title: "Current chat",
					createdAt: now,
					updatedAt: now,
				},
				{
					id: "bike-selected",
					userId: "user-1",
					title: "Bike fit details",
					projectId: null,
					createdAt: new Date("2026-05-10T09:00:00.000Z"),
					updatedAt: new Date("2026-05-10T10:00:00.000Z"),
				},
			])
			.run();
		db.insert(schema.conversationSummaries)
			.values({
				conversationId: "bike-selected",
				userId: "user-1",
				summary: "Bike fit discussion with saddle height and tire notes.",
				source: "deterministic",
				createdAt: new Date("2026-05-10T10:00:00.000Z"),
				updatedAt: new Date("2026-05-10T10:00:00.000Z"),
			})
			.run();
		db.insert(schema.messages)
			.values(
				Array.from({ length: 12 }, (_, index) => ({
					id: `bike-selected-${index}`,
					conversationId: "bike-selected",
					role: index % 2 === 0 ? "user" : "assistant",
					content: `Bike selected message ${index}`,
					createdAt: new Date(2026, 4, 10, 11, index),
				})),
			)
			.run();
		sqlite.close();

		const { getMemoryContext } = await import("./memory-context");
		const result = await getMemoryContext({
			userId: "user-1",
			conversationId: "conv-current",
			mode: "history",
			query: "bike",
			historyConversationId: "bike-selected",
			maxMessages: 4,
		});

		expect(result).toMatchObject({
			success: true,
			mode: "history",
			status: "available",
			selectedConversation: {
				conversationId: "bike-selected",
				title: "Bike fit details",
				omittedMessageCount: 8,
			},
			audit: {
				historyConversationId: "bike-selected",
				requestedMaxMessages: 4,
				appliedMaxMessages: 4,
			},
		});
		expect(result.selectedConversation?.messages).toHaveLength(4);
		expect(
			result.selectedConversation?.messages.map((message) => message.content),
		).toEqual([
			"Bike selected message 8",
			"Bike selected message 9",
			"Bike selected message 10",
			"Bike selected message 11",
		]);
	});

	it("rejects selected history detail outside the current history query result set", async () => {
		const { sqlite, db } = openSeedDatabase();
		const now = new Date("2026-05-16T09:00:00.000Z");
		db.insert(schema.users)
			.values({
				id: "user-1",
				email: "history-scope@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(schema.conversations)
			.values([
				{
					id: "conv-current",
					userId: "user-1",
					title: "Current chat",
					createdAt: now,
					updatedAt: now,
				},
				{
					id: "bike-match",
					userId: "user-1",
					title: "Bike history",
					projectId: null,
					createdAt: new Date("2026-05-10T09:00:00.000Z"),
					updatedAt: new Date("2026-05-10T10:00:00.000Z"),
				},
				{
					id: "unrelated-detail",
					userId: "user-1",
					title: "Garden notes",
					projectId: null,
					createdAt: new Date("2026-05-11T09:00:00.000Z"),
					updatedAt: new Date("2026-05-11T10:00:00.000Z"),
				},
			])
			.run();
		db.insert(schema.conversationSummaries)
			.values([
				{
					conversationId: "bike-match",
					userId: "user-1",
					summary: "Bike fit notes and tire pressure.",
					source: "deterministic",
					createdAt: new Date("2026-05-10T10:00:00.000Z"),
					updatedAt: new Date("2026-05-10T10:00:00.000Z"),
				},
				{
					conversationId: "unrelated-detail",
					userId: "user-1",
					summary: "Garden bed layout and seed timing.",
					source: "deterministic",
					createdAt: new Date("2026-05-11T10:00:00.000Z"),
					updatedAt: new Date("2026-05-11T10:00:00.000Z"),
				},
			])
			.run();
		db.insert(schema.messages)
			.values({
				id: "unrelated-detail-message",
				conversationId: "unrelated-detail",
				role: "user",
				content: "Garden detail should stay scoped to planting notes.",
				createdAt: new Date("2026-05-11T10:05:00.000Z"),
			})
			.run();
		sqlite.close();

		const { getMemoryContext } = await import("./memory-context");
		await expect(
			getMemoryContext({
				userId: "user-1",
				conversationId: "conv-current",
				mode: "history",
				query: "bike",
				historyConversationId: "unrelated-detail",
			}),
		).rejects.toThrow(
			"historyConversationId is outside memory_context history scope",
		);
	});
});
