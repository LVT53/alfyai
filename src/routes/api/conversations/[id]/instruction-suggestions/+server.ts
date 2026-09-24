import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConversation } from "$lib/server/services/conversations";
import {
	InstructionSuggestionTransitionError,
	updateAssistantMessageInstructionSuggestionStatus,
} from "$lib/server/services/messages";
import type { RequestHandler } from "./$types";

// The two answers a user can give an offer. `pending` is deliberately not
// writeable: it is where a suggestion starts, not somewhere a client may put
// one back.
const WRITEABLE_STATUSES = ["reviewed", "dismissed"] as const;
type WriteableStatus = (typeof WRITEABLE_STATUSES)[number];

function isWriteableStatus(value: unknown): value is WriteableStatus {
	return WRITEABLE_STATUSES.includes(value as WriteableStatus);
}

/**
 * Answers one instruction suggestion the model offered in this conversation.
 *
 * The state lives in the assistant message's metadata, so the row survives a
 * reload; the write goes through the message-ownership check in the service
 * rather than this route re-deriving it. Nothing is saved as an instruction
 * here — Review opens the dialog and its own Save writes the text.
 */
export const POST: RequestHandler = async (event) => {
	requireAuth(event);

	const user = event.locals.user;
	const conversation = await getConversation(user.id, event.params.id);
	if (!conversation) {
		return json({ error: "Conversation not found." }, { status: 404 });
	}

	const body = await event.request.json().catch(() => null);
	const messageId = (body as { messageId?: unknown } | null)?.messageId;
	const suggestionId = (body as { suggestionId?: unknown } | null)
		?.suggestionId;
	const status = (body as { status?: unknown } | null)?.status;

	if (typeof messageId !== "string" || typeof suggestionId !== "string") {
		return json(
			{
				error: "A message id and a suggestion id are required.",
				errorKey: "instructions.suggestionInvalidRequest",
			},
			{ status: 400 },
		);
	}
	if (!isWriteableStatus(status)) {
		return json(
			{
				error: "A suggestion is answered as reviewed or dismissed.",
				errorKey: "instructions.suggestionInvalidStatus",
			},
			{ status: 400 },
		);
	}

	const suggestion = await updateAssistantMessageInstructionSuggestionStatus({
		userId: user.id,
		conversationId: event.params.id,
		messageId,
		suggestionId,
		status,
	}).catch((error) => {
		if (error instanceof InstructionSuggestionTransitionError) {
			return error;
		}
		throw error;
	});

	if (suggestion instanceof InstructionSuggestionTransitionError) {
		return json(
			{ error: suggestion.message, errorKey: suggestion.code },
			{ status: suggestion.status },
		);
	}
	if (!suggestion) {
		return json(
			{
				error: "Instruction suggestion not found.",
				errorKey: "instructions.suggestionNotFound",
			},
			{ status: 404 },
		);
	}

	return json({ suggestion });
};
