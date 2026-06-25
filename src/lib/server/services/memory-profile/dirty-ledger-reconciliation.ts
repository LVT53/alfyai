import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	conversations,
	memoryProfileItemProvenance,
	memoryProfileItems,
	messages,
} from "$lib/server/db/schema";
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
import {
	createMemoryProfileItem,
	addMemoryProfileItemProvenance,
} from "./projection-store";
import {
	getCurrentMemoryResetGeneration,
	isCurrentMemoryResetGeneration,
} from "./reset-generation";
import { createOrUpdateMemoryReviewItem } from "./review";
import {
	normalizeRememberedStatement,
	resolveMemoryProfileItemKey,
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
	MEMORY_PROFILE_CATEGORIES,
	type MemoryProfileCategory,
	type MemoryDirtyLedgerReconciliationResult,
	readMemoryProfileCategory,
} from "./types";
import { getConversationSummary } from "../conversation-summaries";
import {
	getHonchoSessionId,
	getUserPeer,
	isHonchoEnabled,
	isHonchoMissingError,
} from "../honcho";
import { truncateToTokenBudget } from "$lib/server/utils/prompt-context";

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

const DEFERRED_INTAKE_MAX_CANDIDATES = 50;
const DEFERRED_INTAKE_MAX_PROJECTION_MUTATIONS = 20;
const DEFERRED_INTAKE_MAX_NEW_REVIEWS = 3;
const DEFERRED_INTAKE_MAX_OPEN_REVIEWS = 12;
const DEFERRED_INTAKE_RAW_TURN_LIMIT = 8;
const DEFERRED_INTAKE_HIGH_CONFIDENCE = 0.9;
const DEFERRED_INTAKE_REVIEW_CONFIDENCE = 0.55;

type DeferredIntakeCandidate = {
	statement: string;
	category: MemoryProfileCategory;
	scope: "global" | "conversation";
	confidence: number;
};

type DeferredIntakeResult =
	| {
			status: "admitted";
			candidate: DeferredIntakeCandidate;
			itemId: string;
	  }
	| {
			status: "review";
			candidate: DeferredIntakeCandidate;
	  }
	| {
			status: "rejected";
			candidate: DeferredIntakeCandidate;
			reason: string;
	  }
	| {
			status: "skipped";
			reason: string;
	  };

function buildDeferredIntakePrompt(params: {
	conversationSummary: string | null;
	rawTurns: Array<{ role: "user" | "assistant"; content: string }>;
}): string {
	const summaryBlock = params.conversationSummary
		? `Conversation summary:\n${params.conversationSummary}`
		: "No durable conversation summary available.";

	const rawBlock =
		params.rawTurns.length > 0
			? `Recent raw conversation turns (supplementary detail):\n${params.rawTurns
					.map(
						(turn) =>
							`[${turn.role === "user" ? "USER" : "ASSISTANT"}]: ${turn.content}`,
					)
					.join("\n\n")}`
			: "No raw conversation turns available.";

	return [summaryBlock, rawBlock].join("\n\n");
}

function parseDeferredIntakeCandidates(
	text: string,
): DeferredIntakeCandidate[] {
	try {
		const parsed = JSON.parse(text) as unknown;
		const record =
			parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: {};
		const candidates = Array.isArray(record.candidates)
			? record.candidates
			: [];

		return candidates
			.map((entry: unknown): DeferredIntakeCandidate | null => {
				if (!entry || typeof entry !== "object" || Array.isArray(entry))
					return null;
				const item = entry as Record<string, unknown>;
				const statement =
					typeof item.statement === "string"
						? item.statement.trim().replace(/\s+/g, " ")
						: "";
				const category = readMemoryProfileCategory(item.category);
				const scopeItem =
					typeof item.scope === "string" &&
					(item.scope === "global" || item.scope === "conversation")
						? item.scope
						: "global";
				const confidence =
					typeof item.confidence === "number" &&
					Number.isFinite(item.confidence)
						? item.confidence
						: null;

				if (!statement || statement.length < 4 || statement.length > 260)
					return null;
				if (!category) return null;
				if (confidence === null || confidence < 0 || confidence > 1)
					return null;

				return {
					statement,
					category,
					scope: scopeItem,
					confidence,
				};
			})
			.filter(
				(candidate): candidate is DeferredIntakeCandidate =>
					candidate !== null,
			);
	} catch {
		return [];
	}
}

