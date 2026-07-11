import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	artifacts,
	conversationContextStatus,
	conversationTaskStates,
	conversationWorkingSetItems,
	memoryDirtyLedger,
	memoryEvents,
	memoryProjectionState,
	memoryReviewItems,
	memoryReworkTelemetry,
	semanticEmbeddings,
	taskCheckpoints,
	taskStateEvidenceLinks,
} from "$lib/server/db/schema";
import {
	buildArtifactVisibilityCondition,
	getArtifactOwnershipScope,
	hardDeleteArtifactsForUser,
} from "../knowledge";
import { advanceMemoryResetGeneration } from "../memory-profile";
import { clearMessageEvidenceForUser } from "../messages";

export async function resetKnowledgeBaseState(userId: string): Promise<{
	deletedArtifactIds: string[];
}> {
	await advanceMemoryResetGeneration(userId);

	const ownershipScope = await getArtifactOwnershipScope(userId);
	const artifactRows = await db
		.select({ id: artifacts.id })
		.from(artifacts)
		.where(buildArtifactVisibilityCondition({ userId, ownershipScope }));
	const deletedArtifactIds = artifactRows.map((row) => row.id);

	if (deletedArtifactIds.length > 0) {
		await hardDeleteArtifactsForUser(userId, deletedArtifactIds);
	}

	await db.transaction((tx) => {
		tx.delete(taskStateEvidenceLinks)
			.where(eq(taskStateEvidenceLinks.userId, userId))
			.run();
		tx.delete(taskCheckpoints).where(eq(taskCheckpoints.userId, userId)).run();
		tx.delete(conversationTaskStates)
			.where(eq(conversationTaskStates.userId, userId))
			.run();
		tx.delete(memoryEvents).where(eq(memoryEvents.userId, userId)).run();
		tx.delete(memoryProjectionState)
			.where(eq(memoryProjectionState.userId, userId))
			.run();
		tx.delete(memoryReviewItems)
			.where(eq(memoryReviewItems.userId, userId))
			.run();
		tx.delete(memoryDirtyLedger)
			.where(eq(memoryDirtyLedger.userId, userId))
			.run();
		tx.delete(memoryReworkTelemetry)
			.where(eq(memoryReworkTelemetry.userId, userId))
			.run();
		tx.delete(semanticEmbeddings)
			.where(eq(semanticEmbeddings.userId, userId))
			.run();
		tx.delete(conversationWorkingSetItems)
			.where(eq(conversationWorkingSetItems.userId, userId))
			.run();
		tx.delete(conversationContextStatus)
			.where(eq(conversationContextStatus.userId, userId))
			.run();
	});

	await clearMessageEvidenceForUser(userId);

	return { deletedArtifactIds };
}
