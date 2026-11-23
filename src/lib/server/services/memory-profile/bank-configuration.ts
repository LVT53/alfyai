import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { memoryBanks, type memoryDeliveryJobs } from "$lib/server/db/schema";
import type { JobRunContext, Tx } from "../jobs/types";
import {
	CURRENT_NATIVE_BANK_CONFIGS,
	HINDSIGHT_ENGINE_COMMIT,
	KNOWN_NATIVE_BANK_CONFIGS,
	NATIVE_BANK_CONFIG_PENDING,
	NATIVE_BANK_CONFIG_UPGRADE_PENDING,
	NATIVE_BANK_CONFIG_VERSION,
	type NativeBankConfig,
	nativeBankConfigForScopeKey,
	PREVIOUS_NATIVE_BANK_CONFIG,
} from "./contracts";
import {
	type HindsightClient,
	type NativeBinding,
	NativeMemoryError,
} from "./hindsight-client";

/**
 * Settles the one submitted config PATCH by readback. A bank being created
 * (`NATIVE_BANK_CONFIG_PENDING`) did not exist before its PATCH, so any config
 * this app has set proves it landed, the previous release's included; an
 * upgrade (`NATIVE_BANK_CONFIG_UPGRADE_PENDING`) is settled only by config 2.
 */
export async function verifySubmittedBankConfig(
	client: HindsightClient,
	accepted: readonly NativeBankConfig[] = KNOWN_NATIVE_BANK_CONFIGS,
) {
	try {
		await client.verifyConfig(accepted);
	} catch (error) {
		if (
			error instanceof NativeMemoryError &&
			(error.code === "native_not_found" ||
				error.code === "native_config_mismatch")
		)
			throw new NativeMemoryError("native_config_unconfirmed", true);
		throw error;
	}
}

/** The config readback a pending version needs before the bank may be deleted. */
export function submittedConfigsFor(version: string | null) {
	return version === NATIVE_BANK_CONFIG_UPGRADE_PENDING
		? CURRENT_NATIVE_BANK_CONFIGS
		: KNOWN_NATIVE_BANK_CONFIGS;
}

/**
 * Makes the bank hold config 2 before anything is sent to it. A bank on config
 * 2 is verified; a bank the previous release configured (config 1, stored as
 * `HINDSIGHT_ENGINE_COMMIT`) gets one PATCH behind the same fence a new bank
 * gets, so a reset can wait for it; a pending PATCH is settled by readback and
 * never sent again.
 */
export async function ensureConfiguredBank(
	ctx: JobRunContext<typeof memoryDeliveryJobs>,
	client: HindsightClient,
	binding: NativeBinding,
	fence: (tx: Tx) => typeof memoryBanks.$inferSelect,
) {
	let bank = db.transaction(fence);
	const config = nativeBankConfigForScopeKey(bank.scopeKey);
	if (bank.nativeConfigVersion === NATIVE_BANK_CONFIG_VERSION) {
		await client.verifyConfig(CURRENT_NATIVE_BANK_CONFIGS);
		return;
	}
	if (
		bank.nativeConfigVersion === NATIVE_BANK_CONFIG_PENDING ||
		bank.nativeConfigVersion === NATIVE_BANK_CONFIG_UPGRADE_PENDING
	) {
		// There is only one allowed submission. Exact readback can settle
		// that submission without starting another possible writer.
		await verifySubmittedBankConfig(
			client,
			submittedConfigsFor(bank.nativeConfigVersion),
		);
		const previous =
			bank.nativeConfigVersion === NATIVE_BANK_CONFIG_PENDING &&
			(await holdsPreviousConfig(client));
		if (previous) {
			// A creation PATCH the previous release sent landed with config 1:
			// record it as verified config 1, then upgrade it below.
			const recorded = await ctx.write((tx) => {
				fence(tx);
				tx.update(memoryBanks)
					.set({ nativeConfigVersion: HINDSIGHT_ENGINE_COMMIT })
					.where(eq(memoryBanks.id, bank.id))
					.run();
			});
			if (!recorded) throw new NativeMemoryError("memory_cancelled", false);
			bank = db.transaction(fence);
		}
	}
	if (bank.nativeConfigVersion === HINDSIGHT_ENGINE_COMMIT) {
		// Config 1, verified by the previous release. The live config must be
		// one this app set before it is changed.
		await client.verifyConfig();
		await client.configure(config, async () => {
			const recorded = await ctx.write((tx) => {
				const current = fence(tx);
				if (current.nativeConfigVersion !== HINDSIGHT_ENGINE_COMMIT)
					throw new NativeMemoryError("native_config_unconfirmed", true);
				tx.update(memoryBanks)
					.set({ nativeConfigVersion: NATIVE_BANK_CONFIG_UPGRADE_PENDING })
					.where(eq(memoryBanks.id, bank.id))
					.run();
			});
			if (!recorded) throw new NativeMemoryError("memory_cancelled", false);
		});
	} else if (
		bank.nativeConfigVersion !== NATIVE_BANK_CONFIG_PENDING &&
		bank.nativeConfigVersion !== NATIVE_BANK_CONFIG_UPGRADE_PENDING
	) {
		// An older bound-but-unverified row may have issued multiple
		// mutations. Readback cannot prove all of them have finished.
		if (bank.nativeBaseUrl || bank.nativeConfigVersion)
			throw new NativeMemoryError("native_config_unconfirmed", true);
		await client.configure(config, async () => {
			const recorded = await ctx.write((tx) => {
				const current = fence(tx);
				if (current.nativeConfigVersion || current.nativeBaseUrl)
					throw new NativeMemoryError("native_config_unconfirmed", true);
				tx.update(memoryBanks)
					.set({
						nativeBaseUrl: binding.baseUrl,
						nativeCredentialHash: binding.credentialHash,
						nativeConfigVersion: NATIVE_BANK_CONFIG_PENDING,
					})
					.where(eq(memoryBanks.id, bank.id))
					.run();
			});
			if (!recorded) throw new NativeMemoryError("memory_cancelled", false);
		});
	}
	const acknowledged = await ctx.write((tx) => {
		fence(tx);
		tx.update(memoryBanks)
			.set({ nativeConfigVersion: NATIVE_BANK_CONFIG_VERSION })
			.where(eq(memoryBanks.id, bank.id))
			.run();
	});
	if (!acknowledged) throw new NativeMemoryError("memory_cancelled", false);
}

async function holdsPreviousConfig(client: HindsightClient) {
	try {
		await client.verifyConfig([PREVIOUS_NATIVE_BANK_CONFIG]);
		return true;
	} catch (error) {
		if (
			error instanceof NativeMemoryError &&
			error.code === "native_config_mismatch"
		)
			return false;
		throw error;
	}
}
