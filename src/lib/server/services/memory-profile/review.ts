import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	memoryProfileItems,
	memoryProjectionState,
	memoryReviewItems,
	memoryReviewResolutions,
} from "$lib/server/db/schema";
import {
	type MemoryProfileTextSanitizer,
	sanitizePublicMemoryText,
} from "./identity-sanitizer";
import { parseJsonArray, parseJsonRecord } from "./internal-json";
import { ensureProjectionState } from "./projection-store";
import {
	assertExpectedMemoryResetGeneration,
	getCurrentMemoryResetGeneration,
} from "./reset-generation";
import {
	resolveMemoryProfileItemKey,
	stableMemoryMaintenanceDigest,
	toScopeColumns,
} from "./scope";
import {
	assertOneOf,
	assertPrivacySafeMetadata,
	type JsonRecord,
	MEMORY_REVIEW_RESOLUTION_TYPES,
	type MemoryProfileCategory,
	type MemoryProfileScope,
	type MemoryReviewResolutionType,
	readMemoryProfileCategory,
} from "./types";

function inferReviewCategory(params: {
	subject: string;
	question: string;
	reason: string;
	metadata: JsonRecord;
}): MemoryProfileCategory {
	const explicitCategory = readMemoryProfileCategory(params.metadata.category);
	if (explicitCategory) return explicitCategory;

	const text =
		`${params.subject} ${params.question} ${params.reason}`.toLowerCase();
	if (
		/\b(avoid|never|must|constraint|boundary|do not|don't|dont|privacy|sensitive)\b/.test(
			text,
		)
	) {
		return "constraints_boundaries";
	}
	if (/\b(goal|ongoing|working on|project|roadmap|todo)\b/.test(text)) {
		return "goals_ongoing_work";
	}
	if (
		/\b(prefer|prefers|preference|likes|style|language|ui|labels)\b/.test(text)
	) {
		return "preferences";
	}
	return "about_you";
}

