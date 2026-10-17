import { randomUUID } from "node:crypto";
import {
	and,
	count,
	eq,
	inArray,
	isNotNull,
	isNull,
	lt,
	or,
} from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	sessions,
	signInChallenges,
	userBackupCodes,
	userSecondFactors,
} from "$lib/server/db/schema";
import { revokeOtherSessionsInTransaction } from "$lib/server/services/auth";
import {
	decryptConnectionSecret,
	encryptConnectionSecret,
} from "$lib/server/services/connections/vault";
import {
	BACKUP_CODE_COUNT,
	backupCodeHashMatches,
	formatTotpKey,
	generateBackupCodes,
	generateTotpSecret,
	hashBackupCode,
	matchTotpStep,
	normalizeBackupCode,
	renderQrSvg,
	totpUri,
} from "./codes";

/**
 * The database half of two-step sign-in: the factor, its backup codes and the
 * read/write rules around them. No HTTP, no cookies, no limiter — the routes
 * and `challenges.ts` compose these calls.
 *
 * Every state write that must not happen twice is a conditional UPDATE that
 * reports the rows it changed (the TOTP replay guard, a backup code's single
 * use). SQLite evaluates it and the guard together, so two racing requests
 * cannot both win; a read followed by a separate write could.
 */

/** An unconfirmed factor older than this was abandoned, and the sweep removes it. */
export const UNCONFIRMED_FACTOR_TTL_MS = 15 * 60 * 1000;
const FACTOR_KIND_TOTP = "totp";

export type TwoStepStatus = {
	enabled: boolean;
	since: Date | null;
	backupCodesLeft: number;
};

export type SecondFactorInput = {
	/** A six-digit authenticator code. */
	code?: string;
	/** A one-time backup code, typed loosely. */
	backupCode?: string;
};

export type SetupStartResult =
	| { ok: true; qrSvg: string; key: string }
	| { ok: false; reason: "already_on" };

export type SetupConfirmResult =
	| {
			ok: true;
			backupCodes: string[];
			signedOutOtherDevices: number;
	  }
	| {
			ok: false;
			reason: "wrong_code" | "no_setup" | "unreadable_secret";
	  };

export type SecondFactorResult =
	| {
			ok: true;
			usedBackupCode: boolean;
			backupCodesLeft: number;
	  }
	| {
			ok: false;
			reason: "wrong_code" | "unreadable_secret" | "not_enabled";
	  };

export type DisableResult =
	| { ok: true; disabled: boolean }
	| { ok: false; reason: "wrong_code" | "unreadable_secret" };

export type RegenerateResult =
	| { ok: true; backupCodes: string[] }
	| { ok: false; reason: "wrong_code" | "unreadable_secret" | "not_enabled" };

type FactorRow = typeof userSecondFactors.$inferSelect;

/**
 * Hashes a freshly generated code. It always normalizes (the generator uses
 * the same alphabet), so a failure here is a programming error, not a user's
 * bad input: throwing keeps it from storing a hash of nothing.
 */
function hashIssuedBackupCode(code: string): string {
	const normalized = normalizeBackupCode(code);
	if (!normalized) {
		throw new Error("A generated backup code did not normalize");
	}
	return hashBackupCode(normalized);
}

function findFactor(
	userId: string,
	options: { confirmedOnly?: boolean } = {},
): Promise<FactorRow | null> {
	const where = options.confirmedOnly
		? and(
				eq(userSecondFactors.userId, userId),
				isNotNull(userSecondFactors.confirmedAt),
			)
		: eq(userSecondFactors.userId, userId);
	return db
		.select()
		.from(userSecondFactors)
		.where(where)
		.limit(1)
		.then((rows) => rows[0] ?? null);
}

/**
 * The plaintext secret behind a factor, or null when the vault cannot open it.
 * A changed `SESSION_SECRET` makes every stored secret unreadable; that is a
 * refusal with a clear answer, never a throw at sign-in.
 */
function readSecret(factor: FactorRow): Uint8Array | null {
	try {
		const base64 = decryptConnectionSecret({
			ciphertext: factor.secretCiphertext,
			iv: factor.secretIv,
			authTag: factor.secretAuthTag,
		});
		return new Uint8Array(Buffer.from(base64, "base64"));
	} catch {
		console.warn("[AUTH] two-step factor's secret cannot be decrypted", {
			userId: factor.userId,
		});
		return null;
	}
}

/**
 * Records the step of an accepted TOTP code, only if it is above the last one
 * this factor accepted. Returns whether this request is the one that won.
 */
function recordUsedStep(factorId: string, step: number, now: Date): boolean {
	const result = db
		.update(userSecondFactors)
		.set({ lastUsedStep: step, updatedAt: now })
		.where(
			and(
				eq(userSecondFactors.id, factorId),
				or(
					isNull(userSecondFactors.lastUsedStep),
					lt(userSecondFactors.lastUsedStep, step),
				),
			),
		)
		.run();
	return result.changes > 0;
}

