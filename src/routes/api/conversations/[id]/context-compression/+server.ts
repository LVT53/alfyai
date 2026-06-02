import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getOrphanedStream } from "$lib/server/services/chat-turn/active-streams";
import {
	getLatestValidContextCompressionSnapshot,
	listContextCompressionSourceMessages,
	runContextCompression,
	serializeContextCompressionSnapshot,
} from "$lib/server/services/context-compression";
import { getConversation } from "$lib/server/services/conversations";
import { sendJsonControlMessage } from "$lib/server/services/normal-chat-control-model";
import type { ModelId } from "$lib/types";
import type { RequestHandler } from "./$types";

function isModelId(value: unknown): value is ModelId {
	return (
		value === "model1" ||
		value === "model2" ||
		(typeof value === "string" && value.startsWith("provider:"))
	);
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}
	const conversationId = event.params.id;

	const conversation = await getConversation(user.id, conversationId);
	if (!conversation) {
		return json({ error: "Conversation not found" }, { status: 404 });
	}
	if (getOrphanedStream(conversationId)) {
		return json(
			{
				error:
					"Conversation is currently generating. Try again after the turn finishes.",
			},
			{ status: 409 },
		);
	}

	const body = await event.request.json().catch(() => null);
	if (!isModelId(body?.selectedModelId)) {
		return json({ error: "selectedModelId is required" }, { status: 400 });
	}
	const trigger = body?.trigger === "automatic" ? "automatic" : "manual";

	const sourceMessages =
		await listContextCompressionSourceMessages(conversationId);
	const priorSnapshot = await getLatestValidContextCompressionSnapshot({
		conversationId,
		userId: user.id,
	});
	const pendingSourceMessages = priorSnapshot
		? sourceMessages.filter(
				(message) =>
					message.messageSequence > priorSnapshot.sourceEndMessageSequence,
			)
		: sourceMessages;
	if (pendingSourceMessages.length === 0 && priorSnapshot) {
		return json({
			snapshot: serializeContextCompressionSnapshot(priorSnapshot),
		});
	}
	if (pendingSourceMessages.length === 0) {
		return json(
			{ error: "Conversation has no messages to compact" },
			{ status: 400 },
		);
	}

	const snapshot = await runContextCompression({
		conversationId,
		userId: user.id,
		trigger,
		selectedModelId: body.selectedModelId,
		controlMessageSender: sendJsonControlMessage,
		sourceMessages: pendingSourceMessages,
		priorSnapshot,
	});

	return json({ snapshot: serializeContextCompressionSnapshot(snapshot) });
};
