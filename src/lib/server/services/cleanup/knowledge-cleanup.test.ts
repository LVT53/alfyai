import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockDeleteAllHonchoStateForUser,
	mockRotateHonchoPeerIdentity,
	mockClearMessageEvidenceForUser,
	mockGetArtifactOwnershipScope,
	mockBuildArtifactVisibilityCondition,
	mockHardDeleteArtifactsForUser,
	mockTransaction,
	mockSelect,
} = vi.hoisted(() => ({
	mockDeleteAllHonchoStateForUser: vi.fn(),
	mockRotateHonchoPeerIdentity: vi.fn(),
	mockClearMessageEvidenceForUser: vi.fn(),
	mockGetArtifactOwnershipScope: vi.fn(),
	mockBuildArtifactVisibilityCondition: vi.fn(),
	mockHardDeleteArtifactsForUser: vi.fn(),
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
	memoryProjects: {
		userId: { name: "memoryProjectsUserId" },
	},
	memoryProjectTaskLinks: {
		userId: { name: "memoryProjectTaskLinksUserId" },
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

vi.mock("../honcho", () => ({
	deleteAllHonchoStateForUser: mockDeleteAllHonchoStateForUser,
	rotateHonchoPeerIdentity: mockRotateHonchoPeerIdentity,
}));

vi.mock("../messages", () => ({
	clearMessageEvidenceForUser: mockClearMessageEvidenceForUser,
}));

vi.mock("../knowledge", () => ({
	buildArtifactVisibilityCondition: mockBuildArtifactVisibilityCondition,
	getArtifactOwnershipScope: mockGetArtifactOwnershipScope,
	hardDeleteArtifactsForUser: mockHardDeleteArtifactsForUser,
}));

describe("resetKnowledgeBaseState", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDeleteAllHonchoStateForUser.mockResolvedValue(undefined);
		mockRotateHonchoPeerIdentity.mockResolvedValue(2);
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

	it("clears Honcho, artifacts, continuity state, and message evidence", async () => {
		const { resetKnowledgeBaseState } = await import("./knowledge-cleanup");

		const result = await resetKnowledgeBaseState("user-1");

		expect(result.deletedArtifactIds).toEqual(["artifact-1"]);
		expect(mockDeleteAllHonchoStateForUser).toHaveBeenCalledWith("user-1");
		expect(mockRotateHonchoPeerIdentity).toHaveBeenCalledWith("user-1");
		expect(mockHardDeleteArtifactsForUser).toHaveBeenCalledWith("user-1", [
			"artifact-1",
		]);
		expect(mockTransaction).toHaveBeenCalledTimes(1);
		expect(mockClearMessageEvidenceForUser).toHaveBeenCalledWith("user-1");
	});
});
