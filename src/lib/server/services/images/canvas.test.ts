import { describe, expect, it } from "vitest";
import {
	canvasForEdit,
	canvasForNewPicture,
	H3_NEW_PICTURE_CANVAS,
	MAX_SIDE_BY_MODEL,
	NEW_PICTURE_CANVAS,
} from "./canvas";

describe("canvas", () => {
	it("defaults a new Qwen picture to 1248x832", () =>
		expect(canvasForNewPicture(undefined, false, "qwen")).toEqual({
			width: 1248,
			height: 832,
		}));
	it("doubles each side for a Qwen print", () =>
		expect(canvasForNewPicture("tall", true, "qwen")).toEqual({
			width: 1536,
			height: 2752,
		}));
	it("keeps a photo's shape at about 1 MP in multiples of 32", () =>
		expect(canvasForEdit({ width: 4032, height: 3024 }, false, "qwen")).toEqual(
			{
				width: 1184,
				height: 896,
			},
		));
	it("goes to about 4 MP for a Qwen print", () =>
		expect(canvasForEdit({ width: 4032, height: 3024 }, true, "qwen")).toEqual({
			width: 2368,
			height: 1760,
		}));
	it("never edits at exactly 1024x1024", () =>
		expect(canvasForEdit({ width: 3000, height: 3000 }, false, "qwen")).toEqual(
			{
				width: 1056,
				height: 1056,
			},
		));
	it("keeps a panorama inside the limits", () =>
		expect(canvasForEdit({ width: 4000, height: 1000 }, false, "qwen")).toEqual(
			{
				width: 2048,
				height: 512,
			},
		));
});

