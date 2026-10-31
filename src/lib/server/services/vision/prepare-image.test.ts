import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { FILE_TYPE_ENTRIES } from "$lib/shared/file-types";
import { isSeeableImage } from "$lib/shared/file-types/seeable-image";
import {
	ATTACHMENT_MAX_LONG_EDGE,
	decodeImageToPng,
	estimateImageTokens,
	ImagePreparationError,
	type PreparedImage,
	prepareImageForModel,
	THUMBNAIL_MAX_LONG_EDGE,
} from "./prepare-image";

// `__fixtures__/tiny.heic` is 64x42, made on a Mac with
// `sips -s format heic -Z 64` from a 96x64 PNG of four flat quadrants: red top
// left, green top right, blue bottom left, yellow bottom right. Its brand is
// `ftypheic`, so it can be found by its bytes as well as by its MIME type.
const here = path.dirname(fileURLToPath(import.meta.url));
const tinyHeic = new Uint8Array(
	readFileSync(path.join(here, "__fixtures__", "tiny.heic")),
);

function solidJpeg(width: number, height: number): Promise<Buffer> {
	return sharp({
		create: { width, height, channels: 3, background: "#888888" },
	})
		.jpeg()
		.toBuffer();
}

/** What the model would be sent, decoded again. */
function sentBytes(image: PreparedImage): Buffer {
	return Buffer.from(image.base64, "base64");
}

async function pixelAt(
	bytes: Uint8Array,
	x: number,
	y: number,
): Promise<number[]> {
	const { data, info } = await sharp(bytes)
		.raw()
		.toBuffer({ resolveWithObject: true });
	const offset = (y * info.width + x) * info.channels;
	return Array.from(data.subarray(offset, offset + info.channels));
}

/** A copy of `bytes` placed inside a larger buffer, as a view that starts mid-buffer. */
function viewInsideLargerBuffer(bytes: Uint8Array): Uint8Array {
	const padded = new Uint8Array(bytes.length + 32);
	padded.set(bytes, 11);
	return padded.subarray(11, 11 + bytes.length);
}

