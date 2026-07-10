import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	GitHubError,
	githubConnect,
} from "$lib/server/services/connections/providers/github";
import type { RequestHandler } from "./$types";

// POST /api/connections/github/start — no OAuth/login flow: the client
// posts a pasted Personal Access Token (+ an optional Gitea/GHE base URL)
// and this route synchronously validates it against `GET /user` before
// storing it (encrypted). The token is never persisted in plaintext, never
// logged, and never appears in the response.
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;

	let body: {
		token?: unknown;
		baseUrl?: unknown;
	};
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const token = typeof body.token === "string" ? body.token.trim() : "";
	const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
	if (!token) {
		return json({ error: "token is required" }, { status: 400 });
	}

	try {
		const result = await githubConnect({
			userId: user.id,
			token,
			...(baseUrl ? { baseUrl } : {}),
		});
		return json(result);
	} catch (err) {
		const status =
			err instanceof GitHubError &&
			(err.code === "invalid_token" || err.code === "invalid_config")
				? err.code === "invalid_token"
					? 401
					: 400
				: 502;
		return json(
			{
				error:
					err instanceof GitHubError
						? err.message
						: "Failed to connect to GitHub",
			},
			{ status },
		);
	}
};
