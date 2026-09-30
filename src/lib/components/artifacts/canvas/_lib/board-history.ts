/**
 * The board's own undo and redo (ruling 16): a bounded stack of what the board
 * looked like before each of the reader's recent steps. It is transient by
 * design — closing the panel forgets it — and it is NOT how Alfy's changes or an
 * earlier session's are undone: that is a version restore, through History.
 *
 * A snapshot is the board's canonical JSON without its camera (`structuralJson`),
 * so two states that differ only in where the reader was looking are the same
 * step, and undoing never moves the camera.
 */

/** One snapshot per step, this many steps back: bounded memory. */
export const HISTORY_LIMIT = 50;

export interface BoardHistory {
	/** Records the state a step just left. A repeat of the latest entry is not a step, and a new step forgets what was undone. */
	push(before: string): void;
	/** The state before the latest step, given the current one (which becomes redoable); `null` when there is nothing to undo. */
	undo(current: string): string | null;
	/** The state after the latest undone step, given the current one (which becomes undoable again); `null` when there is nothing to redo. */
	redo(current: string): string | null;
	readonly undoDepth: number;
	readonly redoDepth: number;
}

export function createBoardHistory(limit = HISTORY_LIMIT): BoardHistory {
	const past: string[] = [];
	const future: string[] = [];

	function remember(stack: string[], snapshot: string): void {
		if (stack[stack.length - 1] === snapshot) return;
		stack.push(snapshot);
		if (stack.length > limit) stack.shift();
	}

	return {
		push(before) {
			remember(past, before);
			future.length = 0;
		},
		undo(current) {
			const previous = past.pop();
			if (previous === undefined) return null;
			remember(future, current);
			return previous;
		},
		redo(current) {
			const next = future.pop();
			if (next === undefined) return null;
			remember(past, current);
			return next;
		},
		get undoDepth() {
			return past.length;
		},
		get redoDepth() {
			return future.length;
		},
	};
}
