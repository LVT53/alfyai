import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { assertPublicHttpsUrl } from "$lib/server/services/connections/host-locality";
import { nextcloudConnectPoll } from "$lib/server/services/connections/providers/nextcloud-files";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;

	let body: {
		serverUrl?: unknown;
		pollToken?: unknown;
	};
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const rawServerUrl =
		typeof body.serverUrl === "string" ? body.serverUrl.trim() : "";
	const pollToken =
		typeof body.pollToken === "string" ? body.pollToken.trim() : "";

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

	if (!pollToken) {
		return json({ error: "pollToken is required" }, { status: 400 });
	}

	try {
		const result = await nextcloudConnectPoll({
			userId: user.id,
			serverUrl,
			pollToken,
		});
		return json(result);
	} catch (err) {
		return json(
			{
				error:
					err instanceof Error ? err.message : "Failed to poll Nextcloud login",
			},
			{ status: 502 },
		);
	}
};
