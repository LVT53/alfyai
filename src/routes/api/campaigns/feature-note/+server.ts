import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getEligibleFeatureNoteForUser } from "$lib/server/services/announcement-campaigns";
import { userHasActiveChatStream } from "$lib/server/services/chat-turn/active-streams";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user?.id;
	// A note never interrupts a turn. A reader who reloads, or comes back to a
	// phone tab, while Alfy is still answering is offered nothing until the
	// answer is done; the next landing arrival asks again. Who may see the note
	// is the service's rule; whether one may show right now is not.
	if (userHasActiveChatStream(userId)) {
		return json({ note: null });
	}
	const note = await getEligibleFeatureNoteForUser(userId);
	return json({ note });
};
