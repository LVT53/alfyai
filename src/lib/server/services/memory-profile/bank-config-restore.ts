import { and, eq, ne } from "drizzle-orm";
import { db } from "$lib/server/db";
import { memoryAccounts, memoryBanks } from "$lib/server/db/schema";
import {
	liveConfigVersion,
	restoreNativeBankConfig2,
	restorePreviousNativeBankConfig,
} from "./bank-configuration";
import {
	HINDSIGHT_ENGINE_COMMIT,
	NATIVE_BANK_CONFIG_2_VERSION,
	NATIVE_BANK_CONFIG_PENDING,
	NATIVE_BANK_CONFIG_VERSION,
	NativeMemoryError,
} from "./contracts";
import { type HindsightClient, nativeMemoryClient } from "./hindsight-client";
import { revokeMemoryLabelsVerified } from "./labels-verified";
import { memoryMigrationGuard } from "./migration-guard";

/**
 * The rollback of the bank config (operator step, run with the app's Memory
 * workers stopped, from this release's code, before an earlier release serves
 * Memory again). Each earlier release compares its own config's keys one by
 * one and fails a bank on a later config, so the banks go back first:
 *
 * - `to: 2`, for a rollback to the config 2 release: every bank this release
 *   moved to config 3 goes back to its own kind's config 2, verified by
 *   readback, and its stored version back to `NATIVE_BANK_CONFIG_2_VERSION`.
 *   Config 2 labels every new fact, so nothing else changes: the labels and
 *   every account's label verification stay.
 * - `to: 1` (the default), for a rollback to the first release: every bank on
 *   config 3 or config 2 goes back to config 1 with its labels cleared, and
 *   its stored version back to `HINDSIGHT_ENGINE_COMMIT`. It also takes back
 *   every account's label verification (`revokeMemoryLabelsVerified`): the
 *   first release writes facts without labels into any account's banks, and
 *   may create config-1 banks, so each account it will serve gets today's
 *   Memory page until the label migration, run again after the roll forward,
 *   verifies it again. An account goes back as soon as one of its banks is
 *   restored, and every account goes back once a run leaves no bank on
 *   config 2 or 3. The permanent tester rule's account is left as it is
 *   (migration 143 never marked it).
 *
 * Inspects by default; counts only, no ids and no content. Removes nothing:
 * label rows stay in `memory_fact_labels` (and the relabel's record in
 * `memory_label_relabels`) for a roll forward.
 */
export interface BankConfigRestoreReport {
	mode: "inspect" | "execute";
	/** Non-retired banks of native accounts, by stored config version. */
	versions: {
		config3: number;
		config2: number;
		config1: number;
		pending: number;
		other: number;
	};
	restored: number;
	/**
	 * Accounts returned to today's Memory page (inspect: that a clean run to
	 * config 1 would return; a run to config 2 returns none).
	 */
	unverified: number;
	failed: Record<string, number>;
}

