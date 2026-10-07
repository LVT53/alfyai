/**
 * Where a block Alfy adds goes (decisions.md ruling 74, the owner's ask: "where
 * AlfyAI places new blocks when asked to"). A model is poor at the geometry of a
 * board it cannot see: it covers a note, or sticks a chart out of a frame, or
 * puts "next to" a note on the far side of the board. So a block it adds is put
 * where a person would put it, by this module, and the model's own place is
 * kept only when it is a good one:
 *
 *  - a place the model gives is kept when it is free, and moved to the nearest
 *    free ground when it is not (never onto another block, and a block in a frame
 *    stays inside it);
 *  - a place it leaves out is found: beside the block it names (`near`: to its
 *    right, else under it, else the nearest free ground), or in the next free
 *    slot of the frame it names (left to right, then the next row), or on free
 *    ground nearest to what the reader is looking at;
 *  - a frame that has no room grows, down or to the right, when the ground it
 *    grows into is free, as a person drags a corner; when it is not, the block
 *    goes beside the frame and the answer says so;
 *  - a block whose middle lies inside a frame it was not made a child of is made
 *    one, as the board does when a reader drops a block there.
 *
 * Pure and deterministic: the same board and request give the same place, so the
 * judge (`board-ops.ts`) can resolve an op once and the board is applied to as
 * the judge saw it. Everything is in the space of the block's own container (the
 * board's, or its frame's), whole numbers.
 */
import type { CanvasBody, CanvasNode, Pt } from "./canvas";
import { estimatedNodeSize } from "./canvas-blocks";

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** The room left between a block and the ones around it when the app chooses where it goes. */
export const PLACEMENT_GAP = 24;
/** Inside a frame: the margin at its sides and bottom, and the title's band at the top (the board's own convention: a block at 20, 56). */
export const FRAME_INSET = { x: 20, top: 56, bottom: 20 } as const;
/** What the reader is taken to see of the board when only the camera it was saved with is known. */
const ASSUMED_PANE = { width: 900, height: 600 } as const;
/** Where the first block of an empty board goes. */
const EMPTY_BOARD_ORIGIN: Pt = { x: 40, y: 40 };

export type PlacedHow =
	/** The place the model gave was free, and is kept. */
	| "kept"
	/** The place it gave was taken (or outside its frame), and the block is on the nearest free ground. */
	| "moved"
	/** The model gave none, and the block is where it was found. */
	| "placed"
	/** There was no room in the frame: it grew to hold the block. */
	| "grew"
	/** There was no room and the frame could not grow: the block is beside the frame, not in it. */
	| "outside";

export interface PlacementRequest {
	/** The block's own id: it is never in its own way. */
	id: string;
	/** A frame is placed on its own level and never made a child of another by where its middle is. */
	asFrame?: boolean;
	/** The size the board will draw it at (`estimatedNodeSize`). */
	size: { width: number; height: number };
	/** The model's own place, in its container's space. */
	position?: Pt;
	/** The frame it is to be in. */
	parentId?: string;
	/** The block it is to be next to. */
	near?: string;
}

export interface Placed {
	position: Pt;
	/** The frame it ends up in: the one asked for, the one `near` or its own middle puts it in, or none. */
	parentId?: string;
	how: PlacedHow;
}

const whole = (value: number): number => Math.round(value);

function intersects(a: Box, b: Box, margin: number): boolean {
	return (
		a.x < b.x + b.width + margin &&
		a.x + a.width > b.x - margin &&
		a.y < b.y + b.height + margin &&
		a.y + a.height > b.y - margin
	);
}

/** Two boxes share space: more than a pixel of both axes, as the eval's rubric counts it. */
function overlaps(a: Box, b: Box): boolean {
	const across = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
	const down = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	return across > 1 && down > 1;
}

function boxOf(node: CanvasNode): Box {
	return { x: node.position.x, y: node.position.y, ...estimatedNodeSize(node) };
}

function findNode(body: CanvasBody, id: string): CanvasNode | undefined {
	return body.nodes.find((node) => node.id === id);
}

/** A node's place on the board: its own, and each frame's it sits in. Loops (a board nobody normalised) end the walk. */
function absoluteOrigin(body: CanvasBody, node: CanvasNode): Pt {
	let { x, y } = node.position;
	const seen = new Set([node.id]);
	let cursor = node.parentId ? findNode(body, node.parentId) : undefined;
	while (cursor && !seen.has(cursor.id)) {
		x += cursor.position.x;
		y += cursor.position.y;
		seen.add(cursor.id);
		cursor = cursor.parentId ? findNode(body, cursor.parentId) : undefined;
	}
	return { x, y };
}

