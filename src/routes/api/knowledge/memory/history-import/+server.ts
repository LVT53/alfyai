import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getHistoryImportStatus } from "$lib/server/services/memory-profile/migration-policy";
import type { RequestHandler } from "./$types";

// Older tabs may still request this status. Neither notice is available.
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const status = await getHistoryImportStatus(event.locals.user.id);
	return json({ ...status, available: false, shouldPrompt: false });
};

export const POST: RequestHandler = (event) => {
	requireAuth(event);
	return json({ error: "history_choice_retired" }, { status: 410 });
};
