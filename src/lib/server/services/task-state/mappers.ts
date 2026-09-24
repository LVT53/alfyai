import type {
	artifactChunks,
	conversationTaskStates,
	taskCheckpoints,
} from "$lib/server/db/schema";
import type { ArtifactChunk } from "$lib/server/services/knowledge/types";
import type {
	TaskCheckpoint,
	TaskState,
	VerificationStatus,
} from "$lib/server/services/task-state/types";
import { parseJsonStringArray } from "$lib/server/utils/json";

export function mapTaskState(
	row: typeof conversationTaskStates.$inferSelect,
): TaskState {
	return {
		taskId: row.taskId,
		userId: row.userId,
		conversationId: row.conversationId,
		status: row.status as TaskState["status"],
		objective: row.objective,
		confidence: row.confidence ?? 0,
		locked: row.locked === 1,
		lastConfirmedTurnMessageId: row.lastConfirmedTurnMessageId ?? null,
		constraints: parseJsonStringArray(row.constraintsJson),
		factsToPreserve: parseJsonStringArray(row.factsToPreserveJson),
		decisions: parseJsonStringArray(row.decisionsJson),
		openQuestions: parseJsonStringArray(row.openQuestionsJson),
		activeArtifactIds: parseJsonStringArray(row.activeArtifactIdsJson),
		nextSteps: parseJsonStringArray(row.nextStepsJson),
		lastCheckpointAt: row.lastCheckpointAt
			? row.lastCheckpointAt.getTime()
			: null,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

export function mapTaskCheckpoint(
	row: typeof taskCheckpoints.$inferSelect,
): TaskCheckpoint {
	return {
		id: row.id,
		taskId: row.taskId,
		userId: row.userId,
		conversationId: row.conversationId,
		checkpointType: row.checkpointType as TaskCheckpoint["checkpointType"],
		content: row.content,
		sourceTurnRange: row.sourceTurnRange ?? null,
		sourceEvidenceIds: parseJsonStringArray(row.sourceEvidenceIdsJson),
		verificationStatus: row.verificationStatus as VerificationStatus,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

export function mapArtifactChunk(
	row: typeof artifactChunks.$inferSelect,
): ArtifactChunk {
	return {
		id: row.id,
		artifactId: row.artifactId,
		userId: row.userId,
		conversationId: row.conversationId ?? null,
		chunkIndex: row.chunkIndex,
		contentText: row.contentText,
		tokenEstimate: row.tokenEstimate,
		// NULL for direct text and for every row written before structure-aware
		// chunking existed. `formatPageCitation` reads that as "no citation".
		pageStart: row.pageStart ?? null,
		pageEnd: row.pageEnd ?? null,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}
