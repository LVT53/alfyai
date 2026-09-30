/**
 * The name of the chat file that holds a block's still image (a poster). One name
 * for one block of one board, so a new picture of the block replaces the last, and
 * so the serving of generated files can tell a poster — a file that hangs from no
 * reply, on purpose, so nothing lists it — from any other file that hangs from
 * none, which it refuses (a file of a job that did not succeed is not to be seen).
 * Browser-safe: no runtime imports.
 */
const POSTER_FILE_PREFIX = "canvas-poster-";

/** A block's id as a piece of a file name: nothing but letters, digits, dashes and underscores. */
function namePart(id: string): string {
	return id.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 64) || "block";
}

export function posterFileName(boardId: string, nodeId: string): string {
	return `${POSTER_FILE_PREFIX}${posterFileScope(boardId)}${namePart(nodeId)}.png`;
}

/** What every poster of one board's file name starts with: the board's id and the dash before the block's. */
function posterFileScope(boardId: string): string {
	return `${namePart(boardId)}-`;
}

/** Whether this is a poster of this board (a board's id is a whole id, so no board's scope starts another's). */
export function isPosterOfBoard(filename: string, boardId: string): boolean {
	return (
		isPosterFileName(filename) &&
		filename.startsWith(`${POSTER_FILE_PREFIX}${posterFileScope(boardId)}`)
	);
}

export function isPosterFileName(filename: string): boolean {
	return filename.startsWith(POSTER_FILE_PREFIX) && filename.endsWith(".png");
}
