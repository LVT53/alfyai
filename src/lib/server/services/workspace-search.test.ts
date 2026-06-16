import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDocumentItem } from "$lib/types";

const {
	mockEq,
	mockConversationRows,
	mockGetLogicalDocumentForArtifact,
	mockListLogicalDocuments,
	mockListLogicalDocumentsPage,
	mockSelect,
} = vi.hoisted(() => {
	const mockEq = vi.fn((field: unknown, value: unknown) => ({
		field,
		op: "eq",
		value,
	}));
	const mockConversationRows: Array<Record<string, unknown>> = [];
	const mockGetLogicalDocumentForArtifact = vi.fn();
	const mockListLogicalDocuments = vi.fn();
	const mockListLogicalDocumentsPage = vi.fn();
	const mockSelect = vi.fn();

	return {
		mockEq,
		mockConversationRows,
		mockGetLogicalDocumentForArtifact,
		mockListLogicalDocuments,
		mockListLogicalDocumentsPage,
		mockSelect,
	};
});

vi.mock("$lib/server/db", () => ({
	db: {
		select: mockSelect,
	},
}));

vi.mock("$lib/server/db/schema", () => ({
	conversations: {
		id: { name: "conversation.id" },
		userId: { name: "conversation.userId" },
		title: { name: "conversation.title" },
		projectId: { name: "conversation.projectId" },
		status: { name: "conversation.status" },
		sealedAt: { name: "conversation.sealedAt" },
		updatedAt: { name: "conversation.updatedAt" },
	},
	messages: {
		id: { name: "message.id" },
		conversationId: { name: "message.conversationId" },
		role: { name: "message.role" },
		content: { name: "message.content" },
		createdAt: { name: "message.createdAt" },
	},
	projects: {
		id: { name: "project.id" },
		userId: { name: "project.userId" },
		name: { name: "project.name" },
	},
	artifacts: {
		id: { name: "artifact.id" },
		userId: { name: "artifact.userId" },
		type: { name: "artifact.type" },
		retrievalClass: { name: "artifact.retrievalClass" },
		name: { name: "artifact.name" },
		contentText: { name: "artifact.contentText" },
		summary: { name: "artifact.summary" },
		metadataJson: { name: "artifact.metadataJson" },
		updatedAt: { name: "artifact.updatedAt" },
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions: unknown[]) => conditions),
	asc: vi.fn((field: unknown) => ({ direction: "asc", field })),
	desc: vi.fn((field: unknown) => ({ direction: "desc", field })),
	eq: mockEq,
	inArray: vi.fn((field: unknown, values: unknown[]) => ({
		field,
		op: "in",
		values,
	})),
	isNull: vi.fn((field: unknown) => ({ field, op: "isNull" })),
	sql: vi.fn(),
}));

vi.mock("drizzle-orm/sqlite-core", () => ({
	alias: vi.fn((table: Record<string, unknown>, aliasName: string) =>
		Object.fromEntries(
			Object.entries(table).map(([key, value]) => [
				key,
				{
					...(typeof value === "object" && value !== null ? value : {}),
					alias: aliasName,
				},
			]),
		),
	),
}));

vi.mock("$lib/server/services/knowledge/store", () => ({
	getLogicalDocumentForArtifact: mockGetLogicalDocumentForArtifact,
	listLogicalDocuments: mockListLogicalDocuments,
	listLogicalDocumentsPage: mockListLogicalDocumentsPage,
}));

function makeOrderByResult(rows: Array<Record<string, unknown>>) {
	return Object.assign([...rows], {
		limit: vi.fn(async (limit?: number) =>
			typeof limit === "number" ? rows.slice(0, limit) : rows,
		),
	});
}

function makeSelectChain(rows: Array<Record<string, unknown>>) {
	const terminal = {
		orderBy: vi.fn(() => ({
			limit: vi.fn(async (limit?: number) =>
				typeof limit === "number" ? rows.slice(0, limit) : rows,
			),
		})),
		limit: vi.fn(async (limit?: number) =>
			typeof limit === "number" ? rows.slice(0, limit) : rows,
		),
	};
	terminal.orderBy.mockImplementation(() => makeOrderByResult(rows));
	const joinable = {
		leftJoin: vi.fn(() => joinable),
		where: vi.fn(() => terminal),
	};

	return {
		from: vi.fn(() => ({
			leftJoin: joinable.leftJoin,
			where: vi.fn(() => terminal),
		})),
	};
}

function queueSelectChains(
	...responses: Array<Array<Record<string, unknown>>>
) {
	let index = 0;
	mockSelect.mockImplementation(() => {
		const rows = responses[index] ?? responses[responses.length - 1] ?? [];
		index += 1;
		return makeSelectChain(rows);
	});
}

