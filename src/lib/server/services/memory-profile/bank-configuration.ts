import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { memoryBanks, type memoryDeliveryJobs } from "$lib/server/db/schema";
import type { JobRunContext, Tx } from "../jobs/types";
import {
	HINDSIGHT_ENGINE_COMMIT,
	KNOWN_NATIVE_BANK_CONFIGS,
	NATIVE_BANK_CONFIG_PENDING,
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
 * Settles the one PATCH that created a bank (`NATIVE_BANK_CONFIG_PENDING`) by
 * readback. The bank did not exist before it, so any config this app has set
 * proves it landed, the previous release's included.
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

/**
 * Makes the bank hold config 2 before anything is sent to it. A new bank is
 * created behind the single-submission fence (`NATIVE_BANK_CONFIG_PENDING`),
 * because a reset must not delete it while its creating PATCH may still land.
 * A bank the previous release configured (config 1, stored as
 * `HINDSIGHT_ENGINE_COMMIT`) already holds the person's data, so it is
 * upgraded with a plain PATCH that may be sent again: config 2 is the same
 * whoever sends it, and the bank keeps its version until a readback proves
 * config 2, so a lost PATCH never holds its deliveries, edits, Clear Memory
 * or erasure. Every version write is a compare-and-set on the version read.
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
		await client.verifyConfig([config]);
		return;
	}
	const moveVersion = async (from: string | null, to: string) => {
		const recorded = await ctx.write((tx) => {
			if (fence(tx).nativeConfigVersion !== from)
				throw new NativeMemoryError("native_config_unconfirmed", true);
			tx.update(memoryBanks)
				.set({ nativeConfigVersion: to })
				.where(eq(memoryBanks.id, bank.id))
				.run();
		});
		if (!recorded) throw new NativeMemoryError("memory_cancelled", false);
	};
	if (bank.nativeConfigVersion === NATIVE_BANK_CONFIG_PENDING) {
		// There is only one allowed submission. Exact readback can settle
		// that submission without starting another possible writer.
		await verifySubmittedBankConfig(client);
		if (!(await holdsPreviousConfig(client))) {
			await moveVersion(NATIVE_BANK_CONFIG_PENDING, NATIVE_BANK_CONFIG_VERSION);
			return;
		}
		// A creation the previous release sent landed with config 1: record it
		// as verified config 1, then upgrade it below.
		await moveVersion(NATIVE_BANK_CONFIG_PENDING, HINDSIGHT_ENGINE_COMMIT);
		bank = db.transaction(fence);
	}
	if (bank.nativeConfigVersion === HINDSIGHT_ENGINE_COMMIT) {
		// The live config must be one this app set before it is changed.
		await client.verifyConfig();
		await client.configure(config, async () => {
			const current = await ctx.write((tx) => {
				if (fence(tx).nativeConfigVersion !== HINDSIGHT_ENGINE_COMMIT)
					throw new NativeMemoryError("native_config_unconfirmed", true);
			});
			if (!current) throw new NativeMemoryError("memory_cancelled", false);
		});
		await moveVersion(HINDSIGHT_ENGINE_COMMIT, NATIVE_BANK_CONFIG_VERSION);
		return;
	}
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
	await moveVersion(NATIVE_BANK_CONFIG_PENDING, NATIVE_BANK_CONFIG_VERSION);
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
