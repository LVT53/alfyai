import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { recordImageLoad } from "$lib/server/services/image-search-analytics/display";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const body = await event.request.json().catch(() => null);
	if (
		!body ||
		typeof body.messageId !== "string" ||
		!body.messageId ||
		body.messageId.length > 128 ||
		typeof body.imageKey !== "string" ||
		!/^[a-f0-9]{64}$/.test(body.imageKey) ||
		(body.outcome !== "loaded" && body.outcome !== "failed")
	) {
		return json({ error: "Invalid picture report" }, { status: 400 });
	}
	await recordImageLoad(
		event.locals.user.id,
		body.messageId,
		body.imageKey,
		body.outcome,
	);
	return new Response(null, { status: 204 });
};
