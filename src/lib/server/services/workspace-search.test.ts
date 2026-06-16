import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDocumentItem } from "$lib/types";

const {
	mockConversationRows,
	mockListLogicalDocuments,
	mockListLogicalDocumentsPage,
	mockSelect,
} = vi.hoisted(() => {
	const mockConversationRows: Array<Record<string, unknown>> = [];
	const mockListLogicalDocuments = vi.fn();
	const mockListLogicalDocumentsPage = vi.fn();
	const mockSelect = vi.fn();

	return {
		mockConversationRows,
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
		name: { name: "project.name" },
	},
	artifacts: {
		id: { name: "artifact.id" },
		contentText: { name: "artifact.contentText" },
		summary: { name: "artifact.summary" },
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions: unknown[]) => conditions),
	asc: vi.fn((field: unknown) => ({ direction: "asc", field })),
	desc: vi.fn((field: unknown) => ({ direction: "desc", field })),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, op: "eq", value })),
	inArray: vi.fn((field: unknown, values: unknown[]) => ({
		field,
		op: "in",
		values,
	})),
	sql: vi.fn(),
}));

vi.mock("$lib/server/services/knowledge/store", () => ({
	listLogicalDocuments: mockListLogicalDocuments,
	listLogicalDocumentsPage: mockListLogicalDocumentsPage,
}));

function makeSelectChain(rows: Array<Record<string, unknown>>) {
	const terminal = {
		orderBy: vi.fn(() => ({
			limit: vi.fn(async () => rows),
		})),
		limit: vi.fn(async () => rows),
	};
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
		mockConversationRows.length = 0;
		mockListLogicalDocuments.mockReset();
		mockListLogicalDocuments.mockResolvedValue([]);
		mockListLogicalDocumentsPage.mockReset();
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

	it("searches openable document metadata and content without returning full content", async () => {
		const { searchWorkspace } = await import("./workspace-search");
		queueSelectChains(
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
		mockListLogicalDocuments.mockResolvedValue([
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
		]);

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
});
