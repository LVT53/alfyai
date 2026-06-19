import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	memoryProfileItemProvenance,
	memoryProfileItems,
	memoryReviewItems,
} from "$lib/server/db/schema";
import { parseJsonRecord, readSafeString } from "./internal-json";
import { bumpProjectionRevision } from "./projection-store";
import {
	getCurrentMemoryResetGeneration,
	isCurrentMemoryResetGeneration,
} from "./reset-generation";
import {
	createOrUpdateMemoryReviewItem,
	legacyReviewSubjectKey,
} from "./review";
import {
	resolveMemoryProfileItemKey,
	stableMemoryMaintenanceDigest,
} from "./scope";
import { recordMemoryReworkTelemetry } from "./telemetry";
import {
	assertMemoryProfileCategory,
	MEMORY_PROFILE_CATEGORIES,
	type MemoryProfileCategory,
	type MemoryProfileScope,
	readMemoryProfileCategory,
} from "./types";

const DEFAULT_LEGACY_CURATION_BATCH_SIZE = 25;
const MAX_LEGACY_CURATION_BATCH_SIZE = 40;
const MAX_LEGACY_CURATION_NEW_REVIEWS_PER_SLICE = 3;
const MAX_OPEN_MEMORY_REVIEWS_PER_USER = 12;

type PreservedLegacyMemoryRow = typeof memoryProfileItems.$inferSelect & {
	category: MemoryProfileCategory;
};

export type LegacyMemoryCurationInputItem = {
	id: string;
	statement: string;
	category: MemoryProfileCategory;
};

export type LegacyMemoryCurationDecision =
	| {
			id: string;
			decision: "activate";
			category: MemoryProfileCategory;
			statement: string;
	  }
	| {
			id: string;
			decision: "review";
			category: MemoryProfileCategory;
			statement: string;
			reason?: string;
	  }
	| { id: string; decision: "reject"; reason?: string };

export type LegacyMemoryCurator = (
	items: LegacyMemoryCurationInputItem[],
) => Promise<LegacyMemoryCurationDecision[]>;

export type LegacyMemoryCurationResult = {
	status: "completed" | "stale_generation";
	inspected: number;
	active: number;
	review: number;
	rejected: number;
	remainingPreserved: number;
};

function sanitizeLegacyCurationStatement(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const statement = value.trim().replace(/\s+/g, " ");
	return statement.length >= 4 && statement.length <= 260 ? statement : null;
}

function normalizeLegacyCurationDecision(
	value: unknown,
): LegacyMemoryCurationDecision | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const id = readSafeString(record.id);
	const decision = readSafeString(record.decision);
	if (!id || !decision) return null;

	if (decision === "reject") {
		return {
			id,
			decision,
			...(readSafeString(record.reason)
				? { reason: readSafeString(record.reason) ?? undefined }
				: {}),
		};
	}

	if (decision !== "activate" && decision !== "review") return null;
	const category = readMemoryProfileCategory(record.category);
	const statement = sanitizeLegacyCurationStatement(record.statement);
	if (!category || !statement) return null;

	return {
		id,
		decision,
		category,
		statement,
		...(decision === "review" && readSafeString(record.reason)
			? { reason: readSafeString(record.reason) ?? undefined }
			: {}),
	};
}

function parseLegacyCurationResponse(
	text: string,
): LegacyMemoryCurationDecision[] {
	const parsed = JSON.parse(text) as unknown;
	const record =
		parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	const decisions = Array.isArray(record.decisions) ? record.decisions : [];
	return decisions
		.map(normalizeLegacyCurationDecision)
		.filter((decision): decision is LegacyMemoryCurationDecision =>
			Boolean(decision),
		);
}

