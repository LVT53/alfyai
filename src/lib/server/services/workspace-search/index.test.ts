import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	WorkspaceSearchConversationResult,
	WorkspaceSearchDocumentResult,
} from "./types";

// `searchWorkspace` is the wiring between the kinds: what it asks each of them
// for, under which scope and cursor, and how it sums their answers. Each kind's
// matching is tested on a real database beside it (chats.test.ts,
// documents.test.ts).
const {
	mockRecentChats,
	mockRecentDocuments,
	mockSearchChats,
	mockSearchDocuments,
} = vi.hoisted(() => ({
	mockRecentChats: vi.fn(),
	mockRecentDocuments: vi.fn(),
	mockSearchChats: vi.fn(),
	mockSearchDocuments: vi.fn(),
}));

vi.mock("./chats", () => ({
	recentChats: mockRecentChats,
	searchChats: mockSearchChats,
}));

vi.mock("./documents", () => ({
	recentDocuments: mockRecentDocuments,
	searchDocuments: mockSearchDocuments,
}));

const { searchWorkspace } = await import("./index");

function chat(id: string): WorkspaceSearchConversationResult {
	return {
		id,
		title: id,
		projectId: null,
		projectName: null,
		status: "open",
		sealedAt: null,
		updatedAt: 100,
		href: `/chat/${id}`,
		match: {
			type: "recent",
			snippet: null,
			messageId: null,
			messageRole: null,
		},
	};
}

function document(
	id: string,
	searchKind: WorkspaceSearchDocumentResult["searchKind"] = "documents",
): WorkspaceSearchDocumentResult {
	return {
		id,
		displayArtifactId: id,
		promptArtifactId: null,
		familyArtifactIds: [id],
		name: id,
		mimeType: null,
		sizeBytes: null,
		conversationId: null,
		summary: null,
		updatedAt: 100,
		href: `/knowledge?open_artifact=${id}`,
		sourceHref: null,
		searchKind,
		badge: "document",
		originConversationTitle: null,
		preview: null,
		durationMs: null,
		match: { type: "name", snippet: null },
	};
}

const NO_DOCUMENTS = {
	results: [],
	totals: { documents: 0, media: 0, apps: 0 },
	hasMore: false,
};

beforeEach(() => {
	vi.clearAllMocks();
	mockRecentChats.mockResolvedValue([]);
	mockRecentDocuments.mockResolvedValue([]);
	mockSearchChats.mockResolvedValue({ results: [], total: 0, hasMore: false });
	mockSearchDocuments.mockResolvedValue(NO_DOCUMENTS);
});