interface Container {
	/** The frame, or null for the board itself. */
	frame: CanvasNode | null;
	/** What is already in it, in its own space. */
	siblings: Box[];
	/** Its extent, when it has one (a frame's own size, in its own space). */
	bounds: Box | null;
}

function containerOf(
	body: CanvasBody,
	parentId: string | undefined,
	exceptId: string,
): Container {
	const frame =
		parentId === undefined ? null : (findNode(body, parentId) ?? null);
	return {
		frame,
		siblings: body.nodes
			.filter((node) => node.parentId === frame?.id && node.id !== exceptId)
			.map(boxOf),
		bounds: frame ? { x: 0, y: 0, ...estimatedNodeSize(frame) } : null,
	};
}

/** Inside the frame, as the rubric reads "inside": a pixel of slack, no inset. */
function withinFrame(box: Box, bounds: Box): boolean {
	return (
		box.x >= -1 &&
		box.y >= -1 &&
		box.x + box.width <= bounds.width + 1 &&
		box.y + box.height <= bounds.height + 1
	);
}

/** Inside the frame and clear of its edges and its title: where the app puts a block of its own choosing. */
function withinFrameInset(box: Box, bounds: Box): boolean {
	return (
		box.x >= FRAME_INSET.x &&
		box.y >= FRAME_INSET.top &&
		box.x + box.width <= bounds.width - FRAME_INSET.x &&
		box.y + box.height <= bounds.height - FRAME_INSET.bottom
	);
}

/** The places worth trying: against each neighbour's four sides (aligned with it), and the frame's own corner. */
function candidatesAround(
	container: Container,
	size: { width: number; height: number },
): Pt[] {
	const points: Pt[] = [];
	if (container.bounds) {
		points.push({ x: FRAME_INSET.x, y: FRAME_INSET.top });
	}
	for (const other of container.siblings) {
		const right = other.x + other.width + PLACEMENT_GAP;
		const below = other.y + other.height + PLACEMENT_GAP;
		points.push(
			{ x: right, y: other.y },
			{ x: other.x, y: below },
			{ x: other.x - size.width - PLACEMENT_GAP, y: other.y },
			{ x: other.x, y: other.y - size.height - PLACEMENT_GAP },
			{ x: right, y: below },
		);
		if (container.bounds) points.push({ x: FRAME_INSET.x, y: below });
	}
	return points.map((point) => ({ x: whole(point.x), y: whole(point.y) }));
}

function isFreeForApp(
	at: Pt,
	size: { width: number; height: number },
	container: Container,
): boolean {
	const box = { ...at, ...size };
	if (container.bounds && !withinFrameInset(box, container.bounds))
		return false;
	return !container.siblings.some((other) =>
		intersects(box, other, PLACEMENT_GAP),
	);
}

function isFreeForModel(
	at: Pt,
	size: { width: number; height: number },
	container: Container,
): boolean {
	const box = { ...at, ...size };
	if (container.bounds && !withinFrame(box, container.bounds)) return false;
	return !container.siblings.some((other) => overlaps(box, other));
}

const distanceBetween = (a: Pt, b: Pt): number =>
	Math.hypot(a.x - b.x, a.y - b.y);

/** The free place nearest to `from` (ties: higher, then more to the left), or null. */
function nearestFree(
	from: Pt,
	size: { width: number; height: number },
	container: Container,
	isFree: (at: Pt) => boolean,
): Pt | null {
	let best: Pt | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const point of [from, ...candidatesAround(container, size)]) {
		if (!isFree(point)) continue;
		const distance = distanceBetween(point, from);
		if (
			distance < bestDistance - 0.5 ||
			(Math.abs(distance - bestDistance) <= 0.5 &&
				best &&
				(point.y < best.y || (point.y === best.y && point.x < best.x)))
		) {
			best = point;
			bestDistance = distance;
		}
	}
	return best;
}

/** The first free slot in reading order: the topmost, and the leftmost of those. */
function firstFree(
	size: { width: number; height: number },
	container: Container,
): Pt | null {
	let best: Pt | null = null;
	for (const point of candidatesAround(container, size)) {
		if (!isFreeForApp(point, size, container)) continue;
		if (!best || point.y < best.y || (point.y === best.y && point.x < best.x)) {
			best = point;
		}
	}
	return best;
}

