import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	deleteCampaignDraft,
	getCampaignAnalyticsSummary,
	getCampaignById,
	updateCampaignDraft,
} from "$lib/server/services/announcement-campaigns";
import { campaignErrorResponse } from "../_shared";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	const campaign = await getCampaignById(event.params.id);
	if (!campaign) {
		return json({ error: "Campaign not found" }, { status: 404 });
	}
	const analyticsSummary = await getCampaignAnalyticsSummary(event.params.id);
	return json({ campaign: { ...campaign, analyticsSummary } });
};

export const PATCH: RequestHandler = async (event) => {
	requireAdmin(event);
	const body = await event.request.json().catch(() => ({}));
	try {
		const campaign = await updateCampaignDraft(event.params.id, body);
		return json({ campaign });
	} catch (error) {
		return campaignErrorResponse(error, "Failed to update campaign draft.");
	}
};

export const DELETE: RequestHandler = async (event) => {
	requireAdmin(event);
	try {
		await deleteCampaignDraft(event.params.id);
		return json({ success: true });
	} catch (error) {
		return campaignErrorResponse(error, "Failed to delete campaign draft.");
	}
};
