// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readHeifPixelCount } from "./heif-decode";

// The HEIC files are real ones, made on this Mac with `sips` (macOS 27,
// sips-316).
//
// `__fixtures__/tiny.heic` is 64x42, made with `sips -s format heic -Z 64` from
// a 96x64 PNG of four flat quadrants (its full recipe is in
// prepare-image.test.ts). It has one `ispe` box: 64x42.
//
// `__fixtures__/photo-grid.heic` is 4032x3024 (12 MP, 672 KB). It is a PNG of
// that size made by a short script and converted with
// `sips -s format heic -s formatOptions 50`: a colour ramp across the picture
// (red and green rising with x and y, blue falling), a 12x8 grid of cells each
// tinted a little differently, and triangular noise of up to 10 levels from a
// seeded xorshift32 generator (seed 0x2545f491), so the encoder has detail to
// code and the decode takes real time: about 270 to 300 ms with libheif-js on
// this Mac. `sips` writes it as a grid of 512x512 tiles, so it has two `ispe`
// boxes, 512x512 for a tile and 4032x3024 for the picture, in `meta` > `iprp` >
// `ipco`, with `meta` before `mdat`.
//
// `__fixtures__/transparent-page.heic` is 800x600 (9 KB): "Invoice" and
// "No. 4271" in bold black Helvetica on a fully transparent PNG (the text
// drawn by sharp from an SVG and composited on a transparent canvas), converted
// with `sips -s format heic`, which keeps the alpha plane. libheif gives the
// 439,248 transparent pixels as RGBA 0,0,0,0 and the letters opaque black. The
// stem of the "I" of "Invoice" covers x 70 to 91 and y 152 to 255. It has one
// `ispe` box: 800x600.
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
	new Uint8Array(readFileSync(path.join(here, "__fixtures__", name)));
const tinyHeic = fixture("tiny.heic");
const photoGrid = fixture("photo-grid.heic");
const transparentPage = fixture("transparent-page.heic");

// --- Files built from boxes, for the shapes no real photo has ---------------

type Form = "short" | "large" | "to-end";

const u32 = (value: number) => [
	(value >>> 24) & 255,
	(value >>> 16) & 255,
	(value >>> 8) & 255,
	value & 255,
];
const letters = (text: string) => [...text].map((c) => c.charCodeAt(0));
const concat = (...parts: Uint8Array[]) =>
	Uint8Array.from(parts.flatMap((part) => Array.from(part)));

/** A box: a 32-bit size, a 64-bit one after the type, or a size of 0 (to the end of what holds it). */
function box(
	type: string,
	payload: ArrayLike<number>,
	form: Form = "short",
): Uint8Array {
	const body = Array.from(payload);
	if (form === "large") {
		return Uint8Array.from([
			...u32(1),
			...letters(type),
			...u32(0),
			...u32(16 + body.length),
			...body,
		]);
	}
	if (form === "to-end") {
		return Uint8Array.from([...u32(0), ...letters(type), ...body]);
	}
	return Uint8Array.from([...u32(8 + body.length), ...letters(type), ...body]);
}
const fullBox = (type: string, payload: ArrayLike<number>, form?: Form) =>
	box(type, [0, 0, 0, 0, ...Array.from(payload)], form);
const ispe = (width: number, height: number, form?: Form) =>
	fullBox("ispe", [...u32(width), ...u32(height)], form);
const ftyp = () => box("ftyp", [...letters("heic"), 0, 0, 0, 0]);
const mdat = () => box("mdat", [1, 2, 3, 4]);

/** ftyp, then meta > iprp > ipco > `properties`, then picture data: the shape of a HEIF file. */
function heifOf(
	properties: Uint8Array[],
	forms: { meta?: Form; iprp?: Form; ipco?: Form } = {},
): Uint8Array {
	const ipco = box("ipco", concat(...properties), forms.ipco);
	const iprp = box("iprp", ipco, forms.iprp);
	return concat(ftyp(), fullBox("meta", iprp, forms.meta), mdat());
}

