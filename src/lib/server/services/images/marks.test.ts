// @vitest-environment node
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MARK_COLOURS } from "$lib/shared/artifacts/image-body";
import { marksLabel, paintMarks } from "./marks";

async function grey(width: number, height: number): Promise<Buffer> {
	return sharp({
		create: {
			width,
			height,
			channels: 3,
			background: { r: 120, g: 130, b: 140 },
		},
	})
		.png()
		.toBuffer();
}

async function raw(png: Uint8Array) {
	const { data, info } = await sharp(png)
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height };
}

function pixel(
	image: { data: Buffer; width: number },
	x: number,
	y: number,
): [number, number, number] {
	const at = (y * image.width + x) * 4;
	return [image.data[at], image.data[at + 1], image.data[at + 2]];
}

function hex(colour: string): [number, number, number] {
	return [
		Number.parseInt(colour.slice(1, 3), 16),
		Number.parseInt(colour.slice(3, 5), 16),
		Number.parseInt(colour.slice(5, 7), 16),
	];
}

describe("paintMarks", () => {
	it("draws box A's top edge in its colour, within 8 per channel", async () => {
		const input = await grey(800, 600);
		const out = await paintMarks(input, [
			{ letter: "A", x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
		]);
		const image = await raw(out);
		// The middle of the top edge: x at the box's middle, y inside the stroke.
		const [r, g, b] = pixel(image, 400, 150 + 2);
		const [er, eg, eb] = hex(MARK_COLOURS.A);
		expect(Math.abs(r - er)).toBeLessThanOrEqual(8);
		expect(Math.abs(g - eg)).toBeLessThanOrEqual(8);
		expect(Math.abs(b - eb)).toBeLessThanOrEqual(8);
	});

	it("leaves pixels well outside every box byte-equal to the input", async () => {
		const input = await grey(800, 600);
		const before = await raw(input);
		const out = await paintMarks(input, [
			{ letter: "A", x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
			{ letter: "B", x: 0.6, y: 0.6, w: 0.2, h: 0.2 },
		]);
		const after = await raw(out);
		expect(after.width).toBe(before.width);
		for (const [x, y] of [
			[5, 5],
			[790, 10],
			[10, 590],
			[100, 300],
			[790, 590],
		]) {
			expect(pixel(after, x, y)).toEqual(pixel(before, x, y));
		}
	});

	it("draws the letter as white strokes inside the tag", async () => {
		const input = await grey(400, 400);
		const out = await paintMarks(input, [
			{ letter: "H", x: 0.1, y: 0.1, w: 0.6, h: 0.6 },
		]);
		const image = await raw(out);
		let whites = 0;
		for (let y = 40; y < 40 + 28; y += 1) {
			for (let x = 40; x < 40 + 28; x += 1) {
				const [r, g, b] = pixel(image, x, y);
				if (r > 240 && g > 240 && b > 240) whites += 1;
			}
		}
		expect(whites).toBeGreaterThan(20);
	});

	it("draws every one of the eight letters", async () => {
		const input = await grey(1000, 1000);
		const letters = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
		const out = await paintMarks(
			input,
			letters.map((letter, index) => ({
				letter,
				x: (index % 4) * 0.25,
				y: Math.floor(index / 4) * 0.5,
				w: 0.2,
				h: 0.4,
			})),
		);
		const meta = await sharp(out).metadata();
		expect(meta.format).toBe("png");
		expect(meta.width).toBe(1000);
	});
});

describe("marksLabel", () => {
	it("names the base picture and each mark's colour", () => {
		expect(
			marksLabel(3, [
				{ letter: "A", x: 0, y: 0, w: 0.5, h: 0.5 },
				{ letter: "B", x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
			]),
		).toBe("Picture 3 with the user's marks: A = red box, B = blue box");
	});
});
