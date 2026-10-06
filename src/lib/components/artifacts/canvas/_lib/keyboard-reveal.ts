/**
 * The block a finger types in stays in view when the keyboard comes up (TR-D4).
 *
 * On Android the keyboard shortens the page (`interactive-widget=resizes-content`,
 * app.html); on iOS it covers the bottom of it and shrinks only the visual viewport.
 * Either way a block lower than the keyboard's top edge is hidden while the reader
 * types in it, and the browser cannot scroll it into view: the flow library undoes
 * its wrapper's scroll. So the camera does what the browser would have done: it pans,
 * by the least distance, never zoomed, ONCE per opening of the keyboard, after which
 * the camera is the reader's again. Nothing happens when the block is in view, when
 * the keyboard goes, when a field takes the focus with the pane and the viewport as
 * they were, or on a device that has no use for it (the board loads this only where
 * the pointer is coarse, with `group-parts.ts`).
 *
 * Loaded on demand and imports nothing the editor shares (a lazy part that did would
 * split that module out of the editor's chunk) and no flow library: it is handed the
 * camera's two members and the editor's own test for "a field the reader types in".
 */
import { prefersReducedMotion } from "$lib/utils/motion";
import type { ScreenRect } from "./floating";

/** How far the camera moves, in the screen's own pixels (the camera's own unit). */
type Pan = { x: number; y: number };

/** The camera, as the flow library keeps it. */
type RevealCamera = { x: number; y: number; zoom: number };

/** The two members of the flow library's helpers this needs. */
export type RevealFlow = {
	getViewport: () => RevealCamera;
	setViewport: (camera: RevealCamera, options: { duration: number }) => unknown;
};

/** The part of the page the reader sees, as the visual viewport reports it. */
type VisibleView = {
	offsetLeft: number;
	offsetTop: number;
	width: number;
	height: number;
};

/** How much room a block brought into view keeps around it, on the screen. */
export const REVEAL_MARGIN = 16;
/** How long the pan takes when motion is allowed (the Fit button's). */
export const REVEAL_PAN_MS = 200;
/** How long the pane and the visual viewport hold still before the block is looked at: a keyboard that opens in steps gets one pan, to where it ends. */
export const REVEAL_SETTLE_MS = 100;

const NODE = ".svelte-flow__node";

/** The part of the pane the reader can see: the pane, where the visual viewport is. */
export function visibleRoom(
	pane: ScreenRect,
	view: VisibleView | null,
): ScreenRect {
	if (!view) return { ...pane };
	return {
		left: Math.max(pane.left, view.offsetLeft),
		top: Math.max(pane.top, view.offsetTop),
		right: Math.min(pane.right, view.offsetLeft + view.width),
		bottom: Math.min(pane.bottom, view.offsetTop + view.height),
	};
}

/**
 * The least move along one axis that puts `start..end` inside `from..to` with
 * `margin` to spare, and none when it is inside already. A span too long for the
 * room starts at the margin instead, unless it fills the room as it is.
 */
function axisPan(
	start: number,
	end: number,
	from: number,
	to: number,
	margin: number,
): number {
	if (start >= from && end <= to) return 0;
	if (end - start + 2 * margin > to - from) {
		return start <= from && end >= to ? 0 : from + margin - start;
	}
	return start < from ? from + margin - start : to - margin - end;
}

/**
 * The pan, in screen pixels, that brings `block` fully into `room`, clear of the
 * `toolbar` standing in it, with `margin` to spare: the least distance, along each
 * axis. A block too big for the room it has left (above the toolbar, with its margin)
 * is not tried: the `field` the reader types in is brought in instead. There is no
 * zoom in it: a pan is all it can say.
 */
