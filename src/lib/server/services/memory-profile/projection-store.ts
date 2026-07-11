import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	memoryProfileItemProvenance,
	memoryProfileItems,
	memoryProjectionState,
	memoryReviewItems,
} from "$lib/server/db/schema";
import {
	assertExpectedMemoryResetGeneration,
	getCurrentMemoryResetGeneration,
} from "./reset-generation";
import {
	type ReviewRowResolution,
	resolveReviewRowsTx,
} from "./review-resolution";
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

type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The optimistic-concurrency claim at the heart of the mutation door: advance
 * the projection revision by one IFF it still equals the revision the caller
 * read. A mismatch means another writer moved first — the caller's write must be
 * abandoned (stale_projection). Every door that mutates items composes this so
 * the invariant can never be skipped or hand-rolled divergently.
 */
function claimProjectionRevisionTx(
	tx: TransactionClient,
	params: { projectionStateId: string; expectedRevision: number; now: Date },
): boolean {
	const claim = tx
		.update(memoryProjectionState)
		.set({
			revision: sql`${memoryProjectionState.revision} + 1`,
			updatedAt: params.now,
		})
		.where(
			and(
				eq(memoryProjectionState.id, params.projectionStateId),
				eq(memoryProjectionState.revision, params.expectedRevision),
			),
		)
		.run() as { changes?: number };
	return (claim.changes ?? 0) === 1;
}

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

export async function expireOverdueReviewMemoryProfileItems(params: {
	userId: string;
	resetGeneration: number;
	projectionStateId: string;
	now?: Date;
}): Promise<number> {
	const now = params.now ?? new Date();
	const overdueItems = await db
		.select({ id: memoryProfileItems.id })
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
				eq(memoryProfileItems.status, "review_needed"),
				lt(memoryProfileItems.expiresAt, now),
			),
		);
	if (overdueItems.length === 0) return 0;
	const overdueItemIds = new Set(overdueItems.map((row) => row.id));

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
				eq(memoryProfileItems.status, "review_needed"),
				lt(memoryProfileItems.expiresAt, now),
			),
		)
		.run()) as { changes?: number };
	const expiredCount = result.changes ?? 0;
	if (expiredCount === 0) return 0;

	// Close any open review rows that reference an item we just expired, using
	// the SAME "resolved" transition as a dismissal — via the shared
	// resolveReviewRowsTx primitive (see review-resolution.ts). This used to be a
	// hand-copy of review.ts's dance to dodge the import cycle; the primitive now
	// lives in a low module both sides import, so there is one implementation.
	const openReviewRows = await db
		.select()
		.from(memoryReviewItems)
		.where(
			and(
				eq(memoryReviewItems.userId, params.userId),
				eq(memoryReviewItems.resetGeneration, params.resetGeneration),
				eq(memoryReviewItems.status, "open"),
			),
		);
	const reviewRowsToClose = openReviewRows.filter((row) => {
		let affectedItemIds: unknown;
		try {
			affectedItemIds = JSON.parse(row.affectedItemIdsJson ?? "[]");
		} catch {
			return false;
		}
		return (
			Array.isArray(affectedItemIds) &&
			affectedItemIds.some(
				(id) => typeof id === "string" && overdueItemIds.has(id),
			)
		);
	});

	if (reviewRowsToClose.length > 0) {
		db.transaction((tx) => {
			resolveReviewRowsTx(tx, {
				userId: params.userId,
				resetGeneration: params.resetGeneration,
				now,
				rows: reviewRowsToClose.map((row) => ({
					reviewItemId: row.id,
					resolutionType: "do_not_remember",
					metadata: { reason: "review_item_expired" },
				})),
			});
		});
	}

	await db
		.update(memoryProjectionState)
		.set({
			revision: sql`${memoryProjectionState.revision} + ${expiredCount}`,
			updatedAt: now,
		})
		.where(eq(memoryProjectionState.id, params.projectionStateId))
		.run();

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
		/** Optional expiry override. `null` clears the item's expiry. */
		expiresAt?: Date | null;
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
		if (
			!claimProjectionRevisionTx(tx, {
				projectionStateId: projection.id,
				expectedRevision: params.expectedProjectionRevision,
				now,
			})
		) {
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
				...(params.patch.expiresAt !== undefined
					? { expiresAt: params.patch.expiresAt }
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

function parseMemoryProfileItemMetadata(
	metadataJson: string | null,
): Record<string, unknown> {
	try {
		const parsed = JSON.parse(metadataJson ?? "{}");
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/**
 * Merge a metadata patch into an item's existing metadataJson so callers never
 * clobber fields (confidence/expiryClass/origin/...) written by other writers
 * (intake, the judge, consolidation). Shared by consolidation steps and the
 * user-facing correct/summary-edit actions.
 */
export async function mergeMemoryProfileItemMetadata(params: {
	userId: string;
	itemId: string;
	patch: Record<string, unknown>;
}): Promise<void> {
	const [row] = await db
		.select({ metadataJson: memoryProfileItems.metadataJson })
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.id, params.itemId),
			),
		)
		.limit(1);
	const next = {
		...parseMemoryProfileItemMetadata(row?.metadataJson ?? "{}"),
		...params.patch,
	};
	await db
		.update(memoryProfileItems)
		.set({ metadataJson: JSON.stringify(next) })
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.id, params.itemId),
			),
		)
		.run();
}

