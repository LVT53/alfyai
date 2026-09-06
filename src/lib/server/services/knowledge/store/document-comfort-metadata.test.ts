// "Long-document comfort" (owner-approved mockup, 2026-09-06): tests that
// createNormalizedArtifact computes and stores tokenEstimate/pageCount/
// outline at ingestion — on the normalized artifact's own metadata, and
// patched onto the source artifact (the one actually shown as an
// attachment chip in the UI).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "$lib/server/services/knowledge/types";

vi.mock("$lib/server/db", () => ({
	db: { select: vi.fn() },
}));

vi.mock("$lib/server/db/schema", () => ({
	artifacts: {},
	artifactLinks: {},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn(),
	asc: vi.fn(),
	desc: vi.fn(),
	eq: vi.fn(),
	inArray: vi.fn(),
	like: vi.fn(),
	ne: vi.fn(),
	or: vi.fn(),
	sql: vi.fn(),
}));

vi.mock("../../semantic-ranking", () => ({
	shortlistSemanticMatchesBySubject: vi.fn(),
}));

vi.mock("../../tei-reranker", () => ({
	canUseTeiReranker: vi.fn(),
	rerankItems: vi.fn(),
}));

const {
	mockCreateArtifact,
	mockCreateArtifactLink,
	mockUpdateArtifactMetadata,
} = vi.hoisted(() => ({
	mockCreateArtifact: vi.fn(),
	mockCreateArtifactLink: vi.fn(),
	mockUpdateArtifactMetadata: vi.fn(),
}));

vi.mock("./core", () => ({
	createArtifact: mockCreateArtifact,
	createArtifactLink: mockCreateArtifactLink,
	updateArtifactMetadata: mockUpdateArtifactMetadata,
	guessSummary: (text: string) => text.slice(0, 20),
	buildArtifactVisibilityCondition: vi.fn(),
	getArtifactOwnershipScope: vi.fn(),
	isArtifactCanonicallyOwned: vi.fn(),
	knowledgeArtifactListSelection: {},
	mapArtifact: vi.fn(),
	mapArtifactSummary: vi.fn(),
}));

const mockExtractDocumentText = vi.hoisted(() => vi.fn());
vi.mock("../../document-extraction", () => ({
	extractDocumentText: mockExtractDocumentText,
}));

import { createNormalizedArtifact } from "./documents";

function fakeArtifact(overrides: Partial<Artifact> = {}): Artifact {
	return {
		id: "normalized-1",
		userId: "user-1",
		type: "normalized_document",
		retrievalClass: "durable",
		name: "contract.md",
		mimeType: "text/markdown",
		sizeBytes: 100,
		conversationId: null,
		summary: "summary",
		extension: "txt",
		storagePath: null,
		contentText: null,
		metadata: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

describe("createNormalizedArtifact — long-document comfort metadata", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockCreateArtifact.mockResolvedValue(fakeArtifact());
		mockCreateArtifactLink.mockResolvedValue(undefined);
		mockUpdateArtifactMetadata.mockResolvedValue(undefined);
	});

	it("computes tokenEstimate and outline and stores them on both the normalized and source artifact", async () => {
		const text = [
			"# Contract",
			"",
			"This agreement governs the relationship between the parties.",
			"",
			"## Break clause",
			"",
			"Either party may terminate this agreement with 30 days notice.",
		].join("\n");

		mockExtractDocumentText.mockResolvedValue({
			text,
			normalizedName: "contract.md",
			mimeType: "text/markdown",
			pageCount: 38,
		});

		await createNormalizedArtifact({
			userId: "user-1",
			conversationId: "conv-1",
			sourceArtifactId: "source-1",
			sourceStoragePath: "data/knowledge/user-1/source-1.pdf",
			sourceName: "contract.pdf",
			sourceMimeType: "application/pdf",
		});

		expect(mockCreateArtifact).toHaveBeenCalledTimes(1);
		const createArtifactCall = mockCreateArtifact.mock.calls[0][0];
		expect(createArtifactCall.metadata.tokenEstimate).toBeGreaterThan(0);
		expect(createArtifactCall.metadata.pageCount).toBe(38);
		expect(createArtifactCall.metadata.outline).toEqual([
			expect.objectContaining({ level: 1, title: "Contract" }),
			expect.objectContaining({ level: 2, title: "Break clause" }),
		]);

		expect(mockUpdateArtifactMetadata).toHaveBeenCalledTimes(1);
		const patchCall = mockUpdateArtifactMetadata.mock.calls[0][0];
		expect(patchCall.artifactId).toBe("source-1");
		expect(patchCall.patch.tokenEstimate).toBe(
			createArtifactCall.metadata.tokenEstimate,
		);
		expect(patchCall.patch.pageCount).toBe(38);
		expect(patchCall.patch.outline).toEqual(
			createArtifactCall.metadata.outline,
		);
	});

	it("omits pageCount and outline from the patch when neither is available", async () => {
		mockExtractDocumentText.mockResolvedValue({
			text: "just some plain unstructured text with no headings at all",
			normalizedName: "notes.md",
			mimeType: "text/markdown",
		});

		await createNormalizedArtifact({
			userId: "user-1",
			conversationId: null,
			sourceArtifactId: "source-2",
			sourceStoragePath: "data/knowledge/user-1/source-2.txt",
			sourceName: "notes.txt",
			sourceMimeType: "text/plain",
		});

		const patchCall = mockUpdateArtifactMetadata.mock.calls[0][0];
		expect(patchCall.patch.tokenEstimate).toBeGreaterThan(0);
		expect(patchCall.patch.pageCount).toBeUndefined();
		expect(patchCall.patch.outline).toBeUndefined();
	});

	it("does nothing when extraction produces no text", async () => {
		mockExtractDocumentText.mockResolvedValue({
			text: null,
			normalizedName: "empty.md",
			mimeType: "text/markdown",
		});

		const result = await createNormalizedArtifact({
			userId: "user-1",
			conversationId: null,
			sourceArtifactId: "source-3",
			sourceStoragePath: "data/knowledge/user-1/source-3.pdf",
			sourceName: "empty.pdf",
			sourceMimeType: "application/pdf",
		});

		expect(result).toBeNull();
		expect(mockCreateArtifact).not.toHaveBeenCalled();
		expect(mockUpdateArtifactMetadata).not.toHaveBeenCalled();
	});
});
