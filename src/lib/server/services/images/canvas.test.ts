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

	it("keeps an edit's shape at 12 MP, in multiples of 32, capped at 6272", () => {
		expect(canvasForEdit({ width: 4032, height: 3024 }, false, "h3")).toEqual({
			width: 3968,
			height: 2976,
		});
		expect(canvasForEdit({ width: 4032, height: 3024 }, true, "h3")).toEqual(
			canvasForEdit({ width: 4032, height: 3024 }, false, "h3"),
		);
		expect(canvasForEdit({ width: 3000, height: 3000 }, false, "h3")).toEqual({
			width: 3456,
			height: 3456,
		});
		expect(canvasForEdit({ width: 4000, height: 1000 }, false, "h3")).toEqual({
			width: 6272,
			height: 1728,
		});
		// The wider model's own side limit, not Qwen's 2752. A shape past it loses
		// area, which is why the app never asks for one itself.
		expect(canvasForEdit({ width: 12000, height: 1000 }, false, "h3")).toEqual({
			width: 6272,
			height: 992,
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
