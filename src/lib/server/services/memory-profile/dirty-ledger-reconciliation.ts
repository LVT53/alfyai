import { and, asc, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { memoryProfileItems } from "$lib/server/db/schema";
import { getActiveMemoryProfileContext } from "./active-context";
import {
	type ClaimedDirtyLedgerRow,
	claimNextMemoryDirtyLedgerRow,
	completeClaimedMemoryDirtyLedgerRow,
	markMemoryDirty,
	reclaimStaleClaimedMemoryDirtyLedgerRows,
	requeueClaimedMemoryDirtyLedgerRow,
} from "./dirty-ledger";
import {
	parseJsonRecord,
	readSafePositiveInteger,
	readSafeString,
	readSafeStringArray,
} from "./internal-json";
import {
	type LegacyPersonaMemoryCandidateBatch,
	migrateLegacyMemoryForUser,
} from "./legacy";
import {
	curatePreservedLegacyMemoryForUser,
	type LegacyMemoryCurator,
} from "./legacy-curation";
import { getCurrentMemoryResetGeneration } from "./reset-generation";
import { createOrUpdateMemoryReviewItem } from "./review";
import {
	normalizeRememberedStatement,
	stableMemoryMaintenanceDigest,
} from "./scope";
import { recordMemoryReworkTelemetry } from "./telemetry";
import {
	assertMemoryProfileCategory,
	assertOneOf,
	isOneOf,
	type JsonRecord,
	type LegacyMemoryCandidateLoader,
	MEMORY_DIRTY_REASONS,
	type MemoryDirtyLedgerReconciliationResult,
} from "./types";

const DEFAULT_MEMORY_DIRTY_LEDGER_BATCH_SIZE = 25;
const DEFAULT_MEMORY_DIRTY_LEDGER_MAX_RUNTIME_MS = 1500;
const DEFAULT_MEMORY_DIRTY_LEDGER_STALE_CLAIM_MS = 5 * 60 * 1000;
const LEGACY_DIRTY_LEDGER_CANDIDATE_LIMIT = 5;
const LEGACY_DIRTY_LEDGER_MAX_PAGES = 4;

function telemetrySubjectIdForDirtyMetadata(
	metadata: JsonRecord,
): string | null {
	return (
		readSafeString(metadata.reviewItemId) ??
		readSafeString(metadata.subjectId) ??
		readSafeString(metadata.subjectKey) ??
		readSafeString(metadata.itemId) ??
		readSafeString(metadata.projectionStateId)
	);
}

async function handleClaimedMemoryDirtyLedgerRow(params: {
	userId: string;
	row: ClaimedDirtyLedgerRow;
	loadLegacyMemoryCandidates?: LegacyMemoryCandidateLoader;
	curatePreservedLegacyMemory?: LegacyMemoryCurator;
}): Promise<void> {
	assertOneOf(params.row.reason, MEMORY_DIRTY_REASONS, "memory dirty reason");
	const metadata = parseJsonRecord(params.row.reasonMetadataJson);
	if (
		params.row.reason === "possible_duplicate" ||
		params.row.reason === "review_generation"
	) {
		const reviewCount = await createExactDuplicateMemoryReviews({
			userId: params.userId,
			resetGeneration: params.row.resetGeneration,
			ledgerEntryId: params.row.id,
		});
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "maintenance",
			eventName:
				reviewCount > 0
					? "dirty_ledger_duplicate_review_created"
					: "dirty_ledger_acknowledged",
			reason: params.row.reason,
			status: "completed",
			count: reviewCount,
			subjectId: telemetrySubjectIdForDirtyMetadata(metadata) ?? undefined,
			metadata: {
				ledgerEntryId: params.row.id,
				scopeType: params.row.scopeType,
				scopeId: params.row.scopeId,
				reviewCount,
			},
			expectedResetGeneration: params.row.resetGeneration,
		});
		return;
	}
	if (params.row.reason === "possible_conflict") {
		const subjectId = readSafeString(metadata.subjectId);
		const subjectKey = readSafeString(metadata.subjectKey);
		const deterministicSubject = subjectId ?? subjectKey;
		if (deterministicSubject) {
			await createOrUpdateMemoryReviewItem({
				userId: params.userId,
				subjectKey: `memory-profile:conflict:${stableMemoryMaintenanceDigest(deterministicSubject)}`,
				subjectLabel: "Memory profile conflict",
				question: "Which memory profile value should AlfyAI keep?",
				reason: "Maintenance found a deterministic conflict marker.",
				affectedItemIds: subjectId ? [subjectId] : [],
				evidence: [
					{
						sourceType: "memory_dirty_ledger",
						ledgerEntryId: params.row.id,
					},
				],
				metadata: {
					source: "dirty_ledger_reconciliation",
					subjectKind: subjectId ? "subjectId" : "subjectKey",
					subjectToken: stableMemoryMaintenanceDigest(deterministicSubject),
				},
				expectedResetGeneration: params.row.resetGeneration,
			});
			await recordMemoryReworkTelemetry({
				userId: params.userId,
				eventFamily: "maintenance",
				eventName: "dirty_ledger_conflict_review_created",
				reason: params.row.reason,
				status: "completed",
				count: params.row.count,
				subjectId: deterministicSubject,
				metadata: {
					ledgerEntryId: params.row.id,
					scopeType: params.row.scopeType,
					scopeId: params.row.scopeId,
				},
				expectedResetGeneration: params.row.resetGeneration,
			});
			return;
		}
	}
	if (params.row.reason === "profile_action_reconciliation") {
		await verifyProfileActionReadModelExclusion({
			userId: params.userId,
			resetGeneration: params.row.resetGeneration,
			ledgerEntryId: params.row.id,
		});
		return;
	}
	if (
		params.row.reason === "projection_reconciliation" ||
		params.row.reason === "honcho_reconciliation"
	) {
		const action = readSafeString(metadata.action);
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "maintenance",
			eventName:
				params.row.reason === "honcho_reconciliation"
					? "dirty_ledger_honcho_reconciliation_projection_only"
					: "dirty_ledger_projection_reconciliation_completed",
			reason: params.row.reason,
			status: "completed",
			count: params.row.count,
			subjectId: telemetrySubjectIdForDirtyMetadata(metadata) ?? undefined,
			metadata: {
				ledgerEntryId: params.row.id,
				scopeType: params.row.scopeType,
				scopeId: params.row.scopeId,
				...(action ? { action } : {}),
			},
			expectedResetGeneration: params.row.resetGeneration,
		});
		return;
	}
	if (params.row.reason === "legacy_migration") {
		const excludedSourceIds = readSafeStringArray(
			metadata.legacyExcludedSourceIds,
		);
		const legacyStartPage =
			readSafePositiveInteger(metadata.legacyNextPage) ?? 1;
		let legacyBatch: LegacyPersonaMemoryCandidateBatch | undefined;
		if (params.loadLegacyMemoryCandidates) {
			legacyBatch = await params.loadLegacyMemoryCandidates(params.userId, {
				limit: LEGACY_DIRTY_LEDGER_CANDIDATE_LIMIT,
				excludeSourceIds: excludedSourceIds,
				startPage: legacyStartPage,
				maxPages: LEGACY_DIRTY_LEDGER_MAX_PAGES,
			});
		}
		const migration = await migrateLegacyMemoryForUser({
			userId: params.userId,
			batchSize: LEGACY_DIRTY_LEDGER_CANDIDATE_LIMIT,
			legacyBatch,
			startedResetGeneration: params.row.resetGeneration,
		});
		if (migration.status === "unavailable") {
			await recordMemoryReworkTelemetry({
				userId: params.userId,
				eventFamily: "maintenance",
				eventName: "legacy_migration_unavailable",
				reason: params.row.reason,
				status: "skipped",
				count: params.row.count,
				metadata: {
					ledgerEntryId: params.row.id,
					scopeType: params.row.scopeType,
					scopeId: params.row.scopeId,
				},
				expectedResetGeneration: params.row.resetGeneration,
			});
		}
		const inspectedSourceIds = readSafeStringArray(
			legacyBatch?.candidates.map((candidate) => candidate.id),
		);
		const nextExcludedSourceIds = Array.from(
			new Set([...excludedSourceIds, ...inspectedSourceIds]),
		);
		if (
			migration.status === "completed" &&
			legacyBatch?.exhausted === false &&
			legacyBatch.nextPage
		) {
			await markMemoryDirty({
				userId: params.userId,
				reason: "legacy_migration",
				metadata: {
					legacyCandidateEstimate: migration.totalAvailable,
					legacyExcludedSourceIds: nextExcludedSourceIds.slice(-25),
					legacyNextPage: legacyBatch.nextPage,
				},
				expectedResetGeneration: params.row.resetGeneration,
			});
		}
		if (migration.status === "completed") {
			await curatePreservedLegacyMemoryForUser({
				userId: params.userId,
				startedResetGeneration: params.row.resetGeneration,
				curateBatch: params.curatePreservedLegacyMemory,
			});
		}
		return;
	}

	await recordMemoryReworkTelemetry({
		userId: params.userId,
		eventFamily: "maintenance",
		eventName: "dirty_ledger_acknowledged",
		reason: params.row.reason,
		status: "completed",
		count: params.row.count,
		subjectId: telemetrySubjectIdForDirtyMetadata(metadata) ?? undefined,
		metadata: {
			ledgerEntryId: params.row.id,
			scopeType: params.row.scopeType,
			scopeId: params.row.scopeId,
			dirtyCount: params.row.count,
		},
		expectedResetGeneration: params.row.resetGeneration,
	});
}

