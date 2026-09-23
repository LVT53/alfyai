import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import { memoryProfileItems, memoryReviewItems } from "$lib/server/db/schema";
import {
	type MemoryProfileTextSanitizer,
	sanitizePublicMemoryText,
} from "./identity-sanitizer";
import { parseJsonArray, parseJsonRecord } from "./internal-json";
import {
	applyReviewItemProjectionMutation,
	ensureProjectionState,
	markActiveMemoryProfileItemsForReview,
} from "./projection-store";
import {
	assertExpectedMemoryResetGeneration,
	getCurrentMemoryResetGeneration,
} from "./reset-generation";
import { resolveReviewRowsTx } from "./review-resolution";
import {
	fromScopeColumns,
	normalizeRememberedStatement,
	resolveMemoryProfileItemKey,
	stableMemoryMaintenanceDigest,
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
	USER_ACCEPTED_MEMORY_ENDORSEMENT,
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

/**
 * Review rows the Memory Judge opens for an inferred fact. Their subject label
 * IS the remembered statement and their affected item carries it, so they are
 * acceptable even without `proposedStatement` metadata (rows opened before the
 * judge started writing it).
 */
export const JUDGE_REVIEW_SUBJECT_PREFIX = "judge:";

function isJudgeReviewRow(row: typeof memoryReviewItems.$inferSelect): boolean {
	return row.subjectKey.startsWith(JUDGE_REVIEW_SUBJECT_PREFIX);
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
		canAccept: proposedStatement !== null || isJudgeReviewRow(row),
	};
}

/**
 * The expiry an item should carry once a review promotes it to active: a
 * time_bound fact gets its factual horizon from now; anything else has the
 * review auto-expiry cleared. Review-row metadata wins over item metadata.
 */
function acceptedExpiresAt(sources: JsonRecord[], now: Date): Date | null {
	for (const source of sources) {
		if (
			source.expiryClass === "time_bound" &&
			typeof source.expiresInDays === "number" &&
			source.expiresInDays > 0
		) {
			return new Date(now.getTime() + source.expiresInDays * 86_400_000);
		}
		if (source.expiryClass === "durable") return null;
	}
	return null;
}

type ReviewRow = typeof memoryReviewItems.$inferSelect;

type ReviewAffectedItem = Pick<
	typeof memoryProfileItems.$inferSelect,
	"id" | "status" | "scopeType" | "scopeId"
>;

function readReviewAffectedItemIds(row: ReviewRow): string[] {
	return parseJsonArray(row.affectedItemIdsJson).filter(
		(value): value is string => typeof value === "string",
	);
}

/** The current state of every item the given review rows point at. */
async function loadReviewAffectedItems(params: {
	userId: string;
	resetGeneration: number;
	rows: ReviewRow[];
}): Promise<Map<string, ReviewAffectedItem>> {
	const ids = [...new Set(params.rows.flatMap(readReviewAffectedItemIds))];
	if (ids.length === 0) return new Map();
	const items = await db
		.select({
			id: memoryProfileItems.id,
			status: memoryProfileItems.status,
			scopeType: memoryProfileItems.scopeType,
			scopeId: memoryProfileItems.scopeId,
		})
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
				inArray(memoryProfileItems.id, ids),
			),
		);
	return new Map(items.map((item) => [item.id, item]));
}

/**
 * The scope of the fact a review row asks about: the scope of its first
 * affected item that still exists (the judge decided it at intake). Rows with
 * no affected item are global, which is where legacy curation proposals lived.
 */
function reviewScopeKey(
	row: ReviewRow,
	affectedItems: Map<string, ReviewAffectedItem>,
): string {
	for (const id of readReviewAffectedItemIds(row)) {
		const item = affectedItems.get(id);
		if (item) return `${item.scopeType}:${item.scopeId}`;
	}
	return "global:";
}

