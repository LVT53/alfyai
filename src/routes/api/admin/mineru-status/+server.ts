import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import { getMineruStatusReport } from "$lib/server/services/mineru/capabilities";
import type { RequestHandler } from "./$types";

/**
 * What the configured MinerU server says about itself, for the Integrations
 * page's status card.
 *
 * GET serves the cached probe; `?refresh=1` forces a live one, which is what
 * the card's "Re-check" button sends. The report never carries the API key and
 * never carries anything but the endpoint's origin.
 */
export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	const refresh = event.url.searchParams.get("refresh") === "1";
	return json({ report: await getMineruStatusReport({ refresh }) });
};
