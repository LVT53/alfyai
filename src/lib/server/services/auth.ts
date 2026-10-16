import * as crypto from "node:crypto";
import type { Cookies } from "@sveltejs/kit";
import * as bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import type { SessionUser } from "$lib/server/services/auth-types";
import { db } from "../db/index";
import { sessions, users } from "../db/schema";

const SHORT_SESSION_DURATION_MS = 24 * 60 * 60 * 1000;
const REMEMBERED_SESSION_DURATION_MS = 14 * 24 * 60 * 60 * 1000;

export async function verifyPassword(
	plaintext: string,
	hash: string,
): Promise<boolean> {
	return bcrypt.compare(plaintext, hash);
}

export async function createSession(
	userId: string,
	options: SessionCookieOptions = { rememberMe: true },
): Promise<{ token: string; expiresAt: Date }> {
	const token = crypto.randomBytes(32).toString("hex");
	const durationMs =
		options.rememberMe === false
			? SHORT_SESSION_DURATION_MS
			: REMEMBERED_SESSION_DURATION_MS;
	const expiresAt = new Date(Date.now() + durationMs);

	// A Date, so Drizzle writes the column in the unit it reads it back in
	// (seconds: `integer` in `timestamp` mode). A raw millisecond count here
	// used to read back as a date tens of thousands of years away, so the check
	// in `validateSession` never fired and only the cookie's Max-Age ended a
	// session.
	await db.insert(sessions).values({
		id: token,
		userId: userId,
		expiresAt,
	});

	return { token, expiresAt };
}

export async function validateSession(
	token: string,
): Promise<SessionUser | null> {
	const sessionResult = await db
		.select()
		.from(sessions)
		.innerJoin(users, eq(sessions.userId, users.id))
		.where(eq(sessions.id, token));

	const [session] = sessionResult;
	if (!session) {
		return null;
	}

	const { sessions: sessionObj, users: userObj } = session;

	if (sessionObj.expiresAt.getTime() < Date.now()) {
		await db.delete(sessions).where(eq(sessions.id, token));
		return null;
	}

	return {
		id: userObj.id,
		email: userObj.email,
		displayName: userObj.name ?? userObj.email,
		role: (userObj.role ??
			"user") as import("$lib/server/services/auth-types").UserRole,
		profilePicture: userObj.profilePicture ?? null,
		titleLanguage: (userObj.titleLanguage ?? "auto") as "auto" | "en" | "hu",
		uiLanguage: (userObj.uiLanguage ?? "en") as "en" | "hu",
	};
}

export async function deleteSession(token: string): Promise<void> {
	await db.delete(sessions).where(eq(sessions.id, token));
}

type SessionCookieOptions = {
	rememberMe?: boolean;
};

export function setSessionCookie(
	cookies: Pick<Cookies, "set">,
	token: string,
	expiresAt: Date,
	_options: SessionCookieOptions = { rememberMe: true },
): void {
	const maxAge = Math.floor((expiresAt.getTime() - Date.now()) / 1000);

	const cookieOptions: Parameters<Cookies["set"]>[2] = {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		path: "/",
	};

	cookieOptions.maxAge = maxAge;

	cookies.set("session", token, cookieOptions);
}

export function clearSessionCookie(cookies: Pick<Cookies, "delete">): void {
	cookies.delete("session", {
		path: "/",
	});
}
