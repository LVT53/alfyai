import { randomUUID } from "node:crypto";
import { decodeBase32IgnorePadding } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
	disableTwoStep,
	getTwoStepStatus,
	listTwoStepEnabled,
	regenerateBackupCodes,
	resetTwoStepForUser,
	sweepTwoStep,
	verifySecondFactor,
} from "./index";

// The service against the real, migrated test database: the replay guard and
// the single-use spend are conditional UPDATEs, and a mocked query builder
// would not show whether they actually stopped the second request.

const STEP_MS = 30_000;
const userEmails: string[] = [];

async function createUser(): Promise<{ userId: string; email: string }> {
	const userId = randomUUID();
	const email = `${userId}@example.com`;
	userEmails.push(userId);
	await db.insert(users).values({ id: userId, email, passwordHash: "hash" });
	return { userId, email };
}

function secretFromKey(key: string): Uint8Array {
	return decodeBase32IgnorePadding(key.replaceAll(" ", ""));
}

function totpAt(secret: Uint8Array, at: Date): string {
	return generateHOTP(secret, BigInt(Math.floor(at.getTime() / STEP_MS)), 6);
}

/** Starts and confirms setup, returning the secret and the ten codes. */
async function enableTwoStep(userId: string, email: string, now: Date) {
	const started = await beginTwoStepSetup(userId, email);
	if (!started.ok) throw new Error(`setup refused: ${started.reason}`);
	const secret = secretFromKey(started.key);
	const confirmed = await confirmTwoStepSetup(
		userId,
		totpAt(secret, now),
		now,
		null,
	);
	if (!confirmed.ok) throw new Error(`confirm refused: ${confirmed.reason}`);
	return { secret, codes: confirmed.backupCodes };
}

beforeEach(() => {
	userEmails.length = 0;
});

afterEach(async () => {
	for (const userId of userEmails) {
		await db.delete(users).where(eq(users.id, userId));
	}
});

