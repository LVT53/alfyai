import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { memoryBanks, type memoryDeliveryJobs } from "$lib/server/db/schema";
import type { JobRunContext, Tx } from "../jobs/types";
import {
	HINDSIGHT_ENGINE_COMMIT,
	NATIVE_BANK_CONFIG_PENDING,
} from "./contracts";
import {
	type HindsightClient,
	type NativeBinding,
	NativeMemoryError,
} from "./hindsight-client";

export async function verifySubmittedBankConfig(client: HindsightClient) {
	try {
		await client.verifyConfig();
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

export async function ensureConfiguredBank(
	ctx: JobRunContext<typeof memoryDeliveryJobs>,
	client: HindsightClient,
	binding: NativeBinding,
	fence: (tx: Tx) => typeof memoryBanks.$inferSelect,
) {
	const bank = db.transaction(fence);
	if (bank.nativeConfigVersion === HINDSIGHT_ENGINE_COMMIT) {
		await client.verifyConfig();
		return;
	}
	if (bank.nativeConfigVersion === NATIVE_BANK_CONFIG_PENDING) {
		// There is only one allowed submission. Exact readback can settle
		// that submission without starting another possible writer.
		await verifySubmittedBankConfig(client);
	} else {
		// An older bound-but-unverified row may have issued multiple
		// mutations. Readback cannot prove all of them have finished.
		if (bank.nativeBaseUrl || bank.nativeConfigVersion)
			throw new NativeMemoryError("native_config_unconfirmed", true);
		await client.configure(async () => {
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
			.set({ nativeConfigVersion: HINDSIGHT_ENGINE_COMMIT })
			.where(eq(memoryBanks.id, bank.id))
			.run();
	});
	if (!acknowledged) throw new NativeMemoryError("memory_cancelled", false);
}
