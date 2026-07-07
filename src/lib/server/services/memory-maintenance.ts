import { and, desc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	artifactChunks,
	artifacts,
	conversationSummaries,
	conversations,
	conversationTaskStates,
	memoryProjects,
	memoryProjectTaskLinks,
	projects,
	semanticEmbeddings,
	taskCheckpoints,
	users,
} from "$lib/server/db/schema";
import { DAY_MS } from "$lib/server/utils/constants";
import { deleteOrphanChatFiles } from "./chat-files";
import { findOrphanFiles } from "./disk-reconciliation";
import {
	repairGeneratedOutputFamilyStatuses,
	repairGeneratedOutputRetrievalClasses,
} from "./evidence-family";
import {
	recordStepFailure,
	recordStepStart,
	recordStepSuccess,
} from "./maintenance-metrics";
import { pruneOldMemoryEvents } from "./memory-events";
import { backfillSemanticEmbeddingsForUser } from "./semantic-embedding-refresh";
import { deleteSemanticEmbeddingsForSubjects } from "./semantic-embeddings";
import {
	pruneOrphanProjectMemory,
	updateProjectMemoryStatuses,
} from "./task-state";

const KEEP_MICRO_CHECKPOINTS = 6;
const KEEP_STABLE_CHECKPOINTS = 3;
const TASK_ARCHIVE_AFTER_DAYS = 30;
const CHAT_MAINTENANCE_DEBOUNCE_MS = 10 * 60_000;
const EMBEDDING_BACKFILL_COOLDOWN_MS = 24 * 60 * 60_000;

let schedulerStarted = false;
let schedulerHandle: ReturnType<typeof setInterval> | null = null;
const userMaintenanceStates = new Map<
	string,
	{
		inFlight: Promise<void> | null;
		rerunRequested: boolean;
		lastCompletedAt: number;
		scheduledReason: string | null;
		timer: ReturnType<typeof setTimeout> | null;
	}
>();

const userLastBackfill = new Map<string, number>();

const _globalCleanupRun = new Set<string>();

function taskIsStale(updatedAt: Date, now = Date.now()): boolean {
	return now - updatedAt.getTime() >= TASK_ARCHIVE_AFTER_DAYS * DAY_MS;
}

async function pruneTaskCheckpoints(userId: string): Promise<void> {
	const rows = await db
		.select()
		.from(taskCheckpoints)
		.where(eq(taskCheckpoints.userId, userId))
		.orderBy(desc(taskCheckpoints.updatedAt));

	const keepIds = new Set<string>();
	const counts = new Map<string, { micro: number; stable: number }>();

	for (const row of rows) {
		const current = counts.get(row.taskId) ?? { micro: 0, stable: 0 };
		if (row.checkpointType === "micro") {
			if (current.micro < KEEP_MICRO_CHECKPOINTS) {
				keepIds.add(row.id);
				current.micro += 1;
			}
		} else if (row.checkpointType === "stable") {
			if (current.stable < KEEP_STABLE_CHECKPOINTS) {
				keepIds.add(row.id);
				current.stable += 1;
			}
		} else {
			keepIds.add(row.id);
		}
		counts.set(row.taskId, current);
	}

	const idsToDelete = rows
		.map((row) => row.id)
		.filter((id) => !keepIds.has(id));
	if (idsToDelete.length === 0) return;

	await db
		.delete(taskCheckpoints)
		.where(
			and(
				eq(taskCheckpoints.userId, userId),
				inArray(taskCheckpoints.id, idsToDelete),
			),
		);
}

async function archiveStaleTaskMemory(userId: string): Promise<void> {
	const rows = await db
		.select({
			taskId: conversationTaskStates.taskId,
			status: conversationTaskStates.status,
			updatedAt: conversationTaskStates.updatedAt,
		})
		.from(conversationTaskStates)
		.where(eq(conversationTaskStates.userId, userId));

	const staleIds = rows
		.filter((row) => row.status !== "archived" && taskIsStale(row.updatedAt))
		.map((row) => row.taskId);
	if (staleIds.length === 0) return;

	await db
		.update(conversationTaskStates)
		.set({
			status: "archived",
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(conversationTaskStates.userId, userId),
				inArray(conversationTaskStates.taskId, staleIds),
			),
		);
}

