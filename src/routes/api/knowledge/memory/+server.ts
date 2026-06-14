import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getKnowledgeMemory } from "$lib/server/services/memory";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;

	try {
		const memory = await getKnowledgeMemory(user.id, user.displayName);
		return json(memory);
	} catch (error) {
		console.error("[KNOWLEDGE_MEMORY] Failed to load knowledge memory:", error);
		return json({ error: "Failed to load memory profile" }, { status: 500 });
	}
};
