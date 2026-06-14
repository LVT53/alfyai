import type {
	artifactChunks,
	conversationTaskStates,
	taskCheckpoints,
	taskStateEvidenceLinks,
} from "$lib/server/db/schema";
import { parseJsonStringArray } from "$lib/server/utils/json";
import type {
	ArtifactChunk,
	TaskCheckpoint,
	TaskEvidenceLink,
	TaskState,
	VerificationStatus,
} from "$lib/types";

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

export function mapTaskEvidenceLink(
	row: typeof taskStateEvidenceLinks.$inferSelect,
): TaskEvidenceLink {
	return {
		id: row.id,
		taskId: row.taskId,
		userId: row.userId,
		conversationId: row.conversationId,
		artifactId: row.artifactId,
		chunkIndex: row.chunkIndex ?? null,
		role: row.role as TaskEvidenceLink["role"],
		origin: row.origin as TaskEvidenceLink["origin"],
		confidence: row.confidence ?? 0,
		reason: row.reason ?? null,
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
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}
