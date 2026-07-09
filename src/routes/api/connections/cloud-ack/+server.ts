import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { recordCloudConnectorAck } from "$lib/server/services/connections/locality";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);

	await recordCloudConnectorAck(event.locals.user.id);

	return json({ ok: true });
};