/** How many backup codes the person has not spent yet. */
export async function countBackupCodesLeft(userId: string): Promise<number> {
	const [row] = await db
		.select({ value: count() })
		.from(userBackupCodes)
		.where(
			and(eq(userBackupCodes.userId, userId), isNull(userBackupCodes.usedAt)),
		);
	return Number(row?.value ?? 0);
}

/** Whether the account has a confirmed factor (two-step sign-in is on). */
export async function isTwoStepEnabled(userId: string): Promise<boolean> {
	return (await findFactor(userId, { confirmedOnly: true })) !== null;
}

/**
 * The Settings row and the admin detail: whether it is on, since when, and
 * how many one-time codes are left. It reads the confirmed factor, so an
 * abandoned setup reads Off.
 */
export async function getTwoStepStatus(userId: string): Promise<TwoStepStatus> {
	const factor = await findFactor(userId, { confirmedOnly: true });
	if (!factor) return { enabled: false, since: null, backupCodesLeft: 0 };
	return {
		enabled: true,
		since: factor.confirmedAt,
		backupCodesLeft: await countBackupCodesLeft(userId),
	};
}

/**
 * The status of many accounts at once (R18): the admin page reads every row
 * from two grouped queries, never one per account. `enabled` and `since` come
 * from the one factor query; `backupCodesLeft` from one grouped count. Every
 * requested id is in the map, so a caller never needs a fallback branch.
 */
export async function listTwoStepStatuses(
	userIds: readonly string[],
): Promise<Map<string, TwoStepStatus>> {
	const statuses = new Map<string, TwoStepStatus>(
		userIds.map((userId) => [
			userId,
			{ enabled: false, since: null, backupCodesLeft: 0 },
		]),
	);
	if (userIds.length === 0) return statuses;

	const factorRows = await db
		.select({
			userId: userSecondFactors.userId,
			confirmedAt: userSecondFactors.confirmedAt,
		})
		.from(userSecondFactors)
		.where(inArray(userSecondFactors.userId, [...userIds]));
	for (const row of factorRows) {
		if (!row.confirmedAt) continue;
		const status = statuses.get(row.userId);
		if (!status) continue;
		status.enabled = true;
		status.since = row.confirmedAt;
	}

	const codeRows = await db
		.select({ userId: userBackupCodes.userId, value: count() })
		.from(userBackupCodes)
		.where(
			and(
				inArray(userBackupCodes.userId, [...userIds]),
				isNull(userBackupCodes.usedAt),
			),
		)
		.groupBy(userBackupCodes.userId);
	for (const row of codeRows) {
		const status = statuses.get(row.userId);
		if (status) status.backupCodesLeft = Number(row.value);
	}

	return statuses;
}

/** The boolean form of {@link listTwoStepStatuses}, for callers that only ask whether it is on. */
export async function listTwoStepEnabled(
	userIds: readonly string[],
): Promise<Map<string, boolean>> {
	const statuses = await listTwoStepStatuses(userIds);
	return new Map(
		[...statuses].map(([userId, status]) => [userId, status.enabled]),
	);
}

/**
 * Starts setup: a fresh secret, encrypted into the factor row, with the QR
 * and the typed key returned ONCE.
 *
 * R13: an unconfirmed factor is replaced (a person who closed the dialog at
 * step 1 starts clean), and a confirmed one refuses with `already_on` — turn
 * it off first, never overwrite a working factor. A cheap pre-check keeps that
 * refusal from paying the vault's PBKDF2/AES to mint a secret nobody uses; the
 * confirmed read is then repeated inside the one transaction that deletes and
 * inserts, and the write lock SQLite takes at BEGIN (db/write-lock.ts) makes
 * two racing setups serialize. Without the in-transaction read a confirm
 * committing in between would make the insert hit the unique (user, kind)
 * index and answer 500.
 */
