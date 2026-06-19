import { and, asc, desc, eq } from "drizzle-orm";
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
	type MemoryProfileItemDetail,
	type MemoryProfileReadModel,
} from "./types";

function toCardItem(
	row: typeof memoryProfileItems.$inferSelect,
	sanitizer: MemoryProfileTextSanitizer,
): MemoryProfileCardItem {
	assertMemoryProfileCategory(row.category);
	return {
		id: row.id,
		itemKey: row.itemKey,
		category: row.category,
		statement: sanitizePublicMemoryText(row.statement, sanitizer),
		scope: fromScopeColumns(row.scopeType, row.scopeId),
		status: "active",
		revision: row.revision,
		updatedAt: row.updatedAt,
		canEdit: true,
		canDelete: true,
		canSuppress: true,
	};
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
	const visibleReviews = dedupedReviewRows
		.slice(0, 3)
		.map((row) => toPublicReviewItem(row, sanitizer));
	const allReviews = dedupedReviewRows.map((row) =>
		toPublicReviewItem(row, sanitizer),
	);

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