describe("setup", () => {
	it("an unconfirmed factor leaves two-step off", async () => {
		const { userId, email } = await createUser();
		const now = new Date();
		const started = await beginTwoStepSetup(userId, email);

		expect(started.ok).toBe(true);
		const status = await getTwoStepStatus(userId);
		expect(status).toEqual({
			enabled: false,
			since: null,
			backupCodesLeft: 0,
		});

		if (!started.ok) return;
		const verified = await verifySecondFactor(
			userId,
			{ code: totpAt(secretFromKey(started.key), now) },
			now,
		);
		expect(verified).toEqual({ ok: false, reason: "not_enabled" });
	});

	it("a wrong code does not confirm", async () => {
		const { userId, email } = await createUser();
		const now = new Date();
		const started = await beginTwoStepSetup(userId, email);
		if (!started.ok) throw new Error("setup refused");
		const secret = secretFromKey(started.key);
		const right = totpAt(secret, now);
		const wrong = right === "000000" ? "111111" : "000000";

		const confirmed = await confirmTwoStepSetup(userId, wrong, now, null);

		expect(confirmed).toEqual({ ok: false, reason: "wrong_code" });
		expect((await getTwoStepStatus(userId)).enabled).toBe(false);
	});

	it("the right code confirms and returns 10 codes", async () => {
		const { userId, email } = await createUser();
		const now = new Date();
		const started = await beginTwoStepSetup(userId, email);
		if (!started.ok) throw new Error("setup refused");
		const code = totpAt(secretFromKey(started.key), now);

		const confirmed = await confirmTwoStepSetup(userId, code, now, null);

		expect(confirmed.ok).toBe(true);
		if (!confirmed.ok) return;
		expect(confirmed.backupCodes).toHaveLength(10);
		for (const backupCode of confirmed.backupCodes) {
			expect(backupCode).toMatch(
				/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/,
			);
		}

		const status = await getTwoStepStatus(userId);
		expect(status.enabled).toBe(true);
		expect(status.since?.getTime()).toBe(
			Math.floor(now.getTime() / 1000) * 1000,
		);
		expect(status.backupCodesLeft).toBe(10);
	});

	it("setup refuses when it is already on", async () => {
		const { userId, email } = await createUser();
		const now = new Date();
		await enableTwoStep(userId, email, now);

		expect(await beginTwoStepSetup(userId, email)).toEqual({
			ok: false,
			reason: "already_on",
		});
		// Still exactly the one confirmed factor.
		const rows = await db
			.select()
			.from(userSecondFactors)
			.where(eq(userSecondFactors.userId, userId));
		expect(rows).toHaveLength(1);
	});

	it("a confirm committing at the transaction boundary is refused, not overwritten", async () => {
		const { userId, email } = await createUser();
		const pending = await beginTwoStepSetup(userId, email);
		expect(pending.ok).toBe(true);

		const now = new Date();
		const runTransaction = db.transaction.bind(db) as unknown as (
			callback: (tx: unknown) => unknown,
		) => unknown;
		const transactionSpy = vi.spyOn(db, "transaction");
		transactionSpy.mockImplementation(((callback: (tx: unknown) => unknown) => {
			// A concurrent confirm commits exactly here: after any guard that ran
			// outside the transaction, before its own statements. The fixed setup
			// reads the confirmed row inside the transaction and refuses; a
			// check-then-act would insert over it and hit the unique index.
			db.update(userSecondFactors)
				.set({ confirmedAt: now, lastUsedStep: 0, updatedAt: now })
				.where(
					and(
						eq(userSecondFactors.userId, userId),
						isNull(userSecondFactors.confirmedAt),
					),
				)
				.run();
			return runTransaction(callback);
		}) as never);

		try {
			const raced = await beginTwoStepSetup(userId, email);
			expect(raced).toEqual({ ok: false, reason: "already_on" });
		} finally {
			transactionSpy.mockRestore();
		}

		// The confirm won and the refused setup wrote nothing over it.
		const rows = await db
			.select()
			.from(userSecondFactors)
			.where(eq(userSecondFactors.userId, userId));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.confirmedAt).not.toBeNull();
	});

	it("setup replaces an unconfirmed factor", async () => {
		const { userId, email } = await createUser();
		const first = await beginTwoStepSetup(userId, email);
		const second = await beginTwoStepSetup(userId, email);

		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(second.key).not.toBe(first.key);

		const rows = await db
			.select()
			.from(userSecondFactors)
			.where(eq(userSecondFactors.userId, userId));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.confirmedAt).toBeNull();
	});

	it("confirm signs out the other sessions and keeps the current", async () => {
		const { userId, email } = await createUser();
		const now = new Date();
		const current = await createSession(userId);
		const other = await createSession(userId);
		const started = await beginTwoStepSetup(userId, email);
		if (!started.ok) throw new Error("setup refused");

		const confirmed = await confirmTwoStepSetup(
			userId,
			totpAt(secretFromKey(started.key), now),
			now,
			current.token,
		);

		expect(confirmed.ok).toBe(true);
		if (!confirmed.ok) return;
		expect(confirmed.signedOutOtherDevices).toBe(1);
		const remaining = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(eq(sessions.userId, userId));
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.id).not.toBe(other.token);
	});
});

