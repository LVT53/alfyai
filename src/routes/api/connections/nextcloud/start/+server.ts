import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	assertPublicHttpsUrl,
	nextcloudConnectStart,
} from "$lib/server/services/connections/providers/nextcloud-files";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);

	let body: { serverUrl?: unknown };
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const rawServerUrl =
		typeof body.serverUrl === "string" ? body.serverUrl.trim() : "";

	let serverUrl: string;
	try {
		serverUrl = assertPublicHttpsUrl(rawServerUrl);
	} catch (err) {
		return json(
			{
				error:
					err instanceof Error
						? err.message
						: "serverUrl must be a non-empty public https URL",
			},
			{ status: 400 },
		);
	}

	try {
		const result = await nextcloudConnectStart(serverUrl);
		return json(result);
	} catch (err) {
		return json(
			{
				error:
					err instanceof Error
						? err.message
						: "Failed to start Nextcloud login",
			},
			{ status: 502 },
		);
	}
};
