import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { memoryConsolidationReports } from "$lib/server/db/schema";
import type {
	KnowledgeMemoryOverviewPayload,
	MemoryProfileActionPayload,
	MemoryProfilePublicItem,
	MemoryProfilePublicItemDetail,
	MemoryProfilePublicPayload,
} from "$lib/types";
import {
	listMemoryConsolidationReports,
	type MemoryConsolidationReport,
} from "./memory-consolidation";
import type { ConsolidationAction } from "./memory-consolidation/steps";
import {
	generateAndStorePersonaSummary,
	getPersonaSummary,
	type PersonaSummary,
} from "./memory-consolidation/summary";
import {
	applyMemoryReviewItemWithRevision,
	createMemoryProfileItem,
	getActiveMemoryProfileContext,
	getMemoryProfileItemDetail,
	getMemoryProfileReadModel,
	type MemoryProfileCardItem,
	type MemoryProfileCategory,
	type MemoryProfileItemDetail,
	type MemoryProfileItemStatus,
	type MemoryProfileReadModel,
	markMemoryDirty,
	mergeMemoryProfileItemMetadata,
	normalizeRememberedStatement,
	recordMemoryReworkTelemetry,
	updateMemoryProfileItemWithRevision,
} from "./memory-profile";

export class MemoryProfileActionError extends Error {
	readonly code:
		| "invalid_action"
		| "stale_projection"
		| "not_found"
		| "undo_partial_failure";
	readonly status: number;

	constructor(
		code: MemoryProfileActionError["code"],
		message: string,
		status: number,
	) {
		super(message);
		this.name = "MemoryProfileActionError";
		this.code = code;
		this.status = status;
	}
}

function serializeMemoryProfileItem(
	item: MemoryProfileCardItem,
): MemoryProfilePublicItem {
	return {
		...item,
		updatedAt: item.updatedAt.toISOString(),
		expiresAt: item.expiresAt ? item.expiresAt.toISOString() : null,
	};
}

function serializeMemoryProfileItemDetail(
	item: MemoryProfileItemDetail,
): MemoryProfilePublicItemDetail {
	return {
		...serializeMemoryProfileItem(item),
		sourceChips: item.sourceChips,
		whyRemembered: item.whyRemembered,
	};
}

function serializeMemoryProfileReadModel(
	profile: MemoryProfileReadModel,
): MemoryProfilePublicPayload {
	return {
		resetGeneration: profile.resetGeneration,
		projectionRevision: profile.projectionRevision,
		categories: profile.categories.map((group) => ({
			category: group.category,
			items: group.items.map(serializeMemoryProfileItem),
		})),
		review: profile.review,
	};
}

async function markStaleProjectionRead(userId: string, source: string) {
	await markMemoryDirty({
		userId,
		reason: "stale_projection",
		scope: { type: "global" },
		metadata: { source },
	});
}

async function markLegacyMigrationRead(userId: string, source: string) {
	await markMemoryDirty({
		userId,
		reason: "legacy_migration",
		scope: { type: "global" },
		metadata: { source },
	});
}

function hasActiveMemoryProfileItems(profile: MemoryProfileReadModel): boolean {
	return profile.categories.some((group) => group.items.length > 0);
}

function queueMemoryReadMaintenance(userId: string, source: string): void {
	void import("./memory-maintenance")
		.then(({ runUserMemoryMaintenance }) =>
			runUserMemoryMaintenance(userId, source),
		)
		.catch((error) => {
			console.error("[KNOWLEDGE_MEMORY] Deferred maintenance failed", {
				userId,
				source,
				error,
			});
		});
}