describe("the H3 canvas", () => {
	it.each([
		["landscape", 4224, 2816],
		["portrait", 2816, 4224],
		["square", 3456, 3456],
		["wide", 4608, 2592],
		["tall", 2592, 4608],
	] as const)("makes a new %s picture at 12 MP", (size, width, height) => {
		expect(canvasForNewPicture(size, false, "h3")).toEqual({ width, height });
		expect(H3_NEW_PICTURE_CANVAS[size]).toEqual({ width, height });
		// "12 MP" is the tier's name: the five canvases sit within a few percent.
		expect(width * height).toBeGreaterThan(11_800_000);
		expect(width * height).toBeLessThanOrEqual(11_943_936);
	});

	it("has no print enlargement: print is a no-op at 12 MP", () => {
		for (const size of Object.keys(H3_NEW_PICTURE_CANVAS)) {
			const plain = canvasForNewPicture(
				size as keyof typeof H3_NEW_PICTURE_CANVAS,
				false,
				"h3",
			);
			const print = canvasForNewPicture(
				size as keyof typeof H3_NEW_PICTURE_CANVAS,
				true,
				"h3",
			);
			expect(print).toEqual(plain);
			expect(print.width * print.height).toBeGreaterThan(11_800_000);
		}
	});

	it.each([
		// [base width, base height, canvas width, canvas height]
		[4224, 2816, 3072, 2048], // 3:2 (H3's own landscape picture)
		[2816, 4224, 2048, 3072],
		[3456, 3456, 2048, 2048],
		[4608, 2592, 3648, 2048], // 16:9: 3640.9 snaps to the nearest 32, 3648
		[2592, 4608, 2048, 3648],
		[1056, 1056, 2048, 2048], // a smaller base is scaled UP to the edge
		[4032, 3024, 2720, 2048], // 4:3: 2730.7 snaps to 2720
		[640, 480, 2720, 2048],
		[100, 100, 2048, 2048],
		[6000, 2000, 6144, 2048], // 3:1 still fits under 6272
		[6272, 2048, 6272, 2048], // exactly the longest side
	] as const)(
		"edits a %ix%i picture on a %ix%i canvas: its short edge at 2048",
		(baseWidth, baseHeight, width, height) => {
			const canvas = canvasForEdit(
				{ width: baseWidth, height: baseHeight },
				false,
				"h3",
			);
			expect(canvas).toEqual({ width, height });
			expect(Math.min(canvas.width, canvas.height)).toBe(2048);
		},
	);

	it("has no print enlargement for an edit either", () => {
		for (const base of [
			{ width: 4032, height: 3024 },
			{ width: 3000, height: 3000 },
			{ width: 10000, height: 1000 },
		]) {
			expect(canvasForEdit(base, true, "h3")).toEqual(
				canvasForEdit(base, false, "h3"),
			);
		}
	});

	it("brings both sides down together when the long side would pass 6272", () => {
		// 10:1 would be 20480 x 2048; the long side is capped and the short one
		// follows (627.2, snapped to 640), so the shape stays about 10:1.
		expect(canvasForEdit({ width: 10000, height: 1000 }, false, "h3")).toEqual({
			width: 6272,
			height: 640,
		});
		expect(canvasForEdit({ width: 1000, height: 10000 }, false, "h3")).toEqual({
			width: 640,
			height: 6272,
		});
		// 4:1 keeps its shape exactly: 6272 x 1568.
		expect(canvasForEdit({ width: 4000, height: 1000 }, false, "h3")).toEqual({
			width: 6272,
			height: 1568,
		});
		// One axis is never clamped alone: 12:1 is 6272 x 522.7 (snapped to 512),
		// not the 6272 x 992 that clamping the width alone gave.
		expect(canvasForEdit({ width: 12000, height: 1000 }, false, "h3")).toEqual({
			width: 6272,
			height: 512,
		});
		// A shape so thin that its short side would pass under the floor lands on it.
		expect(canvasForEdit({ width: 40000, height: 1000 }, false, "h3")).toEqual({
			width: 6272,
			height: 256,
		});
	});

	it("always answers in multiples of 32 inside 256..6272, in the base's orientation, with a 2048 short edge while the long side fits", () => {
		const sizes = [
			64, 480, 640, 1000, 1001, 1080, 1920, 3000, 4032, 6000, 10000,
		];
		for (const width of sizes) {
			for (const height of sizes) {
				const canvas = canvasForEdit({ width, height }, false, "h3");
				const label = `${width}x${height} -> ${canvas.width}x${canvas.height}`;
				const long = Math.max(canvas.width, canvas.height);
				const short = Math.min(canvas.width, canvas.height);
				expect(canvas.width % 32, label).toBe(0);
				expect(canvas.height % 32, label).toBe(0);
				expect(long, label).toBeLessThanOrEqual(6272);
				expect(short, label).toBeGreaterThanOrEqual(256);
				if (width > height)
					expect(canvas.width, label).toBeGreaterThanOrEqual(canvas.height);
				if (width < height)
					expect(canvas.width, label).toBeLessThanOrEqual(canvas.height);
				const aspect = Math.max(width, height) / Math.min(width, height);
				if (aspect <= 6272 / 2048) expect(short, label).toBe(2048);
				else expect(long, label).toBe(6272);
			}
		}
	});

	it("keeps Qwen on 1 MP, 4 MP print and its own 2752 side limit", () => {
		expect(MAX_SIDE_BY_MODEL).toEqual({ qwen: 2752, h3: 6272 });
		expect(
			canvasForEdit({ width: 12000, height: 1000 }, true, "qwen").width,
		).toBe(2752);
		expect(NEW_PICTURE_CANVAS.tall).toEqual({ width: 768, height: 1376 });
	});

	it("leaves Qwen's edit canvases exactly as they were: area-based, each axis clamped on its own", () => {
		expect(
			canvasForEdit({ width: 12000, height: 1000 }, false, "qwen"),
		).toEqual({ width: 2752, height: 288 });
		expect(canvasForEdit({ width: 640, height: 480 }, false, "qwen")).toEqual({
			width: 1184,
			height: 896,
		});
		expect(canvasForEdit({ width: 3000, height: 2000 }, true, "qwen")).toEqual({
			width: 2496,
			height: 1664,
		});
	});
});
