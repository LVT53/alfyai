import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	getKnowledgeMemorySummary,
	legacyMemoryAvailable,
} from "$lib/server/services/memory";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	if (!legacyMemoryAvailable(event.locals.user.id))
		return json({ error: "memory_api_replaced" }, { status: 410 });
	const user = event.locals.user;

	try {
		const summary = await getKnowledgeMemorySummary(user.id);
		return json(summary);
	} catch (error) {
		console.error("[KNOWLEDGE_MEMORY] Failed to load memory summary:", error);
		return json({ error: "Failed to load memory summary" }, { status: 500 });
	}
};