describe("searchWorkspace", () => {
	it("shows three recent chats and three recent documents for an empty query", async () => {
		mockRecentChats.mockResolvedValue([chat("c4"), chat("c3"), chat("c2")]);
		mockRecentDocuments.mockResolvedValue([
			document("d3"),
			document("p1", "media"),
		]);

		const result = await searchWorkspace("user-1", { query: "" });

		expect(mockRecentChats).toHaveBeenCalledWith("user-1", 3);
		expect(mockRecentDocuments).toHaveBeenCalledWith("user-1", 3);
		expect(mockSearchChats).not.toHaveBeenCalled();
		expect(mockSearchDocuments).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			query: "",
			mode: "default",
			scope: "all",
			memories: [],
			memorySearchable: false,
			nextCursor: null,
			totals: { chats: 3, memory: 0, documents: 1, media: 1, apps: 0 },
		});
		expect(result.conversations.map((row) => row.id)).toEqual([
			"c4",
			"c3",
			"c2",
		]);
		expect(result.documents.map((row) => row.id)).toEqual(["d3", "p1"]);
	});

	it("shows the empty-query view for a query that is one letter or only punctuation", async () => {
		for (const query of ["a", "!!", " ", "..", "a!"]) {
			const result = await searchWorkspace("user-1", { query });
			expect(result.mode, query).toBe("default");
		}
		expect(mockSearchChats).not.toHaveBeenCalled();
		expect(mockSearchDocuments).not.toHaveBeenCalled();
		const shortWords = await searchWorkspace("user-1", { query: "a b" });
		expect(shortWords.mode).toBe("query");
	});

	it("asks every kind for its few under All, with each word of the query", async () => {
		mockSearchChats.mockResolvedValue({
			results: [chat("c1")],
			total: 43,
			hasMore: true,
		});
		mockSearchDocuments.mockResolvedValue({
			results: [document("d1"), document("a1", "apps")],
			totals: { documents: 4, media: 0, apps: 1 },
			hasMore: false,
		});

		const result = await searchWorkspace("user-1", {
			query: "  Kitchen   PLAN ",
		});

		expect(mockSearchChats).toHaveBeenCalledWith(
			"user-1",
			{ terms: ["kitchen", "plan"], words: ["kitchen", "plan"] },
			{ offset: 0, limit: 3 },
		);
		expect(mockSearchDocuments).toHaveBeenCalledWith(
			"user-1",
			{ terms: ["kitchen", "plan"], words: ["kitchen", "plan"] },
			"all",
			{ offset: 0, limit: 3 },
		);
		expect(result).toMatchObject({
			query: "Kitchen   PLAN",
			mode: "query",
			scope: "all",
			nextCursor: null,
			totals: { chats: 43, memory: 0, documents: 4, media: 0, apps: 1 },
		});
	});

	it("pages chats from the cursor and only counts the other kinds", async () => {
		mockSearchChats.mockResolvedValue({
			results: [chat("c21")],
			total: 100,
			hasMore: true,
		});
		mockSearchDocuments.mockResolvedValue({
			results: [],
			totals: { documents: 5, media: 2, apps: 0 },
			hasMore: false,
		});

		const result = await searchWorkspace("user-1", {
			query: "hello",
			scope: "chats",
			cursor: "o:20",
		});

		expect(mockSearchChats).toHaveBeenCalledWith("user-1", expect.anything(), {
			offset: 20,
			limit: 20,
		});
		expect(mockSearchDocuments).toHaveBeenCalledWith(
			"user-1",
			expect.anything(),
			"chats",
			{ offset: 0, limit: 0 },
		);
		expect(result.scope).toBe("chats");
		expect(result.nextCursor).toBe("o:40");
		expect(result.totals).toEqual({
			chats: 100,
			memory: 0,
			documents: 5,
			media: 2,
			apps: 0,
		});
	});

	it("pages one document kind from the cursor and only counts the chats", async () => {
		mockSearchChats.mockResolvedValue({
			results: [],
			total: 7,
			hasMore: false,
		});
		mockSearchDocuments.mockResolvedValue({
			results: [document("p21", "media")],
			totals: { documents: 1, media: 30, apps: 0 },
			hasMore: true,
		});

		const result = await searchWorkspace("user-1", {
			query: "thesis",
			scope: "media",
			cursor: "o:20",
		});

		expect(mockSearchChats).toHaveBeenCalledWith("user-1", expect.anything(), {
			offset: 0,
			limit: 0,
		});
		expect(mockSearchDocuments).toHaveBeenCalledWith(
			"user-1",
			expect.anything(),
			"media",
			{ offset: 20, limit: 20 },
		);
		expect(result.nextCursor).toBe("o:40");
		expect(result.documents.map((row) => row.id)).toEqual(["p21"]);
		expect(result.totals.media).toBe(30);
	});

	it("leaves out the next cursor when a kind has no more", async () => {
		mockSearchDocuments.mockResolvedValue({
			results: [document("a1", "apps")],
			totals: { documents: 0, media: 0, apps: 1 },
			hasMore: false,
		});
		const result = await searchWorkspace("user-1", {
			query: "countdown",
			scope: "apps",
		});
		expect(result.nextCursor).toBeNull();
	});

	it("reads a cursor it cannot understand as the first page", async () => {
		for (const cursor of ["garbage", "o:", "o:-5", "p:20", "", null]) {
			mockSearchChats.mockClear();
			await searchWorkspace("user-1", {
				query: "hello",
				scope: "chats",
				cursor,
			});
			expect(mockSearchChats, String(cursor)).toHaveBeenCalledWith(
				"user-1",
				expect.anything(),
				{ offset: 0, limit: 20 },
			);
		}
	});

	it("reads nothing but the counts for the memory scope", async () => {
		await searchWorkspace("user-1", { query: "thesis", scope: "memory" });
		expect(mockSearchChats).toHaveBeenCalledWith("user-1", expect.anything(), {
			offset: 0,
			limit: 0,
		});
		expect(mockSearchDocuments).toHaveBeenCalledWith(
			"user-1",
			expect.anything(),
			"memory",
			{ offset: 0, limit: 0 },
		);
	});

	it("still says whether more documents exist, for the row that links to Knowledge", async () => {
		mockSearchDocuments.mockResolvedValue({
			results: [document("d1")],
			totals: { documents: 5, media: 0, apps: 0 },
			hasMore: false,
		});
		const result = await searchWorkspace("user-1", { query: "plan" });
		expect(result.documentOverflow).toBe(true);
		expect(result.knowledgeHref).toBe("/knowledge?query=plan");
	});
});
