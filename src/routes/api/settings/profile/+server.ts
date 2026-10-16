import { json } from "@sveltejs/kit";
import { and, eq, ne } from "drizzle-orm";
import { currentPasswordRefusal } from "$lib/server/api/current-password";
import { requireAuth } from "$lib/server/auth/hooks";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { checkCurrentPassword } from "$lib/server/services/auth";
import type { RequestHandler } from "./$types";

export const PATCH: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user?.id;

	let body: { name?: unknown; email?: unknown; currentPassword?: unknown };
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

		const [current] = await db
			.select({ email: users.email })
			.from(users)
			.where(eq(users.id, userId));
		if (!current) {
			return json({ error: "User not found" }, { status: 404 });
		}

		// The address is what signs a person in, so changing it asks for the
		// account password, and a stolen session alone is not enough. The same
		// address in other letters is not a change, and the Profile card sends
		// the email along with a rename: that needs no password.
		if (email !== current.email.trim().toLowerCase()) {
			if (
				typeof body.currentPassword !== "string" ||
				body.currentPassword.length === 0
			) {
				return json(
					{
						error: "password_required",
						errorKey: "profileTab.emailNeedsPassword",
					},
					{ status: 400 },
				);
			}

			// The sign-in's own bcrypt comparison and limiter (checked before
			// comparing, a wrong answer recorded, a right one clears the count).
			// Before the uniqueness check below, so a session without the
			// password cannot learn which addresses have accounts.
			const check = await checkCurrentPassword(userId, body.currentPassword);
			if (check.outcome !== "ok") return currentPasswordRefusal(check);

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
	}

	await db.update(users).set(updates).where(eq(users.id, userId));

	const [updated] = await db.select().from(users).where(eq(users.id, userId));
	return json({ name: updated.name, email: updated.email });
};
