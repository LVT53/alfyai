// @vitest-environment node
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Worker } from "node:worker_threads";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	decodeHeifToRgba,
	HEIF_MAX_BOXES_READ,
	HEIF_MAX_PIXELS,
	readDecoderAnswer,
	readHeifPixelCount,
} from "./heif-decode";
import { ImagePreparationError, ImageTooLargeError } from "./image-errors";

// Every worker the process's decode pool starts, so a test can say that none
// started, or how many, or wait for one to exit.
type Recorded = Worker & { readonly exited: Promise<number> };
const spawned = vi.hoisted(() => ({ workers: [] as unknown[] }));
const startedWorkers = () => spawned.workers as Recorded[];

vi.mock("node:worker_threads", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:worker_threads")>();
	class RecordingWorker extends actual.Worker {
		readonly exited: Promise<number>;
		constructor(...args: ConstructorParameters<typeof actual.Worker>) {
			super(...args);
			this.exited = new Promise((resolve) => this.once("exit", resolve));
			spawned.workers.push(this);
		}
	}
	return { ...actual, Worker: RecordingWorker };
});

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

beforeEach(async () => {
	// The pool is the process's, so a place a test left is still taken until its
	// thread has exited.
	await Promise.all(startedWorkers().map((worker) => worker.exited));
	spawned.workers.length = 0;
});

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

/** `count` empty boxes of 8 bytes, which a reader can only pass over, made as one run of bytes. */
function emptyBoxes(count: number): Uint8Array {
	const run = new Uint8Array(count * 8);
	const view = new DataView(run.buffer);
	for (let at = 0; at < run.length; at += 8) {
		view.setUint32(at, 8);
		run.set(letters("free"), at + 4);
	}
	return run;
}

/** ftyp, then meta > iprp > ipco > `properties`, then picture data: the shape of a HEIF file. */
function heifOf(
	properties: Uint8Array[],
	forms: { meta?: Form; iprp?: Form; ipco?: Form } = {},
): Uint8Array {
	const ipco = box("ipco", concat(...properties), forms.ipco);
	const iprp = box("iprp", ipco, forms.iprp);
	return concat(ftyp(), fullBox("meta", iprp, forms.meta), mdat());
}