/** Beside a block: to its right, else under it, else to its left, else above; the first of those that is free. */
function besideFree(
	anchor: Box,
	size: { width: number; height: number },
	container: Container,
): Pt | null {
	const sides: Pt[] = [
		{ x: anchor.x + anchor.width + PLACEMENT_GAP, y: anchor.y },
		{ x: anchor.x, y: anchor.y + anchor.height + PLACEMENT_GAP },
		{ x: anchor.x - size.width - PLACEMENT_GAP, y: anchor.y },
		{ x: anchor.x, y: anchor.y - size.height - PLACEMENT_GAP },
	];
	for (const side of sides) {
		const at = { x: whole(side.x), y: whole(side.y) };
		if (isFreeForApp(at, size, container)) return at;
	}
	return nearestFree({ x: anchor.x, y: anchor.y }, size, container, (at) =>
		isFreeForApp(at, size, container),
	);
}

/** Free ground below, and then to the right, of everything in the container: always there, never in the way. */
function pastTheContent(container: Container): Pt {
	if (container.siblings.length === 0) {
		return container.bounds
			? { x: FRAME_INSET.x, y: FRAME_INSET.top }
			: EMPTY_BOARD_ORIGIN;
	}
	const left = Math.min(...container.siblings.map((other) => other.x));
	const bottom = Math.max(
		...container.siblings.map((other) => other.y + other.height),
	);
	return {
		x: container.bounds ? FRAME_INSET.x : whole(left),
		y: whole(bottom + PLACEMENT_GAP),
	};
}

