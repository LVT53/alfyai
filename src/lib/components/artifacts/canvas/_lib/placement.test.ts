import { describe, expect, it } from "vitest";
import type { Rect } from "./board";
import {
	type InsertRequest,
	insertPanePlan,
	type PlacedBlock,
	placeInsertedBlock,
} from "./placement";

// Where a block the reader inserts goes (F8, the friction audit): on free ground the
// reader can see and use, never over the block put there a moment before, and when
// the pane has no such ground the block goes on the nearest there is and the camera
// is asked to bring it into view. Everything here is in board units.

const NOTE = { width: 200, height: 110 };
const FRAME = { width: 360, height: 260 };
const CHART = { width: 360, height: 228 };
const CHECKLIST = { width: 340, height: 98 };

/** The audit's pane: 945 x 778 at 100%, from the board's origin. */
const PANE: Rect = { x: 0, y: 0, width: 945, height: 778 };
/** What the pane keeps clear: room above for a block's own toolbar, the board's toolbar along the bottom. */
const INSET = { top: 64, right: 24, bottom: 112, left: 24 };

const overlaps = (a: Rect, b: Rect): boolean =>
	a.x < b.x + b.width &&
	b.x < a.x + a.width &&
	a.y < b.y + b.height &&
	b.y < a.y + a.height;

const inside = (rect: Rect, region: Rect): boolean =>
	rect.x >= region.x &&
	rect.y >= region.y &&
	rect.x + rect.width <= region.x + region.width &&
	rect.y + rect.height <= region.y + region.height;

const VIEW: Rect = {
	x: PANE.x + INSET.left,
	y: PANE.y + INSET.top,
	width: PANE.width - INSET.left - INSET.right,
	height: PANE.height - INSET.top - INSET.bottom,
};

function request(overrides: Partial<InsertRequest> = {}): InsertRequest {
	return {
		size: NOTE,
		blocks: [],
		pane: PANE,
		inset: INSET,
		...overrides,
	};
}

/** The rectangle the block takes once it is placed, in absolute board units. */
function rectOf(
	placed: PlacedBlock,
	size: { width: number; height: number },
	blocks: InsertRequest["blocks"] = [],
): Rect {
	const parent = blocks.find((block) => block.id === placed.parentId);
	return {
		x: placed.position.x + (parent?.rect.x ?? 0),
		y: placed.position.y + (parent?.rect.y ?? 0),
		...size,
	};
}

