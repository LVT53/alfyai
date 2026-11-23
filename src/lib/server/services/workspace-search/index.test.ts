import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDocumentItem } from "$lib/server/services/knowledge/types";

const {
	mockBuildArtifactVisibilityCondition,
	mockEq,
	mockConversationRows,
	mockGetArtifactOwnershipScope,
	mockGetArtifactVersionNumbers,
	mockGetLogicalDocumentForArtifact,
	mockIsArtifactCanonicallyOwned,
	mockListLogicalDocuments,
	mockListLogicalDocumentsPage,
	mockSearchChats,
	mockSelect,
} = vi.hoisted(() => {
	const mockBuildArtifactVisibilityCondition = vi.fn((params: unknown) => ({
		kind: "visibility",
		params,
	}));
	const mockEq = vi.fn((field: unknown, value: unknown) => ({
		field,
		op: "eq",
		value,
	}));
	const mockConversationRows: Array<Record<string, unknown>> = [];
	const mockGetArtifactOwnershipScope = vi.fn();
	const mockGetArtifactVersionNumbers = vi.fn();
	const mockGetLogicalDocumentForArtifact = vi.fn();
	const mockIsArtifactCanonicallyOwned = vi.fn();
	const mockListLogicalDocuments = vi.fn();
	const mockListLogicalDocumentsPage = vi.fn();
	const mockSearchChats = vi.fn();
	const mockSelect = vi.fn();

	return {
		mockBuildArtifactVisibilityCondition,
		mockEq,
		mockConversationRows,
		mockGetArtifactOwnershipScope,
		mockGetArtifactVersionNumbers,
		mockGetLogicalDocumentForArtifact,
		mockIsArtifactCanonicallyOwned,
		mockListLogicalDocuments,
		mockListLogicalDocumentsPage,
		mockSearchChats,
		mockSelect,
	};
});

// Chat matching is SQL over real tables; chats.test.ts runs it on a real
// database. The recent-chats view stays real here and reads through the mocked
// select chain below, like the documents' loaders do.
vi.mock("./chats", async (importOriginal) => ({
	...(await importOriginal<typeof import("./chats")>()),
	searchChats: mockSearchChats,
}));

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
		conversationId: { name: "artifact.conversationId" },
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

// The extraction module defines its job kind when it is imported, which reads the
// real schema; this test fakes the schema wholesale and reads no extraction jobs.
vi.mock("$lib/server/services/extraction", () => ({
	getExtractionJobsForArtifacts: vi.fn(async () => []),
}));