/** A copy of `bytes` placed inside a larger buffer, as a view that starts mid-buffer. */
function viewInsideLargerBuffer(bytes: Uint8Array): Uint8Array {
	const padded = new Uint8Array(bytes.length + 32);
	padded.set(bytes, 11);
	return padded.subarray(11, 11 + bytes.length);
}

function randomGenerator(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state / 0x100000000;
	};
}

describe("readHeifPixelCount", () => {
	it("reads the size of a photo from its file", () => {
		expect(readHeifPixelCount(tinyHeic)).toBe(64 * 42);
		expect(readHeifPixelCount(transparentPage)).toBe(800 * 600);
	});

	it("gives a grid photo its whole size, not its tiles'", () => {
		// 4032x3024 as tiles of 512x512: the file holds both sizes in `ispe` boxes.
		expect(readHeifPixelCount(photoGrid)).toBe(4032 * 3024);
		expect(readHeifPixelCount(photoGrid)).not.toBe(512 * 512);
	});

	it("reads a file that is a view into a larger buffer", () => {
		expect(readHeifPixelCount(viewInsideLargerBuffer(tinyHeic))).toBe(64 * 42);
	});

	it("takes the largest size whatever order the sizes come in", () => {
		const sizes: Array<[number, number]> = [
			[512, 512],
			[4032, 3024],
			[320, 240],
		];
		const forward = heifOf(sizes.map(([w, h]) => ispe(w, h)));
		const backward = heifOf([...sizes].reverse().map(([w, h]) => ispe(w, h)));

		expect(readHeifPixelCount(forward)).toBe(4032 * 3024);
		expect(readHeifPixelCount(backward)).toBe(4032 * 3024);
	});

	it("reads boxes whose size is a 64-bit number", () => {
		const file = heifOf([ispe(640, 480, "large")], {
			meta: "large",
			iprp: "large",
			ipco: "large",
		});

		expect(readHeifPixelCount(file)).toBe(640 * 480);
	});

	it("reads a last box whose size is 0, which runs to the end of the file", () => {
		const ipco = box("ipco", ispe(640, 480));
		const file = concat(
			ftyp(),
			fullBox("meta", box("iprp", ipco, "to-end"), "to-end"),
		);

		expect(readHeifPixelCount(file)).toBe(640 * 480);
	});

	it("finds meta after the picture data", () => {
		const file = heifOf([ispe(640, 480)]);
		const metaAndData = file.subarray(ftyp().length);
		const metaLength = metaAndData.length - mdat().length;
		const reordered = concat(
			ftyp(),
			mdat(),
			metaAndData.subarray(0, metaLength),
		);

		expect(readHeifPixelCount(reordered)).toBe(640 * 480);
	});

	it("passes over an image with no pixels", () => {
		expect(readHeifPixelCount(heifOf([ispe(0, 480), ispe(64, 42)]))).toBe(
			64 * 42,
		);
		expect(readHeifPixelCount(heifOf([ispe(0, 0)]))).toBeNull();
	});

	it("says its size even when the file is cut off inside its picture data", () => {
		const view = new DataView(tinyHeic.buffer, tinyHeic.byteOffset);
		const metaEnd = view.getUint32(0) + view.getUint32(view.getUint32(0));

		expect(readHeifPixelCount(tinyHeic.subarray(0, metaEnd))).toBe(64 * 42);
		expect(readHeifPixelCount(tinyHeic.subarray(0, metaEnd + 100))).toBe(
			64 * 42,
		);
	});

	describe("says null, and does not throw, for a file with no size", () => {
		it("when the buffer is empty", () => {
			expect(readHeifPixelCount(new Uint8Array(0))).toBeNull();
		});

		it("when the buffer is cut off anywhere before the end of meta", () => {
			const view = new DataView(tinyHeic.buffer, tinyHeic.byteOffset);
			const metaEnd = view.getUint32(0) + view.getUint32(view.getUint32(0));
			const readable: number[] = [];

			for (let cut = 0; cut < metaEnd; cut++) {
				if (readHeifPixelCount(tinyHeic.subarray(0, cut)) !== null) {
					readable.push(cut);
				}
			}

			expect(readable).toEqual([]);
		});

		it("when there is no meta", () => {
			expect(readHeifPixelCount(concat(ftyp(), mdat()))).toBeNull();
			expect(readHeifPixelCount(ftyp())).toBeNull();
		});

		it("when meta has no iprp, iprp no ipco, or ipco no ispe", () => {
			const noIprp = concat(ftyp(), fullBox("meta", box("free", [1, 2])));
			const noIpco = concat(
				ftyp(),
				fullBox("meta", box("iprp", box("ipma", [1, 2]))),
			);
			const noIspe = heifOf([box("pixi", [1, 2, 3])]);

			expect(readHeifPixelCount(noIprp)).toBeNull();
			expect(readHeifPixelCount(noIpco)).toBeNull();
			expect(readHeifPixelCount(noIspe)).toBeNull();
		});

		it("when a box's size runs past the buffer", () => {
			const longMeta = Uint8Array.from(tinyHeic);
			new DataView(longMeta.buffer).setUint32(36, 10_000); // meta's size
			const longData = concat(ftyp(), Uint8Array.from(mdat()));
			new DataView(longData.buffer).setUint32(ftyp().length, 10_000); // mdat's

			expect(readHeifPixelCount(longMeta)).toBeNull();
			expect(readHeifPixelCount(longData)).toBeNull();
		});

		it("when a box is smaller than its own header", () => {
			for (const size of [2, 4, 7]) {
				const file = Uint8Array.from(heifOf([ispe(640, 480)]));
				new DataView(file.buffer).setUint32(ftyp().length, size); // meta's size
				expect(readHeifPixelCount(file)).toBeNull();
			}
		});

		it("when a 64-bit size is more than any buffer holds", () => {
			const file = concat(
				ftyp(),
				Uint8Array.from([...u32(1), ...letters("meta"), ...u32(1), ...u32(0)]),
			);

			expect(readHeifPixelCount(file)).toBeNull();
		});

		it("when a box of size 0 before meta takes the rest of the file with it", () => {
			const file = concat(
				ftyp(),
				box("free", [], "to-end"),
				fullBox("meta", box("iprp", box("ipco", ispe(640, 480)))),
			);

			expect(readHeifPixelCount(file)).toBeNull();
		});

		it("when an ispe is too short to hold a size", () => {
			expect(
				readHeifPixelCount(heifOf([fullBox("ispe", [0, 0, 2, 128])])),
			).toBeNull();
		});

		it("when the properties end in a box that is cut short", () => {
			const damaged = heifOf([ispe(640, 480), Uint8Array.from([0, 0, 0])]);

			expect(readHeifPixelCount(damaged)).toBeNull();
		});
	});

	it("never throws and never reads past the buffer, whatever is wrong with the file", () => {
		const random = randomGenerator(0x2545f491);
		const originals = [
			tinyHeic,
			photoGrid.subarray(0, 3000),
			transparentPage.subarray(0, 800),
		];
		const failures: string[] = [];

		for (let round = 0; round < 3000; round++) {
			const original = originals[round % originals.length];
			const damaged = Uint8Array.from(
				original.subarray(0, 1 + Math.floor(random() * original.length)),
			);
			for (let hit = 0; hit < 1 + Math.floor(random() * 6); hit++) {
				damaged[Math.floor(random() * damaged.length)] = Math.floor(
					random() * 256,
				);
			}
			try {
				const count = readHeifPixelCount(damaged);
				if (count !== null && !(Number.isFinite(count) && count > 0)) {
					failures.push(`round ${round}: ${count}`);
				}
			} catch (error) {
				failures.push(`round ${round}: threw ${String(error)}`);
			}
		}
		for (const length of [1, 7, 8, 9, 16, 100]) {
			const garbage = Uint8Array.from({ length }, () =>
				Math.floor(random() * 256),
			);
			expect(() => readHeifPixelCount(garbage)).not.toThrow();
		}

		expect(failures).toEqual([]);
	});
});