describe("placing a block the reader inserted", () => {
	it("centres it in what the pane leaves clear when nothing is in the way", () => {
		const placed = placeInsertedBlock(request());
		expect(placed.position).toEqual({
			x: Math.round(VIEW.x + VIEW.width / 2 - NOTE.width / 2),
			y: Math.round(VIEW.y + VIEW.height / 2 - NOTE.height / 2),
		});
		expect(placed.pan).toBeUndefined();
		expect(placed.parentId).toBeUndefined();
	});

	it("puts it where the camera is, not at the board's origin: the pane is wherever the reader has gone", () => {
		const pane: Rect = { x: 4_000, y: -2_000, width: 945, height: 778 };
		const placed = placeInsertedBlock(request({ pane }));
		expect(placed.position.x).toBeGreaterThan(4_000);
		expect(placed.position.y).toBeGreaterThan(-2_000);
		expect(placed.position.x).toBeLessThan(4_000 + 945);
	});

	it("gives whole numbers, so a saved board carries no pointer noise", () => {
		const placed = placeInsertedBlock(
			request({ pane: { x: 0.4, y: 0.7, width: 945.3, height: 778.9 } }),
		);
		expect(Number.isInteger(placed.position.x)).toBe(true);
		expect(Number.isInteger(placed.position.y)).toBe(true);
	});

	it("keeps a gap between it and a block already there, not an edge laid against an edge", () => {
		const centred = placeInsertedBlock(request()).position;
		const taken: Rect = { x: centred.x, y: centred.y, ...NOTE };
		const placed = placeInsertedBlock(
			request({ blocks: [{ id: "a", rect: taken }] }),
		);
		const rect = rectOf(placed, NOTE);
		const gapX = Math.max(
			taken.x - (rect.x + rect.width),
			rect.x - (taken.x + taken.width),
		);
		const gapY = Math.max(
			taken.y - (rect.y + rect.height),
			rect.y - (taken.y + taken.height),
		);
		expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(24);
	});

	it("goes to the nearest free ground: a step of about one block, never a ring further out", () => {
		const centred = placeInsertedBlock(request()).position;
		const taken: Rect = { x: centred.x, y: centred.y, ...NOTE };
		const placed = placeInsertedBlock(
			request({ blocks: [{ id: "a", rect: taken }] }),
		);
		const step = Math.hypot(
			placed.position.x - centred.x,
			placed.position.y - centred.y,
		);
		expect(step).toBeLessThan(Math.hypot(2 * NOTE.width, 2 * NOTE.height));
	});

	it("stays wholly inside what the pane leaves clear, whatever else it has to avoid", () => {
		const blocks: InsertRequest["blocks"] = [
			{ id: "a", rect: { x: 300, y: 250, ...NOTE } },
			{ id: "b", rect: { x: 520, y: 250, ...NOTE } },
			{ id: "c", rect: { x: 300, y: 400, ...NOTE } },
		];
		const placed = placeInsertedBlock(request({ blocks }));
		expect(inside(rectOf(placed, NOTE), VIEW)).toBe(true);
		for (const block of blocks) {
			expect(overlaps(rectOf(placed, NOTE), block.rect)).toBe(false);
		}
		expect(placed.pan).toBeUndefined();
	});

	it("keeps clear of what floats over the pane: the board's toolbar, the overview in the corner", () => {
		const toolbar: Rect = { x: 250, y: 690, width: 450, height: 56 };
		const overview: Rect = { x: 780, y: 540, width: 132, height: 200 };
		const placed = placeInsertedBlock(
			request({
				size: CHART,
				chrome: [toolbar, overview],
				// Ground the blocks leave free: the lower half only.
				blocks: [
					{ id: "top", rect: { x: 24, y: 64, width: 897, height: 330 } },
				],
			}),
		);
		const rect = rectOf(placed, CHART);
		expect(overlaps(rect, toolbar)).toBe(false);
		expect(overlaps(rect, overview)).toBe(false);
	});
});

