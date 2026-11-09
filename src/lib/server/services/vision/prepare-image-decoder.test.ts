// @vitest-environment node
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ImageDecodeTimeoutError,
	ImagePreparationError,
	ImageTooLargeError,
} from "./image-errors";
import { decodeImageToPng, prepareImageForModel } from "./prepare-image";

// The decoder itself is tested in heif-decode.test.ts. Here it is a stand-in,
// to see what prepare-image does with what it answers and with how it fails.
const decoder = vi.hoisted(() => vi.fn());
vi.mock("./heif-decode", async (importOriginal) => ({
	...(await importOriginal<typeof import("./heif-decode")>()),
	decodeHeifToRgba: decoder,
}));

const heicBytes = new Uint8Array([1, 2, 3, 4]);

/** Two pixels, straight (not premultiplied) RGBA: opaque red, then fully transparent blue. */
const redThenTransparentBlue = {
	width: 2,
	height: 1,
	data: Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 0]),
};

async function rgbaOf(png: Uint8Array): Promise<number[]> {
	const { data } = await sharp(png)
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	return Array.from(data);
}

const preparations = [
	[
		"decodeImageToPng",
		(bytes: Uint8Array) => decodeImageToPng(bytes, "image/heic"),
	],
	[
		"prepareImageForModel",
		(bytes: Uint8Array) =>
			prepareImageForModel(bytes, "image/heic", { maxLongEdge: 1600 }),
	],
] as const;

beforeEach(() => {
	decoder.mockReset();
});

describe.each(preparations)("%s with a HEIC photo", (_name, prepare) => {
	it("hands the decoder the bytes it was given", async () => {
		decoder.mockResolvedValue(redThenTransparentBlue);

		await prepare(heicBytes);

		expect(decoder).toHaveBeenCalledTimes(1);
		expect(decoder.mock.calls[0][0]).toBe(heicBytes);
	});

	it.each([
		["too large", new ImageTooLargeError(100_010_000, 100_000_000)],
		["out of time", new ImageDecodeTimeoutError(60_000)],
	])("throws the decoder's error as it is when the photo is %s", async (_why, failure) => {
		decoder.mockRejectedValue(failure);

		const caught = await prepare(heicBytes).catch((error: unknown) => error);

		expect(caught).toBe(failure);
	});

	it("says a photo libheif refuses could not be prepared, with the refusal as the cause", async () => {
		const refusal = new ImagePreparationError("HEIF decode failed: x");
		decoder.mockRejectedValue(refusal);

		const caught = await prepare(heicBytes).catch((error: unknown) => error);

		expect(caught).toBeInstanceOf(ImagePreparationError);
		expect(caught).not.toBeInstanceOf(ImageTooLargeError);
		expect(caught).not.toBeInstanceOf(ImageDecodeTimeoutError);
		expect((caught as ImagePreparationError).message).toBe(
			"image preparation failed: HEIF decode failed: x",
		);
		expect((caught as ImagePreparationError).cause).toBe(refusal);
	});

	it("wraps an error that is not its own family's, with it as the cause too", async () => {
		const failure = new Error("the decoder is not installed");
		decoder.mockRejectedValue(failure);

		const caught = await prepare(heicBytes).catch((error: unknown) => error);

		expect(caught).toBeInstanceOf(ImagePreparationError);
		expect((caught as ImagePreparationError).cause).toBe(failure);
		expect((caught as ImagePreparationError).message).toContain(
			"the decoder is not installed",
		);
	});
});

