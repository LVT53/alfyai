#!/usr/bin/env tsx
/**
 * One-off, idempotent backfill: repairs `message_sequence` for conversations
 * that still have a NULL sequence on at least one message row.
 *
 * `repairConversationMessageSequences` used to run on every read path, so
 * any message inserted through a path that skipped it (a bulk write, a
 * bug, manual DB surgery) would sit with a NULL sequence until the next
 * read silently repaired it. Now that repair only runs on writes that can
 * create a sequence gap (see `src/lib/server/services/message-sequences.ts`
 * and its call sites), rows that were already NULL before that change need
 * a one-time backfill — this script is that backfill.
 *
 * Safe to run repeatedly: it only touches conversations that currently have
 * a NULL `message_sequence`; a conversation with none is left untouched, so
 * a second run over an already-repaired database is a no-op.
 *
 * Run via: npx tsx scripts/backfill-message-sequences.ts
 */
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { getDatabasePath } from "$lib/server/env";

export function backfillMessageSequences(
	databasePath: string = getDatabasePath(),
): { conversationIds: string[] } {
	const sqlite = new Database(databasePath);
	sqlite.pragma("foreign_keys = ON");

	try {
		const conversationIds = (
			sqlite
				.prepare(
					"SELECT DISTINCT conversation_id AS id FROM messages WHERE message_sequence IS NULL",
				)
				.all() as { id: string }[]
		).map((row) => row.id);

		if (conversationIds.length === 0) {
			return { conversationIds: [] };
		}

		const repairConversation = sqlite.transaction((conversationId: string) => {
			sqlite
				.prepare(
					"UPDATE messages SET message_sequence = NULL WHERE conversation_id = ?",
				)
				.run(conversationId);
			sqlite
				.prepare(
					`WITH ranked_messages AS (
						SELECT
							rowid AS message_rowid,
							ROW_NUMBER() OVER (
								PARTITION BY conversation_id
								ORDER BY created_at ASC, rowid ASC
							) AS conversation_sequence
						FROM messages
						WHERE conversation_id = ?
					)
					UPDATE messages
					SET message_sequence = (
						SELECT conversation_sequence
						FROM ranked_messages
						WHERE ranked_messages.message_rowid = messages.rowid
					)
					WHERE conversation_id = ?`,
				)
				.run(conversationId, conversationId);
		});

		for (const conversationId of conversationIds) {
			repairConversation(conversationId);
		}

		return { conversationIds };
	} finally {
		sqlite.close();
	}
}

function isDirectExecution(): boolean {
	return Boolean(
		process.argv[1] &&
			resolve(process.argv[1]) === fileURLToPath(import.meta.url),
	);
}

if (isDirectExecution()) {
	const { conversationIds } = backfillMessageSequences();
	console.log(
		`Found ${conversationIds.length} conversation(s) with NULL message sequences.`,
	);
	if (conversationIds.length === 0) {
		console.log("Nothing to repair.");
	} else {
		for (const conversationId of conversationIds) {
			console.log(`  ✓ repaired ${conversationId}`);
		}
		console.log(`\nDone: ${conversationIds.length} conversation(s) repaired.`);
	}
}
