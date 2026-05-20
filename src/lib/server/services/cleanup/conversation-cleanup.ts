import { and, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import { conversations, deepResearchJobs } from "$lib/server/db/schema";
import { deleteAllChatFilesForConversation } from "../chat-files";
import { cancelRunningResearchTasks } from "../deep-research/tasks";
import { deleteConversationHonchoState } from "../honcho";
import {
	artifactHasReferencesOutsideConversation,
	getSourceArtifactIdForNormalizedArtifact,
	hardDeleteArtifactsForUser,
	listConversationOwnedArtifacts,
} from "../knowledge";

const ACTIVE_DEEP_RESEARCH_STATUSES = [
	"awaiting_plan",
	"awaiting_approval",
	"approved",
	"running",
] as const;

export async function deleteConversationWithCleanup(
	userId: string,
	conversationId: string,
): Promise<{
	deletedArtifactIds: string[];
	preservedArtifactIds: string[];
} | null> {
	const [conversation] = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(
			and(
				eq(conversations.id, conversationId),
				eq(conversations.userId, userId),
			),
		)
		.limit(1);

	if (!conversation) {
		return null;
	}

	await cancelActiveDeepResearchJobsForConversation(userId, conversationId);

	await deleteConversationHonchoState(userId, conversationId);

	const ownedArtifacts = await listConversationOwnedArtifacts(
		userId,
		conversationId,
	);
	const deletedArtifactIds: string[] = [];
	const preservedArtifactIds: string[] = [];

	for (const artifact of ownedArtifacts) {
		if (artifact.type === "normalized_document") {
			const sourceArtifactId = await getSourceArtifactIdForNormalizedArtifact(
				userId,
				artifact.id,
			);
			if (
				sourceArtifactId &&
				(await artifactHasReferencesOutsideConversation(
					userId,
					sourceArtifactId,
					conversationId,
				))
			) {
				preservedArtifactIds.push(artifact.id);
				continue;
			}
		}

		if (
			await artifactHasReferencesOutsideConversation(
				userId,
				artifact.id,
				conversationId,
			)
		) {
			preservedArtifactIds.push(artifact.id);
			continue;
		}
		deletedArtifactIds.push(artifact.id);
	}

	await hardDeleteArtifactsForUser(userId, deletedArtifactIds);
	await deleteAllChatFilesForConversation(conversationId);

	await db
		.delete(conversations)
		.where(
			and(
				eq(conversations.id, conversationId),
				eq(conversations.userId, userId),
			),
		);

	return {
		deletedArtifactIds,
		preservedArtifactIds,
	};
}

async function cancelActiveDeepResearchJobsForConversation(
	userId: string,
	conversationId: string,
): Promise<void> {
	const now = new Date();
	const activeJobs = await db
		.select({
			id: deepResearchJobs.id,
			status: deepResearchJobs.status,
			stage: deepResearchJobs.stage,
		})
		.from(deepResearchJobs)
		.where(
			and(
				eq(deepResearchJobs.userId, userId),
				eq(deepResearchJobs.conversationId, conversationId),
				inArray(deepResearchJobs.status, ACTIVE_DEEP_RESEARCH_STATUSES),
			),
		);

	if (activeJobs.length === 0) return;

	await db
		.update(deepResearchJobs)
		.set({
			status: "cancelled",
			stage: "cancelled_by_request",
			cancelledAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(deepResearchJobs.userId, userId),
				eq(deepResearchJobs.conversationId, conversationId),
				inArray(deepResearchJobs.status, ACTIVE_DEEP_RESEARCH_STATUSES),
			),
		);

	await Promise.all(
		activeJobs.map((job) =>
			cancelRunningResearchTasks({
				userId,
				jobId: job.id,
				reason: "Conversation deleted while Deep Research job was active.",
				now,
			}),
		),
	);

	console.info(
		"[CONVERSATION_DELETE] Cancelled active Deep Research jobs before deletion",
		{
			userId,
			conversationId,
			jobIds: activeJobs.map((job) => job.id),
		},
	);
}
