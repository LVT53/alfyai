import { requireApiUser } from "$lib/server/api/auth";
import {
	createJsonErrorResponse,
	createJsonResponse,
} from "$lib/server/api/responses";
import { getReadAloudUrl } from "$lib/server/config-store";
import {
	deletePersonalVoice,
	readJsonBody,
	UnknownVoice,
	updatePersonalVoice,
	voicePatchSchema,
} from "$lib/server/services/read-aloud";
import type { RequestHandler } from "./$types";

/** Changes one of the person's own voices. A voice that is not theirs is 404, whoever's it is. */
export const PATCH: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	if (getReadAloudUrl() === "")
		return createJsonErrorResponse("read_aloud_off", 404);
	const patch = await readJsonBody(event.request, voicePatchSchema);
	if (!patch) return createJsonErrorResponse("invalid_request", 400);
	try {
		const voice = await updatePersonalVoice(user.id, event.params.id, patch);
		if (!voice) return createJsonErrorResponse("not_found", 404);
		return createJsonResponse({ voice });
	} catch (error) {
		if (error instanceof UnknownVoice)
			return createJsonErrorResponse("unknown_voice", 400);
		throw error;
	}
};

/**
 * Deletes one of the person's own voices and answers their choice after: a
 * choice that pointed at it is back on the voice it was made from. A voice
 * that is not theirs is 404.
 */
export const DELETE: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	if (getReadAloudUrl() === "")
		return createJsonErrorResponse("read_aloud_off", 404);
	const choice = await deletePersonalVoice(user.id, event.params.id);
	if (!choice) return createJsonErrorResponse("not_found", 404);
	return createJsonResponse({ choice });
};
