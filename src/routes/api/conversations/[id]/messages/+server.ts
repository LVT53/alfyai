import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getOlderConversationMessages } from "$lib/server/services/conversation-detail/read-model";
import { listChildForksBySourceMessages } from "$lib/server/services/conversation-forks";
import { getConversation } from "$lib/server/services/conversations";
import { deleteMessages, listMessages } from "$lib/server/services/messages";
import type { RequestHandler } from "./$types";

const FORKED_SOURCE_HISTORY_CONFIRMATION_REQUIRED_CODE =
	"forked_source_history_confirmation_required";

// O1 pagination — "load older messages" for a conversation whose initial
// window (served by GET /api/conversations/[id]) didn't include the full
// history. A thin auth/HTTP adapter over the read model, matching
// ADR-0022's boundary: parse/validate query params, delegate assembly to
// `getOlderConversationMessages`, map a missing conversation to 404.
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const { id } = event.params;
	const offsetParam = Number(event.url.searchParams.get("offset"));
	const limitParam = event.url.searchParams.get("limit");
	const offset =
		Number.isFinite(offsetParam) && offsetParam > 0 ? offsetParam : 0;
	const limit = limitParam ? Number(limitParam) : undefined;

	const page = await getOlderConversationMessages({
		userId: user.id,
		conversationId: id,
		offset,
		limit: limit && Number.isFinite(limit) && limit > 0 ? limit : undefined,
	});

	if (!page) {
		return json({ error: "Conversation not found" }, { status: 404 });
	}

	return json(page);
};

export const DELETE: RequestHandler = async (event) => {
	try {
		requireAuth(event);
		const user = event.locals.user;
		const { id } = event.params;

		const conversation = await getConversation(user.id, id);
		if (!conversation) {
			return json({ error: "Conversation not found" }, { status: 404 });
		}

		const body = await event.request.json().catch(() => null);
		if (
			!body ||
			!Array.isArray(body.messageIds) ||
			body.messageIds.length === 0
		) {
			return json({ error: "messageIds array is required" }, { status: 400 });
		}

		const messageIds: string[] = body.messageIds.filter(
			(id: unknown) => typeof id === "string",
		);
		const confirmedForkedSourceHistoryMutation =
			body.confirmForkedSourceHistoryMutation === true;

		// Verify all messages belong to this conversation before deleting
		const existingMessages = await listMessages(id);
		const existingIds = new Set(existingMessages.map((m) => m.id));
		const safeIds = messageIds.filter((mid) => existingIds.has(mid));
		const safeIdSet = new Set(safeIds);
		const assistantMessageIds = existingMessages
			.filter(
				(message) => message.role === "assistant" && safeIdSet.has(message.id),
			)
			.map((message) => message.id);

		if (
			assistantMessageIds.length > 0 &&
			!confirmedForkedSourceHistoryMutation
		) {
			const childForks = await listChildForksBySourceMessages(
				user.id,
				assistantMessageIds,
			);
			const hasChildForks = Object.values(childForks).some(
				(sourceForks) => (sourceForks.count ?? 0) > 0,
			);
			if (hasChildForks) {
				return json(
					{
						error: "Forked source history requires confirmation",
						code: FORKED_SOURCE_HISTORY_CONFIRMATION_REQUIRED_CODE,
						errorKey: "fork.editWarning",
					},
					{ status: 409 },
				);
			}
		}

		await deleteMessages(safeIds);

		return json({ deleted: safeIds.length });
	} catch (err) {
		console.error("Error deleting messages:", err);
		return json({ error: "Failed to delete messages" }, { status: 500 });
	}
};
