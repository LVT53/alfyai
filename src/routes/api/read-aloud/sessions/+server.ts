import { requireApiUser } from "$lib/server/api/auth";
import {
	createJsonErrorResponse,
	createJsonResponse,
} from "$lib/server/api/responses";
import { getReadAloudUrl } from "$lib/server/config-store";
import { getConversation } from "$lib/server/services/conversations";
import { getReplyForDocumentKeep } from "$lib/server/services/messages";
import {
	charsPerSecondByLanguage,
	openReading,
	ReadingSuperseded,
	readingRequestSchema,
	resolveReadingVoices,
	SpeechRefused,
	speechSentencesFor,
	takeOpenTicket,
	wordsFitReply,
} from "$lib/server/services/read-aloud";
import type { RequestHandler } from "./$types";

/**
 * Starts a reading of a reply: checks that the person owns the conversation,
 * that every written word occurs in the reply's text in order and that its
 * tokens are the shared dictionary's reading of it, then opens a session on the
 * speech service. The answers are in the plan's browser-to-app contract.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	// The person's place in line, before anything is awaited: presses open in the
	// order they arrived, however long each one's checks take.
	const ticket = takeOpenTicket(user.id);
	const baseUrl = getReadAloudUrl();
	if (baseUrl === "") return createJsonErrorResponse("read_aloud_off", 404);

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return createJsonErrorResponse("invalid_request", 400);
	}
	const parsed = readingRequestSchema.safeParse(body);
	if (!parsed.success) return createJsonErrorResponse("invalid_request", 400);
	const { conversationId, messageId, sentences } = parsed.data;

	if (!(await getConversation(user.id, conversationId)))
		return createJsonErrorResponse("not_found", 404);
	// A reply as the person reads it: its "Ask me first" segments walked back
	// from the last one, the way Copy takes them.
	const reply = await getReplyForDocumentKeep({ conversationId, messageId });
	if (!reply) return createJsonErrorResponse("not_found", 404);

	const outside = wordsFitReply(reply.content, sentences);
	if (outside !== null) {
		// The index and the count only: never a word of the request or the reply.
		console.warn("[READ_ALOUD] a request is not in its reply", {
			sentence: outside,
			sentences: sentences.length,
		});
		return createJsonErrorResponse("not_in_reply", 422);
	}

	// The voice each language reads with, and the speed a reading starts at, are
	// the person's own choices; anything that is not theirs reads as the default.
	const { voices, defaultSpeed } = await resolveReadingVoices(user.id);

	try {
		const reading = await openReading({
			userId: user.id,
			baseUrl,
			sentences: speechSentencesFor(parsed.data, voices),
			ticket,
		});
		return createJsonResponse(
			{
				sessionId: reading.sessionId,
				defaultSpeed,
				charsPerSecond: charsPerSecondByLanguage(voices),
			},
			201,
		);
	} catch (error) {
		// A press that came after this one has opened: this one is stale, and the
		// browser has dropped it already.
		if (error instanceof ReadingSuperseded)
			return createJsonErrorResponse("superseded", 409);
		// A 422 from the service would mean this schema let through something it
		// refuses: say its status and the field, never the text.
		console.warn("[READ_ALOUD] the speech service did not start a reading", {
			status: error instanceof SpeechRefused ? error.status : null,
			field: error instanceof SpeechRefused ? error.field : null,
		});
		return createJsonErrorResponse("voice_unavailable", 503);
	}
};
