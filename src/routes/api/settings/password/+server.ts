import { json } from "@sveltejs/kit";
import * as bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { requireAuth } from "$lib/server/auth/hooks";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { verifyPassword } from "$lib/server/services/auth";
import type { RequestHandler } from "./$types";

export const PATCH: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user?.id;

	let body: { currentPassword?: unknown; newPassword?: unknown };
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	if (
		typeof body.currentPassword !== "string" ||
		typeof body.newPassword !== "string"
	) {
		return json(
			{ error: "currentPassword and newPassword are required" },
			{ status: 400 },
		);
	}

	if (body.newPassword.length < 8) {
		return json(
			{ error: "New password must be at least 8 characters" },
			{ status: 400 },
		);
	}

	const [user] = await db.select().from(users).where(eq(users.id, userId));
	if (!user) {
		return json({ error: "User not found" }, { status: 404 });
	}

	const valid = await verifyPassword(body.currentPassword, user.passwordHash);
	if (!valid) {
		return json({ error: "Current password is incorrect" }, { status: 401 });
	}

	const newHash = await bcrypt.hash(body.newPassword, 12);
	await db
		.update(users)
		.set({ passwordHash: newHash, updatedAt: new Date() })
		.where(eq(users.id, userId));

	return json({ success: true });
};
