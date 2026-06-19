import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	memoryProfileItemProvenance,
	memoryProfileItems,
	memoryProjectionState,
} from "$lib/server/db/schema";
import {
	assertExpectedMemoryResetGeneration,
	getCurrentMemoryResetGeneration,
} from "./reset-generation";
import {
	deriveMemoryProfileItemKey,
	fromScopeColumns,
	ITEM_KEY_VERSION,
	resolveMemoryProfileItemKey,
	toScopeColumns,
} from "./scope";
import type {
	MemoryProfileCategory,
	MemoryProfileItemStatus,
	MemoryProfilePolicyBlockedStatement,
	MemoryProfileScope,
	MemoryProfileSourceChip,
} from "./types";
import { assertMemoryProfileCategory } from "./types";

export async function ensureProjectionState(params: {
	userId: string;
	resetGeneration: number;
	scope?: MemoryProfileScope;
}): Promise<typeof memoryProjectionState.$inferSelect> {
	const scope = toScopeColumns(params.scope ?? { type: "global" });
	await db
		.insert(memoryProjectionState)
		.values({
			id: randomUUID(),
			userId: params.userId,
			resetGeneration: params.resetGeneration,
			scopeType: scope.scopeType,
			scopeId: scope.scopeId,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.onConflictDoNothing({
			target: [
				memoryProjectionState.userId,
				memoryProjectionState.resetGeneration,
				memoryProjectionState.scopeType,
				memoryProjectionState.scopeId,
			],
		})
		.run();

	const [row] = await db
		.select()
		.from(memoryProjectionState)
		.where(
			and(
				eq(memoryProjectionState.userId, params.userId),
				eq(memoryProjectionState.resetGeneration, params.resetGeneration),
				eq(memoryProjectionState.scopeType, scope.scopeType),
				eq(memoryProjectionState.scopeId, scope.scopeId),
			),
		)
		.limit(1);
	if (!row) {
		throw new Error("Memory projection state could not be initialized.");
	}
	return row;
}

export async function expireOverdueActiveMemoryProfileItems(params: {
	userId: string;
	resetGeneration: number;
	projectionStateId: string;
	now?: Date;
}): Promise<number> {
	const now = params.now ?? new Date();
	const result = (await db
		.update(memoryProfileItems)
		.set({
			status: "expired",
			updatedAt: now,
		})
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
				eq(memoryProfileItems.status, "active"),
				lt(memoryProfileItems.expiresAt, now),
			),
		)
		.run()) as { changes?: number };
	const expiredCount = result.changes ?? 0;
	if (expiredCount > 0) {
		await db
			.update(memoryProjectionState)
			.set({
				revision: sql`${memoryProjectionState.revision} + ${expiredCount}`,
				updatedAt: now,
			})
			.where(eq(memoryProjectionState.id, params.projectionStateId))
			.run();
	}
	return expiredCount;
}

export async function createMemoryProfileItem(params: {
	userId: string;
	category: MemoryProfileCategory;
	scope: MemoryProfileScope;
	statement: string;
	itemKey?: string;
	slotKey?: string;
	status?: MemoryProfileItemStatus;
	expectedResetGeneration?: number;
}): Promise<{
	id: string;
	itemKey: string;
	status: MemoryProfileItemStatus;
	revision: number;
	resetGeneration: number;
	projectionRevision: number;
}> {
	const resetGeneration = await assertExpectedMemoryResetGeneration({
		userId: params.userId,
		expectedResetGeneration: params.expectedResetGeneration,
	});
	const projection = await ensureProjectionState({
		userId: params.userId,
		resetGeneration,
	});
	const scope = toScopeColumns(params.scope);
	const itemKey = resolveMemoryProfileItemKey(params);
	const now = new Date();
	const item = {
		id: randomUUID(),
		userId: params.userId,
		projectionStateId: projection.id,
		resetGeneration,
		itemKey,
		category: params.category,
		scopeType: scope.scopeType,
		scopeId: scope.scopeId,
		statement: params.statement,
		status: params.status ?? "active",
		revision: 0,
		createdAt: now,
		updatedAt: now,
	};

	const result = db.transaction((tx) => {
		const insertResult = tx
			.insert(memoryProfileItems)
			.values(item)
			.onConflictDoNothing({
				target: [
					memoryProfileItems.userId,
					memoryProfileItems.resetGeneration,
					memoryProfileItems.itemKey,
				],
			})
			.run() as { changes?: number };

		if ((insertResult.changes ?? 0) === 1) {
			tx.update(memoryProjectionState)
				.set({
					revision: sql`${memoryProjectionState.revision} + 1`,
					updatedAt: now,
				})
				.where(eq(memoryProjectionState.id, projection.id))
				.run();

			return {
				row: item,
				projectionRevision: projection.revision + 1,
			};
		}

		const [existing] = tx
			.select()
			.from(memoryProfileItems)
			.where(
				and(
					eq(memoryProfileItems.userId, params.userId),
					eq(memoryProfileItems.resetGeneration, resetGeneration),
					eq(memoryProfileItems.itemKey, itemKey),
				),
			)
			.limit(1)
			.all();

		if (!existing) {
			throw new Error("Memory profile item could not be initialized.");
		}

		return {
			row: existing,
			projectionRevision: projection.revision,
		};
	});

	return {
		id: result.row.id,
		itemKey: result.row.itemKey,
		status: result.row.status as MemoryProfileItemStatus,
		revision: result.row.revision,
		resetGeneration,
		projectionRevision: result.projectionRevision,
	};
}

