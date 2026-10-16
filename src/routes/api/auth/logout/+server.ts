import type { RequestHandler } from "@sveltejs/kit";
import { json } from "@sveltejs/kit";
import { clearSessionCookie, deleteSession } from "$lib/server/services/auth";

export const POST: RequestHandler = async ({ cookies }) => {
	const token = cookies.get("session");

	if (token) {
		// Hashes the token before it looks the row up: the database holds the
		// hash, the cookie holds the token.
		await deleteSession(token);
	}

	clearSessionCookie(cookies);

	return json({ success: true });
};