export function revealPan(
	block: ScreenRect,
	field: ScreenRect,
	room: ScreenRect,
	toolbar: ScreenRect | null,
	margin = REVEAL_MARGIN,
): Pan {
	const floor = toolbar ? Math.min(room.bottom, toolbar.top) : room.bottom;
	const target =
		block.right - block.left + 2 * margin > room.right - room.left ||
		block.bottom - block.top + 2 * margin > floor - room.top
			? field
			: block;
	const x = axisPan(target.left, target.right, room.left, room.right, margin);
	// The toolbar is in the way of what is above it, once the block has panned along.
	const under =
		toolbar !== null &&
		target.left + x < toolbar.right &&
		target.right + x > toolbar.left;
	const y = axisPan(
		target.top,
		target.bottom,
		room.top,
		under ? floor : room.bottom,
		margin,
	);
	return { x, y };
}

/**
 * Watches `root` (the board) for a text field in a block taking the focus, and pans
 * the camera when what the reader can see shrinks over that block: the pane getting
 * shorter, or the visual viewport. That is what a keyboard does; a field that takes
 * the focus with nothing changing around it is left to the reader. Once the camera
 * has been panned for a keyboard it is left alone until the keyboard has gone and come
 * back. Returns what stops it.
 */
export function watchKeyboardReveal(
	root: HTMLElement,
	flow: RevealFlow,
	isField: (target: EventTarget | null) => boolean,
): () => void {
	const view = window.visualViewport ?? null;
	let field: HTMLElement | null = null;
	/** The camera has been panned for this opening of the keyboard. */
	let panned = false;
	/** What the reader could see at the last look, to tell a keyboard coming from one going. */
	let before: ScreenRect | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const roomNow = () => visibleRoom(root.getBoundingClientRect(), view);

	function look(): void {
		timer = undefined;
		const block = field?.closest<HTMLElement>(NODE);
		if (!field?.isConnected || !block) return;
		const room = roomNow();
		const was = before ?? room;
		before = room;
		// More to see than a moment ago: the keyboard went, and the next one is a new opening.
		if (room.bottom - room.top > was.bottom - was.top + 1) panned = false;
		const covered =
			room.top > was.top + 1 ||
			room.bottom < was.bottom - 1 ||
			room.left > was.left + 1 ||
			room.right < was.right - 1;
		if (panned || !covered) return;
		const bar = root.querySelector(".canvas-toolbar");
		const pan = revealPan(
			block.getBoundingClientRect(),
			field.getBoundingClientRect(),
			room,
			bar ? bar.getBoundingClientRect() : null,
		);
		if (!pan.x && !pan.y) return;
		panned = true;
		const camera = flow.getViewport();
		void flow.setViewport(
			{ x: camera.x + pan.x, y: camera.y + pan.y, zoom: camera.zoom },
			{ duration: prefersReducedMotion() ? 0 : REVEAL_PAN_MS },
		);
	}

	function soon(): void {
		if (!field) return;
		clearTimeout(timer);
		timer = setTimeout(look, REVEAL_SETTLE_MS);
	}

	function take(target: EventTarget | null): void {
		field =
			target instanceof HTMLElement && isField(target) && target.closest(NODE)
				? target
				: null;
		panned = false;
		if (field) before = roomNow();
		soon();
	}

	const focusIn = (event: FocusEvent) => take(event.target);
	const focusOut = (event: FocusEvent) => {
		if (event.target !== field) return;
		field = null;
		clearTimeout(timer);
	};

	root.addEventListener("focusin", focusIn, true);
	root.addEventListener("focusout", focusOut, true);
	view?.addEventListener("resize", soon);
	view?.addEventListener("scroll", soon);
	const observer =
		typeof ResizeObserver === "undefined" ? null : new ResizeObserver(soon);
	observer?.observe(root);
	// The part may arrive after the reader has put the focus in a field.
	if (root.contains(document.activeElement)) take(document.activeElement);

	return () => {
		root.removeEventListener("focusin", focusIn, true);
		root.removeEventListener("focusout", focusOut, true);
		view?.removeEventListener("resize", soon);
		view?.removeEventListener("scroll", soon);
		observer?.disconnect();
		clearTimeout(timer);
		field = null;
	};
}
