import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getKnowledgeMemoryOverview } from "$lib/server/services/memory";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const force = event.url.searchParams.get("force") === "1";

	try {
		const overview = await getKnowledgeMemoryOverview(
			user.id,
			user.displayName,
			{
				force,
			},
		);
		return json(overview);
	} catch (error) {
		console.error(
			"[KNOWLEDGE_MEMORY] Failed to refresh knowledge overview:",
			error,
		);
		return json(
			{ error: "Failed to refresh the live memory overview" },
			{ status: 500 },
		);
	}
};