function readReviewProposedStatement(metadata: JsonRecord): string | null {
	const proposedStatement = metadata.proposedStatement;
	if (typeof proposedStatement !== "string") return null;
	const trimmed = proposedStatement.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeReviewDeduplicationText(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function legacyReviewSubjectKey(params: {
	category: MemoryProfileCategory;
	statement: string;
}): string {
	return `legacy-memory-curation:${stableMemoryMaintenanceDigest(
		`${params.category}\u001f${normalizeReviewDeduplicationText(params.statement)}`,
	)}`;
}

export function toPublicReviewItem(
	row: typeof memoryReviewItems.$inferSelect,
	sanitizer: MemoryProfileTextSanitizer,
) {
	const metadata = parseJsonRecord(row.metadataJson);
	const proposedStatement = readReviewProposedStatement(metadata);
	return {
		id: row.id,
		subject: sanitizePublicMemoryText(
			proposedStatement ?? row.subjectLabel,
			sanitizer,
		),
		question: sanitizePublicMemoryText(row.question, sanitizer),
		reason: sanitizePublicMemoryText(row.reason, sanitizer),
		canAccept: proposedStatement !== null,
	};
}

function reviewDeduplicationKey(
	row: typeof memoryReviewItems.$inferSelect,
): string {
	const metadata = parseJsonRecord(row.metadataJson);
	const proposedStatement = readReviewProposedStatement(metadata);
	const category =
		readMemoryProfileCategory(metadata.category) ?? "uncategorized";
	return [
		category,
		proposedStatement
			? normalizeReviewDeduplicationText(proposedStatement)
			: `subject-key:${row.subjectKey}`,
	].join("\u001f");
}

export function dedupeReviewRows(
	rows: Array<typeof memoryReviewItems.$inferSelect>,
): Array<typeof memoryReviewItems.$inferSelect> {
	const deduped = new Map<string, typeof memoryReviewItems.$inferSelect>();
	for (const row of rows) {
		const key = reviewDeduplicationKey(row);
		if (!deduped.has(key)) {
			deduped.set(key, row);
		}
	}
	return [...deduped.values()];
}

export async function createOrUpdateMemoryReviewItem(params: {
	userId: string;
	subjectKey: string;
	subjectLabel: string;
	question: string;
	reason: string;
	affectedItemIds?: string[];
	evidence?: unknown[];
	metadata?: JsonRecord;
	expectedResetGeneration?: number;
}): Promise<{ id: string; status: "open"; evidenceCount: number }> {
	assertPrivacySafeMetadata(params.metadata);
	const resetGeneration = await assertExpectedMemoryResetGeneration({
		userId: params.userId,
		expectedResetGeneration: params.expectedResetGeneration,
	});
	const now = new Date();
	const requestedAffectedItemIds = Array.from(
		new Set((params.affectedItemIds ?? []).filter((id) => id.length > 0)),
	);
	const [existing] = await db
		.select()
		.from(memoryReviewItems)
		.where(
			and(
				eq(memoryReviewItems.userId, params.userId),
				eq(memoryReviewItems.resetGeneration, resetGeneration),
				eq(memoryReviewItems.subjectKey, params.subjectKey),
				eq(memoryReviewItems.status, "open"),
			),
		)
		.limit(1);

	if (existing) {
		const evidence = [
			...parseJsonArray(existing.evidenceJson),
			...(params.evidence ?? []),
		];
		const affectedItemIds = Array.from(
			new Set([
				...parseJsonArray(existing.affectedItemIdsJson).filter(
					(value): value is string => typeof value === "string",
				),
				...requestedAffectedItemIds,
			]),
		);
		await markAffectedActiveMemoryProfileItemsForReview({
			userId: params.userId,
			resetGeneration,
			affectedItemIds,
			now,
			mutateReviewItem: (tx) => {
				tx.update(memoryReviewItems)
					.set({
						question: params.question,
						reason: params.reason,
						subjectLabel: params.subjectLabel,
						affectedItemIdsJson: JSON.stringify(affectedItemIds),
						evidenceJson: JSON.stringify(evidence),
						metadataJson: JSON.stringify(
							params.metadata ?? parseJsonRecord(existing.metadataJson),
						),
						updatedAt: now,
					})
					.where(eq(memoryReviewItems.id, existing.id))
					.run();
			},
		});
		return {
			id: existing.id,
			status: "open",
			evidenceCount: evidence.length,
		};
	}

	const id = randomUUID();
	await markAffectedActiveMemoryProfileItemsForReview({
		userId: params.userId,
		resetGeneration,
		affectedItemIds: requestedAffectedItemIds,
		now,
		mutateReviewItem: (tx) => {
			tx.insert(memoryReviewItems)
				.values({
					id,
					userId: params.userId,
					resetGeneration,
					subjectKey: params.subjectKey,
					subjectLabel: params.subjectLabel,
					question: params.question,
					reason: params.reason,
					affectedItemIdsJson: JSON.stringify(requestedAffectedItemIds),
					evidenceJson: JSON.stringify(params.evidence ?? []),
					metadataJson: JSON.stringify(params.metadata ?? {}),
					createdAt: now,
					updatedAt: now,
				})
				.run();
		},
	});
	return {
		id,
		status: "open",
		evidenceCount: params.evidence?.length ?? 0,
	};
}

async function markAffectedActiveMemoryProfileItemsForReview(params: {
	userId: string;
	resetGeneration: number;
	affectedItemIds: string[];
	now: Date;
	mutateReviewItem: (
		tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	) => void;
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

export async function resolveMemoryReviewItem(params: {
	userId: string;
	reviewItemId: string;
	resolutionType: MemoryReviewResolutionType;
	editedStatement?: string;
	metadata?: JsonRecord;
}): Promise<{ status: "resolved" } | { status: "not_found" }> {
	assertOneOf(
		params.resolutionType,
		MEMORY_REVIEW_RESOLUTION_TYPES,
		"memory review resolution",
	);
	assertPrivacySafeMetadata(params.metadata);
	const resetGeneration = await getCurrentMemoryResetGeneration(params.userId);
	const [review] = await db
		.select()
		.from(memoryReviewItems)
		.where(
			and(
				eq(memoryReviewItems.userId, params.userId),
				eq(memoryReviewItems.id, params.reviewItemId),
				eq(memoryReviewItems.resetGeneration, resetGeneration),
			),
		)
		.limit(1);
	if (!review) return { status: "not_found" };

	const now = new Date();
	await db.transaction((tx) => {
		tx.insert(memoryReviewResolutions)
			.values({
				id: randomUUID(),
				reviewItemId: review.id,
				userId: params.userId,
				resetGeneration,
				resolutionType: params.resolutionType,
				editedStatement: params.editedStatement,
				metadataJson: JSON.stringify(params.metadata ?? {}),
				createdAt: now,
			})
			.onConflictDoNothing({
				target: memoryReviewResolutions.reviewItemId,
			})
			.run();
		tx.update(memoryReviewItems)
			.set({
				status: "resolved",
				resolvedAt: now,
				updatedAt: now,
			})
			.where(eq(memoryReviewItems.id, review.id))
			.run();
	});

	return { status: "resolved" };
}

export async function applyMemoryReviewItemWithRevision(params: {
	userId: string;
	reviewItemId: string;
	expectedProjectionRevision: number;
	action: "accept" | "edit" | "dismiss";
	statement?: string;
}): Promise<
	| {
			status: "updated";
			projectionRevision: number;
			itemId: string | null;
			category: MemoryProfileCategory | null;
	  }
	| { status: "stale_projection" }
	| { status: "not_found" }
> {
	const resetGeneration = await getCurrentMemoryResetGeneration(params.userId);
	const projection = await ensureProjectionState({
		userId: params.userId,
		resetGeneration,
	});
	const [review] = await db
		.select()
		.from(memoryReviewItems)
		.where(
			and(
				eq(memoryReviewItems.userId, params.userId),
				eq(memoryReviewItems.id, params.reviewItemId),
				eq(memoryReviewItems.resetGeneration, resetGeneration),
				eq(memoryReviewItems.status, "open"),
			),
		)
		.limit(1);
	if (!review) return { status: "not_found" };

	const metadata = parseJsonRecord(review.metadataJson);
	const duplicateReviewKey = reviewDeduplicationKey(review);
	const duplicateReviewRows = (
		await db
			.select()
			.from(memoryReviewItems)
			.where(
				and(
					eq(memoryReviewItems.userId, params.userId),
					eq(memoryReviewItems.resetGeneration, resetGeneration),
					eq(memoryReviewItems.status, "open"),
				),
			)
	).filter((row) => reviewDeduplicationKey(row) === duplicateReviewKey);
	const affectedItemIds = Array.from(
		new Set(
			duplicateReviewRows.flatMap((row) =>
				parseJsonArray(row.affectedItemIdsJson).filter(
					(value): value is string => typeof value === "string",
				),
			),
		),
	);
	const proposedStatement = readReviewProposedStatement(metadata);
	const candidateStatement = params.statement ?? proposedStatement ?? "";
	const category =
		params.action === "dismiss"
			? null
			: inferReviewCategory({
					subject: candidateStatement || review.subjectLabel,
					question: review.question,
					reason: review.reason,
					metadata,
				});
	const statement =
		params.action === "dismiss" ? null : candidateStatement.trim();
	if (params.action !== "dismiss" && !statement) {
		return { status: "not_found" };
	}

	const now = new Date();
	const nextProjectionRevision = params.expectedProjectionRevision + 1;
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

		// On accept, recompute expiresAt from the review item's own
		// metadata: a time_bound item gets its factual horizon applied now
		// (it no longer needs the review auto-expiry window); a durable item
		// has its expiry cleared entirely.
		const acceptExpiresInDays =
			params.action === "accept" &&
			metadata.expiryClass === "time_bound" &&
			typeof metadata.expiresInDays === "number"
				? metadata.expiresInDays
				: null;
		const acceptExpiresAt =
			params.action === "accept"
				? acceptExpiresInDays !== null
					? new Date(now.getTime() + acceptExpiresInDays * 86_400_000)
					: null
				: undefined;

		let itemId: string | null = null;
		if (category && statement) {
			const scope: MemoryProfileScope = { type: "global" };
			const scopeColumns = toScopeColumns(scope);
			const itemKey = resolveMemoryProfileItemKey({
				category,
				scope,
				statement,
			});
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
							updatedAt: now,
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
						projectionStateId: projection.id,
						resetGeneration,
						itemKey,
						category,
						scopeType: scopeColumns.scopeType,
						scopeId: scopeColumns.scopeId,
						statement,
						status: "active",
						expiresAt: acceptExpiresAt ?? undefined,
						revision: 0,
						createdAt: now,
						updatedAt: now,
					})
					.run();
			}
		}

		if (params.action === "dismiss" && affectedItemIds.length > 0) {
			tx.update(memoryProfileItems)
				.set({
					status: "suppressed",
					suppressedAt: now,
					revision: sql`${memoryProfileItems.revision} + 1`,
					updatedAt: now,
				})
				.where(
					and(
						eq(memoryProfileItems.userId, params.userId),
						eq(memoryProfileItems.resetGeneration, resetGeneration),
						eq(memoryProfileItems.status, "active"),
						inArray(memoryProfileItems.id, affectedItemIds),
					),
				)
				.run();
		}

		const resolutionType: MemoryReviewResolutionType =
			params.action === "accept"
				? "use_fact"
				: params.action === "edit"
					? "edit_fact"
					: "do_not_remember";
		for (const duplicateReview of duplicateReviewRows) {
			tx.insert(memoryReviewResolutions)
				.values({
					id: randomUUID(),
					reviewItemId: duplicateReview.id,
					userId: params.userId,
					resetGeneration,
					resolutionType,
					editedStatement: params.action === "edit" ? statement : undefined,
					metadataJson: JSON.stringify({
						action: params.action,
						category,
						resolvedWithReviewItemId: review.id,
					}),
					createdAt: now,
				})
				.onConflictDoNothing({
					target: memoryReviewResolutions.reviewItemId,
				})
				.run();
			tx.update(memoryReviewItems)
				.set({
					status: "resolved",
					resolvedAt: now,
					updatedAt: now,
				})
				.where(eq(memoryReviewItems.id, duplicateReview.id))
				.run();
		}

		return {
			status: "updated" as const,
			projectionRevision: nextProjectionRevision,
			itemId,
			category,
		};
	});

	return result;
}
