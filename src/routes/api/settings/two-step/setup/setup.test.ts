import { randomUUID } from "node:crypto";
import { decodeBase32IgnorePadding } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "$lib/server/db";
import { userSecondFactors, users } from "$lib/server/db/schema";
import {
	_resetLoginRateLimitForTests,
	_setLoginRateLimitSleepForTests,
} from "$lib/server/services/login-rate-limit";
import { getTwoStepStatus } from "$lib/server/services/two-step";
import { POST } from "./+server";

// The route's call is what this test observes; the real service still runs.
const beginSetup = vi.hoisted(() => vi.fn());
vi.mock("$lib/server/services/two-step", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/server/services/two-step")>();
	beginSetup.mockImplementation(actual.beginTwoStepSetup);
	return { ...actual, beginTwoStepSetup: beginSetup };
});

type Event = Parameters<typeof POST>[0];
const ORIGIN = "https://alfyai.example";
const userIds: string[] = [];

function makeEvent(user: { id: string; email: string } | null): Event {
	return {
		request: new Request(`${ORIGIN}/api/settings/two-step/setup`, {
			method: "POST",
		}),
		url: new URL(`${ORIGIN}/api/settings/two-step/setup`),
		locals: { user },
		cookies: { get: () => undefined },
	} as unknown as Event;
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
	beginSetup.mockClear();
});

afterEach(async () => {
	for (const userId of userIds) {
		await db.delete(users).where(eq(users.id, userId));
	}
	userIds.length = 0;
});

describe("POST /api/settings/two-step/setup", () => {
	it("needs a session", async () => {
		await expect(POST(makeEvent(null))).rejects.toMatchObject({ status: 302 });
	});

	it("returns the QR and the key once, and leaves it unconfirmed", async () => {
		const { userId, email } = await createUser();

		const response = await POST(makeEvent({ id: userId, email }));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.qrSvg.startsWith("<svg")).toBe(true);
		expect(data.key).toMatch(/^(?:[A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
		// The key really is the secret the QR carries: it decodes to 20 bytes.
		expect(
			decodeBase32IgnorePadding(data.key.replaceAll(" ", "")),
		).toHaveLength(20);

		const [factor] = await db
			.select()
			.from(userSecondFactors)
			.where(eq(userSecondFactors.userId, userId));
		expect(factor?.confirmedAt).toBeNull();
		expect((await getTwoStepStatus(userId)).enabled).toBe(false);
	});

	it("refuses with a clear 409 once a confirmed factor exists", async () => {
		const { userId, email } = await createUser();
		const started = await beginSetupAndConfirm(userId, email);

		const response = await POST(makeEvent({ id: userId, email }));

		expect(response.status).toBe(409);
		expect((await response.json()).errorKey).toBe(
			"profileTab.twoStepAlreadyOn",
		);
		expect(started).toBe(true);
	});

	it("passes the public origin's AlfyAI mark as the authenticator image", async () => {
		const { userId, email } = await createUser();

		const response = await POST(makeEvent({ id: userId, email }));

		expect(response.status).toBe(200);
		expect(beginSetup).toHaveBeenCalledWith(
			userId,
			email,
			`${ORIGIN}/icon-192.png`,
		);
	});
});

// A local confirm through the service, so the test is about the route's
// refusal rather than repeating the whole two-step flow.
async function beginSetupAndConfirm(
	userId: string,
	email: string,
): Promise<boolean> {
	const { beginTwoStepSetup, confirmTwoStepSetup } = await import(
		"$lib/server/services/two-step"
	);
	const started = await beginTwoStepSetup(userId, email);
	if (!started.ok) return false;
	const secret = decodeBase32IgnorePadding(started.key.replaceAll(" ", ""));
	const now = new Date();
	const code = generateHOTP(
		secret,
		BigInt(Math.floor(now.getTime() / 30_000)),
		6,
	);
	const confirmed = await confirmTwoStepSetup(userId, code, now, null);
	return confirmed.ok;
}
