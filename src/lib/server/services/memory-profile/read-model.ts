import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	memoryProfileItemProvenance,
	memoryProfileItems,
	memoryReviewItems,
} from "$lib/server/db/schema";
import {
	createIdentityTextSanitizer,
	getMemoryProfileIdentity,
	type MemoryProfileTextSanitizer,
	sanitizePublicMemoryText,
} from "./identity-sanitizer";
import {
	parseJsonArray,
	parseJsonRecord,
	readSafeStringArray,
} from "./internal-json";
import {
	ensureProjectionState,
	expireOverdueActiveMemoryProfileItems,
} from "./projection-store";
import { getCurrentMemoryResetGeneration } from "./reset-generation";
import { dedupeReviewRows, toPublicReviewItem } from "./review";
import { fromScopeColumns } from "./scope";
import {
	assertMemoryProfileCategory,
	MEMORY_PROFILE_CATEGORIES,
	type MemoryProfileCardItem,
	type MemoryProfileItemConfidence,
	type MemoryProfileItemDetail,
	type MemoryProfileItemExpiryClass,
	type MemoryProfileReadModel,
} from "./types";

function readConfidence(value: unknown): MemoryProfileItemConfidence | null {
	return value === "stated" || value === "inferred" ? value : null;
}

function readExpiryClass(value: unknown): MemoryProfileItemExpiryClass | null {
	return value === "durable" || value === "time_bound" ? value : null;
}

function toCardItem(
	row: typeof memoryProfileItems.$inferSelect,
	sanitizer: MemoryProfileTextSanitizer,
): MemoryProfileCardItem {
	assertMemoryProfileCategory(row.category);
	const metadata = parseJsonRecord(row.metadataJson);
	return {
		id: row.id,
		itemKey: row.itemKey,
		category: row.category,
		statement: sanitizePublicMemoryText(row.statement, sanitizer),
		scope: fromScopeColumns(row.scopeType, row.scopeId),
		status: "active",
		revision: row.revision,
		updatedAt: row.updatedAt,
		confidence: readConfidence(metadata.confidence),
		expiryClass: readExpiryClass(metadata.expiryClass),
		expiresAt: row.expiresAt ?? null,
		canEdit: true,
		canDelete: true,
		canSuppress: true,
	};
}

/**
 * Maps each open review row to the earliest auto-expiry of the
 * review_needed profile items it refers to, so the UI can show an
 * "auto-expires in {n} days" countdown for the review queue.
 */
async function getReviewExpiryByRowId(params: {
	userId: string;
	resetGeneration: number;
	reviewRows: Array<typeof memoryReviewItems.$inferSelect>;
}): Promise<Map<string, string | null>> {
	const affectedIdsByRow = new Map<string, string[]>();
	const allAffectedIds = new Set<string>();
	for (const row of params.reviewRows) {
		const ids = readSafeStringArray(parseJsonArray(row.affectedItemIdsJson));
		affectedIdsByRow.set(row.id, ids);
		for (const id of ids) allAffectedIds.add(id);
	}

	const expiryById = new Map<string, Date>();
	if (allAffectedIds.size > 0) {
		const rows = await db
			.select({
				id: memoryProfileItems.id,
				expiresAt: memoryProfileItems.expiresAt,
			})
			.from(memoryProfileItems)
			.where(
				and(
					eq(memoryProfileItems.userId, params.userId),
					eq(memoryProfileItems.resetGeneration, params.resetGeneration),
					eq(memoryProfileItems.status, "review_needed"),
					inArray(memoryProfileItems.id, [...allAffectedIds]),
				),
			);
		for (const row of rows) {
			if (row.expiresAt) expiryById.set(row.id, row.expiresAt);
		}
	}

	const result = new Map<string, string | null>();
	for (const row of params.reviewRows) {
		const expiries = (affectedIdsByRow.get(row.id) ?? [])
			.map((id) => expiryById.get(id))
			.filter((value): value is Date => Boolean(value));
		result.set(
			row.id,
			expiries.length > 0
				? new Date(Math.min(...expiries.map((d) => d.getTime()))).toISOString()
				: null,
		);
	}
	return result;
}

