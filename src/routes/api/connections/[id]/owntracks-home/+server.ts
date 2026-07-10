import { json } from "@sveltejs/kit";
import { createJsonErrorResponse } from "$lib/server/api/responses";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	getConnection,
	updateConnection,
} from "$lib/server/services/connections/store";
import type { RequestHandler } from "./$types";

interface OwnTracksHomeBody {
	homeLat?: unknown;
	homeLon?: unknown;
}

const MIN_LAT = -90;
const MAX_LAT = 90;
const MIN_LON = -180;
const MAX_LON = 180;

// PATCH /api/connections/[id]/owntracks-home — Task 10: lets a user set (or
// clear) the home lat/lon that ownTracksHomeReference (providers/
// owntracks.ts) reads for the "distance to home" tool action. Deliberately a
// small, provider-specific sub-route (mirrors the nextcloud-folders pattern)
// rather than folding this into the generic PATCH /api/connections/[id],
// which only knows the typed allowWrites/defaultOn/capabilities/
// writeAllowlist fields — homeLat/homeLon live inside the OwnTracks
// connection's own free-form `config` instead.
//
// This is CONFIG, not a secret and not a write to the third-party service —
// it only ever affects local distance math — so it never touches the vault
// or the write-confirm firewall.
//
// Always resolves the connection user-scoped via getConnection(userId, id)
// first, so another user's connection id 404s instead of leaking existence
// or allowing a cross-user mutation (mirrors connections-id +server.ts /
// nextcloud-folders +server.ts).
export const PATCH: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user.id;
	const id = event.params.id;

	const connection = await getConnection(userId, id);
	if (!connection) {
		return createJsonErrorResponse("Connection not found", 404);
	}
	if (connection.provider !== "owntracks") {
		return createJsonErrorResponse(
			"Connection does not support a home location",
			400,
		);
	}

	let body: OwnTracksHomeBody;
	try {
		body = await event.request.json();
	} catch {
		return createJsonErrorResponse("Invalid JSON", 400);
	}

	const { homeLat: rawLat, homeLon: rawLon } = body;
	const latIsNull = rawLat === null || rawLat === undefined;
	const lonIsNull = rawLon === null || rawLon === undefined;

	// Only two valid shapes: both cleared (unset home), or both present as
	// in-range numbers (set home). A single coordinate without its pair is
	// meaningless, so it's rejected rather than silently accepted.
	if (latIsNull !== lonIsNull) {
		return createJsonErrorResponse(
			"homeLat and homeLon must both be set or both be cleared",
			400,
		);
	}

	const nextConfig: Record<string, unknown> = { ...connection.config };

	if (latIsNull && lonIsNull) {
		delete nextConfig.homeLat;
		delete nextConfig.homeLon;
	} else {
		if (typeof rawLat !== "number" || !Number.isFinite(rawLat)) {
			return createJsonErrorResponse("homeLat must be a number", 400);
		}
		if (typeof rawLon !== "number" || !Number.isFinite(rawLon)) {
			return createJsonErrorResponse("homeLon must be a number", 400);
		}
		if (rawLat < MIN_LAT || rawLat > MAX_LAT) {
			return createJsonErrorResponse(
				`homeLat must be between ${MIN_LAT} and ${MAX_LAT}`,
				400,
			);
		}
		if (rawLon < MIN_LON || rawLon > MAX_LON) {
			return createJsonErrorResponse(
				`homeLon must be between ${MIN_LON} and ${MAX_LON}`,
				400,
			);
		}
		nextConfig.homeLat = rawLat;
		nextConfig.homeLon = rawLon;
	}

	const updated = await updateConnection(userId, id, { config: nextConfig });
	if (!updated) {
		return createJsonErrorResponse("Connection not found", 404);
	}
	return json(updated);
};