describe("prepareImageForModel", () => {
	it("shrinks a large photo to the long-edge budget", async () => {
		const big = await sharp({
			create: { width: 4032, height: 3024, channels: 3, background: "#888" },
		})
			.jpeg()
			.toBuffer();
		const out = await prepareImageForModel(big, "image/jpeg", {
			maxLongEdge: ATTACHMENT_MAX_LONG_EDGE,
		});
		expect(Math.max(out.width, out.height)).toBe(1600);
		expect(out.mediaType).toBe("image/jpeg");
	});

	it("sends bytes that are a JPEG of the size and cost it reports", async () => {
		const out = await prepareImageForModel(
			await solidJpeg(4032, 3024),
			"image/jpeg",
			{ maxLongEdge: ATTACHMENT_MAX_LONG_EDGE },
		);
		const sent = await sharp(sentBytes(out)).metadata();
		expect([sent.format, sent.width, sent.height]).toEqual([
			"jpeg",
			1600,
			1200,
		]);
		expect([out.width, out.height]).toEqual([1600, 1200]);
		expect(out.estimatedTokens).toBe(estimateImageTokens(1600, 1200));
		expect(out.estimatedTokens).toBe(1900);
	});

	it.each([
		{
			name: "a landscape photo",
			from: [4032, 3024],
			edge: 1600,
			to: [1600, 1200],
		},
		{
			name: "a portrait photo",
			from: [3024, 4032],
			edge: 1600,
			to: [1200, 1600],
		},
		{
			name: "a photo for the thumbnail budget",
			from: [4032, 3024],
			edge: THUMBNAIL_MAX_LONG_EDGE,
			to: [512, 384],
		},
		{
			name: "an image exactly at the budget",
			from: [1600, 1000],
			edge: 1600,
			to: [1600, 1000],
		},
		{
			name: "an image under the budget",
			from: [800, 600],
			edge: 1600,
			to: [800, 600],
		},
	])("keeps the shape of $name inside the budget", async ({
		from,
		edge,
		to,
	}) => {
		const out = await prepareImageForModel(
			await solidJpeg(from[0], from[1]),
			"image/jpeg",
			{ maxLongEdge: edge },
		);
		expect([out.width, out.height]).toEqual(to);
	});

	it("applies EXIF orientation", async () => {
		const rotated = await sharp({
			create: { width: 300, height: 200, channels: 3, background: "#888" },
		})
			.jpeg()
			.withMetadata({ orientation: 6 })
			.toBuffer();
		const out = await prepareImageForModel(rotated, "image/jpeg", {
			maxLongEdge: 1600,
		});
		expect([out.width, out.height]).toEqual([200, 300]);
	});

	it("does not leave the orientation tag on pixels it has already turned", async () => {
		const rotated = await sharp({
			create: { width: 300, height: 200, channels: 3, background: "#888" },
		})
			.jpeg()
			.withMetadata({ orientation: 6 })
			.toBuffer();
		expect((await sharp(rotated).metadata()).orientation).toBe(6);
		const out = await prepareImageForModel(rotated, "image/jpeg", {
			maxLongEdge: 1600,
		});
		expect(
			(await sharp(sentBytes(out)).metadata()).orientation,
		).toBeUndefined();
	});

	it("flattens transparency", async () => {
		const withAlpha = await sharp({
			create: {
				width: 40,
				height: 30,
				channels: 4,
				background: { r: 255, g: 0, b: 0, alpha: 0 },
			},
		})
			.png()
			.toBuffer();
		expect((await sharp(withAlpha).metadata()).channels).toBe(4);
		const out = await prepareImageForModel(withAlpha, "image/png", {
			maxLongEdge: 1600,
		});
		const sent = await sharp(sentBytes(out)).metadata();
		expect(sent.format).toBe("jpeg");
		expect(sent.channels).toBe(3);
		expect(sent.hasAlpha).toBe(false);
	});

	it("flattens onto white, not black", async () => {
		const clear = await sharp({
			create: {
				width: 40,
				height: 30,
				channels: 4,
				background: { r: 0, g: 0, b: 0, alpha: 0 },
			},
		})
			.png()
			.toBuffer();
		const out = await prepareImageForModel(clear, "image/png", {
			maxLongEdge: 1600,
		});
		const [r, g, b] = await pixelAt(sentBytes(out), 20, 15);
		expect(Math.min(r, g, b)).toBeGreaterThan(240);
	});

	it("keeps only the first frame of an animated GIF", async () => {
		const frameWidth = 20;
		const frameHeight = 10;
		const red = Buffer.alloc(frameWidth * frameHeight * 3);
		const blue = Buffer.alloc(frameWidth * frameHeight * 3);
		for (let i = 0; i < red.length; i += 3) {
			red[i] = 255;
			blue[i + 2] = 255;
		}
		const gif = await sharp(Buffer.concat([red, blue]), {
			raw: {
				width: frameWidth,
				height: frameHeight * 2,
				channels: 3,
				pageHeight: frameHeight,
			},
		})
			.gif({ delay: [100, 100], loop: 0 })
			.toBuffer();
		expect((await sharp(gif).metadata()).pages).toBe(2);

		const out = await prepareImageForModel(gif, "image/gif", {
			maxLongEdge: 1600,
		});

		expect([out.width, out.height]).toEqual([frameWidth, frameHeight]);
		const sent = await sharp(sentBytes(out)).metadata();
		expect(sent.pages ?? 1).toBe(1);
		const [r, , b] = await pixelAt(sentBytes(out), 5, 5);
		expect(r).toBeGreaterThan(200);
		expect(b).toBeLessThan(60);
	});

	it("never enlarges a small image", async () => {
		const onePixel = await sharp({
			create: {
				width: 1,
				height: 1,
				channels: 4,
				background: { r: 10, g: 20, b: 30, alpha: 1 },
			},
		})
			.png()
			.toBuffer();
		const out = await prepareImageForModel(onePixel, "image/png", {
			maxLongEdge: 1600,
		});
		expect([out.width, out.height]).toEqual([1, 1]);
	});

	it("decodes bytes handed over as a plain Uint8Array or as a view into a larger buffer", async () => {
		const png = await sharp({
			create: { width: 30, height: 20, channels: 3, background: "#123456" },
		})
			.png()
			.toBuffer();
		for (const input of [new Uint8Array(png), viewInsideLargerBuffer(png)]) {
			const out = await prepareImageForModel(input, "image/png", {
				maxLongEdge: 1600,
			});
			expect([out.width, out.height]).toEqual([30, 20]);
		}
	});

	it.each([
		"jpeg",
		"png",
		"gif",
		"webp",
		"tiff",
	] as const)("reads a %s", async (format) => {
		const bytes = await sharp({
			create: { width: 48, height: 32, channels: 3, background: "#336699" },
		})
			.toFormat(format)
			.toBuffer();
		const out = await prepareImageForModel(bytes, null, { maxLongEdge: 1600 });
		expect([out.width, out.height]).toEqual([48, 32]);
	});

	it("turns a CMYK JPEG into sRGB", async () => {
		const cmyk = await sharp({
			create: { width: 40, height: 40, channels: 3, background: "#33aa55" },
		})
			.toColourspace("cmyk")
			.jpeg()
			.toBuffer();
		expect((await sharp(cmyk).metadata()).space).toBe("cmyk");
		const out = await prepareImageForModel(cmyk, "image/jpeg", {
			maxLongEdge: 1600,
		});
		const sent = await sharp(sentBytes(out)).metadata();
		expect([sent.space, sent.channels]).toEqual(["srgb", 3]);
	});

	describe("HEIC", () => {
		it("decodes HEIC", async () => {
			const out = await prepareImageForModel(tinyHeic, "image/heic", {
				maxLongEdge: 1600,
			});
			expect(out.width).toBeGreaterThan(0);
			expect(out.mediaType).toBe("image/jpeg");
			expect((await sharp(sentBytes(out)).metadata()).format).toBe("jpeg");
		});

		it("keeps the picture upright and its colours", async () => {
			const out = await prepareImageForModel(tinyHeic, "image/heic", {
				maxLongEdge: 1600,
			});
			expect([out.width, out.height]).toEqual([64, 42]);
			const sent = sentBytes(out);
			const [topLeft, topRight, bottomLeft, bottomRight] = await Promise.all([
				pixelAt(sent, 8, 5),
				pixelAt(sent, 56, 5),
				pixelAt(sent, 8, 36),
				pixelAt(sent, 56, 36),
			]);
			expect(topLeft[0]).toBeGreaterThan(200); // red
			expect(topLeft[1]).toBeLessThan(60);
			expect(topRight[1]).toBeGreaterThan(200); // green
			expect(topRight[0]).toBeLessThan(60);
			expect(bottomLeft[2]).toBeGreaterThan(200); // blue
			expect(bottomLeft[0]).toBeLessThan(60);
			expect(Math.min(bottomRight[0], bottomRight[1])).toBeGreaterThan(200); // yellow
			expect(bottomRight[2]).toBeLessThan(60);
		});

		it.each([
			{ declared: "image/heic" },
			{ declared: "image/heif" },
			{ declared: "image/heic; charset=binary" },
			{ declared: null },
			{ declared: "application/octet-stream" },
			{ declared: "image/jpeg" },
		])("finds HEIC by its type or by its bytes when the type is $declared", async ({
			declared,
		}) => {
			const out = await prepareImageForModel(tinyHeic, declared, {
				maxLongEdge: 1600,
			});
			expect([out.width, out.height]).toEqual([64, 42]);
		});

		it("trusts the declared type when the brand is not one it looks for", async () => {
			// Same file with its major brand changed from `heic` to `hevc`, which
			// libheif reads but the brand check does not list: only the type is left.
			const otherBrand = Uint8Array.from(tinyHeic);
			otherBrand.set(
				[..."hevc"].map((letter) => letter.charCodeAt(0)),
				8,
			);
			const out = await prepareImageForModel(otherBrand, "image/heic", {
				maxLongEdge: 1600,
			});
			expect([out.width, out.height]).toEqual([64, 42]);
		});

		it("shrinks a HEIC to the budget like any other image", async () => {
			const out = await prepareImageForModel(tinyHeic, "image/heic", {
				maxLongEdge: 32,
			});
			expect([out.width, out.height]).toEqual([32, 21]);
			expect(out.estimatedTokens).toBe(1);
		});

		it("decodes a HEIC handed over as a view into a larger buffer", async () => {
			const out = await prepareImageForModel(
				viewInsideLargerBuffer(tinyHeic),
				"image/heic",
				{ maxLongEdge: 1600 },
			);
			expect([out.width, out.height]).toEqual([64, 42]);
		});
	});

	describe("bad input", () => {
		it("rejects bytes that are not an image", async () => {
			await expect(
				prepareImageForModel(new Uint8Array([1, 2, 3]), "image/png", {
					maxLongEdge: 1600,
				}),
			).rejects.toBeInstanceOf(ImagePreparationError);
		});

		it("rejects an empty input", async () => {
			await expect(
				prepareImageForModel(new Uint8Array(0), "image/jpeg", {
					maxLongEdge: 1600,
				}),
			).rejects.toBeInstanceOf(ImagePreparationError);
		});

		it("rejects bytes that are labelled HEIC but are not", async () => {
			await expect(
				prepareImageForModel(new Uint8Array([1, 2, 3]), "image/heic", {
					maxLongEdge: 1600,
				}),
			).rejects.toBeInstanceOf(ImagePreparationError);
		});

		it("names itself and keeps the library's error as the cause", async () => {
			const error = await prepareImageForModel(
				new Uint8Array([1, 2, 3]),
				null,
				{ maxLongEdge: 1600 },
			).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(ImagePreparationError);
			expect((error as ImagePreparationError).name).toBe(
				"ImagePreparationError",
			);
			expect((error as ImagePreparationError).cause).toBeInstanceOf(Error);
		});
	});
});

