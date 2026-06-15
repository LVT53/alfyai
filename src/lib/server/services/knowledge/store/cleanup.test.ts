import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	makeArtifactRow,
	makeSelectResult,
	makeTransactionStub,
	queueMockResponses,
} from "./test-fixtures";

const {
	mockArtifacts,
	mockSelect,
	mockTransaction,
	mockDelete,
	mockUnlink,
	mockGetArtifactForUser,
	mockGetArtifactOwnershipScope,
	mockBuildArtifactVisibilityCondition,
	mockIsArtifactCanonicallyOwned,
} = vi.hoisted(() => {
	const mockArtifacts: Array<Record<string, unknown>> = [];
	const mockSelect = vi.fn();
	const mockTransaction = vi.fn();
	const mockDelete = vi.fn();
	const mockUnlink = vi.fn();
	const mockGetArtifactForUser = vi.fn();
	const mockGetArtifactOwnershipScope = vi.fn();
	const mockBuildArtifactVisibilityCondition = vi.fn();
	const mockIsArtifactCanonicallyOwned = vi.fn();

	return {
		mockArtifacts,
		mockSelect,
		mockTransaction,
		mockDelete,
		mockUnlink,
		mockGetArtifactForUser,
		mockGetArtifactOwnershipScope,
		mockBuildArtifactVisibilityCondition,
		mockIsArtifactCanonicallyOwned,
	};
});

vi.mock("$lib/server/db", () => ({
	db: {
		select: mockSelect,
		transaction: mockTransaction,
		delete: mockDelete,
	},
}));

vi.mock("$lib/server/db/schema", () => ({
	artifacts: {
		id: { name: "id" },
		userId: { name: "userId" },
		type: { name: "type" },
		conversationId: { name: "conversationId" },
		storagePath: { name: "storagePath" },
		metadataJson: { name: "metadataJson" },
	},
	artifactLinks: {
		artifactId: { name: "artifactId" },
		relatedArtifactId: { name: "relatedArtifactId" },
		userId: { name: "userId" },
		linkType: { name: "linkType" },
	},
	conversationWorkingSetItems: {
		artifactId: { name: "artifactId" },
	},
	taskStateEvidenceLinks: {
		artifactId: { name: "artifactId" },
	},
	messages: {},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions: unknown[]) => conditions),
	eq: vi.fn((field: { name: string }, value: unknown) => ({
		field: field.name,
		value,
	})),
	inArray: vi.fn((field: { name: string }, value: unknown[]) => ({
		field: field.name,
		value,
	})),
	ne: vi.fn(),
	or: vi.fn(),
	like: vi.fn((field: { name: string }, value: string) => ({
		field: field.name,
		value,
		op: "like",
	})),
}));

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>();
	return {
		...actual,
		unlink: mockUnlink,
	};
});

vi.mock("./core", () => ({
	getArtifactForUser: mockGetArtifactForUser,
	getArtifactOwnershipScope: mockGetArtifactOwnershipScope,
	buildArtifactVisibilityCondition: mockBuildArtifactVisibilityCondition,
	isArtifactCanonicallyOwned: mockIsArtifactCanonicallyOwned,
}));

vi.mock("./documents", () => ({
	listLogicalDocuments: vi.fn(async () => []),
}));

function installTransactionStub() {
	const { transaction, tx } = makeTransactionStub();
	mockTransaction.mockImplementation(transaction);
	return tx;
}