async function defaultLegacyMemoryCurator(
	items: LegacyMemoryCurationInputItem[],
): Promise<LegacyMemoryCurationDecision[]> {
	if (items.length === 0) return [];
	const controlModelModule = "../normal-chat-control-model";
	const { sendJsonControlMessage } = await import(controlModelModule);
	const response = await sendJsonControlMessage(
		JSON.stringify({ items }),
		getConfig().memoryLegacyCurationModel,
		{
			systemPrompt: [
				"You curate preserved legacy memory candidates for a user's long-term memory profile.",
				"Return one decision per input id.",
				"Use activate only for stable, user-relevant facts or preferences that should be used immediately.",
				"Use review when the memory may be valuable but is uncertain, ambiguous, contradictory, document-derived, or needs user confirmation.",
				"Use reject for transient chat details, assistant prose, one-off tasks, stale facts, generic observations, document contents that are not explicitly about the user, or junk.",
				"Rewrite activated or reviewed statements as concise third-person memory profile facts.",
				"Do not include raw source text outside the statement field.",
			].join("\n"),
			thinkingMode: "on",
			maxTokens: 1800,
			temperature: 0,
			jsonSchema: {
				name: "legacy_memory_curation",
				strict: true,
				schema: {
					type: "object",
					additionalProperties: false,
					required: ["decisions"],
					properties: {
						decisions: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								required: ["id", "decision", "category", "statement", "reason"],
								properties: {
									id: { type: "string" },
									decision: {
										type: "string",
										enum: ["activate", "review", "reject"],
									},
									category: {
										type: "string",
										enum: [...MEMORY_PROFILE_CATEGORIES],
									},
									statement: { type: "string" },
									reason: { type: "string" },
								},
							},
						},
					},
				},
			},
			allowReasoningFallback: true,
		},
	);

	return parseLegacyCurationResponse(response.text);
}

function fallbackReviewDecision(
	row: PreservedLegacyMemoryRow,
): LegacyMemoryCurationDecision {
	return {
		id: row.id,
		decision: "review",
		category: row.category,
		statement: row.statement,
		reason: "Needs user confirmation before becoming active memory.",
	};
}

async function loadPreservedLegacyMemoryRows(params: {
	userId: string;
	resetGeneration: number;
	limit: number;
}): Promise<PreservedLegacyMemoryRow[]> {
	const rows = await db
		.select()
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
				eq(memoryProfileItems.status, "preserved_legacy"),
			),
		)
		.orderBy(asc(memoryProfileItems.createdAt))
		.limit(params.limit);
	return rows.map((row) => {
		assertMemoryProfileCategory(row.category);
		return { ...row, category: row.category };
	});
}

async function countPreservedLegacyMemoryRows(params: {
	userId: string;
	resetGeneration: number;
}): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(*)` })
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
				eq(memoryProfileItems.status, "preserved_legacy"),
			),
		)
		.limit(1);
	return Number(row?.count ?? 0);
}

async function countOpenMemoryReviewRows(params: {
	userId: string;
	resetGeneration: number;
}): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(*)` })
		.from(memoryReviewItems)
		.where(
			and(
				eq(memoryReviewItems.userId, params.userId),
				eq(memoryReviewItems.resetGeneration, params.resetGeneration),
				eq(memoryReviewItems.status, "open"),
			),
		)
		.limit(1);
	return Number(row?.count ?? 0);
}

function legacyCurationMetadata(params: {
	row: PreservedLegacyMemoryRow;
	decision: LegacyMemoryCurationDecision;
}): string {
	return JSON.stringify({
		...parseJsonRecord(params.row.metadataJson),
		source: "legacy_memory_curation",
		legacyCurationDecision: params.decision.decision,
		legacyCurationReason:
			"reason" in params.decision ? params.decision.reason : undefined,
		curatedAt: new Date().toISOString(),
	});
}

function applyActivateLegacyCurationDecision(params: {
	userId: string;
	resetGeneration: number;
	row: PreservedLegacyMemoryRow;
	decision: Extract<LegacyMemoryCurationDecision, { decision: "activate" }>;
	now: Date;
}): "active" | "rejected" | "skipped" {
	const scope: MemoryProfileScope = { type: "global" };
	const itemKey = resolveMemoryProfileItemKey({
		category: params.decision.category,
		scope,
		statement: params.decision.statement,
	});
	const [duplicate] = db
		.select({ id: memoryProfileItems.id })
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

	const nextStatus =
		duplicate && duplicate.id !== params.row.id ? "inactive" : "active";
	const result = db
		.update(memoryProfileItems)
		.set({
			itemKey: nextStatus === "active" ? itemKey : params.row.itemKey,
			category:
				nextStatus === "active"
					? params.decision.category
					: params.row.category,
			statement:
				nextStatus === "active"
					? params.decision.statement
					: params.row.statement,
			status: nextStatus,
			revision: sql`${memoryProfileItems.revision} + 1`,
			metadataJson: legacyCurationMetadata(params),
			updatedAt: params.now,
		})
		.where(
			and(
				eq(memoryProfileItems.id, params.row.id),
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
				eq(memoryProfileItems.status, "preserved_legacy"),
			),
		)
		.run() as { changes?: number };
	if ((result.changes ?? 0) !== 1) return "skipped";

	if (nextStatus !== "active") return "rejected";
	db.insert(memoryProfileItemProvenance)
		.values({
			id: randomUUID(),
			itemId: params.row.id,
			userId: params.userId,
			resetGeneration: params.resetGeneration,
			sourceType: "legacy_memory_curation",
			sourceId: params.row.id,
			label: "Legacy memory",
			summary: "Curated from preserved legacy memory.",
			metadataJson: JSON.stringify({
				source: "legacy_memory_curation",
				legacyItemToken: stableMemoryMaintenanceDigest(params.row.id),
			}),
			createdAt: params.now,
		})
		.run();
	return "active";
}

