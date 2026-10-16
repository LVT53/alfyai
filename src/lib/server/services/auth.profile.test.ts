import { randomUUID } from "node:crypto";
import * as bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { updateOwnProfile } from "./auth";
import {
	_resetLoginRateLimitForTests,
	_setLoginRateLimitSleepForTests,
	LOGIN_RATE_LIMIT_POLICY,
} from "./login-rate-limit";

// What a person may change about themselves on the Profile card, and what each
// change costs. The policy lives here, not in the route: a name asks for
// nothing; an email is what signs a person in, so changing it asks for the
// account password, checked like the sign-in's (one budget of wrong answers
// per account) and before the answer to "is this address taken", so a stolen
// session cannot learn which addresses have accounts. Real account rows.

const PASSWORD = "current-password-1";
const NEW_ADDRESS = "new-address@example.com";

let userId: string;
let email: string;
let strangerEmail: string;
let strangerId: string;

beforeEach(async () => {
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

async function stored() {
	const [row] = await db
		.select({ email: users.email, name: users.name })
		.from(users)
		.where(eq(users.id, userId));
	return row;
}

describe("updateOwnProfile: a name", () => {
	it("is stored trimmed and needs no password", async () => {
		expect(await updateOwnProfile(userId, { name: "  New Name " })).toEqual({
			status: "updated",
			name: "New Name",
			email,
		});
		expect(await stored()).toEqual({ name: "New Name", email });
	});

	it("is cleared by an empty one", async () => {
		expect(await updateOwnProfile(userId, { name: "   " })).toMatchObject({
			status: "updated",
			name: null,
		});
		expect((await stored()).name).toBeNull();
	});

	it("is never counted against the limiter", async () => {
		const budget = LOGIN_RATE_LIMIT_POLICY.maxFailuresPerAccount;
		for (let attempt = 0; attempt < budget + 2; attempt += 1) {
			expect(
				await updateOwnProfile(userId, { name: `Name ${attempt}` }),
			).toMatchObject({ status: "updated" });
		}
	});
});

describe("updateOwnProfile: an email", () => {
	it("is refused without the password, and nothing in the request is applied", async () => {
		const result = await updateOwnProfile(userId, {
			name: "Changed Name",
			email: NEW_ADDRESS,
		});

		expect(result).toEqual({ status: "password_required" });
		expect(await stored()).toEqual({ name: "Original Name", email });
	});

	it("treats an empty password as none", async () => {
		expect(
			await updateOwnProfile(userId, {
				email: NEW_ADDRESS,
				currentPassword: "",
			}),
		).toEqual({ status: "password_required" });
	});

	it("is refused with a wrong password, which the account's budget counts", async () => {
		const budget = LOGIN_RATE_LIMIT_POLICY.maxFailuresPerAccount;
		const wrong = () =>
			updateOwnProfile(userId, {
				email: NEW_ADDRESS,
				currentPassword: "not-the-password",
			});

		for (let attempt = 0; attempt < budget; attempt += 1) {
			expect(await wrong()).toEqual({
				status: "password_refused",
				check: { outcome: "wrong" },
			});
		}
		const over = await wrong();

		expect(over).toMatchObject({
			status: "password_refused",
			check: { outcome: "throttled" },
		});
		expect((await stored()).email).toBe(email);
	});

	it("is changed, normalized, by the right password", async () => {
		const result = await updateOwnProfile(userId, {
			email: "  New-Address@Example.COM ",
			currentPassword: PASSWORD,
		});

		expect(result).toEqual({
			status: "updated",
			name: "Original Name",
			email: NEW_ADDRESS,
		});
		expect((await stored()).email).toBe(NEW_ADDRESS);
	});

	it("is changed together with the name by the right password", async () => {
		await updateOwnProfile(userId, {
			name: " New Name ",
			email: NEW_ADDRESS,
			currentPassword: PASSWORD,
		});

		expect(await stored()).toEqual({ name: "New Name", email: NEW_ADDRESS });
	});

	it("is checked against the password before it is called taken", async () => {
		expect(
			await updateOwnProfile(userId, {
				email: strangerEmail,
				currentPassword: "not-the-password",
			}),
		).toMatchObject({ status: "password_refused" });

		expect(
			await updateOwnProfile(userId, {
				email: strangerEmail,
				currentPassword: PASSWORD,
			}),
		).toEqual({ status: "email_taken" });
		expect((await stored()).email).toBe(email);
	});

	it("needs no password when it is the same address in other letters, and keeps the stored one", async () => {
		const result = await updateOwnProfile(userId, {
			name: "New Name",
			email: `  ${email.toUpperCase()} `,
		});

		expect(result).toEqual({ status: "updated", name: "New Name", email });
		expect(await stored()).toEqual({ name: "New Name", email });
	});

	it("needs no password when the unchanged address rides along with a rename", async () => {
		expect(
			await updateOwnProfile(userId, { name: "New Name", email }),
		).toMatchObject({ status: "updated" });
	});
});

describe("updateOwnProfile: a person who is not there", () => {
	it("is not found, whether the email or only the name was sent", async () => {
		await db.delete(users).where(eq(users.id, userId));

		expect(await updateOwnProfile(userId, { email: NEW_ADDRESS })).toEqual({
			status: "not_found",
		});
		expect(await updateOwnProfile(userId, { name: "Name" })).toEqual({
			status: "not_found",
		});
	});
});
