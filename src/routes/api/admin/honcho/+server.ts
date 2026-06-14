import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import { checkHealth } from "$lib/server/services/honcho";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);

	const health = await checkHealth();
	return json(health);
};
