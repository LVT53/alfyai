// The look at a picture make_image just made: the result (and, when the message
// did not carry the picture that was changed, the base under "Before:") goes to
// the model in the step after the tool result, through the turn's
// StepImageQueue and its eight-picture budget. A made picture is not an upload:
// it never rides currentImages and no image_descriptions row is made for it.
//
// Everything written here is read by the model: ASCII English (ruling 79).

import type { StepImageQueue } from "$lib/server/services/vision/step-images";
import type { TurnImage } from "$lib/server/services/vision/turn-images";
import { getImageFile, readImageFileBytes } from "./files";

const BEFORE_LABEL = "Before:";
const RESULT_NAME = "make_image result";
const BEFORE_NAME = "make_image base";

/** The label under which a made picture is shown; `beforeNumber` is the message picture it was changed from. */
export function resultLookLabel(
	takeId: string,
	beforeNumber: number | null,
): string {
	return beforeNumber === null
		? `Result of make_image (takeId ${takeId}):`
		: `Result of make_image (takeId ${takeId}), changed from picture ${beforeNumber}:`;
}

async function prepared(params: {
	userId: string;
	conversationId: string;
	fileId: string;
	name: string;
}): Promise<TurnImage | null> {
	try {
		const file = await getImageFile({
			userId: params.userId,
			fileId: params.fileId,
			conversationId: params.conversationId,
		});
		if (!file) return null;
		const bytes = await readImageFileBytes(file, "full");
		const { ATTACHMENT_MAX_LONG_EDGE, prepareImageForModel } = await import(
			"$lib/server/services/vision/prepare-image"
		);
		const image = await prepareImageForModel(bytes, "image/png", {
			maxLongEdge: ATTACHMENT_MAX_LONG_EDGE,
		});
		// Not an artifact id: a made picture is shown, not attached.
		return {
			artifactId: `image-file:${params.fileId}`,
			name: params.name,
			image,
		};
	} catch (error) {
		console.warn("[IMAGES] A made picture could not be prepared for a look", {
			reason: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Queues the look when the turn has room for it: one picture, or two when the
 * base has to be shown first. Answers whether the result was queued. With no
 * room, nothing is read; what was reserved and not queued is given back.
 */
export async function queueResultLook(params: {
	userId: string;
	conversationId: string;
	queue: StepImageQueue;
	signal: AbortSignal;
	takeId: string;
	resultFileId: string;
	/** The picture that was changed, when this was a change. */
	baseFileId: string | null;
	/** Its number in the message, when the message carried it. */
	baseNumber: number | null;
}): Promise<boolean> {
	const needsBefore = params.baseFileId !== null && params.baseNumber === null;
	const granted = params.queue.reserve(needsBefore ? 2 : 1);
	if (granted === 0) return false;
	const scope = {
		userId: params.userId,
		conversationId: params.conversationId,
	};
	const result = await prepared({
		...scope,
		fileId: params.resultFileId,
		name: RESULT_NAME,
	});
	// A call given up on pushes nothing: a late push would hand the next step
	// pictures nobody asked for.
	if (!result || params.signal.aborted) {
		params.queue.release(granted);
		return false;
	}
	let used = 1;
	if (needsBefore && granted === 2 && params.baseFileId) {
		const before = await prepared({
			...scope,
			fileId: params.baseFileId,
			name: BEFORE_NAME,
		});
		if (before && !params.signal.aborted) {
			params.queue.push({ label: BEFORE_LABEL, images: [before] });
			used = 2;
		}
	}
	params.queue.release(granted - used);
	params.queue.push({
		label: resultLookLabel(params.takeId, params.baseNumber),
		images: [result],
	});
	return true;
}
