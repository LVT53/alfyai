import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

const mocks = vi.hoisted(() => {
	const config = {
		honchoApiKey: "test-api-key",
		honchoBaseUrl: "http://honcho.test",
		honchoWorkspace: "test-workspace",
		honchoIdentityNamespace: "context-access-harness",
		honchoEnabled: true,
		honchoContextWaitMs: 100,
		honchoContextPollIntervalMs: 10,
		honchoPersonaContextWaitMs: 100,
		contextDiagnosticsDebug: false,
		teiEmbedderUrl: "",
		teiEmbedderApiKey: "",
		teiEmbedderBatchSize: 8,
		teiRerankerUrl: "",
		teiRerankerApiKey: "",
		teiRerankerMaxTexts: 8,
		documentTokenBudget: 6_000,
		workingSetPromptTokenBudget: 20_000,
		smallFileThreshold: 256_000,
		maxModelContext: 262_144,
		compactionUiThreshold: 209_715,
		targetConstructedContext: 157_286,
		model1MaxModelContext: 262_144,
		model1CompactionUiThreshold: 209_715,
		model1TargetConstructedContext: 157_286,
		model2MaxModelContext: 262_144,
		model2CompactionUiThreshold: 209_715,
		model2TargetConstructedContext: 157_286,
	};
	const peerContext = vi.fn(async () => ({
		representation:
			"Synthesized baseline profile: prefers concise technical answers and tracks cycling gear.",
		peerCard: ["Works on Context Access v1"],
	}));
	const peerChat = vi.fn(
		async () => "persona recall should only happen through memory_context",
	);
	const sessionContext = vi.fn(async () => ({
		messages: [],
		summary: null,
	}));
	const shortlistSemanticMatchesBySubject = vi.fn(async () => []);

	return {
		config,
		peerContext,
		peerChat,
		sessionContext,
		shortlistSemanticMatchesBySubject,
	};
});

vi.mock("$lib/server/config-store", async (importActual) => {
	const actual =
		await importActual<typeof import("$lib/server/config-store")>();
	return {
		...actual,
		getConfig: () => mocks.config,
		getMaxModelContext: () => mocks.config.maxModelContext,
		getCompactionUiThreshold: () => mocks.config.compactionUiThreshold,
		getTargetConstructedContext: () => mocks.config.targetConstructedContext,
		getDocumentTokenBudget: () => mocks.config.documentTokenBudget,
		getWorkingSetPromptTokenBudget: () =>
			mocks.config.workingSetPromptTokenBudget,
		getSmallFileThreshold: () => mocks.config.smallFileThreshold,
	};
});

vi.mock("@honcho-ai/sdk", () => {
	function makePeer(id: string) {
		return {
			id,
			context: mocks.peerContext,
			chat: mocks.peerChat,
			message: (
				content: string,
				options?: { metadata?: Record<string, unknown> },
			) => ({
				content,
				metadata: options?.metadata ?? {},
				peerId: id,
				createdAt: new Date("2026-05-16T09:00:00.000Z").toISOString(),
			}),
		};
	}

	function Honcho() {
		return {
			peer: vi.fn(async (id: string) => makePeer(id)),
			session: vi.fn(async (id: string) => ({
				id,
				setMetadata: vi.fn(async () => undefined),
				setPeers: vi.fn(async () => undefined),
				context: mocks.sessionContext,
				addMessages: vi.fn(async () => undefined),
			})),
		};
	}

	return { Honcho };
});

vi.mock("$lib/server/services/semantic-ranking", () => ({
	shortlistSemanticMatchesBySubject: mocks.shortlistSemanticMatchesBySubject,
}));

let dbPath: string;

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

