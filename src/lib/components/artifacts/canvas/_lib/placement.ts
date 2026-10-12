/**
 * Where a block the reader inserts goes (F8, the friction audit), and how the
 * camera meets it. A lazy part: the board asks for it when the reader reaches for
 * Insert, and nothing about it is in the editor's first paint.
 *
 * The rule is the one `shared/artifacts/board-placement.ts` keeps for a block Alfy
 * adds (free ground, a gap clear of what is there, in a frame only when it fits in
 * it), applied to what the reader can see and use: ground wholly inside the pane,
 * clear of what the pane keeps for the board's toolbar, a block's own toolbar and the
 * overview, and clear of what floats over it. A block is never laid over the block
 * put there a moment before (the audit: a chart on the frame made just before it),
 * and when the pane has no such ground the block goes on the nearest there is beyond
 * it and the camera is asked to bring it in, by the least distance (`pan`), so a new
 * block is always where it can be used.
 *
 * Pure: everything is in board units and the DOM is read once, in
 * `placeForInsert`, so the geometry is unit-tested without a browser.
 */
import {
	FRAME_INSET,
	PLACEMENT_GAP,
} from "$lib/shared/artifacts/board-placement";
import type { Pt } from "$lib/shared/artifacts/canvas";
import type { Rect } from "./board";

type Size = { width: number; height: number };
type Camera = { x: number; y: number; zoom: number };

/** The lattice the search for free ground walks: a fine one, so a block can sit a gap from its neighbour. */
const LATTICE = 24;
/** How far apart a second block's corner must be from a block's before it counts as being under it (the stagger of the last resort). */
const OVERLAP = 16;
const STAGGER = 28;
const MAX_TRIES = 60;
/** What stays clear around a floating control: close, not touching. */
const CHROME_GAP = 8;

