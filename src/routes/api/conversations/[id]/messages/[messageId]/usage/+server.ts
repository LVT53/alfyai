import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getMessageUsageState } from "$lib/server/services/analytics";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const state = await getMessageUsageState(
		event.locals.user.id,
		event.params.id,
		event.params.messageId,
	);
	return state
		? json(state, {
				status: state.status === "pending" ? 202 : 200,
				headers: { "Cache-Control": "no-store" },
			})
		: json({ error: "Message not found" }, { status: 404 });
};
