// The user message an Atlas job was started from.
//
// A job row carries its assistant message, not its user message: the kickoff
// is the latest user message before that assistant message in the same
// conversation. The worker reads the job's query off it, and a lifecycle
// child's seed reads the PARENT's kickoff links off it (the documents a v1/v2
// parent was given), so the lookup lives here once rather than in both.

import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { messages } from "$lib/server/db/schema";

export async function resolveAtlasKickoffMessage(job: {
	conversationId: string;
	assistantMessageId: string | null;
}): Promise<{ query: string | null; userMessageId: string | null }> {
	if (!job.assistantMessageId) return { query: null, userMessageId: null };
	const [assistantMessage] = await db
		.select()
		.from(messages)
		.where(eq(messages.id, job.assistantMessageId))
		.limit(1);
	if (!assistantMessage) return { query: null, userMessageId: null };

	const sequence = assistantMessage.messageSequence;
	const [userMessage] = await db
		.select()
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, job.conversationId),
				eq(messages.role, "user"),
				sequence === null
					? sql`${messages.createdAt} <= ${assistantMessage.createdAt}`
					: lt(messages.messageSequence, sequence),
			),
		)
		.orderBy(desc(messages.messageSequence), desc(messages.createdAt))
		.limit(1);

	return {
		query: userMessage?.content ?? null,
		userMessageId: userMessage?.id ?? null,
	};
}
