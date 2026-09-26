import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunUserMemoryMaintenance = vi.fn();
const mockGetArtifactOwnershipScope = vi.fn();
const mockBuildArtifactVisibilityCondition = vi.fn();
const mockIsArtifactCanonicallyOwned = vi.fn();
const mockListLogicalDocuments = vi.fn();
const mockListLogicalDocumentsPage = vi.fn();
const mockMapArtifactSummary = vi.fn();
const mockMapWorkCapsuleFromArtifactRow = vi.fn();
const mockGetExtractionJobsForArtifacts = vi.fn();

const mockOrderBy = vi.fn();
const mockWhere = vi.fn();
const mockFrom = vi.fn();
const mockSelect = vi.fn();

vi.mock("$lib/server/db", () => ({
	db: {
		select: (...args: unknown[]) => mockSelect(...args),
	},
}));

vi.mock("./memory-maintenance", () => ({
	runUserMemoryMaintenance: (...args: unknown[]) =>
		mockRunUserMemoryMaintenance(...args),
}));

vi.mock("./knowledge/store", () => ({
	getArtifactOwnershipScope: (...args: unknown[]) =>
		mockGetArtifactOwnershipScope(...args),
	buildArtifactVisibilityCondition: (...args: unknown[]) =>
		mockBuildArtifactVisibilityCondition(...args),
	isArtifactCanonicallyOwned: (...args: unknown[]) =>
		mockIsArtifactCanonicallyOwned(...args),
	knowledgeArtifactListSelection: {},
	listLogicalDocuments: (...args: unknown[]) =>
		mockListLogicalDocuments(...args),
	listLogicalDocumentsPage: (...args: unknown[]) =>
		mockListLogicalDocumentsPage(...args),
	mapArtifactSummary: (...args: unknown[]) => mockMapArtifactSummary(...args),
}));

vi.mock("./knowledge/capsules", () => ({
	mapWorkCapsuleFromArtifactRow: (...args: unknown[]) =>
		mockMapWorkCapsuleFromArtifactRow(...args),
}));

vi.mock("./extraction", () => ({
	getExtractionJobsForArtifacts: (...args: unknown[]) =>
		mockGetExtractionJobsForArtifacts(...args),
}));

import { getKnowledgeLibraryPage, listKnowledgeArtifacts } from "./knowledge";

describe("knowledge service listKnowledgeArtifacts", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		mockSelect.mockReturnValue({ from: mockFrom });
		mockFrom.mockReturnValue({ where: mockWhere });
		mockWhere.mockReturnValue({ orderBy: mockOrderBy });

		mockGetArtifactOwnershipScope.mockResolvedValue({});
		mockBuildArtifactVisibilityCondition.mockReturnValue({});
		mockIsArtifactCanonicallyOwned.mockReturnValue(true);
		mockListLogicalDocuments.mockResolvedValue([
			{ id: "doc-1", name: "Doc 1" },
		]);
		mockMapArtifactSummary.mockImplementation((row: { id: string }) => ({
			id: row.id,
		}));
		mockMapWorkCapsuleFromArtifactRow.mockImplementation(
			(row: { id: string }) => ({ artifact: { id: row.id } }),
		);
	});

	it("does not block knowledge reads on maintenance completion", async () => {
		let resolveMaintenance: (() => void) | undefined;
		const maintenancePromise = new Promise<void>((resolve) => {
			resolveMaintenance = resolve;
		});
		mockRunUserMemoryMaintenance.mockReturnValue(maintenancePromise);

		mockOrderBy.mockResolvedValue([
			{ id: "gen-1", type: "generated_output", conversationId: "conv-1" },
			{ id: "cap-1", type: "work_capsule", conversationId: "conv-1" },
		]);

		const result = await listKnowledgeArtifacts("user-1");
		await vi.waitFor(() => {
			expect(mockRunUserMemoryMaintenance).toHaveBeenCalledWith(
				"user-1",
				"knowledge_read",
			);
		});
		expect(result.documents).toHaveLength(1);
		expect(result.results).toEqual([{ id: "gen-1" }]);
		expect(result.workflows).toEqual([{ artifact: { id: "cap-1" } }]);

		resolveMaintenance?.();
		await maintenancePromise;
	});
});

