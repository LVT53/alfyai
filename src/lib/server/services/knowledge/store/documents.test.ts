import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, KnowledgeDocumentItem } from "$lib/types";
import { buildGeneratedOutputDocumentMetadata } from "./document-metadata";
import {
	makeArtifactRow,
	makeSelectOrderByResult,
	makeSelectResult,
	queueMockResponses,
} from "./test-fixtures";
import { resolveWorkingDocumentIdentity } from "./working-document-identity";

type SemanticShortlistMatch = {
	item: { id: string };
	subjectId: string;
	semanticScore: number;
};

type RerankResult = {
	items: Array<{ item: Artifact; index: number; score: number }>;
	confidence: number;
};

const {
	mockRows,
	mockDerivedRows,
	mockSelect,
	mockShortlistSemanticMatchesBySubject,
	mockCanUseTeiReranker,
	mockRerankItems,
} = vi.hoisted(() => {
	const mockRows: Array<Record<string, unknown>> = [];
	const mockDerivedRows: Array<Record<string, unknown>> = [];
	const mockSelect = vi.fn();
	const mockShortlistSemanticMatchesBySubject = vi.fn(
		async (_params: { items: Array<{ id: string }>; subjectType: string }) =>
			[] as SemanticShortlistMatch[],
	);
	const mockCanUseTeiReranker = vi.fn(() => true);
	const mockRerankItems = vi.fn(async () => null as RerankResult | null);

	return {
		mockRows,
		mockDerivedRows,
		mockSelect,
		mockShortlistSemanticMatchesBySubject,
		mockCanUseTeiReranker,
		mockRerankItems,
	};
});

vi.mock("$lib/server/db", () => ({
	db: {
		select: mockSelect,
	},
}));

vi.mock("$lib/server/db/schema", () => ({
	conversations: {
		id: { name: "id" },
		userId: { name: "userId" },
	},
	artifacts: {
		id: { name: "id" },
		userId: { name: "userId" },
		type: { name: "type" },
		retrievalClass: { name: "retrievalClass" },
		name: { name: "name" },
		mimeType: { name: "mimeType" },
		sizeBytes: { name: "sizeBytes" },
		conversationId: { name: "conversationId" },
		summary: { name: "summary" },
		metadataJson: { name: "metadataJson" },
		createdAt: { name: "createdAt" },
		updatedAt: { name: "updatedAt" },
		contentText: { name: "contentText" },
	},
	artifactLinks: {
		artifactId: { name: "artifactId" },
		relatedArtifactId: { name: "relatedArtifactId" },
		userId: { name: "userId" },
		linkType: { name: "linkType" },
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions: unknown[]) => conditions),
	asc: vi.fn(() => "asc"),
	desc: vi.fn(() => "desc"),
	eq: vi.fn((field: { name: string }, value: unknown) => ({
		field: field.name,
		value,
	})),
	inArray: vi.fn((field: { name: string }, value: unknown[]) => ({
		field: field.name,
		value,
	})),
	isNull: vi.fn((field: { name: string }) => ({
		field: field.name,
		isNull: true,
	})),
	like: vi.fn(),
	ne: vi.fn(),
	or: vi.fn(),
	sql: vi.fn(),
}));

vi.mock("../../semantic-ranking", () => ({
	shortlistSemanticMatchesBySubject: mockShortlistSemanticMatchesBySubject,
}));

vi.mock("../../tei-reranker", () => ({
	canUseTeiReranker: mockCanUseTeiReranker,
	rerankItems: mockRerankItems,
}));

function expectDocumentIdentity(document: KnowledgeDocumentItem) {
	const identity = resolveWorkingDocumentIdentity(document);

	expect(document.displayArtifactId).toBe(identity.display.artifactId);
	expect(document.promptArtifactId).toBe(identity.prompt?.artifactId ?? null);
	expect(document.familyArtifactIds).toEqual(identity.family.artifactIds);
	expect(document.sourceChatFileId ?? null).toBe(
		identity.preview.sourceChatFileId,
	);
}

