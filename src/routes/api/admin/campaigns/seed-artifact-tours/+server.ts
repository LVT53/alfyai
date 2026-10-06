import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import { seedArtifactTourDrafts } from "$lib/server/services/artifact-tours";
import { campaignErrorResponse } from "../_shared";
import type { RequestHandler } from "./$types";

/**
 * Sibling of `../seed-first-run/+server.ts`, with one deliberate difference:
 * this seeds one draft per shipped tour kind (document, app, canvas —
 * `SHIPPED_ARTIFACT_TOUR_TYPES`, ruling 69), so the response is counts rather
 * than a single campaign.
 */
export const POST: RequestHandler = async (event) => {
	requireAdmin(event);
	try {
		// Named in the language of the admin who seeds them.
		const result = await seedArtifactTourDrafts(event.locals.user.id, {
			language: event.locals.user.uiLanguage,
		});
		return json(result, { status: result.created > 0 ? 201 : 200 });
	} catch (error) {
		return campaignErrorResponse(error, "Failed to seed the tour drafts.");
	}
};
