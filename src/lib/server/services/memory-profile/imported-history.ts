import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	conversations,
	memoryAccounts,
	memoryDeliveryJobs,
	memorySourceRevisions,
	messages,
	users,
} from "$lib/server/db/schema";
import type { Tx } from "../jobs/types";
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
 * How long a whole pass that found nothing more to take up spares later
 * passes their inventory while nothing it read has changed. Anything the
 * cheap state below cannot see (a correction undone, a message whose date
 * was in the future) is picked up when it runs out.
 */
const SETTLED_FOR_MS = 6 * 60 * 60_000;

type Trigger = "import" | "memory_on" | "maintenance";
type MemoryAccount = typeof memoryAccounts.$inferSelect;
type Inventory = ReturnType<typeof inspectMemoryMigration>;
type OwedSource = Inventory["sources"][number];

/**
 * Per person: what a whole pass read when it last found nothing more it could
 * take up (declined, held, off-period or Clear Memory messages, say), and
 * when. In this process only: a restart forgets it, which costs one inventory.
 */
const settled = new Map<string, { state: string; at: number }>();

/**
 * What decides whether imported messages can be taken up, read cheaply: the
 * account's history controls and the set of imported messages. Switching
 * Memory off or on moves the control revision; a deletion, a move or a
 * withdrawal only ever takes messages out of reach.
 */
function takeUpState(userId: string, account: MemoryAccount) {
	const imported = db.get<{ n: number; total: number }>(sql`
		SELECT count(*) AS n, total(m.rowid) AS total FROM messages m
		JOIN conversations c ON c.id = m.conversation_id
		WHERE c.user_id = ${userId}
			AND m.role = 'user'
			AND m.import_source IS NOT NULL
	`);
	return JSON.stringify([
		account.tenantId,
		account.epoch,
		account.controlRevision,
		account.historyChoice,
		account.historyCutoff?.getTime() ?? null,
		account.historyPolicyVersion,
		imported?.n ?? 0,
		imported?.total ?? 0,
	]);
}

/**
 * The person's imported messages (in the given chats) that could still be
 * taken up: dated, not a branch copy, not in an incognito chat, and with no
 * source in this epoch but ones the Memory switch revoked. Read before any
 * inventory is built, so a pass with nothing owed costs this one query; it
 * joins sources through the person's banks, one index lookup per message.
 */
function owedImportedMessages(
	userId: string,
	epoch: number,
	conversationIds?: readonly string[],
): Set<string> {
	const inChats = conversationIds
		? sql`AND c.id IN (SELECT value FROM json_each(${JSON.stringify(conversationIds)}))`
		: sql``;
	return new Set(
		db
			.all<{ id: string }>(sql`
			SELECT m.id AS id FROM messages m
			JOIN conversations c ON c.id = m.conversation_id
			WHERE c.user_id = ${userId}
				AND c.memory_incognito = 0
				AND m.role = 'user'
				AND m.import_source IS NOT NULL
				AND m.created_at < c.created_at
				AND (CASE WHEN json_valid(m.metadata_json)
					THEN json_extract(m.metadata_json, '$.importedBranchCopy') END) IS NOT 1
				AND NOT EXISTS (
					SELECT 1 FROM conversation_forks f
					WHERE f.fork_conversation_id = c.id
						AND f.source_assistant_message_id_snapshot LIKE 'chatgpt:%'
				)
				${inChats}
				AND NOT EXISTS (
					SELECT 1 FROM memory_banks b
					JOIN memory_source_revisions s
						ON s.bank_id = b.id AND s.epoch = b.epoch AND s.message_id = m.id
					WHERE b.user_id = ${userId}
						AND b.epoch = ${epoch}
						AND (s.state <> 'revoked' OR NOT EXISTS (
							SELECT 1 FROM memory_delivery_jobs j
							WHERE j.user_id = ${userId}
								AND j.request_id = 'disabled-cleanup:' || s.id
						))
				)
		`)
			.map(({ id }) => id),
	);
}

interface BatchOutcome {
	/** A control changed: the rest waits for the next pass, which reads it anew. */
	stop: boolean;
	/** Something left owed that a later pass may still take up. */
	unfinished: boolean;
	recorded: number;
	failures: string[];
}