describe("knowledge service getKnowledgeLibraryPage", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		mockRunUserMemoryMaintenance.mockResolvedValue(undefined);
		mockListLogicalDocumentsPage.mockResolvedValue({
			documents: [
				{
					id: "doc-larger",
					displayArtifactId: "doc-larger",
					promptArtifactId: null,
					familyArtifactIds: ["doc-larger"],
					name: "Beta onboarding.docx",
					mimeType:
						"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					sizeBytes: 500,
					conversationId: null,
					summary: "Beta onboarding",
					normalizedAvailable: false,
					documentOrigin: "uploaded",
					createdAt: 200,
					updatedAt: 200,
				},
			],
			totalItems: 2,
		});
		mockGetExtractionJobsForArtifacts.mockResolvedValue([]);
	});

	it("returns a searched, sorted, paged library document projection", async () => {
		const result = await getKnowledgeLibraryPage("user-1", {
			query: "onboarding",
			sortKey: "size",
			sortDirection: "desc",
			page: 1,
			pageSize: 1,
		});

		expect(mockListLogicalDocuments).not.toHaveBeenCalled();
		expect(mockListLogicalDocumentsPage).toHaveBeenCalledWith("user-1", {
			includeGeneratedOutputs: true,
			query: "onboarding",
			sortKey: "size",
			sortDirection: "desc",
			offset: 0,
			limit: 1,
		});
		expect(result.documents.map((document) => document.id)).toEqual([
			"doc-larger",
		]);
		expect(result.pagination).toEqual({
			page: 1,
			pageSize: 1,
			totalItems: 2,
			totalPages: 2,
		});
		expect(result.query).toBe("onboarding");
		expect(result.sort).toEqual({ key: "size", direction: "desc" });
	});

	it("resolves the page's extraction verdicts in one batched read", async () => {
		mockGetExtractionJobsForArtifacts.mockResolvedValue([
			{
				id: "job-1",
				sourceArtifactId: "doc-larger",
				normalizedArtifactId: null,
				status: "parsing",
				intakeRoute: "mineru",
				fileName: "Beta onboarding.docx",
				attemptCount: 1,
				maxAttempts: 3,
				retryable: false,
				cancelable: true,
				error: null,
				createdAt: 100,
				updatedAt: 200,
				startedAt: 150,
				legacy: false,
			},
		]);

		const result = await getKnowledgeLibraryPage("user-1", { pageSize: 1 });

		expect(mockGetExtractionJobsForArtifacts).toHaveBeenCalledTimes(1);
		expect(mockGetExtractionJobsForArtifacts).toHaveBeenCalledWith({
			userId: "user-1",
			artifactIds: ["doc-larger"],
		});
		expect(result.documents[0].extraction).toMatchObject({
			id: "job-1",
			status: "parsing",
			cancelable: true,
		});
	});

	it("never asks the ledger about a generated output", async () => {
		mockListLogicalDocumentsPage.mockResolvedValue({
			documents: [
				{
					id: "gen-1",
					displayArtifactId: "gen-1",
					promptArtifactId: null,
					familyArtifactIds: ["gen-1"],
					name: "Summary.md",
					mimeType: "text/markdown",
					sizeBytes: 10,
					conversationId: "conv-1",
					summary: null,
					normalizedAvailable: true,
					documentOrigin: "generated",
					type: "generated_output",
					createdAt: 1,
					updatedAt: 1,
				},
			],
			totalItems: 1,
		});

		const result = await getKnowledgeLibraryPage("user-1");

		expect(mockGetExtractionJobsForArtifacts).not.toHaveBeenCalled();
		expect(result.documents[0].extraction).toBeUndefined();
	});

	it("still serves the library when the ledger read fails", async () => {
		// A Status column with nothing in it beats a Knowledge tab with
		// nothing in it: the ledger is additive to this page, not load-bearing.
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		mockGetExtractionJobsForArtifacts.mockRejectedValue(
			new Error("ledger unavailable"),
		);

		const result = await getKnowledgeLibraryPage("user-1", { pageSize: 1 });

		expect(result.documents.map((document) => document.id)).toEqual([
			"doc-larger",
		]);
		expect(result.documents[0].extraction).toBeUndefined();
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
	});

	// Slice 7: the Documents tab's chip row reads its counts from here, and a
	// chip click threads `kindFilter` straight through.
	it("threads kindFilter to listLogicalDocumentsPage and returns its countsByKind", async () => {
		mockListLogicalDocumentsPage.mockResolvedValue({
			documents: [
				{
					id: "canvas-1",
					displayArtifactId: "canvas-1",
					promptArtifactId: null,
					familyArtifactIds: ["canvas-1"],
					name: "Vienna trip board",
					mimeType: null,
					sizeBytes: null,
					conversationId: "conv-1",
					summary: null,
					normalizedAvailable: false,
					kind: "canvas",
					artifactVersionNumber: 7,
					createdAt: 300,
					updatedAt: 300,
				},
			],
			totalItems: 1,
			countsByKind: {
				document: 0,
				app: 0,
				canvas: 1,
				slides: 0,
				uploaded: 0,
			},
		});

		const result = await getKnowledgeLibraryPage("user-1", {
			kindFilter: "canvas",
		});

		expect(mockListLogicalDocumentsPage).toHaveBeenCalledWith(
			"user-1",
			expect.objectContaining({ kindFilter: "canvas" }),
		);
		expect(result.countsByKind).toEqual({
			document: 0,
			app: 0,
			canvas: 1,
			slides: 0,
			uploaded: 0,
		});
		expect(result.documents.map((document) => document.id)).toEqual([
			"canvas-1",
		]);
	});
});

