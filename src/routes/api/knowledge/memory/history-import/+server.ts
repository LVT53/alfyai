import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	getHistoryImportStatus,
	recordHistoryImportChoice,
} from "$lib/server/services/memory-profile/migration-policy";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	return json(await getHistoryImportStatus(event.locals.user.id));
};
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const body: unknown = await event.request.json().catch(() => null);
	if (
		!body ||
		typeof body !== "object" ||
		!("choice" in body) ||
		!("requestId" in body) ||
		(body.choice !== "include" && body.choice !== "decline") ||
		typeof body.requestId !== "string" ||
		!body.requestId.trim() ||
		body.requestId.length > 200
	)
		return json({ error: "invalid_history_choice" }, { status: 400 });
	const current = await getHistoryImportStatus(event.locals.user.id);
	if (!current.available)
		return json({ error: "memory_replacement_unavailable" }, { status: 409 });
	try {
		return json(
			await recordHistoryImportChoice(event.locals.user.id, {
				choice: body.choice,
				requestId: body.requestId,
			}),
		);
	} catch (error) {
		if (error instanceof Error && error.message === "history_request_conflict")
			return json({ error: "history_request_conflict" }, { status: 409 });
		throw error;
	}
};
