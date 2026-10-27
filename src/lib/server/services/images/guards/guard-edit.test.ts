import { describe, expect, it } from "vitest";
import { guardEdit } from "./guard-edit";
import {
	copyOf,
	fillBox,
	makeScene,
	RECTS,
	SCENE_H,
	SCENE_W,
} from "./test-scene";

const base = makeScene();
const margin = Math.ceil(0.04 * SCENE_H) + 12; // dilation + feather + a work pixel

function equalOutside(
	a: Uint8Array,
	b: Uint8Array,
	boxes: Array<{ x: number; y: number; w: number; h: number }>,
) {
	for (let y = 0; y < SCENE_H; y++) {
		for (let x = 0; x < SCENE_W; x++) {
			if (
				boxes.some(
					(r) =>
						x > r.x - margin &&
						x < r.x + r.w + margin &&
						y > r.y - margin &&
						y < r.y + r.h + margin,
				)
			)
				continue;
			const o = (y * SCENE_W + x) * 4;
			if (
				a[o] !== b[o] ||
				a[o + 1] !== b[o + 1] ||
				a[o + 2] !== b[o + 2] ||
				a[o + 3] !== b[o + 3]
			) {
				return `differs at ${x},${y}`;
			}
		}
	}
	return null;
}

describe("guardEdit", () => {
	it("pastes a recolour back and leaves the rest as the base", async () => {
		const result = copyOf(base);
		const box = RECTS[1].box;
		fillBox(result, box, [250, 20, 200]);
		const out = await guardEdit({
			base,
			anchor: null,
			chainSinceAnchor: 0,
			result,
			marks: null,
		});
		expect(out.measures.miss).toBeNull();
		expect(out.measures.global).toBe(false);
		expect(out.chainSinceAnchor).toBe(1);
		expect(out.anchorIsResult).toBe(false);
		expect(equalOutside(out.picture.data, base.data, [box])).toBeNull();
		const o = ((box.y + 40) * SCENE_W + box.x + 40) * 4;
		expect(Array.from(out.picture.data.subarray(o, o + 3))).toEqual([
			250, 20, 200,
		]);
	});

	it("reports nothing changed for a result that is the base with noise", async () => {
		const result = copyOf(base);
		for (let i = 0; i < result.data.length; i += 4)
			result.data[i] = Math.min(
				255,
				result.data[i] + (i % 8 === 0 ? 3 : -3 + 3),
			);
		const out = await guardEdit({
			base,
			anchor: null,
			chainSinceAnchor: 0,
			result,
			marks: null,
		});
		expect(out.measures.miss).toBe("nothing_changed");
	});

	it("reports a change outside the marks", async () => {
		const result = copyOf(base);
		fillBox(result, RECTS[2].box, [250, 20, 200]);
		const left = RECTS[0].box;
		const marks = [
			{
				x: left.x / SCENE_W,
				y: left.y / SCENE_H,
				w: left.w / SCENE_W,
				h: left.h / SCENE_H,
			},
		];
		const out = await guardEdit({
			base,
			anchor: null,
			chainSinceAnchor: 0,
			result,
			marks,
		});
		expect(out.measures.miss).toBe("outside_marks");
		expect(out.measures.insideMarksShare as number).toBeLessThan(0.5);
	});

	it("keeps a change inside the marks as a hit", async () => {
		const result = copyOf(base);
		const box = RECTS[0].box;
		fillBox(result, box, [250, 20, 200]);
		const marks = [
			{
				x: box.x / SCENE_W,
				y: box.y / SCENE_H,
				w: box.w / SCENE_W,
				h: box.h / SCENE_H,
			},
		];
		const out = await guardEdit({
			base,
			anchor: null,
			chainSinceAnchor: 0,
			result,
			marks,
		});
		expect(out.measures.miss).toBeNull();
		expect(out.measures.insideMarksShare as number).toBeGreaterThan(0.9);
	});

	it("keeps a whole repaint whole and restarts the chain", async () => {
		const result = copyOf(base);
		fillBox(
			result,
			{ x: 0, y: 0, w: SCENE_W, h: Math.round(SCENE_H * 0.7) },
			[30, 220, 90],
		);
		const out = await guardEdit({
			base,
			anchor: null,
			chainSinceAnchor: 2,
			result,
			marks: null,
		});
		expect(out.measures.global).toBe(true);
		expect(out.anchorIsResult).toBe(true);
		expect(out.chainSinceAnchor).toBe(0);
		expect(out.picture.data[0]).toBe(30);
	});

	it("re-anchors on the fourth change and pastes onto the anchor", async () => {
		const anchor = copyOf(base);
		const earlier = RECTS[3].box;
		fillBox(anchor, earlier, [10, 10, 10]);
		const result = copyOf(base);
		const now = RECTS[1].box;
		fillBox(result, now, [250, 20, 200]);
		const out = await guardEdit({
			base,
			anchor,
			chainSinceAnchor: 3,
			result,
			marks: null,
		});
		expect(out.measures.reanchored).toBe(true);
		expect(out.chainSinceAnchor).toBe(0);
		expect(
			equalOutside(out.picture.data, anchor.data, [earlier, now]),
		).toBeNull();
	});

	it("keeps transparency where the base had none to give", async () => {
		const clear = copyOf(base);
		for (let y = 0; y < SCENE_H; y++) {
			for (let x = 0; x < 40; x++)
				clear.data.fill(0, (y * SCENE_W + x) * 4, (y * SCENE_W + x) * 4 + 4);
		}
		const result = copyOf(clear);
		for (let y = 0; y < SCENE_H; y++)
			for (let x = 0; x < 40; x++) result.data[(y * SCENE_W + x) * 4 + 3] = 255;
		fillBox(result, RECTS[2].box, [250, 20, 200]);
		const out = await guardEdit({
			base: clear,
			anchor: null,
			chainSinceAnchor: 0,
			result,
			marks: null,
		});
		expect(out.picture.data[(400 * SCENE_W + 10) * 4 + 3]).toBe(0);
	});

	it("refuses an empty base", async () => {
		const empty = { data: new Uint8Array(0), width: 0, height: 0 };
		await expect(
			guardEdit({
				base: empty,
				anchor: null,
				chainSinceAnchor: 0,
				result: base,
				marks: null,
			}),
		).rejects.toThrow();
	});
});
