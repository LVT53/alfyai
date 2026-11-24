import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { memoryBanks, type memoryDeliveryJobs } from "$lib/server/db/schema";
import type { JobRunContext, Tx } from "../jobs/types";
import {
	HINDSIGHT_ENGINE_COMMIT,
	KNOWN_NATIVE_BANK_CONFIGS,
	NATIVE_BANK_CONFIG_2_VERSION,
	NATIVE_BANK_CONFIG_PENDING,
	NATIVE_BANK_CONFIG_VERSION,
	type NativeBankConfig,
	nativeBankConfig2ForScopeKey,
	nativeBankConfigForScopeKey,
	PREVIOUS_NATIVE_BANK_CONFIG,
} from "./contracts";
import {
	type HindsightClient,
	type NativeBinding,
	NativeMemoryError,
} from "./hindsight-client";
import { markMemoryLabelsUnverified } from "./labels-verified";

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
 * Makes the bank hold config 3 before anything is sent to it. A new bank is
 * created behind the single-submission fence (`NATIVE_BANK_CONFIG_PENDING`),
 * because a reset must not delete it while its creating PATCH may still land.
 * A bank an earlier release configured (config 1, stored as
 * `HINDSIGHT_ENGINE_COMMIT`, or config 2, stored as
 * `NATIVE_BANK_CONFIG_2_VERSION`) already holds the person's data, so it is
 * upgraded with a plain PATCH that may be sent again: config 3 is the same
 * whoever sends it, and the bank keeps its version until a readback proves
 * config 3, so a lost PATCH never holds its deliveries, edits, Clear Memory
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
			const current = fence(tx);
			if (current.nativeConfigVersion !== from)
				throw new NativeMemoryError("native_config_unconfirmed", true);
			tx.update(memoryBanks)
				.set({ nativeConfigVersion: to })
				.where(eq(memoryBanks.id, bank.id))
				.run();
			// A bank on config 1 may hold facts without labels: its epoch keeps
			// today's Memory page until the label migration verifies it. An epoch
			// that migration already verified stays verified when a bank is only
			// upgraded; a bank the first release created may hold facts it never
			// saw, so it marks the epoch again. A bank on config 2 or 3 labels
			// every new fact, so moving between them marks nothing.
			if (to === HINDSIGHT_ENGINE_COMMIT)
				markMemoryLabelsUnverified(
					tx,
					current.userId,
					current.epoch,
					"created_by_previous_release",
				);
			else if (from === HINDSIGHT_ENGINE_COMMIT)
				markMemoryLabelsUnverified(
					tx,
					current.userId,
					current.epoch,
					"upgraded",
				);
		});
		if (!recorded) throw new NativeMemoryError("memory_cancelled", false);
	};
	if (bank.nativeConfigVersion === NATIVE_BANK_CONFIG_PENDING) {
		// There is only one allowed submission. Exact readback can settle
		// that submission without starting another possible writer.
		await verifySubmittedBankConfig(client);
		const landed = await landedConfigVersion(client, bank.scopeKey);
		if (landed === NATIVE_BANK_CONFIG_VERSION) {
			await moveVersion(NATIVE_BANK_CONFIG_PENDING, NATIVE_BANK_CONFIG_VERSION);
			return;
		}
		// A creation an earlier release sent landed with its config: record it
		// as that verified config, then upgrade it below.
		await moveVersion(NATIVE_BANK_CONFIG_PENDING, landed);
		bank = db.transaction(fence);
	}
	const earlier = bank.nativeConfigVersion;
	if (
		earlier === HINDSIGHT_ENGINE_COMMIT ||
		earlier === NATIVE_BANK_CONFIG_2_VERSION
	) {
		// The live config must be one this app set before it is changed.
		await client.verifyConfig();
		await client.configure(config, async () => {
			const current = await ctx.write((tx) => {
				if (fence(tx).nativeConfigVersion !== earlier)
					throw new NativeMemoryError("native_config_unconfirmed", true);
			});
			if (!current) throw new NativeMemoryError("memory_cancelled", false);
		});
		await moveVersion(earlier, NATIVE_BANK_CONFIG_VERSION);
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

/**
 * For a rollback one release (operator step,
 * `scripts/memory-bank-config-restore.ts restore-bank-config-2`): puts a bank
 * of this kind back on config 2, verified by readback. The config 2 release
 * compares config 2's keys one by one and fails a bank on config 3, so every
 * bank this release upgraded needs this before that release serves Memory
 * again; its stored version then goes back to `NATIVE_BANK_CONFIG_2_VERSION`.
 * Config 2 labels every new fact, so its labels and the accounts' label
 * verification stay as they are.
 */
export async function restoreNativeBankConfig2(
	client: HindsightClient,
	scopeKey: string,
) {
	await client.configure(
		nativeBankConfig2ForScopeKey(scopeKey),
		async () => {},
	);
}

/**
 * For a rollback to the first release (operator step,
 * `scripts/memory-bank-config-restore.ts restore-bank-config-1`): puts a bank
 * back on config 1 and clears its labels, verified by readback. The first
 * release compares config 1's keys one by one and fails a bank on config 2 or
 * 3, so every bank this release or the one before it upgraded needs this
 * before the old code serves Memory again; its stored version then goes back
 * to `HINDSIGHT_ENGINE_COMMIT`.
 */
export async function restorePreviousNativeBankConfig(client: HindsightClient) {
	await client.configure(
		{ ...PREVIOUS_NATIVE_BANK_CONFIG, entity_labels: null },
		async () => {},
	);
}

/**
 * The stored version of the config the bank holds now, by readback: config 3,
 * config 2 or config 1, each of the bank's own kind. A live config none of
 * them describes is another kind's, or none this app set, and settles nothing.
 */
async function landedConfigVersion(client: HindsightClient, scopeKey: string) {
	const candidates: Array<[string, NativeBankConfig]> = [
		[NATIVE_BANK_CONFIG_VERSION, nativeBankConfigForScopeKey(scopeKey)],
		[NATIVE_BANK_CONFIG_2_VERSION, nativeBankConfig2ForScopeKey(scopeKey)],
		[HINDSIGHT_ENGINE_COMMIT, PREVIOUS_NATIVE_BANK_CONFIG],
	];
	for (const [version, config] of candidates)
		if (await holdsConfig(client, config)) return version;
	throw new NativeMemoryError("native_config_mismatch", false);
}

async function holdsConfig(client: HindsightClient, config: NativeBankConfig) {
	try {
		await client.verifyConfig([config]);
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
