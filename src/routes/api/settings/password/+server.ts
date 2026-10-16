import { json } from "@sveltejs/kit";
import * as bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { currentPasswordRefusal } from "$lib/server/api/current-password";
import { requireAuth } from "$lib/server/auth/hooks";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import {
	checkCurrentPassword,
	revokeOtherSessions,
} from "$lib/server/services/auth";
import { MIN_PASSWORD_LENGTH } from "$lib/shared/password-policy";
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

	if (body.newPassword.length < MIN_PASSWORD_LENGTH) {
		return json(
			{
				error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters`,
			},
			{ status: 400 },
		);
	}

	// The same limiter as the sign-in, in its own `account:` namespace (see
	// checkCurrentPassword): a fumbled current password here cannot lock the
	// person out of signing in, and vice versa.
	const check = await checkCurrentPassword(userId, body.currentPassword);
	if (check.outcome !== "ok") return currentPasswordRefusal(check);

	const newHash = await bcrypt.hash(body.newPassword, 12);
	await db
		.update(users)
		.set({ passwordHash: newHash, updatedAt: new Date() })
		.where(eq(users.id, userId));

	// The password a stolen cookie or a forgotten phone was signed in with is
	// gone, so those sessions go too. This device keeps its own: the person who
	// just proved they know the old password is not thrown out of the page they
	// are looking at. The count goes back so the Profile card can say so.
	const signedOutOtherDevices = await revokeOtherSessions(
		userId,
		event.cookies.get("session") ?? null,
	);

	return json({ success: true, signedOutOtherDevices });
};
