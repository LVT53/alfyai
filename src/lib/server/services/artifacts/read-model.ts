// What the chat needs to know about the artifacts a conversation made: the
// panel's "what this chat made" list and, by its length, the header count.
// Both come from here and from nowhere else, through the conversation detail
// payload the chat page already refreshes after a file-producing turn.
import { and, count, desc, eq, inArray, max } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	artifactComments,
	artifacts,
	artifactVersions,
} from "$lib/server/db/schema";
import { listConversationGeneratedFiles } from "$lib/server/services/file-production/read-model";
import {
	buildArtifactCanonicalOwnershipCondition,
	getArtifactOwnershipScope,
} from "$lib/server/services/knowledge/store/core";
import {
	FAMILY_ROW_TYPES,
	kindForArtifactRow,
	titleForArtifactRow,
} from "./record";
import type { ArtifactCardSummary } from "./types";

/**
 * The conversation's artifacts, newest change first: its own `artifact` rows,
 * and its produced files (`generated_output`, kind `file`) — but only a
 * produced file that has a file to open. Which chat file a produced-file
 * artifact stands for is the file-production read model's existing join
 * (metadata `originalChatFileId` / rendered-file ids, one artifact per chat
 * file), reused rather than written a second time.
 *
 * The conversation is the served one, so an incognito conversation lists its
 * own artifacts; no other conversation's — and no other user's — ever appear,
 * because the rows are filtered by the canonical ownership condition and pinned
 * to `artifacts.conversationId`.
 */
export async function listArtifactsForConversation(params: {
	userId: string;
	conversationId: string;
}): Promise<ArtifactCardSummary[]> {
	const ownershipScope = await getArtifactOwnershipScope(params.userId, {
		conversationId: params.conversationId,
	});
	// Not one of the caller's conversations: nothing to list, and nothing to
	// reveal about whether it holds anything.
	if (!ownershipScope.conversationIds.has(params.conversationId)) return [];

	const rows = await db
		.select({
			id: artifacts.id,
			type: artifacts.type,
			name: artifacts.name,
			metadataJson: artifacts.metadataJson,
			conversationId: artifacts.conversationId,
			updatedAt: artifacts.updatedAt,
		})
		.from(artifacts)
		.where(
			and(
				eq(artifacts.conversationId, params.conversationId),
				inArray(artifacts.type, FAMILY_ROW_TYPES),
				buildArtifactCanonicalOwnershipCondition({
					userId: params.userId,
					ownershipScope,
				}),
			),
		)
		.orderBy(desc(artifacts.updatedAt), desc(artifacts.id));
	if (rows.length === 0) return [];

	const openableFileArtifactIds = rows.some(
		(row) => row.type === "generated_output",
	)
		? new Set(
				(await listConversationGeneratedFiles(params.conversationId))
					.map((file) => file.artifactId)
					.filter((id): id is string => Boolean(id)),
			)
		: new Set<string>();
	const listed = rows.filter(
		(row) =>
			row.type !== "generated_output" || openableFileArtifactIds.has(row.id),
	);
	if (listed.length === 0) return [];

	const ids = listed.map((row) => row.id);
	const [versionRows, commentRows] = await Promise.all([
		db
			.select({
				artifactId: artifactVersions.artifactId,
				newest: max(artifactVersions.versionNumber),
			})
			.from(artifactVersions)
			.where(inArray(artifactVersions.artifactId, ids))
			.groupBy(artifactVersions.artifactId),
		db
			.select({
				artifactId: artifactComments.artifactId,
				total: count(),
			})
			.from(artifactComments)
			.where(inArray(artifactComments.artifactId, ids))
			.groupBy(artifactComments.artifactId),
	]);
	const newestVersionById = new Map(
		versionRows.map((row) => [row.artifactId, row.newest ?? 0]),
	);
	const commentCountById = new Map(
		commentRows.map((row) => [row.artifactId, row.total]),
	);

	return listed.map((row) => ({
		id: row.id,
		kind: kindForArtifactRow(row),
		title: titleForArtifactRow(row),
		conversationId: row.conversationId ?? null,
		versionNumber: newestVersionById.get(row.id) ?? 0,
		commentCount: commentCountById.get(row.id) ?? 0,
		updatedAt: row.updatedAt.getTime(),
	}));
}