describe("verification", () => {
	it("accepts the current step either side, and refuses the same code twice", async () => {
		const { userId, email } = await createUser();
		const issued = new Date();
		const { secret } = await enableTwoStep(userId, email, issued);
		const currentStep = Math.floor(issued.getTime() / STEP_MS);

		// The next step's code is above the step confirm recorded, so it works.
		const next = new Date((currentStep + 1) * STEP_MS + 1_000);
		const code = totpAt(secret, next);
		expect(await verifySecondFactor(userId, { code }, next)).toEqual({
			ok: true,
			usedBackupCode: false,
			backupCodesLeft: 10,
		});

		// The same code inside its own step is a replay.
		expect(await verifySecondFactor(userId, { code }, new Date(next))).toEqual({
			ok: false,
			reason: "wrong_code",
		});
	});

	it("two racing verifications with one code: exactly one succeeds", async () => {
		const { userId, email } = await createUser();
		const issued = new Date();
		const { secret } = await enableTwoStep(userId, email, issued);
		const later = new Date(
			Math.floor(issued.getTime() / STEP_MS) * STEP_MS + STEP_MS + 1_000,
		);
		const code = totpAt(secret, later);

		const [first, second] = await Promise.all([
			verifySecondFactor(userId, { code }, later),
			verifySecondFactor(userId, { code }, later),
		]);

		expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
		expect([first, second].find((result) => !result.ok)).toEqual({
			ok: false,
			reason: "wrong_code",
		});
	});

	it("a backup code works once and the count drops", async () => {
		const { userId, email } = await createUser();
		const issued = new Date();
		const { codes } = await enableTwoStep(userId, email, issued);
		const code = codes[0];
		expect(code).toBeDefined();
		if (!code) return;

		// Typed loosely: lower case, no hyphen, O for 0, I/L for 1.
		const loose = code
			.toLowerCase()
			.replace("-", "")
			.replaceAll("0", "o")
			.replaceAll("1", "i");
		const used = await verifySecondFactor(
			userId,
			{ backupCode: loose },
			new Date(),
		);
		expect(used).toEqual({
			ok: true,
			usedBackupCode: true,
			backupCodesLeft: 9,
		});

		expect(
			await verifySecondFactor(userId, { backupCode: code }, new Date()),
		).toEqual({ ok: false, reason: "wrong_code" });
		expect((await getTwoStepStatus(userId)).backupCodesLeft).toBe(9);
	});

	it("a backup code cannot be spent by two racing requests", async () => {
		const { userId, email } = await createUser();
		const issued = new Date();
		const { codes } = await enableTwoStep(userId, email, issued);
		const backupCode = codes[0];
		if (!backupCode) return;

		const [first, second] = await Promise.all([
			verifySecondFactor(userId, { backupCode }, new Date()),
			verifySecondFactor(userId, { backupCode }, new Date()),
		]);

		expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
		expect((await getTwoStepStatus(userId)).backupCodesLeft).toBe(9);
	});

	it("an unreadable secret answers unreadable_secret, never a throw", async () => {
		const { userId, email } = await createUser();
		const issued = new Date();
		const { secret } = await enableTwoStep(userId, email, issued);
		await db
			.update(userSecondFactors)
			.set({ secretCiphertext: "not-a-ciphertext" })
			.where(eq(userSecondFactors.userId, userId));

		const later = new Date(issued.getTime() + 5 * STEP_MS);
		expect(
			await verifySecondFactor(userId, { code: totpAt(secret, later) }, later),
		).toEqual({ ok: false, reason: "unreadable_secret" });
	});
});

describe("turning off and new codes", () => {
	it("disable needs a valid code", async () => {
		const { userId, email } = await createUser();
		const issued = new Date();
		const { secret } = await enableTwoStep(userId, email, issued);

		const refused = await disableTwoStep(
			userId,
			{ code: "000000" },
			new Date(issued.getTime() + STEP_MS),
		);
		expect(refused.ok).toBe(false);
		expect((await getTwoStepStatus(userId)).enabled).toBe(true);

		const later = new Date(issued.getTime() + 2 * STEP_MS);
		const disabled = await disableTwoStep(
			userId,
			{ code: totpAt(secret, later) },
			later,
		);
		expect(disabled.ok).toBe(true);
		expect((await getTwoStepStatus(userId)).enabled).toBe(false);

		const codes = await db
			.select()
			.from(userBackupCodes)
			.where(eq(userBackupCodes.userId, userId));
		expect(codes).toHaveLength(0);
	});

	it("new codes need a valid code and replace the old ones", async () => {
		const { userId, email } = await createUser();
		const issued = new Date();
		const { secret, codes: oldCodes } = await enableTwoStep(
			userId,
			email,
			issued,
		);

		const refused = await regenerateBackupCodes(
			userId,
			{ code: "000000" },
			new Date(issued.getTime() + STEP_MS),
		);
		expect(refused.ok).toBe(false);

		const later = new Date(issued.getTime() + 2 * STEP_MS);
		const renewed = await regenerateBackupCodes(
			userId,
			{ code: totpAt(secret, later) },
			later,
		);
		expect(renewed.ok).toBe(true);
		if (!renewed.ok) return;
		expect(renewed.backupCodes).toHaveLength(10);
		expect((await getTwoStepStatus(userId)).backupCodesLeft).toBe(10);

		// The old codes really stop working.
		const oldCode = oldCodes[0];
		if (!oldCode) return;
		expect(
			await verifySecondFactor(userId, { backupCode: oldCode }, new Date()),
		).toEqual({ ok: false, reason: "wrong_code" });
	});
});

