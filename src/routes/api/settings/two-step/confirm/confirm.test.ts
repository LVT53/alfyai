import { randomUUID } from "node:crypto";
import { decodeBase32IgnorePadding } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import { sessions, userBackupCodes, users } from "$lib/server/db/schema";
import { createSession, hashSessionToken } from "$lib/server/services/auth";
import {
	_resetLoginRateLimitForTests,
	_setLoginRateLimitSleepForTests,
	LOGIN_RATE_LIMIT_POLICY,
	recordLoginFailure,
} from "$lib/server/services/login-rate-limit";
import {
	beginTwoStepSetup,
	getTwoStepStatus,
} from "$lib/server/services/two-step";
import { POST } from "./+server";

type Event = Parameters<typeof POST>[0];
const STEP_MS = 30_000;
const userIds: string[] = [];

function makeEvent(
	user: { id: string; email: string } | null,
	body: unknown,
	sessionToken?: string,
): Event {
	return {
		request: new Request("http://localhost/api/settings/two-step/confirm", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user },
		cookies: {
			get: (name: string) => (name === "session" ? sessionToken : undefined),
		},
	} as unknown as Event;
}

function totpAt(secret: Uint8Array, at: Date): string {
	return generateHOTP(secret, BigInt(Math.floor(at.getTime() / STEP_MS)), 6);
}

async function createUser(): Promise<{ userId: string; email: string }> {
	const userId = randomUUID();
	const email = `${userId}@example.com`;
	userIds.push(userId);
	await db.insert(users).values({ id: userId, email, passwordHash: "hash" });
	return { userId, email };
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

describe("POST /api/settings/two-step/confirm", () => {
	it("needs a session", async () => {
		await expect(
			POST(makeEvent(null, { code: "123456" })),
		).rejects.toMatchObject({ status: 302 });
	});

	it("signs out the other sessions and returns the ten codes", async () => {
		const { userId, email } = await createUser();
		const current = await createSession(userId);
		await createSession(userId);
		const started = await beginTwoStepSetup(userId, email);
		if (!started.ok) throw new Error("setup refused");
		const secret = decodeBase32IgnorePadding(started.key.replaceAll(" ", ""));

		const response = await POST(
			makeEvent(
				{ id: userId, email },
				{ code: totpAt(secret, new Date()) },
				current.token,
			),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.backupCodes).toHaveLength(10);
		expect(data.signedOutOtherDevices).toBe(1);

		// The session that survives is THIS one, not merely "one of them".
		const remaining = await db
			.select()
			.from(sessions)
			.where(eq(sessions.userId, userId));
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.id).toBe(hashSessionToken(current.token));
		expect((await getTwoStepStatus(userId)).enabled).toBe(true);
		const codes = await db
			.select()
			.from(userBackupCodes)
			.where(eq(userBackupCodes.userId, userId));
		expect(codes).toHaveLength(10);
	});

	it("answers 429 once the account has spent its wrong-code budget", async () => {
		const { userId, email } = await createUser();
		const started = await beginTwoStepSetup(userId, email);
		if (!started.ok) throw new Error("setup refused");
		const secret = decodeBase32IgnorePadding(started.key.replaceAll(" ", ""));
		for (
			let attempt = 0;
			attempt < LOGIN_RATE_LIMIT_POLICY.maxFailuresPerAccount;
			attempt += 1
		) {
			recordLoginFailure({ accountId: userId });
		}
		const right = totpAt(secret, new Date());
		const wrong =
			right[0] === "0" ? `1${right.slice(1)}` : `0${right.slice(1)}`;

		const response = await POST(
			makeEvent({ id: userId, email }, { code: wrong }),
		);

		expect(response.status).toBe(429);
		expect((await response.json()).errorKey).toBe(
			"profileTab.twoStepTooManyAttempts",
		);
		expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
		expect((await getTwoStepStatus(userId)).enabled).toBe(false);
	});

	it("a wrong code does not finish setup", async () => {
		const { userId, email } = await createUser();
		const started = await beginTwoStepSetup(userId, email);
		if (!started.ok) throw new Error("setup refused");
		const secret = decodeBase32IgnorePadding(started.key.replaceAll(" ", ""));
		const right = totpAt(secret, new Date());
		const wrong = right === "000000" ? "111111" : "000000";

		const response = await POST(
			makeEvent({ id: userId, email }, { code: wrong }),
		);

		expect(response.status).toBe(401);
		expect((await response.json()).errorKey).toBe(
			"profileTab.twoStepWrongCode",
		);
		expect((await getTwoStepStatus(userId)).enabled).toBe(false);
	});
});
