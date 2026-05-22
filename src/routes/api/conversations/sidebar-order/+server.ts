import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	listConversations,
	savePinnedConversationSidebarOrder,
} from "$lib/server/services/conversations";
import type { RequestHandler } from "./$types";

function parseOrderedIds(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	if (
		!value.every((item) => typeof item === "string" && item.trim().length > 0)
	) {
		return null;
	}
	return value.map((item) => item.trim());
}

export const PATCH: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}
	const body = await event.request.json().catch(() => null);
	const orderedIds = parseOrderedIds(body?.orderedIds);
	if (!orderedIds) {
		return json(
			{ error: "orderedIds must be an array of conversation ids" },
			{ status: 400 },
		);
	}

	try {
		await savePinnedConversationSidebarOrder(user.id, orderedIds);
	} catch (error) {
		return json(
			{
				error: error instanceof Error ? error.message : "Invalid sidebar order",
			},
			{ status: 400 },
		);
	}

	const conversations = await listConversations(user.id);
	return json({ conversations });
};
