import { randomUUID } from "node:crypto";
import * as bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import { sessions, users } from "$lib/server/db/schema";
import { createSession, hashSessionToken } from "$lib/server/services/auth";
import {
	_resetLoginRateLimitForTests,
	_setLoginRateLimitSleepForTests,
	LOGIN_RATE_LIMIT_POLICY,
} from "$lib/server/services/login-rate-limit";
import { MIN_PASSWORD_LENGTH } from "$lib/shared/password-policy";
import { PATCH } from "./+server";

// The Profile card tells the person before the server has to
// (account-form.test.ts holds that half). This holds the server's half at the
// exact edge, in terms of the one shared number, against a real account row.

const CURRENT_PASSWORD = "current-password-1";
let userId: string;

beforeEach(async () => {
	// The limiter's buckets live as long as the process, so a wrong password in
	// one case must not count against the next.
	_resetLoginRateLimitForTests();
	userId = randomUUID();
	await db.insert(users).values({
		id: userId,
		email: `${userId}@example.com`,
		passwordHash: bcrypt.hashSync(CURRENT_PASSWORD, 4),
	});
});

afterEach(async () => {
	// Its sessions go with it (the foreign key cascades).
	await db.delete(users).where(eq(users.id, userId));
});

/**
 * One PATCH as the signed-in person. `token` is the session cookie of the
 * device the request comes from, which the route keeps signed in.
 */
function changePasswordTo(
	newPassword: string,
	options: { currentPassword?: string; token?: string } = {},
) {
	return PATCH({
		request: new Request("http://localhost/api/settings/password", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				currentPassword: options.currentPassword ?? CURRENT_PASSWORD,
				newPassword,
			}),
		}),
		cookies: {
			get: (name: string) => (name === "session" ? options.token : undefined),
		},
		locals: { user: { id: userId } },
	} as unknown as Parameters<typeof PATCH>[0]);
}

async function storedHash(): Promise<string> {
	const [row] = await db
		.select({ hash: users.passwordHash })
		.from(users)
		.where(eq(users.id, userId));
	return row.hash;
}

function storedSessionIds() {
	return db
		.select({ id: sessions.id })
		.from(sessions)
		.where(eq(sessions.userId, userId))
		.then((rows) => rows.map((row) => row.id));
}

describe("PATCH /api/settings/password length", () => {
	it("refuses a new password one character under the minimum and keeps the old one", async () => {
		const response = await changePasswordTo(
			"x".repeat(MIN_PASSWORD_LENGTH - 1),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters`,
		});
		expect(await bcrypt.compare(CURRENT_PASSWORD, await storedHash())).toBe(
			true,
		);
	});

	it("changes the password when the new one is exactly the minimum", async () => {
		const newPassword = "y".repeat(MIN_PASSWORD_LENGTH);

		const response = await changePasswordTo(newPassword);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			signedOutOtherDevices: 0,
		});
		expect(await bcrypt.compare(newPassword, await storedHash())).toBe(true);
	});
});

// A stolen cookie, or a phone left signed in somewhere, must not outlive the
// password it was signed in with. The device that changes the password stays.
describe("PATCH /api/settings/password and the person's other devices", () => {
	const newPassword = "z".repeat(MIN_PASSWORD_LENGTH);

	it("a password change answers signedOutOtherDevices and leaves only the current session", async () => {
		const current = await createSession(userId);
		await createSession(userId);
		await createSession(userId, { rememberMe: false });

		const response = await changePasswordTo(newPassword, {
			token: current.token,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			signedOutOtherDevices: 2,
		});
		expect(await storedSessionIds()).toEqual([hashSessionToken(current.token)]);
		expect(await bcrypt.compare(newPassword, await storedHash())).toBe(true);
	});

	it("says 0 when this is the only device, and keeps it signed in", async () => {
		const current = await createSession(userId);

		const response = await changePasswordTo(newPassword, {
			token: current.token,
		});

		expect(await response.json()).toMatchObject({ signedOutOtherDevices: 0 });
		expect(await storedSessionIds()).toEqual([hashSessionToken(current.token)]);
	});

	it("signs out every session when the request carries no session of its own", async () => {
		await createSession(userId);
		await createSession(userId);

		const response = await changePasswordTo(newPassword);

		expect(await response.json()).toMatchObject({ signedOutOtherDevices: 2 });
		expect(await storedSessionIds()).toHaveLength(0);
	});

	it("a wrong current password signs nobody out", async () => {
		const current = await createSession(userId);
		await createSession(userId);

		const response = await changePasswordTo(newPassword, {
			token: current.token,
			currentPassword: "not-the-password",
		});

		expect(response.status).toBe(401);
		expect(await storedSessionIds()).toHaveLength(2);
		expect(await bcrypt.compare(CURRENT_PASSWORD, await storedHash())).toBe(
			true,
		);
	});

	it("a new password that is refused signs nobody out", async () => {
		const current = await createSession(userId);
		await createSession(userId);

		const response = await changePasswordTo(
			"x".repeat(MIN_PASSWORD_LENGTH - 1),
			{
				token: current.token,
			},
		);

		expect(response.status).toBe(400);
		expect(await storedSessionIds()).toHaveLength(2);
	});
});

// The current-password check is shared with the email change
// (checkCurrentPassword), and the budget with it: both count in the account's
// own namespace of the sign-in limiter.
describe("PATCH /api/settings/password and the limiter", () => {
	const budget = LOGIN_RATE_LIMIT_POLICY.maxFailuresPerAccount;
	const newPassword = "z".repeat(MIN_PASSWORD_LENGTH);

	beforeEach(() => {
		_setLoginRateLimitSleepForTests(async () => {});
	});

	afterEach(() => {
		_setLoginRateLimitSleepForTests();
	});

	it("counts every wrong current password, and answers the wrong one over budget as a 429", async () => {
		for (let attempt = 0; attempt < budget; attempt += 1) {
			const response = await changePasswordTo(newPassword, {
				currentPassword: "not-the-password",
			});
			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({
				error: "Current password is incorrect",
			});
		}

		const throttled = await changePasswordTo(newPassword, {
			currentPassword: "not-the-password",
		});

		expect(throttled.status).toBe(429);
		expect(Number(throttled.headers.get("Retry-After"))).toBeGreaterThan(0);
		expect(await throttled.json()).toMatchObject({
			errorKey: "login.tooManyAttempts",
		});
		expect(await bcrypt.compare(CURRENT_PASSWORD, await storedHash())).toBe(
			true,
		);
	});

	it("still takes the right password over budget", async () => {
		for (let attempt = 0; attempt < budget + 2; attempt += 1) {
			await changePasswordTo(newPassword, {
				currentPassword: "not-the-password",
			});
		}

		const response = await changePasswordTo(newPassword);

		expect(response.status).toBe(200);
		expect(await bcrypt.compare(newPassword, await storedHash())).toBe(true);
	});

	it("answers 404 for an account that is no longer there", async () => {
		await db.delete(users).where(eq(users.id, userId));

		const response = await changePasswordTo(newPassword);

		expect(response.status).toBe(404);
	});
});
