import { inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import { memoryProfileItems } from "$lib/server/db/schema";
import type {
	KnowledgeMemoryOverviewPayload,
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
	getPersonaSummary,
	type PersonaSummary,
} from "./memory-consolidation/summary";
import { markMemoryDirty } from "./memory-profile/dirty-ledger";
import {
	getMemoryProfileItemDetail,
	getMemoryProfileReadModel,
} from "./memory-profile/read-model";
import type {
	MemoryDirtyReason,
	MemoryProfileCardItem,
	MemoryProfileItemDetail,
	MemoryProfileReadModel,
	MemoryProfileScope,
} from "./memory-profile/types";

// Serialize helpers for the Knowledge Memory read surface. Exported so the
// action-dispatch surface (knowledge-memory-actions.ts) can return the same
// serialized payloads after a mutation without re-deriving them.
export function serializeMemoryProfileItem(
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

export function serializeMemoryProfileReadModel(
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

	queueMemoryReadMaintenance(userId, source);
	return profile;
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
	const { isUserMemoryEnabled } = await import("./memory-controls");
	const { listPendingMemoryDirtyEntries } = await import(
		"./memory-profile/dirty-ledger"
	);
	const [memoryEnabled, pending] = await Promise.all([
		isUserMemoryEnabled(userId),
		listPendingMemoryDirtyEntries({ userId }).catch(() => []),
	]);
	// The "updating your memory" notice must reflect genuine learning/consolidation
	// of the user's content — NOT internal bookkeeping. In particular
	// `stale_projection` is marked on every profile read (markStaleProjectionRead
	// above), so counting it would make merely opening this page announce that
	// memory is updating. Restrict the signal to reasons that mean new content is
	// being ingested or reconciled.
	const processingReasons = new Set<MemoryDirtyReason>([
		"deferred_intake",
		"possible_conflict",
		"possible_duplicate",
	]);
	const activeWork = pending.filter((entry) =>
		processingReasons.has(entry.reason),
	);
	return {
		summary: buildCompatibilitySummary(profile),
		profile,
		memoryEnabled,
		processing: {
			active: activeWork.length > 0,
			pendingCount: activeWork.length,
			operations: summarizeMemoryDirtyOperations(pending),
		},
	};
}

// Reasons that represent genuine, user-relevant memory work worth naming in
// the friendly "updating your memory" list. Deliberately excludes:
//  - `stale_projection`, which markStaleProjectionRead marks on every read of
//    this very function — surfacing it would make simply opening the page
//    announce a fake in-progress operation.
//  - `legacy_migration`, which is internal one-time bookkeeping, not
//    user-facing content work.
const OPERATION_REASONS = new Set<MemoryDirtyReason>([
	"deferred_intake",
	"possible_conflict",
	"possible_duplicate",
	"projection_reconciliation",
	"review_generation",
	"profile_action_reconciliation",
]);

function memoryDirtyScopeKey(scope: MemoryProfileScope): string {
	return scope.type === "global" ? "global" : `${scope.type}:${scope.id}`;
}

// Groups privacy-safe dirty-ledger metadata (reason + scope + count) for the
// "updating your memory" notice. Never touches `entry.metadata` or any raw
// fact/subject text — only the reason, scope, and count are privacy-safe to
// expose to the client (per assertPrivacySafeMetadata's design).
function summarizeMemoryDirtyOperations(
	pending: Array<{
		reason: MemoryDirtyReason;
		count: number;
		scope: MemoryProfileScope;
	}>,
): Array<{
	reason: MemoryDirtyReason;
	scope: MemoryProfileScope;
	count: number;
}> {
	const grouped = new Map<
		string,
		{ reason: MemoryDirtyReason; scope: MemoryProfileScope; count: number }
	>();
	for (const entry of pending) {
		if (!OPERATION_REASONS.has(entry.reason)) continue;
		const key = `${entry.reason}:${memoryDirtyScopeKey(entry.scope)}`;
		const existing = grouped.get(key);
		if (existing) {
			existing.count += entry.count;
		} else {
			grouped.set(key, {
				reason: entry.reason,
				scope: entry.scope,
				count: entry.count,
			});
		}
	}
	return Array.from(grouped.values());
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

export function serializePersonaSummary(
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
	statementById: Map<string, string>,
): KnowledgeMemoryTimelinePayload["reports"][number] {
	return {
		id: report.id,
		status: report.status,
		summaryText: report.summaryText,
		createdAt: report.createdAt.toISOString(),
		// Resolve each action's target (resultItemId) to its current statement so
		// the UI can name what a fact was superseded/merged into, instead of just
		// an opaque id. Dropped silently if the target no longer exists.
		actions: report.actions.map((action) => {
			const resultStatement = action.resultItemId
				? statementById.get(action.resultItemId)
				: undefined;
			return resultStatement ? { ...action, resultStatement } : action;
		}),
	};
}

// Batch-resolve the current statements for every resultItemId referenced across
// a set of consolidation reports, in a single query.
async function resolveResultStatements(
	reports: MemoryConsolidationReport[],
): Promise<Map<string, string>> {
	const ids = new Set<string>();
	for (const report of reports) {
		for (const action of report.actions) {
			if (action.resultItemId) ids.add(action.resultItemId);
		}
	}
	if (ids.size === 0) return new Map();
	const rows = await db
		.select({
			id: memoryProfileItems.id,
			statement: memoryProfileItems.statement,
		})
		.from(memoryProfileItems)
		.where(inArray(memoryProfileItems.id, [...ids]));
	return new Map(rows.map((row) => [row.id, row.statement]));
}

// The consolidation timeline surfaces only recent activity — see spec: "While
// you were away" shows what changed lately, not the full history.
const TIMELINE_WINDOW_DAYS = 7;
const TIMELINE_WINDOW_MS = TIMELINE_WINDOW_DAYS * 86_400_000;

export async function getKnowledgeMemorySummary(
	userId: string,
): Promise<KnowledgeMemorySummaryPayload> {
	const summary = await getPersonaSummary({ userId });
	return { summary: serializePersonaSummary(summary) };
}

export async function listKnowledgeMemoryTimeline(
	userId: string,
): Promise<KnowledgeMemoryTimelinePayload> {
	const reports = await listMemoryConsolidationReports({
		userId,
		limit: 20,
		since: new Date(Date.now() - TIMELINE_WINDOW_MS),
	});
	const statementById = await resolveResultStatements(reports);
	return {
		reports: reports.map((report) =>
			serializeConsolidationReport(report, statementById),
		),
	};
}