async function applyReviewLegacyCurationDecision(params: {
	userId: string;
	resetGeneration: number;
	row: PreservedLegacyMemoryRow;
	decision: Extract<LegacyMemoryCurationDecision, { decision: "review" }>;
	now: Date;
}): Promise<"review" | "skipped"> {
	const result = (await db
		.update(memoryProfileItems)
		.set({
			status: "review_needed",
			revision: sql`${memoryProfileItems.revision} + 1`,
			metadataJson: legacyCurationMetadata(params),
			updatedAt: params.now,
		})
		.where(
			and(
				eq(memoryProfileItems.id, params.row.id),
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
				eq(memoryProfileItems.status, "preserved_legacy"),
			),
		)
		.run()) as { changes?: number };
	if ((result.changes ?? 0) !== 1) return "skipped";

	await createOrUpdateMemoryReviewItem({
		userId: params.userId,
		subjectKey: legacyReviewSubjectKey({
			category: params.decision.category,
			statement: params.decision.statement,
		}),
		subjectLabel: params.decision.statement,
		question: "Should AlfyAI remember this?",
		reason:
			params.decision.reason ??
			"Legacy memory needs confirmation before becoming active.",
		affectedItemIds: [params.row.id],
		evidence: [
			{
				sourceType: "legacy_memory_curation",
				legacyItemToken: stableMemoryMaintenanceDigest(params.row.id),
			},
		],
		metadata: {
			source: "legacy_memory_curation",
			category: params.decision.category,
			proposedStatement: params.decision.statement,
			legacyItemToken: stableMemoryMaintenanceDigest(params.row.id),
		},
		expectedResetGeneration: params.resetGeneration,
	});
	return "review";
}

function applyRejectLegacyCurationDecision(params: {
	userId: string;
	resetGeneration: number;
	row: PreservedLegacyMemoryRow;
	decision: Extract<LegacyMemoryCurationDecision, { decision: "reject" }>;
	now: Date;
}): "rejected" | "skipped" {
	const result = db
		.update(memoryProfileItems)
		.set({
			status: "inactive",
			revision: sql`${memoryProfileItems.revision} + 1`,
			metadataJson: legacyCurationMetadata(params),
			updatedAt: params.now,
		})
		.where(
			and(
				eq(memoryProfileItems.id, params.row.id),
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
				eq(memoryProfileItems.status, "preserved_legacy"),
			),
		)
		.run() as { changes?: number };
	return (result.changes ?? 0) === 1 ? "rejected" : "skipped";
}

async function applyLegacyCurationDecision(params: {
	userId: string;
	resetGeneration: number;
	row: PreservedLegacyMemoryRow;
	decision: LegacyMemoryCurationDecision;
	now: Date;
}): Promise<"active" | "review" | "rejected" | "skipped"> {
	if (params.decision.decision === "activate") {
		return applyActivateLegacyCurationDecision({
			userId: params.userId,
			resetGeneration: params.resetGeneration,
			row: params.row,
			decision: params.decision,
			now: params.now,
		});
	}
	if (params.decision.decision === "review") {
		return applyReviewLegacyCurationDecision({
			userId: params.userId,
			resetGeneration: params.resetGeneration,
			row: params.row,
			decision: params.decision,
			now: params.now,
		});
	}
	return applyRejectLegacyCurationDecision({
		userId: params.userId,
		resetGeneration: params.resetGeneration,
		row: params.row,
		decision: params.decision,
		now: params.now,
	});
}

