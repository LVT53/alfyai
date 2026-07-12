import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { listConnectionsForUser } from "$lib/server/services/connections/store";
import type { RequestHandler } from "./$types";

// GET /api/connections — lists the authenticated user's connections. The
// ConnectionPublic DTO (store.ts) already excludes every secret field, so
// this route never needs to redact anything itself.
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const connections = await listConnectionsForUser(user.id);
	return json({ connections });
};
