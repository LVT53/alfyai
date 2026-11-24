// The plan a video take's estimate counts down from (`take-eta.ts` keeps the
// time; this says what a clip is made of).
//
// What the measurements say (docs/plans/ltx-video/feasibility.md): ComfyUI
// stages the 14.6 GB encoder and the 17.8 GB transformer for every prompt,
// slowly from disk the first time and from memory after; a 5 s clip at
// 1280x704 was 53.1 s cold and 16-27 s warm on the graph as it was then (the
// numbers below are the ones that count now). LTX samples in two passes
// (eight steps, then three), then decodes the frames (121 for 5 s, 241 for
// 10 s); after the render the app checks every frame (about 4 s per 5 s of
// clip) and stores the clip.

import type { EtaPlan } from "../take-eta";
import type { VideoDurationSeconds } from "./request";

/**
 * What a clip's render costs now, measured on the production card with the
 * sharpen pass and the x2 upscale both in the graph (journal, 2026-11-22):
 * five seconds is ~56 s and ten seconds is ~114 s, steady across repeats. Both
 * are ONE render, so the numbers are the whole render.
 */
const WARM_RENDER_SECONDS: Record<VideoDurationSeconds, number> = {
	5: 56,
	10: 114,
};
/** Staging the encoder and the transformer from memory, and from disk when cold. */
const LOAD_SECONDS = 6;
const COLD_EXTRA_SECONDS = 5;
/** The share of the render the first pass, the second pass and the decode take. */
const FIRST_PASS_SHARE = 0.36;
const SECOND_PASS_SHARE = 0.28;
const DECODE_SHARE = 0.36;
/** The explicit-picture check of every frame, per five seconds of clip. */
const CHECK_SECONDS_PER_FIVE_SECONDS_OF_CLIP = 4;
/** The poster, the thumbnail and the store. */
const STORE_SECONDS = 1;

/**
 * The stages of a video take, which is one render. It loads cold unless LTX is
 * still warm from a clip a moment ago.
 */
export function videoPlan(
	durationSeconds: VideoDurationSeconds,
	warm: boolean,
): EtaPlan {
	// One render per take: the measured render, split across the three stages it
	// is made of, plus what the app does afterwards.
	const load = LOAD_SECONDS + (warm ? 0 : COLD_EXTRA_SECONDS);
	const body = WARM_RENDER_SECONDS[durationSeconds] - LOAD_SECONDS;
	return [
		{ kind: "load", seconds: load },
		{ kind: "sample", seconds: body * FIRST_PASS_SHARE },
		{ kind: "sample", seconds: body * SECOND_PASS_SHARE },
		{
			kind: "finish",
			seconds:
				body * DECODE_SHARE +
				CHECK_SECONDS_PER_FIVE_SECONDS_OF_CLIP * (durationSeconds / 5) +
				STORE_SECONDS,
		},
	];
}
