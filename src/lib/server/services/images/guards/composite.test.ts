import { describe, expect, it } from "vitest";
import { compositeOnto, overBase } from "./composite";
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

describe("overBase", () => {
	const pixel = (rgba: number[]): RawImage => ({
		data: new Uint8Array(rgba),
		width: 1,
		height: 1,
	});

	it("shows the base where the top is fully transparent (an exposed edge)", () => {
		const out = overBase(pixel([10, 20, 30, 255]), pixel([0, 0, 0, 0]));
		expect(Array.from(out.data)).toEqual([10, 20, 30, 255]);
	});

	it("keeps an opaque top as it is", () => {
		const out = overBase(pixel([10, 20, 30, 255]), pixel([200, 100, 50, 255]));
		expect(Array.from(out.data)).toEqual([200, 100, 50, 255]);
	});

	it("blends a translucent top over an opaque base into an opaque pixel", () => {
		const out = overBase(pixel([0, 0, 0, 255]), pixel([200, 100, 50, 51]));
		expect(Array.from(out.data)).toEqual([40, 20, 10, 255]);
	});

	it("never fills where the base itself is transparent", () => {
		expect(
			Array.from(overBase(pixel([9, 9, 9, 0]), pixel([0, 0, 0, 0])).data),
		).toEqual([0, 0, 0, 0]);
		expect(
			Array.from(overBase(pixel([9, 9, 9, 0]), pixel([5, 6, 7, 128])).data),
		).toEqual([5, 6, 7, 128]);
	});
});