function seedUserAndConversation(
	db: ReturnType<typeof openSeedDatabase>["db"],
	conversationId = "conv-current",
) {
	const now = new Date("2026-05-16T09:00:00.000Z");
	db.insert(schema.users)
		.values({
			id: "user-1",
			email: `${conversationId}@example.com`,
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: conversationId,
			userId: "user-1",
			title: "Current context access chat",
			projectId: null,
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

describe("Context Access v1 integrated regression harness", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-context-access-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		vi.clearAllMocks();
		mocks.config.honchoEnabled = true;
		mocks.peerContext.mockResolvedValue({
			representation:
				"Synthesized baseline profile: prefers concise technical answers and tracks cycling gear.",
			peerCard: ["Works on Context Access v1"],
		});
		mocks.sessionContext.mockResolvedValue({
			messages: [],
			summary: null,
		});
		mocks.shortlistSemanticMatchesBySubject.mockResolvedValue([]);
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module is loaded only by tests that hit server services.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("assembles baseline Honcho profile, fuzzy document evidence, and account history before relying on tools", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedUserAndConversation(db);
		const now = new Date("2026-05-16T09:00:00.000Z");
		db.insert(schema.users)
			.values({
				id: "user-2",
				email: "other-context-access@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(schema.artifacts)
			.values({
				id: "doc-semantic",
				userId: "user-1",
				conversationId: null,
				type: "normalized_document",
				retrievalClass: "durable",
				name: "Operations handbook.txt",
				mimeType: "text/plain",
				extension: "txt",
				sizeBytes: 1024,
				contentText:
					"Escalation policy: refund risk predictors include repeated failed renewals and unresolved billing complaints.",
				summary: "Support operations procedures",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(schema.conversations)
			.values([
				...Array.from({ length: 4 }, (_, index) => ({
					id: `bike-history-${index + 1}`,
					userId: "user-1",
					title: `Bike fit chat ${index + 1}`,
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
					title: "Other user's bike chat",
					projectId: null,
					createdAt: now,
					updatedAt: now,
				},
			])
			.run();
		db.insert(schema.conversationSummaries)
			.values([
				...Array.from({ length: 4 }, (_, index) => ({
					conversationId: `bike-history-${index + 1}`,
					userId: "user-1",
					summary: `Bike setup memory ${index + 1}: tire width, commute route, pannier fit.`,
					source: "deterministic",
					createdAt: new Date(2026, 4, 10 + index, 10),
					updatedAt: new Date(2026, 4, 10 + index, 10),
				})),
				{
					conversationId: "bike-project",
					userId: "user-1",
					summary: "Project bike memory should stay out of account history.",
					source: "deterministic",
					createdAt: now,
					updatedAt: now,
				},
				{
					conversationId: "bike-other-user",
					userId: "user-2",
					summary: "Other user bike memory should stay private.",
					source: "deterministic",
					createdAt: now,
					updatedAt: now,
				},
			])
			.run();
		sqlite.close();

		mocks.shortlistSemanticMatchesBySubject.mockImplementation(
			async ({
				items,
				subjectType,
			}: {
				items: Array<{ id: string }>;
				subjectType: string;
			}) =>
				subjectType === "artifact"
					? items
							.filter((item) => item.id === "doc-semantic")
							.map((item) => ({
								subjectId: item.id,
								item,
								semanticScore: 0.94,
							}))
					: [],
		);

		const { buildConstructedContext } = await import("./honcho");
		const { getMemoryContext } = await import("./memory-context");

		const constructed = await buildConstructedContext({
			userId: "user-1",
			conversationId: "conv-current",
			message: "What predicts refund trouble?",
		});
		const history = await getMemoryContext({
			userId: "user-1",
			conversationId: "conv-current",
			mode: "history",
			query: "bike",
			maxHistoryConversations: 10,
		});

		expect(constructed.inputValue).toContain("## Baseline Memory Profile");
		expect(constructed.inputValue).toContain(
			"Synthesized baseline profile: prefers concise technical answers",
		);
		expect(mocks.peerContext).toHaveBeenCalled();
		expect(mocks.peerChat).not.toHaveBeenCalled();

		expect(constructed.inputValue).toContain("## Retrieved Evidence");
		expect(constructed.inputValue).toContain("Operations handbook.txt");
		expect(constructed.inputValue).toContain("refund risk predictors");
		expect(constructed.inputValue).not.toContain("/document");
		expect(constructed.contextTraceSections).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "Baseline Memory Profile",
					source: "memory",
					signalReasons: ["honcho_baseline_profile:live"],
				}),
				expect.objectContaining({
					name: "Retrieved Evidence",
					itemIds: ["doc-semantic"],
					itemTitles: ["Operations handbook.txt"],
				}),
			]),
		);

		expect(history).toMatchObject({
			success: true,
			mode: "history",
			status: "available",
			source: "conversation_summaries",
		});
		expect(history.conversations.map((item) => item.conversationId)).toEqual([
			"bike-history-4",
			"bike-history-3",
			"bike-history-2",
			"bike-history-1",
		]);
		expect(JSON.stringify(history)).not.toContain("bike-project");
		expect(JSON.stringify(history)).not.toContain("bike-other-user");
	});

	it("keeps the model-facing Langflow tool contract on memory_context modes only", async () => {
		const { buildOutboundSystemPrompt } = await import("./langflow");
		const prompt = buildOutboundSystemPrompt({
			basePrompt: "Base system prompt",
			inputValue: "What do you remember about my bike setup?",
			modelDisplayName: "Context Harness Model",
		});
		const nodeSource = readFileSync(
			resolve(process.cwd(), "langflow_nodes", "memory_context_tool.py"),
			"utf8",
		);

		expect(prompt).toContain("Memory context workflow");
		expect(prompt).toContain("memory_context");
		expect(prompt).toContain("mode `project`");
		expect(prompt).toContain("mode `persona`");
		expect(prompt).toContain("mode `history`");
		expect(prompt).not.toContain(["project", "context"].join("_"));

		expect(nodeSource).toContain('name = "memory_context"');
		expect(nodeSource).toContain('method="memory_context"');
		expect(nodeSource).toContain("/api/tools/memory-context");
		expect(nodeSource).toContain('options=["persona", "history", "project"]');
		expect(nodeSource).toContain('value="persona"');
		const legacyToolName = ["project", "context"].join("_");
		const legacyToolRoute = `/api/tools/${legacyToolName.replace("_", "-")}`;
		expect(nodeSource).not.toContain(`name = "${legacyToolName}"`);
		expect(nodeSource).not.toContain(`method="${legacyToolName}"`);
		expect(nodeSource).not.toContain(legacyToolRoute);
	});
});
