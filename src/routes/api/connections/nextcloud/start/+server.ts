import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { nextcloudConnectStart } from "$lib/server/services/connections/providers/nextcloud-files";
import type { RequestHandler } from "./$types";

function isHttpsUrl(value: string): boolean {
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);

	let body: { serverUrl?: unknown };
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const serverUrl =
		typeof body.serverUrl === "string" ? body.serverUrl.trim() : "";
	if (!serverUrl || !isHttpsUrl(serverUrl)) {
		return json(
			{ error: "serverUrl must be a non-empty https URL" },
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