async function verifyProfileActionReadModelExclusion(params: {
	userId: string;
	resetGeneration: number;
	ledgerEntryId: string;
}): Promise<void> {
	const activeContext = await getActiveMemoryProfileContext({
		userId: params.userId,
	});
	const rows = await db
		.select({
			id: memoryProfileItems.id,
			status: memoryProfileItems.status,
		})
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
			),
		);
	const nonActiveIds = new Set(
		rows.filter((row) => row.status !== "active").map((row) => row.id),
	);
	const leakedIds = activeContext.items
		.map((item) => item.id)
		.filter((id) => nonActiveIds.has(id));

	await recordMemoryReworkTelemetry({
		userId: params.userId,
		eventFamily: "maintenance",
		eventName:
			leakedIds.length > 0
				? "dirty_ledger_profile_action_issue_found"
				: "dirty_ledger_profile_action_read_model_verified",
		reason: "profile_action_reconciliation",
		status: leakedIds.length > 0 ? "issue_found" : "completed",
		count: leakedIds.length,
		metadata: {
			ledgerEntryId: params.ledgerEntryId,
			activeContextCount: activeContext.items.length,
			nonActiveProfileItemCount: nonActiveIds.size,
			...(leakedIds.length > 0 ? { affectedItemIds: leakedIds } : {}),
		},
		expectedResetGeneration: params.resetGeneration,
	});
}

