import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	AnnouncementCampaignValidationError,
	type CampaignCompletionReason,
	completeCampaignForUser,
} from "$lib/server/services/announcement-campaigns";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const body = await event.request.json().catch(() => ({}));
	if (body?.reason !== "completed" && body?.reason !== "skipped") {
		return json(
			{ error: "reason must be completed or skipped" },
			{ status: 400 },
		);
	}
	try {
		const state = await completeCampaignForUser(
			event.params.id,
			event.locals.user?.id,
			body.reason as CampaignCompletionReason,
		);
		return json({ state });
	} catch (error) {
		if (error instanceof AnnouncementCampaignValidationError) {
			return json(
				{ error: error.message, fieldErrors: error.fieldErrors },
				{ status: error.status },
			);
		}
		console.error(
			"[ANNOUNCEMENT_CAMPAIGNS] Failed to complete campaign:",
			error,
		);
		return json({ error: "Failed to complete campaign." }, { status: 500 });
	}
};