function lazySendJsonControlMessage(
	message: string,
) {
	return async () => {
		const { sendJsonControlMessage } = await import(
			"../normal-chat-control-model"
		);
		const { getConfig } = await import("$lib/server/config-store");
		return sendJsonControlMessage(
			message,
			getConfig().memoryLegacyCurationModel,
			{
				systemPrompt: [
					"You extract durable memory profile candidates from a user's conversation.",
					"Extract ONLY durable user facts, preferences, constraints, goals, and self-statements.",
					"DO NOT extract assistant-generated inferences, opinions, or suggestions.",
					"DO NOT extract document contents, file references, or attachment details.",
					"DO NOT extract one-off instructions, single-turn requests, or temporary details.",
					"Work with English and Hungarian input.",
					"Normalize the output statement to reflect the user's expressed language.",
					"Return an empty candidates list if no durable facts are found.",
					"Use the conversation summary as primary context and raw turns as supplementary detail.",
					'Assign a category: "about_you" (stable facts about the user), "preferences" (likes, styles, choices), "goals_ongoing_work" (current goals or ongoing work), "constraints_boundaries" (rules, limits, things to avoid).',
					'Assign a scope: "global" for general preferences/facts, "conversation" for project-specific goals.',
					"Assign a confidence score 0.0-1.0. 0.90+ for high-certainty durable facts. 0.55-0.89 for plausible but uncertain. Below 0.55 for speculative or transient.",
				].join("\n"),
				thinkingMode: "on",
				maxTokens: 1800,
				temperature: 0,
				jsonSchema: {
					name: "deferred_intake_extraction",
					strict: true,
					schema: {
						type: "object",
						additionalProperties: false,
						required: ["candidates"],
						properties: {
							candidates: {
								type: "array",
								items: {
									type: "object",
									additionalProperties: false,
									required: ["statement", "category", "scope", "confidence"],
									properties: {
										statement: { type: "string" },
										category: {
											type: "string",
											enum: [...MEMORY_PROFILE_CATEGORIES],
										},
										scope: {
											type: "string",
											enum: ["global", "conversation"],
										},
										confidence: {
											type: "number",
											minimum: 0,
											maximum: 1,
										},
									},
								},
							},
						},
					},
				},
				allowReasoningFallback: true,
			},
		);
	};
}

async function loadRawConversationTurns(params: {
	conversationId: string;
	limit: number;
}): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
	const rows = await db
		.select({
			role: messages.role,
			content: messages.content,
		})
		.from(messages)
		.where(eq(messages.conversationId, params.conversationId))
		.orderBy(desc(messages.createdAt))
		.limit(params.limit * 2);

	const filtered = rows
		.filter(
			(row): row is { role: "user" | "assistant"; content: string } =>
				(row.role === "user" || row.role === "assistant") &&
				typeof row.content === "string" &&
				row.content.trim().length > 0,
		)
		.reverse();

	const pairs: Array<{ role: "user" | "assistant"; content: string }> = [];
	for (const row of filtered) {
		pairs.push(row as { role: "user" | "assistant"; content: string });
		if (pairs.length >= params.limit) break;
	}

	return pairs;
}

async function conversationExists(
	conversationId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1);
	return Boolean(row);
}