async function createExactDuplicateMemoryReviews(params: {
	userId: string;
	resetGeneration: number;
	ledgerEntryId: string;
}): Promise<number> {
	const rows = await db
		.select()
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
				eq(memoryProfileItems.status, "active"),
			),
		)
		.orderBy(asc(memoryProfileItems.updatedAt));

	const groups = new Map<string, typeof rows>();
	for (const row of rows) {
		assertMemoryProfileCategory(row.category);
		const key = [
			row.category,
			row.scopeType,
			row.scopeId,
			normalizeRememberedStatement(row.statement),
		].join("\u001f");
		const group = groups.get(key);
		if (group) {
			group.push(row);
		} else {
			groups.set(key, [row]);
		}
	}

	let reviewCount = 0;
	for (const [key, group] of groups.entries()) {
		if (group.length < 2) continue;
		const [category, scopeType, scopeId] = key.split("\u001f");
		assertMemoryProfileCategory(category);
		const affectedItemIds = group.map((row) => row.id).sort();
		await createOrUpdateMemoryReviewItem({
			userId: params.userId,
			subjectKey: `memory-profile:exact-duplicate:${stableMemoryMaintenanceDigest(key)}`,
			subjectLabel: "Duplicate memory profile items",
			question: "Which duplicate memory profile item should remain active?",
			reason: "Maintenance found exact active duplicate memory profile items.",
			affectedItemIds,
			evidence: [
				{
					sourceType: "memory_dirty_ledger",
					ledgerEntryId: params.ledgerEntryId,
					affectedItemIds,
				},
			],
			metadata: {
				category,
				scopeType,
				scopeId: scopeId ?? "",
				duplicateCount: group.length,
				source: "dirty_ledger_reconciliation",
			},
			expectedResetGeneration: params.resetGeneration,
		});
		reviewCount += 1;
	}

	return reviewCount;
}

