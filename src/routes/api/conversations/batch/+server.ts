import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { deleteConversationsWithCleanup } from "$lib/server/services/cleanup";
import {
	moveConversationsToProject,
	setConversationsSidebarPinned,
} from "$lib/server/services/conversations";
import { invalidateHomeSummary } from "$lib/server/services/home-summary";
import {
	CONVERSATION_BATCH_MAX_IDS,
	type ConversationBatchRequest,
} from "$lib/shared/conversation-batch";
import type { RequestHandler } from "./$types";

// At most `CONVERSATION_BATCH_MAX_IDS` ids, each a non-blank string. Ids are
// trimmed and a repeated id is dropped (the first one keeps its place), so the
// services see each chat once, in the order the person's request named them.
function parseBatchIds(value: unknown): string[] | null {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.length > CONVERSATION_BATCH_MAX_IDS
	) {
		return null;
	}
	const ids = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string" || item.trim().length === 0) {
			return null;
		}
		ids.add(item.trim());
	}
	return [...ids];
}

function parseConversationBatchRequest(
	body: unknown,
): ConversationBatchRequest | null {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return null;
	}
	const {
		action,
		ids: rawIds,
		projectId,
		pinned,
	} = body as Record<string, unknown>;
	const ids = parseBatchIds(rawIds);
	if (!ids) {
		return null;
	}

	switch (action) {
		case "delete":
			return { action, ids };
		case "move":
			// `null` takes the chats out of any project; anything else has to name one.
			if (projectId === null) {
				return { action, ids, projectId: null };
			}
			if (typeof projectId !== "string" || projectId.trim().length === 0) {
				return null;
			}
			return { action, ids, projectId: projectId.trim() };
		case "pin":
			return typeof pinned === "boolean" ? { action, ids, pinned } : null;
		default:
			return null;
	}
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const request = parseConversationBatchRequest(
		await event.request.json().catch(() => null),
	);
	if (!request) {
		return json(
			{
				error: `Expected an action ("delete", "move" or "pin") and 1 to ${CONVERSATION_BATCH_MAX_IDS} conversation ids, with projectId (a string, or null) for move and pinned (a boolean) for pin`,
			},
			{ status: 400 },
		);
	}

	try {
		switch (request.action) {
			case "delete": {
				const results = await deleteConversationsWithCleanup(
					user.id,
					request.ids,
				);
				// The new-chat page's Recent row is read from a summary held for 30
				// seconds, and a chat that went must not be listed there until it
				// expires. Dropped once for the whole batch, and only when something
				// was deleted (the single delete route's rule).
				if (results.some((result) => result.ok)) {
					invalidateHomeSummary(user.id);
				}
				return json({ results });
			}
			case "move": {
				const results = await moveConversationsToProject(
					user.id,
					request.ids,
					request.projectId,
				);
				if (!results) {
					return json({ error: "Project not found" }, { status: 404 });
				}
				return json({ results });
			}
			case "pin": {
				const results = await setConversationsSidebarPinned(
					user.id,
					request.ids,
					request.pinned,
				);
				return json({ results });
			}
		}
	} catch (error) {
		console.error("[CONVERSATION_BATCH] Failed to apply batch action", {
			action: request.action,
			error,
		});
		return json({ error: "Failed to apply batch action" }, { status: 500 });
	}
};
