import { randomUUID } from "node:crypto";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { memoryDirtyLedger } from "$lib/server/db/schema";
import { parseJsonRecord } from "./internal-json";
import {
	assertExpectedMemoryResetGeneration,
	getCurrentMemoryResetGeneration,
} from "./reset-generation";
import { fromScopeColumns, toScopeColumns } from "./scope";
import {
	assertOneOf,
	assertPrivacySafeMetadata,
	type JsonRecord,
	MEMORY_DIRTY_REASONS,
	type MemoryDirtyReason,
	type MemoryProfileScope,
} from "./types";

const DIRTY_METADATA_ARRAY_LIMIT = 12;
const DIRTY_METADATA_RECONCILEABLE_ID_KEYS = [
	"itemId",
	"userMessageId",
	"assistantMessageId",
	"reviewItemId",
	"subjectId",
] as const;
const DIRTY_METADATA_ARRAY_KEYS: Record<
	(typeof DIRTY_METADATA_RECONCILEABLE_ID_KEYS)[number],
	string
> = {
	itemId: "itemIds",
	userMessageId: "userMessageIds",
	assistantMessageId: "assistantMessageIds",
	reviewItemId: "reviewItemIds",
	subjectId: "subjectIds",
};

function appendBoundedUniqueStrings(
	values: unknown[],
	next: unknown,
): string[] {
	const strings = values
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.trim())
		.filter(Boolean);
	if (typeof next === "string" && next.trim()) {
		strings.push(next.trim());
	}
	return Array.from(new Set(strings)).slice(-DIRTY_METADATA_ARRAY_LIMIT);
}

function coalesceDirtyLedgerMetadata(
	current: JsonRecord,
	next: JsonRecord,
): JsonRecord {
	const merged: JsonRecord = { ...current, ...next };
	for (const key of DIRTY_METADATA_RECONCILEABLE_ID_KEYS) {
		const currentValue = current[key];
		const nextValue = next[key];
		const arrayKey = DIRTY_METADATA_ARRAY_KEYS[key];
		const existingArray = Array.isArray(current[arrayKey])
			? current[arrayKey]
			: [];
		const values = appendBoundedUniqueStrings(existingArray, currentValue);
		const coalesced = appendBoundedUniqueStrings(values, nextValue);
		if (
			coalesced.length > 1 ||
			(Array.isArray(current[arrayKey]) && coalesced.length > 0)
		) {
			merged[arrayKey] = coalesced;
		}
	}
	return merged;
}

export async function markMemoryDirty(params: {
	userId: string;
	reason: MemoryDirtyReason;
	scope?: MemoryProfileScope;
	metadata?: JsonRecord;
	expectedResetGeneration?: number;
}): Promise<{ id: string; reason: MemoryDirtyReason; count: number }> {
	assertOneOf(params.reason, MEMORY_DIRTY_REASONS, "memory dirty reason");
	assertPrivacySafeMetadata(params.metadata);
	const resetGeneration = await assertExpectedMemoryResetGeneration({
		userId: params.userId,
		expectedResetGeneration: params.expectedResetGeneration,
	});
	const scope = toScopeColumns(params.scope ?? { type: "global" });
	const now = new Date();
	const updateExistingPending = async (): Promise<{
		id: string;
		reason: MemoryDirtyReason;
		count: number;
	} | null> => {
		const [existing] = await db
			.select()
			.from(memoryDirtyLedger)
			.where(
				and(
					eq(memoryDirtyLedger.userId, params.userId),
					eq(memoryDirtyLedger.resetGeneration, resetGeneration),
					eq(memoryDirtyLedger.scopeType, scope.scopeType),
					eq(memoryDirtyLedger.scopeId, scope.scopeId),
					eq(memoryDirtyLedger.reason, params.reason),
					eq(memoryDirtyLedger.status, "pending"),
				),
			)
			.limit(1);

		if (!existing) return null;
		const metadata = coalesceDirtyLedgerMetadata(
			parseJsonRecord(existing.reasonMetadataJson),
			params.metadata ?? {},
		);
		await db
			.update(memoryDirtyLedger)
			.set({
				count: sql`${memoryDirtyLedger.count} + 1`,
				reasonMetadataJson: JSON.stringify(metadata),
				lastMarkedAt: now,
			})
			.where(eq(memoryDirtyLedger.id, existing.id))
			.run();
		return {
			id: existing.id,
			reason: params.reason,
			count: existing.count + 1,
		};
	};

	const existingResult = await updateExistingPending();
	if (existingResult) return existingResult;

	const id = randomUUID();
	try {
		await db
			.insert(memoryDirtyLedger)
			.values({
				id,
				userId: params.userId,
				resetGeneration,
				scopeType: scope.scopeType,
				scopeId: scope.scopeId,
				reason: params.reason,
				reasonMetadataJson: JSON.stringify(params.metadata ?? {}),
				firstMarkedAt: now,
				lastMarkedAt: now,
			})
			.run();
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			typeof error.code === "string" &&
			error.code.startsWith("SQLITE_CONSTRAINT")
		) {
			const retried = await updateExistingPending();
			if (retried) return retried;
		}
		throw error;
	}
	return { id, reason: params.reason, count: 1 };
}

