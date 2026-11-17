// The plan a video take's estimate counts down from (`take-eta.ts` keeps the
// time; this says what a clip is made of).
//
// What the measurements say (docs/plans/ltx-video/feasibility.md): ComfyUI
// stages the 14.6 GB encoder and the 17.8 GB transformer for every prompt,
// slowly from disk the first time and from memory after; a 5 s clip at
// 1280x704 was 53.1 s cold and 16-27 s warm, and a chained 10 s clip costs
// about two warm 5 s clips. LTX samples in two passes (eight steps, then
// three), then decodes 121 frames; after the last segment the app checks
// every frame (about 4 s per 5 s of clip) and stores the clip.

import type { EtaPlan } from "../take-eta";
import { type VideoDurationSeconds, videoSegmentCount } from "./request";

/** Staging the encoder and the transformer from disk. */
const COLD_LOAD_SECONDS = 22;
/** Staging them again from memory, as every later prompt does. */
const WARM_LOAD_SECONDS = 6;
/** The first pass's eight steps at half size, and the second's three at full size. */
const FIRST_PASS_SECONDS = 5;
const SECOND_PASS_SECONDS = 4;
/** The conv VAE's decode of a segment's 121 frames. */
const DECODE_SECONDS = 5;
/** Between segments: the first clip's last frame, read and uploaded as the next guide. */
const CHAIN_SECONDS = 1;
/** The explicit-picture check of every frame, per 5 s segment. */
const CHECK_SECONDS_PER_SEGMENT = 4;
/** The poster, the thumbnail and the store. */
const STORE_SECONDS = 1;

/**
 * The stages of a video take, segment by segment. The first prompt loads cold
 * unless LTX is still warm from a clip a moment ago; a later segment's prompt
 * restages from memory.
 */
export function videoPlan(
	durationSeconds: VideoDurationSeconds,
	warm: boolean,
): EtaPlan {
	const segments = videoSegmentCount(durationSeconds);
	const plan: Array<EtaPlan[number]> = [];
	for (let segment = 1; segment <= segments; segment += 1) {
		const last = segment === segments;
		plan.push(
			{
				kind: "load",
				seconds: segment === 1 && !warm ? COLD_LOAD_SECONDS : WARM_LOAD_SECONDS,
			},
			{ kind: "sample", seconds: FIRST_PASS_SECONDS },
			{ kind: "sample", seconds: SECOND_PASS_SECONDS },
			{
				kind: "finish",
				seconds: last
					? DECODE_SECONDS +
						CHECK_SECONDS_PER_SEGMENT * segments +
						STORE_SECONDS
					: DECODE_SECONDS + CHAIN_SECONDS,
			},
		);
	}
	return plan;
}
