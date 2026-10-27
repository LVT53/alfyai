import { describe, expect, it } from "vitest";
import { canvasForEdit, canvasForNewPicture } from "./canvas";

describe("canvas", () => {
	it("defaults a new picture to 1248x832", () =>
		expect(canvasForNewPicture(undefined, false)).toEqual({
			width: 1248,
			height: 832,
		}));
	it("doubles each side for print", () =>
		expect(canvasForNewPicture("tall", true)).toEqual({
			width: 1536,
			height: 2752,
		}));
	it("keeps a photo's shape at about 1 MP in multiples of 32", () =>
		expect(canvasForEdit({ width: 4032, height: 3024 }, false)).toEqual({
			width: 1184,
			height: 896,
		}));
	it("goes to about 4 MP for print", () =>
		expect(canvasForEdit({ width: 4032, height: 3024 }, true)).toEqual({
			width: 2368,
			height: 1760,
		}));
	it("never edits at exactly 1024x1024", () =>
		expect(canvasForEdit({ width: 3000, height: 3000 }, false)).toEqual({
			width: 1056,
			height: 1056,
		}));
	it("keeps a panorama inside the limits", () =>
		expect(canvasForEdit({ width: 4000, height: 1000 }, false)).toEqual({
			width: 2048,
			height: 512,
		}));
});
