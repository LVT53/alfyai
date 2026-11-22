// @vitest-environment node
//
// What a video take was asked to render, and the deadline/wait the video owns
// on its own (never the picture's).

import { describe, expect, it } from "vitest";
import { IMAGE_RENDER_DEADLINE_MS } from "../take-request";
import {
	parseVideoCheckpoint,
	parseVideoTakeRequest,
	VIDEO_FPS,
	VIDEO_RENDER_DEADLINE_MS,
	VIDEO_SEGMENT_DURATION_MS,
	VIDEO_SEGMENT_FRAMES,
	VIDEO_TOOL_WAIT_MS,
	type VideoTakeRequest,
	videoSizeForSource,
} from "./request";

function request(overrides: Partial<VideoTakeRequest> = {}): VideoTakeRequest {
	return {
		v: 1,
		prompt: "the harbour at dusk, a slow tide",
		durationSeconds: 5,
		sourceFileId: "still-1",
		fromText: false,
		title: "Harbour at dusk",
		summary: null,
		artifactId: null,
		explicitVariant: false,
		...overrides,
	};
}

describe("a video take request", () => {
	it("keeps a 10 s request's caption for its second segment, and an older row has none", () => {
		const tenSeconds = request({
			durationSeconds: 10,
			continuationPrompt: "The tide pulls back across the sand.",
		});
		expect(parseVideoTakeRequest(JSON.stringify(tenSeconds))).toEqual(
			tenSeconds,
		);
		// A row written before segment 2 had a caption of its own.
		expect(
			parseVideoTakeRequest(JSON.stringify(request({ durationSeconds: 10 }))),
		).toEqual(request({ durationSeconds: 10 }));
		// A blank or wrong one is no caption: segment 2 falls back to the prompt.
		for (const continuationPrompt of ["   ", 3, null]) {
			expect(
				parseVideoTakeRequest(
					JSON.stringify({
						...request({ durationSeconds: 10 }),
						continuationPrompt,
					}),
				),
			).toEqual(request({ durationSeconds: 10 }));
		}
	});

	it("round-trips a 5 s request and a 10 s request", () => {
		expect(parseVideoTakeRequest(JSON.stringify(request()))).toEqual(request());
		expect(
			parseVideoTakeRequest(
				JSON.stringify(request({ durationSeconds: 10, artifactId: "a1" })),
			),
		).toEqual(request({ durationSeconds: 10, artifactId: "a1" }));
	});

	it("keeps an old row as a picture take", () => {
		const parsed = parseVideoTakeRequest(
			JSON.stringify({
				v: 1,
				prompt: "p",
				durationSeconds: 5,
				sourceFileId: "file-1",
				title: "t",
				summary: null,
				artifactId: null,
			}),
		);
		expect(parsed?.fromText).toBe(false);
		expect(parsed?.sourceFileId).toBe("file-1");
	});

	it("parses a text take without a picture", () => {
		const parsed = parseVideoTakeRequest(
			JSON.stringify({ ...request(), sourceFileId: "", fromText: true }),
		);
		expect(parsed?.fromText).toBe(true);
		expect(parsed?.sourceFileId).toBeNull();
	});

	it("drops a stale picture id on a text take", () => {
		const parsed = parseVideoTakeRequest(
			JSON.stringify({
				...request(),
				sourceFileId: "still-1",
				fromText: true,
			}),
		);
		expect(parsed?.fromText).toBe(true);
		expect(parsed?.sourceFileId).toBeNull();
	});

	it("refuses a picture take with no picture", () => {
		expect(
			parseVideoTakeRequest(JSON.stringify({ ...request(), sourceFileId: "" })),
		).toBeNull();
	});

	it("reads a malformed mode as a picture take", () => {
		const parsed = parseVideoTakeRequest(
			JSON.stringify({ ...request(), fromText: "yes" }),
		);
		expect(parsed?.fromText).toBe(false);
	});

	it("rejects a source-less row whose mode is malformed", () => {
		expect(
			parseVideoTakeRequest(
				JSON.stringify({ ...request(), sourceFileId: "", fromText: "yes" }),
			),
		).toBeNull();
	});

	it("defaults an older row to the first variant", () => {
		const parsed = parseVideoTakeRequest(
			JSON.stringify({
				v: 1,
				prompt: "p",
				durationSeconds: 5,
				sourceFileId: "f",
				title: "t",
				summary: null,
				artifactId: null,
			}),
		);
		expect(parsed?.explicitVariant).toBe(false);
	});

	it("round-trips the second variant", () => {
		const parsed = parseVideoTakeRequest(
			JSON.stringify({
				v: 1,
				prompt: "p",
				durationSeconds: 5,
				sourceFileId: "f",
				title: "t",
				summary: null,
				artifactId: null,
				explicitVariant: true,
			}),
		);
		expect(parsed?.explicitVariant).toBe(true);
	});

	it("reads a malformed stored variant as the first variant without rejecting the row", () => {
		for (const value of ["true", 1, {}, null]) {
			const parsed = parseVideoTakeRequest(
				JSON.stringify({ ...request(), explicitVariant: value }),
			);
			expect(parsed).not.toBeNull();
			expect(parsed?.explicitVariant).toBe(false);
		}
	});

	it("refuses anything that cannot stand", () => {
		const bad = [
			"not json",
			"{}",
			JSON.stringify({ ...request(), v: 2 }),
			JSON.stringify({ ...request(), prompt: "   " }),
			JSON.stringify({ ...request(), prompt: 3 }),
			JSON.stringify({ ...request(), durationSeconds: 4 }),
			JSON.stringify({ ...request(), durationSeconds: 11 }),
			JSON.stringify({ ...request(), durationSeconds: 5.5 }),
			JSON.stringify({ ...request(), sourceFileId: "" }),
			JSON.stringify({ ...request(), sourceFileId: null }),
			JSON.stringify({ ...request(), title: "" }),
			JSON.stringify({ ...request(), artifactId: 7 }),
			JSON.stringify({ ...request(), summary: 7 }),
		];
		for (const json of bad) {
			expect(parseVideoTakeRequest(json), json).toBeNull();
		}
	});

	it("never throws", () => {
		expect(() => parseVideoTakeRequest("{")).not.toThrow();
	});
});

