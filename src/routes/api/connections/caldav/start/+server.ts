import { handleCredentialConnect } from "$lib/server/api/connect";
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
export const POST: RequestHandler = (event) =>
	handleCredentialConnect({
		event,
		errorType: CalDavError,
		fallbackError: "Failed to connect to the CalDAV server",
		parse: (body) => {
			const serverUrl =
				typeof body.serverUrl === "string" ? body.serverUrl.trim() : "";
			const username =
				typeof body.username === "string" ? body.username.trim() : "";
			const appPassword =
				typeof body.appPassword === "string" ? body.appPassword.trim() : "";
			if (!serverUrl || !username || !appPassword) {
				return {
					ok: false,
					error: "serverUrl, username, and appPassword are required",
				};
			}
			return { ok: true, value: { serverUrl, username, appPassword } };
		},
		connect: ({ userId, value }) =>
			caldavConnect({
				userId,
				serverUrl: value.serverUrl,
				username: value.username,
				appPassword: value.appPassword,
			}),
	});