describe("a block put where a frame stands", () => {
	const frame = (
		rect: Rect,
		id = "frame",
	): InsertRequest["blocks"][number] => ({
		id,
		rect,
		frame: true,
	});

	it("never lies across a frame it does not fit in: a chart is not put over the frame made a moment before", () => {
		// The audit: a frame 360 x 260 at the middle, and the next block, a chart 360 x 228,
		// put at the very same place, across it. Neither side of such a frame leaves a chart
		// room in a pane this size, so the chart goes beside it and the camera shows it.
		const centred = placeInsertedBlock(request({ size: FRAME, asFrame: true }));
		const made = frame({ ...centred.position, ...FRAME });
		const placed = placeInsertedBlock(request({ size: CHART, blocks: [made] }));
		const rect = rectOf(placed, CHART);
		expect(overlaps(rect, made.rect)).toBe(false);
		expect(placed.parentId).toBeUndefined();
		const shown: Rect = {
			...VIEW,
			x: VIEW.x + (placed.pan?.x ?? 0),
			y: VIEW.y + (placed.pan?.y ?? 0),
		};
		expect(inside(rect, shown)).toBe(true);
		// And only as far as it has to: the nearest edge, not across the board.
		expect(Math.hypot(placed.pan?.x ?? 0, placed.pan?.y ?? 0)).toBeLessThan(
			200,
		);
	});

	it("is wholly in view, next to the frame, when the pane has the room", () => {
		const roomy: Rect = { x: 0, y: 0, width: 1_800, height: 1_000 };
		const centred = placeInsertedBlock(
			request({ pane: roomy, size: FRAME, asFrame: true }),
		);
		const made = frame({ ...centred.position, ...FRAME });
		const placed = placeInsertedBlock(
			request({ pane: roomy, size: CHART, blocks: [made] }),
		);
		expect(overlaps(rectOf(placed, CHART), made.rect)).toBe(false);
		expect(placed.pan).toBeUndefined();
	});

	it("goes inside a frame it fits in, as that frame's own, in the frame's space", () => {
		const big = frame({ x: 100, y: 100, width: 700, height: 520 });
		const placed = placeInsertedBlock(request({ blocks: [big] }));
		expect(placed.parentId).toBe("frame");
		const rect = rectOf(placed, NOTE, [big]);
		// Wholly inside the frame, clear of its title band and its edges.
		expect(rect.x).toBeGreaterThanOrEqual(big.rect.x + 20);
		expect(rect.y).toBeGreaterThanOrEqual(big.rect.y + 56);
		expect(rect.x + rect.width).toBeLessThanOrEqual(
			big.rect.x + big.rect.width - 20,
		);
		expect(rect.y + rect.height).toBeLessThanOrEqual(
			big.rect.y + big.rect.height - 20,
		);
	});

	it("goes in the innermost frame that holds it", () => {
		const outer = frame({ x: 50, y: 70, width: 800, height: 600 }, "outer");
		const inner = frame({ x: 200, y: 200, width: 500, height: 380 }, "inner");
		const placed = placeInsertedBlock(request({ blocks: [outer, inner] }));
		expect(placed.parentId).toBe("inner");
	});

	it("keeps off the blocks that are in a frame as it does off any block", () => {
		const big = frame({ x: 100, y: 100, width: 700, height: 520 });
		const inside1: InsertRequest["blocks"][number] = {
			id: "n1",
			rect: { x: 300, y: 250, ...NOTE },
		};
		const placed = placeInsertedBlock(request({ blocks: [big, inside1] }));
		expect(overlaps(rectOf(placed, NOTE, [big]), inside1.rect)).toBe(false);
	});

	it("keeps a new frame off everything, frames too, and in no frame", () => {
		const centred = placeInsertedBlock(request({ size: FRAME, asFrame: true }));
		const made = frame({ ...centred.position, ...FRAME });
		const placed = placeInsertedBlock(
			request({ size: FRAME, asFrame: true, blocks: [made] }),
		);
		expect(overlaps(rectOf(placed, FRAME), made.rect)).toBe(false);
		expect(placed.parentId).toBeUndefined();
	});
});

describe("when the pane has no free ground", () => {
	/** A pane full of blocks: a grid that leaves a gap between its cells narrower than a block. */
	function crowded(): InsertRequest["blocks"] {
		const blocks: InsertRequest["blocks"][number][] = [];
		for (let column = 0; column < 4; column += 1) {
			for (let row = 0; row < 5; row += 1) {
				blocks.push({
					id: `b${column}${row}`,
					rect: {
						x: 24 + column * 232,
						y: 64 + row * 120,
						width: 200,
						height: 100,
					},
				});
			}
		}
		return blocks;
	}

	it("puts the block on the nearest free ground beyond it and asks the camera to bring it in, by the least distance", () => {
		const blocks = crowded();
		const placed = placeInsertedBlock(request({ blocks }));
		const rect = rectOf(placed, NOTE);
		for (const block of blocks) expect(overlaps(rect, block.rect)).toBe(false);
		expect(inside(rect, VIEW)).toBe(false);
		expect(placed.pan).toBeDefined();
		// After the camera has moved, the block is wholly in what the pane leaves clear.
		const moved: Rect = {
			...VIEW,
			x: VIEW.x + (placed.pan?.x ?? 0),
			y: VIEW.y + (placed.pan?.y ?? 0),
		};
		expect(inside(rect, moved)).toBe(true);
		// The least distance: the block ends against the edge it was beyond, with nothing to spare.
		const slack = Math.min(
			rect.x - moved.x,
			rect.y - moved.y,
			moved.x + moved.width - (rect.x + rect.width),
			moved.y + moved.height - (rect.y + rect.height),
		);
		expect(slack).toBe(0);
	});

	it("starts a block wider than the pane at the pane's own edge, the part it can show", () => {
		const wide = { width: 1_400, height: 200 };
		const placed = placeInsertedBlock(request({ size: wide }));
		expect(placed.position.x).toBe(VIEW.x);
		expect(placed.pan).toBeUndefined();
	});

	it("falls back to the centre, staggered like a note, when there is no free ground to be found at all", () => {
		const everything: Rect = {
			x: -50_000,
			y: -50_000,
			width: 100_000,
			height: 100_000,
		};
		const first = placeInsertedBlock(
			request({ blocks: [{ id: "all", rect: everything }] }),
		);
		const centred = {
			x: Math.round(VIEW.x + VIEW.width / 2 - NOTE.width / 2),
			y: Math.round(VIEW.y + VIEW.height / 2 - NOTE.height / 2),
		};
		expect(first.position).toEqual(centred);
		expect(first.pan).toBeUndefined();
	});

	it("is finite for every size and every board, and never loops", () => {
		const many = Array.from({ length: 400 }, (_, index) => ({
			id: `m${index}`,
			rect: {
				x: (index % 20) * 60,
				y: Math.floor(index / 20) * 60,
				width: 50,
				height: 50,
			},
		}));
		const placed = placeInsertedBlock(request({ size: CHART, blocks: many }));
		expect(Number.isFinite(placed.position.x)).toBe(true);
		expect(Number.isFinite(placed.position.y)).toBe(true);
	});
});

