/**
 * What the panel tells the blocks made from the chat, through Svelte context
 * (the editor provides it above the board; a node, or the Insert menu inside the
 * toolbar's popover, reads it): which conversation the panel is showing, how to
 * open a file in the panel's own viewer, and how to read what the chat has made.
 *
 * Apart from `board-context.ts` on purpose: that one is what the BOARD knows
 * (is it editable, which frame is lit) and is provided by the board; this is what
 * the PANEL knows, provided by the editor that the panel mounts. A host that
 * offers none of it (a component test, a board opened where there is no chat) gets
 * the standalone answer below: no conversation, nothing to open with, nothing to
 * read.
 */
import { getContext, setContext } from "svelte";
import type { SearchCanvasWebResult } from "$lib/client/api/artifacts";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import type { CanvasChatBlocks } from "$lib/shared/artifacts/chat-blocks";
import type { CanvasWebFailure } from "$lib/shared/artifacts/live-web";

/** What a refresh answers the block that asked: the new snapshot is on the board (the board saves it), or why it could not be made. */
export type BlockRefreshResult =
	| { ok: true }
	| { ok: false; reason: CanvasWebFailure };

export interface CanvasChatContext {
	/** The conversation the panel is showing (ruling 51): passed to every artifact route a block calls, so an incognito chat's own App resolves. Null outside a conversation. */
	readonly conversationId: string | null;
	/** Opens an item in the panel's shared viewer (a File block's file). Absent where the host cannot: the block is then a plain row. */
	readonly openItem?: ((item: DocumentWorkspaceItem) => void) | undefined;
	/** Reads what the board's own chat has that the board can hold. Absent where there is no chat to read: the Insert menu then has no "From this chat". */
	readonly load?: (() => Promise<CanvasChatBlocks>) | undefined;
	/**
	 * Re-runs a live-web block's search and puts the new snapshot on the board, where
	 * the board's own save keeps it as the reader's version. The block passes only its
	 * own id: the query that runs is the one stored on the saved board. Absent where
	 * there is no chat to search for: the block then has no Refresh.
	 */
	readonly refreshBlock?:
		| ((nodeId: string, signal?: AbortSignal) => Promise<BlockRefreshResult>)
		| undefined;
	/** Searches the web for a query typed into the Insert menu and answers the snapshot a live-web block starts from. Absent with no chat: the menu then has no "Search the web". */
	readonly searchWeb?:
		| ((query: string, signal?: AbortSignal) => Promise<SearchCanvasWebResult>)
		| undefined;
}

const CHAT_CONTEXT = Symbol("artifact-canvas-chat");

const STANDALONE: CanvasChatContext = { conversationId: null };

export function provideChatContext(context: CanvasChatContext): void {
	setContext(CHAT_CONTEXT, context);
}

export function useChatContext(): CanvasChatContext {
	return getContext<CanvasChatContext | undefined>(CHAT_CONTEXT) ?? STANDALONE;
}