export async function restoreBankConfigs(input: {
	execute: boolean;
	/** The release to go back to: 1 (the first release, the default) or 2. */
	to?: 1 | 2;
	clientFor?: (bankId: string, tenantId: string) => HindsightClient;
}): Promise<BankConfigRestoreReport> {
	const to = input.to ?? 1;
	const clientFor =
		input.clientFor ??
		((bankId: string, tenantId: string) =>
			nativeMemoryClient(bankId, tenantId));
	const banks = db
		.select({ bank: memoryBanks, tenantId: memoryAccounts.tenantId })
		.from(memoryBanks)
		.innerJoin(memoryAccounts, eq(memoryAccounts.userId, memoryBanks.userId))
		.where(
			and(
				ne(memoryBanks.status, "retired"),
				eq(memoryAccounts.authority, "hindsight"),
				eq(memoryBanks.epoch, memoryAccounts.epoch),
			),
		)
		.all();
	// Every native account the first release will serve, the tester's left out.
	const accounts = db
		.select({ userId: memoryAccounts.userId, epoch: memoryAccounts.epoch })
		.from(memoryAccounts)
		.where(eq(memoryAccounts.authority, "hindsight"))
		.all()
		.filter(({ userId }) => memoryMigrationGuard(userId).allowed);
	const report: BankConfigRestoreReport = {
		mode: input.execute ? "execute" : "inspect",
		versions: { config3: 0, config2: 0, config1: 0, pending: 0, other: 0 },
		restored: 0,
		unverified: input.execute ? 0 : accounts.length,
		failed: {},
	};
	const revoked = new Set<string>();
	const revoke = (userId: string, epoch: number) => {
		if (revoked.has(userId)) return;
		if (!accounts.some((account) => account.userId === userId)) return;
		if (db.transaction((tx) => revokeMemoryLabelsVerified(tx, userId, epoch)))
			revoked.add(userId);
	};
	for (const { bank } of banks) {
		const version = bank.nativeConfigVersion;
		if (version === NATIVE_BANK_CONFIG_VERSION) report.versions.config3++;
		else if (version === NATIVE_BANK_CONFIG_2_VERSION)
			report.versions.config2++;
		else if (version === HINDSIGHT_ENGINE_COMMIT) report.versions.config1++;
		else if (version === NATIVE_BANK_CONFIG_PENDING) report.versions.pending++;
		else report.versions.other++;
	}
	if (!input.execute) return report;
	// A creation still pending may have landed as config 3, or may yet land: this
	// release settles it at its own next delivery (it reads the live config
	// back), and a restore that PATCHed it would be a second mutation of a bank
	// whose first may still be in flight. Settle it first, then restore.
	if (report.versions.pending) {
		report.failed.memory_restore_pending_banks = report.versions.pending;
		return report;
	}
	const target =
		to === 2 ? NATIVE_BANK_CONFIG_2_VERSION : HINDSIGHT_ENGINE_COMMIT;
	for (const { bank, tenantId } of banks) {
		const stored = bank.nativeConfigVersion;
		if (
			stored !== NATIVE_BANK_CONFIG_VERSION &&
			stored !== NATIVE_BANK_CONFIG_2_VERSION &&
			stored !== HINDSIGHT_ENGINE_COMMIT
		)
			continue;
		try {
			const client = clientFor(bank.id, tenantId);
			// The live config decides, not the stored version: an upgrade whose PATCH
			// landed but whose version write was lost leaves a bank ahead of its
			// version, which the older release cannot serve either.
			const live = await liveConfigVersion(client, bank.scopeKey);
			if (!live) throw new NativeMemoryError("native_config_mismatch", false);
			// What the older release serves: for config 2 a bank on config 2 or 1,
			// for config 1 a bank on config 1 only.
			const patch =
				to === 2
					? live === NATIVE_BANK_CONFIG_VERSION
					: live !== HINDSIGHT_ENGINE_COMMIT;
			if (patch) {
				if (to === 2) await restoreNativeBankConfig2(client, bank.scopeKey);
				else await restorePreviousNativeBankConfig(client);
			}
			const now = patch ? target : live;
			if (now !== stored)
				db.update(memoryBanks)
					.set({ nativeConfigVersion: now })
					.where(
						and(
							eq(memoryBanks.id, bank.id),
							eq(memoryBanks.nativeConfigVersion, stored),
						),
					)
					.run();
			if (patch || now !== stored) {
				// The first release writes facts without labels into this bank.
				if (to === 1) revoke(bank.userId, bank.epoch);
				report.restored++;
			}
		} catch (error) {
			const code =
				error instanceof NativeMemoryError
					? error.code
					: "memory_restore_failed";
			report.failed[code] = (report.failed[code] ?? 0) + 1;
		}
	}
	// A clean run to config 1: the first release may now serve every account, so
	// each goes back to today's page (a run with a failure is run again first).
	if (to === 1 && !Object.keys(report.failed).length)
		for (const { userId, epoch } of accounts) revoke(userId, epoch);
	report.unverified = revoked.size;
	return report;
}
