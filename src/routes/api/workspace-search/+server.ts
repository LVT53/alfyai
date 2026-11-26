import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { searchWorkspace } from "$lib/server/services/workspace-search";
import { parseWorkspaceSearchScope } from "$lib/server/services/workspace-search/types";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const params = event.url.searchParams;
	const query = params.get("q") ?? params.get("query") ?? "";

	return json(
		await searchWorkspace(user.id, {
			query,
			scope: parseWorkspaceSearchScope(params.get("scope")),
			cursor: params.get("cursor"),
		}),
	);
};
