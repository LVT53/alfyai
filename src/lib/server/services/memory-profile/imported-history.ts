import { and, eq, inArray } from "drizzle-orm";
import {
	memoryAccounts,
	memorySourceRevisions,
	users,
} from "$lib/server/db/schema";
import {
	type EnqueueMemoryDelivery,
	enqueueMemoryMutation,
} from "./delivery-job";
import { inspectMemoryMigration } from "./migration-progress";
import {
	ensureMemoryBank,
	memoryTextHash,
	recordMemorySource,
} from "./revisions";

/**
 * Chats an import (a ChatGPT export) brings into an account already on native
 * Memory are earlier history that no preparation will see again, and no turn
 * delivers them. Record a source for each of the person's imported messages
 * the history rules admit, judged by the message's own date (Memory on, a
 * recorded decline, periods when Memory was off, a past Clear Memory, the
 * chat's scope), exactly as preparation records an earlier chat: the same
 * event id, lineage and context, and the same delivery job. Only imported
 * messages that hold no live source are recorded; nothing else in the
 * history is touched and no manifest is written.
 *
 * With conversation ids it takes up those chats; without, every imported
 * message still owed one (after a restart, or when Memory comes back on).
 * An account still preparing is left to its operator's preparation and a
 * legacy account to the memory judge, and no memory account is created here.
 * Returns how many sources it recorded.
 */
export async function recordImportedHistory(
	userId: string,
	conversationIds?: readonly string[],
): Promise<number> {
	let recorded = 0;
	await enqueueMemoryMutation((tx) => {
		recorded = 0;
		const account = tx
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, userId))
			.get();
		if (
			account?.authority !== "hindsight" ||
			account.lifecycleState !== "active"
		)
			return [];
		const user = tx
			.select({ enabled: users.memoryEnabled })
			.from(users)
			.where(eq(users.id, userId))
			.get();
		if (!user?.enabled) return [];
		const wanted = conversationIds ? new Set(conversationIds) : null;
		const owed = inspectMemoryMigration(userId).sources.filter(
			(source) =>
				source.imported === true &&
				source.eligibility === "eligible" &&
				source.conversationId !== null &&
				(!wanted || wanted.has(source.conversationId)),
		);
		if (!owed.length) return [];
		const existing = tx
			.select()
			.from(memorySourceRevisions)
			.where(
				and(
					eq(memorySourceRevisions.userId, userId),
					eq(memorySourceRevisions.epoch, account.epoch),
					inArray(
						memorySourceRevisions.messageId,
						owed.map((source) => source.id),
					),
				),
			)
			.all();
		const jobs: EnqueueMemoryDelivery[] = [];
		for (const source of owed) {
			// A message with a live source anywhere is already Memory's business,
			// a moved chat's included; only one with none, or only revoked ones
			// (Memory was switched off before it was taken up), is owed.
			if (
				existing.some(
					(row) => row.messageId === source.id && row.state !== "revoked",
				)
			)
				continue;
			const bank = ensureMemoryBank(userId, source.scope);
			const earlier = existing.filter(
				(row) => row.messageId === source.id && row.bankId === bank.id,
			).length;
			const textHash = memoryTextHash(source.text);
			const row = recordMemorySource({
				userId,
				bankId: bank.id,
				epoch: account.epoch,
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
						: [{ id: source.id, role: "user", sourceId: "$current", textHash }],
				}),
				assertedAt: new Date(source.assertedAt),
				conversationId: source.conversationId,
				messageId: source.id,
			});
			recorded++;
			jobs.push({
				userId,
				bankId: bank.id,
				epoch: account.epoch,
				kind: "source",
				sourceId: row.id,
				// Preparation's request id for a source no action touches.
				requestId: `source:${row.id}:${memoryTextHash(JSON.stringify([]))}`,
			});
		}
		return jobs;
	});
	return recorded;
}

/** A code for the log: never an error's message, which can carry chat text. */
function errorCode(error: unknown) {
	if (error instanceof Error && /^[a-z][a-z0-9_]{2,80}$/.test(error.message))
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
			`[MEMORY_IMPORTED_HISTORY] not taken up trigger=${trigger} code=${errorCode(error)}`,
		);
		return 0;
	}
}