/**
 * Overwrite an item's metadata (and, optionally, its expiry) as a side write
 * that does NOT touch the projection revision. Used by intake right after
 * `createMemoryProfileItem` (which already claimed the revision for the create):
 * the metadata/expiry are properties of the just-created row, not an independent
 * projection change, so re-bumping would double-count. Keeping this in the store
 * means the judge never issues a raw `db.update(memoryProfileItems)` of its own.
 */
export async function setMemoryProfileItemMetadataAndExpiry(params: {
	userId: string;
	itemId: string;
	metadataJson: string;
	expiresAt?: Date;
}): Promise<void> {
	await db
		.update(memoryProfileItems)
		.set({
			metadataJson: params.metadataJson,
			...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
		})
		.where(
			and(
				eq(memoryProfileItems.id, params.itemId),
				eq(memoryProfileItems.userId, params.userId),
			),
		)
		.run();
}

/**
 * Extend one item's expiry (consolidation's RENEW pass) and account for it with
 * a single projection-revision step, atomically. Renewals do not bump the item's
 * own revision (they are not a semantic edit of the fact), matching the prior
 * behavior where the renew pass hand-bumped the projection counter by the number
 * of renewals via the now-removed naked-revision-bump escape hatch.
 */
export async function renewMemoryProfileItemExpiry(params: {
	userId: string;
	itemId: string;
	projectionStateId: string;
	expiresAt: Date;
	now: Date;
}): Promise<void> {
	db.transaction((tx) => {
		tx.update(memoryProfileItems)
			.set({ expiresAt: params.expiresAt, updatedAt: params.now })
			.where(
				and(
					eq(memoryProfileItems.userId, params.userId),
					eq(memoryProfileItems.id, params.itemId),
				),
			)
			.run();
		tx.update(memoryProjectionState)
			.set({
				revision: sql`${memoryProjectionState.revision} + 1`,
				updatedAt: params.now,
			})
			.where(eq(memoryProjectionState.id, params.projectionStateId))
			.run();
	});
}

/**
 * Store a freshly generated persona summary on the projection-state row and
 * account for it with a single projection-revision step. The night shift's
 * summary step used to issue this update (and its `revision + 1` bump) inline,
 * outside the mutation door; routing it here keeps the projection revision the
 * sole business of this store. The write is not item-shaped, so it stays a plain
 * update — the door is here for authority, not for the optimistic-concurrency
 * claim (a summary regeneration is unconditional, exactly as before).
 */