async function hasActiveContradiction(params: {
	userId: string;
	resetGeneration: number;
	candidate: DeferredIntakeCandidate;
}): Promise<string | null> {
	const itemKey = resolveMemoryProfileItemKey({
		category: params.candidate.category,
		scope: { type: "global" },
		statement: params.candidate.statement,
	});

	const rows = db
		.select({
			id: memoryProfileItems.id,
			statement: memoryProfileItems.statement,
		})
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
				eq(memoryProfileItems.status, "active"),
			),
		)
		.limit(100)
		.all();

	const matching = rows.filter((row) => {
		if (row.statement === params.candidate.statement) return false;
		const existingWords = new Set(
			normalizeRememberedStatement(row.statement)
				.split(/\s+/)
				.filter((w) => w.length > 2),
		);
		const candidateWords = normalizeRememberedStatement(
			params.candidate.statement,
		)
			.split(/\s+/)
			.filter((w) => w.length > 2);
		if (candidateWords.length === 0) return false;
		const overlap = candidateWords.filter((w) => existingWords.has(w)).length;
		return overlap >= candidateWords.length * 0.5;
	});

	if (matching.length > 0) {
		return matching[0].id;
	}

	const [exact] = await db
		.select({ id: memoryProfileItems.id })
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
				eq(memoryProfileItems.itemKey, itemKey),
			),
		)
		.limit(1);

	if (exact) return exact.id;

	return null;
}

async function computeDeferredIntakeResult(params: {
	userId: string;
	resetGeneration: number;
	candidate: DeferredIntakeCandidate;
	conversationId: string;
}): Promise<DeferredIntakeResult> {
	const contradictingId = await hasActiveContradiction({
		userId: params.userId,
		resetGeneration: params.resetGeneration,
		candidate: params.candidate,
	});

	if (contradictingId) {
		return {
			status: "review",
			candidate: params.candidate,
		};
	}

	if (params.candidate.confidence >= DEFERRED_INTAKE_HIGH_CONFIDENCE) {
		try {
			const scope =
				params.candidate.scope === "conversation"
					? { type: "conversation" as const, id: params.conversationId }
					: ({ type: "global" as const });

			const item = await createMemoryProfileItem({
				userId: params.userId,
				category: params.candidate.category,
				scope,
				statement: params.candidate.statement,
				expectedResetGeneration: params.resetGeneration,
			});

			if (item.status !== "active") {
				return {
					status: "skipped",
					reason: "inactive_duplicate",
				};
			}

			await addMemoryProfileItemProvenance({
				userId: params.userId,
				itemId: item.id,
				sourceType: "deferred_intake_extraction",
				sourceId: params.conversationId,
				label: "Chat (LLM extraction)",
				summary:
					"Extracted from conversation by automatic deferred intake analysis.",
				expectedResetGeneration: params.resetGeneration,
			});

			return {
				status: "admitted",
				candidate: params.candidate,
				itemId: item.id,
			};
		} catch {
			return { status: "skipped", reason: "projection_write_failed" };
		}
	}

	if (params.candidate.confidence >= DEFERRED_INTAKE_REVIEW_CONFIDENCE) {
		return { status: "review", candidate: params.candidate };
	}

	return {
		status: "rejected",
		candidate: params.candidate,
		reason: "low_confidence_extraction",
	};
}

