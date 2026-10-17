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
	LOGIN_RATE_LIMIT_POLICY,
	recordLoginFailure,
} from "$lib/server/services/login-rate-limit";
import {
	beginTwoStepSetup,
	confirmTwoStepSetup,
	getTwoStepStatus,
	verifySecondFactor,
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
		request: new Request(
			"http://localhost/api/settings/two-step/backup-codes",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			},
		),
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
	backupCodes: string[];
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
	return { userId, email, secret, backupCodes: confirmed.backupCodes };
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

describe("POST /api/settings/two-step/backup-codes", () => {
	it("needs a valid code and replaces the old ones", async () => {
		const { userId, email, secret, backupCodes } = await enableTwoStep();

		const refused = await POST(
			makeEvent({ id: userId, email }, { code: "000000" }),
		);
		expect(refused.status).toBe(401);

		const response = await POST(
			makeEvent({ id: userId, email }, { code: totpAt(secret, new Date()) }),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.backupCodes).toHaveLength(10);
		expect((await getTwoStepStatus(userId)).backupCodesLeft).toBe(10);
		expect(
			await db
				.select()
				.from(userBackupCodes)
				.where(eq(userBackupCodes.userId, userId)),
		).toHaveLength(10);

		// The old codes really stop working.
		const oldCode = backupCodes[0];
		if (!oldCode) throw new Error("no old code");
		expect(
			await verifySecondFactor(userId, { backupCode: oldCode }, new Date()),
		).toEqual({ ok: false, reason: "wrong_code" });
	});

	it("answers 429 once the account has spent its wrong-code budget", async () => {
		const { userId, email, secret } = await enableTwoStep();
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
		expect((await getTwoStepStatus(userId)).backupCodesLeft).toBe(10);
	});

	it("a backup code can ask for new ones", async () => {
		const { userId, email, backupCodes } = await enableTwoStep();
		const backupCode = backupCodes[0];
		if (!backupCode) throw new Error("no code");

		const response = await POST(
			makeEvent({ id: userId, email }, { backupCode }),
		);

		expect(response.status).toBe(200);
		expect((await response.json()).backupCodes).toHaveLength(10);
	});

	it("needs a session", async () => {
		await expect(
			POST(makeEvent(null, { code: "123456" })),
		).rejects.toMatchObject({ status: 302 });
	});
});
