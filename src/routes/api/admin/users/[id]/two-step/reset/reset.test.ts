import { randomUUID } from "node:crypto";
import { decodeBase32IgnorePadding } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import {
	sessions,
	userBackupCodes,
	userSecondFactors,
	users,
} from "$lib/server/db/schema";
import { createSession } from "$lib/server/services/auth";
import {
	_resetLoginRateLimitForTests,
	_setLoginRateLimitSleepForTests,
} from "$lib/server/services/login-rate-limit";
import {
	beginTwoStepSetup,
	confirmTwoStepSetup,
	getTwoStepStatus,
} from "$lib/server/services/two-step";
import { POST } from "./+server";

type Event = Parameters<typeof POST>[0];
const STEP_MS = 30_000;
const PASSWORD = "admin-password-123";
const userIds: string[] = [];

function makeEvent(
	admin: { id: string; email: string; role: "admin" | "user" } | null,
	targetId: string,
	body: unknown,
): Event {
	return {
		request: new Request(
			`http://localhost/api/admin/users/${targetId}/two-step/reset`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			},
		),
		locals: { user: admin },
		params: { id: targetId },
		cookies: { get: () => undefined },
	} as unknown as Event;
}

function totpAt(secret: Uint8Array, at: Date): string {
	return generateHOTP(secret, BigInt(Math.floor(at.getTime() / STEP_MS)), 6);
}

async function createUser(role: "admin" | "user") {
	const userId = randomUUID();
	const email = `${userId}@example.com`;
	userIds.push(userId);
	await db.insert(users).values({
		id: userId,
		email,
		passwordHash: await bcrypt.hash(PASSWORD, 4),
		role,
	});
	return { id: userId, email, role };
}

async function enableTwoStep(userId: string, email: string) {
	const issued = new Date(Date.now() - 2 * STEP_MS);
	const started = await beginTwoStepSetup(userId, email);
	if (!started.ok) throw new Error("setup refused");
	const secret = decodeBase32IgnorePadding(started.key.replaceAll(" ", ""));
	const confirmed = await confirmTwoStepSetup(
		userId,
		totpAt(secret, issued),
		issued,
		null,
	);
	if (!confirmed.ok) throw new Error("confirm refused");
	return { secret };
}

async function seedTarget() {
	const target = await createUser("user");
	await enableTwoStep(target.id, target.email);
	await createSession(target.id);
	return target;
}

beforeEach(() => {
	_resetLoginRateLimitForTests();
	_setLoginRateLimitSleepForTests(async () => {});
});

afterEach(async () => {
	for (const userId of userIds) {
		await db.delete(users).where(eq(users.id, userId));
	}
	userIds.length = 0;
});

describe("POST /api/admin/users/[id]/two-step/reset", () => {
	it("refuses the admin's own account", async () => {
		const admin = await createUser("admin");
		await enableTwoStep(admin.id, admin.email);

		const response = await POST(
			makeEvent(admin, admin.id, { password: PASSWORD }),
		);

		expect(response.status).toBe(400);
		expect((await response.json()).errorKey).toBe(
			"admin.users.twoStepSelfReset",
		);
		// Still on.
		expect((await getTwoStepStatus(admin.id)).enabled).toBe(true);
	});

	it("refuses a wrong admin password and leaves the target alone", async () => {
		const admin = await createUser("admin");
		const target = await seedTarget();

		const response = await POST(
			makeEvent(admin, target.id, { password: "wrong-password" }),
		);

		expect(response.status).toBe(401);
		expect((await response.json()).errorKey).toBe(
			"profileTab.currentPasswordWrong",
		);
		expect((await getTwoStepStatus(target.id)).enabled).toBe(true);
	});

	it("asks for the admin's code when the admin has a factor", async () => {
		const admin = await createUser("admin");
		const { secret } = await enableTwoStep(admin.id, admin.email);
		const target = await seedTarget();

		const withoutCode = await POST(
			makeEvent(admin, target.id, { password: PASSWORD }),
		);
		expect(withoutCode.status).toBe(400);
		expect((await withoutCode.json()).errorKey).toBe(
			"admin.users.twoStepCodeRequired",
		);

		const wrongCode = await POST(
			makeEvent(admin, target.id, { password: PASSWORD, code: "000000" }),
		);
		expect(wrongCode.status).toBe(401);
		expect((await getTwoStepStatus(target.id)).enabled).toBe(true);

		const rightCode = await POST(
			makeEvent(admin, target.id, {
				password: PASSWORD,
				code: totpAt(secret, new Date()),
			}),
		);
		expect(rightCode.status).toBe(200);
		expect((await getTwoStepStatus(target.id)).enabled).toBe(false);
	});

	it("clears the factor, the codes and every session of the person", async () => {
		const admin = await createUser("admin");
		const target = await seedTarget();
		await createSession(target.id);

		const response = await POST(
			makeEvent(admin, target.id, { password: PASSWORD }),
		);

		expect(response.status).toBe(200);
		expect(
			await db
				.select()
				.from(userSecondFactors)
				.where(eq(userSecondFactors.userId, target.id)),
		).toHaveLength(0);
		expect(
			await db
				.select()
				.from(userBackupCodes)
				.where(eq(userBackupCodes.userId, target.id)),
		).toHaveLength(0);
		expect(
			await db.select().from(sessions).where(eq(sessions.userId, target.id)),
		).toHaveLength(0);
	});

	it("refuses a non-admin", async () => {
		const user = await createUser("user");
		const target = await seedTarget();

		await expect(
			POST(makeEvent(user, target.id, { password: PASSWORD })),
		).rejects.toMatchObject({ status: 403 });
	});

	it("needs a session", async () => {
		await expect(
			POST(makeEvent(null, randomUUID(), { password: PASSWORD })),
		).rejects.toMatchObject({ status: 302 });
	});
});
