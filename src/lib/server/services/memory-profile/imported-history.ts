import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	memoryAccounts,
	memoryDeliveryJobs,
	memorySourceRevisions,
	messages,
	users,
} from "$lib/server/db/schema";
import {
	type EnqueueMemoryDelivery,
	enqueueMemoryMutation,
} from "./delivery-job";
import { inspectMemoryMigration } from "./migration-progress";
import {
	ensureMemoryBank,
	memoryScopeKey,
	memoryTextHash,
	recordMemorySource,
} from "./revisions";

/** Sources recorded per write, so a long import never holds the database long. */
const IMPORTED_HISTORY_BATCH = 200;
/** Claimed after the person's own turns, removals and cleanups (default 0). */
const IMPORTED_HISTORY_PRIORITY = 10;

/**
 * Whether any imported message of the person (in the given chats) has no live
 * source yet: the cheap question asked before any inventory is built, so a
 * maintenance pass for an account with nothing owed costs one query.
 */
function importedHistoryOwed(
	userId: string,
	conversationIds?: readonly string[],
) {
	const inChats = conversationIds
		? sql`AND c.id IN (SELECT value FROM json_each(${JSON.stringify(conversationIds)}))`
		: sql``;
	return Boolean(
		db.get(sql`
			SELECT 1 FROM messages m
			JOIN conversations c ON c.id = m.conversation_id
			WHERE c.user_id = ${userId}
				AND m.role = 'user'
				AND m.import_source IS NOT NULL
				AND m.created_at < c.created_at
				AND (CASE WHEN json_valid(m.metadata_json)
					THEN json_extract(m.metadata_json, '$.importedBranchCopy') END) IS NOT 1
				${inChats}
				AND NOT EXISTS (
					SELECT 1 FROM memory_source_revisions s
					WHERE s.user_id = ${userId}
						AND s.message_id = m.id
						AND s.state <> 'revoked'
				)
			LIMIT 1
		`),
	);
}

/**
 * Chats an import (a ChatGPT export) brings into an account already on native
 * Memory are earlier history that no preparation will see again, and no turn
 * delivers them. Record a source for each of the person's imported messages
 * the history rules admit, judged by the message's own date (Memory on, a
 * recorded decline, periods when Memory was off, a past Clear Memory, the
 * chat's scope), with preparation's own event id, lineage, context and
 * request id, and queue its delivery behind the person's own work. Nothing
 * else in the history is touched and no manifest is written.
 *
 * An imported message is taken up only when it has no source at all, or only
 * sources the Memory switch revoked (a deletion, a move or a withdrawal is
 * never undone here). One that a legacy removal or edit, a native correction
 * or an explicit edit touches is left to a preparation, which replays those
 * with it. With conversation ids it takes up those chats; without, every
 * imported chat still owed (after a restart, or when Memory comes back on),
 * chats imported before this rule existed included. An account still
 * preparing is left to its operator's preparation and a legacy account to the
 * memory judge, and no memory account is created here.
 *
 * Returns how many sources it recorded.
 */
