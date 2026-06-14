import * as crypto from "node:crypto";
import type { Cookies } from "@sveltejs/kit";
import * as bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import type { SessionUser } from "../../types";
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
): Promise<{ token: string; expiresAt: number }> {
	const token = crypto.randomBytes(32).toString("hex");
	const durationMs =
		options.rememberMe === false
			? SHORT_SESSION_DURATION_MS
			: REMEMBERED_SESSION_DURATION_MS;
	const expiresAt = Date.now() + durationMs;

	await db.insert(sessions).values({
		id: token,
		userId: userId,
		expiresAt: sql`${expiresAt}`,
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

	if (Number(sessionObj.expiresAt) < Date.now()) {
		await db.delete(sessions).where(eq(sessions.id, token));
		return null;
	}

	return {
		id: userObj.id,
		email: userObj.email,
		displayName: userObj.name ?? userObj.email,
		role: (userObj.role ?? "user") as import("../../types").UserRole,
		avatarId: userObj.avatarId ?? null,
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
	expiresAt: number,
	_options: SessionCookieOptions = { rememberMe: true },
): void {
	const maxAge = Math.floor((expiresAt - Date.now()) / 1000);

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
