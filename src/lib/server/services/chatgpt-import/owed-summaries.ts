// The summaries a ChatGPT import still owes, and the one drain that writes them.
//
// The import answers before its conversations are summarized: a summary is a
// model call per conversation, and one import can bring hundreds. A restart
// used to lose every summary not yet written, and nothing else writes one for
// an imported chat until the person talks in it; history recall, a project's
// context and the memory judge all read it.
//
// No row records the debt: it is read from what is stored. A conversation is
// owed a summary when its first message came from a ChatGPT import, it is not
// a fork (the import never summarized those) and not incognito, it has no
// `conversation_summaries` row, and it was made after the person last cleared
// their memory. A Clear Memory deletes every summary on purpose, and must not
// be undone here.
//
// `startImportedSummaryDrain` writes them in the background, one conversation
// at a time per person. The import starts it once its conversations are
// stored, and memory maintenance starts it again, so a restart only pauses
// it. The drain stops at the first summary that fails (most likely the model
// is unavailable; the next start goes on), and this process tries the same
// conversation again only after `RETRY_AFTER_MS`.

import {
	and,
	asc,
	eq,
	exists,
	gte,
	inArray,
	notExists,
	sql,
} from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	conversationForks,
	conversationSummaries,
	conversations,
	memoryResetGenerations,
	messages,
} from "$lib/server/db/schema";
import { buildConversationContextScopeCondition } from "$lib/server/services/conversation-scope";
import {
	getCurrentMemoryResetGeneration,
	isCurrentMemoryResetGeneration,
} from "$lib/server/services/memory-profile/reset-generation";
import { summarizeConversation } from "./summarizer";

/** How long this process leaves a conversation it tried before trying it again. */
const RETRY_AFTER_MS = 24 * 60 * 60_000;

/** When this process last tried each conversation, whatever came of it. */
const triedAt = new Map<string, number>();

/** One drain per person; `again` asks a running drain for one more pass. */
const drains = new Map<string, { done: Promise<void>; again: boolean }>();

function listConversationsOwedASummary(
	userId: string,
): Array<{ id: string; title: string }> {
	const lastReset =
		db
			.select({ advancedAt: memoryResetGenerations.advancedAt })
			.from(memoryResetGenerations)
			.where(eq(memoryResetGenerations.userId, userId))
			.get()?.advancedAt ?? null;
	return db
		.select({ id: conversations.id, title: conversations.title })
		.from(conversations)
		.where(
			and(
				eq(conversations.userId, userId),
				buildConversationContextScopeCondition(),
				lastReset ? gte(conversations.createdAt, lastReset) : undefined,
				exists(
					db
						.select({ one: sql`1` })
						.from(messages)
						.where(
							and(
								eq(messages.conversationId, conversations.id),
								eq(messages.messageSequence, 1),
								eq(messages.importSource, "chatgpt"),
							),
						),
				),
				notExists(
					db
						.select({ one: sql`1` })
						.from(conversationForks)
						.where(eq(conversationForks.forkConversationId, conversations.id)),
				),
				notExists(
					db
						.select({ one: sql`1` })
						.from(conversationSummaries)
						.where(eq(conversationSummaries.conversationId, conversations.id)),
				),
			),
		)
		.orderBy(asc(conversations.createdAt), asc(conversations.id))
		.all();
}

/**
 * Store an imported conversation's summary, unless something made it moot while
 * the model was writing it: the person cleared their memory since the work
 * began (`resetGeneration` is the one it began under), the conversation was
 * deleted or turned incognito, or it already has a summary (a turn in it wrote
 * a fresher one). One transaction, so a Clear Memory cannot land between the
 * checks and the write. Returns whether it wrote.
 */
function storeOwedSummary(params: {
	userId: string;
	conversationId: string;
	summary: string;
	resetGeneration: number;
}): boolean {
	return db.transaction((tx) => {
		// As `getCurrentMemoryResetGeneration` reads it: no row yet means 0.
		const generation =
			tx
				.select({ resetGeneration: memoryResetGenerations.resetGeneration })
				.from(memoryResetGenerations)
				.where(eq(memoryResetGenerations.userId, params.userId))
				.get()?.resetGeneration ?? 0;
		if (generation !== params.resetGeneration) return false;

		const conversation = tx
			.select({ id: conversations.id })
			.from(conversations)
			.where(
				and(
					eq(conversations.id, params.conversationId),
					eq(conversations.userId, params.userId),
					// Pinned to one conversation, so incognito is spelled directly
					// (conversation-scope.ts): an incognito chat gets no summary.
					eq(conversations.memoryIncognito, false),
				),
			)
			.get();
		if (!conversation) return false;

		const now = new Date();
		const stored = tx
			.insert(conversationSummaries)
			.values({
				conversationId: params.conversationId,
				userId: params.userId,
				summary: params.summary,
				source: "chatgpt-import",
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing({ target: conversationSummaries.conversationId })
			.run();
		return stored.changes > 0;
	});
}

/** Summarize one conversation and store it. False when the model call failed. */
async function writeOwedSummary(
	userId: string,
	conversation: { id: string; title: string },
	resetGeneration: number,
): Promise<boolean> {
	const dialogue = db
		.select({ role: messages.role, content: messages.content })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, conversation.id),
				inArray(messages.role, ["user", "assistant"]),
			),
		)
		.orderBy(asc(messages.messageSequence))
		.all();
	if (dialogue.length === 0) return true;

	let summary: string;
	try {
		summary = await summarizeConversation(dialogue, conversation.title);
	} catch (error) {
		console.error(
			"[CHATGPT_IMPORT] Summarization failed for conversation",
			conversation.id,
			error,
		);
		return false;
	}
	storeOwedSummary({
		userId,
		conversationId: conversation.id,
		summary,
		resetGeneration,
	});
	return true;
}

async function drainOwedSummaries(userId: string): Promise<void> {
	const resetGeneration = await getCurrentMemoryResetGeneration(userId);
	for (;;) {
		// Asked again before every conversation: what the person did meanwhile
		// (a chat, a delete, another import, a Clear Memory) is seen at once.
		if (!(await isCurrentMemoryResetGeneration({ userId, resetGeneration }))) {
			return;
		}
		const now = Date.now();
		const next = listConversationsOwedASummary(userId).find(
			(conversation) =>
				now - (triedAt.get(conversation.id) ?? -Infinity) >= RETRY_AFTER_MS,
		);
		if (!next) return;
		// Recorded before the call, whatever comes of it, so no outcome can make
		// the drain ask the model about the same conversation twice in a row.
		triedAt.set(next.id, now);
		if (!(await writeOwedSummary(userId, next, resetGeneration))) return;
	}
}

/**
 * Write the summaries `userId`'s imports still owe, one at a time, in the
 * background. A drain already running for the person makes one more pass
 * instead of starting a second. The promise settles when the drain is done and
 * never rejects.
 */
export function startImportedSummaryDrain(userId: string): Promise<void> {
	const running = drains.get(userId);
	if (running) {
		running.again = true;
		return running.done;
	}
	const drain = { done: Promise.resolve(), again: false };
	drain.done = (async () => {
		try {
			do {
				drain.again = false;
				await drainOwedSummaries(userId);
			} while (drain.again);
		} catch (error) {
			console.error("[CHATGPT_IMPORT] Summary drain failed", {
				userId,
				error,
			});
		} finally {
			drains.delete(userId);
		}
	})();
	drains.set(userId, drain);
	return drain.done;
}