import {
	applyConversationBoundaryPenalty,
	isCrossConversationArtifactEligible,
} from "../utils/conversation-boundary-filter";
import { findRelevantKnowledgeArtifacts } from "./knowledge/context";
import * as store from "./knowledge/store";

vi.mock("../utils/conversation-boundary-filter", () => ({
	applyConversationBoundaryPenalty: vi.fn((params) => params.score),
	isCrossConversationArtifactEligible: vi.fn(() => true),
}));

// We should mock countRecentMemoryBehaviorEventsBySubject directly
const mockCountRecentMemoryEventsBySubject = vi.fn(() =>
	Promise.resolve(new Map()),
);

vi.mock("./document-resolution", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./document-resolution")>();
	return {
		...actual,
		resolveRelevantGeneratedDocumentSelection: vi.fn((params) => ({
			orderedArtifacts: params.artifacts,
		})),
		getGeneratedDocumentBehaviorKey: vi.fn(() => "test"),
	};
});

vi.mock("./memory-behavior-log", () => ({
	countRecentMemoryBehaviorEventsBySubject: (
		...args: Parameters<typeof mockCountRecentMemoryEventsBySubject>
	) => mockCountRecentMemoryEventsBySubject(...args),
}));

const mockedStore = store as typeof store & {
	findRelevantArtifactsByTypesDetailed: ReturnType<typeof vi.fn> &
		((params: { types: string[] }) => Promise<unknown[]>);
	getArtifactsForUser: ReturnType<typeof vi.fn> &
		((userId: string) => Promise<unknown[]>);
};

describe("findRelevantKnowledgeArtifacts", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Add the mocked functions explicitly here since they weren't in the original mock of store
		mockedStore.findRelevantArtifactsByTypesDetailed =
			vi.fn() as unknown as typeof mockedStore.findRelevantArtifactsByTypesDetailed;
		mockedStore.getArtifactsForUser =
			vi.fn() as unknown as typeof mockedStore.getArtifactsForUser;

		mockedStore.getArtifactsForUser.mockResolvedValue([]);
		mockedStore.findRelevantArtifactsByTypesDetailed.mockImplementation(
			(params: { types: string[] }) => {
				if (params.types[0] === "normalized_document") {
					return Promise.resolve([
						{
							artifact: {
								id: "doc-1",
								type: "normalized_document",
								conversationId: "conv-1",
								updatedAt: Date.now(),
								name: "test doc",
								summary: "",
							},
							lexicalScore: 3,
							semanticScore: 10,
							rerankScore: 10,
							finalScore: 10,
						},
					]);
				}
				if (params.types[0] === "generated_output") {
					return Promise.resolve([
						{
							artifact: {
								id: "gen-1",
								type: "generated_output",
								conversationId: "conv-2",
								updatedAt: Date.now(),
								name: "test gen",
								summary: "",
							},
							lexicalScore: 4,
							semanticScore: 20,
							rerankScore: 20,
							finalScore: 20,
						},
					]);
				}
				return Promise.resolve([]);
			},
		);
	});

	it("filters artifacts using conversation boundary filter and penalty", async () => {
		await findRelevantKnowledgeArtifacts({
			userId: "user-1",
			query: "test query",
			currentConversationId: "conv-1",
		});

		expect(isCrossConversationArtifactEligible).toHaveBeenCalledWith(
			expect.objectContaining({
				artifactConversationId: "conv-2",
				currentConversationId: "conv-1",
				matchScore: 4,
				minMatchScore: 3,
			}),
		);

		expect(applyConversationBoundaryPenalty).toHaveBeenCalled();
	});
});
