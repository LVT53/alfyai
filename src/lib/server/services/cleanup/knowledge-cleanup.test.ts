import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockClearMessageEvidenceForUser,
	mockGetArtifactOwnershipScope,
	mockBuildArtifactVisibilityCondition,
	mockHardDeleteArtifactsForUser,
	mockAdvanceMemoryResetGeneration,
	mockTransaction,
	mockSelect,
} = vi.hoisted(() => ({
	mockClearMessageEvidenceForUser: vi.fn(),
	mockGetArtifactOwnershipScope: vi.fn(),
	mockBuildArtifactVisibilityCondition: vi.fn(),
	mockHardDeleteArtifactsForUser: vi.fn(),
	mockAdvanceMemoryResetGeneration: vi.fn(),
	mockTransaction: vi.fn(),
	mockSelect: vi.fn(),
}));

vi.mock("$lib/server/db", () => ({
	db: {
		select: mockSelect,
		transaction: mockTransaction,
	},
}));

vi.mock("$lib/server/db/schema", () => ({
	artifacts: {
		id: { name: "artifactId" },
	},
	conversationContextStatus: {
		userId: { name: "conversationContextStatusUserId" },
	},
	conversationTaskStates: {
		userId: { name: "conversationTaskStatesUserId" },
	},
	conversationWorkingSetItems: {
		userId: { name: "conversationWorkingSetItemsUserId" },
	},
	memoryEvents: {
		userId: { name: "memoryEventsUserId" },
	},
	memoryProjectionState: {
		userId: { name: "memoryProjectionStateUserId" },
	},
	memoryProjects: {
		userId: { name: "memoryProjectsUserId" },
	},
	memoryProjectTaskLinks: {
		userId: { name: "memoryProjectTaskLinksUserId" },
	},
	memoryDirtyLedger: {
		userId: { name: "memoryDirtyLedgerUserId" },
	},
	memoryReviewItems: {
		userId: { name: "memoryReviewItemsUserId" },
	},
	memoryReworkTelemetry: {
		userId: { name: "memoryReworkTelemetryUserId" },
	},
	semanticEmbeddings: {
		userId: { name: "semanticEmbeddingsUserId" },
	},
	taskCheckpoints: {
		userId: { name: "taskCheckpointsUserId" },
	},
	taskStateEvidenceLinks: {
		userId: { name: "taskStateEvidenceLinksUserId" },
	},
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn((field: { name: string }, value: unknown) => ({
		field: field.name,
		value,
	})),
}));

vi.mock("../messages", () => ({
	clearMessageEvidenceForUser: mockClearMessageEvidenceForUser,
}));

vi.mock("../knowledge", () => ({
	buildArtifactVisibilityCondition: mockBuildArtifactVisibilityCondition,
	getArtifactOwnershipScope: mockGetArtifactOwnershipScope,
	hardDeleteArtifactsForUser: mockHardDeleteArtifactsForUser,
}));

vi.mock("../memory-profile", () => ({
	advanceMemoryResetGeneration: mockAdvanceMemoryResetGeneration,
}));

describe("resetKnowledgeBaseState", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockAdvanceMemoryResetGeneration.mockResolvedValue(1);
		mockClearMessageEvidenceForUser.mockResolvedValue(undefined);
		mockGetArtifactOwnershipScope.mockResolvedValue({
			conversationIds: new Set(),
		});
		mockBuildArtifactVisibilityCondition.mockReturnValue({
			field: "scope",
			value: "user-1",
		});
		mockHardDeleteArtifactsForUser.mockResolvedValue({
			deletedArtifactIds: ["artifact-1"],
		});
		mockSelect.mockReturnValue({
			from: vi.fn().mockReturnValue({
				where: vi.fn().mockResolvedValue([{ id: "artifact-1" }]),
			}),
		});
		mockTransaction.mockImplementation((callback: (tx: unknown) => void) => {
			const tx = {
				delete: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						run: vi.fn(),
					}),
				}),
			};
			callback(tx);
		});
	});

	it("clears artifacts, continuity state, and message evidence", async () => {
		const { resetKnowledgeBaseState } = await import("./knowledge-cleanup");

		const result = await resetKnowledgeBaseState("user-1");

		expect(result.deletedArtifactIds).toEqual(["artifact-1"]);
		expect(mockAdvanceMemoryResetGeneration).toHaveBeenCalledWith("user-1");
		expect(mockHardDeleteArtifactsForUser).toHaveBeenCalledWith("user-1", [
			"artifact-1",
		]);
		expect(mockTransaction).toHaveBeenCalledTimes(1);
		expect(mockClearMessageEvidenceForUser).toHaveBeenCalledWith("user-1");
	});
});
