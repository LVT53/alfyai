import { describe, expect, it } from "vitest";
import { guardEdit } from "./guard-edit";
import { copyOf, fillBox, sceneAt, warp } from "./test-scene";

// A small canvas: the alignment search costs the same on any frame the size of
// its work width, so a 208-wide scene keeps every case well under a second
// where the full 1248-wide one took over a second (and seven for one case).
const scene = sceneAt(208);
const base = scene.base;
const RECTS = scene.rects;
const SCENE_W = scene.width;
const SCENE_H = scene.height;
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
		const o = ((box.y + scene.px(40)) * SCENE_W + box.x + scene.px(40)) * 4;
		expect(Array.from(out.picture.data.subarray(o, o + 3))).toEqual([
			250, 20, 200,
		]);
	});

	it("reports nothing changed for a result that is the base with noise", async () => {
		const result = copyOf(base);
		let seed = 12345;
		for (let i = 0; i < result.data.length; i += 4) {
			for (let c = 0; c < 3; c++) {
				seed = (seed * 1664525 + 1013904223) >>> 0;
				const noise = seed & 0x8000 ? 3 : -3;
				result.data[i + c] = Math.min(
					255,
					Math.max(0, result.data[i + c] + noise),
				);
			}
		}
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

	describe("an edit with marks", () => {
		// A marked box in a free patch of the scene and a second change elsewhere:
		// the picture's gradient is the only thing under both.
		const MARKED = { x: 70, y: 60, w: 40, h: 40 };
		const marks = [
			{
				x: MARKED.x / SCENE_W,
				y: MARKED.y / SCENE_H,
				w: MARKED.w / SCENE_W,
				h: MARKED.h / SCENE_H,
			},
		];
		const grow = Math.ceil(0.1 * Math.min(SCENE_W, SCENE_H));
		const changed = (outsideWidth: number) => {
			const result = copyOf(base);
			fillBox(result, MARKED, [250, 20, 200]);
			fillBox(
				result,
				{ x: 60, y: 128, w: outsideWidth, h: 10 },
				[10, 250, 250],
			);
			return result;
		};
		const run = (result: typeof base) =>
			guardEdit({ base, anchor: null, chainSinceAnchor: 0, result, marks });

		it("changes nothing outside the marks grown by a tenth of the short side, even when the result changed more", async () => {
			const out = await run(changed(16));
			const x0 = MARKED.x - grow;
			const x1 = MARKED.x + MARKED.w + grow;
			const y0 = MARKED.y - grow;
			const y1 = MARKED.y + MARKED.h + grow;
			let outside = 0;
			for (let y = 0; y < SCENE_H; y++) {
				for (let x = 0; x < SCENE_W; x++) {
					if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
					outside++;
					const o = (y * SCENE_W + x) * 4;
					for (let c = 0; c < 4; c++) {
						if (out.picture.data[o + c] !== base.data[o + c]) {
							throw new Error(`differs at ${x},${y}`);
						}
					}
				}
			}
			expect(outside).toBeGreaterThan(0);
			// The marked change itself is carried.
			const o = ((MARKED.y + 20) * SCENE_W + MARKED.x + 20) * 4;
			expect(Array.from(out.picture.data.subarray(o, o + 3))).toEqual([
				250, 20, 200,
			]);
			expect(out.mask[(MARKED.y + 20) * SCENE_W + MARKED.x + 20]).toBe(1);
		});

		it("feathers the edge of the allowed area instead of cutting it", async () => {
			// A repaint that runs well past the allowed area on every side.
			const result = copyOf(base);
			fillBox(result, { x: 20, y: 40, w: 150, h: 80 }, [250, 20, 200]);
			const out = await run(result);
			const edgeRow = MARKED.y + 20;
			const inner =
				out.mask[edgeRow * SCENE_W + MARKED.x + MARKED.w + grow - 1];
			const farther =
				out.mask[edgeRow * SCENE_W + MARKED.x + MARKED.w + grow + 4];
			expect(farther).toBe(0);
			expect(inner).toBeGreaterThan(0);
			expect(inner).toBeLessThan(1);
			// Full strength well inside.
			expect(out.mask[edgeRow * SCENE_W + MARKED.x + 20]).toBe(1);
		});

		it("calls a change that is mostly outside the marks a miss at 0.77 and not at 0.87", async () => {
			const miss = await run(changed(36));
			expect(miss.measures.insideMarksShare as number).toBeGreaterThan(0.7);
			expect(miss.measures.insideMarksShare as number).toBeLessThan(0.8);
			expect(miss.measures.miss).toBe("outside_marks");
			const hit = await run(changed(16));
			expect(hit.measures.insideMarksShare as number).toBeGreaterThan(0.85);
			expect(hit.measures.miss).toBeNull();
		});

		it("keeps an earlier change outside the marks when the fourth change goes back onto the anchor", async () => {
			const anchor = base;
			const earlier = copyOf(anchor);
			fillBox(earlier, RECTS[3].box, [20, 200, 200]);
			const result = copyOf(earlier);
			fillBox(result, MARKED, [250, 20, 200]);
			const out = await guardEdit({
				base: earlier,
				anchor,
				chainSinceAnchor: 3,
				result,
				marks,
			});
			expect(out.measures.reanchored).toBe(true);
			const at = (x: number, y: number) => (y * SCENE_W + x) * 4;
			const inEarlier = at(RECTS[3].box.x + 10, RECTS[3].box.y + 10);
			expect(
				Array.from(out.picture.data.subarray(inEarlier, inEarlier + 3)),
			).toEqual([20, 200, 200]);
			const inMarked = at(MARKED.x + 20, MARKED.y + 20);
			expect(
				Array.from(out.picture.data.subarray(inMarked, inMarked + 3)),
			).toEqual([250, 20, 200]);
		});

		it("treats a marked repaint over most of the frame as a miss and still changes nothing outside the marks", async () => {
			const result = copyOf(base);
			fillBox(
				result,
				{ x: 4, y: 4, w: SCENE_W - 8, h: SCENE_H - 8 },
				[20, 90, 200],
			);
			const out = await run(result);
			expect(out.measures.global).toBe(true);
			expect(out.measures.miss).toBe("outside_marks");
			const x1 = MARKED.x + MARKED.w + grow;
			const y1 = MARKED.y + MARKED.h + grow;
			for (let y = 0; y < SCENE_H; y++) {
				for (let x = 0; x < SCENE_W; x++) {
					if (x < x1 && x >= MARKED.x - grow && y < y1 && y >= MARKED.y - grow)
						continue;
					const o = (y * SCENE_W + x) * 4;
					for (let c = 0; c < 4; c++) {
						if (out.picture.data[o + c] !== base.data[o + c]) {
							throw new Error(`differs at ${x},${y}`);
						}
					}
				}
			}
			// Not kept whole: the chain goes on and the result is not the new anchor.
			expect(out.anchorIsResult).toBe(false);
			expect(out.chainSinceAnchor).toBe(1);
		});

		it("keeps the picture opaque where an alignment-exposed edge lies inside the marks", async () => {
			const edited = copyOf(base);
			fillBox(edited, RECTS[1].box, [250, 20, 200]);
			const out = await guardEdit({
				base,
				anchor: null,
				chainSinceAnchor: 0,
				result: warp(edited, 1, 2, -1),
				marks: [{ x: 0, y: 0, w: 1, h: 1 }],
			});
			let notOpaque = 0;
			for (let i = 3; i < out.picture.data.length; i += 4)
				if (out.picture.data[i] !== 255) notOpaque++;
			expect(notOpaque).toBe(0);
		});

		it("leaves an edit without marks unclamped", async () => {
			const out = await guardEdit({
				base,
				anchor: null,
				chainSinceAnchor: 0,
				result: changed(16),
				marks: null,
			});
			const o = (130 * SCENE_W + 66) * 4;
			expect(Array.from(out.picture.data.subarray(o, o + 3))).toEqual([
				10, 250, 250,
			]);
		});
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
			for (let x = 0; x < scene.px(40); x++)
				clear.data.fill(0, (y * SCENE_W + x) * 4, (y * SCENE_W + x) * 4 + 4);
		}
		const result = copyOf(clear);
		for (let y = 0; y < SCENE_H; y++)
			for (let x = 0; x < scene.px(40); x++)
				result.data[(y * SCENE_W + x) * 4 + 3] = 255;
		fillBox(result, RECTS[2].box, [250, 20, 200]);
		const out = await guardEdit({
			base: clear,
			anchor: null,
			chainSinceAnchor: 0,
			result,
			marks: null,
		});
		expect(out.picture.data[(scene.px(400) * SCENE_W + 2) * 4 + 3]).toBe(0);
	});

	it("never pastes a semi-transparent rim onto an opaque base (fractional scale)", async () => {
		const result = copyOf(base);
		fillBox(result, RECTS[1].box, [250, 20, 200]);
		// What a fractional rescale leaves: a half-transparent rim with colours off.
		for (let x = 0; x < SCENE_W; x++) {
			for (const y of [0, 1, SCENE_H - 1, SCENE_H - 2]) {
				const o = (y * SCENE_W + x) * 4;
				result.data[o] = 0;
				result.data[o + 1] = 0;
				result.data[o + 2] = 0;
				result.data[o + 3] = 120;
			}
		}
		const out = await guardEdit({
			base,
			anchor: null,
			chainSinceAnchor: 0,
			result,
			marks: null,
		});
		for (let i = 3; i < out.picture.data.length; i += 4)
			expect(out.picture.data[i]).toBe(255);
		for (const y of [0, 1, SCENE_H - 1, SCENE_H - 2]) {
			const o = (y * SCENE_W + 2) * 4;
			expect(Array.from(out.picture.data.subarray(o, o + 4))).toEqual(
				Array.from(base.data.subarray(o, o + 4)),
			);
		}
	});

	it("does not paste a translucent top onto an opaque cut-out base (pasteMinAlpha)", async () => {
		const cutout = copyOf(base);
		// A transparent-subject picture: the left third is cut away (alpha 0).
		for (let y = 0; y < SCENE_H; y++)
			for (let x = 0; x < scene.px(300); x++)
				cutout.data[(y * SCENE_W + x) * 4 + 3] = 0;
		const result = copyOf(cutout);
		const box = RECTS[1].box;
		fillBox(result, box, [250, 20, 200]);
		// Translucent top (alpha 100) over part of the opaque change: not pasted there.
		for (let y = box.y; y < box.y + scene.px(40); y++)
			for (let x = box.x; x < box.x + box.w; x++)
				result.data[(y * SCENE_W + x) * 4 + 3] = 100;
		const out = await guardEdit({
			base: cutout,
			anchor: null,
			chainSinceAnchor: 0,
			result,
			marks: null,
		});
		const at = (x: number, y: number) => (y * SCENE_W + x) * 4;
		const mid = Math.floor(box.x + box.w / 2);
		expect(out.picture.data[at(mid, box.y + 3) + 3]).toBe(255);
		expect(out.picture.data[at(mid, box.y + 3)]).toBe(
			cutout.data[at(mid, box.y + 3)],
		);
		expect(out.picture.data[at(mid, box.y + scene.px(100))]).toBe(250);
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

	it("leaves no transparent strip when the result was shifted, and measures only the box", async () => {
		const box = RECTS[1].box;
		const edited = copyOf(base);
		fillBox(edited, box, [250, 20, 200]);
		const result = warp(edited, 1, 2, -1);
		const out = await guardEdit({
			base,
			anchor: null,
			chainSinceAnchor: 0,
			result,
			marks: null,
		});
		let notOpaque = 0;
		for (let i = 3; i < out.picture.data.length; i += 4)
			if (out.picture.data[i] !== 255) notOpaque++;
		expect(notOpaque).toBe(0);
		const g = 0.04 * SCENE_H;
		const boxShare = ((box.w + 2 * g) * (box.h + 2 * g)) / (SCENE_W * SCENE_H);
		expect(out.measures.miss).toBeNull();
		expect(out.measures.changedShare).toBeLessThan(boxShare * 1.5);
	});

	describe("a result shifted against the base", () => {
		// What the live check found: the model moved the picture a pixel (or a
		// few), alignment undid it, and the strip it exposed was stored see-through.
		// Every path must store an opaque picture over an opaque base, the strip
		// taking the base's own pixels.
		const SEE_THROUGH = 250;
		const seeThrough = (picture: { data: Uint8Array }) => {
			let count = 0;
			for (let i = 3; i < picture.data.length; i += 4)
				if (picture.data[i] < SEE_THROUGH) count++;
			return count;
		};
		const recoloured = () => {
			const edited = copyOf(base);
			fillBox(edited, RECTS[1].box, [250, 20, 200]);
			return edited;
		};
		const repainted = () => {
			const edited = copyOf(base);
			fillBox(
				edited,
				{ x: 0, y: 0, w: SCENE_W, h: Math.round(SCENE_H * 0.7) },
				[30, 220, 90],
			);
			return edited;
		};
		const box = RECTS[1].box;
		const marked = [
			{
				x: box.x / SCENE_W,
				y: box.y / SCENE_H,
				w: box.w / SCENE_W,
				h: box.h / SCENE_H,
			},
		];
		const elsewhere = [
			{
				x: RECTS[3].box.x / SCENE_W,
				y: RECTS[3].box.y / SCENE_H,
				w: RECTS[3].box.w / SCENE_W,
				h: RECTS[3].box.h / SCENE_H,
			},
		];
		const anchor = (() => {
			const a = copyOf(base);
			fillBox(a, RECTS[4].box, [10, 10, 10]);
			return a;
		})();
		const paths = [
			{ name: "paste-back", edited: recoloured, marks: null, chain: 0 },
			{ name: "re-anchor", edited: recoloured, marks: null, chain: 3 },
			{ name: "whole repaint", edited: repainted, marks: null, chain: 0 },
			{ name: "marked edit", edited: recoloured, marks: marked, chain: 0 },
			{ name: "marked repaint", edited: repainted, marks: marked, chain: 0 },
			{ name: "marked re-anchor", edited: recoloured, marks: marked, chain: 3 },
			{
				name: "clear miss (outside the marks)",
				edited: recoloured,
				marks: elsewhere,
				chain: 0,
			},
			{
				name: "clear miss (nothing changed)",
				edited: () => copyOf(base),
				marks: null,
				chain: 0,
			},
		] as const;
		const shifts = [
			{ dx: 0, dy: -1 },
			{ dx: 0, dy: 1 },
			{ dx: -1, dy: 0 },
			{ dx: 0, dy: -5 },
			{ dx: 5, dy: 3 },
		];

		for (const path of paths) {
			for (const { dx, dy } of shifts) {
				it(`stores an opaque picture on the ${path.name} path for a ${dx},${dy} px shift`, async () => {
					const out = await guardEdit({
						base,
						anchor: path.chain > 0 ? anchor : null,
						chainSinceAnchor: path.chain,
						result: warp(path.edited(), 1, dx, dy),
						marks: path.marks,
					});
					// The shift was found and undone, so a strip was exposed.
					expect(Math.round(out.measures.dy)).toBe(dy);
					expect(Math.round(out.measures.dx)).toBe(dx);
					expect(seeThrough(out.picture)).toBe(0);
				});
			}
		}

		it("fills the exposed strip of a whole repaint with the base's own pixels", async () => {
			const out = await guardEdit({
				base,
				anchor: null,
				chainSinceAnchor: 0,
				result: warp(repainted(), 1, 0, -1),
				marks: null,
			});
			expect(out.measures.global).toBe(true);
			const row = SCENE_W * 4;
			expect(Array.from(out.picture.data.subarray(0, row))).toEqual(
				Array.from(base.data.subarray(0, row)),
			);
			// Below the strip the repaint is kept as the model made it.
			expect(Array.from(out.picture.data.subarray(row, row + 4))).toEqual([
				30, 220, 90, 255,
			]);
		});

		it("keeps a transparent base transparent where it is, and fills only where it is opaque", async () => {
			const clear = copyOf(base);
			const cut = scene.px(100);
			for (let y = 0; y < SCENE_H; y++)
				for (let x = 0; x < cut; x++) clear.data[(y * SCENE_W + x) * 4 + 3] = 0;
			const globals: boolean[] = [];
			for (const edited of [
				(() => {
					const e = copyOf(clear);
					fillBox(e, RECTS[1].box, [250, 20, 200]);
					return e;
				})(),
				(() => {
					const e = copyOf(clear);
					fillBox(
						e,
						{ x: cut, y: 0, w: SCENE_W - cut, h: Math.round(SCENE_H * 0.7) },
						[30, 220, 90],
					);
					return e;
				})(),
			]) {
				const out = await guardEdit({
					base: clear,
					anchor: null,
					chainSinceAnchor: 0,
					result: warp(edited, 1, 0, -1),
					marks: null,
				});
				expect(out.measures).toMatchObject({ dx: 0, dy: -1, scale: 1 });
				globals.push(out.measures.global);
				for (let y = 0; y < SCENE_H; y++) {
					for (let x = 0; x < SCENE_W; x++) {
						const a = out.picture.data[(y * SCENE_W + x) * 4 + 3];
						if (x < cut - 2) expect(a).toBe(0);
						else if (x > cut + 2 && a < SEE_THROUGH)
							throw new Error(`see-through at ${x},${y}: ${a}`);
					}
				}
			}
			// Both the paste-back and the whole-repaint path were taken.
			expect(globals).toEqual([false, true]);
		});
	});

	it("calls a shifted no-op nothing changed", async () => {
		const result = warp(base, 1, 2, -1);
		const out = await guardEdit({
			base,
			anchor: null,
			chainSinceAnchor: 0,
			result,
			marks: null,
		});
		expect(out.measures.miss).toBe("nothing_changed");
	});
});
