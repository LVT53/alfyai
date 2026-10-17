import { randomUUID } from "node:crypto";
import { decodeBase32IgnorePadding } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import {
	sessions,
	signInChallenges,
	userBackupCodes,
	userSecondFactors,
	users,
} from "$lib/server/db/schema";
import { createSession } from "$lib/server/services/auth";
import {
	beginTwoStepSetup,
	confirmTwoStepSetup,
} from "$lib/server/services/two-step";
import { resetTwoStepByEmail } from "./reset-two-step";

const userIds: string[] = [];

afterEach(async () => {
	for (const userId of userIds) {
		await db.delete(users).where(eq(users.id, userId));
	}
	userIds.length = 0;
});

async function enableTwoStep() {
	const userId = randomUUID();
	const email = `${userId}@example.com`;
	userIds.push(userId);
	await db.insert(users).values({ id: userId, email, passwordHash: "hash" });

	const now = new Date();
	const started = await beginTwoStepSetup(userId, email);
	if (!started.ok) throw new Error("setup refused");
	const secret = decodeBase32IgnorePadding(started.key.replaceAll(" ", ""));
	const confirmed = await confirmTwoStepSetup(
		userId,
		generateHOTP(secret, BigInt(Math.floor(now.getTime() / 30_000)), 6),
		now,
		null,
	);
	if (!confirmed.ok) throw new Error("confirm refused");
	await createSession(userId);
	await db.insert(signInChallenges).values({
		id: randomUUID(),
		userId,
		expiresAt: new Date(Date.now() + 60_000),
	});
	return { userId, email, backupCodes: confirmed.backupCodes };
}

describe("the recovery script", () => {
	it("clears a person's factor, codes, attempts and sessions by email", async () => {
		const { userId, email } = await enableTwoStep();

		// An upper-case address finds the same account.
		const result = await resetTwoStepByEmail(email.toUpperCase());

		expect(result?.userId).toBe(userId);
		expect(
			await db
				.select()
				.from(userSecondFactors)
				.where(eq(userSecondFactors.userId, userId)),
		).toHaveLength(0);
		expect(
			await db
				.select()
				.from(userBackupCodes)
				.where(eq(userBackupCodes.userId, userId)),
		).toHaveLength(0);
		expect(
			await db
				.select()
				.from(signInChallenges)
				.where(eq(signInChallenges.userId, userId)),
		).toHaveLength(0);
		expect(
			await db.select().from(sessions).where(eq(sessions.userId, userId)),
		).toHaveLength(0);
	});

	it("says nothing was found for an address with no account", async () => {
		expect(await resetTwoStepByEmail("nobody@example.com")).toBeNull();
	});
});
