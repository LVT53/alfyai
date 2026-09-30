import type { Pt } from "$lib/shared/artifacts/canvas";
import type { Rect } from "./board";

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

/** The breathing room left between a block and the ones beside it. */
const GAP = 24;
/** The lattice the search for free ground walks: fine enough that a block can sit a gap from its neighbour, coarse enough to stay cheap. */
const LATTICE = 24;
/** How far from the centre, in block sizes, the search reaches. */
const REACH = 2.5;

function intersects(a: Rect, b: Rect): boolean {
	return (
		a.x < b.x + b.width &&
		b.x < a.x + a.width &&
		a.y < b.y + b.height &&
		b.y < a.y + a.height
	);
}

/**
 * Where a block made from the chat goes: centred in what the reader is looking at
 * if that ground is free, else on the nearest free ground. These blocks are big
 * (an App is 400 x 340, a map 360 x 280), so the note's stagger would lay one over
 * the other, and an App laid over an App takes the clicks of the one beneath it.
 *
 * Free ground is ground a gap clear of every block already there. The search
 * walks a fine lattice around the centre and takes what is wholly in view before
 * what is half in view before what is out of view, the nearer before the further;
 * when nothing within reach is free it staggers like a note does.
 *
 * `occupied` are the rectangles (board units, absolute) of the blocks already on
 * the board; `visible` is what the pane is showing. Whole numbers, as everywhere
 * a position is stored.
 */
export function placeBesideBlocks(input: {
	center: Pt;
	size: { width: number; height: number };
	occupied: readonly Rect[];
	visible?: Rect;
}): Pt {
	const { size, occupied, visible } = input;
	const x = Math.round(input.center.x - size.width / 2);
	const y = Math.round(input.center.y - size.height / 2);
	const blocked = occupied.map((other) => ({
		x: other.x - GAP,
		y: other.y - GAP,
		width: other.width + 2 * GAP,
		height: other.height + 2 * GAP,
	}));
	const isFree = (at: Pt) =>
		!blocked.some((other) => intersects({ ...at, ...size }, other));
	if (isFree({ x, y })) return { x, y };

	// 2: wholly in view, 1: its middle is, 0: out of view.
	const visibility = (at: Pt): number => {
		if (!visible) return 2;
		if (
			at.x >= visible.x &&
			at.y >= visible.y &&
			at.x + size.width <= visible.x + visible.width &&
			at.y + size.height <= visible.y + visible.height
		) {
			return 2;
		}
		const middleX = at.x + size.width / 2;
		const middleY = at.y + size.height / 2;
		return middleX >= visible.x &&
			middleX <= visible.x + visible.width &&
			middleY >= visible.y &&
			middleY <= visible.y + visible.height
			? 1
			: 0;
	};

	const reachX = Math.ceil((size.width * REACH) / LATTICE) * LATTICE;
	const reachY = Math.ceil((size.height * REACH) / LATTICE) * LATTICE;
	let best: { at: Pt; visibility: number; distance: number } | null = null;
	for (let dx = -reachX; dx <= reachX; dx += LATTICE) {
		for (let dy = -reachY; dy <= reachY; dy += LATTICE) {
			const at = { x: x + dx, y: y + dy };
			if (!isFree(at)) continue;
			const candidate = {
				at,
				visibility: visibility(at),
				distance: Math.hypot(dx, dy),
			};
			if (
				!best ||
				candidate.visibility > best.visibility ||
				(candidate.visibility === best.visibility &&
					candidate.distance < best.distance)
			) {
				best = candidate;
			}
		}
	}
	if (best) return best.at;
	return placeInsertedBlock({
		center: input.center,
		size,
		taken: occupied.map((other) => ({ x: other.x, y: other.y })),
	});
}
