import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getEligibleCampaignForUser } from "$lib/server/services/announcement-campaigns";
import { userHasActiveChatStream } from "$lib/server/services/chat-turn/active-streams";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user?.id;
	// An announcement never opens over a turn. A reader who reloads, or comes
	// back to a phone tab, while Alfy is still answering is offered nothing until
	// the answer is done; the next arrival asks again. Who may be shown what is
	// the service's rule; whether a card may open right now is not.
	if (userHasActiveChatStream(userId)) {
		return json({ campaign: null });
	}
	const campaign = await getEligibleCampaignForUser(userId);
	return json({ campaign });
};
