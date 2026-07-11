import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { memoryReviewItems } from "$lib/server/db/schema";
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

	// On accept, recompute expiresAt from the review item's own metadata: a
	// time_bound item gets its factual horizon applied now (it no longer needs
	// the review auto-expiry window); a durable item has its expiry cleared.
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

	const resolutionType: MemoryReviewResolutionType =
		params.action === "accept"
			? "use_fact"
			: params.action === "edit"
				? "edit_fact"
				: "do_not_remember";

	// Hand the projection store a plain decision; it runs the revision claim, the
	// create/reactivate + suppress item writes, and the review-row resolution as
	// one atomic transaction. review.ts owns only the review-specific reasoning.
	const scope: MemoryProfileScope = { type: "global" };
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
