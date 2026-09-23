import { and, eq } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { memoryProfileItems } from "$lib/server/db/schema";
import { getConversationSummary } from "../conversation-summaries";
import { callMemoryControlModel } from "../memory-control-model";
import { getActiveMemoryProfileContext } from "../memory-profile/active-context";
import {
	addMemoryProfileItemProvenance,
	createMemoryProfileItem,
	ensureProjectionState,
	setMemoryProfileItemMetadataAndExpiry,
	updateMemoryProfileItemWithRevision,
} from "../memory-profile/projection-store";
import { getMemoryProfileReadModel } from "../memory-profile/read-model";
import { getCurrentMemoryResetGeneration } from "../memory-profile/reset-generation";
import {
	createOrUpdateMemoryReviewItem,
	JUDGE_REVIEW_SUBJECT_PREFIX,
} from "../memory-profile/review";
import { recordMemoryReworkTelemetry } from "../memory-profile/telemetry";
import {
	type MemoryItemUserProtection,
	readMemoryItemUserProtection,
} from "../memory-profile/types";
import { getConversationProjectId } from "../projects";
import { REVIEW_EXPIRY_DAYS, REVIEW_OPEN_CAP } from "./config";
import {
	buildJudgeSystemPrompt,
	buildJudgeUserMessage,
	type JudgeSegmentMessage,
} from "./prompt";
import {
	JUDGE_JSON_SCHEMA,
	type JudgeDecision,
	parseJudgeDecisionsDetailed,
	type RejectedJudgeCandidate,
} from "./schema";
import {
	advanceConversationMemoryWatermark,
	countUnjudgedMessages,
	getUnjudgedConversationSegment,
} from "./segment";

export type JudgeTrigger =
	| "idle"
	| "explicit"
	| "marathon"
	| "sweep"
	| "recuration";

export type JudgeRunResult =
	| {
			status: "ran";
			admitted: number;
			review: number;
			updated: number;
			dryRun: boolean;
			/**
			 * True when the conversation still had unjudged messages beyond the
			 * segment we just processed (a backlog > maxMessages). Callers that
			 * complete the conversation's dirty-ledger rows after a run must
			 * re-mark it dirty so a later sweep/idle pass drains the remainder.
			 */
			backlogRemaining: boolean;
	  }
	| { status: "empty" }
	| { status: "failed"; reason: string };

const DAY_MS = 86_400_000;

