// Knowledge -> Documents' Delete, for an item that may be one of the family's own
// (Feature 2 · Artifacts; FU-1). The library keeps its own delete (the knowledge
// store's: who may delete a row, source documents with their normalized copies,
// generated-document families), and a board is a row of that store like any
// other, so its rows go the store's way and nothing about who may delete changes.
// What the store cannot reach is what a deleted board leaves outside the
// database: the poster files of its blocks. They go through the very function the
// panel's Delete calls (`deleteFilesOfDeletedBoard`), so the two Deletes take
// exactly the same files, and only for a board the store really deleted.
//
// Here, not in the store: taking a file out of a chat is the chat-file store's
// (`chat-files.ts`), which already reaches back into the knowledge facade, so the
// knowledge store cannot call it without a circular import.
import { and, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifacts } from "$lib/server/db/schema";
import { deleteArtifactForUser } from "$lib/server/services/knowledge";
import { deleteFilesOfDeletedBoard, FAMILY_ROW_TYPES } from "./record";

/**
 * `deleteArtifactForUser`, and then the files a deleted board leaves behind. The
 * answer is the store's own, unchanged: `null` for an id that is not there or not
 * the caller's to delete (the same answer for both), else what it deleted.
 */
export async function deleteLibraryArtifact(
	userId: string,
	artifactId: string,
): ReturnType<typeof deleteArtifactForUser> {
	// Read first: once the row is gone nothing says whose board it was or which chat
	// it was made in. A guess, not an authority: whether this is the caller's to
	// delete is the store's to say, and only a board it deleted has its files taken.
	const [row] = await db
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.id, artifactId),
				inArray(artifacts.type, FAMILY_ROW_TYPES),
			),
		)
		.limit(1);
	const result = await deleteArtifactForUser(userId, artifactId);
	if (row && result?.deletedArtifactIds.includes(row.id)) {
		await deleteFilesOfDeletedBoard(row);
	}
	return result;
}
