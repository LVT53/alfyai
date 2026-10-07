/**
 * Where the pill a selection raises sits (Feature 2 · Artifacts, Slice 3): below
 * the selected blocks, centred, because their own small toolbar (Delete and the
 * block's controls) is above them; and above that toolbar when there is no room
 * below, the board's own toolbar running along the bottom of the pane. It is kept
 * inside the pane, and off the change pill (RC-3 N3): the pill is as wide as its
 * two buttons, so a block near an edge of a phone's pane put it half outside, and
 * the change pill hangs from the block below, which is where this one goes. Pure
 * and in board space, like the geometry it reads, so it is unit-tested without a
 * browser.
 */
import {
	BOARD_TOOLBAR_CLEARANCE,
	PANE_EDGE_GAP,
	rectsMeet,
	type ScreenRect,
} from "./floating";
import type { Box } from "./review-geometry";

/** The pill's own size on the screen before it is measured (redesign §4.2 item 1: 38 tall). */
const DEFAULT_SIZE = { width: 240, height: 38 };
/** The gap between a block and the pill, on screen. */
const GAP = 14;
/** How far above a block a pill hangs to clear the block's own toolbar, on screen. */
const ABOVE_CLEARANCE = 60;
/** How close the pill may come to the change pill, on screen. */
const AVOID_GAP = 6;

export type SelectionPillPlacement = {
	side: "below" | "above";
	/** The point the pill hangs from, in board space: its centre line, and the edge of the box it is on. */
	x: number;
	y: number;
	/** How much further than its usual gap the pill hangs from the block, on the screen. Below the block: the block's own toolbar is under it, and the pill stands under that (CV-B2). Above it: the toolbar is taller than the usual clearance reckons with (a phone's, 52 px), and the pill stands over it. Left out when it is none. */
	lift?: number;
};

type Camera = { x: number; y: number; zoom: number };
type Size = { width: number; height: number };

export function selectionPillPlacement(
	box: Box,
	camera: Camera,
	pane: Size,
	options: {
		/** The pill's size on the screen, as measured: a phone's is taller. */
		size?: Size;
		/** Where the change pill is on the screen: this pill keeps off it. */
		avoid?: ScreenRect | null;
		/** Where the picked block's own toolbar is on the screen. Below the block (it had no room above), the pill hangs under it; above it, as ever, the pill clears it. */
		toolbar?: ScreenRect | null;
	} = {},
): SelectionPillPlacement {
	const size = options.size ?? DEFAULT_SIZE;
	const avoid = options.avoid ?? null;
	const centre = box.x + box.width / 2;
	const screenCentre = centre * camera.zoom + camera.x;
	const screenTop = box.y * camera.zoom + camera.y;
	const screenBottom = (box.y + box.height) * camera.zoom + camera.y;
	const known = pane.width > 0 && pane.height > 0;
	// The block's toolbar hangs below it: the pill stands under the toolbar, not on it.
	const toolbar = options.toolbar ?? null;
	const lift =
		toolbar !== null && toolbar.top >= screenBottom
			? Math.max(0, toolbar.bottom + AVOID_GAP - screenBottom - GAP)
			: 0;
	// Above the block the toolbar is above it, and ABOVE_CLEARANCE is the room a toolbar
	// of a pointer's size takes: a taller one (a phone's) is cleared by its own height.
	const rise =
		toolbar !== null && toolbar.bottom <= screenTop
			? Math.max(0, screenTop - toolbar.top + AVOID_GAP - ABOVE_CLEARANCE)
			: 0;
	const noRoom =
		known &&
		screenBottom + GAP + lift + size.height >
			pane.height - BOARD_TOOLBAR_CLEARANCE;
	const preferred = noRoom ? "above" : "below";
	const sides = [preferred, preferred === "below" ? "above" : "below"] as const;

	const inside = (centreX: number): number => {
		if (!known) return centreX;
		const least = PANE_EDGE_GAP + size.width / 2;
		const most = pane.width - PANE_EDGE_GAP - size.width / 2;
		return least > most
			? pane.width / 2
			: Math.min(Math.max(centreX, least), most);
	};
	const rectOf = (side: "below" | "above", centreX: number): ScreenRect => {
		const top =
			side === "below"
				? screenBottom + GAP + lift
				: screenTop - ABOVE_CLEARANCE - rise - size.height;
		return {
			left: centreX - size.width / 2,
			top,
			right: centreX + size.width / 2,
			bottom: top + size.height,
		};
	};
	const fits = (rect: ScreenRect): boolean =>
		(!known || (rect.top >= 0 && rect.bottom <= pane.height)) &&
		(avoid === null || !rectsMeet(rect, avoid, AVOID_GAP));
	const placed = (side: "below" | "above", centreX: number) => ({
		side,
		x: (centreX - camera.x) / camera.zoom,
		y: side === "below" ? box.y + box.height : box.y,
		...(side === "below" && lift > 0 ? { lift } : {}),
		...(side === "above" && rise > 0 ? { lift: rise } : {}),
	});

	// The middle of the block first, then on its other side, then slid to either
	// side of the change pill (the side that comes first is the block's preferred).
	const middle = inside(screenCentre);
	const candidates: { side: "below" | "above"; centreX: number }[] = [
		...sides.map((side) => ({ side, centreX: middle })),
	];
	if (avoid !== null) {
		for (const side of sides) {
			candidates.push(
				{
					side,
					centreX: inside(avoid.right + AVOID_GAP + size.width / 2),
				},
				{
					side,
					centreX: inside(avoid.left - AVOID_GAP - size.width / 2),
				},
			);
		}
	}
	const found =
		candidates.find(({ side, centreX }) => fits(rectOf(side, centreX))) ??
		candidates[0];
	return placed(found.side, found.centreX);
}
