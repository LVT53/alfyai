import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { createJsonErrorResponse } from "$lib/server/api/responses";
import { assertPublicHttpsUrl } from "$lib/server/services/connections/host-locality";
import { nextcloudConnectStart } from "$lib/server/services/connections/providers/nextcloud-files";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireApiUser(event);

	let body: { serverUrl?: unknown };
	try {
		body = await event.request.json();
	} catch {
		return createJsonErrorResponse("Invalid JSON", 400);
	}

	const rawServerUrl =
		typeof body.serverUrl === "string" ? body.serverUrl.trim() : "";

	let serverUrl: string;
	try {
		serverUrl = assertPublicHttpsUrl(rawServerUrl);
	} catch (err) {
		return createJsonErrorResponse(
			err instanceof Error
				? err.message
				: "serverUrl must be a non-empty public https URL",
			400,
		);
	}

	try {
		const result = await nextcloudConnectStart(serverUrl);
		return json(result);
	} catch (err) {
		return createJsonErrorResponse(
			err instanceof Error ? err.message : "Failed to start Nextcloud login",
			502,
		);
	}
};
