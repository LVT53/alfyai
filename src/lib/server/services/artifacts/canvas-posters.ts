/**
 * A board's poster files (RC-3 N2). A block a picture cannot reproduce (an App, the
 * map, photos, live web) carries a poster: a chat file that hangs from no reply, so
 * nothing lists it, named for its board and its block (`shared/artifacts/poster-
 * file.ts`). Nothing else keeps them company, so when the board is deleted they
 * must go with it, or they stay (one of them a montage of the owner's own photos)
 * until the chat is deleted.
 *
 * Scoped three ways, because the name alone is forgeable: the board's own chat,
 * the board's own user, and a file that hangs from no reply (a file of a reply is
 * a produced file of the chat, such as the board's exported picture, and stays).
 * Not called for a removed block: an older version of the board still draws that
 * block, and Versions can restore it.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "$lib/server/db";
import { chatGeneratedFiles } from "$lib/server/db/schema";
import { deleteChatFile } from "$lib/server/services/chat-files";
import { isPosterOfBoard } from "$lib/shared/artifacts/poster-file";

/** Deletes the poster files of one board, row and bytes; how many went. Throws on a failure, for the caller to weigh. */
export async function deleteBoardPosters(params: {
	userId: string;
	conversationId: string;
	boardId: string;
}): Promise<number> {
	const files = await db
		.select({
			id: chatGeneratedFiles.id,
			filename: chatGeneratedFiles.filename,
		})
		.from(chatGeneratedFiles)
		.where(
			and(
				eq(chatGeneratedFiles.conversationId, params.conversationId),
				eq(chatGeneratedFiles.userId, params.userId),
				isNull(chatGeneratedFiles.assistantMessageId),
			),
		);
	let deleted = 0;
	for (const file of files) {
		if (!isPosterOfBoard(file.filename, params.boardId)) continue;
		if (await deleteChatFile(params.conversationId, file.id)) deleted += 1;
	}
	return deleted;
}
