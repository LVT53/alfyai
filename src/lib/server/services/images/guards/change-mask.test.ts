import { describe, expect, it } from "vitest";
import { changeMask } from "./change-mask";
import { copyOf, fillBox, makeScene, SCENE_H, SCENE_W } from "./test-scene";

describe("changeMask", () => {
	const base = makeScene();

	it("sees no change in identical pictures", () => {
		expect(changeMask(base, copyOf(base)).changedShare).toBe(0);
	});

	it("masks a recoloured box and nothing far from it", () => {
		const box = { x: 560, y: 300, w: 100, h: 80 };
		const after = copyOf(base);
		fillBox(after, box, [250, 250, 250]);
		const { mask, changedShare } = changeMask(base, after);
		for (let y = box.y; y < box.y + box.h; y++) {
			for (let x = box.x; x < box.x + box.w; x++) {
				expect(mask[y * SCENE_W + x]).toBeGreaterThanOrEqual(0.95);
			}
		}
		expect(mask[0]).toBe(0);
		expect(mask[SCENE_W * SCENE_H - 1]).toBe(0);
		const grow = 0.02 * SCENE_H;
		const expected =
			((box.w + 2 * grow) * (box.h + 2 * grow)) / (SCENE_W * SCENE_H);
		expect(changedShare).toBeGreaterThan(expected * 0.75);
		expect(changedShare).toBeLessThan(expected * 1.25);
	});

	it("ignores small noise", () => {
		const after = copyOf(base);
		for (let i = 0; i < after.data.length; i += 4)
			after.data[i] = Math.min(255, after.data[i] + 3);
		expect(changeMask(base, after).changedShare).toBe(0);
	});

	it("answers an empty mask for empty pictures", () => {
		const empty = { data: new Uint8Array(0), width: 0, height: 0 };
		expect(changeMask(empty, empty)).toEqual({
			mask: new Float32Array(0),
			changedShare: 0,
		});
	});
});
