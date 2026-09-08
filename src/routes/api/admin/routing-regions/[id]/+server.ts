import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	getRoutingRegionManager,
	isRegionRoutingConfigured,
} from "$lib/server/services/routing/region-runtime";
import type { RequestHandler } from "./$types";

// Retry a failed region build, or — with { action: "refresh_transit" } —
// re-download the region's GTFS feed and rebuild only its public-transport
// graph, ignoring the nightly refresh window.
export const POST: RequestHandler = async (event) => {
	requireAdmin(event);
	if (!isRegionRoutingConfigured()) {
		return json({ error: "Routing is not configured" }, { status: 409 });
	}
	const body = (await event.request.json().catch(() => null)) as {
		action?: unknown;
	} | null;
	const id = decodeURIComponent(event.params.id);
	const manager = getRoutingRegionManager();
	const region =
		body?.action === "refresh_transit"
			? await manager.refreshTransit(id)
			: await manager.retryRegion(id);
	if (!region) return json({ error: "Region not found" }, { status: 404 });
	return json({ region });
};

// Toggle whether a region is resident (kept downloaded and running).
export const PATCH: RequestHandler = async (event) => {
	requireAdmin(event);
	if (!isRegionRoutingConfigured()) {
		return json({ error: "Routing is not configured" }, { status: 409 });
	}
	const body = (await event.request.json().catch(() => null)) as {
		resident?: unknown;
	} | null;
	if (!body || typeof body.resident !== "boolean") {
		return json({ error: "Provide { resident: boolean }" }, { status: 400 });
	}
	const id = decodeURIComponent(event.params.id);
	const region = await getRoutingRegionManager().setResident(id, body.resident);
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
