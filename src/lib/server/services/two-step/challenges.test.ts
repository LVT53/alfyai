import { createHash, randomUUID } from "node:crypto";
import type { Cookies } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "$lib/server/db";
import { signInChallenges, users } from "$lib/server/db/schema";
import {
	ATTEMPT_TTL_MS,
	clearSignInAttemptCookie,
	createSignInChallenge,
	hashSignInAttemptToken,
	SIGN_IN_ATTEMPT_COOKIE,
	setSignInAttemptCookie,
} from "$lib/server/services/two-step";

const userIds: string[] = [];

async function createUser(): Promise<string> {
	const userId = randomUUID();
	userIds.push(userId);
	await db
		.insert(users)
		.values({ id: userId, email: `${userId}@example.com`, passwordHash: "h" });
	return userId;
}

afterEach(async () => {
	for (const userId of userIds) {
		await db.delete(users).where(eq(users.id, userId));
	}
	userIds.length = 0;
});

describe("the sign-in attempt cookie", () => {
	it("has the spec's flags", () => {
		const set = vi.fn();
		setSignInAttemptCookie({ set } as unknown as Pick<Cookies, "set">, "tok");

		expect(set).toHaveBeenCalledWith(SIGN_IN_ATTEMPT_COOKIE, "tok", {
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: "strict",
			path: "/api/auth",
			maxAge: 300,
		});
		expect(SIGN_IN_ATTEMPT_COOKIE).toBe("signin_attempt");
		expect(ATTEMPT_TTL_MS).toBe(300_000);
	});

	it("sets no cookie attribute that would widen it", () => {
		const set = vi.fn();
		setSignInAttemptCookie({ set } as unknown as Pick<Cookies, "set">, "tok");
		const options = set.mock.calls[0]?.[2] as Record<string, unknown>;

		expect(options.domain).toBeUndefined();
		expect(options.path).toBe("/api/auth");
	});

	it("clears on the same path it was set", () => {
		const del = vi.fn();
		clearSignInAttemptCookie({ delete: del } as unknown as Pick<
			Cookies,
			"delete"
		>);

		expect(del).toHaveBeenCalledWith(SIGN_IN_ATTEMPT_COOKIE, {
			path: "/api/auth",
		});
	});
});

describe("the attempt row", () => {
	it("stores only the token's SHA-256, and remembers remember-me", async () => {
		const userId = await createUser();
		const now = new Date();
		const attempt = await createSignInChallenge(userId, true, now);

		expect(attempt.token).toMatch(/^[0-9a-f]{64}$/);
		expect(attempt.expiresAt.getTime()).toBe(now.getTime() + 300_000);
		expect(hashSignInAttemptToken(attempt.token)).toBe(
			createHash("sha256").update(attempt.token).digest("hex"),
		);

		const [row] = await db
			.select()
			.from(signInChallenges)
			.where(eq(signInChallenges.userId, userId));
		expect(row?.id).toBe(hashSignInAttemptToken(attempt.token));
		expect(row?.id).not.toBe(attempt.token);
		expect(row?.rememberMe).toBe(true);
		expect(row?.attempts).toBe(0);
	});
});
