import { describe, expect, it } from "vitest";
import { CHAIN_EDITS, driftLine, SINGLE_EDITS, unionMasks } from "./drift";

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
