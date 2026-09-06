// Analytics overhaul (backend half) — the client-observed half of
// activity_events (composer_command, follow_up_click, answer_now). Tool
// calls and skill use are recorded server-side at turn completion instead
// (see $lib/server/services/activity-events.ts) and are never accepted here.
import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	ACTIVITY_EVENT_NAME_MAX_LENGTH,
	checkClientActivityRateLimit,
	isClientActivityEventKind,
	recordClientActivityEvent,
} from "$lib/server/services/activity-events";
import {
	getConversationUserId,
	messageBelongsToConversation,
} from "$lib/server/services/conversations";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user.id;

	if (!checkClientActivityRateLimit(userId)) {
		return json({ error: "Too many requests" }, { status: 429 });
	}

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON body" }, { status: 400 });
	}

	if (typeof body !== "object" || body === null) {
		return json({ error: "Invalid request body" }, { status: 400 });
	}
	const payload = body as Record<string, unknown>;

	const { kind } = payload;
	if (!isClientActivityEventKind(kind)) {
		return json(
			{
				error:
					"kind must be one of composer_command, follow_up_click, answer_now",
			},
			{ status: 400 },
		);
	}

	const { name } = payload;
	if (
		typeof name !== "string" ||
		name.trim().length === 0 ||
		name.length > ACTIVITY_EVENT_NAME_MAX_LENGTH
	) {
		return json(
			{
				error: `name must be a non-empty string of at most ${ACTIVITY_EVENT_NAME_MAX_LENGTH} characters`,
			},
			{ status: 400 },
		);
	}

	const { conversationId } = payload;
	if (
		typeof conversationId !== "string" ||
		conversationId.trim().length === 0
	) {
		return json({ error: "conversationId is required" }, { status: 400 });
	}

	const { messageId } = payload;
	if (
		messageId !== undefined &&
		messageId !== null &&
		typeof messageId !== "string"
	) {
		return json({ error: "messageId must be a string" }, { status: 400 });
	}

	// The caller controls conversationId outright, and activity_events rows
	// are FK-bound to conversations (and cascade with them), so an event may
	// only ever be attached to a conversation the caller owns. A missing
	// conversation answers identically to one owned by somebody else, so the
	// endpoint is not an existence oracle for other people's conversations.
	if ((await getConversationUserId(conversationId)) !== userId) {
		return json({ error: "Conversation not found" }, { status: 403 });
	}

	// messageId is a second, independent caller-controlled input: the
	// activity_events FK only proves the message exists somewhere, not that it
	// belongs to the conversation the event is filed under. An id that is not
	// part of this conversation is dropped to null rather than rejected — the
	// event itself is still worth recording, it just loses its (unverifiable)
	// message attribution, which no read-model section depends on.
	const resolvedMessageId =
		typeof messageId === "string" &&
		messageId.length > 0 &&
		(await messageBelongsToConversation(messageId, conversationId))
			? messageId
			: null;

	await recordClientActivityEvent({
		userId,
		conversationId,
		messageId: resolvedMessageId,
		kind,
		name,
	});

	return json({ ok: true });
};