export async function recordImportedHistory(
	userId: string,
	conversationIds?: readonly string[],
	batchSize = IMPORTED_HISTORY_BATCH,
): Promise<number> {
	const account = db
		.select()
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, userId))
		.get();
	if (account?.authority !== "hindsight" || account.lifecycleState !== "active")
		return 0;
	if (!importedHistoryOwed(userId, conversationIds)) return 0;
	// Built outside the write barrier; each batch checks it still holds.
	const inventory = inspectMemoryMigration(userId);
	const wanted = conversationIds ? new Set(conversationIds) : null;
	const replayed = new Set(inventory.actions.flatMap((a) => a.sourceIds));
	const owed = inventory.sources.filter(
		(source) =>
			source.imported === true &&
			source.eligibility === "eligible" &&
			source.conversationId !== null &&
			(!wanted || wanted.has(source.conversationId)) &&
			!replayed.has(source.id) &&
			!source.replayActionIds?.length &&
			!source.explicitEditAt,
	);
	let recorded = 0;
	for (let start = 0; start < owed.length; start += batchSize) {
		const batch = owed.slice(start, start + batchSize);
		let stop = false;
		await enqueueMemoryMutation((tx) => {
			const current = tx
				.select()
				.from(memoryAccounts)
				.where(eq(memoryAccounts.userId, userId))
				.get();
			const enabled = tx
				.select({ enabled: users.memoryEnabled })
				.from(users)
				.where(eq(users.id, userId))
				.get()?.enabled;
			// A control change since the inventory (Memory off, a decline, a
			// reset) leaves the rest to the next catch-up, which reads it anew.
			if (
				current?.authority !== "hindsight" ||
				current.lifecycleState !== "active" ||
				current.epoch !== inventory.epoch ||
				current.controlRevision !== inventory.controlRevision ||
				!enabled
			) {
				stop = true;
				return [];
			}
			const ids = batch.map((source) => source.id);
			const existing = tx
				.select()
				.from(memorySourceRevisions)
				.where(
					and(
						eq(memorySourceRevisions.userId, userId),
						eq(memorySourceRevisions.epoch, current.epoch),
						inArray(memorySourceRevisions.messageId, ids),
					),
				)
				.all();
			const revoked = existing.filter((row) => row.state === "revoked");
			const switchedOff = new Set(
				(revoked.length
					? tx
							.select({ requestId: memoryDeliveryJobs.requestId })
							.from(memoryDeliveryJobs)
							.where(
								and(
									eq(memoryDeliveryJobs.userId, userId),
									inArray(
										memoryDeliveryJobs.requestId,
										revoked.map((row) => `disabled-cleanup:${row.id}`),
									),
								),
							)
							.all()
					: []
				).map(({ requestId }) => requestId.slice("disabled-cleanup:".length)),
			);
			const stored = new Map(
				tx
					.select()
					.from(messages)
					.where(inArray(messages.id, ids))
					.all()
					.map((message) => [message.id, message]),
			);
			const banks = new Map<string, ReturnType<typeof ensureMemoryBank>>();
			const jobs: EnqueueMemoryDelivery[] = [];
			for (const source of batch) {
				const rows = existing.filter((row) => row.messageId === source.id);
				if (
					rows.some(
						(row) => row.state !== "revoked" || !switchedOff.has(row.id),
					)
				)
					continue;
				const message = stored.get(source.id);
				if (
					!message?.importSource ||
					memoryTextHash(message.content) !== memoryTextHash(source.text) ||
					message.createdAt.toISOString() !== source.messageAt
				)
					continue;
				const scopeKey = memoryScopeKey(source.scope);
				const bank =
					banks.get(scopeKey) ?? ensureMemoryBank(userId, source.scope);
				banks.set(scopeKey, bank);
				const earlier = rows.filter((row) => row.bankId === bank.id).length;
				const textHash = memoryTextHash(source.text);
				const row = recordMemorySource({
					userId,
					bankId: bank.id,
					epoch: current.epoch,
					eventId: `migration-message:${source.id}:${bank.id}:${earlier}`,
					lineageId: source.lineageId,
					text: source.text,
					context: JSON.stringify({
						migration: true,
						migrationMessageAt: source.messageAt,
						migrationDefaultHistory: source.defaultHistory,
						migrationImported: true,
						// An import makes new chats, and an imported message is never
						// context (migration.ts), so nothing comes before it.
						messages: source.defaultHistory
							? []
							: [
									{
										id: source.id,
										role: "user",
										sourceId: "$current",
										textHash,
									},
								],
					}),
					assertedAt: new Date(source.assertedAt),
					conversationId: source.conversationId,
					messageId: source.id,
				});
				recorded++;
				jobs.push({
					userId,
					bankId: bank.id,
					epoch: current.epoch,
					kind: "source",
					sourceId: row.id,
					// Preparation's request id for a source no action touches.
					requestId: `source:${row.id}:${memoryTextHash(JSON.stringify([]))}`,
					priority: IMPORTED_HISTORY_PRIORITY,
				});
			}
			return jobs;
		});
		if (stop) break;
		// Let chat streams run between batches.
		await new Promise((resolve) => setImmediate(resolve));
	}
	return recorded;
}

/** A code for the log: never an error's message, which can carry chat text. */
function errorCode(error: unknown) {
	if (error instanceof Error && /^memory_[a-z0-9_]{2,80}$/.test(error.message))
		return error.message;
	return error instanceof Error ? error.name : "unknown";
}

/**
 * `recordImportedHistory` for the places that must not fail because of it:
 * the import itself, Memory switched on, and maintenance. A failure leaves
 * the messages owed, and the next of those catches them up.
 */
export async function catchUpImportedHistory(
	userId: string,
	trigger: "import" | "memory_on" | "maintenance",
	conversationIds?: readonly string[],
): Promise<number> {
	try {
		return await recordImportedHistory(userId, conversationIds);
	} catch (error) {
		console.error(
			`[MEMORY_MAINTENANCE] imported history not taken up trigger=${trigger} code=${errorCode(error)}`,
		);
		return 0;
	}
}
