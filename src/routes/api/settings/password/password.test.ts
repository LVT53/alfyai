import { randomUUID } from "node:crypto";
import * as bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { MIN_PASSWORD_LENGTH } from "$lib/shared/password-policy";
import { PATCH } from "./+server";

// The Profile card tells the person before the server has to
// (account-form.test.ts holds that half). This holds the server's half at the
// exact edge, in terms of the one shared number, against a real account row.

const CURRENT_PASSWORD = "current-password-1";
let userId: string;

beforeEach(async () => {
	userId = randomUUID();
	await db.insert(users).values({
		id: userId,
		email: `${userId}@example.com`,
		passwordHash: bcrypt.hashSync(CURRENT_PASSWORD, 4),
	});
});

afterEach(async () => {
	await db.delete(users).where(eq(users.id, userId));
});

function changePasswordTo(newPassword: string) {
	return PATCH({
		request: new Request("http://localhost/api/settings/password", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ currentPassword: CURRENT_PASSWORD, newPassword }),
		}),
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
		expect(await response.json()).toEqual({ success: true });
		expect(await bcrypt.compare(newPassword, await storedHash())).toBe(true);
	});
});