export async function getMemoryProfileReadModel(params: {
	userId: string;
}): Promise<MemoryProfileReadModel> {
	const resetGeneration = await getCurrentMemoryResetGeneration(params.userId);
	const identity = await getMemoryProfileIdentity(params.userId);
	const sanitizer = createIdentityTextSanitizer({
		userId: params.userId,
		displayName: identity.displayName,
		honchoPeerVersion: identity.honchoPeerVersion,
	});
	const projection = await ensureProjectionState({
		userId: params.userId,
		resetGeneration,
	});
	const expiredCount = await expireOverdueActiveMemoryProfileItems({
		userId: params.userId,
		resetGeneration,
		projectionStateId: projection.id,
	});
	const rows = await db
		.select()
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, resetGeneration),
				eq(memoryProfileItems.status, "active"),
			),
		)
		.orderBy(desc(memoryProfileItems.updatedAt));
	const cards = rows.map((row) => toCardItem(row, sanitizer));
	const reviewRows = await db
		.select()
		.from(memoryReviewItems)
		.where(
			and(
				eq(memoryReviewItems.userId, params.userId),
				eq(memoryReviewItems.resetGeneration, resetGeneration),
				eq(memoryReviewItems.status, "open"),
			),
		)
		.orderBy(asc(memoryReviewItems.updatedAt));
	const dedupedReviewRows = dedupeReviewRows(reviewRows);
	const reviewExpiryByRowId = await getReviewExpiryByRowId({
		userId: params.userId,
		resetGeneration,
		reviewRows: dedupedReviewRows,
	});
	const toReviewItemWithExpiry = (row: (typeof dedupedReviewRows)[number]) => ({
		...toPublicReviewItem(row, sanitizer),
		expiresAt: reviewExpiryByRowId.get(row.id) ?? null,
	});
	const visibleReviews = dedupedReviewRows
		.slice(0, 3)
		.map(toReviewItemWithExpiry);
	const allReviews = dedupedReviewRows.map(toReviewItemWithExpiry);

	return {
		resetGeneration,
		projectionRevision: projection.revision + expiredCount,
		categories: MEMORY_PROFILE_CATEGORIES.map((category) => ({
			category,
			items: cards.filter((item) => item.category === category),
		})),
		review: {
			items: allReviews,
			visibleItems: visibleReviews,
			openCount: dedupedReviewRows.length,
			overflowCount: Math.max(
				0,
				dedupedReviewRows.length - visibleReviews.length,
			),
		},
	};
}

export async function getMemoryProfileItemDetail(params: {
	userId: string;
	itemId: string;
}): Promise<MemoryProfileItemDetail | null> {
	const resetGeneration = await getCurrentMemoryResetGeneration(params.userId);
	const projection = await ensureProjectionState({
		userId: params.userId,
		resetGeneration,
	});
	await expireOverdueActiveMemoryProfileItems({
		userId: params.userId,
		resetGeneration,
		projectionStateId: projection.id,
	});
	const [item] = await db
		.select()
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.id, params.itemId),
				eq(memoryProfileItems.resetGeneration, resetGeneration),
				eq(memoryProfileItems.status, "active"),
			),
		)
		.limit(1);
	if (!item) return null;
	const identity = await getMemoryProfileIdentity(params.userId);
	const sanitizer = createIdentityTextSanitizer({
		userId: params.userId,
		displayName: identity.displayName,
		honchoPeerVersion: identity.honchoPeerVersion,
	});

	const provenance = await db
		.select()
		.from(memoryProfileItemProvenance)
		.where(
			and(
				eq(memoryProfileItemProvenance.userId, params.userId),
				eq(memoryProfileItemProvenance.itemId, params.itemId),
				eq(memoryProfileItemProvenance.resetGeneration, resetGeneration),
			),
		)
		.orderBy(asc(memoryProfileItemProvenance.createdAt))
		.limit(3);

	return {
		...toCardItem(item, sanitizer),
		sourceChips: provenance.map((row) => ({
			id: row.id,
			sourceType: row.sourceType,
			label: sanitizePublicMemoryText(row.label, sanitizer),
			summary: row.summary
				? sanitizePublicMemoryText(row.summary, sanitizer)
				: null,
		})),
		whyRemembered: provenance[0]?.summary
			? sanitizePublicMemoryText(provenance[0].summary, sanitizer)
			: null,
	};
}
