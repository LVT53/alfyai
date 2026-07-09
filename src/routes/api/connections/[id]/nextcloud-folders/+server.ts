import { json } from "@sveltejs/kit";
import { createJsonErrorResponse } from "$lib/server/api/responses";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	NextcloudFilesError,
	type NextcloudFilesErrorCode,
	nextcloudListFolders,
} from "$lib/server/services/connections/providers/nextcloud-files";
import { getConnection } from "$lib/server/services/connections/store";
import type { RequestHandler } from "./$types";

const ERROR_STATUS: Record<NextcloudFilesErrorCode, number> = {
	invalid_path: 400,
	invalid_config: 400,
	needs_reauth: 409,
	not_found: 404,
	too_large: 502,
	request_failed: 502,
	etag_mismatch: 502,
	conflict: 502,
	writes_disabled: 502,
	connection_not_found: 404,
};

// GET /api/connections/[id]/nextcloud-folders?path=/optional/subpath —
// backs the write-allowlist folder editor's suggestion dropdown (Redesign
// R9). Always scoped via getConnection(userId, id) first (mirrors
// src/routes/api/connections/[id]/+server.ts) so another user's connection
// id 404s instead of leaking existence, and only valid for a nextcloud
// connection with the files capability — every other provider is 400.
// Folder names are shown to the USER in their own settings UI, so unlike
// the model-facing chat tools there is no Option-A/leak concern here; the
// only thing that must never appear in the response is the secret itself,
// which nextcloudListFolders never returns.
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user.id;
	const id = event.params.id;

	const connection = await getConnection(userId, id);
	if (!connection) {
		return createJsonErrorResponse("Connection not found", 404);
	}
	if (
		connection.provider !== "nextcloud" ||
		!connection.capabilities.includes("files")
	) {
		return createJsonErrorResponse(
			"Connection does not support Nextcloud folder listing",
			400,
		);
	}

	const path = event.url.searchParams.get("path") ?? undefined;

	try {
		const folders = await nextcloudListFolders(userId, id, { path });
		return json({ folders });
	} catch (err) {
		if (err instanceof NextcloudFilesError) {
			return createJsonErrorResponse(
				err.message,
				ERROR_STATUS[err.code] ?? 502,
			);
		}
		return createJsonErrorResponse("Failed to list Nextcloud folders", 502);
	}
};