describe("five blocks in a row on a populated board (the audit's own)", () => {
	it("puts each one clear of the others, wholly in what the pane leaves clear, with nothing stacked", () => {
		// What the audit's board held: two frames with notes, a chart and a diagram.
		const blocks: InsertRequest["blocks"][number][] = [
			{
				id: "sat",
				frame: true,
				rect: { x: 24, y: 150, width: 440, height: 250 },
			},
			{
				id: "sun",
				frame: true,
				rect: { x: 500, y: 150, width: 420, height: 250 },
			},
			{ id: "n1", rect: { x: 60, y: 220, width: 190, height: 70 } },
			{ id: "n2", rect: { x: 300, y: 220, width: 190, height: 70 } },
			{ id: "n3", rect: { x: 540, y: 220, width: 190, height: 70 } },
			{ id: "chart", rect: { x: 40, y: 480, width: 360, height: 220 } },
			{ id: "flow", rect: { x: 440, y: 480, width: 480, height: 83 } },
		];
		const placed: Rect[] = [];
		let view = VIEW;
		const sizes: { width: number; height: number; frame?: boolean }[] = [
			NOTE,
			{ width: 240, height: 60 },
			{ ...FRAME, frame: true },
			CHART,
			CHECKLIST,
		];
		for (const size of sizes) {
			const result = placeInsertedBlock(
				request({
					size,
					asFrame: size.frame === true,
					blocks,
					pane: {
						x: view.x - INSET.left,
						y: view.y - INSET.top,
						width: PANE.width,
						height: PANE.height,
					},
				}),
			);
			const rect = rectOf(result, size, blocks);
			if (result.pan) {
				view = { ...view, x: view.x + result.pan.x, y: view.y + result.pan.y };
			}
			expect(inside(rect, view), `${size.width}x${size.height}`).toBe(true);
			// Not over anything already there, a frame it is not in included.
			for (const block of blocks) {
				const parentOf = result.parentId === block.id;
				if (block.frame && parentOf) continue;
				expect(
					overlaps(rect, block.rect),
					`${size.width}x${size.height} on ${block.id}`,
				).toBe(false);
			}
			blocks.push({
				id: `new${placed.length}`,
				rect,
				frame: size.frame === true,
			});
			placed.push(rect);
		}
		expect(placed).toHaveLength(5);
	});
});

describe("the camera a plan asks for", () => {
	it("moves nothing when the block is already in view", () => {
		const plan = insertPanePlan({ x: 10, y: 20, zoom: 0.5 }, undefined);
		expect(plan).toBeNull();
	});

	it("moves the camera against the pan, at the camera's own zoom: looking further right moves the board left", () => {
		const plan = insertPanePlan(
			{ x: 10, y: 20, zoom: 0.5 },
			{ x: 100, y: -40 },
		);
		expect(plan).toEqual({ x: 10 - 100 * 0.5, y: 20 + 40 * 0.5, zoom: 0.5 });
	});
});
