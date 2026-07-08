import { and, eq } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { memoryProfileItems } from "$lib/server/db/schema";
import { getConversationSummary } from "../conversation-summaries";
import { getActiveMemoryProfileContext } from "../memory-profile/active-context";
import {
	addMemoryProfileItemProvenance,
	createMemoryProfileItem,
	updateMemoryProfileItemWithRevision,
} from "../memory-profile/projection-store";
import { getMemoryProfileReadModel } from "../memory-profile/read-model";
import { createOrUpdateMemoryReviewItem } from "../memory-profile/review";
import { recordMemoryReworkTelemetry } from "../memory-profile/telemetry";
import { isUserAuthoredMemoryMetadata } from "../memory-profile/types";
import { getConversationProjectId } from "../projects";
import {
	buildJudgeSystemPrompt,
	buildJudgeUserMessage,
	type JudgeSegmentMessage,
} from "./prompt";
import {
	JUDGE_JSON_SCHEMA,
	type JudgeDecision,
	parseJudgeDecisionsDetailed,
	reasoningAwareMaxTokens,
	type RejectedJudgeCandidate,
} from "./schema";
import {
	advanceConversationMemoryWatermark,
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
	  }
	| { status: "empty" }
	| { status: "failed"; reason: string };

const REVIEW_OPEN_CAP = 10;
const REVIEW_EXPIRY_DAYS = 30;
const DAY_MS = 86_400_000;

export async function runMemoryJudgeOnSegment(params: {
	userId: string;
	conversationId: string;
	trigger: JudgeTrigger;
	segmentOverride?: JudgeSegmentMessage[];
}): Promise<JudgeRunResult> {
	const config = getConfig();
	let segmentMessages: JudgeSegmentMessage[];
	let highestSequence = 0;
	if (params.segmentOverride) {
		segmentMessages = params.segmentOverride;
	} else {
		const segment = await getUnjudgedConversationSegment(params);
		if (segment.count === 0) return { status: "empty" };
		segmentMessages = segment.messages;
		highestSequence = segment.highestSequence;
	}

	const [summary, projectId, activeContext] = await Promise.all([
		getConversationSummary({
			userId: params.userId,
			conversationId: params.conversationId,
		}).catch(() => null),
		getConversationProjectId(params.userId, params.conversationId).catch(
			() => null,
		),
		getActiveMemoryProfileContext({ userId: params.userId }),
	]);

	let decisions: JudgeDecision[];
	let rejected: RejectedJudgeCandidate[] = [];
	try {
		const { sendJsonControlMessage } = await import(
			"../normal-chat-control-model"
		);
		const res = await sendJsonControlMessage(
			buildJudgeUserMessage({
				segment: segmentMessages,
				conversationSummary: summary?.summary ?? null,
				existingFacts: activeContext.items.map((i) => ({
					id: i.id,
					statement: i.statement,
					category: i.category,
				})),
				projectId,
			}),
			config.memoryJudgeModel,
			{
				systemPrompt: buildJudgeSystemPrompt(),
				temperature: 0,
				// Scale with segment length: a reasoning model's chain-of-thought
				// grows with the conversation it must weigh and counts against
				// max_tokens on these providers. A flat budget silently truncates
				// long conversations into all-reasoning, zero-decision responses
				// (verified: an 87-message segment yielded 0 decisions at 2400 and
				// 3 clean decisions at 8000).
				maxTokens: reasoningAwareMaxTokens(segmentMessages.length),
				jsonSchema: JUDGE_JSON_SCHEMA,
				allowReasoningFallback: true,
			},
		);
		({ decisions, rejected } = parseJudgeDecisionsDetailed(res.text));
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
		return { status: "ran", admitted: 0, review: 0, updated: 0, dryRun: true };
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

		if (d.action === "update" || d.action === "strengthen") {
			if (!d.targetItemId) continue;
			const target = activeContext.items.find((i) => i.id === d.targetItemId);
			if (!target) continue;
			// Never touch user-authored items. Read the item metadata directly
			// rather than relying on read-model detail (which does not expose it).
			if (await isUserAuthoredItem(params.userId, d.targetItemId)) continue;
			const patched = await updateMemoryProfileItemWithRevision({
				userId: params.userId,
				itemId: d.targetItemId,
				expectedProjectionRevision: projectionRevision,
				patch: d.action === "update" ? { statement: d.statement } : {},
			});
			if (patched.status === "updated") {
				projectionRevision = patched.projectionRevision;
				updated++;
				await addProvenanceForItem(params, d.targetItemId, d);
				await refreshFactEmbedding(params.userId, d.targetItemId, d.statement);
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
			await applyItemMetadata(
				params.userId,
				item.id,
				metadata,
				d,
				new Date(Date.now() + REVIEW_EXPIRY_DAYS * DAY_MS),
			);
			await addProvenanceForItem(params, item.id, d);
			await createOrUpdateMemoryReviewItem({
				userId: params.userId,
				subjectKey: `judge:${item.itemKey}`,
				subjectLabel: d.statement,
				question: "Should I keep remembering this?",
				reason: "Inferred from conversation, not stated directly.",
				affectedItemIds: [item.id],
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

	return { status: "ran", admitted, review, updated, dryRun: false };
}

async function isUserAuthoredItem(
	userId: string,
	itemId: string,
): Promise<boolean> {
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
	if (!row) return false;
	return isUserAuthoredMemoryMetadata(row.metadataJson);
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
	await db
		.update(memoryProfileItems)
		.set({
			metadataJson: JSON.stringify(meta),
			...(expiresAt ? { expiresAt } : {}),
		})
		.where(
			and(
				eq(memoryProfileItems.id, itemId),
				eq(memoryProfileItems.userId, userId),
			),
		);
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
