import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConversationCostSummary } from "$lib/server/services/analytics";
import { getConversation } from "$lib/server/services/conversations";
import { getConversationContextStatus } from "$lib/server/services/knowledge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const conversation = await getConversation(user.id, event.params.id);
	if (!conversation) {
		return json({ error: "Conversation not found" }, { status: 404 });
	}

	const [contextStatus, costSummary] = await Promise.all([
		getConversationContextStatus(user.id, event.params.id),
		getConversationCostSummary(event.params.id),
	]);

	return json({
		contextStatus,
		totalCostUsdMicros: costSummary.totalCostUsdMicros,
		totalTokens: costSummary.totalTokens,
	});
};