// `isSeeableImage` (the registry ids this module decodes) is a list somebody
// keeps by hand. This is what keeps it honest: every registry image is
// accounted for, a seeable one is really prepared from real bytes, and the two
// images that are not seeable say why.
describe("the formats an attachment can be sent as", () => {
	/** A valid 2x2, 24-bit BMP: a header, then four bottom-up pixels. */
	function tinyBmp(): Uint8Array {
		const row = [0xff, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0x00]; // 2 px + 2 pad
		const pixels = [...row, ...row];
		const header = Buffer.alloc(54);
		header.write("BM", 0, "ascii");
		header.writeUInt32LE(54 + pixels.length, 2); // file size
		header.writeUInt32LE(54, 10); // pixel data offset
		header.writeUInt32LE(40, 14); // DIB header size
		header.writeInt32LE(2, 18); // width
		header.writeInt32LE(2, 22); // height
		header.writeUInt16LE(1, 26); // planes
		header.writeUInt16LE(24, 28); // bits per pixel
		header.writeUInt32LE(pixels.length, 34); // image size
		return new Uint8Array(Buffer.concat([header, Buffer.from(pixels)]));
	}

	/** Real bytes for each image the app calls seeable, with the type they arrive under. */
	const SAMPLES: Record<
		string,
		() => Promise<{ bytes: Uint8Array; mimeType: string }>
	> = {
		jpg: async () => ({
			bytes: await solidJpeg(40, 30),
			mimeType: "image/jpeg",
		}),
		png: async () => ({
			bytes: await sharp({
				create: { width: 40, height: 30, channels: 3, background: "#3366cc" },
			})
				.png()
				.toBuffer(),
			mimeType: "image/png",
		}),
		gif: async () => ({
			bytes: await sharp({
				create: { width: 40, height: 30, channels: 3, background: "#3366cc" },
			})
				.gif()
				.toBuffer(),
			mimeType: "image/gif",
		}),
		webp: async () => ({
			bytes: await sharp({
				create: { width: 40, height: 30, channels: 3, background: "#3366cc" },
			})
				.webp()
				.toBuffer(),
			mimeType: "image/webp",
		}),
		tif: async () => ({
			bytes: await sharp({
				create: { width: 40, height: 30, channels: 3, background: "#3366cc" },
			})
				.tiff()
				.toBuffer(),
			mimeType: "image/tiff",
		}),
		heic: async () => ({ bytes: tinyHeic, mimeType: "image/heic" }),
		heif: async () => ({ bytes: tinyHeic, mimeType: "image/heif" }),
		svg: async () => ({
			// A Buffer, as the stored file is read: under jsdom a TextEncoder's
			// Uint8Array comes from another realm and the image library refuses it.
			bytes: Buffer.from(
				'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#3366cc"/></svg>',
			),
			mimeType: "image/svg+xml",
		}),
	};

	const imageEntries = FILE_TYPE_ENTRIES.filter(
		(entry) => entry.category === "image",
	);
	const seeable = imageEntries.filter((entry) =>
		isSeeableImage(`file.${entry.extensions[0]}`, entry.mimeTypes[0]),
	);

	it("has a real sample for every registry image it calls seeable, and none besides", () => {
		expect(seeable.map((entry) => entry.id).sort()).toEqual(
			Object.keys(SAMPLES).sort(),
		);
	});

	it.each(
		Object.keys(SAMPLES),
	)("prepares %s from real bytes, upright and flat, as a JPEG", async (id) => {
		const entry = imageEntries.find((candidate) => candidate.id === id);
		const sample = await SAMPLES[id]();

		const out = await prepareImageForModel(sample.bytes, sample.mimeType, {
			maxLongEdge: ATTACHMENT_MAX_LONG_EDGE,
		});

		expect(entry).toBeDefined();
		expect(out.mediaType).toBe("image/jpeg");
		expect(out.width).toBeGreaterThan(0);
		expect((await sharp(sentBytes(out)).metadata()).format).toBe("jpeg");
	});

	it("says why each registry image that is not seeable is not", async () => {
		const notSeeable = imageEntries
			.filter((entry) => !seeable.includes(entry))
			.map((entry) => entry.id)
			.sort();

		// A new registry image shows up here until it is made seeable (with a
		// sample above) or given its reason below.
		expect(notSeeable).toEqual(["avif", "bmp"]);

		// BMP: the prebuilt libvips has no loader for it, so nothing can be sent.
		await expect(
			prepareImageForModel(tinyBmp(), "image/bmp", { maxLongEdge: 1600 }),
		).rejects.toBeInstanceOf(ImagePreparationError);

		// AVIF: the upload refuses it, so it is never an attachment at all.
		const avif = imageEntries.find((entry) => entry.id === "avif");
		expect(avif?.intake.route).toBe("reject");
		expect(avif?.surfaces).toEqual([]);
	});
});

