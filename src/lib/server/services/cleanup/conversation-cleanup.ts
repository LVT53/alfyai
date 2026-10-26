import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { conversations } from "$lib/server/db/schema";
import type { ConversationBatchResult } from "$lib/shared/conversation-batch";
import {
	cancelActiveAtlasJobsForConversation,
	deleteAtlasJobsForConversation,
} from "../atlas";
import { deleteAllChatFilesForConversation } from "../chat-files";
import {
	getOrphanedStream,
	requestActiveChatStreamStop,
} from "../chat-turn/active-streams";
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

	// A reply that is still streaming into this chat is stopped first, the way
	// the Stop button stops it. Without this the server keeps generating into a
	// chat that no longer exists. The stop is not awaited: the stream ends on
	// its own, and an end-of-turn write that meets the deleted chat is logged
	// and dropped (chat-turn/finalize.ts), never thrown at the person. The
	// registry is keyed by owner and chat, so this only ever reaches a stream
	// the person owns, and only after the ownership check above.
	const streamId = getOrphanedStream({ userId, conversationId });
	if (streamId) {
		requestActiveChatStreamStop({ streamId, userId });
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

/**
 * Deletes several chats, each exactly as `deleteConversationWithCleanup`
 * deletes one, and says what happened to each in the order the ids came:
 * `ok`, `not_found` (not the person's, or already gone: it is gone either way)
 * or `failed` (the delete threw, and the chat is still there to try again).
 * One chat's failure never stops the rest.
 *
 * The deletes run one after another on purpose. Each is a run of SQLite writes
 * plus the artifact and file cleanup, and none of that wants a second one
 * beside it.
 */
export async function deleteConversationsWithCleanup(
	userId: string,
	conversationIds: string[],
): Promise<ConversationBatchResult[]> {
	const results: ConversationBatchResult[] = [];
	for (const conversationId of conversationIds) {
		try {
			const deleted = await deleteConversationWithCleanup(
				userId,
				conversationId,
			);
			results.push(
				deleted
					? { id: conversationId, ok: true }
					: { id: conversationId, ok: false, error: "not_found" },
			);
		} catch (error) {
			console.error(
				"[CONVERSATION_BATCH_DELETE] Failed to fully delete conversation",
				{ conversationId, error },
			);
			results.push({ id: conversationId, ok: false, error: "failed" });
		}
	}
	return results;
}