/** One batch, inside the write barrier: re-checks what the inventory saw. */
function takeUpBatch(
	tx: Tx,
	userId: string,
	before: MemoryAccount,
	inventory: Inventory,
	batch: OwedSource[],
	outcome: BatchOutcome,
): EnqueueMemoryDelivery[] {
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
	// Memory off, a reset or a history choice since the inventory. A history
	// choice leaves the control revision alone, so it is compared on its own.
	if (
		current?.authority !== "hindsight" ||
		current.lifecycleState !== "active" ||
		current.epoch !== inventory.epoch ||
		current.controlRevision !== inventory.controlRevision ||
		current.historyChoice !== before.historyChoice ||
		current.historyCutoff?.getTime() !== before.historyCutoff?.getTime() ||
		current.historyPolicyVersion !== before.historyPolicyVersion ||
		!enabled
	) {
		outcome.stop = true;
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
	const chats = new Map(
		tx
			.select({
				id: conversations.id,
				projectId: conversations.projectId,
				memoryIncognito: conversations.memoryIncognito,
			})
			.from(conversations)
			.where(
				inArray(
					conversations.id,
					[...new Set(batch.map((source) => source.conversationId))].filter(
						(id): id is string => id !== null,
					),
				),
			)
			.all()
			.map((chat) => [chat.id, chat]),
	);
	const banks = new Map<string, ReturnType<typeof ensureMemoryBank>>();
	const failedScopes = new Set<string>();
	const jobs: EnqueueMemoryDelivery[] = [];
	for (const source of batch) {
		const rows = existing.filter((row) => row.messageId === source.id);
		// A live source, or one a deletion, a move or a withdrawal revoked.
		if (rows.some((row) => row.state !== "revoked" || !switchedOff.has(row.id)))
			continue;
		const message = stored.get(source.id);
		const chat = chats.get(source.conversationId ?? "");
		const scopeKey = memoryScopeKey(source.scope);
		// Changed since the inventory (an edit, a move, incognito, a delete):
		// the next pass judges it as it is then.
		if (
			!message?.importSource ||
			memoryTextHash(message.content) !== memoryTextHash(source.text) ||
			message.createdAt.toISOString() !== source.messageAt ||
			!chat ||
			chat.memoryIncognito ||
			(chat.projectId ? `project:${chat.projectId}` : "personal") !== scopeKey
		) {
			outcome.unfinished = true;
			continue;
		}
		if (failedScopes.has(scopeKey)) {
			outcome.unfinished = true;
			continue;
		}
		try {
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
		} catch (error) {
			// One bank that cannot take sources now (one being repaired, say)
			// leaves its own messages owed; the others in the batch go on. Its
			// writes were a savepoint of their own and are undone.
			failedScopes.add(scopeKey);
			outcome.failures.push(errorCode(error));
			outcome.unfinished = true;
		}
	}
	outcome.recorded = jobs.length;
	return jobs;
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
 * or an explicit edit touches is held for an operator's preparation
 * (`scripts/memory-backfill.ts`), which replays those with it. With
 * conversation ids it takes up those chats; without, every imported chat
 * still owed (after a restart, or when Memory comes back on), chats imported
 * before this rule existed included. An account still preparing is left to
 * its operator's preparation and a legacy account to the memory judge, and no
 * memory account is created here.
 *
 * Each batch is its own write and re-checks the controls, the message and its
 * chat; a batch or a bank that fails is logged by code and left owed, and the
 * rest go on. Returns how many sources it recorded.
 */
export async function recordImportedHistory(
	userId: string,
	options: {
		conversationIds?: readonly string[];
		batchSize?: number;
		trigger?: Trigger;
	} = {},
): Promise<number> {
	const { conversationIds, batchSize = IMPORTED_HISTORY_BATCH } = options;
	const account = db
		.select()
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, userId))
		.get();
	if (account?.authority !== "hindsight" || account.lifecycleState !== "active")
		return 0;
	const enabled = db
		.select({ enabled: users.memoryEnabled })
		.from(users)
		.where(eq(users.id, userId))
		.get()?.enabled;
	if (!enabled) return 0;
	const owedIds = owedImportedMessages(userId, account.epoch, conversationIds);
	if (!owedIds.size) return 0;
	const state = takeUpState(userId, account);
	const memo = settled.get(userId);
	if (memo?.state === state && Date.now() - memo.at < SETTLED_FOR_MS) return 0;
	// Built outside the write barrier; each batch checks it still holds.
	const inventory = inspectMemoryMigration(userId);
	const replayed = new Set(inventory.actions.flatMap((a) => a.sourceIds));
	const owed = inventory.sources.filter(
		(source) =>
			owedIds.has(source.id) &&
			source.imported === true &&
			source.eligibility === "eligible" &&
			source.conversationId !== null &&
			!replayed.has(source.id) &&
			!source.replayActionIds?.length &&
			!source.explicitEditAt,
	);
	let recorded = 0;
	let finished = true;
	for (let start = 0; start < owed.length; start += batchSize) {
		const batch = owed.slice(start, start + batchSize);
		const outcome: BatchOutcome = {
			stop: false,
			unfinished: false,
			recorded: 0,
			failures: [],
		};
		try {
			await enqueueMemoryMutation((tx) =>
				takeUpBatch(tx, userId, account, inventory, batch, outcome),
			);
			recorded += outcome.recorded;
		} catch (error) {
			outcome.failures.push(errorCode(error));
			outcome.unfinished = true;
		}
		for (const code of outcome.failures) logNotTakenUp(options.trigger, code);
		if (outcome.unfinished || outcome.stop) finished = false;
		if (outcome.stop) break;
		// Let chat streams run between batches.
		await new Promise((resolve) => setImmediate(resolve));
	}
	// Only a whole pass knows that what is left can never be taken up as things are.
	if (finished && !conversationIds)
		settled.set(userId, { state, at: Date.now() });
	return recorded;
}

/** A code for the log: never an error's message, which can carry chat text. */
function errorCode(error: unknown) {
	if (error instanceof Error && /^memory_[a-z0-9_]{2,80}$/.test(error.message))
		return error.message;
	return error instanceof Error ? error.name : "unknown";
}

function logNotTakenUp(trigger: Trigger | undefined, code: string) {
	console.error(
		`[MEMORY_MAINTENANCE] imported history not taken up trigger=${trigger ?? "direct"} code=${code}`,
	);
}

/**
 * `recordImportedHistory` for the places that must not fail because of it:
 * the import itself, Memory switched on, and maintenance. A failure leaves
 * the messages owed, and the next of those catches them up.
 */
export async function catchUpImportedHistory(
	userId: string,
	trigger: Trigger,
	conversationIds?: readonly string[],
): Promise<number> {
	try {
		return await recordImportedHistory(userId, { conversationIds, trigger });
	} catch (error) {
		logNotTakenUp(trigger, errorCode(error));
		return 0;
	}
}
