// What a video take was asked to render, as the job row keeps it
// (`request_json`), plus the video's own clock: its render deadline and the
// tool wait are the video's, never the picture's (the picture's live in
// `../take-request.ts`). The tool builds a VideoTakeRequest; the runner reads
// it back through `parseVideoTakeRequest`, which trusts nothing.
//
// A take is one 5 s segment; a 10 s take is two segments chained last-frame to
// first-frame and concatenated (the runner's job, not this file's).

import type { ComfyImageRef } from "../comfyui/types";

/** A take's product length: 5 s, or 10 s as two chained 5 s segments. */
export type VideoDurationSeconds = 5 | 10;

export type VideoTakeRequest = {
	v: 1;
	/** The motion caption, in the LTX caption style the tool wrote. */
	prompt: string;
	/** 5 s by default; 10 s is two 5 s segments chained. */
	durationSeconds: VideoDurationSeconds;
	/** The still the clip is made from (an `image_files` id of the person). */
	sourceFileId: string;
	/** The Video item's title. */
	title: string;
	/** The one-line version summary, when the caller has one. */
	summary: string | null;
	/**
	 * The Video item a later take appends a version to ("another take"), or
	 * null to make a new item. A take whose item is gone stores nothing.
	 */
	artifactId: string | null;
};

/**
 * The video's own render deadline, in milliseconds. A cold 5 s render measured
 * 53 s on the production card and a 10 s take is two segments, each paying the
 * encoder staging on a cold server; 15 minutes also covers waiting in
 * ComfyUI's queue behind the other engine's free. Deliberately not the
 * picture's 10 minutes.
 */
export const VIDEO_RENDER_DEADLINE_MS = 900_000;

/**
 * How long a `make_video` call waits inside the turn before leaving the take
 * on its card. Longer than the picture's 100 s because a 10 s take is two
 * renders; the take itself is detached and finishes either way.
 */
export const VIDEO_TOOL_WAIT_MS = 240_000;

/**
 * The template's frame rate and segment length: 121 frames at 24 fps. They live
 * in `comfyui/ltx-spec.ts` (which imports no JSON) and the graph builder writes
 * them into the graph, so these are the same numbers and not two copies of one.
 */
export {
	LTX_SEGMENT_FRAMES as VIDEO_SEGMENT_FRAMES,
	LTX_VIDEO_FPS as VIDEO_FPS,
} from "../comfyui/ltx-spec";
export const VIDEO_SEGMENT_DURATION_MS = 5_000;

/** The product length of one segment, and of the whole take. */
export function videoDurationMs(durationSeconds: VideoDurationSeconds): number {
	return durationSeconds === 10 ? 10_000 : VIDEO_SEGMENT_DURATION_MS;
}

/** How many LTX segments a take renders: one at 5 s, two at 10 s. */
export function videoSegmentCount(
	durationSeconds: VideoDurationSeconds,
): 1 | 2 {
	return durationSeconds === 10 ? 2 : 1;
}

/** The long edge of every clip: the measured 720p product size. */
export const VIDEO_LONG_EDGE = 1280;
/** LTX works in multiples of 32 on both sides. */
export const VIDEO_SIZE_STEP = 32;
/** An abuse guard and the smallest useful short side, not a product size. */
export const VIDEO_MIN_SIDE = 256;

/**
 * The clip's size from the source still's aspect: the long edge is 1280 and
 * the short side is the same ratio, floored to a multiple of 32 so it never
 * rounds past the still's shape. A 16:9 still gives 1280 x 704 (the measured
 * 720p product size, which the template's own 1280 x 720 setting lands on
 * after its latent's `// 32`), a 9:16 still 704 x 1280, a 4:3 still
 * 1280 x 960.
 */
export function videoSizeForSource(size: { width: number; height: number }): {
	width: number;
	height: number;
} {
	const width = Math.trunc(size.width);
	const height = Math.trunc(size.height);
	if (!(width > 0) || !(height > 0)) {
		return { width: VIDEO_LONG_EDGE, height: 704 };
	}
	const portrait = height > width;
	const ratio = Math.min(width, height) / Math.max(width, height);
	const shortSide = Math.min(
		VIDEO_LONG_EDGE,
		Math.max(
			VIDEO_MIN_SIDE,
			Math.floor((ratio * VIDEO_LONG_EDGE) / VIDEO_SIZE_STEP) * VIDEO_SIZE_STEP,
		),
	);
	return portrait
		? { width: shortSide, height: VIDEO_LONG_EDGE }
		: { width: VIDEO_LONG_EDGE, height: shortSide };
}

/** One finished segment of a take, as the checkpoint remembers it. */
export type VideoSegmentRecord = {
	promptId: string;
	/** ComfyUI's saved clip for the segment, once the follow reported it. */
	media: ComfyImageRef | null;
};

/**
 * The take's checkpoint. `promptId` is the segment being rendered — the same
 * id `promptIdOf` reads, so a Stop finds the running prompt — and `segments`
 * is every segment's prompt and saved clip, so a restart at segment 2 fetches
 * segment 1 again instead of rendering it twice.
 */
export type VideoCheckpoint = {
	promptId: string;
	segment: 1 | 2;
	segments: VideoSegmentRecord[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isDurationSeconds(value: unknown): value is VideoDurationSeconds {
	return value === 5 || value === 10;
}

/** The request a row holds, or null when it cannot stand. Never throws. */
export function parseVideoTakeRequest(json: string): VideoTakeRequest | null {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return null;
	}
	if (!isRecord(value) || value.v !== 1) return null;
	const { prompt, durationSeconds, sourceFileId, title, summary, artifactId } =
		value;
	if (typeof prompt !== "string" || prompt.trim() === "") return null;
	if (!isDurationSeconds(durationSeconds)) return null;
	if (!isNonEmptyString(sourceFileId)) return null;
	if (typeof title !== "string" || title.trim() === "") return null;
	if (summary !== null && typeof summary !== "string") return null;
	if (artifactId !== null && !isNonEmptyString(artifactId)) return null;
	return {
		v: 1,
		prompt,
		durationSeconds,
		sourceFileId,
		title,
		summary,
		artifactId,
	};
}

function parseMedia(value: unknown): ComfyImageRef | null | undefined {
	if (value === null || value === undefined) return null;
	if (!isRecord(value)) return undefined;
	const { filename, subfolder, type } = value;
	if (typeof filename !== "string" || filename === "") return undefined;
	if (typeof subfolder !== "string") return undefined;
	if (type !== "input" && type !== "output" && type !== "temp")
		return undefined;
	return { filename, subfolder, type };
}

function parseSegments(value: unknown): VideoSegmentRecord[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return undefined;
	const segments: VideoSegmentRecord[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || !isNonEmptyString(entry.promptId)) return undefined;
		const media = parseMedia(entry.media);
		if (media === undefined) return undefined;
		segments.push({ promptId: entry.promptId, media });
	}
	return segments;
}

/** The checkpoint a row holds, or null. Never throws. */
export function parseVideoCheckpoint(
	json: string | null,
): VideoCheckpoint | null {
	if (!json) return null;
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return null;
	}
	if (!isRecord(value) || !isNonEmptyString(value.promptId)) return null;
	if (value.segment !== 1 && value.segment !== 2) return null;
	const segments = parseSegments(value.segments);
	if (!segments) return null;
	return { promptId: value.promptId, segment: value.segment, segments };
}
