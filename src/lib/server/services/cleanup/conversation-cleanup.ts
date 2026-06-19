import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { conversations } from "$lib/server/db/schema";
import { deleteAllChatFilesForConversation } from "../chat-files";
import { deleteConversationHonchoState } from "../honcho";
import {
	artifactHasReferencesOutsideConversation,
	getSourceArtifactIdForNormalizedArtifact,
	hardDeleteArtifactsForUser,
	listConversationOwnedArtifacts,
} from "../knowledge";

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