describe("reset and the sweep", () => {
	it("reset clears the factor, the codes and every session of the person", async () => {
		const { userId, email } = await createUser();
		const other = await createUser();
		const issued = new Date();
		await enableTwoStep(userId, email, issued);
		await createSession(userId);
		const otherSession = await createSession(other.userId);
		await db.insert(signInChallenges).values({
			id: randomUUID(),
			userId,
			expiresAt: new Date(Date.now() + 60_000),
		});

		await resetTwoStepForUser(userId);

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
		// The other person is untouched.
		expect(
			await db.select().from(sessions).where(eq(sessions.userId, other.userId)),
		).toHaveLength(1);

		// A session that belonged to somebody else is still valid.
		const stillThere = await db
			.select()
			.from(sessions)
			.where(and(eq(sessions.userId, other.userId)));
		expect(stillThere[0]?.id).toBeDefined();
		expect(otherSession.token).toBeDefined();
	});

	it("the sweep removes unconfirmed factors older than 15 minutes and expired attempts", async () => {
		const { userId, email } = await createUser();
		const now = new Date();
		await beginTwoStepSetup(userId, email);
		await db
			.update(userSecondFactors)
			.set({ createdAt: new Date(now.getTime() - 16 * 60 * 1000) })
			.where(eq(userSecondFactors.userId, userId));
		await db.insert(signInChallenges).values({
			id: randomUUID(),
			userId,
			expiresAt: new Date(now.getTime() - 1_000),
		});

		const swept = await sweepTwoStep(now);

		expect(swept.unconfirmed).toBeGreaterThanOrEqual(1);
		expect(swept.challenges).toBeGreaterThanOrEqual(1);
		expect(
			await db
				.select()
				.from(userSecondFactors)
				.where(eq(userSecondFactors.userId, userId)),
		).toHaveLength(0);
		expect(
			await db
				.select()
				.from(signInChallenges)
				.where(eq(signInChallenges.userId, userId)),
		).toHaveLength(0);
	});

	it("the sweep keeps a fresh unconfirmed factor and a live attempt", async () => {
		const { userId, email } = await createUser();
		const now = new Date();
		await beginTwoStepSetup(userId, email);
		await db.insert(signInChallenges).values({
			id: randomUUID(),
			userId,
			expiresAt: new Date(now.getTime() + 60_000),
		});

		await sweepTwoStep(now);

		expect(
			await db
				.select()
				.from(userSecondFactors)
				.where(eq(userSecondFactors.userId, userId)),
		).toHaveLength(1);
		expect(
			await db
				.select()
				.from(signInChallenges)
				.where(eq(signInChallenges.userId, userId)),
		).toHaveLength(1);
	});
});

describe("the admin list's read", () => {
	it("tells on exactly the accounts with a confirmed factor, in one look", async () => {
		const first = await createUser();
		const second = await createUser();
		const third = await createUser();
		const now = new Date();
		await enableTwoStep(first.userId, first.email, now);
		await beginTwoStepSetup(third.userId, third.email);

		const enabled = await listTwoStepEnabled([
			first.userId,
			second.userId,
			third.userId,
		]);

		expect(enabled.get(first.userId)).toBe(true);
		expect(enabled.get(second.userId)).toBe(false);
		expect(enabled.get(third.userId)).toBe(false);
	});
});
