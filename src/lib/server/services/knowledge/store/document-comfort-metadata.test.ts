// "Long-document comfort" (owner-approved mockup, 2026-09-06): tests that the
// `indexing` phase computes and stores tokenEstimate/pageCount/outline — on the
// normalized artifact's own metadata, and patched onto the source artifact (the
// one actually shown as an attachment chip in the UI).
//
// Phase 3 moved that code out of `store/documents.ts`'s `createNormalizedArtifact`
// (deleted with its inline `extractDocumentText` call) and into
// `extraction/persist.ts`, which takes text in and gives an artifact out. The
// behaviour under test is unchanged, so the assertions are too; only the
// extraction half of the old function is gone, and it is now the extractor's.
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

const {
	mockCreateArtifact,
	mockCreateArtifactLink,
	mockUpdateArtifactMetadata,
	mockGetNormalizedArtifactForSource,
} = vi.hoisted(() => ({
	mockCreateArtifact: vi.fn(),
	mockCreateArtifactLink: vi.fn(),
	mockUpdateArtifactMetadata: vi.fn(),
	// Phase 3 review: persist now asks whether this source already HAS a
	// normalized artifact, so a re-extraction rewrites it instead of minting a
	// second one. These cases are a first extraction, so: none.
	mockGetNormalizedArtifactForSource: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/knowledge/store/core", () => ({
	createArtifact: mockCreateArtifact,
	createArtifactLink: mockCreateArtifactLink,
	updateArtifactMetadata: mockUpdateArtifactMetadata,
	getNormalizedArtifactForSource: mockGetNormalizedArtifactForSource,
	guessSummary: (text: string) => text.slice(0, 20),
	buildArtifactVisibilityCondition: vi.fn(),
	getArtifactOwnershipScope: vi.fn(),
	isArtifactCanonicallyOwned: vi.fn(),
	knowledgeArtifactListSelection: {},
	mapArtifact: vi.fn(),
	mapArtifactSummary: vi.fn(),
}));

import { createNormalizedArtifactFromExtraction } from "$lib/server/services/extraction/persist";

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

describe("createNormalizedArtifactFromExtraction — long-document comfort metadata", () => {
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

		await createNormalizedArtifactFromExtraction({
			userId: "user-1",
			conversationId: "conv-1",
			sourceArtifactId: "source-1",
			sourceName: "contract.pdf",
			text,
			normalizedName: "contract.md",
			mimeType: "text/markdown",
			pageCount: 38,
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
		// The patch must be scoped to the ingesting user, never to the
		// artifact id alone (see updateArtifactMetadata's ownership scope).
		expect(patchCall.userId).toBe("user-1");
		expect(patchCall.patch.tokenEstimate).toBe(
			createArtifactCall.metadata.tokenEstimate,
		);
		expect(patchCall.patch.pageCount).toBe(38);
		expect(patchCall.patch.outline).toEqual(
			createArtifactCall.metadata.outline,
		);
	});

	it("omits pageCount and outline from the patch when neither is available", async () => {
		await createNormalizedArtifactFromExtraction({
			userId: "user-1",
			conversationId: null,
			sourceArtifactId: "source-2",
			sourceName: "notes.txt",
			text: "just some plain unstructured text with no headings at all",
			normalizedName: "notes.md",
			mimeType: "text/markdown",
		});

		const patchCall = mockUpdateArtifactMetadata.mock.calls[0][0];
		expect(patchCall.patch.tokenEstimate).toBeGreaterThan(0);
		expect(patchCall.patch.pageCount).toBeUndefined();
		expect(patchCall.patch.outline).toBeUndefined();
	});
});