// `mapArtifactFamilyRow` is the REAL implementation (imported, not mocked):
// it is a pure row → KnowledgeDocumentItem mapper with no DB calls of its
// own, so exercising it for real is what proves the artifact-family
// candidate loader's output actually carries `kind`/`artifactVersionNumber`.
// Everything else that talks to the database stays mocked.
vi.mock("$lib/server/services/knowledge/store", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("$lib/server/services/knowledge/store")
		>();
	return {
		buildArtifactVisibilityCondition: mockBuildArtifactVisibilityCondition,
		getArtifactOwnershipScope: mockGetArtifactOwnershipScope,
		getArtifactVersionNumbers: mockGetArtifactVersionNumbers,
		getLogicalDocumentForArtifact: mockGetLogicalDocumentForArtifact,
		isArtifactCanonicallyOwned: mockIsArtifactCanonicallyOwned,
		knowledgeArtifactListSelection: {},
		listLogicalDocuments: mockListLogicalDocuments,
		listLogicalDocumentsPage: mockListLogicalDocumentsPage,
		mapArtifactFamilyRow: actual.mapArtifactFamilyRow,
	};
});

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
		mockBuildArtifactVisibilityCondition.mockClear();
		mockEq.mockClear();
		mockConversationRows.length = 0;
		mockGetArtifactOwnershipScope.mockReset();
		mockGetArtifactOwnershipScope.mockResolvedValue({
			conversationIds: new Set(["conversation-owned"]),
		});
		mockGetArtifactVersionNumbers.mockReset();
		mockGetArtifactVersionNumbers.mockResolvedValue(new Map());
		mockGetLogicalDocumentForArtifact.mockReset();
		mockGetLogicalDocumentForArtifact.mockResolvedValue(null);
		mockIsArtifactCanonicallyOwned.mockReset();
		mockIsArtifactCanonicallyOwned.mockReturnValue(true);
		mockListLogicalDocuments.mockReset();
		mockListLogicalDocuments.mockResolvedValue([]);
		mockListLogicalDocumentsPage.mockReset();
		mockListLogicalDocumentsPage.mockResolvedValue({
			documents: [],
			totalItems: 0,
		});
		mockSearchChats.mockReset();
		mockSearchChats.mockResolvedValue({
			results: [],
			total: 0,
			hasMore: false,
		});
		mockSelect.mockReset();
		mockSelect.mockImplementation(() => makeSelectChain(mockConversationRows));
	});

	it("returns capped recent conversations and openable documents for empty search", async () => {
		const { searchWorkspace } = await import("./index");
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

	it("searches openable document metadata and content without returning full content", async () => {
		const { searchWorkspace } = await import("./index");
		const promptDocTextRow = {
			id: "prompt-doc",
			contentText:
				"Background paragraph before the key Atlas renewal clause that should be clipped rather than sent whole to the shell modal.",
			summary: "Contract notes",
		};
		queueSelectChains(
			[],
			[promptDocTextRow],
			// No artifact-family candidates in this fixture.
			[],
			// loadArtifactTextRows, called after the candidate documents (and the
			// family query above) resolve, for the same "prompt-doc" content.
			[promptDocTextRow],
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
		const { searchWorkspace } = await import("./index");
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
					conversationId: "conversation-owned",
					contentText:
						"Background paragraph before the key Atlas renewal clause that should be clipped rather than sent whole to the shell modal.",
					summary: "Contract notes",
					updatedAt: new Date("2026-04-04T10:00:00Z"),
				},
			],
			// No artifact-family candidates in this fixture.
			[],
			[
				{
					id: "prompt-doc",
					userId: "user-1",
					type: "normalized_document",
					conversationId: "conversation-owned",
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
		expect(mockGetArtifactOwnershipScope).toHaveBeenCalledWith("user-1");
		expect(mockBuildArtifactVisibilityCondition).toHaveBeenCalledWith({
			userId: "user-1",
			ownershipScope: { conversationIds: new Set(["conversation-owned"]) },
		});
		expect(mockIsArtifactCanonicallyOwned).toHaveBeenCalledWith({
			userId: "user-1",
			ownershipScope: { conversationIds: new Set(["conversation-owned"]) },
			artifact: expect.objectContaining({
				id: "prompt-doc",
				conversationId: "conversation-owned",
			}),
		});
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

	// Slice 7 (Feature 2, ADR-0066): the artifact family's own candidate
	// loader. Unlike the two loaders above, it returns full
	// KnowledgeDocumentItems directly (mapArtifactFamilyRow is the REAL
	// implementation here — see the module mock's own comment).
	describe("the artifact family's typed-query candidates", () => {
		it("finds a row by name and carries its kind on the result", async () => {
			const { searchWorkspace } = await import("./index");
			const familyRow = {
				id: "art-canvas-1",
				userId: "user-1",
				type: "artifact",
				conversationId: "conversation-owned",
				name: "Vienna trip board",
				metadataJson: JSON.stringify({
					artifactType: "canvas",
					title: "Vienna trip board",
				}),
				createdAt: new Date("2026-04-05T10:00:00Z"),
				updatedAt: new Date("2026-04-05T10:00:00Z"),
			};
			queueSelectChains(
				[], // legacy metadata candidates
				[], // legacy content candidates
				[familyRow], // artifact-family candidates
				[], // loadArtifactTextRows — artifactIds is non-empty now
			);
			mockGetArtifactVersionNumbers.mockResolvedValue(
				new Map([["art-canvas-1", 7]]),
			);

			const result = await searchWorkspace("user-1", { query: "vienna" });

			expect(result.documents).toHaveLength(1);
			expect(result.documents[0]).toMatchObject({
				displayArtifactId: "art-canvas-1",
				name: "Vienna trip board",
				kind: "canvas",
				match: { type: "name" },
			});
		});

		it("never surfaces an App from its body content alone — the re-score guard refuses to read it (Review Focus #3)", async () => {
			const { searchWorkspace } = await import("./index");
			// Simulates the defence-in-depth case: even if a row like this
			// somehow became a candidate, `scoreDocument`'s own App guard must
			// still refuse to score it by content — the candidate loader's SQL
			// exclusion is not the only place this is enforced.
			const appRow = {
				id: "art-app-1",
				userId: "user-1",
				type: "artifact",
				conversationId: "conversation-owned",
				name: "Trip cost splitter",
				metadataJson: JSON.stringify({
					artifactType: "app",
					title: "Trip cost splitter",
				}),
				createdAt: new Date("2026-04-05T10:00:00Z"),
				updatedAt: new Date("2026-04-05T10:00:00Z"),
			};
			queueSelectChains(
				[],
				[],
				[appRow],
				[
					{
						id: "art-app-1",
						contentText: '<div class="budget">budget total</div>',
						summary: null,
					},
				],
			);

			const result = await searchWorkspace("user-1", { query: "budget" });

			expect(result.documents).toHaveLength(0);
		});

		it("excludes a candidate that isArtifactCanonicallyOwned refuses, mirroring the other two loaders", async () => {
			const { searchWorkspace } = await import("./index");
			const foreignRow = {
				id: "art-foreign-1",
				userId: "someone-else",
				type: "artifact",
				conversationId: "conversation-foreign",
				name: "Not yours",
				metadataJson: JSON.stringify({
					artifactType: "document",
					title: "Not yours",
				}),
				createdAt: new Date("2026-04-05T10:00:00Z"),
				updatedAt: new Date("2026-04-05T10:00:00Z"),
			};
			queueSelectChains([], [], [foreignRow]);
			mockIsArtifactCanonicallyOwned.mockImplementation(
				(params: { artifact: { id: string } }) =>
					params.artifact.id !== "art-foreign-1",
			);

			const result = await searchWorkspace("user-1", { query: "yours" });

			expect(result.documents).toHaveLength(0);
		});

		it("already includes an artifact-family row in the default (empty-query) view, with no further code change", async () => {
			const { searchWorkspace } = await import("./index");
			mockListLogicalDocumentsPage.mockResolvedValue({
				documents: [
					makeDocument({
						id: "art-canvas-1",
						displayArtifactId: "art-canvas-1",
						name: "Vienna trip board",
						kind: "canvas",
						artifactVersionNumber: 7,
						familyArtifactIds: ["art-canvas-1"],
						promptArtifactId: null,
						normalizedAvailable: false,
					}),
				],
				totalItems: 1,
			});

			const result = await searchWorkspace("user-1", { query: "" });

			expect(result.mode).toBe("default");
			expect(result.documents).toHaveLength(1);
			expect(result.documents[0]).toMatchObject({
				displayArtifactId: "art-canvas-1",
				kind: "canvas",
			});
		});
	});
});
