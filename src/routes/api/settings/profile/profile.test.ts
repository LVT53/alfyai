import { randomUUID } from "node:crypto";
import * as bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import {
	_resetLoginRateLimitForTests,
	_setLoginRateLimitSleepForTests,
	LOGIN_RATE_LIMIT_POLICY,
} from "$lib/server/services/login-rate-limit";
import { PATCH } from "./+server";

// Changing the email changes what signs a person in and where a reset would
// go, so a stolen session alone must not be enough: the account password is
// asked for, checked with the same bcrypt comparison the login uses, and every
// wrong answer is counted by the same limiter. A name change asks for nothing.
// Against real account rows, so what is stored after each answer is what is
// asserted, not what a mock was told.

const PASSWORD = "current-password-1";
const FAILURES_BEFORE_THE_PENALTY =
	LOGIN_RATE_LIMIT_POLICY.maxFailuresPerAccount;

let userId: string;
let email: string;
let strangerEmail: string;
let strangerId: string;

beforeEach(async () => {
	// The limiter's buckets live as long as the process, and the penalty's wait
	// would cost a real second per case.
	_resetLoginRateLimitForTests();
	_setLoginRateLimitSleepForTests(async () => {});

	userId = randomUUID();
	email = `${userId}@example.com`;
	await db.insert(users).values({
		id: userId,
		email,
		name: "Original Name",
		passwordHash: bcrypt.hashSync(PASSWORD, 4),
	});

	strangerId = randomUUID();
	strangerEmail = `${strangerId}@example.com`;
	await db.insert(users).values({
		id: strangerId,
		email: strangerEmail,
		passwordHash: bcrypt.hashSync("somebody-elses-1", 4),
	});
});

afterEach(async () => {
	_setLoginRateLimitSleepForTests();
	await db.delete(users).where(eq(users.id, userId));
	await db.delete(users).where(eq(users.id, strangerId));
});

function patchProfile(body: unknown) {
	return PATCH({
		request: new Request("http://localhost/api/settings/profile", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user: { id: userId } },
	} as unknown as Parameters<typeof PATCH>[0]);
}

async function stored() {
	const [row] = await db
		.select({ email: users.email, name: users.name })
		.from(users)
		.where(eq(users.id, userId));
	return row;
}

describe("PATCH /api/settings/profile: the email asks for the password", () => {
	it("an email change without currentPassword is refused", async () => {
		const response = await patchProfile({ email: "new-address@example.com" });

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "password_required" });
		expect((await stored()).email).toBe(email);
	});

	it.each([
		["empty", ""],
		["not text", 12345],
		["null", null],
	])("treats a currentPassword that is %s as no password", async (_label, currentPassword) => {
		const response = await patchProfile({
			email: "new-address@example.com",
			currentPassword,
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "password_required" });
		expect((await stored()).email).toBe(email);
	});

	it("a wrong currentPassword is refused and counted by the login limiter", async () => {
		const wrong = () =>
			patchProfile({
				email: "new-address@example.com",
				currentPassword: "not-the-password",
			});

		// Under the budget: a plain refusal, each one counted.
		for (let attempt = 0; attempt < FAILURES_BEFORE_THE_PENALTY; attempt += 1) {
			const response = await wrong();
			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({
				error: "Current password is incorrect",
			});
		}
		expect((await stored()).email).toBe(email);

		// Over it: the same wrong answer is now reported as the throttle it is.
		const throttled = await wrong();
		expect(throttled.status).toBe(429);
		expect(Number(throttled.headers.get("Retry-After"))).toBeGreaterThan(0);
		expect(await throttled.json()).toMatchObject({
			errorKey: "profileTab.currentPasswordTooManyAttempts",
		});
		expect((await stored()).email).toBe(email);
	});

	it("still takes the right password while throttled, and then forgets the failures", async () => {
		for (let attempt = 0; attempt < FAILURES_BEFORE_THE_PENALTY; attempt += 1) {
			await patchProfile({
				email: "new-address@example.com",
				currentPassword: "not-the-password",
			});
		}

		const right = await patchProfile({
			email: "new-address@example.com",
			currentPassword: PASSWORD,
		});
		expect(right.status).toBe(200);
		expect((await stored()).email).toBe("new-address@example.com");

		// The count was cleared by the success: a wrong answer is a plain 401
		// again, not a 429.
		const wrongAgain = await patchProfile({
			email: "another-address@example.com",
			currentPassword: "not-the-password",
		});
		expect(wrongAgain.status).toBe(401);
	});

	it("the right password changes the email", async () => {
		const response = await patchProfile({
			email: "  New-Address@Example.COM ",
			currentPassword: PASSWORD,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			name: "Original Name",
			email: "new-address@example.com",
		});
		expect((await stored()).email).toBe("new-address@example.com");
	});

	it("changes the name and the email together when the password is right", async () => {
		const response = await patchProfile({
			name: "  New Name ",
			email: "new-address@example.com",
			currentPassword: PASSWORD,
		});

		expect(response.status).toBe(200);
		expect(await stored()).toEqual({
			name: "New Name",
			email: "new-address@example.com",
		});
	});

	it("a refused email change applies none of the request, the name included", async () => {
		const response = await patchProfile({
			name: "Changed Name",
			email: "new-address@example.com",
		});

		expect(response.status).toBe(400);
		expect(await stored()).toEqual({ name: "Original Name", email });
	});

	it("checks the password before it says an address is taken", async () => {
		// A stolen session must not be able to learn which addresses have
		// accounts without the password.
		const withoutIt = await patchProfile({
			email: strangerEmail,
			currentPassword: "not-the-password",
		});
		expect(withoutIt.status).toBe(401);

		const withIt = await patchProfile({
			email: strangerEmail,
			currentPassword: PASSWORD,
		});
		expect(withIt.status).toBe(409);
		expect((await stored()).email).toBe(email);
	});

	it("still refuses something that is not an address before it asks for anything", async () => {
		const response = await patchProfile({ email: "not-an-address" });

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Invalid email address" });
	});
});

describe("PATCH /api/settings/profile: what needs no password", () => {
	it("a name change needs no password", async () => {
		const response = await patchProfile({ name: "  New Name " });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ name: "New Name", email });
		expect(await stored()).toEqual({ name: "New Name", email });
	});

	it("a name change that carries the unchanged email needs no password", async () => {
		const response = await patchProfile({ name: "New Name", email });

		expect(response.status).toBe(200);
		expect(await stored()).toEqual({ name: "New Name", email });
	});

	it("the same address in other letters or with spaces is not a change", async () => {
		const response = await patchProfile({
			name: "New Name",
			email: `  ${email.toUpperCase()} `,
		});

		expect(response.status).toBe(200);
		expect(await stored()).toEqual({ name: "New Name", email });
	});

	it("does not count a name change against the limiter", async () => {
		for (
			let attempt = 0;
			attempt < FAILURES_BEFORE_THE_PENALTY + 2;
			attempt += 1
		) {
			const response = await patchProfile({ name: `Name ${attempt}` });
			expect(response.status).toBe(200);
		}
	});
});
