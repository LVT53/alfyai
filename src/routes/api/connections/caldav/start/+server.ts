import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	CalDavError,
	caldavConnect,
} from "$lib/server/services/connections/providers/caldav-tasks";
import type { RequestHandler } from "./$types";

// POST /api/connections/caldav/start — no OAuth/login flow: the client
// posts a CalDAV server URL + username + app-specific password, and this
// route synchronously runs task-list discovery (PROPFIND chain, see
// caldav-tasks.ts) before storing the app password (encrypted). The
// password is never persisted in plaintext, never logged, and never appears
// in the response. `serverUrl` is validated server-side via
// assertPublicHttpsUrl (inside caldavConnect) before anything is fetched.
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;

	let body: { serverUrl?: unknown; username?: unknown; appPassword?: unknown };
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const serverUrl =
		typeof body.serverUrl === "string" ? body.serverUrl.trim() : "";
	const username =
		typeof body.username === "string" ? body.username.trim() : "";
	const appPassword =
		typeof body.appPassword === "string" ? body.appPassword.trim() : "";
	if (!serverUrl || !username || !appPassword) {
		return json(
			{ error: "serverUrl, username, and appPassword are required" },
			{ status: 400 },
		);
	}

	try {
		const result = await caldavConnect({
			userId: user.id,
			serverUrl,
			username,
			appPassword,
		});
		return json(result);
	} catch (err) {
		const status =
			err instanceof CalDavError &&
			(err.code === "invalid_credentials" || err.code === "invalid_config")
				? err.code === "invalid_credentials"
					? 401
					: 400
				: 502;
		return json(
			{
				error:
					err instanceof CalDavError
						? err.message
						: "Failed to connect to the CalDAV server",
			},
			{ status },
		);
	}
};
