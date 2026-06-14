import { json } from "@sveltejs/kit";
import { and, eq, ne } from "drizzle-orm";
import { requireAuth } from "$lib/server/auth/hooks";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import type { RequestHandler } from "./$types";

export const PATCH: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user?.id;

	let body: { name?: unknown; email?: unknown };
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const updates: Record<string, unknown> = { updatedAt: new Date() };

	if (body.name !== undefined) {
		if (typeof body.name !== "string") {
			return json({ error: "name must be a string" }, { status: 400 });
		}
		updates.name = body.name.trim() || null;
	}

	if (body.email !== undefined) {
		if (typeof body.email !== "string" || !body.email.includes("@")) {
			return json({ error: "Invalid email address" }, { status: 400 });
		}
		const email = body.email.trim().toLowerCase();
		// Check uniqueness
		const existing = await db
			.select({ id: users.id })
			.from(users)
			.where(and(eq(users.email, email), ne(users.id, userId)));
		if (existing.length > 0) {
			return json({ error: "Email already in use" }, { status: 409 });
		}
		updates.email = email;
	}

	await db.update(users).set(updates).where(eq(users.id, userId));

	const [updated] = await db.select().from(users).where(eq(users.id, userId));
	return json({ name: updated.name, email: updated.email });
};
