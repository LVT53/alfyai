import { randomUUID } from "node:crypto";
import { and, eq, gte, isNotNull, lte } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	memoryProfileItemProvenance,
	memoryProfileItems,
} from "$lib/server/db/schema";
import { refreshFactEmbedding } from "../memory-judge";
import {
	createMemoryProfileItem,
	ensureProjectionState,
	expireOverdueActiveMemoryProfileItems,
	expireOverdueReviewMemoryProfileItems,
	mergeMemoryProfileItemMetadata,
	updateMemoryProfileItemWithRevision,
} from "../memory-profile/projection-store";
import { getCurrentMemoryResetGeneration } from "../memory-profile/reset-generation";
import {
	assertMemoryProfileCategory,
	isUserAuthoredMemoryMetadata,
	parseMemoryItemMetadata,
} from "../memory-profile/types";

const DAY_MS = 86_400_000;
const RENEW_EXPIRES_WITHIN_DAYS = 7;
const RENEW_TOUCHED_WITHIN_DAYS = 14;
const RENEW_EXTENSION_DAYS = 30;

export type ConsolidationAction = {
	type: "expired" | "renewed" | "superseded" | "merged";
	itemIds: string[];
	resultItemId?: string;
	description: string;
	undo: Array<{
		itemId: string;
		prevStatus: string;
		prevStatement: string;
		prevExpiresAt?: string | null;
	}>;
};

export const CONSOLIDATION_JSON_SCHEMA = {
	name: "memory_consolidation_actions",
	strict: true as const,
	schema: {
		type: "object",
		additionalProperties: false,
		required: ["actions"],
		properties: {
			actions: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["type"],
					properties: {
						type: { type: "string", enum: ["supersede", "merge"] },
						winnerId: { type: "string" },
						loserId: { type: "string" },
						itemIds: { type: "array", items: { type: "string" } },
						mergedStatement: { type: "string" },
						category: { type: "string" },
						scope: { type: "string", enum: ["global", "project"] },
					},
				},
			},
		},
	},
};

const CONSOLIDATION_SYSTEM_PROMPT =
	"You maintain a user's memory facts. Identify (a) pairs where a newer fact " +
	"contradicts/supersedes an older one, (b) clusters that state the same thing " +
	"and should merge into one richer first-person sentence. Only propose actions " +
	"you are certain about; an empty list is the normal result.";

/**
 * Merge a metadata patch into the item's existing metadataJson so we never
 * clobber confidence/expiryClass/origin written by intake or the judge.
 */
async function mergeItemMetadata(
	userId: string,
	itemId: string,
	patch: Record<string, unknown>,
): Promise<void> {
	await mergeMemoryProfileItemMetadata({ userId, itemId, patch });
}

/**
 * Step: expire overdue items and renew still-relevant time-bound ones.
 *
 * Order of operations matters: RENEW runs first so that a renewable item is
 * not swept by the expiry pass in the same run.
 */
