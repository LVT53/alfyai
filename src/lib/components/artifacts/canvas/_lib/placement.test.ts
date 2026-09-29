import { describe, expect, it } from "vitest";
import { placeInsertedBlock } from "./placement";

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
