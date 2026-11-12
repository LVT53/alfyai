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
		["landscape", 2496, 1664],
		["portrait", 1664, 2496],
		["square", 2048, 2048],
		["wide", 2720, 1536],
		["tall", 1536, 2720],
	] as const)("makes a new %s picture at 4 MP", (size, width, height) => {
		expect(canvasForNewPicture(size, false, "h3")).toEqual({ width, height });
		expect(H3_NEW_PICTURE_CANVAS[size]).toEqual({ width, height });
		// "4 MP" is the tier's name: the five canvases sit within a few percent.
		expect(width * height).toBeGreaterThan(4_000_000);
		expect(width * height).toBeLessThanOrEqual(4_194_304);
	});

	it("has no print enlargement: print is a no-op at 4 MP", () => {
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
			expect(print.width * print.height).toBeGreaterThan(4_000_000);
		}
	});

	it("keeps an edit's shape at 4 MP, in multiples of 32, capped at 6272", () => {
		expect(canvasForEdit({ width: 4032, height: 3024 }, false, "h3")).toEqual({
			width: 2368,
			height: 1760,
		});
		expect(canvasForEdit({ width: 4032, height: 3024 }, true, "h3")).toEqual(
			canvasForEdit({ width: 4032, height: 3024 }, false, "h3"),
		);
		expect(canvasForEdit({ width: 3000, height: 3000 }, false, "h3")).toEqual({
			width: 2048,
			height: 2048,
		});
		expect(canvasForEdit({ width: 4000, height: 1000 }, false, "h3")).toEqual({
			width: 4096,
			height: 1024,
		});
		// The wider model's own side limit, not Qwen's 2752.
		expect(canvasForEdit({ width: 12000, height: 1000 }, false, "h3")).toEqual({
			width: 6272,
			height: 576,
		});
	});

	it("keeps Qwen on 1 MP, 4 MP print and its own 2752 side limit", () => {
		expect(MAX_SIDE_BY_MODEL).toEqual({ qwen: 2752, h3: 6272 });
		expect(
			canvasForEdit({ width: 12000, height: 1000 }, true, "qwen").width,
		).toBe(2752);
		expect(NEW_PICTURE_CANVAS.tall).toEqual({ width: 768, height: 1376 });
	});
});
