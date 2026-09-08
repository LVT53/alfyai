import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	getRoutingRegionManager,
	isRegionRoutingConfigured,
} from "$lib/server/services/routing/region-runtime";
import type { RequestHandler } from "./$types";

// Retry a failed region build, or act on its timetables:
//   { action: "refresh_transit" }              re-download every feed and
//                                              rebuild the public-transport
//                                              graph, ignoring the nightly
//                                              refresh window
//   { action: "retry_feed", feedId: "mav-… " } clear ONE feed's recorded
//                                              failure and queue the rebuild,
//                                              which re-fetches just that feed
export const POST: RequestHandler = async (event) => {
	requireAdmin(event);
	if (!isRegionRoutingConfigured()) {
		return json({ error: "Routing is not configured" }, { status: 409 });
	}
	const body = (await event.request.json().catch(() => null)) as {
		action?: unknown;
		feedId?: unknown;
	} | null;
	const id = decodeURIComponent(event.params.id);
	const manager = getRoutingRegionManager();
	let region: Awaited<ReturnType<typeof manager.retryRegion>>;
	if (body?.action === "refresh_transit") {
		region = await manager.refreshTransit(id);
	} else if (body?.action === "retry_feed") {
		if (typeof body.feedId !== "string" || !body.feedId.trim()) {
			return json(
				{ error: "Provide { feedId } with action retry_feed" },
				{ status: 400 },
			);
		}
		region = await manager.retryTransitFeed(id, body.feedId.trim());
	} else {
		region = await manager.retryRegion(id);
	}
	if (!region) return json({ error: "Region not found" }, { status: 404 });
	return json({
		region: { ...region, feeds: manager.describeTransitFeeds(region) },
	});
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
