import { describe, expect, it } from "vitest";
import { compositeOnto } from "./composite";
import type { RawImage } from "./raw-image";

function flat(value: number): RawImage {
	return { data: new Uint8Array(4 * 4 * 4).fill(value), width: 4, height: 4 };
}

describe("compositeOnto", () => {
	it("keeps the base where the mask is 0, takes the top where it is 1, blends between", () => {
		const mask = new Float32Array(16);
		mask[1] = 1;
		mask[2] = 0.5;
		const out = compositeOnto(flat(10), flat(200), mask);
		expect(out.data[0]).toBe(10);
		expect(out.data[4]).toBe(200);
		expect(out.data[8]).toBe(105);
		expect(out.data[3 * 4]).toBe(10);
	});

	it("refuses mismatched sizes", () => {
		expect(() =>
			compositeOnto(
				flat(0),
				{ data: new Uint8Array(4), width: 1, height: 1 },
				new Float32Array(16),
			),
		).toThrow();
	});

	it("keeps an opaque base opaque where the top is semi-transparent", () => {
		const top = flat(200);
		top.data[3] = 100;
		const mask = new Float32Array(16).fill(1);
		const opaque = flat(10);
		for (let i = 3; i < opaque.data.length; i += 4) opaque.data[i] = 255;
		const out = compositeOnto(opaque, top, mask);
		expect(out.data[3]).toBe(255);
	});
});
