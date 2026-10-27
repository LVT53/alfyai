import { describe, expect, it } from "vitest";
import {
	type ImageVersionBody,
	MARK_COLOURS,
	parseImageMarks,
	parseImageVersionBody,
	parseUserPictures,
	serializeImageVersionBody,
	thumbWidth,
} from "./image-body";

const body: ImageVersionBody = {
	v: 1,
	fileId: "file-1",
	width: 1248,
	height: 832,
	hasAlpha: false,
	baseFileId: "file-0",
	sources: [{ fileId: "file-0", name: "room.png" }],
	marks: [{ letter: "A", x: 0.1, y: 0.1, w: 0.3, h: 0.2 }],
	prompt: "a cosy room",
	takeId: "take-1",
	seed: 42,
	anchorFileId: "file-0",
	chainSinceAnchor: 1,
};

describe("image version body", () => {
	it("survives serialize then parse", () => {
		expect(parseImageVersionBody(serializeImageVersionBody(body))).toEqual(
			body,
		);
	});

	it("refuses a missing fileId, a negative width and v 2", () => {
		const { fileId: _drop, ...noFile } = body;
		expect(parseImageVersionBody(JSON.stringify(noFile))).toBeNull();
		expect(
			parseImageVersionBody(JSON.stringify({ ...body, width: -1 })),
		).toBeNull();
		expect(parseImageVersionBody(JSON.stringify({ ...body, v: 2 }))).toBeNull();
		expect(parseImageVersionBody("not json")).toBeNull();
		expect(parseImageVersionBody(null)).toBeNull();
	});

	it("keeps the eight mark colours", () => {
		expect(MARK_COLOURS.A).toBe("#E53935");
		expect(MARK_COLOURS.H).toBe("#6D4C41");
	});
});

describe("parseImageMarks", () => {
	const mark = (letter: string, x = 0.1) => ({
		letter,
		x,
		y: 0.1,
		w: 0.2,
		h: 0.2,
	});

	it("accepts well-formed marks", () => {
		expect(parseImageMarks([mark("A"), mark("B")])).toHaveLength(2);
	});

	it("refuses two marks with the same letter", () => {
		expect(parseImageMarks([mark("A"), mark("A", 0.5)])).toBeNull();
	});

	it("refuses a box thinner than 2 percent", () => {
		expect(parseImageMarks([{ ...mark("A"), w: 0.01 }])).toBeNull();
	});

	it("refuses a box past the edge", () => {
		expect(parseImageMarks([mark("A", 0.9)])).toBeNull();
	});

	it("refuses nine marks", () => {
		const nine = "ABCDEFGHA".split("").map((l, i) => mark(l, i / 20));
		expect(parseImageMarks(nine)).toBeNull();
	});
});

describe("parseUserPictures uploads", () => {
	const refs = [{ imageFileId: "f1", number: 1, name: "Sofa" }];

	it("keeps the numbers of the uploads a message carried", () => {
		expect(
			parseUserPictures({
				refs,
				open: null,
				marks: null,
				uploads: [
					{ artifactId: "a", number: 2 },
					{ artifactId: "b", number: 3 },
				],
			}),
		).toEqual({
			refs,
			uploads: [
				{ artifactId: "a", number: 2 },
				{ artifactId: "b", number: 3 },
			],
			open: null,
			marks: null,
		});
	});

	it("still reads an older record without them", () => {
		expect(parseUserPictures({ refs, open: null, marks: null })).toEqual({
			refs,
			open: null,
			marks: null,
		});
	});

	it("drops a malformed uploads list without refusing the record", () => {
		expect(
			parseUserPictures({
				refs,
				open: null,
				marks: null,
				uploads: [{ artifactId: "a", number: "2" }],
			}),
		).toEqual({ refs, open: null, marks: null });
	});
});

describe("thumbWidth", () => {
	it("is the width of the 320 px thumbnail, never wider than the picture", () => {
		expect(thumbWidth(1248, 832)).toBe(320);
		expect(thumbWidth(832, 1248)).toBe(213);
		expect(thumbWidth(200, 100)).toBe(200);
	});
});
