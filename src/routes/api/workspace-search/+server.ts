import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { searchWorkspace } from "$lib/server/services/workspace-search";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const query =
		event.url.searchParams.get("q") ??
		event.url.searchParams.get("query") ??
		"";

	return json(await searchWorkspace(user.id, { query }));
};
