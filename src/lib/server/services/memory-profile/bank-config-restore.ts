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

/**
 * The rollback of Memory part 2's bank config (operator step, run with the
 * app's Memory workers stopped, from this release's code, before the
 * previous release serves Memory again): every bank this release moved to
 * config 2 goes back to config 1, labels cleared, and its stored version back
 * to `HINDSIGHT_ENGINE_COMMIT`. Inspects by default; counts only, no ids and
 * no content. Removes nothing: label rows stay in `memory_fact_labels` for a
 * roll forward. It does forget that the account's labels were verified, so a
 * roll forward marks them for the label migration again (`labels-verified.ts`).
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
	const report: BankConfigRestoreReport = {
		mode: input.execute ? "execute" : "inspect",
		versions: { config2: 0, config1: 0, pending: 0, other: 0 },
		restored: 0,
		failed: {},
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
			// The previous release writes facts without labels, so after a roll
			// forward the account's labels are verified again.
			db.update(memoryAccounts)
				.set({ labelsVerifiedEpoch: null })
				.where(eq(memoryAccounts.userId, bank.userId))
				.run();
			report.restored++;
		} catch (error) {
			const code =
				error instanceof NativeMemoryError
					? error.code
					: "memory_restore_failed";
			report.failed[code] = (report.failed[code] ?? 0) + 1;
		}
	}
	return report;
}
