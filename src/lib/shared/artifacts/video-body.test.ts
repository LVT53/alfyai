import { describe, expect, it } from "vitest";
import {
	parseVideoVersionBody,
	serializeVideoVersionBody,
	type VideoVersionBody,
} from "./video-body";

const body: VideoVersionBody = {
	v: 1,
	fileId: "video-file-1",
	posterFileId: "video-file-1",
	width: 1280,
	height: 704,
	durationMs: 5000,
	sourceFileId: "still-file-1",
};

describe("video version body", () => {
	it("survives serialize then parse, source still and all", () => {
		expect(parseVideoVersionBody(serializeVideoVersionBody(body))).toEqual(
			body,
		);
	});

	it("keeps a clip made from words alone, with no source still", () => {
		const fromWords: VideoVersionBody = { ...body, sourceFileId: null };
		expect(parseVideoVersionBody(serializeVideoVersionBody(fromWords))).toEqual(
			fromWords,
		);
	});

	it("refuses a missing fileId or posterFileId", () => {
		const { fileId: _fileId, ...noFile } = body;
		const { posterFileId: _posterFileId, ...noPoster } = body;
		expect(parseVideoVersionBody(JSON.stringify(noFile))).toBeNull();
		expect(parseVideoVersionBody(JSON.stringify(noPoster))).toBeNull();
		expect(
			parseVideoVersionBody(JSON.stringify({ ...body, posterFileId: "" })),
		).toBeNull();
	});

	it("refuses a version other than 1 and dimensions that cannot be a picture", () => {
		expect(parseVideoVersionBody(JSON.stringify({ ...body, v: 2 }))).toBeNull();
		expect(
			parseVideoVersionBody(JSON.stringify({ ...body, width: 0 })),
		).toBeNull();
		expect(
			parseVideoVersionBody(JSON.stringify({ ...body, height: -1 })),
		).toBeNull();
		expect(
			parseVideoVersionBody(JSON.stringify({ ...body, width: "1280" })),
		).toBeNull();
	});

	it("refuses a duration that is not a positive whole number of milliseconds", () => {
		for (const durationMs of [0, -1, 0.5, Number.NaN, "5000", null]) {
			expect(
				parseVideoVersionBody(JSON.stringify({ ...body, durationMs })),
				String(durationMs),
			).toBeNull();
		}
	});

	it("refuses a source still that is not a string or null", () => {
		expect(
			parseVideoVersionBody(JSON.stringify({ ...body, sourceFileId: 3 })),
		).toBeNull();
		expect(
			parseVideoVersionBody(JSON.stringify({ ...body, sourceFileId: "" })),
		).toBeNull();
	});

	it("reads a record that omits the source still as made from words alone", () => {
		const { sourceFileId: _sourceFileId, ...withoutSource } = body;
		expect(parseVideoVersionBody(JSON.stringify(withoutSource))).toEqual({
			...body,
			sourceFileId: null,
		});
	});

	it("answers null for anything unreadable, never throwing", () => {
		for (const stored of [
			null,
			"",
			"not json",
			"null",
			"[]",
			'"a string"',
			JSON.stringify({ ...body, v: "1" }),
		]) {
			expect(() => parseVideoVersionBody(stored)).not.toThrow();
			expect(parseVideoVersionBody(stored), String(stored)).toBeNull();
		}
	});

	it("serialises deterministically, whatever key order it was handed", () => {
		const reordered = {
			sourceFileId: body.sourceFileId,
			durationMs: body.durationMs,
			height: body.height,
			width: body.width,
			posterFileId: body.posterFileId,
			fileId: body.fileId,
			v: 1,
		} as VideoVersionBody;
		expect(serializeVideoVersionBody(reordered)).toBe(
			serializeVideoVersionBody(body),
		);
	});
});