describe("knowledge store cleanup", () => {
	beforeEach(() => {
		mockArtifacts.length = 0;
		vi.clearAllMocks();

		mockGetArtifactOwnershipScope.mockResolvedValue({
			conversationIds: new Set(["conv-1"]),
		});
		mockBuildArtifactVisibilityCondition.mockReturnValue({
			field: "visibility",
			value: "user-1",
		});
		mockIsArtifactCanonicallyOwned.mockReturnValue(true);
		mockUnlink.mockResolvedValue(undefined);
	});

	describe("hardDeleteArtifactsForUser", () => {
		it("awaits the transaction before returning", async () => {
			const { hardDeleteArtifactsForUser } = await import("./cleanup");

			mockSelect.mockReturnValue(
				makeSelectResult([
					makeArtifactRow({
						id: "artifact-1",
						userId: "user-1",
						type: "generated_output",
						conversationId: "conv-1",
					}),
				]),
			);

			let transactionResolved = false;
			const tx = installTransactionStub();
			mockTransaction.mockImplementation(
				async (callback: (tx: unknown) => Promise<void>) => {
					await callback(tx);
					transactionResolved = true;
				},
			);

			const result = await hardDeleteArtifactsForUser("user-1", ["artifact-1"]);

			expect(transactionResolved).toBe(true);
			expect(mockTransaction).toHaveBeenCalled();
			expect(result.deletedArtifactIds).toEqual(["artifact-1"]);
		});

		it("returns empty arrays when no artifacts match", async () => {
			const { hardDeleteArtifactsForUser } = await import("./cleanup");

			mockSelect.mockReturnValue(makeSelectResult([]));

			const result = await hardDeleteArtifactsForUser("user-1", [
				"nonexistent",
			]);

			expect(result.deletedArtifactIds).toEqual([]);
			expect(result.deletedStoragePaths).toEqual([]);
			expect(result.failedStoragePaths).toEqual([]);
			expect(mockTransaction).not.toHaveBeenCalled();
		});
	});

	describe("deleteArtifactForUser", () => {
		it("deletes all generated_output artifacts in the same document family", async () => {
			const { deleteArtifactForUser } = await import("./cleanup");

			mockGetArtifactForUser.mockResolvedValue({
				id: "artifact-1",
				userId: "user-1",
				type: "generated_output",
				conversationId: "conv-1",
				storagePath: null,
				metadata: {
					documentFamilyId: "family-abc",
					documentLabel: "report.md",
					versionNumber: 2,
				},
			});

			const familyArtifacts = [
				makeArtifactRow({
					id: "artifact-1",
					userId: "user-1",
					type: "generated_output",
					conversationId: "conv-1",
					metadataJson: JSON.stringify({
						documentFamilyId: "family-abc",
						documentLabel: "report.md",
						versionNumber: 2,
					}),
				}),
				makeArtifactRow({
					id: "artifact-2",
					userId: "user-1",
					type: "generated_output",
					conversationId: "conv-1",
					metadataJson: JSON.stringify({
						documentFamilyId: "family-abc",
						documentLabel: "report.md",
						versionNumber: 1,
					}),
				}),
				makeArtifactRow({
					id: "artifact-3",
					userId: "user-1",
					type: "generated_output",
					conversationId: "conv-1",
					metadataJson: JSON.stringify({
						documentFamilyId: "family-xyz",
						documentLabel: "other.md",
						versionNumber: 1,
					}),
				}),
			];

			queueMockResponses(mockSelect, [
				makeSelectResult(familyArtifacts),
				makeSelectResult(
					familyArtifacts.filter(
						(artifact) =>
							artifact.id === "artifact-1" || artifact.id === "artifact-2",
					),
				),
			]);

			installTransactionStub();

			const result = await deleteArtifactForUser("user-1", "artifact-1");

			expect(result).not.toBeNull();
			expect(result?.deletedArtifactIds).toContain("artifact-1");
			expect(result?.deletedArtifactIds).toContain("artifact-2");
			expect(result?.deletedArtifactIds).not.toContain("artifact-3");
		});

		it("does not expand deletion when generated_output has no documentFamilyId", async () => {
			const { deleteArtifactForUser } = await import("./cleanup");

			mockGetArtifactForUser.mockResolvedValue({
				id: "artifact-1",
				userId: "user-1",
				type: "generated_output",
				conversationId: "conv-1",
				storagePath: null,
				metadata: {
					documentLabel: "report.md",
					versionNumber: 1,
				},
			});

			mockSelect.mockReturnValue(
				makeSelectResult([
					makeArtifactRow({
						id: "artifact-1",
						userId: "user-1",
						type: "generated_output",
						conversationId: "conv-1",
						metadataJson: JSON.stringify({
							documentLabel: "report.md",
							versionNumber: 1,
						}),
					}),
				]),
			);

			installTransactionStub();

			const result = await deleteArtifactForUser("user-1", "artifact-1");

			expect(result).not.toBeNull();
			expect(result?.deletedArtifactIds).toEqual(["artifact-1"]);
		});

		it("respects ownership boundaries when expanding family deletion", async () => {
			const { deleteArtifactForUser } = await import("./cleanup");

			mockGetArtifactForUser.mockResolvedValue({
				id: "artifact-1",
				userId: "user-1",
				type: "generated_output",
				conversationId: "conv-1",
				storagePath: null,
				metadata: {
					documentFamilyId: "family-abc",
					documentLabel: "report.md",
					versionNumber: 2,
				},
			});

			const familyArtifacts = [
				makeArtifactRow({
					id: "artifact-1",
					userId: "user-1",
					type: "generated_output",
					conversationId: "conv-1",
					metadataJson: JSON.stringify({
						documentFamilyId: "family-abc",
						documentLabel: "report.md",
						versionNumber: 2,
					}),
				}),
				makeArtifactRow({
					id: "artifact-2",
					userId: "user-2",
					type: "generated_output",
					conversationId: "conv-2",
					metadataJson: JSON.stringify({
						documentFamilyId: "family-abc",
						documentLabel: "report.md",
						versionNumber: 1,
					}),
				}),
			];

			mockSelect.mockReturnValue(makeSelectResult(familyArtifacts));

			mockIsArtifactCanonicallyOwned.mockImplementation(
				(params: { artifact: { userId: string } }) => {
					return params.artifact.userId === "user-1";
				},
			);

			installTransactionStub();

			const result = await deleteArtifactForUser("user-1", "artifact-1");

			expect(result).not.toBeNull();
			expect(result?.deletedArtifactIds).toEqual(["artifact-1"]);
			expect(result?.deletedArtifactIds).not.toContain("artifact-2");
		});

		it("returns null when artifact does not exist or is not owned", async () => {
			const { deleteArtifactForUser } = await import("./cleanup");

			mockGetArtifactForUser.mockResolvedValue(null);

			const result = await deleteArtifactForUser("user-1", "nonexistent");

			expect(result).toBeNull();
		});
	});

	describe("deleteKnowledgeArtifactsByAction", () => {
		it("deletes generated output artifacts for result bulk actions", async () => {
			const { deleteKnowledgeArtifactsByAction } = await import("./cleanup");
			const resultArtifacts = [
				makeArtifactRow({
					id: "result-1",
					userId: "user-1",
					type: "generated_output",
					conversationId: "conv-1",
				}),
				makeArtifactRow({
					id: "result-2",
					userId: "user-1",
					type: "generated_output",
					conversationId: "conv-2",
				}),
			];

			queueMockResponses(mockSelect, [
				makeSelectResult(resultArtifacts),
				makeSelectResult(resultArtifacts),
			]);
			installTransactionStub();

			const result = await deleteKnowledgeArtifactsByAction(
				"user-1",
				"forget_all_results",
			);

			expect(result.deletedArtifactIds).toEqual(["result-1", "result-2"]);
		});

		it("deletes work capsule artifacts for workflow bulk actions", async () => {
			const { deleteKnowledgeArtifactsByAction } = await import("./cleanup");
			const workflowArtifacts = [
				makeArtifactRow({
					id: "workflow-1",
					userId: "user-1",
					type: "work_capsule",
					conversationId: "conv-1",
				}),
			];

			queueMockResponses(mockSelect, [
				makeSelectResult(workflowArtifacts),
				makeSelectResult(workflowArtifacts),
			]);
			installTransactionStub();

			const result = await deleteKnowledgeArtifactsByAction(
				"user-1",
				"forget_all_workflows",
			);

			expect(result.deletedArtifactIds).toEqual(["workflow-1"]);
		});
	});
});