export async function beginTwoStepSetup(
	userId: string,
	email: string,
	imageUrl?: string,
): Promise<SetupStartResult> {
	// Cheap refusal before the expensive part: an account that is already on
	// needs no secret at all.
	if (await isTwoStepEnabled(userId))
		return { ok: false, reason: "already_on" };

	const secret = generateTotpSecret();
	const encrypted = encryptConnectionSecret(
		Buffer.from(secret).toString("base64"),
	);
	const now = new Date();

	let alreadyOn = false;
	db.transaction((tx) => {
		// Any confirmed factor means two-step sign-in is on, the same rule
		// `isTwoStepEnabled` applies.
		const confirmed = tx
			.select({ id: userSecondFactors.id })
			.from(userSecondFactors)
			.where(
				and(
					eq(userSecondFactors.userId, userId),
					isNotNull(userSecondFactors.confirmedAt),
				),
			)
			.get();
		if (confirmed) {
			alreadyOn = true;
			return;
		}

		tx.delete(userSecondFactors)
			.where(
				and(
					eq(userSecondFactors.userId, userId),
					eq(userSecondFactors.kind, FACTOR_KIND_TOTP),
					isNull(userSecondFactors.confirmedAt),
				),
			)
			.run();
		tx.insert(userSecondFactors)
			.values({
				id: randomUUID(),
				userId,
				kind: FACTOR_KIND_TOTP,
				secretCiphertext: encrypted.ciphertext,
				secretIv: encrypted.iv,
				secretAuthTag: encrypted.authTag,
				confirmedAt: null,
				lastUsedStep: null,
				createdAt: now,
				updatedAt: now,
			})
			.run();
	});

	if (alreadyOn) return { ok: false, reason: "already_on" };

	return {
		ok: true,
		qrSvg: renderQrSvg(totpUri(secret, email, imageUrl)),
		key: formatTotpKey(secret),
	};
}

/**
 * Finishes setup with a working code: confirms the factor, creates the ten
 * backup codes and signs out the account's other devices as ONE transaction
 * (R10). The current session's token is kept.
 *
 * The replay guard is checked in the same UPDATE that confirms, so two racing
 * confirmations cannot both turn it on, and the codes are not written if that
 * UPDATE changed nothing (the transaction rolls the rest back).
 */
export async function confirmTwoStepSetup(
	userId: string,
	code: string,
	now: Date,
	keepToken: string | null,
): Promise<SetupConfirmResult> {
	const factor = await findFactor(userId);
	if (!factor || factor.confirmedAt) return { ok: false, reason: "no_setup" };

	const secret = readSecret(factor);
	if (!secret) return { ok: false, reason: "unreadable_secret" };

	const step = matchTotpStep(secret, code, now);
	if (step === null) return { ok: false, reason: "wrong_code" };

	const backupCodes = generateBackupCodes(BACKUP_CODE_COUNT);
	const codeRows = backupCodes.map((backupCode) => ({
		id: randomUUID(),
		userId,
		codeHash: hashIssuedBackupCode(backupCode),
		createdAt: now,
	}));

	let confirmed = false;
	let signedOutOtherDevices = 0;
	db.transaction((tx) => {
		const update = tx
			.update(userSecondFactors)
			.set({ confirmedAt: now, lastUsedStep: step, updatedAt: now })
			.where(
				and(
					eq(userSecondFactors.id, factor.id),
					isNull(userSecondFactors.confirmedAt),
					or(
						isNull(userSecondFactors.lastUsedStep),
						lt(userSecondFactors.lastUsedStep, step),
					),
				),
			)
			.run();
		if (update.changes === 0) return;

		confirmed = true;
		tx.delete(userBackupCodes).where(eq(userBackupCodes.userId, userId)).run();
		tx.insert(userBackupCodes).values(codeRows).run();
		signedOutOtherDevices = revokeOtherSessionsInTransaction(
			tx,
			userId,
			keepToken,
			now,
		);
	});

	if (!confirmed) return { ok: false, reason: "wrong_code" };

	console.info("[AUTH] two-step turned on", {
		userId,
		signedOutOtherDevices,
	});
	return { ok: true, backupCodes, signedOutOtherDevices };
}

/**
 * Checks a code (or a backup code) against a CONFIRMED factor, spending a
 * backup code or recording the TOTP step as it goes.
 *
 * This is the one verification every caller shares: sign-in's second step,
 * Turn off, New backup codes and the admin's own code in a reset. It does not
 * touch the rate limiter — the caller knows which budget applies (R11) — and
 * it never throws for a bad code, a missing factor or an unreadable secret.
 */
