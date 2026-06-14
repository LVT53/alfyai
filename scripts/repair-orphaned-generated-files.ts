/**
 * One‑time repair: backfill generated_output artifacts for chat‑generated
 * files that have no corresponding artifact row.
 *
 * Run via:  npx tsx scripts/repair-orphaned-generated-files.ts
 *
 * The root cause is a race between sandbox completion and stream
 * completion — both of which can skip syncGeneratedFilesToMemory
 * when the preconditions (assistantMessageId or newGeneratedFileIds)
 * aren't available yet.
 */
import Database from "better-sqlite3";

const DB_PATH = process.env.DATABASE_PATH ?? "./data/chat.db";
const raw = new Database(DB_PATH);

interface OrphanedFile {
	chatFileId: string;
	filename: string;
	conversationId: string;
	assistantMessageId: string | null;
}

// ── Find orphaned files ──────────────────────────────────────────

const orphaned = raw
	.prepare(
		`SELECT
       cgf.id               AS chatFileId,
       cgf.filename         AS filename,
       cgf.conversation_id  AS conversationId,
       cgf.assistant_message_id AS assistantMessageId
     FROM chat_generated_files cgf
     WHERE cgf.assistant_message_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM artifacts a
         WHERE a.conversation_id = cgf.conversation_id
           AND a.type = 'generated_output'
           AND (
             json_extract(a.metadata_json, '$.originalChatFileId') = cgf.id
             OR json_extract(a.metadata_json, '$.sourceChatFileId') = cgf.id
           )
       )
     ORDER BY cgf.created_at ASC`,
	)
	.all() as OrphanedFile[];

console.log(`Found ${orphaned.length} orphaned chat-generated files.`);

if (orphaned.length === 0) {
	console.log("Nothing to repair.");
	process.exit(0);
}

// ── Import app services ──────────────────────────────────────────

async function main() {
	const [{ syncGeneratedFilesToMemory }] = await Promise.all([
		import("$lib/server/services/chat-files"),
	]);

	let repaired = 0;
	let errors = 0;
	const skippedNoAssistant: string[] = [];

	for (const file of orphaned) {
		if (!file.assistantMessageId) {
			skippedNoAssistant.push(file.chatFileId);
			continue;
		}

		const msg = raw
			.prepare(`SELECT content FROM messages WHERE id = ?`)
			.get(file.assistantMessageId) as { content: string } | undefined;

		const assistantResponse = msg?.content ?? "";

		const userRow = raw
			.prepare(`SELECT user_id FROM conversations WHERE id = ?`)
			.get(file.conversationId) as { user_id: string } | undefined;
		if (!userRow) {
			errors++;
			console.error(`  ✗ ${file.filename}  conversation not found`);
			continue;
		}

		try {
			await syncGeneratedFilesToMemory({
				userId: userRow.user_id,
				conversationId: file.conversationId,
				assistantMessageId: file.assistantMessageId,
				fileIds: [file.chatFileId],
				assistantResponse,
			});
			repaired++;
			console.log(`  ✓ ${file.filename}  (${file.chatFileId})`);
		} catch (error) {
			errors++;
			console.error(`  ✗ ${file.filename}  (${file.chatFileId})`, error);
		}
	}

	console.log(
		`\nDone: ${repaired} repaired, ${errors} errors, ${skippedNoAssistant.length} skipped (no assistant msg).`,
	);

	if (skippedNoAssistant.length > 0) {
		console.log("Skipped files (need manual repair):", skippedNoAssistant);
	}
}

main().catch((error) => {
	console.error("Fatal:", error);
	process.exit(1);
});
