import { and, asc, count, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { conversationMemoryWatermarks, messages } from "$lib/server/db/schema";

export type UnjudgedSegment = {
	messages: Array<{ role: "user" | "assistant"; content: string }>;
	/**
	 * The highest message sequence contained in THIS segment (the batch actually
	 * returned in `messages`). The caller advances the watermark to this value,
	 * so it must never exceed a sequence that was included in the batch —
	 * otherwise unseen messages would be marked judged. See `getUnjudged
	 * ConversationSegment` for the oldest-first invariant.
	 */
	highestSequence: number;
	/** Number of messages in this segment (i.e. `messages.length`). */
	count: number;
	/**
	 * Count of still-unjudged messages that did NOT fit in this segment (the
	 * backlog beyond `maxMessages`). When > 0 the caller must re-drain the
	 * conversation in a later pass. Zero when the whole backlog fit.
	 */
	remaining: number;
};

const JUDGED_ROLES = ["user", "assistant"] as const;

async function getWatermark(conversationId: string): Promise<number> {
	const row = await db.query.conversationMemoryWatermarks.findFirst({
		where: eq(conversationMemoryWatermarks.conversationId, conversationId),
	});
	return row?.lastJudgedSequence ?? 0;
}

export async function countUnjudgedMessages(params: {
	userId: string;
	conversationId: string;
}): Promise<number> {
	const watermark = await getWatermark(params.conversationId);
	const [row] = await db
		.select({ n: count() })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, params.conversationId),
				inArray(messages.role, JUDGED_ROLES),
				gt(messages.messageSequence, watermark),
			),
		);
	return row?.n ?? 0;
}

export async function getUnjudgedConversationSegment(params: {
	userId: string;
	conversationId: string;
	maxMessages?: number;
}): Promise<UnjudgedSegment> {
	const maxMessages = params.maxMessages ?? 50;
	const watermark = await getWatermark(params.conversationId);
	const rows = await db
		.select({
			role: messages.role,
			content: messages.content,
			seq: messages.messageSequence,
		})
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, params.conversationId),
				inArray(messages.role, JUDGED_ROLES),
				gt(messages.messageSequence, watermark),
			),
		)
		.orderBy(asc(messages.messageSequence));

	// Judge OLDEST-first: take the oldest `maxMessages` rows and advance the
	// watermark only to the highest sequence in THAT batch. Any surplus stays
	// unjudged for a later pass. (Previously this kept the NEWEST `maxMessages`
	// but advanced the watermark to the top of the FULL set — silently marking
	// the un-sent older messages judged. That was the D1 intake-loss defect.)
	const kept = rows.slice(0, maxMessages);
	const highestSequence = kept.length
		? (kept[kept.length - 1].seq ?? watermark)
		: 0;

	return {
		messages: kept.map((r) => ({
			role: r.role as "user" | "assistant",
			content: r.content,
		})),
		highestSequence,
		count: kept.length,
		remaining: rows.length - kept.length,
	};
}

/**
 * Highest `messageSequence` among the given judgeable (user/assistant) message
 * ids in a conversation. Used by the explicit "remember that…" path, which
 * judges a synthesised exchange (not a loaded segment) and therefore has no
 * segment `highestSequence` to advance the watermark with. Threading the real
 * sequence of the just-persisted turn lets that path mark those messages judged
 * so they are never re-counted by a later marathon/idle/sweep pass. Unknown or
 * empty id sets return 0 (a safe no-op under the caller's `> 0` guard).
 */
export async function getMaxJudgedMessageSequence(params: {
	conversationId: string;
	messageIds: string[];
}): Promise<number> {
	if (params.messageIds.length === 0) return 0;
	const [row] = await db
		.select({
			maxSeq: sql<number | null>`max(${messages.messageSequence})`,
		})
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, params.conversationId),
				inArray(messages.id, params.messageIds),
				inArray(messages.role, JUDGED_ROLES),
			),
		);
	return row?.maxSeq ?? 0;
}

export async function advanceConversationMemoryWatermark(params: {
	userId: string;
	conversationId: string;
	lastJudgedSequence: number;
}): Promise<void> {
	await db
		.insert(conversationMemoryWatermarks)
		.values({
			conversationId: params.conversationId,
			userId: params.userId,
			lastJudgedSequence: params.lastJudgedSequence,
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: conversationMemoryWatermarks.conversationId,
			set: {
				lastJudgedSequence: sql`max(${conversationMemoryWatermarks.lastJudgedSequence}, ${params.lastJudgedSequence})`,
				updatedAt: new Date(),
			},
		});
}
