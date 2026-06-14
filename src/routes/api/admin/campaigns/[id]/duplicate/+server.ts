import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import { duplicateCampaignAsDraft } from "$lib/server/services/announcement-campaigns";
import { campaignErrorResponse } from "../../_shared";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAdmin(event);
	try {
		const campaign = await duplicateCampaignAsDraft(
			event.params.id,
			event.locals.user?.id,
		);
		return json({ campaign }, { status: 201 });
	} catch (error) {
		return campaignErrorResponse(error, "Failed to duplicate campaign.");
	}
};