export async function runExpireAndRenew(params: {
	userId: string;
}): Promise<ConsolidationAction[]> {
	const { userId } = params;
	const now = new Date();
	const resetGeneration = await getCurrentMemoryResetGeneration(userId);
	const projection = await ensureProjectionState({ userId, resetGeneration });
	const actions: ConsolidationAction[] = [];
	let renewedCount = 0;

	// 1. RENEW: active time_bound items expiring within the next 7 days AND
	//    touched within the last 14 days → extend expiresAt by +30 days.
	const renewWindowEnd = new Date(
		now.getTime() + RENEW_EXPIRES_WITHIN_DAYS * DAY_MS,
	);
	const renewTouchedAfter = new Date(
		now.getTime() - RENEW_TOUCHED_WITHIN_DAYS * DAY_MS,
	);
	const renewCandidates = await db
		.select()
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, userId),
				eq(memoryProfileItems.resetGeneration, resetGeneration),
				eq(memoryProfileItems.status, "active"),
				isNotNull(memoryProfileItems.expiresAt),
				gte(memoryProfileItems.expiresAt, now),
				lte(memoryProfileItems.expiresAt, renewWindowEnd),
				gte(memoryProfileItems.updatedAt, renewTouchedAfter),
			),
		);

	for (const item of renewCandidates) {
		if (parseMemoryItemMetadata(item.metadataJson).expiryClass !== "time_bound")
			continue;
		if (isUserAuthoredMemoryMetadata(item.metadataJson)) continue;
		if (!item.expiresAt) continue;
		const prevExpiresAt = item.expiresAt;
		const nextExpiresAt = new Date(
			prevExpiresAt.getTime() + RENEW_EXTENSION_DAYS * DAY_MS,
		);
		await db
			.update(memoryProfileItems)
			.set({ expiresAt: nextExpiresAt, updatedAt: now })
			.where(
				and(
					eq(memoryProfileItems.userId, userId),
					eq(memoryProfileItems.id, item.id),
				),
			)
			.run();
		renewedCount += 1;
		actions.push({
			type: "renewed",
			itemIds: [item.id],
			description: `Renewed time-bound fact "${item.statement}" (expiry ${prevExpiresAt.toISOString()} → ${nextExpiresAt.toISOString()}).`,
			undo: [
				{
					itemId: item.id,
					prevStatus: item.status,
					prevStatement: item.statement,
					prevExpiresAt: prevExpiresAt.toISOString(),
				},
			],
		});
	}
	// Renewals wrote to the items table directly, so bump the projection
	// revision by the number of renewals (the expiry helpers below bump their
	// own counts). This keeps revision discipline consistent across writers.
	if (renewedCount > 0) {
		const { bumpProjectionRevision } = await import(
			"../memory-profile/projection-store"
		);
		bumpProjectionRevision({
			projectionStateId: projection.id,
			amount: renewedCount,
			now,
		});
	}

	// 2. EXPIRE (active): first capture the exact ids so the action can list
	//    them, then expire through the shared code path (single expiry mechanism).
	const overdueActives = await db
		.select({
			id: memoryProfileItems.id,
			statement: memoryProfileItems.statement,
			status: memoryProfileItems.status,
		})
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, userId),
				eq(memoryProfileItems.resetGeneration, resetGeneration),
				eq(memoryProfileItems.status, "active"),
				isNotNull(memoryProfileItems.expiresAt),
				lte(memoryProfileItems.expiresAt, now),
			),
		);
	if (overdueActives.length > 0) {
		await expireOverdueActiveMemoryProfileItems({
			userId,
			resetGeneration,
			projectionStateId: projection.id,
			now,
		});
		actions.push({
			type: "expired",
			itemIds: overdueActives.map((r) => r.id),
			description: `Expired ${overdueActives.length} overdue active memory fact(s) past their expiry date.`,
			undo: overdueActives.map((r) => ({
				itemId: r.id,
				prevStatus: r.status,
				prevStatement: r.statement,
			})),
		});
	}

	// 3. EXPIRE (review queue): expire overdue review_needed items and close
	//    their open review rows. Capture ids first for the action record.
	const overdueReviews = await db
		.select({
			id: memoryProfileItems.id,
			statement: memoryProfileItems.statement,
			status: memoryProfileItems.status,
		})
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, userId),
				eq(memoryProfileItems.resetGeneration, resetGeneration),
				eq(memoryProfileItems.status, "review_needed"),
				isNotNull(memoryProfileItems.expiresAt),
				lte(memoryProfileItems.expiresAt, now),
			),
		);
	if (overdueReviews.length > 0) {
		await expireOverdueReviewMemoryProfileItems({
			userId,
			resetGeneration,
			projectionStateId: projection.id,
			now,
		});
		actions.push({
			type: "expired",
			itemIds: overdueReviews.map((r) => r.id),
			description: `Expired ${overdueReviews.length} overdue review-queue item(s) and closed their open review rows.`,
			undo: overdueReviews.map((r) => ({
				itemId: r.id,
				prevStatus: r.status,
				prevStatement: r.statement,
			})),
		});
	}

	return actions;
}

type ConsolidationLlmAction = {
	type: "supersede" | "merge";
	winnerId?: string;
	loserId?: string;
	itemIds?: string[];
	mergedStatement?: string;
	category?: string;
	scope?: "global" | "project";
};

/**
 * Step: reconcile contradictions (supersede) and merge duplicates via a single
 * LLM call over the user's active facts. user_authored items are excluded from
 * candidacy and every referenced id is validated before any write.
 */
