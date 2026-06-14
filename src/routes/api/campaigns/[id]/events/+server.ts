import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	AnnouncementCampaignValidationError,
	type CampaignEventType,
	recordCampaignEvent,
} from "$lib/server/services/announcement-campaigns";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const body = await event.request.json().catch(() => ({}));
	try {
		const eventRow = await recordCampaignEvent({
			campaignId: event.params.id,
			userId: event.locals.user?.id,
			eventType: body?.eventType as CampaignEventType,
			slideId: body?.slideId,
			metadata: body?.metadata,
		});
		return json({ event: eventRow }, { status: 201 });
	} catch (error) {
		if (error instanceof AnnouncementCampaignValidationError) {
			return json(
				{ error: error.message, fieldErrors: error.fieldErrors },
				{ status: error.status },
			);
		}
		console.error("[ANNOUNCEMENT_CAMPAIGNS] Failed to record event:", error);
		return json({ error: "Failed to record campaign event." }, { status: 500 });
	}
};