describe("estimateImageTokens", () => {
	it("estimates tokens at 32 px per token", () => {
		expect(estimateImageTokens(1600, 1000)).toBe(1600);
		expect(estimateImageTokens(512, 384)).toBe(192);
	});

	it("rounds each side up to a whole 32 px tile", () => {
		expect(estimateImageTokens(1, 1)).toBe(1);
		expect(estimateImageTokens(32, 32)).toBe(1);
		expect(estimateImageTokens(33, 33)).toBe(4);
		expect(estimateImageTokens(1600, 1200)).toBe(1900);
	});
});

describe("budgets", () => {
	it("allows an attachment 1600 px and a thumbnail 512 px on the long side", () => {
		expect(ATTACHMENT_MAX_LONG_EDGE).toBe(1600);
		expect(THUMBNAIL_MAX_LONG_EDGE).toBe(512);
	});
});

describe("decodeImageToPng", () => {
	it("gives an upright PNG with its size", async () => {
		// 40x20 stored sideways: EXIF orientation 6 means it is shown 20x40.
		const sideways = await sharp({
			create: { width: 40, height: 20, channels: 3, background: "#336699" },
		})
			.withMetadata({ orientation: 6 })
			.jpeg()
			.toBuffer();
		const out = await decodeImageToPng(sideways, "image/jpeg");
		expect(out.width).toBe(20);
		expect(out.height).toBe(40);
		expect(out.hasAlpha).toBe(false);
		const meta = await sharp(out.png).metadata();
		expect(meta.format).toBe("png");
		expect([meta.width, meta.height]).toEqual([20, 40]);
	});

	it("keeps transparency", async () => {
		const png = await sharp({
			create: {
				width: 8,
				height: 8,
				channels: 4,
				background: { r: 255, g: 0, b: 0, alpha: 0.5 },
			},
		})
			.png()
			.toBuffer();
		expect((await decodeImageToPng(png, "image/png")).hasAlpha).toBe(true);
	});

	it("decodes a HEIC", async () => {
		const out = await decodeImageToPng(tinyHeic, "image/heic");
		expect([out.width, out.height]).toEqual([64, 42]);
	});

	it("refuses bytes that are not a picture", async () => {
		await expect(
			decodeImageToPng(new Uint8Array([1, 2, 3]), "image/jpeg"),
		).rejects.toBeInstanceOf(ImagePreparationError);
	});
});

describe("decodeImageToPng with a long-edge limit", () => {
	it("shrinks a large picture, keeps its shape, and never enlarges a small one", async () => {
		const wide = await sharp({
			create: { width: 800, height: 400, channels: 3, background: "#336699" },
		})
			.png()
			.toBuffer();

		const shrunk = await decodeImageToPng(wide, "image/png", {
			maxLongEdge: 200,
		});
		const kept = await decodeImageToPng(wide, "image/png", {
			maxLongEdge: 2000,
		});

		expect([shrunk.width, shrunk.height]).toEqual([200, 100]);
		expect([kept.width, kept.height]).toEqual([800, 400]);
	});
});
