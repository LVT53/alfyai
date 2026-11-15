import { requireApiUser } from "$lib/server/api/auth";
import { requireOwnedConnection } from "$lib/server/api/ownership";
import { createJsonErrorResponse } from "$lib/server/api/responses";
import {
	NextcloudFilesError,
	type NextcloudFilesErrorCode,
	nextcloudPreview,
} from "$lib/server/services/connections/providers/nextcloud-files";
import { getConnectionSecret } from "$lib/server/services/connections/store";
import type { RequestHandler } from "./$types";

// The only two sizes the file card asks for: 96 for a card row, 192 for the
// larger one. Anything else is a client bug, never a hint to Nextcloud to
// render a 4000px image, so it is refused before any network call.
const PREVIEW_SIZES = new Set(["96", "192"]);

const FILE_ID = /^\d+$/;

// needs_reauth is the one failure the browser could act on (the person has to
// reconnect); invalid_path is the adapter refusing a path that escapes the
// files root, which is the caller's mistake. Every other typed failure
// (network, 5xx, config) and every unknown throw is an upstream problem the
// caller cannot fix, so it answers 502.
const ERROR_STATUS: Partial<Record<NextcloudFilesErrorCode, number>> = {
	needs_reauth: 401,
	invalid_path: 400,
};

// GET /api/connections/nextcloud/preview?connectionId=<id>&fileId=<n>&size=96|192
// (&path=<file path> only when the result carries no file id) — the only
// route that serves Nextcloud preview bytes to the file card's <img>. The
// per-user app password never reaches the client: nextcloudPreview is given
// the decrypted secret server-side and this route forwards only the bytes and
// content type it gets back.
//
// Isolation: a file id or path alone means nothing without the caller's own
// connection. requireOwnedConnection scopes the lookup by userId, so another
// user's id and a missing id both 404 identically, before the vault secret is
// read or any upstream request is made. A wrong-provider connection collapses
// into the same 404 (mismatchStatus: 404) so existence is never leaked.
//
// The browser treats any non-200 as "no preview" and draws a file-type glyph,
// so the JSON error bodies below exist for consistency and debuggability, not
// for the client to parse.
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);

	const connectionId = event.url.searchParams.get("connectionId");
	if (!connectionId) {
		return createJsonErrorResponse("connectionId is required", 400);
	}

	const sizeParam = event.url.searchParams.get("size") ?? "";
	if (!PREVIEW_SIZES.has(sizeParam)) {
		return createJsonErrorResponse("Unsupported preview size", 400);
	}
	const size = Number(sizeParam);

	// The id form is preferred (no path to encode); the path form is passed
	// through untouched and normalised by the adapter, which throws on
	// anything that escapes the files root (mapped to 400 below). A digit
	// string too large to be a safe integer is rejected because Number()
	// would silently round it to a different id.
	const fileIdParam = event.url.searchParams.get("fileId");
	const path = event.url.searchParams.get("path");
	let target: { fileId: number } | { path: string };
	if (fileIdParam !== null) {
		const fileId = Number(fileIdParam);
		if (
			!FILE_ID.test(fileIdParam) ||
			!Number.isSafeInteger(fileId) ||
			fileId <= 0
		) {
			return createJsonErrorResponse("fileId must be a positive integer", 400);
		}
		target = { fileId };
	} else {
		if (!path) {
			return createJsonErrorResponse(
				"path is required when there is no fileId",
				400,
			);
		}
		target = { path };
	}

	const owned = await requireOwnedConnection(user.id, connectionId, {
		guard: (connection) => connection.provider === "nextcloud",
		notFoundMessage: "Nextcloud connection not found",
		mismatchStatus: 404,
	});
	if (!owned.ok) {
		return owned.response;
	}

	try {
		const appPassword = await getConnectionSecret(user.id, owned.connection.id);
		if (!appPassword) {
			return createJsonErrorResponse(
				"Nextcloud connection needs re-authorization",
				401,
			);
		}

		const preview = await nextcloudPreview(owned.connection, appPassword, {
			...target,
			size,
		});
		if (!preview) {
			return createJsonErrorResponse("No preview available", 404);
		}

		return new Response(preview.bytes, {
			status: 200,
			headers: {
				"content-type": preview.contentType,
				// Per-user data — never a shared/public cache.
				"cache-control": "private, max-age=300",
				"content-length": String(preview.bytes.byteLength),
				// The content type is Nextcloud-reported, not verified, so
				// nosniff stops a browser from MIME-sniffing these bytes into
				// something other than the declared image type.
				"x-content-type-options": "nosniff",
			},
		});
	} catch (err) {
		if (err instanceof NextcloudFilesError) {
			// NextcloudFilesError messages are static strings that never
			// include the app password or a raw upstream body, so the typed
			// message is safe to surface.
			return createJsonErrorResponse(
				err.message,
				ERROR_STATUS[err.code] ?? 502,
			);
		}
		// A raw network error is not guaranteed to be a clean message, so a
		// fixed string is returned instead of err.message.
		return createJsonErrorResponse("Failed to load the Nextcloud preview", 502);
	}
};
