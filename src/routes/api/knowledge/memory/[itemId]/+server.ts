import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getKnowledgeMemoryItemDetail } from "$lib/server/services/memory";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	try {
		const detail = await getKnowledgeMemoryItemDetail(
			user.id,
			event.params.itemId,
		);
		if (!detail) {
			return json({ error: "Memory item not found" }, { status: 404 });
		}
		return json(detail);
	} catch (error) {
		console.error("[KNOWLEDGE_MEMORY] Failed to load memory item:", error);
		return json({ error: "Failed to load memory item" }, { status: 500 });
	}
};
