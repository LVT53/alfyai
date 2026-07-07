import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { listKnowledgeMemoryTimeline } from "$lib/server/services/memory";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;

	try {
		const timeline = await listKnowledgeMemoryTimeline(user.id);
		return json(timeline);
	} catch (error) {
		console.error("[KNOWLEDGE_MEMORY] Failed to load memory timeline:", error);
		return json({ error: "Failed to load memory timeline" }, { status: 500 });
	}
};
