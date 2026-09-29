import type { Pt } from "$lib/shared/artifacts/canvas";

/** How close another block's corner may be to a new block's before it counts as being under it. */
const OVERLAP = 16;
/** Where the next try goes: down and to the right, a stagger the eye reads as a stack. */
const STEP = 28;
const MAX_TRIES = 60;

/**
 * Where a block the reader just inserted goes: centred in what they are looking
 * at, staggered off any block already sitting exactly there, so a second Insert
 * never lands invisibly on the first. Whole numbers, so a position never
 * carries pointer noise into the saved board.
 *
 * `taken` are the top-left corners (board units) of the blocks already on the
 * board.
 */
export function placeInsertedBlock(input: {
	center: Pt;
	size: { width: number; height: number };
	taken: readonly Pt[];
}): Pt {
	let x = Math.round(input.center.x - input.size.width / 2);
	let y = Math.round(input.center.y - input.size.height / 2);
	for (let tries = 0; tries < MAX_TRIES; tries += 1) {
		const covered = input.taken.some(
			(corner) =>
				Math.abs(corner.x - x) < OVERLAP && Math.abs(corner.y - y) < OVERLAP,
		);
		if (!covered) break;
		x += STEP;
		y += STEP;
	}
	return { x, y };
}
