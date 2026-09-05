import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	getRoutingRegionManager,
	isRegionRoutingConfigured,
} from "$lib/server/services/routing/region-runtime";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	if (!isRegionRoutingConfigured()) {
		return json({ configured: false, regions: [] });
	}
	const regions = await getRoutingRegionManager().listRegions();
	return json({ configured: true, regions });
};

// Request a region by Geofabrik id ({ id }) or by coordinate ({ lat, lng }).
export const POST: RequestHandler = async (event) => {
	requireAdmin(event);
	if (!isRegionRoutingConfigured()) {
		return json({ error: "Routing is not configured" }, { status: 409 });
	}
	const body = (await event.request.json().catch(() => null)) as {
		id?: unknown;
		lat?: unknown;
		lng?: unknown;
	} | null;
	const manager = getRoutingRegionManager();
	const requestedBy = event.locals.user.id;
	if (body && typeof body.id === "string" && body.id.trim()) {
		const outcome = await manager.requestRegion(
			{ id: body.id.trim() },
			{ requestedBy },
		);
		return json({ outcome });
	}
	if (body && typeof body.lat === "number" && typeof body.lng === "number") {
		const outcome = await manager.requestRegion(
			{ point: { lat: body.lat, lng: body.lng } },
			{ requestedBy },
		);
		return json({ outcome });
	}
	return json({ error: "Provide { id } or { lat, lng }" }, { status: 400 });
};
