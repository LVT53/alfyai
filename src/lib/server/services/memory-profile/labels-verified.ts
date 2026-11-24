import { and, eq } from "drizzle-orm";
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
 * epoch again whenever a config-1 bank is upgraded in place. The label
 * migration clears the mark through `markMemoryLabelsVerified`.
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
 * verified that every fact of that epoch's banks is labelled. It changes
 * nothing, and returns false, when the account has moved to another epoch or
 * is not marked for this one. Call it inside a fenced write of your own.
 */
export function markMemoryLabelsVerified(
	tx: Tx,
	userId: string,
	epoch: number,
): boolean {
	return (
		tx
			.update(memoryAccounts)
			.set({ labelsUnverifiedEpoch: null })
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

/**
 * Marks `epoch` as holding facts from before bank config 2 (a config-1 bank
 * upgraded in place). Only while the account is still at that epoch: a new
 * epoch starts on config 2.
 */
export function markMemoryLabelsUnverified(
	tx: Tx,
	userId: string,
	epoch: number,
): void {
	tx.update(memoryAccounts)
		.set({ labelsUnverifiedEpoch: epoch })
		.where(
			and(eq(memoryAccounts.userId, userId), eq(memoryAccounts.epoch, epoch)),
		)
		.run();
}
