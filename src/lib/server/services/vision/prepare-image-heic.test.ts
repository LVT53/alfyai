// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { decodeImageToPng, prepareImageForModel } from "./prepare-image";

// The three HEIC files are real ones, made on this Mac with `sips`; their
// recipes are in prepare-image.test.ts (tiny.heic) and heif-decode.test.ts
// (photo-grid.heic, 12 MP, whose decode takes 270 to 300 ms here, and
// transparent-page.heic, 800x600, black text on transparent: the stem of the
// "I" of "Invoice" covers x 70 to 91 and y 152 to 255).
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
	new Uint8Array(readFileSync(path.join(here, "__fixtures__", name)));
const photoGrid = fixture("photo-grid.heic");
const transparentPage = fixture("transparent-page.heic");
const tinyHeic = fixture("tiny.heic");

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

describe("a transparent HEIC page", () => {
	const corners = (width: number, height: number) => [
		[0, 0],
		[width - 1, 0],
		[0, height - 1],
		[width - 1, height - 1],
	];

	it("keeps its alpha when no background is asked for", async () => {
		const out = await decodeImageToPng(transparentPage, "image/heic");

		expect(out.hasAlpha).toBe(true);
		expect(await pixelAt(out.png, 0, 0)).toEqual([0, 0, 0, 0]);
		expect(await pixelAt(out.png, 80, 200)).toEqual([0, 0, 0, 255]);
	});

	it("goes to the model on white, its text still dark", async () => {
		const out = await prepareImageForModel(transparentPage, "image/heic", {
			maxLongEdge: 1600,
		});
		const sent = Buffer.from(out.base64, "base64");

		expect((await sharp(sent).metadata()).hasAlpha).toBe(false);
		for (const [x, y] of corners(out.width, out.height)) {
			const [red, green, blue] = await pixelAt(sent, x, y);
			expect(Math.min(red, green, blue)).toBeGreaterThan(250);
		}
		const [red, green, blue] = await pixelAt(sent, 80, 200);
		expect(Math.max(red, green, blue)).toBeLessThan(40);
	});
});

describe("the main thread while a HEIC photo decodes", () => {
	it("is never held for long: its longest stall is under half of the decode", async () => {
		// Loading sharp and starting the first decode are one-time costs, not the
		// decode's: pay them before looking.
		await prepareImageForModel(tinyHeic, "image/heic", {
			maxLongEdge: 64,
		});
		const delay = monitorEventLoopDelay({ resolution: 10 });
		delay.enable();
		// The histogram times a lag from its previous tick, so it needs one
		// before the decode starts: a thread held from the first moment would
		// show no lag at all.
		await new Promise((done) => setTimeout(done, 30));

		const started = performance.now();
		await prepareImageForModel(photoGrid, "image/heic", { maxLongEdge: 1600 });
		const decodeMs = performance.now() - started;
		// A timer after the decode settles, so the lag that ended with it counts.
		await new Promise((done) => setTimeout(done, 50));
		delay.disable();
		const longestStallMs = delay.max / 1e6;

		// Relative on purpose: a busy machine slows the decode and the thread
		// alike. A decode that is too quick proves nothing about the thread.
		expect(decodeMs).toBeGreaterThan(100);
		expect(longestStallMs).toBeLessThan(decodeMs / 2);
	});
});
