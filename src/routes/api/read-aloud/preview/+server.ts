import { requireApiUser } from "$lib/server/api/auth";
import { createJsonErrorResponse } from "$lib/server/api/responses";
import { getReadAloudUrl } from "$lib/server/config-store";
import {
	builtInVoice,
	PreviewSuperseded,
	previewRequestSchema,
	readJsonBody,
	renderPreview,
	resolvedVoice,
	SpeechRefused,
} from "$lib/server/services/read-aloud";
import { ownWords, VOICE_SAMPLES } from "$lib/shared/read-aloud/voice-samples";
import type { RequestHandler } from "./$types";

/**
 * Speaks the base voice's sample, or the person's own words, with the knobs
 * they have set, as one MP3 with its length and the time each sentence starts
 * and ends (`X-Read-Aloud-Sentences`). A person has one preview at a time: a
 * newer one makes the older answer 409. Nothing about the words is logged.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const baseUrl = getReadAloudUrl();
	if (baseUrl === "") return createJsonErrorResponse("read_aloud_off", 404);
	const request = await readJsonBody(event.request, previewRequestSchema);
	if (!request) return createJsonErrorResponse("invalid_request", 400);
	const base = builtInVoice(request.base);
	if (!base) return createJsonErrorResponse("unknown_voice", 400);

	let sentences: readonly string[];
	if (request.text === undefined) {
		sentences = VOICE_SAMPLES[base.language];
	} else {
		const words = ownWords(request.text);
		if (words === null) return createJsonErrorResponse("invalid_request", 400);
		sentences = [words];
	}

	try {
		const preview = await renderPreview({
			userId: user.id,
			baseUrl,
			voice: resolvedVoice(base, request.knobs),
			language: base.language,
			sentences,
		});
		return new Response(preview.audio, {
			status: 200,
			headers: {
				"Content-Type": "audio/mpeg",
				"Content-Length": String(preview.audio.length),
				"Cache-Control": "no-store",
				"X-Read-Aloud-Sentences": JSON.stringify(preview.sentences),
			},
		});
	} catch (error) {
		if (error instanceof PreviewSuperseded)
			return createJsonErrorResponse("superseded", 409);
		if (error instanceof SpeechRefused && error.field === "text")
			return createJsonErrorResponse("nothing_to_say", 422);
		// What failed and, for a refusal, its status and the field: never a word of the preview.
		console.warn("[READ_ALOUD] the speech service did not make a preview", {
			kind: error instanceof Error ? error.name : null,
			status: error instanceof SpeechRefused ? error.status : null,
			field: error instanceof SpeechRefused ? error.field : null,
		});
		return createJsonErrorResponse("voice_unavailable", 503);
	}
};