export async function reconcileMemoryProfileDirtyLedgerForUser(params: {
	userId: string;
	batchSize?: number;
	maxRuntimeMs?: number;
	staleClaimMs?: number;
	loadLegacyMemoryCandidates?: LegacyMemoryCandidateLoader;
	curatePreservedLegacyMemory?: LegacyMemoryCurator;
}): Promise<MemoryDirtyLedgerReconciliationResult> {
	const batchSize = Math.max(
		0,
		Math.floor(params.batchSize ?? DEFAULT_MEMORY_DIRTY_LEDGER_BATCH_SIZE),
	);
	const maxRuntimeMs = Math.max(
		1,
		Math.floor(
			params.maxRuntimeMs ?? DEFAULT_MEMORY_DIRTY_LEDGER_MAX_RUNTIME_MS,
		),
	);
	const startedAt = Date.now();
	const resetGeneration = await getCurrentMemoryResetGeneration(params.userId);
	reclaimStaleClaimedMemoryDirtyLedgerRows({
		userId: params.userId,
		resetGeneration,
		staleBefore: new Date(
			startedAt -
				Math.max(
					1,
					Math.floor(
						params.staleClaimMs ?? DEFAULT_MEMORY_DIRTY_LEDGER_STALE_CLAIM_MS,
					),
				),
		),
		limit: Math.max(batchSize, 1),
	});
	const result: MemoryDirtyLedgerReconciliationResult = {
		claimed: 0,
		completed: 0,
		failed: 0,
		skipped: 0,
		timedOut: false,
	};
	const attemptedIds = new Set<string>();

	while (result.claimed < batchSize) {
		if (Date.now() - startedAt >= maxRuntimeMs) {
			result.timedOut = true;
			break;
		}

		const row = claimNextMemoryDirtyLedgerRow({
			userId: params.userId,
			resetGeneration,
			attemptedIds,
		});
		if (!row) break;
		attemptedIds.add(row.id);
		result.claimed += 1;

		if (!isOneOf(row.reason, MEMORY_DIRTY_REASONS)) {
			const metadata = parseJsonRecord(row.reasonMetadataJson);
			const completed = await completeClaimedMemoryDirtyLedgerRow({
				userId: params.userId,
				resetGeneration,
				id: row.id,
			});
			if (completed) {
				result.completed += 1;
			} else {
				result.skipped += 1;
			}
			await recordMemoryReworkTelemetry({
				userId: params.userId,
				eventFamily: "error_fallback",
				eventName: "dirty_ledger_invalid_reason_skipped",
				reason: row.reason,
				status: "skipped",
				count: row.count,
				subjectId: telemetrySubjectIdForDirtyMetadata(metadata) ?? undefined,
				metadata: {
					ledgerEntryId: row.id,
					scopeType: row.scopeType,
					scopeId: row.scopeId,
				},
				expectedResetGeneration: row.resetGeneration,
			});
			continue;
		}

		try {
			await handleClaimedMemoryDirtyLedgerRow({
				userId: params.userId,
				row,
				loadLegacyMemoryCandidates: params.loadLegacyMemoryCandidates,
				curatePreservedLegacyMemory: params.curatePreservedLegacyMemory,
			});
			const completed = await completeClaimedMemoryDirtyLedgerRow({
				userId: params.userId,
				resetGeneration,
				id: row.id,
			});
			if (completed) {
				result.completed += 1;
			} else {
				result.skipped += 1;
			}
		} catch (error) {
			result.failed += 1;
			try {
				await requeueClaimedMemoryDirtyLedgerRow({
					userId: params.userId,
					resetGeneration,
					id: row.id,
				});
				await recordMemoryReworkTelemetry({
					userId: params.userId,
					eventFamily: "error_fallback",
					eventName: "dirty_ledger_reconciliation_failed",
					reason: row.reason,
					status: "retry_pending",
					count: row.count,
					subjectId:
						telemetrySubjectIdForDirtyMetadata(
							parseJsonRecord(row.reasonMetadataJson),
						) ?? undefined,
					metadata: {
						ledgerEntryId: row.id,
						errorName: error instanceof Error ? error.name : "UnknownError",
					},
					expectedResetGeneration: row.resetGeneration,
				});
			} catch (telemetryError) {
				console.warn("[MEMORY_PROFILE] Dirty ledger retry failed", {
					userId: params.userId,
					ledgerEntryId: row.id,
					reason: row.reason,
					errorName:
						telemetryError instanceof Error
							? telemetryError.name
							: "UnknownError",
				});
			}
		}
	}

	return result;
}
