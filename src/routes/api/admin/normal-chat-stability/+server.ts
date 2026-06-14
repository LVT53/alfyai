import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import { getNormalChatStabilitySnapshot } from "$lib/server/services/normal-chat-stability-snapshot";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	const snapshot = await getNormalChatStabilitySnapshot();
	return json({ snapshot });
};
