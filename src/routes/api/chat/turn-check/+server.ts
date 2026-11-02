import type { RequestHandler } from "@sveltejs/kit";
import {
	createJsonErrorResponse,
	createJsonResponse,
} from "$lib/server/api/responses";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import {
	checkChatTurn,
	createStreamJsonErrorResponse,
	parseChatTurnRequest,
	refuseTurnWhenOverCapacity,
} from "$lib/server/services/chat-turn";

// Whether the turn's gate would take this request, asked without starting a turn
// and without writing anything. The body is the stream's; a refusal is the stream's
// refusal, status and body. The edit of a message asks it before it deletes the
// message, because the resend meets the same gate only after the delete.
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return createJsonErrorResponse("Unauthorized", 401);
	}

	const parsedRequest = await parseChatTurnRequest(
		event.request,
		getConfig(),
		"stream",
	);
	if (!parsedRequest.ok) {
		return createStreamJsonErrorResponse(parsedRequest.error);
	}

	// The stream route turns a turn away before it admits it when this user's reply
	// is still running or the server is draining; the resend would be turned away
	// the same way, after the delete, so the check says so first.
	const refused = refuseTurnWhenOverCapacity(user.id, "CHAT_TURN_CHECK");
	if (refused) return refused;

	const checked = await checkChatTurn({
		userId: user.id,
		request: parsedRequest.value,
		signal: event.request.signal,
	});
	if (!checked.ok) {
		return createStreamJsonErrorResponse(checked.error);
	}
	return createJsonResponse({ ok: true });
};
