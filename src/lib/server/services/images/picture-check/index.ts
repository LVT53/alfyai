// The explicit-picture filter's check of one finished picture, as the image
// runner asks it: whether the person is filtered at all (policy.ts), then the
// local classifier (classifier.ts). Fails closed: a check that cannot run
// answers "unchecked", and the runner keeps nothing.

import { classifyPicture } from "./classifier";
import { isExplicitFilterOnFor } from "./policy";

export type FinishedPictureCheck = "not_filtered" | "shown" | "blocked" | "unchecked";

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
