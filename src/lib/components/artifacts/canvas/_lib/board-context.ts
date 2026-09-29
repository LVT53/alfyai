/**
 * What the board tells the nodes drawn on it, through Svelte context rather
 * than through props: Svelte Flow instantiates a node component itself and
 * hands it only the node's own fields, so anything the BOARD knows (is it
 * editable right now, which block was just inserted) has to reach a node some
 * other way. Nodes never call the board back; a change to a node's data goes
 * through Svelte Flow's `updateNodeData` and the board notices the new state.
 */
import { getContext, setContext } from "svelte";

export interface CanvasBoardContext {
	/** True while the board must not change: the item is gone, or a conflict is waiting on the reader's choice. */
	readonly readonly: boolean;
	/** Asks the node with this id to open its text for editing as soon as it mounts (a block was just inserted). */
	requestEdit(id: string): void;
	/** True exactly once, for the node the last insert asked to edit; the request is spent by the answer. */
	takeEditRequest(id: string): boolean;
	/** The frame the block being dragged would join if it were dropped now (it wears a highlight), or null. */
	readonly dropTargetId: string | null;
}

const BOARD_CONTEXT = Symbol("artifact-canvas-board");

/** What a node sees outside a board (a component test): editable, and nothing asks it to edit. */
const STANDALONE: CanvasBoardContext = {
	readonly: false,
	requestEdit() {},
	takeEditRequest() {
		return false;
	},
	dropTargetId: null,
};

export function provideBoardContext(context: CanvasBoardContext): void {
	setContext(BOARD_CONTEXT, context);
}

export function useBoardContext(): CanvasBoardContext {
	return (
		getContext<CanvasBoardContext | undefined>(BOARD_CONTEXT) ?? STANDALONE
	);
}