/**
 * Two open rows are one card only when they propose the same fact: same
 * category, same statement, and same scope. The same statement in a different
 * scope is a different fact, so accepting one must not resolve the other.
 */
function reviewDeduplicationKey(
	row: ReviewRow,
	affectedItems: Map<string, ReviewAffectedItem>,
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
		reviewScopeKey(row, affectedItems),
	].join("\u001f");
}

function dedupeReviewRows(
	rows: ReviewRow[],
	affectedItems: Map<string, ReviewAffectedItem>,
): ReviewRow[] {
	const deduped = new Map<string, ReviewRow>();
	for (const row of rows) {
		const key = reviewDeduplicationKey(row, affectedItems);
		if (!deduped.has(key)) {
			deduped.set(key, row);
		}
	}
	return [...deduped.values()];
}

/**
 * The Guided Memory Review queue: the user's open review rows, oldest update
 * first, with rows that propose the same fact collapsed into one card. The
 * read model's `review.openCount` is the length of this list.
 */
export async function listOpenReviewQueueRows(params: {
	userId: string;
	resetGeneration: number;
}): Promise<ReviewRow[]> {
	const rows = await db
		.select()
		.from(memoryReviewItems)
		.where(
			and(
				eq(memoryReviewItems.userId, params.userId),
				eq(memoryReviewItems.resetGeneration, params.resetGeneration),
				eq(memoryReviewItems.status, "open"),
			),
		)
		.orderBy(asc(memoryReviewItems.updatedAt));
	const affectedItems = await loadReviewAffectedItems({
		userId: params.userId,
		resetGeneration: params.resetGeneration,
		rows,
	});
	return dedupeReviewRows(rows, affectedItems);
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
		await markActiveMemoryProfileItemsForReview({
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
	await markActiveMemoryProfileItemsForReview({
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
	db.transaction((tx) => {
		resolveReviewRowsTx(tx, {
			userId: params.userId,
			resetGeneration,
			now,
			rows: [
				{
					reviewItemId: review.id,
					resolutionType: params.resolutionType,
					editedStatement: params.editedStatement,
					metadata: params.metadata,
				},
			],
		});
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
	const openReviewRows = await db
		.select()
		.from(memoryReviewItems)
		.where(
			and(
				eq(memoryReviewItems.userId, params.userId),
				eq(memoryReviewItems.resetGeneration, resetGeneration),
				eq(memoryReviewItems.status, "open"),
			),
		);
	const openRowAffectedItems = await loadReviewAffectedItems({
		userId: params.userId,
		resetGeneration,
		rows: openReviewRows,
	});
	const duplicateReviewKey = reviewDeduplicationKey(
		review,
		openRowAffectedItems,
	);
	const duplicateReviewRows = openReviewRows.filter(
		(row) =>
			reviewDeduplicationKey(row, openRowAffectedItems) === duplicateReviewKey,
	);
	const affectedItemIds = Array.from(
		new Set(duplicateReviewRows.flatMap(readReviewAffectedItemIds)),
	);
	// The review_needed items this review is about. The first one is the
	// "primary" item: its category and scope are authoritative for accept and
	// edit (they were decided at intake), and its statement is the accept
	// fallback when the row carries no proposed statement (judge rows).
	const affectedItems =
		affectedItemIds.length > 0
			? await db
					.select()
					.from(memoryProfileItems)
					.where(
						and(
							eq(memoryProfileItems.userId, params.userId),
							eq(memoryProfileItems.resetGeneration, resetGeneration),
							inArray(memoryProfileItems.id, affectedItemIds),
						),
					)
			: [];
	const reviewNeededItems = affectedItemIds
		.map((id) => affectedItems.find((item) => item.id === id))
		.filter(
			(item): item is (typeof affectedItems)[number] =>
				item?.status === "review_needed",
		);
	const primaryItem = reviewNeededItems[0] ?? null;
	const primaryCategory = primaryItem
		? readMemoryProfileCategory(primaryItem.category)
		: null;

	const proposedStatement = readReviewProposedStatement(metadata);
	const candidateStatement =
		params.statement ?? proposedStatement ?? primaryItem?.statement ?? "";
	const category =
		params.action === "dismiss"
			? null
			: (primaryCategory ??
				inferReviewCategory({
					subject: candidateStatement || review.subjectLabel,
					question: review.question,
					reason: review.reason,
					metadata,
				}));
	const statement =
		params.action === "dismiss" ? null : candidateStatement.trim();
	if (params.action !== "dismiss" && !statement) {
		return { status: "not_found" };
	}

	const now = new Date();

	// On accept or edit, recompute expiresAt: a time_bound fact gets its factual
	// horizon applied now (it no longer needs the review auto-expiry window); a
	// durable one has its expiry cleared. The review row's metadata wins, then
	// the primary item's own intake metadata (the judge stores it there).
	const acceptExpiresAt =
		params.action === "dismiss"
			? undefined
			: acceptedExpiresAt(
					[
						metadata,
						primaryItem ? parseJsonRecord(primaryItem.metadataJson) : {},
					],
					now,
				);

	const resolutionType: MemoryReviewResolutionType =
		params.action === "accept"
			? "use_fact"
			: params.action === "edit"
				? "edit_fact"
				: "do_not_remember";

	// Accepting the primary item's own statement promotes that item in place,
	// keeping its identity, metadata, and provenance. Any other outcome (an
	// edit, or a curated proposed statement) writes the result under the
	// primary's category/scope and retires the replaced review_needed items
	// with a pointer to it.
	const promoteItemId =
		params.action === "accept" &&
		primaryItem &&
		statement &&
		normalizeRememberedStatement(primaryItem.statement) ===
			normalizeRememberedStatement(statement)
			? primaryItem.id
			: undefined;

	// Hand the projection store a plain decision; it runs the revision claim, the
	// create/reactivate/retire + suppress item writes, and the review-row
	// resolution as one atomic transaction. review.ts owns only the
	// review-specific reasoning.
	const scope: MemoryProfileScope = primaryItem
		? fromScopeColumns(primaryItem.scopeType, primaryItem.scopeId)
		: { type: "global" };
	const mutation = await applyReviewItemProjectionMutation({
		userId: params.userId,
		resetGeneration,
		projectionStateId: projection.id,
		expectedProjectionRevision: params.expectedProjectionRevision,
		now,
		upsert:
			category && statement
				? {
						itemKey: resolveMemoryProfileItemKey({
							category,
							scope,
							statement,
						}),
						category,
						scope,
						statement,
						acceptExpiresAt,
						promoteItemId,
						replaceItemIds: reviewNeededItems.map((item) => item.id),
						retiredReason:
							params.action === "edit"
								? "review_edited"
								: "review_accepted_replacement",
						metadataPatch:
							params.action === "edit"
								? { origin: "user_authored", reviewResolution: "edited" }
								: {
										reviewResolution: "accepted",
										// Accepting endorses the fact: it keeps its true origin but
										// becomes user-protected (isUserProtectedMemoryMetadata).
										endorsement: USER_ACCEPTED_MEMORY_ENDORSEMENT,
										userConfirmedAt: now.toISOString(),
									},
					}
				: null,
		suppressItemIds: params.action === "dismiss" ? affectedItemIds : [],
		resolveRows: duplicateReviewRows.map((duplicateReview) => ({
			reviewItemId: duplicateReview.id,
			resolutionType,
			editedStatement:
				params.action === "edit" ? (statement ?? undefined) : undefined,
			metadata: {
				action: params.action,
				category,
				resolvedWithReviewItemId: review.id,
			},
		})),
	});

	if (mutation.status === "stale_projection") {
		return { status: "stale_projection" };
	}
	return {
		status: "updated",
		projectionRevision: mutation.projectionRevision,
		itemId: mutation.itemId,
		category,
	};
}
