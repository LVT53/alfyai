// The explicit-picture filter's check of one finished picture, as the image
// runner asks it: whether the person is filtered at all (policy.ts), then the
// local classifier (classifier.ts). Fails closed: a check that cannot run
// answers "unchecked", and the runner keeps nothing.

import {
	classifyPicture,
	classifyPictureFrames,
	PICTURE_CHECK_BATCH_SIZE,
} from "./classifier";
import { isExplicitFilterOnFor } from "./policy";

export type FinishedPictureCheck =
	| "not_filtered"
	| "shown"
	| "blocked"
	| "unchecked";

export async function checkFinishedPicture(input: {
	userId: string;
	takeId: string;
	png: Uint8Array;
}): Promise<FinishedPictureCheck> {
	if (!(await isExplicitFilterOnFor(input.userId))) return "not_filtered";
	try {
		const verdict = await classifyPicture(input.png);
		// Content-free: the take, the verdict and the time, never the picture.
		console.info("[IMAGES] Picture check", {
			takeId: input.takeId,
			blocked: verdict.explicit,
			ms: verdict.ms,
		});
		return verdict.explicit ? "blocked" : "shown";
	} catch (error) {
		console.warn("[IMAGES] The picture could not be checked", {
			takeId: input.takeId,
			reason: error instanceof Error ? error.message : String(error),
		});
		return "unchecked";
	}
}

/**
 * The same filter for a whole clip: `frames` are raw rgb24 frames at the
 * model's 224 x 224, in order, and they are classified every one — in batches
 * of `PICTURE_CHECK_BATCH_SIZE` on one session, so 121 frames are 8 inference
 * runs rather than 121. A batch that cannot run makes the clip `unchecked`
 * (fail closed), and the first batch holding an explicit frame makes it
 * `blocked`; either way nothing is stored.
 */
export async function checkFinishedFrames(input: {
	userId: string;
	takeId: string;
	frames: readonly Uint8Array[];
	/** The take's Stop: once aborted, no further batch starts (the clip is not kept). */
	signal?: AbortSignal;
	/** Epoch milliseconds; a batch that would start after it makes the clip unchecked. */
	deadlineAt?: number;
}): Promise<FinishedPictureCheck> {
	if (!(await isExplicitFilterOnFor(input.userId))) return "not_filtered";
	if (input.frames.length === 0) return "unchecked";
	try {
		for (let at = 0; at < input.frames.length; at += PICTURE_CHECK_BATCH_SIZE) {
			if (input.signal?.aborted) return "unchecked";
			if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
				return "unchecked";
			}
			const batch = input.frames.slice(at, at + PICTURE_CHECK_BATCH_SIZE);
			const verdicts = await classifyPictureFrames(batch);
			const blocked = verdicts.some((verdict) => verdict.explicit);
			// Content-free: the take, the batch size, the verdict and the time.
			console.info("[IMAGES] Picture check", {
				takeId: input.takeId,
				frames: verdicts.length,
				blocked,
				ms: verdicts.at(-1)?.ms ?? 0,
			});
			if (blocked) return "blocked";
		}
		return "shown";
	} catch (error) {
		console.warn("[IMAGES] The picture could not be checked", {
			takeId: input.takeId,
			reason: error instanceof Error ? error.message : String(error),
		});
		return "unchecked";
	}
}
