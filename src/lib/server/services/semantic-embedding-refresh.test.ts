import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	artifactRows,
	taskRows,
	mockEmbedTexts,
	mockListSemanticEmbeddingsBySubject,
	mockNeedsSemanticEmbeddingRefresh,
	mockUpsertSemanticEmbedding,
	mockCanUseTeiEmbedder,
	mockGetTeiEmbedderBatchSize,
} = vi.hoisted(() => ({
	artifactRows: [] as Array<{
		id: string;
		userId: string;
		name: string;
		summary: string | null;
		contentText: string | null;
	}>,
	taskRows: [] as Array<Record<string, unknown>>,
	mockEmbedTexts: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
	mockListSemanticEmbeddingsBySubject: vi.fn(async () => new Map()),
	mockNeedsSemanticEmbeddingRefresh: vi.fn(() => true),
	mockUpsertSemanticEmbedding: vi.fn(async () => undefined),
	mockCanUseTeiEmbedder: vi.fn(() => true),
	mockGetTeiEmbedderBatchSize: vi.fn(() => 8),
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: () => ({
		teiEmbedderModel: "bge-m3",
	}),
}));

vi.mock("$lib/server/db/schema", () => ({
	artifacts: { name: "artifacts", userId: { name: "userId" } },
	conversationTaskStates: {
		name: "conversationTaskStates",
		userId: { name: "userId" },
	},
}));

vi.mock("$lib/server/db", () => ({
	db: {
		select: vi.fn(() => ({
			from: vi.fn((table: { name?: string }) => ({
				where: vi.fn(async () => {
					if (table?.name === "artifacts") return artifactRows;
					if (table?.name === "conversationTaskStates") return taskRows;
					return [];
				}),
			})),
		})),
	},
}));

vi.mock("./tei-embedder", () => ({
	canUseTeiEmbedder: mockCanUseTeiEmbedder,
	embedTexts: mockEmbedTexts,
	getTeiEmbedderBatchSize: mockGetTeiEmbedderBatchSize,
}));

vi.mock("./semantic-embeddings", () => ({
	listSemanticEmbeddingsBySubject: mockListSemanticEmbeddingsBySubject,
	needsSemanticEmbeddingRefresh: mockNeedsSemanticEmbeddingRefresh,
	upsertSemanticEmbedding: mockUpsertSemanticEmbedding,
}));

vi.mock("./task-state/mappers", () => ({
	mapTaskState: (row: Record<string, unknown>) => ({
		taskId: String(row.taskId ?? ""),
		userId: String(row.userId ?? ""),
		objective: String(row.objective ?? ""),
		constraints: Array.isArray(row.constraints) ? row.constraints : [],
		factsToPreserve: Array.isArray(row.factsToPreserve)
			? row.factsToPreserve
			: [],
		decisions: Array.isArray(row.decisions) ? row.decisions : [],
		openQuestions: Array.isArray(row.openQuestions) ? row.openQuestions : [],
		nextSteps: Array.isArray(row.nextSteps) ? row.nextSteps : [],
	}),
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn(() => "eq"),
}));

describe("semantic-embedding-refresh", () => {
	beforeEach(() => {
		artifactRows.splice(0, artifactRows.length);
		taskRows.splice(0, taskRows.length);
		vi.clearAllMocks();
		mockCanUseTeiEmbedder.mockReturnValue(true);
		mockGetTeiEmbedderBatchSize.mockReturnValue(8);
		mockNeedsSemanticEmbeddingRefresh.mockReturnValue(true);
		mockListSemanticEmbeddingsBySubject.mockResolvedValue(new Map());
		mockEmbedTexts.mockImplementation(async (texts: string[]) =>
			texts.map(() => [0.1, 0.2]),
		);
		mockUpsertSemanticEmbedding.mockResolvedValue(undefined);
	});

	it("builds compact semantic source text for artifacts and task states", async () => {
		const {
			buildArtifactEmbeddingSourceText,
			buildTaskStateEmbeddingSourceText,
		} = await import("./semantic-embedding-refresh");

		expect(
			buildArtifactEmbeddingSourceText({
				id: "artifact-1",
				userId: "user-1",
				name: "Proposal",
				summary: "Draft summary",
				contentText: "Full proposal body",
			}),
		).toContain("Proposal");

		expect(
			buildTaskStateEmbeddingSourceText({
				taskId: "task-1",
				userId: "user-1",
				objective: "Finish the proposal",
				constraints: ["Keep it under 2 pages"],
				factsToPreserve: ["Client name is ACME"],
				decisions: ["Use a formal tone"],
				openQuestions: ["Need the final budget?"],
				nextSteps: ["Revise introduction"],
			} as never),
		).toContain("Objective: Finish the proposal");
	});

	it("keeps Qwen-sized artifact source text before clipping", async () => {
		const { buildArtifactEmbeddingSourceText } = await import(
			"./semantic-embedding-refresh"
		);
		const source = buildArtifactEmbeddingSourceText({
			id: "artifact-1",
			userId: "user-1",
			name: "Long document",
			summary: null,
			contentText: "x".repeat(140_000),
		});

		expect(source?.length).toBeGreaterThan(120_000);
		expect(source?.length).toBeLessThanOrEqual(131_072);
	});

	it("queues a background artifact embedding refresh", async () => {
		const { queueArtifactSemanticEmbeddingRefresh } = await import(
			"./semantic-embedding-refresh"
		);

		queueArtifactSemanticEmbeddingRefresh({
			id: "artifact-1",
			userId: "user-1",
			name: "Proposal",
			summary: "Draft summary",
			contentText: "Full proposal body",
		} as never);

		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(mockEmbedTexts).toHaveBeenCalledTimes(1);
		expect(mockUpsertSemanticEmbedding).toHaveBeenCalledWith(
			expect.objectContaining({
				subjectType: "artifact",
				subjectId: "artifact-1",
				userId: "user-1",
				modelName: "bge-m3",
			}),
		);
	});

	it("backfills missing semantic embeddings for artifacts and task states", async () => {
		artifactRows.push({
			id: "artifact-1",
			userId: "user-1",
			name: "Proposal",
			summary: "Draft summary",
			contentText: "Full proposal body",
		});
		taskRows.push({
			taskId: "task-1",
			userId: "user-1",
			objective: "Finish the proposal",
			constraints: ["Keep it under 2 pages"],
			factsToPreserve: ["Client name is ACME"],
			decisions: ["Use a formal tone"],
			openQuestions: ["Need the final budget?"],
			nextSteps: ["Revise introduction"],
		});

		const { backfillSemanticEmbeddingsForUser } = await import(
			"./semantic-embedding-refresh"
		);
		const result = await backfillSemanticEmbeddingsForUser("user-1");

		expect(result).toEqual({
			artifactCount: 1,
			taskStateCount: 1,
		});
		expect(mockEmbedTexts).toHaveBeenCalledTimes(2);
		expect(mockUpsertSemanticEmbedding).toHaveBeenCalledTimes(2);
	});
});
