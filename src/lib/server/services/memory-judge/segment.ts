import { and, asc, count, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { conversationMemoryWatermarks, messages } from "$lib/server/db/schema";

export type UnjudgedSegment = {
	messages: Array<{ role: "user" | "assistant"; content: string }>;
	highestSequence: number;
	count: number;
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

	const highestSequence = rows.length
		? (rows[rows.length - 1].seq ?? watermark)
		: 0;
	const kept = rows.slice(-maxMessages);

	return {
		messages: kept.map((r) => ({
			role: r.role as "user" | "assistant",
			content: r.content,
		})),
		highestSequence,
		count: rows.length,
	};
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