/** What the pane keeps clear at its edges, in board units. */
export interface Inset {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

export interface InsertRequest {
	/** The block's size on the board (its kind's own, or the room the chat's data takes). */
	size: Size;
	/** A new frame keeps off everything, frames too, and is in no frame; any other block may go in a frame it fits in. */
	asFrame?: boolean;
	/** The blocks on the board: where each is (absolute, as drawn) and whether it is a frame. */
	blocks: readonly { id: string; rect: Rect; frame?: boolean }[];
	/** What the pane shows. */
	pane: Rect;
	/** What the pane keeps clear at its edges: the toolbar along the bottom, room above for the block's own. */
	inset?: Inset;
	/** What floats over the pane: the overview, the zoom control. */
	chrome?: readonly Rect[];
}

export interface PlacedBlock {
	/** Where it goes: absolute, or in its frame's space when `parentId` is given. Whole numbers. */
	position: Pt;
	/** The frame it is put in (innermost), when it goes inside one. */
	parentId?: string;
	/** How far the pane must look further, in board units, for the block to be wholly in view; absent when it already is. */
	pan?: Pt;
}

const NO_INSET: Inset = { top: 0, right: 0, bottom: 0, left: 0 };

function intersects(a: Rect, b: Rect): boolean {
	return (
		a.x < b.x + b.width &&
		b.x < a.x + a.width &&
		a.y < b.y + b.height &&
		b.y < a.y + a.height
	);
}

function inflate(rect: Rect, by: number): Rect {
	return {
		x: rect.x - by,
		y: rect.y - by,
		width: rect.width + 2 * by,
		height: rect.height + 2 * by,
	};
}

function within(rect: Rect, region: Rect): boolean {
	return (
		rect.x >= region.x &&
		rect.y >= region.y &&
		rect.x + rect.width <= region.x + region.width &&
		rect.y + rect.height <= region.y + region.height
	);
}

/** Where a block in a frame may stand: clear of its title band and its edges (the board's own convention: a block at 20, 56). */
function interiorOf(frame: Rect): Rect {
	return {
		x: frame.x + FRAME_INSET.x,
		y: frame.y + FRAME_INSET.top,
		width: frame.width - 2 * FRAME_INSET.x,
		height: frame.height - FRAME_INSET.top - FRAME_INSET.bottom,
	};
}

/**
 * How far the pane must look further so `rect` is wholly in `view`, by the least
 * distance: nothing along an axis where it already is. A block larger than the view
 * starts at the view's own edge, the part it can show.
 */
function panToShow(rect: Rect, view: Rect): Pt | undefined {
	const along = (
		start: number,
		length: number,
		from: number,
		span: number,
	): number => {
		if (length > span || start < from) return start - from;
		return Math.max(0, start + length - (from + span));
	};
	const x = along(rect.x, rect.width, view.x, view.width);
	const y = along(rect.y, rect.height, view.y, view.height);
	return x === 0 && y === 0 ? undefined : { x, y };
}

/**
 * Where a block the reader inserted goes: centred in what the pane leaves clear when
 * that ground is free, else on the nearest free ground wholly inside it; with none
 * there, on the nearest free ground beyond it, and `pan` says how far the camera
 * must move to show it. When there is no free ground within reach at all it goes to
 * the centre, staggered off any block that starts there, like a note put on a
 * crowded board.
 */
export function placeInsertedBlock(input: InsertRequest): PlacedBlock {
	const { size, blocks, pane } = input;
	const inset = input.inset ?? NO_INSET;
	const chrome = (input.chrome ?? []).map((rect) => inflate(rect, CHROME_GAP));
	const view: Rect = {
		x: pane.x + inset.left,
		y: pane.y + inset.top,
		width: Math.max(0, pane.width - inset.left - inset.right),
		height: Math.max(0, pane.height - inset.top - inset.bottom),
	};

	const whole = (at: Pt): Pt => ({ x: Math.round(at.x), y: Math.round(at.y) });
	// A block wider (or taller) than the view starts at the view's edge: its middle would
	// have it hang out of both sides.
	const centre = whole({
		x:
			size.width > view.width
				? view.x
				: view.x + view.width / 2 - size.width / 2,
		y:
			size.height > view.height
				? view.y
				: view.y + view.height / 2 - size.height / 2,
	});

	// Free ground: a gap clear of every block, except a frame the block is wholly inside
	// (its interior, clear of the title and the sides); a new frame is clear of all.
	const frames = input.asFrame ? [] : blocks.filter((block) => block.frame);
	const isFree = (at: Pt): boolean => {
		const rect: Rect = { ...at, ...size };
		for (const block of blocks) {
			if (!intersects(rect, inflate(block.rect, PLACEMENT_GAP))) continue;
			if (
				block.frame &&
				!input.asFrame &&
				within(rect, interiorOf(block.rect))
			) {
				continue;
			}
			return false;
		}
		return true;
	};
	// Clear of what floats over the pane, where the pane will be once the camera has moved
	// (`pan`): the controls stay where they are on the screen, so on the board they move.
	const isClear = (at: Pt, pan?: Pt): boolean => {
		const rect: Rect = { ...at, ...size };
		return !chrome.some((over) =>
			intersects(rect, {
				...over,
				x: over.x + (pan?.x ?? 0),
				y: over.y + (pan?.y ?? 0),
			}),
		);
	};

	const parentOf = (rect: Rect): { id: string; origin: Pt } | undefined => {
		let best: { id: string; origin: Pt; area: number } | undefined;
		for (const frame of frames) {
			if (!within(rect, interiorOf(frame.rect))) continue;
			const area = frame.rect.width * frame.rect.height;
			if (!best || area < best.area) {
				best = {
					id: frame.id,
					origin: { x: frame.rect.x, y: frame.rect.y },
					area,
				};
			}
		}
		return best;
	};
	const placed = (at: Pt, pan?: Pt): PlacedBlock => {
		const parent = parentOf({ ...at, ...size });
		return {
			position: parent
				? { x: at.x - parent.origin.x, y: at.y - parent.origin.y }
				: at,
			...(parent ? { parentId: parent.id } : {}),
			...(pan ? { pan } : {}),
		};
	};

	// Every free place around what the pane shows (the lattice, and the middle itself): one
	// wholly in view and clear of what floats goes first, the nearest to the middle; when
	// there is none, the one the camera has the least way to go to show, then the nearest.
	let best: { at: Pt; away: number; distance: number; pan?: Pt } | null = null;
	const consider = (at: Pt): void => {
		if (!isFree(at)) return;
		const pan = panToShow({ ...at, ...size }, view);
		if (!isClear(at, pan)) return;
		const away = pan ? Math.hypot(pan.x, pan.y) : 0;
		const distance = Math.hypot(at.x - centre.x, at.y - centre.y);
		if (
			!best ||
			away < best.away ||
			(away === best.away && distance < best.distance)
		) {
			best = { at, away, distance, pan };
		}
	};
	consider(centre);
	const roomX = Math.ceil((size.width + PLACEMENT_GAP) / LATTICE) * LATTICE;
	const roomY = Math.ceil((size.height + PLACEMENT_GAP) / LATTICE) * LATTICE;
	for (
		let x = view.x - roomX;
		x <= view.x + view.width + PLACEMENT_GAP;
		x += LATTICE
	) {
		for (
			let y = view.y - roomY;
			y <= view.y + view.height + PLACEMENT_GAP;
			y += LATTICE
		) {
			consider(whole({ x, y }));
		}
	}
	if (best) return placed(best.at, best.pan);

	// 3. A board full all the way: the middle, staggered off a block that starts there.
	const at = { ...centre };
	for (let tries = 0; tries < MAX_TRIES; tries += 1) {
		const covered = blocks.some(
			(block) =>
				Math.abs(block.rect.x - at.x) < OVERLAP &&
				Math.abs(block.rect.y - at.y) < OVERLAP,
		);
		if (!covered) break;
		at.x += STAGGER;
		at.y += STAGGER;
	}
	return placed(at);
}

/**
 * The camera that brings a plan's block into view: where the pane must look further
 * (`pan`, board units) moves the board the other way on the screen. Null when the
 * block is already in view.
 */
export function insertPanePlan(
	camera: Camera,
	pan: Pt | undefined,
): Camera | null {
	if (!pan) return null;
	return {
		x: camera.x - pan.x * camera.zoom,
		y: camera.y - pan.y * camera.zoom,
		zoom: camera.zoom,
	};
}

// ---- Reading the board's layers ---------------------------------------------

/** Room kept above a block for its own toolbar, and at the sides, in screen pixels. */
const KEEP_ABOVE_PX = 64;
const KEEP_SIDE_PX = 24;
/** Room kept below the board's own toolbar for the selection's pill, which hangs under the block. */
const KEEP_BELOW_TOOLBAR_PX = 48;
/** The least kept at the bottom when there is no toolbar to read (a preview). */
const KEEP_BOTTOM_PX = 64;

/**
 * Plans an insert on the board that `el` is: the pane and what floats over it are read
 * from the page (the toolbar along the bottom, the overview and the zoom control in the
 * corner), in the screen's pixels, and put into board units at the camera's zoom.
 */
export function placeForInsert(input: {
	el: HTMLElement;
	camera: Camera;
	size: Size;
	asFrame?: boolean;
	blocks: InsertRequest["blocks"];
}): PlacedBlock & { camera: Camera | null } {
	const { el, camera } = input;
	const zoom = camera.zoom > 0 ? camera.zoom : 1;
	const box = el.getBoundingClientRect();
	const toBoard = (rect: DOMRect): Rect => ({
		x: (rect.left - box.left - camera.x) / zoom,
		y: (rect.top - box.top - camera.y) / zoom,
		width: rect.width / zoom,
		height: rect.height / zoom,
	});
	const toolbar = el
		.querySelector<HTMLElement>('[data-testid="canvas-toolbar"]')
		?.getBoundingClientRect();
	const bottom = toolbar
		? Math.max(KEEP_BOTTOM_PX, box.bottom - toolbar.top + KEEP_BELOW_TOOLBAR_PX)
		: KEEP_BOTTOM_PX;
	const placed = placeInsertedBlock({
		size: input.size,
		asFrame: input.asFrame,
		blocks: input.blocks,
		pane: {
			x: -camera.x / zoom,
			y: -camera.y / zoom,
			width: box.width / zoom,
			height: box.height / zoom,
		},
		inset: {
			top: KEEP_ABOVE_PX / zoom,
			right: KEEP_SIDE_PX / zoom,
			bottom: bottom / zoom,
			left: KEEP_SIDE_PX / zoom,
		},
		chrome: Array.from(
			el.querySelectorAll<HTMLElement>(".svelte-flow__panel"),
		).map((panel) => toBoard(panel.getBoundingClientRect())),
	});
	return { ...placed, camera: insertPanePlan(camera, placed.pan) };
}

/**
 * Gives the block that was just put on the board the keyboard's focus, as a note or a
 * text block takes it to be typed in: every kind does, the same way. Waits for the
 * block to be drawn; leaves the focus where it is when the block has already taken it
 * (a note opens for typing by itself), and goes to the first field a block has (a
 * checklist's new item) before the block's own box.
 */
export function focusInserted(el: HTMLElement, id: string): Promise<void> {
	return new Promise((resolve) => {
		let frames = 0;
		const look = (): void => {
			const block = el.querySelector<HTMLElement>(
				`.svelte-flow__node[data-id="${CSS.escape(id)}"]`,
			);
			// A block is revealed by the library only once it has measured it.
			if (!block || getComputedStyle(block).visibility === "hidden") {
				frames += 1;
				if (frames < 30) requestAnimationFrame(look);
				else resolve();
				return;
			}
			if (!block.contains(document.activeElement)) {
				const field = block.querySelector<HTMLElement>(
					"input:not([type=checkbox]), textarea, [contenteditable=true]",
				);
				(field ?? block).focus({ preventScroll: true });
			}
			resolve();
		};
		requestAnimationFrame(look);
	});
}
