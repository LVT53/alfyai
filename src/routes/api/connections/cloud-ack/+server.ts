import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { recordCloudConnectorAck } from "$lib/server/services/connections/locality";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);

	await recordCloudConnectorAck(user.id);

	return json({ ok: true });
};
