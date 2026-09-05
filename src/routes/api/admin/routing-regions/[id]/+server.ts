import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	getRoutingRegionManager,
	isRegionRoutingConfigured,
} from "$lib/server/services/routing/region-runtime";
import type { RequestHandler } from "./$types";

// Retry a failed region build.
export const POST: RequestHandler = async (event) => {
	requireAdmin(event);
	if (!isRegionRoutingConfigured()) {
		return json({ error: "Routing is not configured" }, { status: 409 });
	}
	const id = decodeURIComponent(event.params.id);
	const region = await getRoutingRegionManager().retryRegion(id);
	if (!region) return json({ error: "Region not found" }, { status: 404 });
	return json({ region });
};

// Remove a region: stops and removes its container and deletes its files.
export const DELETE: RequestHandler = async (event) => {
	requireAdmin(event);
	if (!isRegionRoutingConfigured()) {
		return json({ error: "Routing is not configured" }, { status: 409 });
	}
	const id = decodeURIComponent(event.params.id);
	const removed = await getRoutingRegionManager().removeRegion(id);
	if (!removed) return json({ error: "Region not found" }, { status: 404 });
	return json({ ok: true });
};
