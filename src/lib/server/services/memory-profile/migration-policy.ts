import { randomUUID } from "node:crypto";
import { and, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { HistoryImportStatus } from "$lib/memory-types";
import { db } from "$lib/server/db";
import {
	conversations,
	memoryAccounts,
	memoryActions,
	memoryControlIntervals,
	memoryDeliveryJobs,
	memoryHistoryChoices,
	memoryResetGenerations,
	memorySourceRevisions,
	messages,
	users,
} from "$lib/server/db/schema";
import type { ActionIntentRecord } from "./curation-intent";
import {
	HISTORY_POLICY_VERSION,
	historicalMemoryExclusion,
} from "./history-eligibility";
import { parseJsonRecord } from "./internal-json";
import { memoryMigrationGuard } from "./migration-guard";

function accountFor(userId: string) {
	const user = db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	if (!user) throw new Error("memory_account_unavailable");
	db.insert(memoryAccounts)
		.values({ userId, tenantId: randomUUID() })
		.onConflictDoNothing()
		.run();
	const account = db
		.select()
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, userId))
		.get();
	if (!account) throw new Error("memory_account_unavailable");
	return account;
}
export async function getHistoryImportStatus(
	userId: string,
): Promise<
	HistoryImportStatus & { available: boolean; shouldPrompt: boolean }
> {
	const account = accountFor(userId);
	const status = account.historyStatus;
	const available =
		account.authority === "hindsight" || account.authority === "preparing";
	const reset = db
		.select({ at: memoryResetGenerations.advancedAt })
		.from(memoryResetGenerations)
		.where(eq(memoryResetGenerations.userId, userId))
		.get();
	const oldDates =
		available && !account.historyChoice
			? db
					.select({ at: messages.createdAt })
					.from(messages)
					.innerJoin(
						conversations,
						eq(conversations.id, messages.conversationId),
					)
					.where(
						and(
							eq(conversations.userId, userId),
							eq(conversations.memoryIncognito, false),
							eq(messages.role, "user"),
							lte(messages.createdAt, account.createdAt),
							sql`NOT EXISTS (
								SELECT 1 FROM ${memorySourceRevisions}
								WHERE ${memorySourceRevisions.userId} = ${userId}
								AND ${memorySourceRevisions.epoch} = ${account.epoch}
								AND ${memorySourceRevisions.messageId} = ${messages.id}
								AND ${memorySourceRevisions.conversationId} = ${conversations.id}
								AND ${memorySourceRevisions.text} = ${messages.content}
								AND ${memorySourceRevisions.eventId} LIKE 'message:%'
								AND ${memorySourceRevisions.state} <> 'revoked'
							)`,
						),
					)
					.all()
			: [];
	const intervals = db
		.select()
		.from(memoryControlIntervals)
		.where(eq(memoryControlIntervals.userId, userId))
		.all();
	const shouldPrompt = oldDates.some(
		({ at }) =>
			historicalMemoryExclusion(
				{ account, intervals, resetAt: reset?.at, enabled: true },
				{ assertedAt: at },
			) === "unknown_history",
	);
	return {
		available,
		shouldPrompt,
		choice:
			account.historyChoice === "include" || account.historyChoice === "decline"
				? account.historyChoice
				: null,
		cutoff: account.historyCutoff?.toISOString() ?? null,
		decidedAt: account.historyDecidedAt?.toISOString() ?? null,
		policyVersion: account.historyPolicyVersion,
		status:
			status === "pending" ||
			status === "working" ||
			status === "complete" ||
			status === "held" ||
			status === "failed"
				? status
				: "not_requested",
	};
}
export async function recordHistoryImportChoice(
	userId: string,
	input: { choice: "include" | "decline"; requestId: string },
): Promise<
	HistoryImportStatus & { available: boolean; shouldPrompt: boolean }
