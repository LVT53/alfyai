import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { db } from "$lib/server/db";
import {
	memoryReviewItems,
	memoryReviewResolutions,
} from "$lib/server/db/schema";
import type { MemoryReviewResolutionType } from "./types";

/**
 * The single, shared primitive for closing an open review row: record its
 * resolution (idempotently — one resolution per review item) and flip the row to
 * "resolved". This lives in a low module that imports neither `review.ts` nor
 * `projection-store.ts` so BOTH can compose it inside their own transactions
 * without a circular import. Before this module existed, `projection-store`'s
 * `expireOverdueReviewMemoryProfileItems` hand-copied `review.ts`'s resolution
 * dance to dodge the cycle; now there is one implementation.
 */
export type ReviewRowResolution = {
	reviewItemId: string;
	resolutionType: MemoryReviewResolutionType;
	editedStatement?: string;
	metadata?: Record<string, unknown>;
};

type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function resolveReviewRowsTx(
	tx: TransactionClient,
	params: {
		userId: string;
		resetGeneration: number;
		now: Date;
		rows: ReviewRowResolution[];
	},
): void {
	for (const row of params.rows) {
		tx.insert(memoryReviewResolutions)
			.values({
				id: randomUUID(),
				reviewItemId: row.reviewItemId,
				userId: params.userId,
				resetGeneration: params.resetGeneration,
				resolutionType: row.resolutionType,
				editedStatement: row.editedStatement,
				metadataJson: JSON.stringify(row.metadata ?? {}),
				createdAt: params.now,
			})
			.onConflictDoNothing({
				target: memoryReviewResolutions.reviewItemId,
			})
			.run();
		tx.update(memoryReviewItems)
			.set({
				status: "resolved",
				resolvedAt: params.now,
				updatedAt: params.now,
			})
			.where(eq(memoryReviewItems.id, row.reviewItemId))
			.run();
	}
}