async function applyDeferredIntakeResults(params: {
	userId: string;
	resetGeneration: number;
	conversationId: string;
	ledgerEntryId: string;
	candidates: DeferredIntakeCandidate[];
	openReviewCount: number;
}): Promise<{
	admitted: number;
	review: number;
	rejected: number;
	skipped: number;
}> {
	let admitted = 0;
	let review = 0;
	let rejected = 0;
	let skipped = 0;
	let projectionMutations = 0;
	let remainingReviewSlots = Math.max(
		0,
		Math.min(
			DEFERRED_INTAKE_MAX_NEW_REVIEWS,
			DEFERRED_INTAKE_MAX_OPEN_REVIEWS - params.openReviewCount,
		),
	);

	for (const candidate of params.candidates.slice(
		0,
		DEFERRED_INTAKE_MAX_CANDIDATES,
	)) {
		if (projectionMutations >= DEFERRED_INTAKE_MAX_PROJECTION_MUTATIONS) {
			skipped += 1;
			await recordDeferredIntakeTelemetry({
				userId: params.userId,
				resetGeneration: params.resetGeneration,
				candidate,
				decision: "skipped",
				reason: "batch_limit",
				ledgerEntryId: params.ledgerEntryId,
				conversationId: params.conversationId,
			});
			continue;
		}

		const result = await computeDeferredIntakeResult({
			userId: params.userId,
			resetGeneration: params.resetGeneration,
			candidate,
			conversationId: params.conversationId,
		});

		if (result.status === "admitted") {
			admitted += 1;
			projectionMutations += 1;

			await markMemoryDirty({
				userId: params.userId,
				reason: "honcho_reconciliation",
				scope: { type: "global" },
				expectedResetGeneration: params.resetGeneration,
				metadata: {
					itemId: result.itemId,
					conversationId: params.conversationId,
					intakeSource: "deferred_intake_extraction",
				},
			});
		} else if (result.status === "review") {
			if (remainingReviewSlots <= 0) {
				skipped += 1;
				await recordDeferredIntakeTelemetry({
					userId: params.userId,
					resetGeneration: params.resetGeneration,
					candidate,
					decision: "skipped",
					reason: "review_slot_full",
					ledgerEntryId: params.ledgerEntryId,
					conversationId: params.conversationId,
				});
				continue;
			}
			review += 1;
			remainingReviewSlots -= 1;

			const contradictingId = await hasActiveContradiction({
				userId: params.userId,
				resetGeneration: params.resetGeneration,
				candidate,
			});

			await createOrUpdateMemoryReviewItem({
				userId: params.userId,
				subjectKey: `deferred-intake:${stableMemoryMaintenanceDigest(`${params.conversationId}\u001f${candidate.category}\u001f${candidate.statement}`)}`,
				subjectLabel: candidate.statement,
				question: "Should AlfyAI remember this?",
				reason: contradictingId
					? "This extracted memory may contradict an existing active profile item."
					: "This memory was extracted from conversation but needs confirmation.",
				affectedItemIds: contradictingId ? [contradictingId] : [],
				evidence: [
					{
						sourceType: "deferred_intake_extraction",
						conversationId: params.conversationId,
						ledgerEntryId: params.ledgerEntryId,
					},
				],
				metadata: {
					source: "deferred_intake_extraction",
					category: candidate.category,
					proposedStatement: candidate.statement,
					confidence: candidate.confidence,
					conversationId: params.conversationId,
				},
				expectedResetGeneration: params.resetGeneration,
			});
		} else if (result.status === "rejected") {
			rejected += 1;
		} else {
			skipped += 1;
		}

		await recordDeferredIntakeTelemetry({
			userId: params.userId,
			resetGeneration: params.resetGeneration,
			candidate,
			decision: result.status,
			reason:
				result.status === "rejected"
					? result.reason
					: result.status === "skipped"
						? result.reason
						: undefined,
			ledgerEntryId: params.ledgerEntryId,
			conversationId: params.conversationId,
		});
	}

	return { admitted, review, rejected, skipped };
}

async function recordDeferredIntakeTelemetry(params: {
	userId: string;
	resetGeneration: number;
	candidate: DeferredIntakeCandidate;
	decision: "admitted" | "review" | "rejected" | "skipped";
	reason?: string;
	ledgerEntryId: string;
	conversationId: string;
}): Promise<void> {
	await recordMemoryReworkTelemetry({
		userId: params.userId,
		eventFamily: "maintenance",
		eventName: "deferred_intake_extraction",
		category: params.candidate.category,
		reason: params.reason ?? params.decision,
		status: params.decision,
		count: 1,
		metadata: {
			ledgerEntryId: params.ledgerEntryId,
			conversationId: params.conversationId,
			confidence: params.candidate.confidence,
			scope: params.candidate.scope,
		},
		expectedResetGeneration: params.resetGeneration,
	});
}

