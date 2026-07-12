import { requireApiUser } from "$lib/server/api/auth";
import { requireOwnedConnection } from "$lib/server/api/ownership";
import { createJsonErrorResponse } from "$lib/server/api/responses";
import {
	ImmichError,
	type ImmichErrorCode,
	immichThumbnail,
} from "$lib/server/services/connections/providers/immich";
import { resolveConnectionsForCapability } from "$lib/server/services/connections/resolve";
import type { RequestHandler } from "./$types";

// Immich asset ids are UUIDs in production; test fixtures elsewhere in the
// codebase use short slugs like "asset-1". Either way this guards the path
// param against anything that isn't a single safe URL segment (no "/", "..",
// percent-encoded traversal, etc.) before it's forwarded on. immichThumbnail
// itself encodeURIComponent()s the id into the Immich API path, so there is
// no server-side traversal risk either way — this is defense in depth.
const SAFE_ASSET_ID = /^[A-Za-z0-9_-]{1,200}$/;

// connection_not_found / needs_reauth get specific statuses; every other
// ImmichError code (request_failed, invalid_config, invalid_credentials) is
// an upstream/config problem the caller can't fix, so it falls through to
// 502 below. Note: Immich returning 404 for a genuinely missing asset is
// NOT distinguished from other upstream failures by immichThumbnail today
// (immichAuthorizedRequest only special-cases 401) — it also lands here as
// request_failed -> 502 rather than 404.
const IMMICH_ERROR_STATUS: Partial<Record<ImmichErrorCode, number>> = {
	connection_not_found: 404,
	needs_reauth: 401,
};

// GET /api/connections/immich/thumbnail/[assetId]?connectionId=optional —
// Task 11a: the only route that serves Immich photo bytes to the browser.
// The per-user Immich API key NEVER reaches the client — immichThumbnail
// resolves it server-side via getConnectionSecret(userId, connectionId) and
// attaches it as the x-api-key header on the upstream request; this route
// only ever forwards the decoded image bytes + content-type it gets back.
//
// Isolation: an assetId alone means nothing without the caller's own
// connection. When ?connectionId= is given it is resolved via
// getConnection(userId, id) — scoped by userId in the store — so another
// user's connection id resolves to null exactly like a missing connection
// and 404s before immichThumbnail (and therefore any vault/network call) is
// ever reached. When ?connectionId= is omitted, the caller's own connected
// Immich connection is picked via resolveConnectionsForCapability, which is
// likewise scoped by userId (mirrors the enable-writes route's lookup).
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const userId = user.id;

	const assetId = event.params.assetId;
	if (!assetId || !SAFE_ASSET_ID.test(assetId)) {
		return createJsonErrorResponse("Invalid asset id", 400);
	}

	const requestedConnectionId = event.url.searchParams.get("connectionId");

	let connectionId: string;
	if (requestedConnectionId) {
		// A wrong-provider or another-user's / missing id both collapse to the
		// same 404 "Immich connection not found" here (mismatchStatus: 404) so
		// existence is never leaked and the message stays uniform.
		const owned = await requireOwnedConnection(userId, requestedConnectionId, {
			guard: (connection) => connection.provider === "immich",
			notFoundMessage: "Immich connection not found",
			mismatchMessage: "Immich connection not found",
			mismatchStatus: 404,
		});
		if (!owned.ok) {
			return owned.response;
		}
		connectionId = owned.connection.id;
	} else {
		const connections = await resolveConnectionsForCapability(userId, "photos");
		const connection = connections.find((c) => c.provider === "immich");
		if (!connection) {
			return createJsonErrorResponse("Immich connection not found", 404);
		}
		connectionId = connection.id;
	}

	try {
		const { bytes, contentType } = await immichThumbnail(userId, connectionId, {
			assetId,
		});
		return new Response(bytes, {
			status: 200,
			headers: {
				"content-type": contentType,
				// Per-user data — never a shared/public cache.
				"cache-control": "private, max-age=300",
				"content-length": String(bytes.byteLength),
				// Task 11b hardening: the upstream contentType is Immich-reported,
				// not verified — nosniff stops a browser from MIME-sniffing these
				// bytes into something other than the declared image type.
				"x-content-type-options": "nosniff",
			},
		});
	} catch (err) {
		if (err instanceof ImmichError) {
			// ImmichError messages are always static strings (see immich.ts)
			// and never include the key or a raw upstream body, so it's safe
			// to surface err.message directly here.
			return createJsonErrorResponse(
				err.message,
				IMMICH_ERROR_STATUS[err.code] ?? 502,
			);
		}
		// Anything else (a raw fetch/network error, etc.) is NOT guaranteed
		// to be a clean message, so a fixed generic string is returned
		// instead of err.message.
		return createJsonErrorResponse("Failed to load the photo thumbnail", 502);
	}
};
