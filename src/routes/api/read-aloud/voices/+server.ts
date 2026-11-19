import { requireApiUser } from "$lib/server/api/auth";
import {
	createJsonErrorResponse,
	createJsonResponse,
} from "$lib/server/api/responses";
import { getReadAloudUrl } from "$lib/server/config-store";
import {
	createPersonalVoice,
	listBuiltInVoices,
	readAloudSettingsFor,
	readJsonBody,
	TooManyVoices,
	UnknownVoice,
	voiceDraftSchema,
} from "$lib/server/services/read-aloud";
import type { RequestHandler } from "./$types";

/**
 * The Read aloud card's data: the built-in voices, the person's own voices,
 * their choice for each language and their Default speed. Only the person's
 * own: the service filters every query by their id.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	if (getReadAloudUrl() === "")
		return createJsonErrorResponse("read_aloud_off", 404);
	const settings = await readAloudSettingsFor(user.id);
	return createJsonResponse({ builtIn: listBuiltInVoices(), ...settings });
};

/** Makes a voice of the person's own from a built-in voice and five knobs. */
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	if (getReadAloudUrl() === "")
		return createJsonErrorResponse("read_aloud_off", 404);
	const draft = await readJsonBody(event.request, voiceDraftSchema);
	if (!draft) return createJsonErrorResponse("invalid_request", 400);
	try {
		return createJsonResponse(
			{ voice: await createPersonalVoice(user.id, draft) },
			201,
		);
	} catch (error) {
		if (error instanceof UnknownVoice)
			return createJsonErrorResponse("unknown_voice", 400);
		if (error instanceof TooManyVoices)
			return createJsonErrorResponse("too_many", 409);
		throw error;
	}
};