async function handleDeferredIntakeExtraction(params: {
	userId: string;
	row: ClaimedDirtyLedgerRow;
}): Promise<void> {
	const metadata = parseJsonRecord(params.row.reasonMetadataJson);
	const conversationId = readSafeString(metadata.conversationId);

	if (!conversationId) {
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "error_fallback",
			eventName: "dirty_ledger_deferred_intake_missing_conversation",
			reason: params.row.reason,
			status: "completed",
			count: params.row.count,
			metadata: {
				ledgerEntryId: params.row.id,
				scopeType: params.row.scopeType,
				scopeId: params.row.scopeId,
			},
			expectedResetGeneration: params.row.resetGeneration,
		});
		return;
	}

	if (!(await conversationExists(conversationId))) {
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "maintenance",
			eventName: "dirty_ledger_deferred_intake_conversation_deleted",
			reason: params.row.reason,
			status: "completed",
			count: params.row.count,
			metadata: {
				ledgerEntryId: params.row.id,
				conversationId,
			},
			expectedResetGeneration: params.row.resetGeneration,
		});
		return;
	}

	const summary = await getConversationSummary({
		userId: params.userId,
		conversationId,
	});

	const rawTurns = await loadRawConversationTurns({
		conversationId,
		limit: DEFERRED_INTAKE_RAW_TURN_LIMIT,
	});

	const userTurns = rawTurns.filter(
		(turn) => turn.role === "user",
	);
	if (rawTurns.length === 0 || userTurns.length === 0) {
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "maintenance",
			eventName: "dirty_ledger_deferred_intake_no_turns",
			reason: params.row.reason,
			status: "completed",
			count: params.row.count,
			metadata: {
				ledgerEntryId: params.row.id,
				conversationId,
			},
			expectedResetGeneration: params.row.resetGeneration,
		});
		return;
	}

	if (
		!(await isCurrentMemoryResetGeneration({
			userId: params.userId,
			resetGeneration: params.row.resetGeneration,
		}))
	) {
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "maintenance",
			eventName: "dirty_ledger_deferred_intake_stale_generation",
			reason: params.row.reason,
			status: "skipped",
			count: params.row.count,
			metadata: {
				ledgerEntryId: params.row.id,
				conversationId,
			},
			expectedResetGeneration: params.row.resetGeneration,
		});
		return;
	}

	const prompt = buildDeferredIntakePrompt({
		conversationSummary: summary?.summary ?? null,
		rawTurns: rawTurns.map((turn) => ({
			role: turn.role,
			content: turn.content.slice(0, 600),
		})),
	});

	let candidates: DeferredIntakeCandidate[] = [];
	try {
		const sendControlMessage = lazySendJsonControlMessage(prompt);
		const response = await sendControlMessage();
		candidates = parseDeferredIntakeCandidates(response.text);
	} catch (error) {
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "error_fallback",
			eventName: "dirty_ledger_deferred_intake_llm_failed",
			reason: params.row.reason,
			status: "retry_pending",
			count: params.row.count,
			metadata: {
				ledgerEntryId: params.row.id,
				conversationId,
				errorName: error instanceof Error ? error.name : "UnknownError",
			},
			expectedResetGeneration: params.row.resetGeneration,
		});
		throw error;
	}

	if (
		!(await isCurrentMemoryResetGeneration({
			userId: params.userId,
			resetGeneration: params.row.resetGeneration,
		}))
	) {
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "maintenance",
			eventName: "dirty_ledger_deferred_intake_stale_generation_after_llm",
			reason: params.row.reason,
			status: "skipped",
			count: params.row.count,
			metadata: {
				ledgerEntryId: params.row.id,
				conversationId,
				candidateCount: candidates.length,
			},
			expectedResetGeneration: params.row.resetGeneration,
		});
		return;
	}

	const openReviews = await db
		.select({ count: memoryProfileItems.id })
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(
					memoryProfileItems.resetGeneration,
					params.row.resetGeneration,
				),
				eq(memoryProfileItems.status, "review_needed"),
			),
		)
		.then((rows) => rows.length);

	const result = await applyDeferredIntakeResults({
		userId: params.userId,
		resetGeneration: params.row.resetGeneration,
		conversationId,
		ledgerEntryId: params.row.id,
		candidates,
		openReviewCount: openReviews,
	});

	await recordMemoryReworkTelemetry({
		userId: params.userId,
		eventFamily: "maintenance",
		eventName: "dirty_ledger_deferred_intake_extraction_completed",
		reason: params.row.reason,
		status: "completed",
		count: params.row.count,
		metadata: {
			ledgerEntryId: params.row.id,
			conversationId,
			admittedCount: result.admitted,
			reviewCount: result.review,
			rejectedCount: result.rejected,
			skippedCount: result.skipped,
			candidateCount: candidates.length,
		},
		expectedResetGeneration: params.row.resetGeneration,
	});
}

