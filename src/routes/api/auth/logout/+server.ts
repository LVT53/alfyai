import type { RequestHandler } from "@sveltejs/kit";
import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { sessions } from "$lib/server/db/schema";
import { clearSessionCookie } from "$lib/server/services/auth";

export const POST: RequestHandler = async ({ cookies }) => {
	const token = cookies.get("session");

	if (token) {
		await db.delete(sessions).where(eq(sessions.id, token));
	}

	clearSessionCookie(cookies);

	return json({ success: true });
};
