import { handleCredentialConnect } from "$lib/server/api/connect";
import {
	PlexError,
	plexConnect,
} from "$lib/server/services/connections/providers/plex";
import type { RequestHandler } from "./$types";

// Advanced setup for existing manual server URL/token installations.
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