function boundsOfAll(boxes: readonly Box[]): Box | null {
	if (boxes.length === 0) return null;
	const left = Math.min(...boxes.map((box) => box.x));
	const top = Math.min(...boxes.map((box) => box.y));
	const right = Math.max(...boxes.map((box) => box.x + box.width));
	const bottom = Math.max(...boxes.map((box) => box.y + box.height));
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/** What the reader is most likely looking at: the camera the board was saved with, else the middle of what is on it. */
function focusOf(body: CanvasBody, topLevel: readonly Box[]): Pt | null {
	const { x, y, zoom } = body.viewport;
	const saved = x !== 0 || y !== 0 || zoom !== 1;
	if (saved && zoom > 0) {
		return {
			x: -x / zoom + ASSUMED_PANE.width / zoom / 2,
			y: -y / zoom + ASSUMED_PANE.height / zoom / 2,
		};
	}
	const all = boundsOfAll(topLevel);
	return all ? { x: all.x + all.width / 2, y: all.y + all.height / 2 } : null;
}

/** The innermost frame whose rectangle holds the block's middle, other than the block's own. */
function frameHoldingMiddle(
	body: CanvasBody,
	id: string,
	at: Pt,
	size: { width: number; height: number },
): CanvasNode | null {
	const middle = { x: at.x + size.width / 2, y: at.y + size.height / 2 };
	let best: { frame: CanvasNode; area: number } | null = null;
	for (const node of body.nodes) {
		if (node.type !== "frame" || node.id === id) continue;
		const origin = absoluteOrigin(body, node);
		const frameSize = estimatedNodeSize(node);
		if (
			middle.x >= origin.x &&
			middle.x <= origin.x + frameSize.width &&
			middle.y >= origin.y &&
			middle.y <= origin.y + frameSize.height
		) {
			const area = frameSize.width * frameSize.height;
			if (!best || area < best.area) best = { frame: node, area };
		}
	}
	return best?.frame ?? null;
}

/** How near a growing frame may come to what stands beside it: a frame that touches its neighbour looks like one. */
const GROW_CLEARANCE = 12;

/**
 * Whether a frame could be made `width` by `height`, its top-left corner staying
 * where it is: the ground it would take (a strip down its side, a strip along its
 * bottom) is free of what sits beside it, a clearance away, and it stays inside
 * the frame it is in, if it is in one.
 */
function canBecome(
	body: CanvasBody,
	frame: CanvasNode,
	width: number,
	height: number,
): boolean {
	const was = estimatedNodeSize(frame);
	const beside = containerOf(body, frame.parentId, frame.id);
	const claimed: Box[] = [];
	if (width > was.width) {
		claimed.push({
			x: frame.position.x + was.width,
			y: frame.position.y,
			width: width - was.width,
			height: Math.max(height, was.height),
		});
	}
	if (height > was.height) {
		claimed.push({
			x: frame.position.x,
			y: frame.position.y + was.height,
			width: Math.max(width, was.width),
			height: height - was.height,
		});
	}
	if (
		beside.siblings.some((other) =>
			claimed.some((strip) => intersects(strip, other, GROW_CLEARANCE)),
		)
	) {
		return false;
	}
	const grown: Box = { ...frame.position, width, height };
	return !beside.bounds || withinFrame(grown, beside.bounds);
}

/**
 * The place for a block that asked for a frame that has no room: where it would
 * go if the frame were as big as it needed, and the size that takes. Null when
 * the frame cannot grow into free ground.
 */
function roomByGrowing(
	body: CanvasBody,
	frame: CanvasNode,
	size: { width: number; height: number },
	container: Container,
): Pt | null {
	const bounds = container.bounds;
	if (!bounds) return null;
	const wideEnough = Math.max(bounds.width, size.width + 2 * FRAME_INSET.x);
	const slot = pastTheContent(container);
	const at = { x: whole(slot.x), y: whole(slot.y) };
	const needed = {
		width: Math.max(wideEnough, at.x + size.width + FRAME_INSET.x),
		height: Math.max(bounds.height, at.y + size.height + FRAME_INSET.bottom),
	};
	return canBecome(body, frame, needed.width, needed.height) ? at : null;
}

/**
 * Where a block goes. See the module's header for the rules; the answer says
 * how the place was reached, for the note the model is given.
 */
export function placeBlock(
	body: CanvasBody,
	request: PlacementRequest,
): Placed {
	const { id, size } = request;
	let parentId = request.parentId;
	let given = request.position;
	const anchorNode = request.near ? findNode(body, request.near) : undefined;

	// A block put beside another is put in the other's frame, unless it was told its own.
	if (parentId === undefined && anchorNode && !given) {
		parentId = anchorNode.parentId;
	}
	// A block whose middle is over a frame it was not made a child of is a child of it.
	if (parentId === undefined && given && !request.asFrame) {
		const holder = frameHoldingMiddle(body, id, given, size);
		if (holder) {
			const origin = absoluteOrigin(body, holder);
			parentId = holder.id;
			given = { x: given.x - origin.x, y: given.y - origin.y };
		}
	}

	const container = containerOf(body, parentId, id);
	const free = (at: Pt) => isFreeForApp(at, size, container);

	if (given) {
		const at = { x: whole(given.x), y: whole(given.y) };
		if (isFreeForModel(at, size, container)) {
			return { position: at, ...(parentId ? { parentId } : {}), how: "kept" };
		}
		const nearest = nearestFree(at, size, container, free);
		if (nearest) {
			return {
				position: nearest,
				...(parentId ? { parentId } : {}),
				how: "moved",
			};
		}
	} else {
		let found: Pt | null = null;
		const anchor =
			anchorNode &&
			anchorNode.parentId === parentId &&
			anchorNode.id !== parentId
				? boxOf(anchorNode)
				: null;
		if (anchor) {
			found = besideFree(anchor, size, container);
		} else if (container.frame) {
			found = firstFree(size, container);
		} else {
			const top = container.siblings;
			const focus = focusOf(body, top);
			if (!focus) {
				found = EMPTY_BOARD_ORIGIN;
			} else {
				const middle = {
					x: whole(focus.x - size.width / 2),
					y: whole(focus.y - size.height / 2),
				};
				found = nearestFree(middle, size, container, free);
			}
		}
		if (found) {
			return {
				position: found,
				...(parentId ? { parentId } : {}),
				how: "placed",
			};
		}
	}

	// Nothing free inside the frame: make room by growing it, or leave it.
	if (container.frame) {
		const room = roomByGrowing(body, container.frame, size, container);
		if (room && parentId) {
			return { position: room, parentId, how: "grew" };
		}
		return placeBesideFrame(body, container.frame, id, size);
	}
	// A board has no edge: below everything is always free.
	const past = pastTheContent(container);
	return { position: { x: whole(past.x), y: whole(past.y) }, how: "placed" };
}

/** A block that cannot go in its frame goes next to it, on the frame's own level. */
function placeBesideFrame(
	body: CanvasBody,
	frame: CanvasNode,
	id: string,
	size: { width: number; height: number },
): Placed {
	const level = containerOf(body, frame.parentId, id);
	const found = besideFree(boxOf(frame), size, level);
	const position = found ?? pastTheContent(level);
	return {
		position: { x: whole(position.x), y: whole(position.y) },
		...(frame.parentId ? { parentId: frame.parentId } : {}),
		how: "outside",
	};
}
