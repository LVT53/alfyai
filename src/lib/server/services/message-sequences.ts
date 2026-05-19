import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm/sql";
import { db } from "$lib/server/db";

export type MessageSequenceExecutor = {
	run: (query: SQL<unknown>) => unknown;
};

export function repairConversationMessageSequencesWithExecutor(
	executor: MessageSequenceExecutor,
	conversationId: string,
): void {
	executor.run(sql`
		UPDATE messages
		SET message_sequence = NULL
		WHERE conversation_id = ${conversationId}
	`);
	executor.run(sql`
		WITH ranked_messages AS (
			SELECT
				rowid AS message_rowid,
				ROW_NUMBER() OVER (
					PARTITION BY conversation_id
					ORDER BY created_at ASC, rowid ASC
				) AS conversation_sequence
			FROM messages
			WHERE conversation_id = ${conversationId}
		)
		UPDATE messages
		SET message_sequence = (
			SELECT conversation_sequence
			FROM ranked_messages
			WHERE ranked_messages.message_rowid = messages.rowid
		)
		WHERE conversation_id = ${conversationId}
	`);
}

export function repairConversationMessageSequences(
	conversationId: string,
): void {
	const maybeDb = db as {
		transaction?: (
			callback: (tx: MessageSequenceExecutor) => unknown,
		) => unknown;
	};
	if (typeof maybeDb.transaction !== "function") return;

	maybeDb.transaction((tx) => {
		repairConversationMessageSequencesWithExecutor(tx, conversationId);
	});
}