export async function runMemoryJudgeOnSegment(params: {
	userId: string;
	conversationId: string;
	trigger: JudgeTrigger;
	segmentOverride?: JudgeSegmentMessage[];
	/**
	 * When `segmentOverride` is supplied (the explicit "remember that…" path),
	 * the highest `messageSequence` of the exchange being judged. The watermark is
	 * advanced to this value ONLY when the exchange is the entire unjudged tail —
	 * i.e. no pre-existing backlog sits below it. `advanceConversationMemory
	 * Watermark` takes `max(existing, value)`, so advancing while a lower-sequence
	 * backlog is still unjudged would silently mark those never-sent messages
	 * judged (D1-class intake loss). When a backlog exists we judge the synthetic
	 * exchange for immediate effect but leave the watermark alone; the dirty-mark
	 * + the loader's oldest-first drain re-judge everything losslessly (gate-5
	 * non-redundancy dedupes the explicit exchange's re-judge). Omitted/zero is a
	 * no-op.
	 */
	overrideHighestSequence?: number;
}): Promise<JudgeRunResult> {
	// Single chokepoint for BOTH memory controls: every judge path (explicit,
	// idle-scheduled, marathon, sweep, re-curation, and the opportunistic flush
	// of queued runs on new-conversation creation) funnels through here, so
	// neither a conversation flipped to incognito NOR a user who has since
	// turned their master memory toggle OFF is ever judged — even for a turn
	// queued while memory was on whose delayed pass fires after it was disabled.
	// (Previously this checked only incognito, so the flush path could still run
	// a pending judge for a user who had since disabled memory.)
	const { isMemoryActiveForConversation } = await import("../memory-controls");
	const memoryActive = await isMemoryActiveForConversation({
		userId: params.userId,
		conversationId: params.conversationId,
	}).catch(() => true);
	if (!memoryActive) {
		return { status: "empty" };
	}
	const config = getConfig();
	let segmentMessages: JudgeSegmentMessage[];
	let highestSequence = 0;
	let backlogRemaining = false;
	if (params.segmentOverride) {
		segmentMessages = params.segmentOverride;
		// Explicit path: advance the watermark to the newest message of the judged
		// exchange (threaded from the caller) ONLY when the exchange is the entire
		// unjudged tail. If a pre-existing backlog sits below it, advancing (which
		// is max(existing, value)) would mark those never-sent messages judged —
		// D1-class intake loss. Detect the backlog via the unjudged count: when it
		// is no larger than the exchange we're judging, nothing older is pending
		// and it is safe to advance. Otherwise leave the watermark alone and let
		// the oldest-first loader drain everything (the explicit exchange included)
		// on a later dirty-mark-driven pass.
		const override = params.overrideHighestSequence ?? 0;
		if (override > 0) {
			const unjudgedCount = await countUnjudgedMessages({
				userId: params.userId,
				conversationId: params.conversationId,
			});
			if (unjudgedCount <= segmentMessages.length) {
				highestSequence = override;
			}
		}
	} else {
		const segment = await getUnjudgedConversationSegment(params);
		if (segment.count === 0) return { status: "empty" };
		segmentMessages = segment.messages;
		highestSequence = segment.highestSequence;
		backlogRemaining = segment.remaining > 0;
	}

	const projectId = await getConversationProjectId(
		params.userId,
		params.conversationId,
	).catch(() => null);
	const [summary, activeContext] = await Promise.all([
		getConversationSummary({
			userId: params.userId,
			conversationId: params.conversationId,
		}).catch(() => null),
		// Gate 5 needs every fact the judge may update, including this project's
		// scoped facts (the judge writes them); otherwise they are never shown and
		// can never be targeted by update/strengthen.
		getActiveMemoryProfileContext({
			userId: params.userId,
			applicableScopes: projectId ? [{ type: "project", id: projectId }] : [],
		}),
	]);
	const existingFacts = activeContext.items.map((i) => ({
		id: i.id,
		statement: i.statement,
		category: i.category,
	}));

	let decisions: JudgeDecision[];
	let rejected: RejectedJudgeCandidate[] = [];
	try {
		// One structured control-model call via the shared memory adapter: it owns
		// control-model selection, thinkingMode:"off" (same-quality, ~7x faster —
		// measured 9s vs 69s on a Qwen thinking model), the reasoning-aware budget
		// (a reasoning model's CoT grows with the conversation and counts against
		// max_tokens; a flat budget truncated an 87-message segment to 0 decisions
		// at 2400 vs 3 clean at 8000), and the per-feature cost row. The judge keeps
		// its bespoke `parseJudgeDecisionsDetailed` (strict JSON.parse + post-filter
		// rejects), so no envelopeKey is passed.
		const res = await callMemoryControlModel({
			userId: params.userId,
			feature: "judge",
			systemPrompt: buildJudgeSystemPrompt(),
			userMessage: buildJudgeUserMessage({
				segment: segmentMessages,
				conversationSummary: summary?.summary ?? null,
				existingFacts,
				projectId,
			}),
			modelId: config.memoryJudgeModel,
			inputSizeHint: segmentMessages.length,
			jsonSchema: JUDGE_JSON_SCHEMA,
		});
		// The facts the model saw let the missing-target gate resolve an
		// update/strengthen that arrived without a targetItemId.
		({ decisions, rejected } = parseJudgeDecisionsDetailed(res.text, {
			existingFacts,
		}));
	} catch (error) {
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "intake",
			eventName: "judge_call_failed",
			reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
			status: "error",
		}).catch(() => {});
		return { status: "failed", reason: "judge_call_failed" };
	}

	if (config.memoryJudgeDryRun) {
		for (const d of decisions) {
			await recordMemoryReworkTelemetry({
				userId: params.userId,
				eventFamily: "intake",
				eventName: "judge_dry_run_decision",
				category: d.category,
				status: d.confidence,
				metadata: {
					statement: d.statement,
					action: d.action,
					trigger: params.trigger,
					...(d.targetResolution
						? { targetResolution: d.targetResolution }
						: {}),
				},
			}).catch(() => {});
		}
		if (highestSequence > 0) {
			await advanceConversationMemoryWatermark({
				userId: params.userId,
				conversationId: params.conversationId,
				lastJudgedSequence: highestSequence,
			});
		}
		return {
			status: "ran",
			admitted: 0,
			review: 0,
			updated: 0,
			dryRun: true,
			backlogRemaining,
		};
	}

	// Live-run diagnostics: record each post-filter reject so the intake funnel
	// (spec §3.2/§6) stays measurable. "statement" is privacy-safe per
	// assertPrivacySafeMetadata; clip to keep telemetry rows bounded.
	for (const r of rejected) {
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "intake",
			eventName: "judge_candidate_rejected",
			reason: r.reason,
			metadata: { statement: r.statement.slice(0, 200) },
		}).catch(() => {});
	}

	let admitted = 0;
	let review = 0;
	let updated = 0;
	// The projection revision advances every time we create or update an item.
	// Track the latest revision as we go so update-with-revision does not fail
	// with stale_projection after earlier creates in the same run.
	let projectionRevision = activeContext.projectionRevision;
	const readModel = decisions.some((d) => d.confidence === "inferred")
		? await getMemoryProfileReadModel({ userId: params.userId })
		: null;
	let openReview = readModel?.review.openCount ?? 0;

	for (const d of decisions) {
		const scope =
			d.scope === "project" && projectId
				? { type: "project" as const, id: projectId }
				: { type: "global" as const };
		const metadata = {
			confidence: d.confidence,
			expiryClass: d.expiryClass,
			origin: params.trigger === "recuration" ? "recuration" : "judge_v1",
			...(d.expiryClass === "time_bound" && d.expiresInDays
				? { expiresInDays: d.expiresInDays }
				: {}),
		};

		if (d.targetResolution) {
			await recordMemoryReworkTelemetry({
				userId: params.userId,
				eventFamily: "intake",
				eventName: "judge_target_resolved",
				reason: d.targetResolution,
				category: d.category,
				metadata: { action: d.action },
			}).catch(() => {});
		}

		// Every way a parsed decision can fail to land is recorded with the same
		// `judge_candidate_rejected` vocabulary as the parse-time gates, so the
		// write path is measurable instead of silently dropped.
		const dropCandidate = (reason: string) =>
			recordMemoryReworkTelemetry({
				userId: params.userId,
				eventFamily: "intake",
				eventName: "judge_candidate_rejected",
				reason,
				category: d.category,
				metadata: { statement: d.statement.slice(0, 200), action: d.action },
			}).catch(() => {});

		if (d.action === "update" || d.action === "strengthen") {
			const targetItemId = d.targetItemId;
			if (!targetItemId) {
				await dropCandidate("missing_target");
				continue;
			}
			const target = activeContext.items.find((i) => i.id === targetItemId);
			if (!target) {
				await dropCandidate("target_not_active");
				continue;
			}
			// Never touch user-protected items (user_authored, or accepted in
			// review). Read the item metadata directly rather than relying on
			// read-model detail (which does not expose it). The user_authored
			// reason name is kept stable; accepted facts get their own.
			const protection = await readItemUserProtection(
				params.userId,
				targetItemId,
			);
			if (protection) {
				await dropCandidate(
					protection === "user_authored"
						? "target_user_authored"
						: "target_user_protected",
				);
				continue;
			}
			const patch = d.action === "update" ? { statement: d.statement } : {};
			let patched = await updateMemoryProfileItemWithRevision({
				userId: params.userId,
				itemId: targetItemId,
				expectedProjectionRevision: projectionRevision,
				patch,
			});
			if (patched.status === "stale_projection") {
				// The revision read before the model call can go stale: chat turns,
				// review actions, or the read-model expiry sweep above may have
				// advanced it meanwhile. The judge is not replaying a user's stale
				// view, so re-read the current revision and try once more.
				projectionRevision = await currentProjectionRevision(params.userId);
				patched = await updateMemoryProfileItemWithRevision({
					userId: params.userId,
					itemId: targetItemId,
					expectedProjectionRevision: projectionRevision,
					patch,
				});
			}
			if (patched.status === "updated") {
				projectionRevision = patched.projectionRevision;
				updated++;
				await addProvenanceForItem(params, targetItemId, d);
				await refreshFactEmbedding(params.userId, targetItemId, d.statement);
			} else {
				await dropCandidate(`target_update_${patched.status}`);
			}
			continue;
		}

		if (d.confidence === "stated") {
			const item = await createMemoryProfileItem({
				userId: params.userId,
				category: d.category,
				scope,
				statement: d.statement,
				status: "active",
			});
			projectionRevision = item.projectionRevision;
			// The itemKey was taken: createMemoryProfileItem handed back an
			// EXISTING row (possibly user-protected, suppressed, or retired). It is
			// not ours to overwrite — writing the judge's metadata would drop a
			// user_authored origin or endorsement, or silently re-label a removed
			// fact.
			if (!item.created) {
				await dropCandidate("duplicate_existing");
				continue;
			}
			await applyItemMetadata(params.userId, item.id, metadata, d);
			await addProvenanceForItem(params, item.id, d);
			await refreshFactEmbedding(params.userId, item.id, d.statement);
			admitted++;
		} else {
			if (openReview >= REVIEW_OPEN_CAP) {
				await recordMemoryReworkTelemetry({
					userId: params.userId,
					eventFamily: "intake",
					eventName: "judge_review_cap_hit",
					category: d.category,
				}).catch(() => {});
				continue;
			}
			const item = await createMemoryProfileItem({
				userId: params.userId,
				category: d.category,
				scope,
				statement: d.statement,
				status: "review_needed",
			});
			projectionRevision = item.projectionRevision;
			// Same guard as the stated path; here it also stops the review row
			// from flipping an existing active fact to review_needed.
			if (!item.created) {
				await dropCandidate("duplicate_existing");
				continue;
			}
			await applyItemMetadata(
				params.userId,
				item.id,
				metadata,
				d,
				new Date(Date.now() + REVIEW_EXPIRY_DAYS * DAY_MS),
			);
			await addProvenanceForItem(params, item.id, d);
			// The row carries the proposed statement and intake category so the
			// review queue can offer Accept (review.ts promotes the affected item
			// in place, keeping this category, scope, and provenance).
			await createOrUpdateMemoryReviewItem({
				userId: params.userId,
				subjectKey: `${JUDGE_REVIEW_SUBJECT_PREFIX}${item.itemKey}`,
				subjectLabel: d.statement,
				question: "Should I keep remembering this?",
				reason: "Inferred from conversation, not stated directly.",
				affectedItemIds: [item.id],
				metadata: {
					source: "memory_judge",
					category: d.category,
					proposedStatement: d.statement,
					expiryClass: d.expiryClass,
					...(d.expiryClass === "time_bound" && d.expiresInDays
						? { expiresInDays: d.expiresInDays }
						: {}),
				},
			});
			openReview++;
			review++;
		}
	}

	if (highestSequence > 0) {
		await advanceConversationMemoryWatermark({
			userId: params.userId,
			conversationId: params.conversationId,
			lastJudgedSequence: highestSequence,
		});
	}

	await recordMemoryReworkTelemetry({
		userId: params.userId,
		eventFamily: "intake",
		eventName: "judge_run",
		count: decisions.length,
		status: "ok",
		metadata: { trigger: params.trigger, admitted, review, updated },
	}).catch(() => {});

	return {
		status: "ran",
		admitted,
		review,
		updated,
		dryRun: false,
		backlogRemaining,
	};
}

