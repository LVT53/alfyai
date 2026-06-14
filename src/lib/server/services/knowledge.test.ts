import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunUserMemoryMaintenance = vi.fn();
const mockGetArtifactOwnershipScope = vi.fn();
const mockBuildArtifactVisibilityCondition = vi.fn();
const mockIsArtifactCanonicallyOwned = vi.fn();
const mockListLogicalDocuments = vi.fn();
const mockMapArtifactSummary = vi.fn();
const mockMapWorkCapsuleFromArtifactRow = vi.fn();

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
	mapArtifactSummary: (...args: unknown[]) => mockMapArtifactSummary(...args),
}));

vi.mock("./knowledge/capsules", () => ({
	mapWorkCapsuleFromArtifactRow: (...args: unknown[]) =>
		mockMapWorkCapsuleFromArtifactRow(...args),
}));

import { listKnowledgeArtifacts } from "./knowledge";

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
		let resolveMaintenance: (() => void) | null = null;
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

// We should mock countRecentMemoryEventsBySubject directly
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

vi.mock("../memory-events", () => ({
	countRecentMemoryEventsBySubject: (...args: unknown[]) =>
		mockCountRecentMemoryEventsBySubject(...args),
}));

const mockedStore = store as typeof store & {
	findRelevantArtifactsByTypesDetailed: ReturnType<typeof vi.fn>;
	getArtifactsForUser: ReturnType<typeof vi.fn>;
};

describe("findRelevantKnowledgeArtifacts", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Add the mocked functions explicitly here since they weren't in the original mock of store
		mockedStore.findRelevantArtifactsByTypesDetailed = vi.fn();
		mockedStore.getArtifactsForUser = vi.fn();

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