async function bootstrapEmptyMemoryProfile(
	userId: string,
	source: string,
	profile: MemoryProfileReadModel,
): Promise<MemoryProfileReadModel> {
	if (hasActiveMemoryProfileItems(profile)) return profile;

	await markLegacyMigrationRead(userId, source);
	queueMemoryReadMaintenance(userId, source);
	return profile;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isExpectedProjectionRevision(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

type ParsedMemoryProfileAction = MemoryProfileActionPayload;

function parseMemoryProfileAction(payload: unknown): ParsedMemoryProfileAction {
	if (!payload || typeof payload !== "object") {
		throw new MemoryProfileActionError(
			"invalid_action",
			"Invalid memory profile action payload.",
			400,
		);
	}
	const record = payload as Record<string, unknown>;
	const itemId = record.itemId;
	const expectedProjectionRevision = record.expectedProjectionRevision;
	if (
		record.target !== undefined &&
		record.target !== "profile_item" &&
		record.target !== "review_item"
	) {
		throw new MemoryProfileActionError(
			"invalid_action",
			"Invalid memory profile action payload.",
			400,
		);
	}
	const target =
		record.target === "review_item" ? "review_item" : "profile_item";
	if (
		!isNonEmptyString(itemId) ||
		!isExpectedProjectionRevision(expectedProjectionRevision)
	) {
		throw new MemoryProfileActionError(
			"invalid_action",
			"Memory profile actions require itemId and expectedProjectionRevision.",
			400,
		);
	}

	if (target === "review_item") {
		if (record.action === "accept") {
			return {
				target: "review_item",
				action: "accept",
				itemId: itemId.trim(),
				expectedProjectionRevision,
			};
		}
		if (record.action === "suppress") {
			return {
				target: "review_item",
				action: "suppress",
				itemId: itemId.trim(),
				expectedProjectionRevision,
			};
		}
		if (record.action === "edit" && isNonEmptyString(record.statement)) {
			return {
				target: "review_item",
				action: "edit",
				itemId: itemId.trim(),
				statement: record.statement.trim(),
				expectedProjectionRevision,
			};
		}
		throw new MemoryProfileActionError(
			"invalid_action",
			"Invalid memory profile action payload.",
			400,
		);
	}

	if (record.action === "delete" || record.action === "suppress") {
		return {
			target: "profile_item",
			action: record.action,
			itemId: itemId.trim(),
			expectedProjectionRevision,
		};
	}

	if (record.action === "edit" && isNonEmptyString(record.statement)) {
		return {
			target: "profile_item",
			action: "edit",
			itemId: itemId.trim(),
			statement: record.statement.trim(),
			expectedProjectionRevision,
		};
	}

	throw new MemoryProfileActionError(
		"invalid_action",
		"Invalid memory profile action payload.",
		400,
	);
}

export type MemoryV2ActionPayload =
	| {
			kind: "profile_item";
			action: "correct";
			itemId: string;
			statement: string;
			expectedProjectionRevision: number;
	  }
	| {
			kind: "profile_item";
			action: "retire";
			itemId: string;
			expectedProjectionRevision: number;
	  }
	| { kind: "summary"; action: "edit"; text: string }
	| {
			kind: "consolidation";
			action: "undo";
			reportId: string;
			actionIndex: number;
	  };

/**
 * Returns null when the payload does not use the `kind`-discriminated v2
 * action envelope, so callers can fall back to the legacy `target`-based
 * parser. Throws MemoryProfileActionError for a recognized-but-invalid v2
 * payload.
 */
function parseMemoryV2Action(payload: unknown): MemoryV2ActionPayload | null {
	if (!payload || typeof payload !== "object") return null;
	const record = payload as Record<string, unknown>;
	if (
		record.kind !== "profile_item" &&
		record.kind !== "summary" &&
		record.kind !== "consolidation"
	) {
		return null;
	}

	if (record.kind === "profile_item") {
		if (
			!isNonEmptyString(record.itemId) ||
			!isExpectedProjectionRevision(record.expectedProjectionRevision)
		) {
			throw new MemoryProfileActionError(
				"invalid_action",
				"Memory profile actions require itemId and expectedProjectionRevision.",
				400,
			);
		}
		if (record.action === "retire") {
			return {
				kind: "profile_item",
				action: "retire",
				itemId: record.itemId.trim(),
				expectedProjectionRevision: record.expectedProjectionRevision,
			};
		}
		if (record.action === "correct" && isNonEmptyString(record.statement)) {
			return {
				kind: "profile_item",
				action: "correct",
				itemId: record.itemId.trim(),
				statement: record.statement.trim(),
				expectedProjectionRevision: record.expectedProjectionRevision,
			};
		}
		throw new MemoryProfileActionError(
			"invalid_action",
			"Invalid memory profile action payload.",
			400,
		);
	}

	if (record.kind === "summary") {
		if (record.action === "edit" && isNonEmptyString(record.text)) {
			return { kind: "summary", action: "edit", text: record.text.trim() };
		}
		throw new MemoryProfileActionError(
			"invalid_action",
			"Invalid memory profile action payload.",
			400,
		);
	}

	// kind === "consolidation"
	if (
		record.action === "undo" &&
		isNonEmptyString(record.reportId) &&
		typeof record.actionIndex === "number" &&
		Number.isInteger(record.actionIndex) &&
		record.actionIndex >= 0
	) {
		return {
			kind: "consolidation",
			action: "undo",
			reportId: record.reportId.trim(),
			actionIndex: record.actionIndex,
		};
	}
	throw new MemoryProfileActionError(
		"invalid_action",
		"Invalid memory profile action payload.",
		400,
	);
}

/**
 * Split free-form summary-edit text into individual sentences. A simple
 * split on sentence-ending punctuation, tolerant of missing trailing
 * punctuation on the last fragment. Empty/whitespace-only fragments are
 * dropped.
 */
export function splitSentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

async function markProfileActionReconciliation(params: {
	userId: string;
	action: ParsedMemoryProfileAction["action"];
	itemId?: string | null;
	reviewItemId?: string;
}) {
	const metadata = {
		action: params.action,
		...(params.itemId ? { itemId: params.itemId } : {}),
		...(params.reviewItemId ? { reviewItemId: params.reviewItemId } : {}),
	};
	await markMemoryDirty({
		userId: params.userId,
		reason: "profile_action_reconciliation",
		scope: { type: "global" },
		metadata,
	});
	await markMemoryDirty({
		userId: params.userId,
		reason: "projection_reconciliation",
		scope: { type: "global" },
		metadata,
	});
}

async function recordProfileActionTelemetry(params: {
	userId: string;
	action: ParsedMemoryProfileAction["action"];
	itemId: string;
	status: "updated" | "stale_projection" | "not_found";
	target?: "profile_item" | "review_item";
}) {
	await recordMemoryReworkTelemetry({
		userId: params.userId,
		eventFamily: "profile_action",
		eventName: `memory_profile_${params.action}`,
		reason: "user_action",
		status: params.status,
		subjectId: params.itemId,
		metadata: {
			action: params.action,
			...(params.target ? { target: params.target } : {}),
		},
	});
}

async function recordReviewActionTelemetry(params: {
	userId: string;
	action: Extract<
		ParsedMemoryProfileAction["action"],
		"accept" | "edit" | "suppress"
	>;
	reviewItemId: string;
	itemId?: string | null;
	category?: MemoryProfileCategory | null;
	status: "updated" | "stale_projection" | "not_found";
}) {
	await recordMemoryReworkTelemetry({
		userId: params.userId,
		eventFamily: "guided_review",
		eventName: `memory_review_${params.action}`,
		category: params.category ?? undefined,
		reason: "user_action",
		status: params.status,
		subjectId: params.reviewItemId,
		metadata: {
			action: params.action,
			...(params.itemId ? { itemId: params.itemId } : {}),
		},
	});
}

export async function getKnowledgeMemory(
	userId: string,
	_userDisplayName: string,
): Promise<MemoryProfilePublicPayload> {
	const source = "knowledge_memory_read";
	await markStaleProjectionRead(userId, source);
	const profile = await bootstrapEmptyMemoryProfile(
		userId,
		source,
		await getMemoryProfileReadModel({ userId }),
	);
	return serializeMemoryProfileReadModel(profile);
}

export async function getKnowledgeMemoryItemDetail(
	userId: string,
	itemId: string,
): Promise<MemoryProfilePublicItemDetail | null> {
	const detail = await getMemoryProfileItemDetail({ userId, itemId });
	return detail ? serializeMemoryProfileItemDetail(detail) : null;
}

function buildCompatibilitySummary(
	profile: MemoryProfilePublicPayload,
): KnowledgeMemoryOverviewPayload["summary"] {
	const activeItemCount = profile.categories.reduce(
		(total, group) => total + group.items.length,
		0,
	);
	return {
		personaCount: activeItemCount,
		taskCount: 0,
		focusContinuityCount: 0,
		activeConstraintCount:
			profile.categories.find(
				(group) => group.category === "constraints_boundaries",
			)?.items.length ?? 0,
		currentProjectContextCount:
			profile.categories.find(
				(group) => group.category === "goals_ongoing_work",
			)?.items.length ?? 0,
		overview: null,
		overviewBullets: [],
		overviewSource: null,
		overviewStatus: activeItemCount > 0 ? "ready" : "not_enough_durable_memory",
		overviewUpdatedAt: null,
		overviewLastAttemptAt: Date.now(),
		durablePersonaCount: activeItemCount,
	};
}

export async function getKnowledgeMemoryOverview(
	userId: string,
	_userDisplayName: string,
	options: { awaitLive?: boolean; force?: boolean } = {},
): Promise<KnowledgeMemoryOverviewPayload> {
	const source = options.force
		? "knowledge_memory_overview_force_read"
		: "knowledge_memory_overview_read";
	await markStaleProjectionRead(userId, source);
	const profile = serializeMemoryProfileReadModel(
		await bootstrapEmptyMemoryProfile(
			userId,
			source,
			await getMemoryProfileReadModel({ userId }),
		),
	);
	return {
		summary: buildCompatibilitySummary(profile),
		profile,
	};
}

export type KnowledgeMemorySummaryPayload = {
	summary: {
		text: string;
		links: Array<{ text: string; factIds: string[] }>;
		updatedAt: string;
	} | null;
};

export type KnowledgeMemoryTimelinePayload = {
	reports: Array<{
		id: string;
		status: string;
		summaryText: string;
		createdAt: string;
		actions: ConsolidationAction[];
	}>;
};

function serializePersonaSummary(
	summary: PersonaSummary,
): KnowledgeMemorySummaryPayload["summary"] {
	if (!summary) return null;
	return {
		text: summary.text,
		links: summary.links,
		updatedAt: summary.updatedAt.toISOString(),
	};
}

function serializeConsolidationReport(
	report: MemoryConsolidationReport,
): KnowledgeMemoryTimelinePayload["reports"][number] {
	return {
		id: report.id,
		status: report.status,
		summaryText: report.summaryText,
		createdAt: report.createdAt.toISOString(),
		actions: report.actions,
	};
}

export async function getKnowledgeMemorySummary(
	userId: string,
): Promise<KnowledgeMemorySummaryPayload> {
	const summary = await getPersonaSummary({ userId });
	return { summary: serializePersonaSummary(summary) };
}

export async function listKnowledgeMemoryTimeline(
	userId: string,
): Promise<KnowledgeMemoryTimelinePayload> {
	const reports = await listMemoryConsolidationReports({ userId, limit: 20 });
	return { reports: reports.map(serializeConsolidationReport) };
}

async function applyProfileItemCorrect(
	userId: string,
	action: Extract<
		MemoryV2ActionPayload,
		{ kind: "profile_item"; action: "correct" }
	>,
): Promise<MemoryProfilePublicPayload> {
	const result = await updateMemoryProfileItemWithRevision({
		userId,
		itemId: action.itemId,
		expectedProjectionRevision: action.expectedProjectionRevision,
		patch: { statement: action.statement },
	});

	if (result.status !== "updated") {
		await recordProfileActionTelemetry({
			userId,
			action: "edit",
			itemId: action.itemId,
			status: result.status,
		});
		if (result.status === "stale_projection") {
			throw new MemoryProfileActionError(
				"stale_projection",
				"Memory profile changed before this action was applied.",
				409,
			);
		}
		throw new MemoryProfileActionError(
			"not_found",
			"Memory profile item was not found.",
			404,
		);
	}

	await mergeMemoryProfileItemMetadata({
		userId,
		itemId: action.itemId,
		patch: { origin: "user_authored" },
	});
	await markProfileActionReconciliation({
		userId,
		action: "edit",
		itemId: action.itemId,
	});
	await recordProfileActionTelemetry({
		userId,
		action: "edit",
		itemId: action.itemId,
		status: "updated",
	});

	return serializeMemoryProfileReadModel(
		await getMemoryProfileReadModel({ userId }),
	);
}

async function applyProfileItemRetire(
	userId: string,
	action: Extract<
		MemoryV2ActionPayload,
		{ kind: "profile_item"; action: "retire" }
	>,
): Promise<MemoryProfilePublicPayload> {
	const result = await updateMemoryProfileItemWithRevision({
		userId,
		itemId: action.itemId,
		expectedProjectionRevision: action.expectedProjectionRevision,
		patch: { status: "retired" },
	});

	if (result.status !== "updated") {
		await recordProfileActionTelemetry({
			userId,
			action: "suppress",
			itemId: action.itemId,
			status: result.status,
		});
		if (result.status === "stale_projection") {
			throw new MemoryProfileActionError(
				"stale_projection",
				"Memory profile changed before this action was applied.",
				409,
			);
		}
		throw new MemoryProfileActionError(
			"not_found",
			"Memory profile item was not found.",
			404,
		);
	}

	await markProfileActionReconciliation({
		userId,
		action: "suppress",
		itemId: action.itemId,
	});
	await recordProfileActionTelemetry({
		userId,
		action: "suppress",
		itemId: action.itemId,
		status: "updated",
	});

	return serializeMemoryProfileReadModel(
		await getMemoryProfileReadModel({ userId }),
	);
}

/**
 * Normalizes a statement for dedupe comparison: lowercase, collapse
 * whitespace (via normalizeRememberedStatement), and strip trailing
 * terminal punctuation so re-punctuated/re-cased restatements of the same
 * fact are recognized as duplicates.
 */
function normalizeForDedupeComparison(statement: string): string {
	return normalizeRememberedStatement(statement).replace(/[.!?]+$/, "");
}

async function applySummaryEdit(
	userId: string,
	action: Extract<MemoryV2ActionPayload, { kind: "summary"; action: "edit" }>,
): Promise<KnowledgeMemorySummaryPayload> {
	const sentences = splitSentences(action.text);
	const activeContext = await getActiveMemoryProfileContext({ userId });
	const existingStatements = new Set(
		activeContext.items.map((item) =>
			normalizeForDedupeComparison(item.statement),
		),
	);

	for (const sentence of sentences) {
		const normalizedSentence = normalizeForDedupeComparison(sentence);
		if (existingStatements.has(normalizedSentence)) continue;
		const item = await createMemoryProfileItem({
			userId,
			category: "about_you",
			scope: { type: "global" },
			statement: sentence,
			status: "active",
		});
		await mergeMemoryProfileItemMetadata({
			userId,
			itemId: item.id,
			patch: { origin: "user_authored" },
		});
		existingStatements.add(normalizedSentence);
	}

	const summary = await generateAndStorePersonaSummary({ userId });
	return { summary: serializePersonaSummary(summary) };
}

async function applyConsolidationUndo(
	userId: string,
	action: Extract<
		MemoryV2ActionPayload,
		{ kind: "consolidation"; action: "undo" }
	>,
): Promise<MemoryProfilePublicPayload> {
	const [reportRow] = await db
		.select()
		.from(memoryConsolidationReports)
		.where(eq(memoryConsolidationReports.id, action.reportId))
		.limit(1);
	if (!reportRow || reportRow.userId !== userId) {
		throw new MemoryProfileActionError(
			"not_found",
			"Consolidation report was not found.",
			404,
		);
	}

	let actions: ConsolidationAction[];
	try {
		const parsed = JSON.parse(reportRow.actionsJson);
		actions = Array.isArray(parsed) ? (parsed as ConsolidationAction[]) : [];
	} catch {
		actions = [];
	}

	const target = actions[action.actionIndex];
	if (!target) {
		throw new MemoryProfileActionError(
			"not_found",
			"Consolidation action was not found.",
			404,
		);
	}

	const activeContext = await getActiveMemoryProfileContext({ userId });
	let projectionRevision = activeContext.projectionRevision;
	let appliedCount = 0;
	const failedItemIds: string[] = [];
	for (const undo of target.undo) {
		// prevExpiresAt round-trips through actionsJson as an ISO string (or
		// null/undefined), since ConsolidationAction is persisted via
		// JSON.stringify. Parse it back into a Date here.
		const prevExpiresAt =
			undo.prevExpiresAt === undefined
				? undefined
				: undo.prevExpiresAt === null
					? null
					: new Date(undo.prevExpiresAt);
		const result = await updateMemoryProfileItemWithRevision({
			userId,
			itemId: undo.itemId,
			expectedProjectionRevision: projectionRevision,
			patch: {
				statement: undo.prevStatement,
				status: undo.prevStatus as MemoryProfileItemStatus,
				...(prevExpiresAt !== undefined ? { expiresAt: prevExpiresAt } : {}),
			},
		});
		if (result.status === "updated") {
			projectionRevision = result.projectionRevision;
			appliedCount += 1;
		} else {
			failedItemIds.push(undo.itemId);
		}
	}

	if (failedItemIds.length > 0) {
		// Entries that already applied stay applied: this store is
		// revision-based and each undo entry commits its own atomic
		// projection-revision bump, so there is no overarching transaction to
		// roll back. We surface the partial-failure count so the caller can
		// decide how to reconcile rather than silently losing entries.
		throw new MemoryProfileActionError(
			"undo_partial_failure",
			`Undo applied to ${appliedCount} of ${target.undo.length} item(s); ` +
				`${failedItemIds.length} failed (itemIds: ${failedItemIds.join(", ")}).`,
			409,
		);
	}

	await markProfileActionReconciliation({
		userId,
		action: "edit",
		itemId: null,
	});

	return serializeMemoryProfileReadModel(
		await getMemoryProfileReadModel({ userId }),
	);
}

export async function applyKnowledgeMemoryAction(
	userId: string,
	_userDisplayName: string,
	payload: { kind: "summary"; action: "edit"; text: string },
): Promise<KnowledgeMemorySummaryPayload>;
export async function applyKnowledgeMemoryAction(
	userId: string,
	_userDisplayName: string,
	payload: unknown,
): Promise<MemoryProfilePublicPayload>;
export async function applyKnowledgeMemoryAction(
	userId: string,
	_userDisplayName: string,
	payload: unknown,
): Promise<MemoryProfilePublicPayload | KnowledgeMemorySummaryPayload> {
	const v2Action = parseMemoryV2Action(payload);
	if (v2Action) {
		if (v2Action.kind === "profile_item" && v2Action.action === "correct") {
			return applyProfileItemCorrect(userId, v2Action);
		}
		if (v2Action.kind === "profile_item" && v2Action.action === "retire") {
			return applyProfileItemRetire(userId, v2Action);
		}
		if (v2Action.kind === "summary") {
			return applySummaryEdit(userId, v2Action);
		}
		return applyConsolidationUndo(userId, v2Action);
	}

	const action = parseMemoryProfileAction(payload);
	if (action.target === "review_item") {
		const reviewResult = await applyMemoryReviewItemWithRevision({
			userId,
			reviewItemId: action.itemId,
			expectedProjectionRevision: action.expectedProjectionRevision,
			action:
				action.action === "suppress"
					? "dismiss"
					: action.action === "accept"
						? "accept"
						: "edit",
			...(action.action === "edit" ? { statement: action.statement } : {}),
		});

		if (reviewResult.status !== "updated") {
			await recordReviewActionTelemetry({
				userId,
				action: action.action,
				reviewItemId: action.itemId,
				status: reviewResult.status,
			});
			await recordProfileActionTelemetry({
				userId,
				action: action.action,
				itemId: action.itemId,
				status: reviewResult.status,
				target: "review_item",
			});
			if (reviewResult.status === "stale_projection") {
				throw new MemoryProfileActionError(
					"stale_projection",
					"Memory profile changed before this action was applied.",
					409,
				);
			}
			throw new MemoryProfileActionError(
				"not_found",
				"Memory review item was not found.",
				404,
			);
		}

		await markProfileActionReconciliation({
			userId,
			action: action.action,
			itemId: reviewResult.itemId,
			reviewItemId: action.itemId,
		});
		await recordReviewActionTelemetry({
			userId,
			action: action.action,
			reviewItemId: action.itemId,
			itemId: reviewResult.itemId,
			category: reviewResult.category,
			status: "updated",
		});
		await recordProfileActionTelemetry({
			userId,
			action: action.action,
			itemId: reviewResult.itemId ?? action.itemId,
			status: "updated",
			target: "review_item",
		});

		return serializeMemoryProfileReadModel(
			await getMemoryProfileReadModel({ userId }),
		);
	}

	const patch: {
		statement?: string;
		status?: MemoryProfileItemStatus;
	} =
		action.action === "edit"
			? { statement: action.statement }
			: { status: action.action === "delete" ? "deleted" : "suppressed" };
	const result = await updateMemoryProfileItemWithRevision({
		userId,
		itemId: action.itemId,
		expectedProjectionRevision: action.expectedProjectionRevision,
		patch,
	});

	if (result.status !== "updated") {
		await recordProfileActionTelemetry({
			userId,
			action: action.action,
			itemId: action.itemId,
			status: result.status,
		});
		if (result.status === "stale_projection") {
			throw new MemoryProfileActionError(
				"stale_projection",
				"Memory profile changed before this action was applied.",
				409,
			);
		}
		throw new MemoryProfileActionError(
			"not_found",
			"Memory profile item was not found.",
			404,
		);
	}

	await markProfileActionReconciliation({
		userId,
		action: action.action,
		itemId: action.itemId,
	});
	await recordProfileActionTelemetry({
		userId,
		action: action.action,
		itemId: action.itemId,
		status: "updated",
	});

	return serializeMemoryProfileReadModel(
		await getMemoryProfileReadModel({ userId }),
	);
}