export async function curatePreservedLegacyMemoryForUser(params: {
	userId: string;
	batchSize?: number;
	startedResetGeneration?: number;
	curateBatch?: LegacyMemoryCurator;
}): Promise<LegacyMemoryCurationResult> {
	const batchSize = Math.max(
		0,
		Math.min(
			MAX_LEGACY_CURATION_BATCH_SIZE,
			Math.floor(params.batchSize ?? DEFAULT_LEGACY_CURATION_BATCH_SIZE),
		),
	);
	const resetGeneration =
		params.startedResetGeneration ??
		(await getCurrentMemoryResetGeneration(params.userId));
	if (
		!(await isCurrentMemoryResetGeneration({
			userId: params.userId,
			resetGeneration,
		}))
	) {
		return {
			status: "stale_generation",
			inspected: 0,
			active: 0,
			review: 0,
			rejected: 0,
			remainingPreserved: 0,
		};
	}

	const rows =
		batchSize > 0
			? await loadPreservedLegacyMemoryRows({
					userId: params.userId,
					resetGeneration,
					limit: batchSize,
				})
			: [];
	if (rows.length === 0) {
		return {
			status: "completed",
			inspected: 0,
			active: 0,
			review: 0,
			rejected: 0,
			remainingPreserved: await countPreservedLegacyMemoryRows({
				userId: params.userId,
				resetGeneration,
			}),
		};
	}

	const curator = params.curateBatch ?? defaultLegacyMemoryCurator;
	let decisions: LegacyMemoryCurationDecision[];
	try {
		decisions = await curator(
			rows.map((row) => ({
				id: row.id,
				statement: row.statement,
				category: row.category,
			})),
		);
	} catch {
		decisions = rows.map(fallbackReviewDecision);
	}
	if (
		!(await isCurrentMemoryResetGeneration({
			userId: params.userId,
			resetGeneration,
		}))
	) {
		return {
			status: "stale_generation",
			inspected: rows.length,
			active: 0,
			review: 0,
			rejected: 0,
			remainingPreserved: 0,
		};
	}
	const decisionMap = new Map(
		decisions
			.map(normalizeLegacyCurationDecision)
			.filter((decision): decision is LegacyMemoryCurationDecision =>
				Boolean(decision),
			)
			.map((decision) => [decision.id, decision] as const),
	);

	let active = 0;
	let review = 0;
	let rejected = 0;
	let changed = 0;
	const openReviews = await countOpenMemoryReviewRows({
		userId: params.userId,
		resetGeneration,
	});
	let remainingReviewSlots = Math.max(
		0,
		Math.min(
			MAX_LEGACY_CURATION_NEW_REVIEWS_PER_SLICE,
			MAX_OPEN_MEMORY_REVIEWS_PER_USER - openReviews,
		),
	);
	const now = new Date();
	for (const row of rows) {
		const decision = decisionMap.get(row.id) ?? fallbackReviewDecision(row);
		if (decision.decision === "review" && remainingReviewSlots <= 0) {
			continue;
		}
		const applied = await applyLegacyCurationDecision({
			userId: params.userId,
			resetGeneration,
			row,
			decision,
			now,
		});
		if (applied === "active") active += 1;
		if (applied === "review") {
			review += 1;
			remainingReviewSlots -= 1;
		}
		if (applied === "rejected") rejected += 1;
		if (applied !== "skipped") changed += 1;
	}

	if (changed > 0) {
		bumpProjectionRevision({
			projectionStateId: rows[0].projectionStateId,
			amount: changed,
			now,
		});
	}
	const remainingPreserved = await countPreservedLegacyMemoryRows({
		userId: params.userId,
		resetGeneration,
	});
	await recordMemoryReworkTelemetry({
		userId: params.userId,
		eventFamily: "maintenance",
		eventName: "legacy_curation_completed",
		reason: "legacy_migration",
		status: "completed",
		count: rows.length,
		metadata: {
			inspectedCount: rows.length,
			activeCount: active,
			reviewCount: review,
			rejectedCount: rejected,
			remainingPreserved,
			requestedLimit: batchSize,
		},
		expectedResetGeneration: resetGeneration,
	});

	return {
		status: "completed",
		inspected: rows.length,
		active,
		review,
		rejected,
		remainingPreserved,
	};
}
