// What a video take was asked to render, as the job row keeps it
// (`request_json`), plus the video's own clock: its render deadline and the
// tool wait are the video's, never the picture's (the picture's live in
// `../take-request.ts`). The tool builds a VideoTakeRequest; the runner reads
// it back through `parseVideoTakeRequest`, which trusts nothing.
//
// A take is one render: 121 frames for five seconds, 241 for ten.

import type { ComfyImageRef } from "../comfyui/types";

/** A take's product length: 5 s or 10 s, one render either way. */
export type VideoDurationSeconds = 5 | 10;

export type VideoTakeRequest = {
	v: 1;
	/** The motion caption, in the LTX caption style the tool wrote. */
	prompt: string;
	/**
	 * The caption an older row wrote for a second segment. Kept in the type and
	 * parsed so an old row still renders; nothing reads it.
	 */
	continuationPrompt?: string;
	/** 5 s by default; 10 s renders 241 frames in the same one pass. */
	durationSeconds: VideoDurationSeconds;
	/**
	 * The still the clip is made from (an `image_files` id of the person), or
	 * null for a take that starts from text.
	 */
	sourceFileId: string | null;
	/**
	 * The take's input mode: true when it renders from the caption alone, false
	 * when it renders from `sourceFileId`. Frozen when this row is written
	 * because the renderer must not re-derive it.
	 */
	fromText: boolean;
	/** The Video item's title. */
	title: string;
	/** The one-line version summary, when the caller has one. */
	summary: string | null;
	/**
	 * The Video item a later take appends a version to ("another take"), or
	 * null to make a new item. A take whose item is gone stores nothing.
	 */
	artifactId: string | null;
	/**
	 * The engine variant the take renders, frozen when this row is written; a
	 * row written before this field exists renders the first variant.
	 */
	explicitVariant: boolean;
};

/**
 * The video's own render deadline, in milliseconds. A cold 5 s render measured
 * 53 s on the production card and the 10 s pass is one longer render; 15
 * minutes also covers waiting in ComfyUI's queue behind the other engine's
 * free. Deliberately not the picture's 10 minutes.
 */
export const VIDEO_RENDER_DEADLINE_MS = 900_000;

// Test seam: a spec that must see a render run out of time in a moment, not in
// fifteen minutes. On `globalThis` so the test file's import and the app's own
// module graph (reset and re-imported per test) read the same value.
const DEADLINE_KEY = Symbol.for("alfyai.video.renderDeadlineMs");
type DeadlineHolder = { [DEADLINE_KEY]?: number };
/** The effective render deadline: the constant, or a test's shorter one. */
export function videoRenderDeadlineMs(): number {
	return (
		(globalThis as DeadlineHolder)[DEADLINE_KEY] ?? VIDEO_RENDER_DEADLINE_MS
	);
}
/** Vitest only; `undefined` puts the constant back. */
export function setVideoRenderDeadlineMsForTests(ms: number | undefined): void {
	if (!process.env.VITEST) {
		throw new Error("setVideoRenderDeadlineMsForTests is for vitest only");
	}
	if (ms === undefined) {
		delete (globalThis as DeadlineHolder)[DEADLINE_KEY];
		return;
	}
	(globalThis as DeadlineHolder)[DEADLINE_KEY] = Math.max(1, Math.trunc(ms));
}

/**
 * How long a `make_video` call waits inside the turn before leaving the take
 * on its card. Longer than the picture's 100 s because a 10 s take is one
 * 241-frame render; the take itself is detached and finishes either way.
 */
export const VIDEO_TOOL_WAIT_MS = 240_000;

/**
 * The template's frame rate and segment length: 121 frames at 24 fps. They live
 * in `comfyui/ltx-spec.ts` (which imports no JSON) and the graph builder writes
 * them into the graph, so these are the same numbers and not two copies of one.
 */
import {
	LTX_LONG_FRAMES,
	LTX_SEGMENT_FRAMES,
	LTX_VIDEO_FPS,
} from "../comfyui/ltx-spec";

export {
	LTX_SEGMENT_FRAMES as VIDEO_SEGMENT_FRAMES,
	LTX_VIDEO_FPS as VIDEO_FPS,
};
export const VIDEO_SEGMENT_DURATION_MS = 5_000;

/** The product length of the whole take. */
export function videoDurationMs(durationSeconds: VideoDurationSeconds): number {
	return durationSeconds === 10 ? 10_000 : VIDEO_SEGMENT_DURATION_MS;
}

/** The frames the graph renders for a take: one pass at 24 fps. */
export function videoFramesFor(durationSeconds: VideoDurationSeconds): number {
	return durationSeconds === 10 ? LTX_LONG_FRAMES : LTX_SEGMENT_FRAMES;
}

/** The long edge of every clip: the measured 720p product size. */
export const VIDEO_LONG_EDGE = 1280;
/** LTX works in multiples of 32 on both sides. */
export const VIDEO_SIZE_STEP = 32;
/** An abuse guard and the smallest useful short side, not a product size. */
export const VIDEO_MIN_SIDE = 256;

/**
 * A take made from text alone has no still to take an aspect from, so it
 * renders at the 16:9 product size.
 */
export const VIDEO_TEXT_SIZE = {
	width: VIDEO_LONG_EDGE,
	height: 704,
} as const;

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
		return { ...VIDEO_TEXT_SIZE };
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

/**
 * The take's checkpoint: the prompt being rendered — the same id `promptIdOf`
 * reads, so a Stop finds the running prompt — and, once the follow reported it,
 * the saved clip.
 */
export type VideoCheckpoint = {
	promptId: string;
	media: ComfyImageRef | null;
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
	const {
		prompt,
		continuationPrompt,
		durationSeconds,
		sourceFileId,
		title,
		summary,
		artifactId,
		explicitVariant,
	} = value;
	const fromText = value.fromText === true;
	if (typeof prompt !== "string" || prompt.trim() === "") return null;
	if (!isDurationSeconds(durationSeconds)) return null;
	let stillFileId: string | null = null;
	if (!fromText) {
		if (!isNonEmptyString(sourceFileId)) return null;
		stillFileId = sourceFileId;
	}
	if (typeof title !== "string" || title.trim() === "") return null;
	if (summary !== null && typeof summary !== "string") return null;
	if (artifactId !== null && !isNonEmptyString(artifactId)) return null;
	return {
		v: 1,
		prompt,
		...(typeof continuationPrompt === "string" &&
		continuationPrompt.trim() !== ""
			? { continuationPrompt }
			: {}),
		durationSeconds,
		sourceFileId: stillFileId,
		fromText,
		title,
		summary,
		artifactId,
		explicitVariant: explicitVariant === true,
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
	if (!isRecord(value)) return null;
	// A row written before a take was one render carries `segment` and
	// `segments`: its first entry is what the take resolves to.
	if (Array.isArray(value.segments)) {
		const first: unknown = value.segments[0];
		if (isRecord(first) && isNonEmptyString(first.promptId)) {
			const media = parseMedia(first.media);
			if (media !== undefined) {
				return { promptId: first.promptId, media };
			}
		}
	}
	if (!isNonEmptyString(value.promptId)) return null;
	const media = parseMedia(value.media);
	if (media === undefined) return null;
	return { promptId: value.promptId, media };
}
