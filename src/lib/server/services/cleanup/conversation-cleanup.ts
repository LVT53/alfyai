import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { conversations } from "$lib/server/db/schema";
import {
	cancelActiveAtlasJobsForConversation,
	deleteAtlasJobsForConversation,
} from "../atlas";
import { deleteAllChatFilesForConversation } from "../chat-files";
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

	await cancelActiveAtlasJobsForConversation({ userId, conversationId });

	const ownedArtifacts = await listConversationOwnedArtifacts(
		userId,
		conversationId,
	);
	const deletedArtifactIds: string[] = [];
	const preservedArtifactIds: string[] = [];

	for (const artifact of ownedArtifacts) {
		// A working artifact cannot outlive its conversation.
		//
		// `generated_output` and `work_capsule` are owned ONLY through their
		// conversation link (`isArtifactCanonicallyOwned`), and
		// `artifacts.conversation_id` is `ON DELETE SET NULL`. Preserving one
		// therefore did not keep it — it stranded it: the link was cleared moments
		// later by the conversation delete below, and the row became invisible in
		// the library, unreachable from any chat, and impossible to remove, while
		// its chunks, its stored file and its MinerU parse bundle stayed on disk.
		//
		// A reference from outside the conversation cannot rescue one either,
		// because a link confers no ownership and `conversation_id` holds exactly
		// one conversation. So for these two types there is nothing to weigh: they
		// belong to this conversation alone and they go with it.
		if (
			artifact.type === "generated_output" ||
			artifact.type === "work_capsule"
		) {
			deletedArtifactIds.push(artifact.id);
			continue;
		}

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
	await deleteAtlasJobsForConversation({ userId, conversationId });

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
