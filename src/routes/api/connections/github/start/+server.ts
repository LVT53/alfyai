import { handleCredentialConnect } from "$lib/server/api/connect";
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
export const POST: RequestHandler = (event) =>
	handleCredentialConnect({
		event,
		errorType: GitHubError,
		fallbackError: "Failed to connect to GitHub",
		parse: (body) => {
			const token = typeof body.token === "string" ? body.token.trim() : "";
			const baseUrl =
				typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
			if (!token) {
				return { ok: false, error: "token is required" };
			}
			return { ok: true, value: { token, baseUrl } };
		},
		connect: ({ userId, value }) =>
			githubConnect({
				userId,
				token: value.token,
				...(value.baseUrl ? { baseUrl: value.baseUrl } : {}),
			}),
	});