export async function runReconcileAndMerge(params: {
	userId: string;
}): Promise<ConsolidationAction[]> {
	const { userId } = params;
	const config = getConfig();
	const resetGeneration = await getCurrentMemoryResetGeneration(userId);

	const activeItems = await db
		.select()
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, userId),
				eq(memoryProfileItems.resetGeneration, resetGeneration),
				eq(memoryProfileItems.status, "active"),
			),
		);

	// Candidates presented to the model exclude user_authored items so they are
	// never proposed as losers/merge members.
	const candidates = activeItems.filter(
		(i) => !isUserAuthoredMemoryMetadata(i.metadataJson),
	);
	if (candidates.length === 0) return [];

	// Fast lookup of the current, active, non-user-authored candidate set.
	const candidateById = new Map(candidates.map((i) => [i.id, i]));

	const userMessage = JSON.stringify({
		facts: candidates.map((i) => ({
			id: i.id,
			statement: i.statement,
			category: i.category,
		})),
	});

	let llmActions: ConsolidationLlmAction[];
	try {
		const { sendJsonControlMessage } = await import(
			"../normal-chat-control-model"
		);
		const res = await sendJsonControlMessage(
			userMessage,
			config.memoryConsolidationModel,
			{
				systemPrompt: CONSOLIDATION_SYSTEM_PROMPT,
				temperature: 0,
				jsonSchema: CONSOLIDATION_JSON_SCHEMA,
				allowReasoningFallback: true,
			},
		);
		const parsed = JSON.parse(res.text) as {
			actions?: ConsolidationLlmAction[];
		};
		llmActions = Array.isArray(parsed.actions) ? parsed.actions : [];
	} catch {
		return [];
	}

	const actions: ConsolidationAction[] = [];
	// Track projection revision across sequential writes so
	// updateMemoryProfileItemWithRevision does not fail with stale_projection.
	const projection = await ensureProjectionState({ userId, resetGeneration });
	let projectionRevision = projection.revision;
	// Items retired earlier in this run must not be reused by later actions.
	const consumed = new Set<string>();

	const isValidCandidate = (id: string | undefined): id is string =>
		typeof id === "string" && candidateById.has(id) && !consumed.has(id);

	for (const action of llmActions) {
		if (action.type === "supersede") {
			const winnerId = action.winnerId;
			const loserId = action.loserId;
			// Winner must exist+active (may be user_authored — allowed as a winner);
			// loser must be a valid, non-user-authored candidate.
			if (!isValidCandidate(loserId)) continue;
			if (
				typeof winnerId !== "string" ||
				winnerId === loserId ||
				!(
					candidateById.has(winnerId) ||
					activeItems.some((i) => i.id === winnerId)
				)
			) {
				continue;
			}
			const loser = candidateById.get(loserId);
			if (!loser) continue;

			const patched = await updateMemoryProfileItemWithRevision({
				userId,
				itemId: loserId,
				expectedProjectionRevision: projectionRevision,
				patch: { status: "retired" },
			});
			if (patched.status !== "updated") continue;
			projectionRevision = patched.projectionRevision;
			await mergeItemMetadata(userId, loserId, { supersededBy: winnerId });
			consumed.add(loserId);

			actions.push({
				type: "superseded",
				itemIds: [loserId],
				resultItemId: winnerId,
				description: `Retired "${loser.statement}" as superseded by a newer fact.`,
				undo: [
					{
						itemId: loserId,
						prevStatus: loser.status,
						prevStatement: loser.statement,
					},
				],
			});
			continue;
		}

		if (action.type === "merge") {
			const memberIds = (action.itemIds ?? []).filter(isValidCandidate);
			// Deduplicate while preserving order.
			const uniqueMemberIds = [...new Set(memberIds)];
			if (
				uniqueMemberIds.length < 2 ||
				typeof action.mergedStatement !== "string" ||
				action.mergedStatement.trim().length === 0 ||
				typeof action.category !== "string"
			) {
				continue;
			}
			let category: string;
			try {
				assertMemoryProfileCategory(action.category);
				category = action.category;
			} catch {
				continue;
			}
			const members = uniqueMemberIds.map((id) => candidateById.get(id));
			if (members.some((m) => !m)) continue;

			// Create the merged item first so members can point at it.
			const created = await createMemoryProfileItem({
				userId,
				category: category as Parameters<
					typeof createMemoryProfileItem
				>[0]["category"],
				scope: { type: "global" },
				statement: action.mergedStatement,
				status: "active",
			});
			projectionRevision = created.projectionRevision;
			await mergeItemMetadata(userId, created.id, { origin: "consolidation" });

			// Best-effort: refresh the merged item's semantic embedding so the new
			// statement is recall-searchable. Fire-and-forget; never fails the merge.
			await refreshFactEmbedding(userId, created.id, action.mergedStatement);

			// Copy provenance rows from every member to the merged item.
			for (const memberId of uniqueMemberIds) {
				const provRows = await db
					.select()
					.from(memoryProfileItemProvenance)
					.where(eq(memoryProfileItemProvenance.itemId, memberId));
				for (const prov of provRows) {
					await db
						.insert(memoryProfileItemProvenance)
						.values({
							id: randomUUID(),
							itemId: created.id,
							userId,
							resetGeneration: prov.resetGeneration,
							sourceType: prov.sourceType,
							sourceId: prov.sourceId,
							label: prov.label,
							summary: prov.summary,
							metadataJson: prov.metadataJson,
							createdAt: prov.createdAt,
						})
						.run();
				}
			}

			// Retire the members and record mergedInto.
			const undo: ConsolidationAction["undo"] = [];
			for (const memberId of uniqueMemberIds) {
				const member = candidateById.get(memberId);
				if (!member) continue;
				const patched = await updateMemoryProfileItemWithRevision({
					userId,
					itemId: memberId,
					expectedProjectionRevision: projectionRevision,
					patch: { status: "retired" },
				});
				if (patched.status === "updated") {
					projectionRevision = patched.projectionRevision;
				}
				await mergeItemMetadata(userId, memberId, { mergedInto: created.id });
				consumed.add(memberId);
				undo.push({
					itemId: memberId,
					prevStatus: member.status,
					prevStatement: member.statement,
				});
			}

			actions.push({
				type: "merged",
				itemIds: uniqueMemberIds,
				resultItemId: created.id,
				description: `Merged ${uniqueMemberIds.length} duplicate facts into "${action.mergedStatement}".`,
				undo,
			});
		}
	}

	return actions;
}