export async function storePersonaSummaryProjection(params: {
	projectionStateId: string;
	personaSummaryText: string;
	personaSummaryLinksJson: string;
	now: Date;
}): Promise<void> {
	await db
		.update(memoryProjectionState)
		.set({
			personaSummaryText: params.personaSummaryText,
			personaSummaryLinksJson: params.personaSummaryLinksJson,
			personaSummaryUpdatedAt: params.now,
			revision: sql`${memoryProjectionState.revision} + 1`,
			updatedAt: params.now,
		})
		.where(eq(memoryProjectionState.id, params.projectionStateId))
		.run();
}

/**
 * Copy every provenance row from one item onto another, preserving the original
 * source identity (type/id/label/summary/metadata/timestamp) and reset
 * generation. Consolidation's merge uses this to carry each member's provenance
 * onto the merged item without re-implementing the provenance insert itself.
 */
export async function copyMemoryProfileItemProvenance(params: {
	userId: string;
	fromItemId: string;
	toItemId: string;
}): Promise<void> {
	const provRows = await db
		.select()
		.from(memoryProfileItemProvenance)
		.where(eq(memoryProfileItemProvenance.itemId, params.fromItemId));
	for (const prov of provRows) {
		await db
			.insert(memoryProfileItemProvenance)
			.values({
				id: randomUUID(),
				itemId: params.toItemId,
				userId: params.userId,
				resetGeneration: prov.resetGeneration,
				sourceType: prov.sourceType,
				sourceId: prov.sourceId,
				label: prov.label,
				summary: prov.summary,
				metadataJson: prov.metadataJson,
				createdAt: prov.createdAt,
			})
			.run();
	}
}

/**
 * Flip the affected ACTIVE items to `review_needed` in the SAME transaction that
 * writes/updates the review row (supplied as `mutateReviewItem`), bumping the
 * projection revision by the number of items actually moved. Moved verbatim out
 * of review.ts so the item-status write + revision bump live behind the door;
 * review.ts now supplies only the review-row mutation.
 */
export async function markActiveMemoryProfileItemsForReview(params: {
	userId: string;
	resetGeneration: number;
	affectedItemIds: string[];
	now: Date;
	mutateReviewItem: (tx: TransactionClient) => void;
}): Promise<void> {
	const affectedItemIds = Array.from(new Set(params.affectedItemIds));
	const projection =
		affectedItemIds.length > 0
			? await ensureProjectionState({
					userId: params.userId,
					resetGeneration: params.resetGeneration,
				})
			: null;

	db.transaction((tx) => {
		params.mutateReviewItem(tx);
		if (affectedItemIds.length === 0 || !projection) return;

		const result = tx
			.update(memoryProfileItems)
			.set({
				status: "review_needed",
				revision: sql`${memoryProfileItems.revision} + 1`,
				updatedAt: params.now,
			})
			.where(
				and(
					eq(memoryProfileItems.userId, params.userId),
					eq(memoryProfileItems.resetGeneration, params.resetGeneration),
					eq(memoryProfileItems.status, "active"),
					inArray(memoryProfileItems.id, affectedItemIds),
				),
			)
			.run() as { changes?: number };
		const changedCount = result.changes ?? 0;
		if (changedCount === 0) return;

		tx.update(memoryProjectionState)
			.set({
				revision: sql`${memoryProjectionState.revision} + ${changedCount}`,
				updatedAt: params.now,
			})
			.where(eq(memoryProjectionState.id, projection.id))
			.run();
	});
}

/**
 * The projection-side of resolving a memory review (accept / edit / dismiss),
 * run as ONE optimistic-concurrency transaction. The caller (review.ts) does the
 * review-specific reasoning — category inference, statement selection, expiry
 * recompute, duplicate-row discovery — and hands the door a plain decision:
 *   - `upsert`: create-or-reactivate the accepted/edited item (null on dismiss)
 *   - `suppressItemIds`: active items to suppress (dismiss only)
 *   - `resolveRows`: the review rows to close, via the shared resolution primitive
 * All item writes, the revision claim, and the review-row resolution happen here
 * so review.ts issues no raw `db.insert/update(memoryProfileItems)` of its own.
 */
