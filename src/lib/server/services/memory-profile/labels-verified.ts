import { and, eq, isNull, ne, or } from "drizzle-orm";
import type { MemoryPageLayout } from "$lib/memory-types";
import { type DatabaseInstance, db } from "$lib/server/db";
import { memoryAccounts } from "$lib/server/db/schema";
import type { Tx } from "../jobs/types";

/**
 * Whether an account's labels are verified, and so which Memory page it gets
 * (Memory part 3). The state is kept per epoch, in
 * `memory_accounts.labels_unverified_epoch`: the epoch whose banks may hold
 * facts from before bank config 2, which carry no labels. Labels are verified
 * when it is null or names another epoch than the account's. Migration 143
 * marked every account that already had a bank in its current epoch; a new
 * account, and a new epoch after Clear Memory or erasure, starts with banks
 * created at config 2 and is never marked. `ensureConfiguredBank` marks the
 * epoch again when a config-1 bank is upgraded in place, unless the label
 * migration has verified that epoch: it clears the mark through
 * `markMemoryLabelsVerified`, which also records the epoch in
 * `labels_verified_epoch`, and a verified epoch sticks.
 */
export function memoryLabelsVerified(
	userId: string,
	database: Pick<DatabaseInstance, "select"> = db,
): boolean {
	const account = database
		.select({
			epoch: memoryAccounts.epoch,
			unverified: memoryAccounts.labelsUnverifiedEpoch,
		})
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, userId))
		.get();
	return account?.unverified == null || account.unverified !== account.epoch;
}

/** The Memory page an account gets: the subject index once its labels are verified, today's list until then. */
export function memoryPageLayout(userId: string): MemoryPageLayout {
	return memoryLabelsVerified(userId) ? "subjects" : "list";
}

/**
 * The label migration's writer: clears the mark for `epoch` after it has
 * verified that every fact of that epoch's banks is labelled, and records the
 * epoch as verified so that a later in-place upgrade of a config-1 bank does
 * not mark it again (every fact in such a bank predates the upgrade, which the
 * label migration has just labelled). It changes nothing, and returns false,
 * when the account has moved to another epoch or is not marked for this one.
 * Call it inside a fenced write of your own.
 */
export function markMemoryLabelsVerified(
	tx: Tx,
	userId: string,
	epoch: number,
): boolean {
	return (
		tx
			.update(memoryAccounts)
			.set({ labelsUnverifiedEpoch: null, labelsVerifiedEpoch: epoch })
			.where(
				and(
					eq(memoryAccounts.userId, userId),
					eq(memoryAccounts.epoch, epoch),
					eq(memoryAccounts.labelsUnverifiedEpoch, epoch),
				),
			)
			.run().changes > 0
	);
}

/** Why an epoch may hold facts without labels. */
export type LabelsUnverifiedCause =
	/** A config-1 bank was upgraded in place: every fact in it predates the upgrade. */
	| "upgraded"
	/** A bank the previous release created landed as config 1: it may hold facts no verification has seen. */
	| "created_by_previous_release";

/**
 * Marks `epoch` as holding facts from before bank config 2. Only while the
 * account is still at that epoch: a new epoch starts on config 2. An epoch
 * the label migration verified stays verified when a config-1 bank is merely
 * upgraded; a bank the previous release created (a rollback followed by a roll
 * forward) may hold facts the verification never saw, so it marks the epoch
 * again and forgets the verification.
 */
export function markMemoryLabelsUnverified(
	tx: Tx,
	userId: string,
	epoch: number,
	cause: LabelsUnverifiedCause = "upgraded",
): void {
	tx.update(memoryAccounts)
		.set(
			cause === "upgraded"
				? { labelsUnverifiedEpoch: epoch }
				: { labelsUnverifiedEpoch: epoch, labelsVerifiedEpoch: null },
		)
		.where(
			and(
				eq(memoryAccounts.userId, userId),
				eq(memoryAccounts.epoch, epoch),
				cause === "upgraded"
					? or(
							isNull(memoryAccounts.labelsVerifiedEpoch),
							ne(memoryAccounts.labelsVerifiedEpoch, epoch),
						)
					: undefined,
			),
		)
		.run();
}
