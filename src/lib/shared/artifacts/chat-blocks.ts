/**
 * "From this chat": what a Canvas can hold that its own conversation already
 * made — files, Apps, route maps and charts (Slice 3, the blocks made from the
 * chat). The server lists them (`services/artifacts/chat-blocks.ts`), the
 * board's Insert menu offers them, and a pick becomes one of the block kinds in
 * `canvas-blocks.ts`. Client-safe on purpose: the listing's wire shape, the one
 * file-id convention and the bound live here, so neither side redeclares them.
 */
import type { CanvasBlockData } from "./canvas-blocks";

type BlockData<K extends CanvasBlockData["kind"]> = Extract<
	CanvasBlockData,
	{ kind: K }
>;

/** How many of each kind the listing carries: the newest, so the menu it fills stays a menu. */
export const CHAT_BLOCKS_PER_KIND = 12;

/** How many of the chat's newest messages are read for route maps and charts. */
export const CHAT_BLOCKS_SCAN_MESSAGES = 200;

/**
 * A File block names its file with one id. A produced file is a
 * `chat_generated_files` row and its id is that row's (what the download and
 * preview routes take). A file the reader attached is an `artifacts` row, and
 * its id carries this prefix: the same `artifact:<id>` the panel already uses
 * as the item id of an attachment it opens. The listing writes the id and the
 * block opens through it (`fileBlockSource`).
 */
export const ATTACHED_FILE_ID_PREFIX = "artifact:";

export function attachedFileId(artifactId: string): string {
	return `${ATTACHED_FILE_ID_PREFIX}${artifactId}`;
}

export type FileBlockSource =
	| { source: "produced"; chatFileId: string }
	| { source: "attached"; artifactId: string };

/** Which kind of file a File block's id names; null for an id that names none. */
export function fileBlockSource(fileId: string): FileBlockSource | null {
	if (fileId.length === 0) return null;
	if (!fileId.startsWith(ATTACHED_FILE_ID_PREFIX)) {
		return { source: "produced", chatFileId: fileId };
	}
	const artifactId = fileId.slice(ATTACHED_FILE_ID_PREFIX.length);
	return artifactId.length > 0 ? { source: "attached", artifactId } : null;
}

export type ChatFileOrigin = "produced" | "attached";

export interface ChatFileBlock {
	/** Stable, for a list to key on. */
	key: string;
	/** When the chat made it (epoch ms): the order the listing is in. */
	at: number;
	origin: ChatFileOrigin;
	/** The produced file's version in its document family, when it has one. */
	version: number | null;
	/** Exactly what a File block stores. */
	data: BlockData<"file">;
}

export interface ChatAppBlock {
	key: string;
	at: number;
	/** The App's current version, for the row's own line. */
	versionNumber: number;
	/** Exactly what an App block stores. */
	data: BlockData<"app">;
}

export interface ChatMapBlock {
	key: string;
	at: number;
	/** The map tool's action ("route", "transit", …): what the chat's own row names the call by. */
	action: string | null;
	/** The payload the chat's map card draws, already checked against the map block's schema. */
	map: BlockData<"map">["map"];
}

export interface ChatChartBlock {
	key: string;
	at: number;
	/** The chart's own title, when its config has one. */
	title: string | null;
	/** Chart.js's `type` ("bar", "line", …). */
	chartType: string | null;
	/** Exactly what a chart block stores: the chat's chart code. */
	data: BlockData<"chart">;
}

/** What the listing route answers, grouped by kind, each group newest first and bounded. */
export interface CanvasChatBlocks {
	files: ChatFileBlock[];
	apps: ChatAppBlock[];
	maps: ChatMapBlock[];
	charts: ChatChartBlock[];
}

/** A listing with nothing in it (a board that belongs to no chat, a chat that has made nothing). */
export function emptyChatBlocks(): CanvasChatBlocks {
	return { files: [], apps: [], maps: [], charts: [] };
}