> {
	if (
		!input.requestId.trim() ||
		input.requestId.length > 200 ||
		!["include", "decline"].includes(input.choice)
	)
		throw new Error("invalid_history_choice");
	const { enqueueMemoryMutation } = await import("./delivery-job");
	const { revokeMemorySources } = await import("./revisions");
	accountFor(userId);
	const now = new Date(Math.floor(Date.now() / 1000) * 1000);
	let prepare = false;
	await enqueueMemoryMutation((tx) => {
		const account = tx
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, userId))
			.get();
		if (!account) throw new Error("memory_account_unavailable");
		prepare =
			account.authority === "preparing" || account.authority === "hindsight";
		const existing = tx
			.select()
			.from(memoryHistoryChoices)
			.where(
				and(
					eq(memoryHistoryChoices.userId, userId),
					eq(memoryHistoryChoices.requestId, input.requestId),
				),
			)
			.get();
		if (existing) {
			if (existing.choice !== input.choice)
				throw new Error("history_request_conflict");
			if (account.historyChoice !== input.choice) return [];
		} else {
			tx.insert(memoryHistoryChoices)
				.values({
					id: randomUUID(),
					userId,
					requestId: input.requestId,
					choice: input.choice,
					cutoff: now,
					decidedAt: now,
					policyVersion: HISTORY_POLICY_VERSION,
					epoch: account.epoch,
				})
				.run();
			tx.update(memoryAccounts)
				.set({
					historyChoice: input.choice,
					historyCutoff: now,
					historyDecidedAt: now,
					historyPolicyVersion: HISTORY_POLICY_VERSION,
					historyStatus:
						input.choice === "include" ? "pending" : "not_requested",
				})
				.where(eq(memoryAccounts.userId, userId))
				.run();
		}
		if (input.choice !== "decline") return [];
		// Optional history loses read and dispatch admission in the same transaction as consent.
		const intervals = tx
			.select()
			.from(memoryControlIntervals)
			.where(eq(memoryControlIntervals.userId, userId))
			.all();
		const reset = tx
			.select({ at: memoryResetGenerations.advancedAt })
			.from(memoryResetGenerations)
			.where(eq(memoryResetGenerations.userId, userId))
			.get();
		const controls = {
			account: { ...account, historyChoice: "decline" },
			intervals,
			resetAt: reset?.at,
			enabled: true,
		};
		return tx
			.select()
			.from(memorySourceRevisions)
			.where(
				and(
					eq(memorySourceRevisions.userId, userId),
					eq(memorySourceRevisions.epoch, account.epoch),
					ne(memorySourceRevisions.state, "revoked"),
				),
			)
			.all()
			.filter((source) => {
				const context = parseJsonRecord(source.context);
				return (
					context.migration === true &&
					typeof context.migrationAuthoredId !== "string" &&
					historicalMemoryExclusion(controls, {
						assertedAt: source.explicitEditAt ?? source.assertedAt,
					}) === "unknown_history"
				);
			})
			.map((source) => {
				revokeMemorySources(userId, [source.id]);
				return {
					userId,
					bankId: source.bankId,
					epoch: source.epoch,
					kind: "source_cleanup" as const,
					sourceId: source.id,
					requestId: `source-cleanup:${source.id}`,
				};
			});
	});
	// A saved choice is not a migration trigger for legacy accounts. Existing prepared/native accounts resume their manifest,
	// except the account the permanent tester rule excludes: its choice is kept and none of its history is migrated.
	if (prepare && memoryMigrationGuard(userId).allowed) {
		const { prepareMemoryMigration } = await import("./migration");
		await prepareMemoryMigration(userId);
	}
	return getHistoryImportStatus(userId);
}
/** Record the actual change, not a reconstruction from the user's current toggle. */
export async function setMemoryEnabled(
	userId: string,
	enabled: boolean,
): Promise<void> {
	const { memoryDeliveryJob, enqueueMemoryMutation } = await import(
		"./delivery-job"
	);
	const { cancelAll } = await import("../jobs");
	const { revokeMemorySources } = await import("./revisions");
	accountFor(userId);
	const now = new Date();
	let retiredRevision = -1;
	await enqueueMemoryMutation((tx) => {
		const account = tx
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, userId))
			.get();
		if (!account) throw new Error("memory_account_unavailable");
		retiredRevision = account.controlRevision;
		const user = tx
			.select({ enabled: users.memoryEnabled })
			.from(users)
			.where(eq(users.id, userId))
			.get();
		if (!user) throw new Error("memory_account_unavailable");
		const open = tx
			.select()
			.from(memoryControlIntervals)
			.where(
				and(
					eq(memoryControlIntervals.userId, userId),
					isNull(memoryControlIntervals.endedAt),
				),
			)
			.get();
		if (open?.enabled === enabled && user.enabled === enabled) return [];
		tx.update(memoryControlIntervals)
			.set({ endedAt: now })
			.where(
				and(
					eq(memoryControlIntervals.userId, userId),
					isNull(memoryControlIntervals.endedAt),
				),
			)
			.run();
		tx.insert(memoryControlIntervals)
			.values({
				id: randomUUID(),
				userId,
				enabled,
				startedAt: now,
				epoch: account.epoch,
			})
			.run();
		if (user.enabled !== enabled)
			tx.update(memoryAccounts)
				.set({ controlRevision: sql`${memoryAccounts.controlRevision}+1` })
				.where(eq(memoryAccounts.userId, userId))
				.run();
		tx.update(users)
			.set({ memoryEnabled: enabled, updatedAt: now })
			.where(eq(users.id, userId))
			.run();
		if (enabled) return [];
		// The job engine cancels the old attempt. Preserve its last repair plan
		// so enable can restore the previously accepted state without replaying the Edit.
		const dirtyEdits = tx
			.select({
				id: memoryActions.id,
				intent: memoryActions.intentJson,
				checkpoint: memoryDeliveryJobs.checkpoint,
			})
			.from(memoryActions)
			.leftJoin(
				memoryDeliveryJobs,
				eq(memoryDeliveryJobs.actionId, memoryActions.id),
			)
			.where(
				and(
					eq(memoryActions.userId, userId),
					eq(memoryActions.epoch, account.epoch),
					eq(memoryActions.kind, "edit"),
					eq(memoryActions.cleanupPending, true),
				),
			)
			.all();
		for (const edit of dirtyEdits) {
			const intent = JSON.parse(
				edit.intent ?? "null",
			) as ActionIntentRecord | null;
			if (!intent?.proposal || intent.outcome === "accepted") continue;
			const checkpoint = JSON.parse(edit.checkpoint ?? "null") as Pick<
				ActionIntentRecord,
				"dependencyRepair"
			> | null;
			tx.update(memoryActions)
				.set({
					intentJson: JSON.stringify({
						...intent,
						dependencyRepair:
							checkpoint?.dependencyRepair ?? intent.dependencyRepair,
						outcome: "rejected",
						rejectionCode: "memory_edit_cancelled",
						rollbackPending: true,
					} satisfies ActionIntentRecord),
				})
				.where(eq(memoryActions.id, edit.id))
				.run();
		}
		const pending = tx
			.select()
			.from(memorySourceRevisions)
			.where(
				and(
					eq(memorySourceRevisions.userId, userId),
					lte(memorySourceRevisions.controlRevision, retiredRevision),
					or(
						eq(memorySourceRevisions.state, "pending"),
						eq(memorySourceRevisions.state, "staged"),
					),
				),
			)
			.all();
		revokeMemorySources(
			userId,
			pending.map((source) => source.id),
		);
		return pending.map((source) => ({
			userId,
			bankId: source.bankId,
			epoch: source.epoch,
			kind: "source_cleanup",
			sourceId: source.id,
			requestId: `disabled-cleanup:${source.id}`,
		}));
	});
	if (enabled) {
		const { resumeDependencyRepairs } = await import("./delivery-job");
		await resumeDependencyRepairs(userId);
		// Imported chats that arrived while Memory was off are owed now.
		const { catchUpImportedHistory } = await import("./imported-history");
		await catchUpImportedHistory(userId, "memory_on");
	}

	if (!enabled && retiredRevision >= 0)
		await cancelAll(memoryDeliveryJob, {
			userId,
			where: (jobs) =>
				sql`${jobs.kind} NOT IN ('cleanup','source_cleanup') AND ${jobs.controlRevision} <= ${retiredRevision} AND NOT (${jobs.kind} = 'action' AND EXISTS (SELECT 1 FROM memory_actions action WHERE action.id = ${jobs.actionId} AND action.kind = 'remove' AND action.exclusion_acknowledged = 1))`,
		});
}
