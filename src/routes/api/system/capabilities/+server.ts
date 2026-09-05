import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	getToolHealthSnapshot,
	projectDegradedCapabilities,
	TOOL_HEALTH_DEFAULT_MAX_AGE_MS,
} from "$lib/server/services/tool-health";
import type { RequestHandler } from "./$types";

// Any signed-in user may read which tools are degraded; details stay admin-only.
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const snapshot = await getToolHealthSnapshot({
		maxAgeMs: TOOL_HEALTH_DEFAULT_MAX_AGE_MS,
	});
	return json(projectDegradedCapabilities(snapshot));
};