async function currentProjectionRevision(userId: string): Promise<number> {
	const resetGeneration = await getCurrentMemoryResetGeneration(userId);
	const projection = await ensureProjectionState({ userId, resetGeneration });
	return projection.revision;
}

async function readItemUserProtection(
	userId: string,
	itemId: string,
): Promise<MemoryItemUserProtection | null> {
	const [row] = await db
		.select({ metadataJson: memoryProfileItems.metadataJson })
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, userId),
				eq(memoryProfileItems.id, itemId),
			),
		)
		.limit(1);
	if (!row) return null;
	return readMemoryItemUserProtection(row.metadataJson);
}

async function applyItemMetadata(
	userId: string,
	itemId: string,
	meta: Record<string, unknown>,
	d: JudgeDecision,
	reviewExpiresAt?: Date,
): Promise<void> {
	// Inferred (review_needed) items always use the ~30-day review auto-expiry
	// window, regardless of expiryClass — the review queue itself must expire.
	// Their factual horizon (expiresInDays) is preserved in metadata only, so
	// it can be applied to expiresAt later if/when the item is accepted.
	// Stated/active time_bound items use their own factual horizon directly.
	const expiresAt = reviewExpiresAt
		? reviewExpiresAt
		: d.expiryClass === "time_bound" && d.expiresInDays
			? new Date(Date.now() + d.expiresInDays * DAY_MS)
			: undefined;
	// The item was just created by createMemoryProfileItem (which already claimed
	// the projection revision); writing its metadata/expiry is a side write on
	// that same row, routed through the store so the judge issues no raw item-
	// table update of its own.
	await setMemoryProfileItemMetadataAndExpiry({
		userId,
		itemId,
		metadataJson: JSON.stringify(meta),
		expiresAt,
	});
}

async function addProvenanceForItem(
	params: { userId: string; conversationId: string },
	itemId: string,
	d: JudgeDecision,
): Promise<void> {
	await addMemoryProfileItemProvenance({
		userId: params.userId,
		itemId,
		sourceType: "conversation",
		sourceId: params.conversationId,
		label: "Conversation",
		summary: d.sourceQuote,
	});
}

export async function refreshFactEmbedding(
	userId: string,
	itemId: string,
	statement: string,
): Promise<void> {
	try {
		const { canUseTeiEmbedder, embedText } = await import("../tei-embedder");
		if (!canUseTeiEmbedder()) return;
		const vector = await embedText(statement);
		if (!vector) return;
		const { upsertSemanticEmbedding } = await import("../semantic-embeddings");
		await upsertSemanticEmbedding({
			userId,
			subjectType: "memory_profile_item",
			subjectId: itemId,
			modelName: getConfig().teiEmbedderModel,
			sourceText: statement,
			embedding: vector,
		});
	} catch {
		// Embedding refresh is best-effort and must never fail the judge run.
	}
}