export async function listPendingMemoryDirtyEntries(params: {
	userId: string;
}): Promise<
	Array<{
		id: string;
		reason: MemoryDirtyReason;
		count: number;
		scope: MemoryProfileScope;
		metadata: JsonRecord;
	}>
> {
	const resetGeneration = await getCurrentMemoryResetGeneration(params.userId);
	const rows = await db
		.select()
		.from(memoryDirtyLedger)
		.where(
			and(
				eq(memoryDirtyLedger.userId, params.userId),
				eq(memoryDirtyLedger.resetGeneration, resetGeneration),
				eq(memoryDirtyLedger.status, "pending"),
			),
		)
		.orderBy(asc(memoryDirtyLedger.lastMarkedAt));

	return rows.map((row) => {
		assertOneOf(row.reason, MEMORY_DIRTY_REASONS, "memory dirty reason");
		return {
			id: row.id,
			reason: row.reason,
			count: row.count,
			scope: fromScopeColumns(row.scopeType, row.scopeId),
			metadata: parseJsonRecord(row.reasonMetadataJson),
		};
	});
}

export type ClaimedDirtyLedgerRow = typeof memoryDirtyLedger.$inferSelect;

function mergeDirtyLedgerMetadata(
	current: string | null,
	next: string | null,
): string {
	return JSON.stringify(
		coalesceDirtyLedgerMetadata(
			parseJsonRecord(current),
			parseJsonRecord(next),
		),
	);
}