async function pruneOrphanConversationSummaries(
	userId: string,
): Promise<number> {
	const orphanRows = await db
		.select({ conversationId: conversationSummaries.conversationId })
		.from(conversationSummaries)
		.where(
			and(
				eq(conversationSummaries.userId, userId),
				notInArray(
					conversationSummaries.conversationId,
					db
						.select({ id: conversations.id })
						.from(conversations)
						.where(eq(conversations.userId, userId)),
				),
			),
		);

	if (orphanRows.length === 0) return 0;

	const result = await db.delete(conversationSummaries).where(
		and(
			eq(conversationSummaries.userId, userId),
			inArray(
				conversationSummaries.conversationId,
				orphanRows.map((r) => r.conversationId),
			),
		),
	);

	return result.changes;
}

async function pruneOrphanArtifactChunks(userId: string): Promise<number> {
	const orphanRows = await db
		.select({ id: artifactChunks.id })
		.from(artifactChunks)
		.where(
			and(
				eq(artifactChunks.userId, userId),
				notInArray(
					artifactChunks.artifactId,
					db
						.select({ id: artifacts.id })
						.from(artifacts)
						.where(eq(artifacts.userId, userId)),
				),
			),
		);

	if (orphanRows.length === 0) return 0;

	const result = await db.delete(artifactChunks).where(
		and(
			eq(artifactChunks.userId, userId),
			inArray(
				artifactChunks.id,
				orphanRows.map((r) => r.id),
			),
		),
	);

	return result.changes;
}

async function pruneOrphanMemoryProjects(userId: string): Promise<number> {
	const orphanRows = await db
		.select({ projectId: memoryProjects.projectId })
		.from(memoryProjects)
		.where(
			and(
				eq(memoryProjects.userId, userId),
				notInArray(
					memoryProjects.projectId,
					db
						.select({ projectId: memoryProjectTaskLinks.projectId })
						.from(memoryProjectTaskLinks)
						.where(eq(memoryProjectTaskLinks.userId, userId)),
				),
				notInArray(
					memoryProjects.projectId,
					db
						.select({
							canonicalMemoryProjectId: projects.canonicalMemoryProjectId,
						})
						.from(projects)
						.where(
							and(
								eq(projects.userId, userId),
								isNotNull(projects.canonicalMemoryProjectId),
							),
						),
				),
			),
		);

	const orphanIds = orphanRows.map((r) => r.projectId);
	if (orphanIds.length === 0) return 0;

	const result = await db
		.delete(memoryProjects)
		.where(
			and(
				eq(memoryProjects.userId, userId),
				inArray(memoryProjects.projectId, orphanIds),
			),
		);

	return result.changes;
}

function getUserMaintenanceState(userId: string) {
	const existing = userMaintenanceStates.get(userId);
	if (existing) return existing;

	const created = {
		inFlight: null as Promise<void> | null,
		rerunRequested: false,
		lastCompletedAt: 0,
		scheduledReason: null as string | null,
		timer: null as ReturnType<typeof setTimeout> | null,
	};
	userMaintenanceStates.set(userId, created);
	return created;
}

function shouldDebounceMaintenanceReason(reason: string): boolean {
	return reason === "chat_send" || reason === "chat_stream";
}

function clearScheduledMaintenance(
	state: ReturnType<typeof getUserMaintenanceState>,
): void {
	if (state.timer) {
		clearTimeout(state.timer);
		state.timer = null;
	}
}

function scheduleDeferredUserMaintenance(
	userId: string,
	reason: string,
	delayMs: number,
): void {
	const state = getUserMaintenanceState(userId);
	state.scheduledReason = reason;
	if (state.timer) return;

	state.timer = setTimeout(
		() => {
			state.timer = null;
			const scheduledReason = state.scheduledReason ?? reason;
			state.scheduledReason = null;
			void startUserMemoryMaintenance(userId, scheduledReason, {
				bypassDebounce: true,
			});
		},
		Math.max(0, delayMs),
	);
	state.timer.unref?.();
}

