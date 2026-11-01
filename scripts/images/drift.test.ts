import { describe, expect, it } from "vitest";
import {
	boxesMask,
	CHAIN_EDITS,
	driftLine,
	growBox,
	SCENE_BOXES,
	SINGLE_EDITS,
	unionMasks,
} from "./drift";

describe("drift sequence", () => {
	it("runs the sofa sequence, then five chained changes", () => {
		expect(SINGLE_EDITS.map((e) => e.id)).toEqual([
			"recolour",
			"reupholster",
			"cushion",
			"move",
			"sofa-picture",
		]);
		expect(SINGLE_EDITS.find((e) => e.id === "sofa-picture")?.needsSofa).toBe(
			true,
		);
		expect(CHAIN_EDITS).toHaveLength(5);
		for (const e of [...SINGLE_EDITS, ...CHAIN_EDITS]) {
			expect(e.prompt).toMatch(/^[\x20-\x7e]+$/);
		}
	});
});

describe("unionMasks", () => {
	it("takes the largest value per pixel", () => {
		const out = unionMasks([
			new Float32Array([0, 0.5, 1]),
			new Float32Array([0.25, 0, 1]),
		]);
		expect(Array.from(out)).toEqual([0.25, 0.5, 1]);
	});
});

describe("driftLine", () => {
	it("has the shape the notes are written from", () => {
		const line = driftLine({
			scene: "room-0",
			edit: "recolour",
			mode: "raw",
			lpipsOutside: 0.0712,
			offsetPx: 1.25,
			changedShare: 0.08,
			miss: null,
			global: false,
			reanchored: false,
		});
		expect(JSON.parse(line)).toEqual({
			scene: "room-0",
			edit: "recolour",
			mode: "raw",
			lpips_outside: 0.0712,
			offset_px: 1.25,
			changed_share: 0.08,
			miss: null,
			global: false,
			reanchored: false,
		});
	});
});

describe("independent region", () => {
	it("grows a box by a share of its own size, inside the picture", () => {
		const grown = growBox({ x: 0.4, y: 0.4, w: 0.2, h: 0.1 }, 0.1);
		expect(grown.x).toBeCloseTo(0.38, 10);
		expect(grown.y).toBeCloseTo(0.39, 10);
		expect(grown.w).toBeCloseTo(0.24, 10);
		expect(grown.h).toBeCloseTo(0.12, 10);
		const edge = growBox({ x: 0, y: 0.9, w: 0.5, h: 0.1 }, 0.1);
		expect(edge.x).toBe(0);
		expect(edge.y + edge.h).toBeCloseTo(1, 10);
	});
	it("masks the union of the boxes", () => {
		const m = boxesMask(
			[
				{ x: 0, y: 0, w: 0.5, h: 0.5 },
				{ x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
			],
			4,
			4,
		);
		expect(Array.from(m)).toEqual([
			1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1,
		]);
	});
	it("has a box for every generated scene", () => {
		expect(Object.keys(SCENE_BOXES)).toEqual(["room-0", "room-1", "room-2"]);
	});
});
