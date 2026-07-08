import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { nextcloudConnectPoll } from "$lib/server/services/connections/providers/nextcloud-files";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;

	let body: {
		serverUrl?: unknown;
		pollToken?: unknown;
		pollEndpoint?: unknown;
	};
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const serverUrl =
		typeof body.serverUrl === "string" ? body.serverUrl.trim() : "";
	const pollToken =
		typeof body.pollToken === "string" ? body.pollToken.trim() : "";
	const pollEndpoint =
		typeof body.pollEndpoint === "string" ? body.pollEndpoint.trim() : "";

	if (!serverUrl || !pollToken || !pollEndpoint) {
		return json(
			{ error: "serverUrl, pollToken, and pollEndpoint are required" },
			{ status: 400 },
		);
	}

	try {
		const result = await nextcloudConnectPoll({
			userId: user.id,
			serverUrl,
			pollToken,
			pollEndpoint,
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
