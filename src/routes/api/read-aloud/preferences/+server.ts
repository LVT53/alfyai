import { requireApiUser } from "$lib/server/api/auth";
import {
	createJsonErrorResponse,
	createJsonResponse,
} from "$lib/server/api/responses";
import { getReadAloudUrl } from "$lib/server/config-store";
import {
	preferencesSchema,
	readJsonBody,
	setReadAloudPreferences,
	UnknownVoice,
} from "$lib/server/services/read-aloud";
import type { RequestHandler } from "./$types";

/**
 * Saves the person's voice for a language and their Default speed, whichever
 * are sent, and answers both as they now are. A choice must be a built-in voice
 * of its language or one of the person's own voices of it.
 */
export const PUT: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	if (getReadAloudUrl() === "")
		return createJsonErrorResponse("read_aloud_off", 404);
	const next = await readJsonBody(event.request, preferencesSchema);
	if (!next) return createJsonErrorResponse("invalid_request", 400);
	try {
		return createJsonResponse(await setReadAloudPreferences(user.id, next));
	} catch (error) {
		if (error instanceof UnknownVoice)
			return createJsonErrorResponse("unknown_voice", 400);
		throw error;
	}
};
