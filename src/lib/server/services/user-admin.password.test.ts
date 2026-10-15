import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { MIN_PASSWORD_LENGTH } from "$lib/shared/password-policy";
import { createManagedUser } from "./user-admin";

// The Create user dialog tells the admin before the server has to
// (CreateUserModal.test.ts holds that half). This holds the server's half at
// the exact edge, in terms of the one shared number, so a copy of it that
// drifts fails here.

let email: string;

beforeEach(() => {
	email = `password-edge-${randomUUID()}@example.com`;
});

afterEach(async () => {
	await db.delete(users).where(eq(users.email, email));
});

function accountsWithThatEmail() {
	return db.select({ id: users.id }).from(users).where(eq(users.email, email));
}

describe("createManagedUser password length", () => {
	it("refuses a password one character under the minimum and creates nobody", async () => {
		await expect(
			createManagedUser({
				email,
				password: "x".repeat(MIN_PASSWORD_LENGTH - 1),
			}),
		).rejects.toThrow(
			`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
		);
		expect(await accountsWithThatEmail()).toHaveLength(0);
	});

	it("creates the account when the password is exactly the minimum", async () => {
		const created = await createManagedUser({
			email,
			password: "x".repeat(MIN_PASSWORD_LENGTH),
		});
		expect(created.email).toBe(email);
		expect(await accountsWithThatEmail()).toHaveLength(1);
	});
});