describe("knowledge documents store", () => {
	beforeEach(() => {
		mockRows.length = 0;
		mockDerivedRows.length = 0;
		mockSelect.mockReset();
		mockShortlistSemanticMatchesBySubject.mockReset();
		mockShortlistSemanticMatchesBySubject.mockResolvedValue([]);
		mockCanUseTeiReranker.mockReset();
		mockCanUseTeiReranker.mockReturnValue(true);
		mockRerankItems.mockReset();
		mockRerankItems.mockResolvedValue(null);
	});

	it("treats generated outputs as logical documents grouped by family metadata", async () => {
		mockRows.push(
			makeArtifactRow({
				id: "source-1",
				userId: "user-1",
				type: "source_document",
				retrievalClass: "durable",
				name: "notes.pdf",
				mimeType: "application/pdf",
				sizeBytes: 1024,
				conversationId: null,
				summary: "Uploaded notes",
			}),
			makeArtifactRow({
				id: "normalized-1",
				userId: "user-1",
				type: "normalized_document",
				retrievalClass: "durable",
				name: "notes.txt",
				mimeType: "text/plain",
				sizeBytes: 512,
				conversationId: null,
				summary: "Normalized notes",
				metadataJson: JSON.stringify({ sourceArtifactId: "source-1" }),
				createdAt: new Date("2026-04-01T10:01:00Z"),
				updatedAt: new Date("2026-04-01T10:01:00Z"),
			}),
			makeArtifactRow({
				id: "gen-1",
				type: "generated_output",
				retrievalClass: "durable",
				name: "brief-v1.docx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				sizeBytes: 2048,
				conversationId: "conv-1",
				summary: "First brief draft",
				metadataJson: JSON.stringify(
					buildGeneratedOutputDocumentMetadata({
						familyId: "family-brief",
						label: "Project brief",
						role: "brief",
						versionNumber: 1,
						sourceChatFileId: "chat-file-1",
					}),
				),
				createdAt: new Date("2026-04-02T10:00:00Z"),
				updatedAt: new Date("2026-04-02T10:00:00Z"),
			}),
			makeArtifactRow({
				id: "gen-2",
				type: "generated_output",
				retrievalClass: "durable",
				name: "brief-v2.docx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				sizeBytes: 3072,
				conversationId: "conv-2",
				summary: "Second brief draft",
				metadataJson: JSON.stringify(
					buildGeneratedOutputDocumentMetadata({
						familyId: "family-brief",
						label: "Project brief",
						role: "brief",
						versionNumber: 2,
						sourceChatFileId: "chat-file-2",
					}),
				),
				createdAt: new Date("2026-04-03T10:00:00Z"),
				updatedAt: new Date("2026-04-03T10:00:00Z"),
			}),
		);

		mockDerivedRows.push({
			normalizedArtifactId: "normalized-1",
			sourceArtifactId: "source-1",
		});

		queueMockResponses(mockSelect, [
			makeSelectResult([{ id: "conv-1" }, { id: "conv-2" }]),
			makeSelectOrderByResult(mockRows),
			makeSelectResult(mockDerivedRows),
		]);

		const { listLogicalDocuments } = await import("./documents");
		const documents = await listLogicalDocuments("user-1", {
			includeGeneratedOutputs: true,
		});

		const generatedDocument = documents.find(
			(document) => document.documentFamilyId === "family-brief",
		);

		expect(generatedDocument).toBeDefined();
		if (!generatedDocument) throw new Error("Expected generated document");
		expectDocumentIdentity(generatedDocument);
		expect(generatedDocument).toMatchObject({
			displayArtifactId: "gen-2",
			promptArtifactId: "gen-2",
			name: "brief-v2.docx",
			documentOrigin: "generated",
			documentFamilyId: "family-brief",
			documentLabel: "Project brief",
			documentRole: "brief",
			versionNumber: 2,
			normalizedAvailable: true,
		});
		expect(generatedDocument?.familyArtifactIds).toEqual(
			expect.arrayContaining(["gen-1", "gen-2"]),
		);
	});

	it("maps uploaded source-plus-normalized documents through working document identity", async () => {
		mockRows.push(
			makeArtifactRow({
				id: "source-1",
				userId: "user-1",
				type: "source_document",
				retrievalClass: "durable",
				name: "notes.pdf",
				mimeType: "application/pdf",
				sizeBytes: 1024,
				conversationId: null,
				summary: "Uploaded notes",
			}),
			makeArtifactRow({
				id: "normalized-1",
				userId: "user-1",
				type: "normalized_document",
				retrievalClass: "durable",
				name: "notes.txt",
				mimeType: "text/plain",
				sizeBytes: 512,
				conversationId: null,
				summary: "Normalized notes",
				metadataJson: JSON.stringify({ sourceArtifactId: "source-1" }),
				createdAt: new Date("2026-04-01T10:01:00Z"),
				updatedAt: new Date("2026-04-01T10:01:00Z"),
			}),
		);

		mockDerivedRows.push({
			normalizedArtifactId: "normalized-1",
			sourceArtifactId: "source-1",
		});

		queueMockResponses(mockSelect, [
			makeSelectResult([]),
			makeSelectOrderByResult(mockRows),
			makeSelectResult(mockDerivedRows),
		]);

		const { listLogicalDocuments } = await import("./documents");
		const documents = await listLogicalDocuments("user-1");
		const uploadedDocument = documents.find(
			(document) => document.id === "source-1",
		);

		expect(uploadedDocument).toBeDefined();
		if (!uploadedDocument) throw new Error("Expected uploaded document");
		expectDocumentIdentity(uploadedDocument);
		expect(uploadedDocument).toMatchObject({
			displayArtifactId: "source-1",
			promptArtifactId: "normalized-1",
			familyArtifactIds: ["source-1", "normalized-1"],
			normalizedAvailable: true,
			summary: "Normalized notes",
		});
	});

	it("excludes generated outputs without sourceChatFileId from documents list", async () => {
		mockRows.push(
			makeArtifactRow({
				id: "source-1",
				type: "source_document",
				retrievalClass: "durable",
				name: "notes.pdf",
				mimeType: "application/pdf",
				sizeBytes: 1024,
				conversationId: null,
				summary: "Uploaded notes",
			}),
			makeArtifactRow({
				id: "gen-file",
				type: "generated_output",
				retrievalClass: "durable",
				name: "report.docx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				sizeBytes: 2048,
				conversationId: "conv-1",
				summary: "Generated report file",
				metadataJson: JSON.stringify(
					buildGeneratedOutputDocumentMetadata({
						familyId: "family-report",
						label: "Report",
						sourceChatFileId: "chat-file-1",
					}),
				),
				createdAt: new Date("2026-04-02T10:00:00Z"),
				updatedAt: new Date("2026-04-02T10:00:00Z"),
			}),
			makeArtifactRow({
				id: "gen-process",
				type: "generated_output",
				retrievalClass: "durable",
				name: "workflow result",
				mimeType: "text/markdown",
				sizeBytes: 512,
				conversationId: "conv-1",
				summary: "AI process output without file",
				metadataJson: JSON.stringify(
					buildGeneratedOutputDocumentMetadata({
						familyId: "family-process",
						label: "Process output",
					}),
				),
				createdAt: new Date("2026-04-03T10:00:00Z"),
				updatedAt: new Date("2026-04-03T10:00:00Z"),
			}),
		);

		queueMockResponses(mockSelect, [
			makeSelectResult([{ id: "conv-1" }]),
			makeSelectOrderByResult(mockRows),
			makeSelectResult([]),
		]);

		const { listLogicalDocuments } = await import("./documents");
		const documents = await listLogicalDocuments("user-1", {
			includeGeneratedOutputs: true,
		});

		const generatedDocuments = documents.filter(
			(document) => document.documentOrigin === "generated",
		);

		expect(generatedDocuments).toHaveLength(1);
		expect(generatedDocuments[0]?.displayArtifactId).toBe("gen-file");
		expect(generatedDocuments[0]?.sourceChatFileId).toBe("chat-file-1");
	});

	it("lists Skill Notes as distinct library documents", async () => {
		mockRows.push({
			...makeArtifactRow({
				id: "note-1",
				type: "skill_note",
				retrievalClass: "durable",
				name: "Research skill note",
				mimeType: "text/markdown",
				sizeBytes: 512,
				conversationId: "conv-1",
				summary: "Living note captured by a skill session",
				metadataJson: JSON.stringify({
					skillSessionId: "session-1",
					originAssistantMessageId: "message-1",
				}),
				createdAt: new Date("2026-04-04T10:00:00Z"),
				updatedAt: new Date("2026-04-04T10:00:00Z"),
			}),
		});

		queueMockResponses(mockSelect, [
			makeSelectResult([{ id: "conv-1" }]),
			makeSelectOrderByResult(mockRows),
		]);

		const { listLogicalDocuments } = await import("./documents");
		const documents = await listLogicalDocuments("user-1", {
			includeGeneratedOutputs: true,
		});

		expect(documents).toHaveLength(1);
		const [document] = documents;
		if (!document) throw new Error("Expected skill note document");
		expectDocumentIdentity(document);
		expect(document).toMatchObject({
			id: "note-1",
			type: "skill_note",
			displayArtifactId: "note-1",
			promptArtifactId: "note-1",
			documentOrigin: "skill_note",
			name: "Research skill note",
			normalizedAvailable: true,
		});
	});

	it("skips orphaned normalized_document artifacts — they never appear standalone", async () => {
		mockRows.push(
			makeArtifactRow({
				id: "source-standalone",
				userId: "user-1",
				type: "source_document",
				retrievalClass: "durable",
				name: "report.pdf",
				mimeType: "application/pdf",
				sizeBytes: 1024,
				conversationId: null,
				summary: "User-uploaded report",
			}),
			makeArtifactRow({
				id: "normalized-orphan",
				userId: "user-1",
				type: "normalized_document",
				retrievalClass: "durable",
				name: "report.txt",
				mimeType: "text/plain",
				sizeBytes: 512,
				conversationId: null,
				summary: "System-generated markdown extraction",
				metadataJson: JSON.stringify({ sourceArtifactId: "source-standalone" }),
				createdAt: new Date("2026-04-01T10:01:00Z"),
				updatedAt: new Date("2026-04-01T10:01:00Z"),
			}),
		);

		mockDerivedRows.length = 0;

		queueMockResponses(mockSelect, [
			makeSelectResult([]),
			makeSelectOrderByResult(mockRows),
			makeSelectResult(mockDerivedRows),
		]);

		const { listLogicalDocuments } = await import("./documents");
		const documents = await listLogicalDocuments("user-1");

		expect(documents).toHaveLength(1);
		expect(documents[0]?.id).toBe("source-standalone");
		expect(documents[0]?.type).toBe("source_document");
		expect(documents[0]?.normalizedAvailable).toBe(false);

		const normalizedDocs = documents.filter(
			(d) => d.type === "normalized_document",
		);
		expect(normalizedDocs).toHaveLength(0);
	});

	it("bounds the no-query date-sorted page in the database before building logical document details", async () => {
		const pageRows = [
			makeArtifactRow({
				id: "source-new",
				userId: "user-1",
				type: "source_document",
				retrievalClass: "durable",
				name: "new.pdf",
				mimeType: "application/pdf",
				sizeBytes: 100,
				conversationId: null,
				summary: "New upload",
				createdAt: new Date("2026-04-05T10:00:00Z"),
				updatedAt: new Date("2026-04-05T10:00:00Z"),
			}),
			makeArtifactRow({
				id: "source-old",
				userId: "user-1",
				type: "source_document",
				retrievalClass: "durable",
				name: "old.pdf",
				mimeType: "application/pdf",
				sizeBytes: 100,
				conversationId: null,
				summary: "Old upload",
				createdAt: new Date("2026-04-04T10:00:00Z"),
				updatedAt: new Date("2026-04-04T10:00:00Z"),
			}),
		];
		const limitSpy = vi.fn(() => ({
			offset: vi.fn(async () => pageRows),
		}));
		const unboundedOrderBySpy = vi.fn(() => {
			throw new Error("full logical document scan should not run");
		});

		let selectCall = 0;
		mockSelect.mockImplementation((selection?: Record<string, unknown>) => {
			selectCall += 1;
			if (selectCall === 1) {
				return {
					from: vi.fn(() => ({
						where: vi.fn(async () => []),
					})),
				};
			}

			if (selection && "normalizedArtifactId" in selection) {
				return {
					from: vi.fn(() => ({
						where: vi.fn(async () => []),
					})),
				};
			}

			if (selection && "total" in selection) {
				return {
					from: vi.fn(() => ({
						where: vi.fn(() => ({
							get: vi.fn(async () => ({ total: 5 })),
						})),
					})),
				};
			}

			return {
				from: vi.fn(() => ({
					where: vi.fn(() => ({
						orderBy: vi.fn(() => ({
							limit: limitSpy,
						})),
					})),
				})),
				orderBy: unboundedOrderBySpy,
			};
		});

		const { listLogicalDocumentsPage } = await import("./documents");
		const result = await listLogicalDocumentsPage("user-1", {
			includeGeneratedOutputs: true,
			sortKey: "date",
			sortDirection: "desc",
			offset: 20,
			limit: 2,
		});

		expect(limitSpy).toHaveBeenCalledWith(2);
		expect(result.totalItems).toBe(5);
		expect(result.documents.map((document) => document.id)).toEqual([
			"source-new",
			"source-old",
		]);
	});

	it("prefers semantic and reranked artifact matches when lexical scores are weak", async () => {
		mockRows.push(
			makeArtifactRow({
				id: "artifact-lexical",
				userId: "user-1",
				type: "normalized_document",
				retrievalClass: "durable",
				name: "Budget notes",
				mimeType: "text/plain",
				sizeBytes: 512,
				conversationId: null,
				summary: "Budget notes",
				contentText: "Budget notes and rough numbers",
				createdAt: new Date("2026-04-01T10:00:00Z"),
				updatedAt: new Date("2026-04-01T10:00:00Z"),
				extension: "txt",
			}),
			makeArtifactRow({
				id: "artifact-semantic",
				userId: "user-1",
				type: "normalized_document",
				retrievalClass: "durable",
				name: "Revenue outlook",
				mimeType: "text/plain",
				sizeBytes: 512,
				conversationId: null,
				summary: "Forecasted quarterly revenue",
				contentText: "Projected quarterly revenue and forecast assumptions",
				createdAt: new Date("2026-04-02T10:00:00Z"),
				updatedAt: new Date("2026-04-02T10:00:00Z"),
				extension: "txt",
			}),
		);

		let selectCall = 0;
		mockSelect.mockImplementation(() => {
			selectCall += 1;
			if (selectCall === 1) {
				return {
					from: vi.fn(() => ({
						where: vi.fn(async () => []),
					})),
				};
			}

			return {
				from: vi.fn(() => ({
					where: vi.fn(() => ({
						orderBy: vi.fn(() => ({
							limit: vi.fn(async () => mockRows),
						})),
					})),
				})),
			};
		});

		mockShortlistSemanticMatchesBySubject.mockImplementation(
			async ({ items }) => {
				const item = items.find(
					(artifact) => artifact.id === "artifact-semantic",
				);
				if (!item) return [];
				return [
					{
						item,
						subjectId: "artifact-semantic",
						semanticScore: 0.92,
					},
				];
			},
		);
		mockRerankItems.mockResolvedValue({
			items: [
				{
					item: {
						id: "artifact-semantic",
						userId: "user-1",
						type: "normalized_document",
						retrievalClass: "durable",
						name: "Revenue outlook",
						mimeType: "text/plain",
						sizeBytes: 512,
						conversationId: null,
						summary: "Forecasted quarterly revenue",
						createdAt: new Date("2026-04-02T10:00:00Z").getTime(),
						updatedAt: new Date("2026-04-02T10:00:00Z").getTime(),
						extension: "txt",
						storagePath: null,
						contentText: "Projected quarterly revenue and forecast assumptions",
						metadata: null,
					},
					index: 0,
					score: 0.88,
				},
			],
			confidence: 88,
		});

		const { findRelevantArtifactsByTypesDetailed } = await import(
			"./documents"
		);
		const matches = await findRelevantArtifactsByTypesDetailed({
			userId: "user-1",
			query: "revenue forecast",
			types: ["normalized_document"],
			limit: 2,
		});

		expect(matches[0]?.artifact.id).toBe("artifact-semantic");
		expect(matches[0]?.semanticScore).toBeGreaterThan(0);
	});

	it("excludes foreign and orphaned generated outputs from retrieval", async () => {
		mockRows.push(
			makeArtifactRow({
				id: "artifact-foreign",
				userId: "user-1",
				type: "generated_output",
				retrievalClass: "durable",
				name: "Foreign memory artifact",
				mimeType: "text/markdown",
				sizeBytes: 512,
				conversationId: "conv-foreign",
				summary: "Should not leak",
				contentText: "budget memory from another account",
				createdAt: new Date("2026-04-01T10:00:00Z"),
				updatedAt: new Date("2026-04-01T10:00:00Z"),
				extension: "md",
			}),
			makeArtifactRow({
				id: "artifact-orphan",
				userId: "user-1",
				type: "generated_output",
				retrievalClass: "durable",
				name: "Orphan memory artifact",
				mimeType: "text/markdown",
				sizeBytes: 512,
				conversationId: null,
				summary: "Should be ignored after reset",
				contentText: "budget memory from deleted conversation",
				createdAt: new Date("2026-04-02T10:00:00Z"),
				updatedAt: new Date("2026-04-02T10:00:00Z"),
				extension: "md",
			}),
			makeArtifactRow({
				id: "artifact-owned",
				userId: "user-1",
				type: "generated_output",
				retrievalClass: "durable",
				name: "Owned memory artifact",
				mimeType: "text/markdown",
				sizeBytes: 512,
				conversationId: "conv-owned",
				summary: "Should remain visible",
				contentText: "budget memory for the current user",
				createdAt: new Date("2026-04-03T10:00:00Z"),
				updatedAt: new Date("2026-04-03T10:00:00Z"),
				extension: "md",
			}),
		);

		let selectCall = 0;
		mockSelect.mockImplementation(() => {
			selectCall += 1;
			if (selectCall === 1) {
				return {
					from: vi.fn(() => ({
						where: vi.fn(async () => [{ id: "conv-owned" }]),
					})),
				};
			}

			return {
				from: vi.fn(() => ({
					where: vi.fn(() => ({
						orderBy: vi.fn(() => ({
							limit: vi.fn(async () => mockRows),
						})),
					})),
				})),
			};
		});

		const { findRelevantArtifactsByTypesDetailed } = await import(
			"./documents"
		);
		const matches = await findRelevantArtifactsByTypesDetailed({
			userId: "user-1",
			query: "budget",
			types: ["generated_output"],
			limit: 4,
		});

		expect(matches.map((entry) => entry.artifact.id)).toEqual([
			"artifact-owned",
		]);
	});
});