async function runGlobalCleanupOnce(
	key: string,
	fn: () => Promise<void>,
): Promise<void> {
	if (_globalCleanupRun.has(key)) return;
	_globalCleanupRun.add(key);
	try {
		await fn();
	} catch (error) {
		console.warn("[MEMORY_MAINTENANCE] Global cleanup failed", { key, error });
	}
}

async function performUserMemoryMaintenance(
	userId: string,
	reason = "manual",
): Promise<void> {
	const errors: string[] = [];

	const safe = async <T>(
		label: string,
		fn: () => Promise<T>,
	): Promise<T | undefined> => {
		const startTime = recordStepStart(userId, label);
		try {
			const result = await fn();
			recordStepSuccess(userId, label, startTime);
			return result;
		} catch (error) {
			recordStepFailure(userId, label, startTime, error);
			errors.push(
				`${label}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	};

	const generatedOutputArtifacts = await safe("fetch artifacts", () =>
		db
			.select()
			.from(artifacts)
			.where(
				and(
					eq(artifacts.userId, userId),
					eq(artifacts.type, "generated_output"),
				),
			)
			.orderBy(desc(artifacts.updatedAt)),
	);

	if (generatedOutputArtifacts) {
		await safe("repair retrieval classes", () =>
			repairGeneratedOutputRetrievalClasses(userId, generatedOutputArtifacts),
		);
		await safe("repair family statuses", () =>
			repairGeneratedOutputFamilyStatuses(userId, generatedOutputArtifacts),
		);
	}

	// Incremental embedding backfill (Fix 11)
	const lastBackfill = userLastBackfill.get(userId) ?? 0;
	const now = Date.now();
	if (now - lastBackfill >= EMBEDDING_BACKFILL_COOLDOWN_MS) {
		const backfillResult = await safe("semantic backfill", () =>
			backfillSemanticEmbeddingsForUser(userId),
		);
		userLastBackfill.set(userId, now);
		if (backfillResult) {
			console.info("[MEMORY_MAINTENANCE] Semantic backfill", {
				userId,
				...backfillResult,
			});
		}
	}

	await safe("prune checkpoints", () => pruneTaskCheckpoints(userId));
	await safe("archive stale tasks", () => archiveStaleTaskMemory(userId));
	await safe("update project statuses", () =>
		updateProjectMemoryStatuses(userId),
	);
	await safe("prune orphan project memory", () =>
		pruneOrphanProjectMemory(userId),
	);

	await safe("prune old memory events", () => pruneOldMemoryEvents({ userId }));
	await safe("delete orphan semantic embeddings", async () => {
		const orphanRows = await db
			.select({ subjectId: semanticEmbeddings.subjectId })
			.from(semanticEmbeddings)
			.where(
				and(
					eq(semanticEmbeddings.userId, userId),
					eq(semanticEmbeddings.subjectType, "artifact"),
					notInArray(
						semanticEmbeddings.subjectId,
						db
							.select({ id: artifacts.id })
							.from(artifacts)
							.where(eq(artifacts.userId, userId)),
					),
				),
			);

		const orphanIds = [...new Set(orphanRows.map((r) => r.subjectId))];
		await deleteSemanticEmbeddingsForSubjects({
			userId,
			subjectType: "artifact",
			subjectIds: orphanIds,
		});
	});

	await safe("prune orphan summaries", () =>
		pruneOrphanConversationSummaries(userId),
	);
	await safe("prune orphan chunks", () => pruneOrphanArtifactChunks(userId));
	await safe("prune orphan memory projects", () =>
		pruneOrphanMemoryProjects(userId),
	);

	// Global cleanup (run once per process lifetime)
	await runGlobalCleanupOnce("deleteOrphanChatFiles", async () => {
		const deleted = await deleteOrphanChatFiles();
		console.info("[MEMORY_MAINTENANCE] Orphan chat files deleted", { deleted });
	});

	await runGlobalCleanupOnce("findOrphanFiles", async () => {
		const report = await findOrphanFiles();
		console.info("[MEMORY_MAINTENANCE] Disk reconciliation report", report);
	});

	if (errors.length > 0) {
		console.warn("[MEMORY_MAINTENANCE] Completed with errors", {
			userId,
			reason,
			errors,
		});
	} else {
		console.info("[MEMORY_MAINTENANCE] Completed", {
			userId,
			reason,
		});
	}
}

async function startUserMemoryMaintenance(
	userId: string,
	reason: string,
	options?: { bypassDebounce?: boolean },
): Promise<void> {
	const state = getUserMaintenanceState(userId);
	if (!options?.bypassDebounce) {
		clearScheduledMaintenance(state);
		state.scheduledReason = null;
	}

	const runPromise = performUserMemoryMaintenance(userId, reason).finally(
		() => {
			state.inFlight = null;
			state.lastCompletedAt = Date.now();

			if (state.rerunRequested) {
				const rerunReason = state.scheduledReason ?? reason;
				state.rerunRequested = false;
				state.scheduledReason = null;
				void startUserMemoryMaintenance(userId, rerunReason, {
					bypassDebounce: true,
				});
			}
		},
	);

	state.inFlight = runPromise;
	await runPromise;
}

export async function runUserMemoryMaintenance(
	userId: string,
	reason = "manual",
): Promise<void> {
	const state = getUserMaintenanceState(userId);
	const debounceReason = shouldDebounceMaintenanceReason(reason);

	if (state.inFlight) {
		state.rerunRequested = true;
		state.scheduledReason = reason;
		return state.inFlight;
	}

	if (debounceReason && state.lastCompletedAt > 0) {
		const elapsedMs = Date.now() - state.lastCompletedAt;
		if (elapsedMs < CHAT_MAINTENANCE_DEBOUNCE_MS) {
			scheduleDeferredUserMaintenance(
				userId,
				reason,
				CHAT_MAINTENANCE_DEBOUNCE_MS - elapsedMs,
			);
			return;
		}
	}

	await startUserMemoryMaintenance(userId, reason);
}

export async function runAllUsersMemoryMaintenance(
	reason = "scheduler",
): Promise<void> {
	_globalCleanupRun.clear();

	const rows = await db.select({ id: users.id }).from(users);
	for (let i = 0; i < rows.length; i++) {
		if (i > 0) {
			await new Promise((r) => setTimeout(r, 200));
		}
		await runUserMemoryMaintenance(rows[i].id, reason);
	}
}

export async function quiesceUserMemoryMaintenance(
	userId: string,
): Promise<void> {
	const state = userMaintenanceStates.get(userId);
	if (!state) return;

	clearScheduledMaintenance(state);
	state.scheduledReason = null;
	state.rerunRequested = false;
	if (state.inFlight) {
		await state.inFlight;
	}
	userMaintenanceStates.delete(userId);
	userLastBackfill.delete(userId);
}

export function ensureMemoryMaintenanceScheduler(): void {
	if (schedulerStarted) return;
	const intervalMinutes = getConfig().memoryMaintenanceIntervalMinutes;
	if (!intervalMinutes || intervalMinutes <= 0) return;

	schedulerStarted = true;
	schedulerHandle = setInterval(() => {
		void runAllUsersMemoryMaintenance("scheduler");
	}, intervalMinutes * 60_000);
	schedulerHandle.unref?.();
	console.info("[MEMORY_MAINTENANCE] Scheduler enabled", { intervalMinutes });
}

export function stopMemoryMaintenanceScheduler(): void {
	if (schedulerHandle) {
		clearInterval(schedulerHandle);
		schedulerHandle = null;
	}
	schedulerStarted = false;
	for (const state of userMaintenanceStates.values()) {
		clearScheduledMaintenance(state);
		state.scheduledReason = null;
		state.rerunRequested = false;
	}
	userMaintenanceStates.clear();
	userLastBackfill.clear();
	_globalCleanupRun.clear();
}
