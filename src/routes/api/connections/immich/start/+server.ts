import { handleCredentialConnect } from "$lib/server/api/connect";
import {
	ImmichError,
	immichConnect,
} from "$lib/server/services/connections/providers/immich";
import type { RequestHandler } from "./$types";

// POST /api/connections/immich/start — no redirect flow (Immich has no
// OAuth): the client posts the server URL + email + password and this route
// synchronously runs the whole connect flow (login, then mint+store a
// scoped read-only API key) before responding. The password is used only in
// memory for the login call inside `immichConnect` — it is never persisted
// and never appears in the response.
export const POST: RequestHandler = (event) =>
	handleCredentialConnect({
		event,
		errorType: ImmichError,
		fallbackError: "Failed to connect to the Immich server",
		parse: (body) => {
			const serverUrl =
				typeof body.serverUrl === "string" ? body.serverUrl.trim() : "";
			const email = typeof body.email === "string" ? body.email.trim() : "";
			const password = typeof body.password === "string" ? body.password : "";
			if (!serverUrl || !email || !password) {
				return {
					ok: false,
					error: "serverUrl, email, and password are required",
				};
			}
			return { ok: true, value: { serverUrl, email, password } };
		},
		connect: ({ userId, value }) =>
			immichConnect({
				userId,
				serverUrl: value.serverUrl,
				email: value.email,
				password: value.password,
			}),
	});