describe("the size derived from the source still", () => {
	it("snaps a landscape still to 1280 x 704", () => {
		expect(videoSizeForSource({ width: 1920, height: 1080 })).toEqual({
			width: 1280,
			height: 704,
		});
	});

	it("snaps a portrait still to 704 x 1280", () => {
		expect(videoSizeForSource({ width: 1080, height: 1920 })).toEqual({
			width: 704,
			height: 1280,
		});
	});

	it("keeps a square still square", () => {
		expect(videoSizeForSource({ width: 1024, height: 1024 })).toEqual({
			width: 1280,
			height: 1280,
		});
	});

	it("floors the short side to a multiple of 32, never above 1280", () => {
		for (const source of [
			{ width: 1600, height: 1200 },
			{ width: 1200, height: 1600 },
			{ width: 3000, height: 1000 },
			{ width: 1000, height: 3000 },
			{ width: 1248, height: 832 },
		]) {
			const size = videoSizeForSource(source);
			expect(size.width % 32, JSON.stringify(source)).toBe(0);
			expect(size.height % 32, JSON.stringify(source)).toBe(0);
			expect(Math.max(size.width, size.height)).toBe(1280);
			expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(256);
			// The orientation of the still is the orientation of the clip.
			expect(size.height > size.width).toBe(source.height > source.width);
		}
		expect(videoSizeForSource({ width: 1600, height: 1200 })).toEqual({
			width: 1280,
			height: 960,
		});
	});

	it("falls back to the landscape product size for an unreadable still", () => {
		expect(videoSizeForSource({ width: 0, height: 0 })).toEqual({
			width: 1280,
			height: 704,
		});
	});
});

describe("the video's own numbers", () => {
	it("runs 121 frames at 24 fps per segment", () => {
		expect(VIDEO_FPS).toBe(24);
		expect(VIDEO_SEGMENT_FRAMES).toBe(121);
		expect(VIDEO_SEGMENT_DURATION_MS).toBe(5_000);
	});

	it("keeps its own render deadline and tool wait, not the picture's", () => {
		expect(VIDEO_RENDER_DEADLINE_MS).toBeGreaterThan(
			VIDEO_SEGMENT_DURATION_MS * 100,
		);
		expect(VIDEO_TOOL_WAIT_MS).toBeGreaterThan(0);
		expect(VIDEO_RENDER_DEADLINE_MS).not.toBe(IMAGE_RENDER_DEADLINE_MS);
	});
});

describe("the checkpoint", () => {
	it("round-trips the prompt id, the segment and the media of finished segments", () => {
		const checkpoint = {
			promptId: "p2",
			segment: 2 as const,
			segments: [
				{
					promptId: "p1",
					media: { filename: "a.mp4", subfolder: "", type: "output" as const },
				},
				{ promptId: "p2", media: null },
			],
		};
		expect(parseVideoCheckpoint(JSON.stringify(checkpoint))).toEqual(
			checkpoint,
		);
	});

	it("answers null for anything unreadable", () => {
		expect(parseVideoCheckpoint(null)).toBeNull();
		expect(parseVideoCheckpoint("{}")).toBeNull();
		expect(parseVideoCheckpoint('{"promptId":""}')).toBeNull();
		expect(parseVideoCheckpoint('{"promptId":"p","segment":3}')).toBeNull();
	});
});