export async function addMemoryProfileItemProvenance(params: {
	userId: string;
	itemId: string;
	sourceType: string;
	sourceId?: string;
	label: string;
	summary?: string;
	expectedResetGeneration?: number;
}): Promise<MemoryProfileSourceChip> {
	const resetGeneration = await assertExpectedMemoryResetGeneration({
		userId: params.userId,
		expectedResetGeneration: params.expectedResetGeneration,
	});
	const [item] = await db
		.select({
			id: memoryProfileItems.id,
			resetGeneration: memoryProfileItems.resetGeneration,
		})
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.id, params.itemId),
				eq(memoryProfileItems.resetGeneration, resetGeneration),
			),
		)
		.limit(1);
	if (!item) {
		throw new Error("Memory profile item not found.");
	}

	const id = randomUUID();
	await db
		.insert(memoryProfileItemProvenance)
		.values({
			id,
			itemId: item.id,
			userId: params.userId,
			resetGeneration: item.resetGeneration,
			sourceType: params.sourceType,
			sourceId: params.sourceId,
			label: params.label,
			summary: params.summary,
			createdAt: new Date(),
		})
		.run();

	return {
		id,
		sourceType: params.sourceType,
		label: params.label,
		summary: params.summary ?? null,
	};
}

export async function listProjectionPolicyBlockedStatements(params: {
	userId: string;
}): Promise<MemoryProfilePolicyBlockedStatement[]> {
	const resetGeneration = await getCurrentMemoryResetGeneration(params.userId);
	const rows = await db
		.select({
			id: memoryProfileItems.id,
			status: memoryProfileItems.status,
			statement: memoryProfileItems.statement,
		})
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, resetGeneration),
				inArray(memoryProfileItems.status, [
					"deleted",
					"suppressed",
					"expired",
					"blocked",
					"review_needed",
					"preserved_legacy",
				]),
			),
		);

	return rows
		.filter(
			(row): row is MemoryProfilePolicyBlockedStatement =>
				row.status === "deleted" ||
				row.status === "suppressed" ||
				row.status === "expired" ||
				row.status === "blocked" ||
				row.status === "review_needed" ||
				row.status === "preserved_legacy",
		)
		.map((row) => ({
			id: row.id,
			status: row.status,
			statement: row.statement,
		}));
}

export async function updateMemoryProfileItemWithRevision(params: {
	userId: string;
	itemId: string;
	expectedProjectionRevision: number;
	patch: {
		statement?: string;
		status?: MemoryProfileItemStatus;
	};
}): Promise<
	| { status: "updated"; projectionRevision: number }
	| { status: "stale_projection" }
	| { status: "not_found" }
> {
	const resetGeneration = await getCurrentMemoryResetGeneration(params.userId);
	const projection = await ensureProjectionState({
		userId: params.userId,
		resetGeneration,
	});
	const now = new Date();
	const itemRows = await db
		.select()
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.id, params.itemId),
				eq(memoryProfileItems.resetGeneration, resetGeneration),
			),
		)
		.limit(1);
	const item = itemRows[0];
	if (!item) return { status: "not_found" };
	assertMemoryProfileCategory(item.category);
	const nextStatement = params.patch.statement ?? item.statement;
	const nextItemKey =
		params.patch.statement !== undefined &&
		item.itemKey.startsWith(`${ITEM_KEY_VERSION}:`)
			? deriveMemoryProfileItemKey({
					category: item.category,
					scope: fromScopeColumns(item.scopeType, item.scopeId),
					statement: nextStatement,
				})
			: item.itemKey;
	if (nextItemKey !== item.itemKey) {
		const [collidingItem] = await db
			.select({ id: memoryProfileItems.id })
			.from(memoryProfileItems)
			.where(
				and(
					eq(memoryProfileItems.userId, params.userId),
					eq(memoryProfileItems.resetGeneration, resetGeneration),
					eq(memoryProfileItems.itemKey, nextItemKey),
				),
			)
			.limit(1);
		if (collidingItem && collidingItem.id !== item.id) {
			return { status: "not_found" };
		}
	}

	const nextRevision = params.expectedProjectionRevision + 1;
	const result = db.transaction((tx) => {
		const projectionClaim = tx
			.update(memoryProjectionState)
			.set({
				revision: sql`${memoryProjectionState.revision} + 1`,
				updatedAt: now,
			})
			.where(
				and(
					eq(memoryProjectionState.id, projection.id),
					eq(memoryProjectionState.revision, params.expectedProjectionRevision),
				),
			)
			.run() as { changes?: number };

		if ((projectionClaim.changes ?? 0) !== 1) {
			return { status: "stale_projection" as const };
		}

		tx.update(memoryProfileItems)
			.set({
				...(params.patch.statement !== undefined
					? { statement: params.patch.statement }
					: {}),
				...(nextItemKey !== item.itemKey ? { itemKey: nextItemKey } : {}),
				...(params.patch.status !== undefined
					? {
							status: params.patch.status,
							deletedAt: params.patch.status === "deleted" ? now : undefined,
							suppressedAt:
								params.patch.status === "suppressed" ? now : undefined,
						}
					: {}),
				revision: sql`${memoryProfileItems.revision} + 1`,
				updatedAt: now,
			})
			.where(
				and(
					eq(memoryProfileItems.userId, params.userId),
					eq(memoryProfileItems.id, params.itemId),
					eq(memoryProfileItems.resetGeneration, resetGeneration),
				),
			)
			.run();

		return {
			status: "updated" as const,
			projectionRevision: nextRevision,
		};
	});

	return result;
}

export function bumpProjectionRevision(params: {
	projectionStateId: string;
	amount: number;
	now: Date;
}): void {
	if (params.amount <= 0) return;
	db.update(memoryProjectionState)
		.set({
			revision: sql`${memoryProjectionState.revision} + ${params.amount}`,
			updatedAt: params.now,
		})
		.where(eq(memoryProjectionState.id, params.projectionStateId))
		.run();
}