/** A copy of a real file with the size its first `ispe` gives changed. */
function withIspe(
	bytes: Uint8Array,
	width: number,
	height: number,
): Uint8Array {
	const patched = Uint8Array.from(bytes);
	const at = Buffer.from(patched).indexOf("ispe");
	const view = new DataView(patched.buffer);
	view.setUint32(at + 8, width); // after "ispe" and its version and flags
	view.setUint32(at + 12, height);
	return patched;
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

/**
 * What a promise rejected with. One that resolves fails the test without
 * printing what it resolved to: a decoded photo is megabytes of pixels, and
 * an assertion that prints them takes the test process's memory with it.
 */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject, but it resolved");
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

	// An upload is not trusted to be small: 100 MB holds 12 million empty boxes of 8
	// bytes, and what reading it costs has to come from a limit and not from the
	// file. The limit is one for the whole walk, so these files each hold a valid
	// `ispe` and a run of empty boxes in one of the places the reader walks.
	describe("a file with a great many boxes", () => {
		const SIZE = 640 * 480;
		const properties = () => box("ipco", ispe(640, 480));
		const places: Array<[string, (many: Uint8Array) => Uint8Array]> = [
			[
				"the top level, before meta",
				(many) =>
					concat(
						ftyp(),
						many,
						fullBox("meta", box("iprp", properties())),
						mdat(),
					),
			],
			[
				"meta, before iprp",
				(many) =>
					concat(
						ftyp(),
						fullBox("meta", concat(many, box("iprp", properties()))),
						mdat(),
					),
			],
			[
				"iprp, before ipco",
				(many) =>
					concat(
						ftyp(),
						fullBox("meta", box("iprp", concat(many, properties()))),
						mdat(),
					),
			],
			[
				"iprp, after ipco",
				(many) =>
					concat(
						ftyp(),
						fullBox("meta", box("iprp", concat(properties(), many))),
						mdat(),
					),
			],
			["ipco, around the ispe", (many) => heifOf([many, ispe(640, 480)])],
		];

		it.each(
			places,
		)("reads the size when %s holds a good many", (_place, fileWith) => {
			expect(
				readHeifPixelCount(fileWith(emptyBoxes(HEIF_MAX_BOXES_READ / 2))),
			).toBe(SIZE);
		});

		it.each(
			places,
		)("says nothing of its size when %s holds more than may be read", (_place, fileWith) => {
			expect(
				readHeifPixelCount(fileWith(emptyBoxes(HEIF_MAX_BOXES_READ))),
			).toBeNull();
		});

		it("counts the boxes of every run against one limit, not one limit for each", () => {
			const most = emptyBoxes(HEIF_MAX_BOXES_READ * 0.6);
			const inBoth = concat(
				ftyp(),
				fullBox(
					"meta",
					box("iprp", concat(most, box("ipco", concat(most, ispe(640, 480))))),
				),
				mdat(),
			);
			const inIprpOnly = concat(
				ftyp(),
				fullBox("meta", box("iprp", concat(most, properties()))),
				mdat(),
			);

			// Each run alone is under the limit, which the file with one of them shows.
			expect(readHeifPixelCount(inIprpOnly)).toBe(SIZE);
			expect(readHeifPixelCount(inBoth)).toBeNull();
		});

		it("reads up to exactly the limit, and not a box past it", () => {
			// ftyp, meta, iprp and ipco are looked at on the way to the properties, and
			// each of those counts as a box.
			const onTheWay = 4;
			const room = HEIF_MAX_BOXES_READ - onTheWay;

			expect(
				readHeifPixelCount(heifOf([ispe(640, 480), emptyBoxes(room - 1)])),
			).toBe(SIZE);
			expect(
				readHeifPixelCount(heifOf([ispe(640, 480), emptyBoxes(room)])),
			).toBeNull();
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

describe("readDecoderAnswer", () => {
	const pixels = (width: number, height: number) =>
		new ArrayBuffer(width * height * 4);

	it("takes a good answer as pixels, without copying them", () => {
		const data = pixels(3, 2);

		const out = readDecoderAnswer({ ok: true, width: 3, height: 2, data });

		expect([out.width, out.height]).toEqual([3, 2]);
		expect(out.data).toBeInstanceOf(Uint8Array);
		expect(out.data.buffer).toBe(data);
		expect(out.data.byteLength).toBe(24);
	});

	it("turns a failed decode into an ImagePreparationError that says why", () => {
		const error = (() => {
			try {
				return readDecoderAnswer({ ok: false, message: "libheif said no" });
			} catch (caught) {
				return caught;
			}
		})();

		expect(error).toBeInstanceOf(ImagePreparationError);
		expect(error).not.toBeInstanceOf(ImageTooLargeError);
		expect((error as Error).message).toContain("libheif said no");
	});

	it.each([
		["nothing", undefined],
		["a string", "pixels"],
		["an object with no verdict", { width: 3, height: 2 }],
	])("refuses %s as an answer", (_name, answer) => {
		expect(() => readDecoderAnswer(answer)).toThrow(ImagePreparationError);
	});

	it.each([
		["no width", { height: 2 }],
		["a width of 0", { width: 0, height: 2 }],
		["a fractional width", { width: 2.5, height: 2 }],
		["a width that is not a number", { width: "3", height: 2 }],
		["an infinite height", { width: 3, height: Number.POSITIVE_INFINITY }],
	])("refuses an answer with %s", (_name, size) => {
		expect(() =>
			readDecoderAnswer({ ok: true, ...size, data: pixels(3, 2) }),
		).toThrow(ImagePreparationError);
	});

	it("refuses a picture over the pixel limit, as too large", () => {
		const error = (() => {
			try {
				return readDecoderAnswer({
					ok: true,
					width: 10_001,
					height: 10_000,
					data: pixels(2, 2),
				});
			} catch (caught) {
				return caught;
			}
		})();

		expect(error).toBeInstanceOf(ImageTooLargeError);
		expect(error).toMatchObject({
			pixels: 100_010_000,
			limit: HEIF_MAX_PIXELS,
		});
	});

	it.each([
		["pixels that are not an ArrayBuffer", new Uint8Array(24)],
		["pixels of the wrong length", new ArrayBuffer(23)],
		["no pixels", undefined],
	])("refuses an answer with %s", (_name, data) => {
		expect(() =>
			readDecoderAnswer({ ok: true, width: 3, height: 2, data }),
		).toThrow(ImagePreparationError);
	});
});

describe("decodeHeifToRgba", () => {
	const pixelAt = (
		out: { width: number; data: Uint8Array },
		x: number,
		y: number,
	) => Array.from(out.data.subarray((y * out.width + x) * 4).subarray(0, 4));

	it("decodes a photo to RGBA, upright, in a worker", async () => {
		const out = await decodeHeifToRgba(tinyHeic);

		expect([out.width, out.height]).toEqual([64, 42]);
		expect(out.data.byteLength).toBe(64 * 42 * 4);
		// Four flat quadrants: red, green, blue and yellow, and no transparency.
		const [red, green, blue, yellow] = [
			pixelAt(out, 8, 5),
			pixelAt(out, 56, 5),
			pixelAt(out, 8, 36),
			pixelAt(out, 56, 36),
		];
		expect(red[0]).toBeGreaterThan(200);
		expect(red[1]).toBeLessThan(60);
		expect(green[1]).toBeGreaterThan(200);
		expect(green[0]).toBeLessThan(60);
		expect(blue[2]).toBeGreaterThan(200);
		expect(blue[0]).toBeLessThan(60);
		expect(Math.min(yellow[0], yellow[1])).toBeGreaterThan(200);
		expect(yellow[2]).toBeLessThan(60);
		expect([red[3], green[3], blue[3], yellow[3]]).toEqual([
			255, 255, 255, 255,
		]);
		expect(startedWorkers()).toHaveLength(1);
	});

	it("gives its pixels in memory of their own, exactly as long as they are", async () => {
		const out = await decodeHeifToRgba(tinyHeic);

		expect(out.data.byteOffset).toBe(0);
		expect(out.data.buffer.byteLength).toBe(out.data.byteLength);
	});

	it("keeps a transparent photo's transparency", async () => {
		const out = await decodeHeifToRgba(transparentPage);

		expect([out.width, out.height]).toEqual([800, 600]);
		expect(pixelAt(out, 0, 0)).toEqual([0, 0, 0, 0]);
		expect(pixelAt(out, 80, 200)).toEqual([0, 0, 0, 255]);
	});

	it("decodes a big grid photo whole", async () => {
		const out = await decodeHeifToRgba(photoGrid);

		expect([out.width, out.height]).toEqual([4032, 3024]);
		expect(out.data.byteLength).toBe(4032 * 3024 * 4);
	});

	it("leaves the caller's bytes as they were, whatever they are held in", async () => {
		const asBuffer = readFileSync(path.join(here, "__fixtures__", "tiny.heic"));
		const before = Buffer.from(asBuffer);
		const view = viewInsideLargerBuffer(tinyHeic);

		const [fromBuffer, fromView] = await Promise.all([
			decodeHeifToRgba(asBuffer),
			decodeHeifToRgba(view),
		]);

		expect([fromBuffer.width, fromBuffer.height]).toEqual([64, 42]);
		expect([fromView.width, fromView.height]).toEqual([64, 42]);
		// A moved buffer would read as empty.
		expect(asBuffer.byteLength).toBe(before.byteLength);
		expect(Buffer.compare(asBuffer, before)).toBe(0);
		expect(view.byteLength).toBe(tinyHeic.byteLength);
		expect(Buffer.compare(view, tinyHeic)).toBe(0);
	});

	it("refuses a photo over the pixel limit before any worker starts", async () => {
		const tooBig = withIspe(tinyHeic, 10_001, 10_000);

		const error = await decodeHeifToRgba(tooBig).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(ImageTooLargeError);
		expect(error).toBeInstanceOf(ImagePreparationError);
		expect(error).toMatchObject({
			pixels: 100_010_000,
			limit: HEIF_MAX_PIXELS,
		});
		expect(startedWorkers()).toHaveLength(0);
	});

	it("takes a photo of exactly the limit through the size check", () => {
		expect(readHeifPixelCount(withIspe(tinyHeic, 10_000, 10_000))).toBe(
			HEIF_MAX_PIXELS,
		);
	});

	it("refuses a file that says nothing of its size, with no worker", async () => {
		const error = await decodeHeifToRgba(new Uint8Array([1, 2, 3])).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(ImagePreparationError);
		expect(error).not.toBeInstanceOf(ImageTooLargeError);
		expect(startedWorkers()).toHaveLength(0);
	});

	it("refuses an aborted signal with its reason, before anything starts", async () => {
		await expect(
			decodeHeifToRgba(tinyHeic, { signal: AbortSignal.abort("not wanted") }),
		).rejects.toBe("not wanted");
		expect(startedWorkers()).toHaveLength(0);
	});

	it("stops a decode that is running when its signal is aborted", async () => {
		const controller = new AbortController();
		const decoding = decodeHeifToRgba(photoGrid, { signal: controller.signal });
		const worker = startedWorkers()[0];
		await once(worker, "online");
		const reason = new Error("cancelled");

		controller.abort(reason);

		expect(await rejection(decoding)).toBe(reason);
		// Its thread is stopped, not left to finish a photo nobody wants.
		await worker.exited;
	});

	it("fails a photo libheif cannot read as an ImagePreparationError, and decodes the next", async () => {
		// The size is intact (it is read before the decode), the picture data is not.
		const damaged = Uint8Array.from(tinyHeic);
		damaged.fill(0xa5, damaged.length - 200);

		const error = await decodeHeifToRgba(damaged).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(ImagePreparationError);
		expect(error).not.toBeInstanceOf(ImageTooLargeError);
		const next = await decodeHeifToRgba(tinyHeic);
		expect([next.width, next.height]).toEqual([64, 42]);
	});

	it("decodes at most two photos at once for the whole process", async () => {
		const decodes = [photoGrid, photoGrid, photoGrid].map((photo) =>
			decodeHeifToRgba(photo),
		);

		// The third waits for a place, with no worker of its own yet.
		expect(startedWorkers()).toHaveLength(2);
		const done = await Promise.all(decodes);

		expect(done.map((out) => out.width)).toEqual([4032, 4032, 4032]);
		expect(startedWorkers()).toHaveLength(3);
	});
});
