import { json } from "@sveltejs/kit";
import { AnnouncementCampaignValidationError } from "$lib/server/services/announcement-campaigns";

export function campaignErrorResponse(error: unknown, fallbackMessage: string) {
	if (error instanceof AnnouncementCampaignValidationError) {
		return json(
			{ error: error.message, fieldErrors: error.fieldErrors },
			{ status: error.status },
		);
	}
	console.error("[ANNOUNCEMENT_CAMPAIGNS] Route failure:", error);
	return json({ error: fallbackMessage }, { status: 500 });
}