describe.each(preparations)("%s with an AbortSignal", (_name, _prepare) => {
	const withSignal = (signal: AbortSignal) =>
		_name === "decodeImageToPng"
			? decodeImageToPng(heicBytes, "image/heic", { signal })
			: prepareImageForModel(heicBytes, "image/heic", {
					maxLongEdge: 1600,
					signal,
				});

	it("gives the signal to the decoder", async () => {
		const controller = new AbortController();
		decoder.mockResolvedValue(redThenTransparentBlue);

		await withSignal(controller.signal);

		expect(decoder.mock.calls[0][1]).toEqual({ signal: controller.signal });
	});

	it.each([
		["an error", new Error("cancelled")],
		["a string", "not wanted"],
	])("rejects with the reason as it is when the decoder was stopped, %s", async (_kind, reason) => {
		const controller = new AbortController();
		decoder.mockImplementation(async () => {
			controller.abort(reason);
			throw controller.signal.reason;
		});

		const caught = await withSignal(controller.signal).catch(
			(error: unknown) => error,
		);

		expect(caught).toBe(reason);
	});

	it("rejects with the reason when the abort comes after the decode, while sharp works", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled");
		decoder.mockImplementation(async () => {
			controller.abort(reason);
			return redThenTransparentBlue;
		});

		const caught = await withSignal(controller.signal).catch(
			(error: unknown) => error,
		);

		// No picture comes out of a preparation that was called off.
		expect(caught).toBe(reason);
	});

	it("rejects with the reason before it starts when the signal is already aborted", async () => {
		const reason = new Error("cancelled");

		const caught = await withSignal(AbortSignal.abort(reason)).catch(
			(error: unknown) => error,
		);

		expect(caught).toBe(reason);
		expect(decoder).not.toHaveBeenCalled();
	});

	it("still throws the decoder's own errors as before when the signal never fires", async () => {
		const controller = new AbortController();
		const failure = new ImageTooLargeError(100_010_000, 100_000_000);
		decoder.mockRejectedValue(failure);

		const caught = await withSignal(controller.signal).catch(
			(error: unknown) => error,
		);

		expect(caught).toBe(failure);
	});
});

describe("a picture that is not a HEIC and an aborted signal", () => {
	it("rejects with the reason before reading it", async () => {
		const png = await sharp({
			create: { width: 4, height: 4, channels: 3, background: "#336699" },
		})
			.png()
			.toBuffer();
		const reason = new Error("cancelled");

		const forPng = await decodeImageToPng(png, "image/png", {
			signal: AbortSignal.abort(reason),
		}).catch((error: unknown) => error);
		const forModel = await prepareImageForModel(png, "image/png", {
			maxLongEdge: 1600,
			signal: AbortSignal.abort(reason),
		}).catch((error: unknown) => error);

		expect(forPng).toBe(reason);
		expect(forModel).toBe(reason);
	});
});

describe("a photo that is not a HEIC", () => {
	it("never reaches the decoder", async () => {
		const png = await sharp({
			create: { width: 4, height: 4, channels: 3, background: "#336699" },
		})
			.png()
			.toBuffer();

		await decodeImageToPng(png, "image/png");
		await prepareImageForModel(png, "image/png", { maxLongEdge: 1600 });

		expect(decoder).not.toHaveBeenCalled();
	});
});

describe("the pixels the decoder gives", () => {
	it("are read as RGBA with the alpha kept as it is, not premultiplied", async () => {
		decoder.mockResolvedValue(redThenTransparentBlue);

		const out = await decodeImageToPng(heicBytes, "image/heic");

		expect([out.width, out.height]).toEqual([2, 1]);
		expect(out.hasAlpha).toBe(true);
		expect(await rgbaOf(out.png)).toEqual([255, 0, 0, 255, 0, 0, 255, 0]);
	});

	it("end up on white for a model where they are transparent", async () => {
		// 32x16: the left half opaque red, the right half transparent blue. Big
		// enough, and cut at a block edge, for JPEG's rounding not to reach the
		// middle of either half.
		const width = 32;
		const height = 16;
		const data = new Uint8Array(width * height * 4);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const at = (y * width + x) * 4;
				data.set(x < width / 2 ? [255, 0, 0, 255] : [0, 0, 255, 0], at);
			}
		}
		decoder.mockResolvedValue({ width, height, data });

		const out = await prepareImageForModel(heicBytes, "image/heic", {
			maxLongEdge: 1600,
		});
		const sent = Buffer.from(out.base64, "base64");
		const { data: pixels, info } = await sharp(sent)
			.raw()
			.toBuffer({ resolveWithObject: true });
		const at = (x: number, y: number) =>
			Array.from(pixels.subarray((y * info.width + x) * 3).subarray(0, 3));

		expect([out.width, out.height]).toEqual([32, 16]);
		expect(info.channels).toBe(3);
		const [red, green, blue] = at(4, 8);
		expect(red).toBeGreaterThan(240);
		expect(Math.max(green, blue)).toBeLessThan(30);
		expect(Math.min(...at(28, 8))).toBeGreaterThan(240);
	});
});