function makeDocument(
	overrides: Partial<KnowledgeDocumentItem>,
): KnowledgeDocumentItem {
	return {
		id: "doc-1",
		type: "source_document",
		displayArtifactId: "doc-1",
		promptArtifactId: null,
		familyArtifactIds: ["doc-1"],
		name: "Notes.pdf",
		mimeType: "application/pdf",
		sizeBytes: 1024,
		conversationId: null,
		summary: null,
		normalizedAvailable: false,
		documentOrigin: "uploaded",
		documentFamilyId: null,
		documentFamilyStatus: null,
		documentLabel: null,
		documentRole: null,
		versionNumber: null,
		originConversationId: null,
		originAssistantMessageId: null,
		sourceChatFileId: null,
		createdAt: 100,
		updatedAt: 100,
		...overrides,
	};
}

describe("searchWorkspace", () => {
	beforeEach(() => {
		mockEq.mockClear();
		mockConversationRows.length = 0;
		mockGetLogicalDocumentForArtifact.mockReset();
		mockGetLogicalDocumentForArtifact.mockResolvedValue(null);
		mockListLogicalDocuments.mockReset();
		mockListLogicalDocuments.mockResolvedValue([]);
		mockListLogicalDocumentsPage.mockReset();
		mockListLogicalDocumentsPage.mockResolvedValue({
			documents: [],
			totalItems: 0,
		});
		mockSelect.mockReset();
		mockSelect.mockImplementation(() => makeSelectChain(mockConversationRows));
	});

	it("returns capped recent conversations and openable documents for empty search", async () => {
		const { searchWorkspace } = await import("./workspace-search");
		mockConversationRows.push(
			{
				id: "conv-4",
				title: "Fourth",
				projectId: null,
				projectName: null,
				status: "open",
				sealedAt: null,
				updatedAt: new Date("2026-04-04T10:00:00Z"),
			},
			{
				id: "conv-3",
				title: "Third",
				projectId: "project-1",
				projectName: "Launch",
				status: "sealed",
				sealedAt: new Date("2026-04-03T10:00:00Z"),
				updatedAt: new Date("2026-04-03T10:00:00Z"),
			},
			{
				id: "conv-2",
				title: "Second",
				projectId: null,
				projectName: null,
				status: "open",
				sealedAt: null,
				updatedAt: new Date("2026-04-02T10:00:00Z"),
			},
		);
		mockListLogicalDocumentsPage.mockResolvedValue({
			documents: [
				makeDocument({
					id: "doc-4",
					displayArtifactId: "doc-4",
					name: "D.pdf",
				}),
				makeDocument({
					id: "doc-3",
					displayArtifactId: "doc-3",
					name: "C.pdf",
				}),
				makeDocument({
					id: "doc-2",
					displayArtifactId: "doc-2",
					name: "B.pdf",
				}),
			],
			totalItems: 4,
		});

		const result = await searchWorkspace("user-1", { query: "" });

		expect(result.mode).toBe("default");
		expect(result.conversations).toHaveLength(3);
		expect(result.conversations.map((item) => item.id)).toEqual([
			"conv-4",
			"conv-3",
			"conv-2",
		]);
		expect(result.conversations[0]).toMatchObject({
			href: "/chat/conv-4",
			match: { type: "recent" },
		});
		expect(result.conversations[1]).toMatchObject({
			projectName: "Launch",
			sealedAt: expect.any(Number),
		});
		expect(result.documents.map((item) => item.displayArtifactId)).toEqual([
			"doc-4",
			"doc-3",
			"doc-2",
		]);
		expect(result.documents[0]).toMatchObject({
			href: "/knowledge?open_artifact=doc-4&open_filename=D.pdf&open_mime=application%2Fpdf",
			match: { type: "recent" },
		});
		expect(mockListLogicalDocumentsPage).toHaveBeenCalledWith("user-1", {
			includeGeneratedOutputs: true,
			limit: 3,
			sortDirection: "desc",
			sortKey: "date",
		});
	});

	it("searches conversation title, project metadata, and body with focus navigation", async () => {
		const { searchWorkspace } = await import("./workspace-search");
		queueSelectChains(
			[
				{
					id: "conv-title",
					title: "Zephyr launch plan",
					projectId: null,
					projectName: null,
					status: "open",
					sealedAt: null,
					updatedAt: new Date("2026-04-04T10:00:00Z"),
				},
				{
					id: "conv-project",
					title: "Weekly notes",
					projectId: "project-1",
					projectName: "Zephyr Folder",
					status: "open",
					sealedAt: null,
					updatedAt: new Date("2026-04-05T10:00:00Z"),
				},
			],
			[
				{
					id: "conv-body",
					title: "Imported chat",
					projectId: null,
					projectName: null,
					status: "sealed",
					sealedAt: new Date("2026-04-06T10:00:00Z"),
					updatedAt: new Date("2026-04-06T10:00:00Z"),
					messageId: "message-1",
					messageRole: "assistant",
					messageContent:
						"Long background before the body match. The key Zephyr decision lives in this assistant message and should be clipped.",
					messageCreatedAt: new Date("2026-04-06T10:01:00Z"),
				},
			],
		);

		const result = await searchWorkspace("user-1", { query: "zephyr" });

		expect(result.mode).toBe("query");
		expect(result.conversations.map((item) => item.id)).toEqual([
			"conv-title",
			"conv-project",
			"conv-body",
		]);
		expect(result.conversations[0].match).toMatchObject({
			type: "title",
			messageId: null,
		});
		expect(result.conversations[1].match).toMatchObject({
			type: "project",
		});
		expect(result.conversations[2]).toMatchObject({
			href: "/chat/conv-body?focus_message=message-1",
			status: "sealed",
			match: {
				type: "body",
				messageId: "message-1",
				messageRole: "assistant",
			},
		});
		expect(result.conversations[2].match.snippet).toContain("Zephyr");
	});

	it("finds old conversation title matches outside the recent sidebar scan", async () => {
		const { searchWorkspace } = await import("./workspace-search");
		const recentNonMatches = Array.from({ length: 200 }, (_, index) => ({
			id: `recent-${index}`,
			title: `Recent notes ${index}`,
			projectId: null,
			projectName: null,
			status: "open",
			sealedAt: null,
			updatedAt: new Date(
				`2026-04-${String((index % 20) + 1).padStart(2, "0")}T10:00:00Z`,
			),
		}));
		queueSelectChains(
			[
				...recentNonMatches,
				{
					id: "old-title",
					title: "Zephyr archive plan",
					projectId: null,
					projectName: null,
					status: "open",
					sealedAt: null,
					updatedAt: new Date("2025-01-01T10:00:00Z"),
				},
			],
			[],
			[],
		);

		const result = await searchWorkspace("user-1", { query: "zephyr" });

		expect(result.conversations.map((item) => item.id)).toContain("old-title");
		expect(
			result.conversations.find((item) => item.id === "old-title")?.match,
		).toMatchObject({
			type: "title",
			messageId: null,
		});
	});

	it("scopes project-name joins to the requesting user", async () => {
		const { searchWorkspace } = await import("./workspace-search");
		queueSelectChains([], [], []);

		await searchWorkspace("user-1", { query: "zephyr" });

		expect(mockEq).toHaveBeenCalledWith({ name: "project.userId" }, "user-1");
	});

	it("keeps at most one body match per conversation before ranking results", async () => {
		const { searchWorkspace } = await import("./workspace-search");
		const busyMessages = Array.from({ length: 500 }, (_, index) => ({
			id: "busy-conv",
			title: "Busy import",
			projectId: null,
			projectName: null,
			status: "open",
			sealedAt: null,
			updatedAt: new Date("2026-04-10T10:00:00Z"),
			messageId: `busy-message-${index}`,
			messageRole: "user",
			messageContent: `Atlas note ${index}`,
			messageCreatedAt: new Date(
				`2026-04-10T10:${String(index % 60).padStart(2, "0")}:00Z`,
			),
		}));
		queueSelectChains(
			[],
			[
				...busyMessages,
				{
					id: "other-conv",
					title: "Other conversation",
					projectId: null,
					projectName: null,
					status: "open",
					sealedAt: null,
					updatedAt: new Date("2026-03-01T10:00:00Z"),
					messageId: "other-message",
					messageRole: "assistant",
					messageContent: "Atlas appears in a quieter conversation too.",
					messageCreatedAt: new Date("2026-03-01T10:01:00Z"),
				},
			],
			[],
		);

		const result = await searchWorkspace("user-1", { query: "atlas" });

		expect(result.conversations.map((item) => item.id)).toContain("busy-conv");
		expect(result.conversations.map((item) => item.id)).toContain("other-conv");
		expect(
			result.conversations.filter((item) => item.id === "busy-conv"),
		).toHaveLength(1);
	});

	it("searches openable document metadata and content without returning full content", async () => {
		const { searchWorkspace } = await import("./workspace-search");
		queueSelectChains(
			[],
			[],
			[],
			[
				{
					id: "prompt-doc",
					contentText:
						"Background paragraph before the key Atlas renewal clause that should be clipped rather than sent whole to the shell modal.",
					summary: "Contract notes",
				},
			],
		);
		mockListLogicalDocumentsPage.mockResolvedValue({
			documents: [
				makeDocument({
					id: "source-doc",
					displayArtifactId: "source-doc",
					promptArtifactId: "prompt-doc",
					familyArtifactIds: ["source-doc", "prompt-doc"],
					name: "Renewal terms.pdf",
					documentOrigin: "uploaded",
					normalizedAvailable: true,
					originConversationId: "conv-source",
					originAssistantMessageId: "assistant-source",
				}),
			],
			totalItems: 1,
		});
		mockGetLogicalDocumentForArtifact.mockResolvedValue(
			makeDocument({
				id: "source-doc",
				displayArtifactId: "source-doc",
				promptArtifactId: "prompt-doc",
				familyArtifactIds: ["source-doc", "prompt-doc"],
				name: "Renewal terms.pdf",
				documentOrigin: "uploaded",
				normalizedAvailable: true,
				originConversationId: "conv-source",
				originAssistantMessageId: "assistant-source",
			}),
		);

		const result = await searchWorkspace("user-1", { query: "atlas" });

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0]).toMatchObject({
			displayArtifactId: "source-doc",
			promptArtifactId: "prompt-doc",
			href: "/knowledge?open_artifact=source-doc&open_filename=Renewal+terms.pdf&open_mime=application%2Fpdf",
			sourceHref: "/chat/conv-source?focus_message=assistant-source",
			match: {
				type: "content",
			},
		});
		expect(result.documents[0].match.snippet).toContain("Atlas renewal");
		expect(result.documents[0].match.snippet).not.toContain(
			"rather than sent whole to the shell modal",
		);
	});

	it("uses bounded logical document and content candidates instead of loading every document", async () => {
		const { searchWorkspace } = await import("./workspace-search");
		const metadataDocument = makeDocument({
			id: "metadata-doc",
			displayArtifactId: "metadata-doc",
			name: "Atlas renewal memo.pdf",
			summary: "Metadata match",
			normalizedAvailable: false,
			updatedAt: 200,
		});
		const contentDocument = makeDocument({
			id: "source-doc",
			displayArtifactId: "source-doc",
			promptArtifactId: "prompt-doc",
			familyArtifactIds: ["source-doc", "prompt-doc"],
			name: "Renewal terms.pdf",
			normalizedAvailable: true,
		});
		queueSelectChains(
			[],
			[],
			[
				{
					id: "metadata-doc",
					userId: "user-1",
					type: "source_document",
					conversationId: null,
					name: "Atlas renewal memo.pdf",
					summary: "Metadata match",
					metadataJson: null,
					updatedAt: new Date("2026-04-05T10:00:00Z"),
				},
			],
			[
				{
					id: "prompt-doc",
					userId: "user-1",
					type: "normalized_document",
					conversationId: null,
					contentText:
						"Background paragraph before the key Atlas renewal clause that should be clipped rather than sent whole to the shell modal.",
					summary: "Contract notes",
					updatedAt: new Date("2026-04-04T10:00:00Z"),
				},
			],
			[
				{
					id: "prompt-doc",
					contentText:
						"Background paragraph before the key Atlas renewal clause that should be clipped rather than sent whole to the shell modal.",
					summary: "Contract notes",
				},
			],
		);
		mockListLogicalDocumentsPage.mockResolvedValue({
			documents: [],
			totalItems: 0,
		});
		mockGetLogicalDocumentForArtifact.mockImplementation(
			async (_userId: string, artifactId: string) =>
				artifactId === "metadata-doc" ? metadataDocument : contentDocument,
		);

		const result = await searchWorkspace("user-1", { query: "atlas" });

		expect(mockListLogicalDocuments).not.toHaveBeenCalled();
		expect(mockListLogicalDocumentsPage).not.toHaveBeenCalled();
		expect(mockGetLogicalDocumentForArtifact).toHaveBeenCalledWith(
			"user-1",
			"metadata-doc",
		);
		expect(mockGetLogicalDocumentForArtifact).toHaveBeenCalledWith(
			"user-1",
			"prompt-doc",
		);
		expect(result.documents).toHaveLength(2);
		expect(result.documents[0]).toMatchObject({
			displayArtifactId: "metadata-doc",
			match: { type: "name" },
		});
		expect(result.documents[1]).toMatchObject({
			displayArtifactId: "source-doc",
			match: { type: "content" },
		});
		expect(result.documents[1].match.snippet).toContain("Atlas renewal");
		expect(result.documents[1].match.snippet).not.toContain(
			"rather than sent whole to the shell modal",
		);
	});
});
