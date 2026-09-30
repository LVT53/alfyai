import { describe, expect, it } from "vitest";
import type { Rect } from "./board";
import { placeBesideBlocks, placeInsertedBlock } from "./placement";

const size = { width: 200, height: 100 };

describe("placing an inserted block", () => {
	it("centres it on what the reader is looking at", () => {
		expect(
			placeInsertedBlock({ center: { x: 500, y: 300 }, size, taken: [] }),
		).toEqual({ x: 400, y: 250 });
	});

	it("rounds to whole board units", () => {
		expect(
			placeInsertedBlock({ center: { x: 500.4, y: 300.7 }, size, taken: [] }),
		).toEqual({ x: 400, y: 251 });
	});

	it("staggers it off a block already at that spot, however many there are", () => {
		const first = placeInsertedBlock({
			center: { x: 500, y: 300 },
			size,
			taken: [],
		});
		const second = placeInsertedBlock({
			center: { x: 500, y: 300 },
			size,
			taken: [first],
		});
		const third = placeInsertedBlock({
			center: { x: 500, y: 300 },
			size,
			taken: [first, second],
		});
		expect(second).toEqual({ x: first.x + 28, y: first.y + 28 });
		expect(third).toEqual({ x: first.x + 56, y: first.y + 56 });
	});

	it("leaves a block alone that only sits near, not on, the spot", () => {
		expect(
			placeInsertedBlock({
				center: { x: 500, y: 300 },
				size,
				taken: [{ x: 300, y: 250 }],
			}),
		).toEqual({ x: 400, y: 250 });
	});

	it("gives up staggering rather than looping when the board is full of blocks all the way down", () => {
		const taken = Array.from({ length: 200 }, (_, index) => ({
			x: 400 + index * 28,
			y: 250 + index * 28,
		}));
		const spot = placeInsertedBlock({
			center: { x: 500, y: 300 },
			size,
			taken,
		});
		expect(Number.isFinite(spot.x) && Number.isFinite(spot.y)).toBe(true);
	});
});

// The blocks made from the chat are big (an App is 400 x 340), so the note's
// 28-unit stagger would pile them on one another: an App laid over an App takes
// the clicks of the one under it. They are placed on free ground instead, as near
// the centre of the view as there is any.
describe("placing a block made from the chat", () => {
	const app = { width: 400, height: 340 };
	const centre = { x: 800, y: 500 };
	const spot = (occupied: Rect[], visible?: Rect) =>
		placeBesideBlocks({ center: centre, size: app, occupied, visible });
	const rectAt = (at: { x: number; y: number }, size = app): Rect => ({
		...at,
		...size,
	});
	const overlaps = (a: Rect, b: Rect) =>
		a.x < b.x + b.width &&
		b.x < a.x + a.width &&
		a.y < b.y + b.height &&
		b.y < a.y + a.height;

	it("centres it on the view when nothing is there", () => {
		expect(spot([])).toEqual({ x: 600, y: 330 });
	});

	it("leaves a block that only sits near the centre alone", () => {
		// Its edge stops short of where the new block would start.
		expect(spot([{ x: 100, y: 330, width: 400, height: 340 }])).toEqual({
			x: 600,
			y: 330,
		});
	});

	it("moves off a block that is in the way, without touching it", () => {
		const taken = rectAt({ x: 600, y: 330 });
		const at = spot([taken]);
		expect(overlaps(rectAt(at), taken)).toBe(false);
		// Whole numbers, so the saved board carries no float noise.
		expect(Number.isInteger(at.x) && Number.isInteger(at.y)).toBe(true);
	});

	it("keeps clear of several blocks, one after another, however many it puts down", () => {
		const occupied: Rect[] = [];
		for (let index = 0; index < 6; index += 1) {
			const at = spot(occupied);
			const rect = rectAt(at);
			expect(occupied.some((other) => overlaps(rect, other))).toBe(false);
			occupied.push(rect);
		}
	});

	it("goes to the nearest free ground: the first block moved aside is the smallest step away", () => {
		const taken = rectAt({ x: 600, y: 330 });
		const at = spot([taken]);
		const step = Math.hypot(at.x - 600, at.y - 330);
		// Beside or below, one block plus a gap away; never a ring further out.
		expect(step).toBeLessThan(Math.hypot(2 * app.width, 2 * app.height));
	});

	it("prefers ground the reader can see over ground off the edge of the view", () => {
		const taken = rectAt({ x: 600, y: 330 });
		// The view ends just right of the taken block: only the left, above and below stay in view.
		const visible: Rect = { x: 0, y: 0, width: 1_040, height: 900 };
		const at = spot([taken], visible);
		expect(at.x).toBeLessThan(600 + app.width);
		const seen =
			at.x < visible.x + visible.width && at.x + app.width > visible.x;
		expect(seen).toBe(true);
	});

	it("falls back to the centre, staggered like a note, when there is no free ground to be found", () => {
		// One block the size of the whole board: nowhere is clear.
		const everything: Rect = {
			x: -50_000,
			y: -50_000,
			width: 100_000,
			height: 100_000,
		};
		const at = spot([everything]);
		expect(at).toEqual({ x: 600, y: 330 });
	});
});
