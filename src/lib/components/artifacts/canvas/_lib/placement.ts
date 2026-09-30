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
/** How many blocks' widths (and heights) out from the centre the search for free ground goes. */
const RINGS = 5;

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
 * The search goes out from the centre in rings of whole blocks (a block and a gap
 * away), takes ground the reader can see before ground they cannot, the nearer
 * before the further, and — when nothing near is free — stagger like a note does.
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
	const isFree = (at: Pt) =>
		!occupied.some((other) => intersects({ ...at, ...size }, other));
	if (isFree({ x, y })) return { x, y };

	const stepX = size.width + GAP;
	const stepY = size.height + GAP;
	const candidates: {
		at: Pt;
		ring: number;
		seen: boolean;
		distance: number;
	}[] = [];
	for (let ring = 1; ring <= RINGS; ring += 1) {
		for (let dx = -ring; dx <= ring; dx += 1) {
			for (let dy = -ring; dy <= ring; dy += 1) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
				const at = { x: x + dx * stepX, y: y + dy * stepY };
				const middle = { x: at.x + size.width / 2, y: at.y + size.height / 2 };
				candidates.push({
					at,
					ring,
					seen:
						!visible ||
						(middle.x >= visible.x &&
							middle.x <= visible.x + visible.width &&
							middle.y >= visible.y &&
							middle.y <= visible.y + visible.height),
					distance: Math.hypot(dx * stepX, dy * stepY),
				});
			}
		}
	}
	candidates.sort(
		(a, b) =>
			Number(b.seen) - Number(a.seen) ||
			a.ring - b.ring ||
			a.distance - b.distance,
	);
	for (const candidate of candidates) {
		if (isFree(candidate.at)) return candidate.at;
	}
	return placeInsertedBlock({
		center: input.center,
		size,
		taken: occupied.map((other) => ({ x: other.x, y: other.y })),
	});
}
