import { and, eq, ne } from "drizzle-orm";
import { db } from "$lib/server/db";
import { memoryAccounts, memoryBanks } from "$lib/server/db/schema";
import { restorePreviousNativeBankConfig } from "./bank-configuration";
import {
	HINDSIGHT_ENGINE_COMMIT,
	NATIVE_BANK_CONFIG_PENDING,
	NATIVE_BANK_CONFIG_VERSION,
	NativeMemoryError,
} from "./contracts";
import { type HindsightClient, nativeMemoryClient } from "./hindsight-client";
import { revokeMemoryLabelsVerified } from "./labels-verified";
import { memoryMigrationGuard } from "./migration-guard";

/**
 * The rollback of Memory part 2's bank config (operator step, run with the
 * app's Memory workers stopped, from this release's code, before the
 * previous release serves Memory again): every bank this release moved to
 * config 2 goes back to config 1, labels cleared, and its stored version back
 * to `HINDSIGHT_ENGINE_COMMIT`. Inspects by default; counts only, no ids and
 * no content. Removes nothing: label rows stay in `memory_fact_labels` for a
 * roll forward. It does take back every account's label verification
 * (`revokeMemoryLabelsVerified`): the previous release writes facts without
 * labels into any account's banks, and may create config-1 banks, so each
 * account it will serve gets today's Memory page until the label migration,
 * run again after the roll forward, verifies it again. An account goes back
 * as soon as one of its banks is restored, and every account goes back once a
 * run leaves no bank on config 2. The permanent tester rule's account is left
 * as it is (migration 143 never marked it).
 */
export interface BankConfigRestoreReport {
	mode: "inspect" | "execute";
	/** Non-retired banks of native accounts, by stored config version. */
	versions: {
		config2: number;
		config1: number;
		pending: number;
		other: number;
	};
	restored: number;
	/** Accounts returned to today's Memory page (inspect: that a clean run would return). */
	unverified: number;
	failed: Record<string, number>;
}

export async function restoreBankConfigs(input: {
	execute: boolean;
	clientFor?: (bankId: string, tenantId: string) => HindsightClient;
}): Promise<BankConfigRestoreReport> {
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
	// Every native account the previous release will serve, the tester's left out.
	const accounts = db
		.select({ userId: memoryAccounts.userId, epoch: memoryAccounts.epoch })
		.from(memoryAccounts)
		.where(eq(memoryAccounts.authority, "hindsight"))
		.all()
		.filter(({ userId }) => memoryMigrationGuard(userId).allowed);
	const report: BankConfigRestoreReport = {
		mode: input.execute ? "execute" : "inspect",
		versions: { config2: 0, config1: 0, pending: 0, other: 0 },
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
		if (version === NATIVE_BANK_CONFIG_VERSION) report.versions.config2++;
		else if (version === HINDSIGHT_ENGINE_COMMIT) report.versions.config1++;
		else if (version === NATIVE_BANK_CONFIG_PENDING) report.versions.pending++;
		else report.versions.other++;
	}
	if (!input.execute) return report;
	for (const { bank, tenantId } of banks) {
		if (bank.nativeConfigVersion !== NATIVE_BANK_CONFIG_VERSION) continue;
		try {
			await restorePreviousNativeBankConfig(clientFor(bank.id, tenantId));
			db.update(memoryBanks)
				.set({ nativeConfigVersion: HINDSIGHT_ENGINE_COMMIT })
				.where(
					and(
						eq(memoryBanks.id, bank.id),
						eq(memoryBanks.nativeConfigVersion, NATIVE_BANK_CONFIG_VERSION),
					),
				)
				.run();
			// The previous release writes facts without labels into this bank.
			revoke(bank.userId, bank.epoch);
			report.restored++;
		} catch (error) {
			const code =
				error instanceof NativeMemoryError
					? error.code
					: "memory_restore_failed";
			report.failed[code] = (report.failed[code] ?? 0) + 1;
		}
	}
	// A clean run: the previous release may now serve every account, so each
	// goes back to today's page (a run with a failure is run again first).
	if (!Object.keys(report.failed).length)
		for (const { userId, epoch } of accounts) revoke(userId, epoch);
	report.unverified = revoked.size;
	return report;
}
