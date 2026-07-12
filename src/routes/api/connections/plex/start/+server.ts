import { handleCredentialConnect } from "$lib/server/api/connect";
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
export const POST: RequestHandler = (event) =>
	handleCredentialConnect({
		event,
		errorType: PlexError,
		fallbackError: "Failed to connect to the Plex server",
		parse: (body) => {
			const serverUrl =
				typeof body.serverUrl === "string" ? body.serverUrl.trim() : "";
			const token = typeof body.token === "string" ? body.token.trim() : "";
			if (!serverUrl || !token) {
				return { ok: false, error: "serverUrl and token are required" };
			}
			return { ok: true, value: { serverUrl, token } };
		},
		connect: ({ userId, value }) =>
			plexConnect({
				userId,
				serverUrl: value.serverUrl,
				token: value.token,
			}),
	});
