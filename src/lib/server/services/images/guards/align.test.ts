import { describe, expect, it } from "vitest";
import { applyAlignment, estimateAlignment } from "./align";
import { copyOf, fillBox, makeScene, warp } from "./test-scene";

describe("estimateAlignment", () => {
	const base = makeScene();

	it("recovers a shift to within a pixel", () => {
		const a = estimateAlignment(warp(base, 1, 12, -8), base);
		expect(Math.abs(a.dx - 12)).toBeLessThanOrEqual(1);
		expect(Math.abs(a.dy + 8)).toBeLessThanOrEqual(1);
		expect(Math.abs(a.scale - 1)).toBeLessThan(0.005);
	});

	it("recovers a scale of 1.03", () => {
		const a = estimateAlignment(warp(base, 1.03, 0, 0), base);
		expect(Math.abs(a.scale - 1.03)).toBeLessThanOrEqual(0.005);
	});

	it("still finds a shift when 30% of the area is recoloured", () => {
		const moved = warp(base, 1, 6, 4);
		const recoloured = copyOf(moved);
		fillBox(recoloured, { x: 0, y: 0, w: 1248, h: 250 }, [10, 240, 240]);
		const a = estimateAlignment(recoloured, base);
		expect(Math.abs(a.dx - 6)).toBeLessThanOrEqual(1);
		expect(Math.abs(a.dy - 4)).toBeLessThanOrEqual(1);
	});

	it("answers the identity for an empty picture", () => {
		const empty = { data: new Uint8Array(0), width: 0, height: 0 };
		expect(estimateAlignment(empty, base)).toEqual({ dx: 0, dy: 0, scale: 1 });
		expect(estimateAlignment(base, empty)).toEqual({ dx: 0, dy: 0, scale: 1 });
	});
});

describe("applyAlignment", () => {
	it("puts a shifted result back on the base and leaves new edges transparent", async () => {
		const base = makeScene();
		const aligned = await applyAlignment(warp(base, 1, 12, -8), base, {
			dx: 12,
			dy: -8,
			scale: 1,
		});
		expect(aligned.width).toBe(base.width);
		const o = (400 * base.width + 300) * 4;
		expect(Array.from(aligned.data.subarray(o, o + 4))).toEqual(
			Array.from(base.data.subarray(o, o + 4)),
		);
		// the top 8 rows have nothing to show
		expect(aligned.data[(2 * base.width + 100) * 4 + 3]).toBe(0);
	});
});
