import { json } from "@sveltejs/kit";
import * as bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { requireAuth } from "$lib/server/auth/hooks";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { verifyPassword } from "$lib/server/services/auth";
import {
	guardCredentialCheck,
	recordLoginFailure,
	recordLoginSuccess,
} from "$lib/server/services/login-rate-limit";
import type { RequestHandler } from "./$types";

function tooManyAttempts(retryAfterSeconds: number): Response {
	return json(
		{
			error: "Too many failed attempts. Please wait a moment and try again.",
			errorKey: "login.tooManyAttempts",
		},
		{
			status: 429,
			headers: { "Retry-After": String(retryAfterSeconds) },
		},
	);
}

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

	// Same limiter as the login route, in its own `account:` namespace so a
	// fumbled current password here cannot lock the person out of signing in
	// (and vice versa). This endpoint is already behind requireAuth, so the
	// threat is a hijacked session brute-forcing the current password in order
	// to change it — not an anonymous guesser.
	const rateLimitKeys = { accountId: userId };

	// Bound to a const before the closure: `body` is a `let`, so TypeScript
	// discards the narrowing above inside a callback.
	const currentPassword = body.currentPassword;

	const guarded = await guardCredentialCheck(rateLimitKeys, async () => {
		const [found] = await db.select().from(users).where(eq(users.id, userId));
		if (!found) return { user: null, valid: false };
		return {
			user: found,
			valid: await verifyPassword(currentPassword, found.passwordHash),
		};
	});

	if (guarded.outcome === "refused") {
		return tooManyAttempts(guarded.block.retryAfterSeconds);
	}

	const { user, valid } = guarded.value;
	if (!user) {
		return json({ error: "User not found" }, { status: 404 });
	}

	if (!valid) {
		recordLoginFailure(rateLimitKeys);
		if (guarded.throttled) {
			return tooManyAttempts(guarded.throttled.retryAfterSeconds);
		}
		return json({ error: "Current password is incorrect" }, { status: 401 });
	}

	recordLoginSuccess(rateLimitKeys);

	const newHash = await bcrypt.hash(body.newPassword, 12);
	await db
		.update(users)
		.set({ passwordHash: newHash, updatedAt: new Date() })
		.where(eq(users.id, userId));

	return json({ success: true });
};
