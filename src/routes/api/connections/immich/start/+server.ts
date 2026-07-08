import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
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
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;

	let body: {
		serverUrl?: unknown;
		email?: unknown;
		password?: unknown;
	};
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const serverUrl =
		typeof body.serverUrl === "string" ? body.serverUrl.trim() : "";
	const email = typeof body.email === "string" ? body.email.trim() : "";
	const password = typeof body.password === "string" ? body.password : "";
	if (!serverUrl || !email || !password) {
		return json(
			{ error: "serverUrl, email, and password are required" },
			{ status: 400 },
		);
	}

	try {
		const result = await immichConnect({
			userId: user.id,
			serverUrl,
			email,
			password,
		});
		return json(result);
	} catch (err) {
		const status =
			err instanceof ImmichError &&
			(err.code === "invalid_credentials" || err.code === "invalid_config")
				? err.code === "invalid_credentials"
					? 401
					: 400
				: 502;
		return json(
			{
				error:
					err instanceof ImmichError
						? err.message
						: "Failed to connect to the Immich server",
			},
			{ status },
		);
	}
};
