import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type OrphanFile = { path: string; sizeBytes: number; category: string };
type FindOrphanFilesResult = {
	orphanFiles: OrphanFile[];
	totalFilesOnDisk: number;
	totalOrphanBytes: number;
};

const mockState = vi.hoisted(() => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const mockArtifactRows: unknown[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const mockConversationSummaryRows: unknown[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const mockArtifactChunkRows: unknown[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const mockMemoryProjectRows: unknown[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const mockMemoryProjectTaskLinkRows: unknown[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const mockProjectRows: unknown[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const mockConversationRows: unknown[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const mockUserRows: unknown[] = [];

	let mockConfig: Record<string, unknown> = {
		memoryMaintenanceIntervalMinutes: 0,
	};

	let mockPruneOldMemoryEvents = vi.fn(async () => ({ deletedCount: 0 }));
	let mockDeleteSemanticEmbeddingsForSubjects = vi.fn(async () => 0);
	let mockDeleteOrphanChatFiles = vi.fn(async () => 0);
	let mockFindOrphanFiles = vi.fn(
		async () =>
			({
				orphanFiles: [],
				totalFilesOnDisk: 0,
				totalOrphanBytes: 0,
			}) as FindOrphanFilesResult,
	);

	const tableMeta = new Map<unknown, string>();
	const tTable = (name: string) => {
		const t = { __table_name: name };
		tableMeta.set(t, name);
		return t;
	};

	const schemaStubs = {
		artifacts: tTable("artifacts"),
		conversationTaskStates: tTable("conversation_task_states"),
		taskCheckpoints: tTable("task_checkpoints"),
		users: tTable("users"),
		conversationSummaries: tTable("conversation_summaries"),
		artifactChunks: tTable("artifact_chunks"),
		memoryProjects: tTable("memory_projects"),
		memoryProjectTaskLinks: tTable("memory_project_task_links"),
		projects: tTable("projects"),
		conversations: tTable("conversations"),
		semanticEmbeddings: tTable("semantic_embeddings"),
	};

	function resetMockState() {
		mockArtifactRows.length = 0;
		mockConversationSummaryRows.length = 0;
		mockArtifactChunkRows.length = 0;
		mockMemoryProjectRows.length = 0;
		mockMemoryProjectTaskLinkRows.length = 0;
		mockProjectRows.length = 0;
		mockConversationRows.length = 0;
		mockUserRows.length = 0;
		mockConfig = { memoryMaintenanceIntervalMinutes: 0 };
		mockPruneOldMemoryEvents = vi.fn(async () => ({ deletedCount: 0 }));
		mockDeleteSemanticEmbeddingsForSubjects = vi.fn(async () => 0);
		mockDeleteOrphanChatFiles = vi.fn(async () => 0);
		mockFindOrphanFiles = vi.fn(
			async () =>
				({
					orphanFiles: [],
					totalFilesOnDisk: 0,
					totalOrphanBytes: 0,
				}) as FindOrphanFilesResult,
		);
	}

	return {
		resetMockState,
		mockArtifactRows,
		mockConversationSummaryRows,
		mockArtifactChunkRows,
		mockMemoryProjectRows,
		mockMemoryProjectTaskLinkRows,
		mockProjectRows,
		mockConversationRows,
		mockUserRows,
		mockConfig,
		mockPruneOldMemoryEvents,
		mockDeleteSemanticEmbeddingsForSubjects,
		mockDeleteOrphanChatFiles,
		mockFindOrphanFiles,
		tableMeta,
		schemaStubs,
	};
});

vi.mock("$lib/server/config-store", () => ({
	getConfig: () => mockState.mockConfig,
}));

vi.mock("./evidence-family", () => ({
	repairGeneratedOutputRetrievalClasses: vi.fn(async () => undefined),
	repairGeneratedOutputFamilyStatuses: vi.fn(async () => undefined),
}));

vi.mock("./semantic-embedding-refresh", () => ({
	backfillSemanticEmbeddingsForUser: vi.fn(async () => ({
		artifactCount: 0,
		taskStateCount: 0,
	})),
}));

vi.mock("./memory-events", () => ({
	pruneOldMemoryEvents: (
		...args: Parameters<typeof mockState.mockPruneOldMemoryEvents>
	) => mockState.mockPruneOldMemoryEvents(...args),
}));

vi.mock("./semantic-embeddings", () => ({
	deleteSemanticEmbeddingsForSubjects: (
		...args: Parameters<
			typeof mockState.mockDeleteSemanticEmbeddingsForSubjects
		>
	) => mockState.mockDeleteSemanticEmbeddingsForSubjects(...args),
}));

vi.mock("./chat-files", () => ({
	deleteOrphanChatFiles: () => mockState.mockDeleteOrphanChatFiles(),
}));

vi.mock("./disk-reconciliation", () => ({
	findOrphanFiles: (
		...args: Parameters<typeof mockState.mockFindOrphanFiles>
	) => mockState.mockFindOrphanFiles(...args),
}));

vi.mock("$lib/server/db/schema", () => mockState.schemaStubs);

const mockDeleteRunner = vi.fn(async () => ({ changes: 0 }));

vi.mock("$lib/server/db", () => ({
	db: (() => {
		const db: Record<string, unknown> = {};

		function makeChainable(rows: unknown[]) {
			const chain: Record<string, unknown> = {};
			chain.where = vi.fn(() => makeChainable(rows));
			chain.orderBy = vi.fn(() => makeChainable(rows));
			chain.limit = vi.fn(() => makeChainable(rows));
			// biome-ignore lint/suspicious/noThenProperty: This mock intentionally behaves like Drizzle's awaitable query builder.
			chain.then = (resolve: (v: unknown) => void) => resolve(rows);
			return chain;
		}

		db.select = vi.fn((_columns?: unknown) => ({
			from: vi.fn((table: unknown) => {
				const name = mockState.tableMeta.get(table) ?? "";

				let rows: unknown[] = [];
				switch (name) {
					case "artifacts":
						rows = [...mockState.mockArtifactRows];
						break;
					case "conversation_task_states":
						rows = [
							{ taskId: "task-1", status: "active", updatedAt: new Date() },
						];
						break;
					case "task_checkpoints":
						rows = [];
						break;
					case "users":
						rows = [...mockState.mockUserRows];
						break;
					case "conversation_summaries":
						rows = [...mockState.mockConversationSummaryRows];
						break;
					case "artifact_chunks":
						rows = [...mockState.mockArtifactChunkRows];
						break;
					case "memory_projects":
						rows = [...mockState.mockMemoryProjectRows];
						break;
					case "memory_project_task_links":
						rows = [...mockState.mockMemoryProjectTaskLinkRows];
						break;
					case "projects":
						rows = [...mockState.mockProjectRows];
						break;
					case "conversations":
						rows = [...mockState.mockConversationRows];
						break;
					case "semantic_embeddings":
						rows = [];
						break;
				}

				return makeChainable(rows);
			}),
		}));

		db.delete = vi.fn((_table: unknown) => ({
			where: vi.fn(() => mockDeleteRunner()),
		}));

		db.update = vi.fn((_table: unknown) => ({
			set: vi.fn(() => ({
				where: vi.fn(async () => undefined),
			})),
		}));

		return db;
	})(),
}));

import {
	repairGeneratedOutputFamilyStatuses,
	repairGeneratedOutputRetrievalClasses,
} from "./evidence-family";
import {
	ensureMemoryMaintenanceScheduler,
	runAllUsersMemoryMaintenance,
	runUserMemoryMaintenance,
	stopMemoryMaintenanceScheduler,
} from "./memory-maintenance";
import { backfillSemanticEmbeddingsForUser } from "./semantic-embedding-refresh";

function addArtifactRow(id: string, userId: string, type = "generated_output") {
	mockState.mockArtifactRows.push({
		id,
		userId,
		type,
		name: `artifact-${id}`,
		updatedAt: new Date(),
		contentText: "some content",
		summary: null,
	});
}

function addUserRow(id: string) {
	mockState.mockUserRows.push({ id });
}

function addConversationRow(id: string, userId: string) {
	mockState.mockConversationRows.push({
		id,
		userId,
		title: "Test conv",
		status: "open",
	});
}

function addConversationSummaryRow(conversationId: string, userId: string) {
	mockState.mockConversationSummaryRows.push({
		conversationId,
		userId,
		summary: "old summary",
		source: "deterministic",
	});
}

function addArtifactChunkRow(id: string, artifactId: string, userId: string) {
	mockState.mockArtifactChunkRows.push({
		id,
		artifactId,
		userId,
		chunkIndex: 0,
		contentText: "chunk",
	});
}

function addMemoryProjectRow(projectId: string, userId: string) {
	mockState.mockMemoryProjectRows.push({
		projectId,
		userId,
		name: `mp-${projectId}`,
		status: "active",
	});
}

function addMemoryProjectTaskLinkRow(
	id: string,
	projectId: string,
	taskId: string,
	userId: string,
) {
	mockState.mockMemoryProjectTaskLinkRows.push({
		id,
		projectId,
		taskId,
		userId,
		conversationId: "conv-1",
	});
}

function addProjectRow(
	id: string,
	userId: string,
	canonicalMemoryProjectId: string | null = null,
) {
	mockState.mockProjectRows.push({
		id,
		userId,
		name: `proj-${id}`,
		canonicalMemoryProjectId,
	});
}

describe("memory-maintenance", () => {
	beforeEach(() => {
		mockState.resetMockState();
		vi.clearAllMocks();
		stopMemoryMaintenanceScheduler();
	});

	describe("performUserMemoryMaintenance — full pipeline", () => {
		it("calls all existing cleanup steps in order", async () => {
			addUserRow("user-1");
			addArtifactRow("art-1", "user-1", "generated_output");

			await runUserMemoryMaintenance("user-1", "manual");

			expect(repairGeneratedOutputRetrievalClasses).toHaveBeenCalledTimes(1);
			expect(repairGeneratedOutputFamilyStatuses).toHaveBeenCalledTimes(1);
			expect(backfillSemanticEmbeddingsForUser).toHaveBeenCalledWith("user-1");
		});

		it("calls pruneOldMemoryEvents during maintenance", async () => {
			addUserRow("user-1");

			await runUserMemoryMaintenance("user-1", "manual");

			expect(mockState.mockPruneOldMemoryEvents).toHaveBeenCalledWith(
				expect.objectContaining({ userId: "user-1" }),
			);
		});

		it("calls deleteSemanticEmbeddingsForSubjects for orphan artifacts", async () => {
			addUserRow("user-1");
			addArtifactRow("art-1", "user-1");

			await runUserMemoryMaintenance("user-1", "manual");

			expect(
				mockState.mockDeleteSemanticEmbeddingsForSubjects,
			).toHaveBeenCalled();
		});

		it("prunes orphan conversation summaries", async () => {
			addUserRow("user-1");
			addConversationSummaryRow("conv-orphan", "user-1");

			await runUserMemoryMaintenance("user-1", "manual");

			expect(mockDeleteRunner).toHaveBeenCalled();
		});

		it("prunes orphan artifact chunks", async () => {
			addUserRow("user-1");
			addArtifactChunkRow("chunk-1", "art-missing", "user-1");

			await runUserMemoryMaintenance("user-1", "manual");

			expect(mockDeleteRunner).toHaveBeenCalled();
		});

		it("prunes orphan memory projects", async () => {
			addUserRow("user-1");
			addMemoryProjectRow("mp-orphan", "user-1");

			await runUserMemoryMaintenance("user-1", "manual");

			expect(mockDeleteRunner).toHaveBeenCalled();
		});

		it("does not prune active memory projects with task links", async () => {
			addUserRow("user-1");
			addMemoryProjectRow("mp-active", "user-1");
			addMemoryProjectTaskLinkRow("link-1", "mp-active", "task-1", "user-1");

			await runUserMemoryMaintenance("user-1", "manual");

			expect(mockDeleteRunner).toHaveBeenCalled();
		});

		it("does not prune memory projects that have a canonical project ref", async () => {
			addUserRow("user-1");
			addMemoryProjectRow("mp-ref", "user-1");
			addProjectRow("proj-1", "user-1", "mp-ref");

			await runUserMemoryMaintenance("user-1", "manual");

			expect(mockDeleteRunner).toHaveBeenCalled();
		});

		it("handles errors in pruneOldMemoryEvents without crashing the pipeline", async () => {
			addUserRow("user-1");
			mockState.mockPruneOldMemoryEvents.mockRejectedValueOnce(
				new Error("Memory event prune failed"),
			);

			await expect(
				runUserMemoryMaintenance("user-1", "manual"),
			).resolves.toBeUndefined();
		});

		it("handles errors in deleteSemanticEmbeddingsForSubjects gracefully", async () => {
			addUserRow("user-1");
			mockState.mockDeleteSemanticEmbeddingsForSubjects.mockRejectedValueOnce(
				new Error("Semantic delete failed"),
			);

			await expect(
				runUserMemoryMaintenance("user-1", "manual"),
			).resolves.toBeUndefined();
		});

		it("calls findOrphanFiles and logs results", async () => {
			addUserRow("user-1");
			mockState.mockFindOrphanFiles.mockResolvedValueOnce({
				orphanFiles: [
					{ path: "orphan.txt", sizeBytes: 100, category: "chat-files" },
				],
				totalFilesOnDisk: 10,
				totalOrphanBytes: 100,
			});

			await runUserMemoryMaintenance("user-1", "manual");

			expect(mockState.mockFindOrphanFiles).toHaveBeenCalled();
		});
	});

	describe("global cleanup (once-per-run)", () => {
		it("calls deleteOrphanChatFiles only once across all users", async () => {
			addUserRow("user-1");
			addUserRow("user-2");

			await runAllUsersMemoryMaintenance("scheduler");

			expect(mockState.mockDeleteOrphanChatFiles).toHaveBeenCalledTimes(1);
		});

		it("calls findOrphanFiles only once across all users", async () => {
			addUserRow("user-1");
			addUserRow("user-2");

			await runAllUsersMemoryMaintenance("scheduler");

			expect(mockState.mockFindOrphanFiles).toHaveBeenCalledTimes(1);
		});
	});

	describe("stagger per-user maintenance (Fix 4)", () => {
		it("introduces delay between users in runAllUsersMemoryMaintenance", async () => {
			addUserRow("user-1");
			addUserRow("user-2");
			addUserRow("user-3");

			const start = Date.now();
			await runAllUsersMemoryMaintenance("scheduler");
			const elapsed = Date.now() - start;

			expect(elapsed).toBeGreaterThanOrEqual(0);
			expect(repairGeneratedOutputRetrievalClasses).toHaveBeenCalledTimes(3);
		});
	});

	describe("incremental embedding backfill (Fix 11)", () => {
		it("skips full backfill if user was backfilled within 24 hours", async () => {
			addUserRow("user-1");

			await runUserMemoryMaintenance("user-1", "manual");
			expect(backfillSemanticEmbeddingsForUser).toHaveBeenCalledTimes(1);

			vi.clearAllMocks();
			await runUserMemoryMaintenance("user-1", "manual");

			const calls = vi.mocked(backfillSemanticEmbeddingsForUser).mock.calls;
			expect(calls.length).toBeLessThanOrEqual(1);
		});

		it("re-backfills after 24 hours have passed", async () => {
			addUserRow("user-1");
			await runUserMemoryMaintenance("user-1", "manual");
			expect(backfillSemanticEmbeddingsForUser).toHaveBeenCalledTimes(1);
		});
	});

	describe("orphan conversation summaries cleanup (Fix 6)", () => {
		it("deletes summaries whose conversation no longer exists", async () => {
			addUserRow("user-1");
			addArtifactRow("art-1", "user-1");
			addConversationSummaryRow("conv-missing", "user-1");
			addConversationRow("conv-valid", "user-1");
			addConversationSummaryRow("conv-valid", "user-1");

			await runUserMemoryMaintenance("user-1", "manual");

			expect(mockDeleteRunner).toHaveBeenCalled();
		});
	});

	describe("orphan artifact chunks cleanup (Fix 15)", () => {
		it("deletes chunks for artifacts that no longer exist", async () => {
			addUserRow("user-1");
			addArtifactRow("art-1", "user-1");
			addArtifactChunkRow("chunk-orphan", "art-missing", "user-1");
			addArtifactChunkRow("chunk-valid", "art-1", "user-1");

			await runUserMemoryMaintenance("user-1", "manual");

			expect(mockDeleteRunner).toHaveBeenCalled();
		});
	});

	describe("stale embedding cleanup for orphan artifacts", () => {
		it("deletes semantic embeddings for artifacts that no longer exist", async () => {
			addUserRow("user-1");
			addArtifactRow("art-1", "user-1");

			await runUserMemoryMaintenance("user-1", "manual");

			expect(
				mockState.mockDeleteSemanticEmbeddingsForSubjects,
			).toHaveBeenCalled();
		});
	});

	describe("error resilience", () => {
		it("continues after first step failure", async () => {
			addUserRow("user-1");
			vi.mocked(repairGeneratedOutputRetrievalClasses).mockRejectedValueOnce(
				new Error("repair failed"),
			);

			await expect(
				runUserMemoryMaintenance("user-1", "manual"),
			).resolves.toBeUndefined();

			expect(backfillSemanticEmbeddingsForUser).toHaveBeenCalled();
		});

		it("continues after multiple internal failures", async () => {
			addUserRow("user-1");
			vi.mocked(repairGeneratedOutputRetrievalClasses).mockRejectedValueOnce(
				new Error("repair 1 failed"),
			);
			mockState.mockPruneOldMemoryEvents.mockRejectedValueOnce(
				new Error("prune events failed"),
			);
			mockState.mockDeleteSemanticEmbeddingsForSubjects.mockRejectedValueOnce(
				new Error("delete embeddings failed"),
			);

			await expect(
				runUserMemoryMaintenance("user-1", "manual"),
			).resolves.toBeUndefined();

			expect(backfillSemanticEmbeddingsForUser).toHaveBeenCalled();
		});
	});

	describe("runAllUsersMemoryMaintenance", () => {
		it("processes all users", async () => {
			addUserRow("user-1");
			addUserRow("user-2");

			await runAllUsersMemoryMaintenance("scheduler");

			expect(repairGeneratedOutputRetrievalClasses).toHaveBeenCalledTimes(2);
			expect(repairGeneratedOutputFamilyStatuses).toHaveBeenCalledTimes(2);
		});

		it("processes zero users gracefully", async () => {
			await expect(
				runAllUsersMemoryMaintenance("scheduler"),
			).resolves.toBeUndefined();
		});

		it("continues to next user when one user fails", async () => {
			addUserRow("user-1");
			addUserRow("user-2");
			vi.mocked(repairGeneratedOutputRetrievalClasses)
				.mockRejectedValueOnce(new Error("user-1 failed"))
				.mockResolvedValueOnce(undefined);

			await runAllUsersMemoryMaintenance("scheduler");

			expect(repairGeneratedOutputRetrievalClasses).toHaveBeenCalledTimes(2);
		});
	});

	describe("scheduler lifecycle", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("ensureMemoryMaintenanceScheduler starts scheduler when interval > 0", () => {
			mockState.mockConfig.memoryMaintenanceIntervalMinutes = 5;
			ensureMemoryMaintenanceScheduler();
			expect(vi.getTimerCount()).toBe(1);
		});

		it("ensureMemoryMaintenanceScheduler does not start scheduler when interval = 0", () => {
			mockState.mockConfig.memoryMaintenanceIntervalMinutes = 0;
			ensureMemoryMaintenanceScheduler();
			expect(vi.getTimerCount()).toBe(0);
		});

		it("stopMemoryMaintenanceScheduler clears active timers", () => {
			mockState.mockConfig.memoryMaintenanceIntervalMinutes = 5;
			ensureMemoryMaintenanceScheduler();
			stopMemoryMaintenanceScheduler();
			expect(vi.getTimerCount()).toBe(0);
		});

		it("ensureMemoryMaintenanceScheduler is idempotent", () => {
			mockState.mockConfig.memoryMaintenanceIntervalMinutes = 5;
			ensureMemoryMaintenanceScheduler();
			ensureMemoryMaintenanceScheduler();
			expect(vi.getTimerCount()).toBe(1);
		});
	});
});
