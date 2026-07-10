import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	TodoistError,
	todoistConnect,
} from "$lib/server/services/connections/providers/todoist";
import type { RequestHandler } from "./$types";

// POST /api/connections/todoist/start — no OAuth/login flow: the client
// posts a pasted Todoist API token and this route synchronously validates it
// against `GET /projects` before storing it (encrypted). The token is never
// persisted in plaintext, never logged, and never appears in the response.
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;

	let body: { token?: unknown };
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const token = typeof body.token === "string" ? body.token.trim() : "";
	if (!token) {
		return json({ error: "token is required" }, { status: 400 });
	}

	try {
		const result = await todoistConnect({ userId: user.id, token });
		return json(result);
	} catch (err) {
		const status =
			err instanceof TodoistError &&
			(err.code === "invalid_token" || err.code === "invalid_config")
				? err.code === "invalid_token"
					? 401
					: 400
				: 502;
		return json(
			{
				error:
					err instanceof TodoistError
						? err.message
						: "Failed to connect to Todoist",
			},
			{ status },
		);
	}
};