export async function verifySecondFactor(
	userId: string,
	input: SecondFactorInput,
	now: Date,
): Promise<SecondFactorResult> {
	const factor = await findFactor(userId, { confirmedOnly: true });
	if (!factor) return { ok: false, reason: "not_enabled" };

	if (input.code) {
		const secret = readSecret(factor);
		if (!secret) return { ok: false, reason: "unreadable_secret" };

		const step = matchTotpStep(secret, input.code, now);
		if (step === null) return { ok: false, reason: "wrong_code" };
		if (!recordUsedStep(factor.id, step, now)) {
			return { ok: false, reason: "wrong_code" };
		}
		return {
			ok: true,
			usedBackupCode: false,
			backupCodesLeft: await countBackupCodesLeft(userId),
		};
	}

	if (input.backupCode) {
		const normalized = normalizeBackupCode(input.backupCode);
		if (!normalized) return { ok: false, reason: "wrong_code" };

		// Every unused code is compared in constant time; the matching row is
		// then spent in a guarded UPDATE, so a second request using the same
		// code loses even when it read the row first.
		const unused = await db
			.select({ id: userBackupCodes.id, codeHash: userBackupCodes.codeHash })
			.from(userBackupCodes)
			.where(
				and(eq(userBackupCodes.userId, userId), isNull(userBackupCodes.usedAt)),
			);
		const matched = unused.find((row) =>
			backupCodeHashMatches(row.codeHash, normalized),
		);
		if (!matched) return { ok: false, reason: "wrong_code" };

		const spent = db
			.update(userBackupCodes)
			.set({ usedAt: now })
			.where(
				and(eq(userBackupCodes.id, matched.id), isNull(userBackupCodes.usedAt)),
			)
			.run();
		if (spent.changes === 0) return { ok: false, reason: "wrong_code" };

		const backupCodesLeft = await countBackupCodesLeft(userId);
		console.info("[AUTH] two-step backup code used", {
			userId,
			backupCodesLeft,
		});
		return { ok: true, usedBackupCode: true, backupCodesLeft };
	}

	return { ok: false, reason: "wrong_code" };
}

/**
 * Turns two-step sign-in off: needs a code, then deletes the factor and every
 * backup code (spent or not). Already off reads as success, so a repeated
 * click is harmless.
 */
export async function disableTwoStep(
	userId: string,
	input: SecondFactorInput,
	now: Date,
): Promise<DisableResult> {
	const verified = await verifySecondFactor(userId, input, now);
	if (!verified.ok) {
		if (verified.reason === "not_enabled") return { ok: true, disabled: false };
		return { ok: false, reason: verified.reason };
	}

	db.transaction((tx) => {
		tx.delete(userBackupCodes).where(eq(userBackupCodes.userId, userId)).run();
		tx.delete(userSecondFactors)
			.where(eq(userSecondFactors.userId, userId))
			.run();
	});

	console.info("[AUTH] two-step turned off", { userId });
	return { ok: true, disabled: true };
}

/**
 * Replaces the ten backup codes, after the same code check as Turn off. The
 * old codes stop working the moment the transaction replaces them — including
 * the backup code just used to ask for the new ones.
 */
export async function regenerateBackupCodes(
	userId: string,
	input: SecondFactorInput,
	now: Date,
): Promise<RegenerateResult> {
	const verified = await verifySecondFactor(userId, input, now);
	if (!verified.ok) return verified;

	const backupCodes = generateBackupCodes(BACKUP_CODE_COUNT);
	const rows = backupCodes.map((backupCode) => ({
		id: randomUUID(),
		userId,
		codeHash: hashIssuedBackupCode(backupCode),
		createdAt: now,
	}));

	db.transaction((tx) => {
		tx.delete(userBackupCodes).where(eq(userBackupCodes.userId, userId)).run();
		tx.insert(userBackupCodes).values(rows).run();
	});

	return { ok: true, backupCodes };
}

/**
 * The admin reset and the recovery script: the factor, its backup codes, any
 * pending sign-in attempt and every session of the person, in ONE
 * transaction (R10). The caller logs which admin did it, if any.
 *
 * A pending attempt goes too, so a password typed before the reset cannot be
 * finished with a code from a factor that no longer exists; consuming an
 * attempt also re-checks the factor, as a second line of defence.
 */
export async function resetTwoStepForUser(userId: string): Promise<void> {
	db.transaction((tx) => {
		tx.delete(signInChallenges)
			.where(eq(signInChallenges.userId, userId))
			.run();
		tx.delete(userBackupCodes).where(eq(userBackupCodes.userId, userId)).run();
		tx.delete(userSecondFactors)
			.where(eq(userSecondFactors.userId, userId))
			.run();
		tx.delete(sessions).where(eq(sessions.userId, userId)).run();
	});
}

/**
 * Housekeeping for the two-step tables: expired attempts and abandoned
 * (unconfirmed) factors older than 15 minutes. No read depends on this — an
 * expired attempt is refused when it is presented — it only stops dead rows
 * from living forever.
 */
export async function sweepTwoStep(
	now: Date,
): Promise<{ challenges: number; unconfirmed: number }> {
	const challenges = db
		.delete(signInChallenges)
		.where(lt(signInChallenges.expiresAt, now))
		.run();
	const unconfirmed = db
		.delete(userSecondFactors)
		.where(
			and(
				isNull(userSecondFactors.confirmedAt),
				lt(
					userSecondFactors.createdAt,
					new Date(now.getTime() - UNCONFIRMED_FACTOR_TTL_MS),
				),
			),
		)
		.run();
	return {
		challenges: challenges.changes,
		unconfirmed: unconfirmed.changes,
	};
}