const HONCHO_RECONCILE_MAX_CALLS_PER_SLICE = 10;

async function handleHonchoReconciliation(params: {
	userId: string;
	row: ClaimedDirtyLedgerRow;
	honchoCallCount: { count: number };
}): Promise<void> {
	const metadata = parseJsonRecord(params.row.reasonMetadataJson);
	const itemId = readSafeString(metadata.itemId);

	if (!itemId) {
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "maintenance",
			eventName: "dirty_ledger_honcho_reconciliation_missing_item_id",
			reason: params.row.reason,
			status: "completed",
			count: params.row.count,
			metadata: {
				ledgerEntryId: params.row.id,
				scopeType: params.row.scopeType,
				scopeId: params.row.scopeId,
			},
			expectedResetGeneration: params.row.resetGeneration,
		});
		return;
	}

	if (
		!(await isCurrentMemoryResetGeneration({
			userId: params.userId,
			resetGeneration: params.row.resetGeneration,
		}))
	) {
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "maintenance",
			eventName: "dirty_ledger_honcho_reconciliation_stale_generation",
			reason: params.row.reason,
			status: "skipped",
			count: params.row.count,
			subjectId: itemId,
			metadata: {
				ledgerEntryId: params.row.id,
				scopeType: params.row.scopeType,
				scopeId: params.row.scopeId,
				itemId,
			},
			expectedResetGeneration: params.row.resetGeneration,
		});
		return;
	}

	if (!isHonchoEnabled()) {
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "maintenance",
			eventName: "dirty_ledger_honcho_reconciliation_disabled",
			reason: params.row.reason,
			status: "completed",
			count: params.row.count,
			subjectId: itemId,
			metadata: {
				ledgerEntryId: params.row.id,
				scopeType: params.row.scopeType,
				scopeId: params.row.scopeId,
				itemId,
			},
			expectedResetGeneration: params.row.resetGeneration,
		});
		return;
	}

	const [item] = await db
		.select({
			id: memoryProfileItems.id,
			statement: memoryProfileItems.statement,
			status: memoryProfileItems.status,
			scopeType: memoryProfileItems.scopeType,
			scopeId: memoryProfileItems.scopeId,
		})
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.id, itemId),
				eq(memoryProfileItems.resetGeneration, params.row.resetGeneration),
			),
		)
		.limit(1);

	if (!item || item.status !== "active") {
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "maintenance",
			eventName: item
				? "dirty_ledger_honcho_reconciliation_item_not_active"
				: "dirty_ledger_honcho_reconciliation_item_not_found",
			reason: params.row.reason,
			status: "completed",
			count: params.row.count,
			subjectId: itemId,
			metadata: {
				ledgerEntryId: params.row.id,
				scopeType: params.row.scopeType,
				scopeId: params.row.scopeId,
				itemId,
				...(item ? { itemStatus: item.status } : {}),
			},
			expectedResetGeneration: params.row.resetGeneration,
		});
		return;
	}

	const statement = item.statement;
	const conversationId =
		readSafeString(metadata.conversationId) ??
		(item.scopeType === "conversation" && item.scopeId ? item.scopeId : null);

	if (!conversationId) {
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "maintenance",
			eventName: "dirty_ledger_honcho_reconciliation_missing_conversation",
			reason: params.row.reason,
			status: "completed",
			count: params.row.count,
			subjectId: itemId,
			metadata: {
				ledgerEntryId: params.row.id,
				scopeType: params.row.scopeType,
				scopeId: params.row.scopeId,
				itemId,
			},
			expectedResetGeneration: params.row.resetGeneration,
		});
		return;
	}

	if (params.honchoCallCount.count >= HONCHO_RECONCILE_MAX_CALLS_PER_SLICE) {
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "maintenance",
			eventName: "dirty_ledger_honcho_reconciliation_rate_limited",
			reason: params.row.reason,
			status: "retry_pending",
			count: params.row.count,
			subjectId: itemId,
			metadata: {
				ledgerEntryId: params.row.id,
				conversationId,
				itemId,
				honchoCallCount: params.honchoCallCount.count,
			},
			expectedResetGeneration: params.row.resetGeneration,
		});
		throw new Error(
			`Honcho call limit reached (${HONCHO_RECONCILE_MAX_CALLS_PER_SLICE})`,
		);
	}

	params.honchoCallCount.count += 1;

	try {
		const peer = await getUserPeer(params.userId);
		await peer.conclusions.create({
			content: truncateToTokenBudget(statement, 800),
			sessionId: getHonchoSessionId(params.userId, conversationId),
		});

		await addMemoryProfileItemProvenance({
			userId: params.userId,
			itemId,
			sourceType: "honcho_conclusion",
			sourceId: conversationId,
			label: "Honcho (memory conclusion)",
			summary:
				"Memory statement written to Honcho as a peer conclusion for reconciliation.",
			expectedResetGeneration: params.row.resetGeneration,
		});

		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "maintenance",
			eventName: "dirty_ledger_honcho_reconciliation_completed",
			reason: params.row.reason,
			status: "completed",
			count: 1,
			subjectId: itemId,
			metadata: {
				ledgerEntryId: params.row.id,
				conversationId,
				itemId,
			},
			expectedResetGeneration: params.row.resetGeneration,
		});
	} catch (error) {
		if (isHonchoMissingError(error)) {
			await recordMemoryReworkTelemetry({
				userId: params.userId,
				eventFamily: "maintenance",
				eventName: "dirty_ledger_honcho_reconciliation_session_missing",
				reason: params.row.reason,
				status: "completed",
				count: 1,
				subjectId: itemId,
				metadata: {
					ledgerEntryId: params.row.id,
					conversationId,
					itemId,
				},
				expectedResetGeneration: params.row.resetGeneration,
			});
			return;
		}

		throw error;
	}
}

async function handleClaimedMemoryDirtyLedgerRow(params: {
	userId: string;
	row: ClaimedDirtyLedgerRow;
	loadLegacyMemoryCandidates?: LegacyMemoryCandidateLoader;
	curatePreservedLegacyMemory?: LegacyMemoryCurator;
	honchoCallCount?: { count: number };
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
	if (params.row.reason === "projection_reconciliation") {
		const action = readSafeString(metadata.action);
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "maintenance",
			eventName: "dirty_ledger_projection_reconciliation_completed",
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
	if (params.row.reason === "honcho_reconciliation") {
		await handleHonchoReconciliation({
			userId: params.userId,
			row: params.row,
			honchoCallCount: params.honchoCallCount ?? { count: 0 },
		});
		return;
	}
	if (params.row.reason === "deferred_intake") {
		await handleDeferredIntakeExtraction({
			userId: params.userId,
			row: params.row,
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

	const honchoCallCount = { count: 0 };

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
				honchoCallCount,
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
