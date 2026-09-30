/**
 * What the editor does with a board the server holds at a version it does not
 * know (`CanvasEditor.adoptBoard`), decided from four facts and nothing
 * else so it can be tested:
 *
 * - `unchanged`: the version is the one it already has;
 * - `ours`: the server holds exactly what the reader has. It is their own last
 *   save, seen by a read before that save's answer was handled, and needs no
 *   drawing and is no conflict (calling it one would stop their saves);
 * - `conflict`: the reader has steps the server has not seen, and the server
 *   holds a change made elsewhere. Neither is given up: the editor puts the
 *   reader's steps on top of the newer version (`rebaseBoard`, by block) and
 *   saves the result as the reader's own step, so drawing the server's board as
 *   it stands would lose those steps and saving theirs as it stands would be
 *   refused as stale;
 * - `land`: it is a change made elsewhere (Alfy answering a comment) and the
 *   reader has nothing it would lose: draw it.
 */
export type ServerBoardVerdict = "unchanged" | "ours" | "conflict" | "land";

export function judgeServerBoard(facts: {
	serverVersion: number;
	knownVersion: number | null;
	/** The server's board as canonical JSON. */
	serverJson: string;
	/** The reader's board as it is now, and as the server last acknowledged it. */
	latestJson: string;
	savedJson: string;
}): ServerBoardVerdict {
	if (facts.serverVersion === facts.knownVersion) return "unchanged";
	if (facts.serverJson === facts.latestJson) return "ours";
	if (facts.latestJson !== facts.savedJson) return "conflict";
	return "land";
}
