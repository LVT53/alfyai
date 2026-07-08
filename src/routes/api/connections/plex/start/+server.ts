import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	PlexError,
	plexConnect,
} from "$lib/server/services/connections/providers/plex";
import type { RequestHandler } from "./$types";

// POST /api/connections/plex/start — no OAuth/login flow (Plex has none for
// this purpose): the client posts the server URL + a pasted Plex token and
// this route synchronously validates it against `GET /identity` before
// storing it (encrypted). The token is never persisted in plaintext, never
// logged, and never appears in the response.
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;

	let body: {
		serverUrl?: unknown;
		token?: unknown;
	};
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const serverUrl =
		typeof body.serverUrl === "string" ? body.serverUrl.trim() : "";
	const token = typeof body.token === "string" ? body.token.trim() : "";
	if (!serverUrl || !token) {
		return json({ error: "serverUrl and token are required" }, { status: 400 });
	}

	try {
		const result = await plexConnect({
			userId: user.id,
			serverUrl,
			token,
		});
		return json(result);
	} catch (err) {
		const status =
			err instanceof PlexError &&
			(err.code === "invalid_token" || err.code === "invalid_config")
				? err.code === "invalid_token"
					? 401
					: 400
				: 502;
		return json(
			{
				error:
					err instanceof PlexError
						? err.message
						: "Failed to connect to the Plex server",
			},
			{ status },
		);
	}
};
