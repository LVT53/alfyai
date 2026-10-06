import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getLatestPublishedAnnouncement } from "$lib/server/services/announcement-campaigns";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	// The version badge replays the latest published announcement: a first-run
	// onboarding or a release note. A published first-open tour is a different
	// kind of campaign and must never be what the badge opens.
	return json({ campaign: await getLatestPublishedAnnouncement() });
};