export function reclaimStaleClaimedMemoryDirtyLedgerRows(params: {
	userId: string;
	resetGeneration: number;
	staleBefore: Date;
	limit: number;
}): number {
	if (params.limit <= 0) return 0;

	return db.transaction((tx) => {
		const staleRows = tx
			.select()
			.from(memoryDirtyLedger)
			.where(
				and(
					eq(memoryDirtyLedger.userId, params.userId),
					eq(memoryDirtyLedger.resetGeneration, params.resetGeneration),
					eq(memoryDirtyLedger.status, "claimed"),
					lt(memoryDirtyLedger.claimedAt, params.staleBefore),
				),
			)
			.orderBy(asc(memoryDirtyLedger.claimedAt))
			.limit(params.limit)
			.all();
		const now = new Date();
		let reclaimed = 0;

		for (const row of staleRows) {
			const [pending] = tx
				.select()
				.from(memoryDirtyLedger)
				.where(
					and(
						eq(memoryDirtyLedger.userId, params.userId),
						eq(memoryDirtyLedger.resetGeneration, params.resetGeneration),
						eq(memoryDirtyLedger.scopeType, row.scopeType),
						eq(memoryDirtyLedger.scopeId, row.scopeId),
						eq(memoryDirtyLedger.reason, row.reason),
						eq(memoryDirtyLedger.status, "pending"),
					),
				)
				.limit(1)
				.all();

			if (pending) {
				tx.update(memoryDirtyLedger)
					.set({
						count: sql`${memoryDirtyLedger.count} + ${row.count}`,
						reasonMetadataJson: mergeDirtyLedgerMetadata(
							pending.reasonMetadataJson,
							row.reasonMetadataJson,
						),
						lastMarkedAt: now,
					})
					.where(eq(memoryDirtyLedger.id, pending.id))
					.run();
				tx.update(memoryDirtyLedger)
					.set({
						status: "completed",
						completedAt: now,
					})
					.where(eq(memoryDirtyLedger.id, row.id))
					.run();
			} else {
				tx.update(memoryDirtyLedger)
					.set({
						status: "pending",
						claimedAt: null,
					})
					.where(eq(memoryDirtyLedger.id, row.id))
					.run();
			}
			reclaimed += 1;
		}

		return reclaimed;
	});
}

export function claimNextMemoryDirtyLedgerRow(params: {
	userId: string;
	resetGeneration: number;
	attemptedIds: Set<string>;
}): ClaimedDirtyLedgerRow | null {
	const now = new Date();
	return db.transaction((tx) => {
		const rows = tx
			.select()
			.from(memoryDirtyLedger)
			.where(
				and(
					eq(memoryDirtyLedger.userId, params.userId),
					eq(memoryDirtyLedger.resetGeneration, params.resetGeneration),
					eq(memoryDirtyLedger.status, "pending"),
				),
			)
			.orderBy(asc(memoryDirtyLedger.lastMarkedAt))
			.limit(Math.max(1, params.attemptedIds.size + 1))
			.all();
		const row = rows.find(
			(candidate) => !params.attemptedIds.has(candidate.id),
		);
		if (!row) return null;

		const claim = tx
			.update(memoryDirtyLedger)
			.set({
				status: "claimed",
				claimedAt: now,
			})
			.where(
				and(
					eq(memoryDirtyLedger.id, row.id),
					eq(memoryDirtyLedger.userId, params.userId),
					eq(memoryDirtyLedger.resetGeneration, params.resetGeneration),
					eq(memoryDirtyLedger.status, "pending"),
				),
			)
			.run() as { changes?: number };

		return (claim.changes ?? 0) === 1
			? {
					...row,
					status: "claimed",
					claimedAt: now,
				}
			: null;
	});
}

export async function completeClaimedMemoryDirtyLedgerRow(params: {
	userId: string;
	resetGeneration: number;
	id: string;
}): Promise<boolean> {
	const result = (await db
		.update(memoryDirtyLedger)
		.set({
			status: "completed",
			completedAt: new Date(),
		})
		.where(
			and(
				eq(memoryDirtyLedger.id, params.id),
				eq(memoryDirtyLedger.userId, params.userId),
				eq(memoryDirtyLedger.resetGeneration, params.resetGeneration),
				eq(memoryDirtyLedger.status, "claimed"),
			),
		)
		.run()) as { changes?: number };

	return (result.changes ?? 0) === 1;
}

export async function requeueClaimedMemoryDirtyLedgerRow(params: {
	userId: string;
	resetGeneration: number;
	id: string;
}): Promise<void> {
	await db
		.update(memoryDirtyLedger)
		.set({
			status: "pending",
			claimedAt: null,
		})
		.where(
			and(
				eq(memoryDirtyLedger.id, params.id),
				eq(memoryDirtyLedger.userId, params.userId),
				eq(memoryDirtyLedger.resetGeneration, params.resetGeneration),
				eq(memoryDirtyLedger.status, "claimed"),
			),
		)
		.run();
}