export async function applyReviewItemProjectionMutation(params: {
	userId: string;
	resetGeneration: number;
	projectionStateId: string;
	expectedProjectionRevision: number;
	upsert: null | {
		itemKey: string;
		category: MemoryProfileCategory;
		scope: MemoryProfileScope;
		statement: string;
		/** `undefined` leaves expiry untouched on reactivation; `null` clears it. */
		acceptExpiresAt: Date | null | undefined;
	};
	suppressItemIds: string[];
	resolveRows: ReviewRowResolution[];
	now: Date;
}): Promise<
	| { status: "updated"; projectionRevision: number; itemId: string | null }
	| { status: "stale_projection" }
> {
	const nextProjectionRevision = params.expectedProjectionRevision + 1;
	return db.transaction((tx) => {
		if (
			!claimProjectionRevisionTx(tx, {
				projectionStateId: params.projectionStateId,
				expectedRevision: params.expectedProjectionRevision,
				now: params.now,
			})
		) {
			return { status: "stale_projection" as const };
		}

		let itemId: string | null = null;
		if (params.upsert) {
			const { itemKey, category, scope, statement, acceptExpiresAt } =
				params.upsert;
			const scopeColumns = toScopeColumns(scope);
			const [existing] = tx
				.select()
				.from(memoryProfileItems)
				.where(
					and(
						eq(memoryProfileItems.userId, params.userId),
						eq(memoryProfileItems.resetGeneration, params.resetGeneration),
						eq(memoryProfileItems.itemKey, itemKey),
					),
				)
				.limit(1)
				.all();

			if (existing) {
				itemId = existing.id;
				if (
					existing.status !== "active" ||
					existing.statement !== statement ||
					acceptExpiresAt !== undefined
				) {
					tx.update(memoryProfileItems)
						.set({
							statement,
							status: "active",
							deletedAt: null,
							suppressedAt: null,
							...(acceptExpiresAt !== undefined
								? { expiresAt: acceptExpiresAt }
								: {}),
							revision: sql`${memoryProfileItems.revision} + 1`,
							updatedAt: params.now,
						})
						.where(eq(memoryProfileItems.id, existing.id))
						.run();
				}
			} else {
				itemId = randomUUID();
				tx.insert(memoryProfileItems)
					.values({
						id: itemId,
						userId: params.userId,
						projectionStateId: params.projectionStateId,
						resetGeneration: params.resetGeneration,
						itemKey,
						category,
						scopeType: scopeColumns.scopeType,
						scopeId: scopeColumns.scopeId,
						statement,
						status: "active",
						expiresAt: acceptExpiresAt ?? undefined,
						revision: 0,
						createdAt: params.now,
						updatedAt: params.now,
					})
					.run();
			}
		}

		if (params.suppressItemIds.length > 0) {
			tx.update(memoryProfileItems)
				.set({
					status: "suppressed",
					suppressedAt: params.now,
					revision: sql`${memoryProfileItems.revision} + 1`,
					updatedAt: params.now,
				})
				.where(
					and(
						eq(memoryProfileItems.userId, params.userId),
						eq(memoryProfileItems.resetGeneration, params.resetGeneration),
						eq(memoryProfileItems.status, "active"),
						inArray(memoryProfileItems.id, params.suppressItemIds),
					),
				)
				.run();
		}

		resolveReviewRowsTx(tx, {
			userId: params.userId,
			resetGeneration: params.resetGeneration,
			now: params.now,
			rows: params.resolveRows,
		});

		return {
			status: "updated" as const,
			projectionRevision: nextProjectionRevision,
			itemId,
		};
	});
}
