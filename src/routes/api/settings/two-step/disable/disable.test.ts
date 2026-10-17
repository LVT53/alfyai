import { randomUUID } from "node:crypto";
import { decodeBase32IgnorePadding } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import { userBackupCodes, users } from "$lib/server/db/schema";
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
const userIds: string[] = [];

function makeEvent(
	user: { id: string; email: string } | null,
	body: unknown,
): Event {
	return {
		request: new Request("http://localhost/api/settings/two-step/disable", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user },
		cookies: { get: () => undefined },
	} as unknown as Event;
}

function totpAt(secret: Uint8Array, at: Date): string {
	return generateHOTP(secret, BigInt(Math.floor(at.getTime() / STEP_MS)), 6);
}

async function enableTwoStep(): Promise<{
	userId: string;
	email: string;
	secret: Uint8Array;
}> {
	const userId = randomUUID();
	const email = `${userId}@example.com`;
	userIds.push(userId);
	await db.insert(users).values({ id: userId, email, passwordHash: "hash" });

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
	return { userId, email, secret };
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

describe("POST /api/settings/two-step/disable", () => {
	it("needs a valid code", async () => {
		const { userId, email } = await enableTwoStep();

		const response = await POST(
			makeEvent({ id: userId, email }, { code: "000000" }),
		);

		expect(response.status).toBe(401);
		expect((await response.json()).errorKey).toBe(
			"profileTab.twoStepWrongCode",
		);
		expect((await getTwoStepStatus(userId)).enabled).toBe(true);
	});

	it("turns it off with a current code and deletes the backup codes", async () => {
		const { userId, email, secret } = await enableTwoStep();

		const response = await POST(
			makeEvent({ id: userId, email }, { code: totpAt(secret, new Date()) }),
		);

		expect(response.status).toBe(200);
		expect((await response.json()).wasOn).toBe(true);
		expect((await getTwoStepStatus(userId)).enabled).toBe(false);
		expect(
			await db
				.select()
				.from(userBackupCodes)
				.where(eq(userBackupCodes.userId, userId)),
		).toHaveLength(0);
	});

	it("already off reads as success", async () => {
		const userId = randomUUID();
		const email = `${userId}@example.com`;
		userIds.push(userId);
		await db.insert(users).values({ id: userId, email, passwordHash: "hash" });

		const response = await POST(
			makeEvent({ id: userId, email }, { code: "123456" }),
		);

		expect(response.status).toBe(200);
		expect((await response.json()).wasOn).toBe(false);
	});
});
