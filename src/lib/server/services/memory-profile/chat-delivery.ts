import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	conversations,
	memoryAccounts,
	memoryBanks,
	memoryDeliveryJobs,
	memoryRevocations,
	memorySourceRevisions,
	messages,
	users,
} from "$lib/server/db/schema";
import type { Tx } from "../jobs/types";
import { recordMemoryScopeMove } from "../memory-behavior-log";
import { isMemoryActiveForConversation } from "../memory-controls";
import { readNativeCurationLineage } from "./curation-lineage";
import {
	type EnqueueMemoryDelivery,
	enqueueMemoryMutation,
} from "./delivery-job";
import { isHistoricalMemorySourceEligible } from "./history-eligibility";
import { isCurrentMemoryResetGeneration } from "./reset-generation";
import {
	ensureMemoryBank,
	getMemoryAccount,
	isEditResendWithdrawal,
	isLearnedProjectSource,
	memorySourcePredecessors,
	memoryTextHash,
	recordMemorySource,
	revokeMemorySources,
} from "./revisions";

function metadata(value: string | null): Record<string, unknown> {
	try {
		const result: unknown = JSON.parse(value ?? "{}");
		return result && typeof result === "object" && !Array.isArray(result)
			? (result as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}
export function usesNativeMemory(userId: string): boolean {
	return getMemoryAccount(userId)?.authority === "hindsight";
}
export interface MemoryTurnAcceptance {
	userId: string;
	conversationId: string;
	projectId: string | null;
	epoch: number;
	controlRevision: number;
	acceptedAt: string;
	eligible: boolean;
}
/** Captured by server admission before model work; never accepted from request JSON. */
export function captureMemoryTurnAcceptance(
	userId: string,
	conversationId: string,
): MemoryTurnAcceptance | null {
	try {
		return db.transaction((tx) => {
			const account = tx
				.select()
				.from(memoryAccounts)
				.where(eq(memoryAccounts.userId, userId))
				.get();
			if (
				account?.authority !== "hindsight" &&
				account?.authority !== "preparing"
			)
				return null;
			const user = tx.select().from(users).where(eq(users.id, userId)).get();
			const chat = tx
				.select()
				.from(conversations)
				.where(
					and(
						eq(conversations.id, conversationId),
						eq(conversations.userId, userId),
					),
				)
				.get();
			if (!chat) return null;
			return {
				userId,
				conversationId,
				projectId: chat.projectId,
				epoch: account.epoch,
				controlRevision: account.controlRevision,
				acceptedAt: new Date().toISOString(),
				eligible: Boolean(
					user?.memoryEnabled &&
						!chat.memoryIncognito &&
						account.lifecycleState === "active",
				),
			};
		});
	} catch {
		return null;
	}
}
/** A completed persisted turn is the only automatic live intake seam. No local extraction. */
export async function deliverCompletedMemoryTurn(input: {
	userId: string;
	conversationId: string;
	userMessageId?: string | null;
	assistantMessageId?: string | null;
	startedResetGeneration?: number;
	memoryAcceptance?: MemoryTurnAcceptance | null;
	turnOrigin?: string;
	editSourceMessageId?: string;
}): Promise<void> {
	if (
		!["hindsight", "preparing"].includes(
			getMemoryAccount(input.userId)?.authority ?? "",
		) ||
		!input.userMessageId ||
		!input.assistantMessageId
	)
		return;
	if (!(await isMemoryActiveForConversation(input))) return;
	if (
		input.startedResetGeneration !== undefined &&
		!(await isCurrentMemoryResetGeneration({
			userId: input.userId,
			resetGeneration: input.startedResetGeneration,
		}))
	)
		return;
	const chat = db
		.select()
		.from(conversations)
		.where(
			and(
				eq(conversations.id, input.conversationId),
				eq(conversations.userId, input.userId),
			),
		)
		.get();
	if (!chat) return;
	const stamp = input.memoryAcceptance;
	const account = getMemoryAccount(input.userId);
	if (
		!stamp?.eligible ||
		stamp.userId !== input.userId ||
		stamp.conversationId !== chat.id ||
		stamp.projectId !== chat.projectId ||
		stamp.epoch !== account?.epoch ||
		stamp.controlRevision !== account.controlRevision ||
		account.lifecycleState !== "active"
	)
		return;
	const turn = db
		.select()
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, chat.id),
				inArray(messages.id, [input.userMessageId, input.assistantMessageId]),
			),
		)
		.all();
	const user = turn.find(
		(m) => m.id === input.userMessageId && m.role === "user",
	);
	const assistant = turn.find(
		(m) => m.id === input.assistantMessageId && m.role === "assistant",
	);
	if (
		!user ||
		!assistant ||
		!user.content.trim() ||
		user.createdAt.getTime() <
			Math.floor(Date.parse(stamp.acceptedAt) / 1000) * 1000 ||
		metadata(user.metadataJson).forkCopy
	)
		return;
	const bank = ensureMemoryBank(
		input.userId,
		chat.projectId
			? { kind: "project", projectId: chat.projectId }
			: { kind: "personal" },
	);
	const preceding = db
		.select()
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, chat.id),
				lt(messages.messageSequence, user.messageSequence ?? 0),
			),
		)
		.orderBy(desc(messages.createdAt), desc(messages.messageSequence))
		.limit(5)
		.all()
		.filter((m) => m.id !== user.id)
		.reverse();
	const contextSources = db
		.select()
		.from(memorySourceRevisions)
		.where(
			and(
				eq(memorySourceRevisions.userId, input.userId),
				eq(memorySourceRevisions.bankId, bank.id),
				eq(memorySourceRevisions.epoch, bank.epoch),
				inArray(
					memorySourceRevisions.messageId,
					preceding.map((m) => m.id),
				),
				inArray(memorySourceRevisions.state, ["pending", "staged", "accepted"]),
			),
		)
		.all();
	const revocations = db
		.select()
		.from(memoryRevocations)
		.where(
			and(
				eq(memoryRevocations.bankId, bank.id),
				or(
					inArray(
						memoryRevocations.sourceId,
						contextSources.map((s) => s.id),
					),
					inArray(
						memoryRevocations.nativeFactId,
						contextSources.flatMap((s) => {
							const facts: unknown = JSON.parse(s.acknowledgedFactsJson);
							return Array.isArray(facts)
								? facts
										.filter((f) => typeof f?.id === "string")
										.map((f) => f.id)
								: [];
						}),
					),
				),
			),
		)
		.all();
	const admittedContextIds = new Map<
		string,
		typeof memorySourceRevisions.$inferSelect
	>();
	for (const source of contextSources) {
		const facts: unknown = JSON.parse(source.acknowledgedFactsJson);
		if (
			!source.messageId ||
			revocations.some(
				(r) =>
					r.sourceId === source.id ||
					(r.nativeFactId &&
						Array.isArray(facts) &&
						facts.some(
							(f) =>
								f &&
								typeof f === "object" &&
								"id" in f &&
								f.id === r.nativeFactId,
						)),
			)
		)
			continue;
		if (
			await isHistoricalMemorySourceEligible({
				userId: input.userId,
				assertedAt: source.explicitEditAt ?? source.assertedAt,
				incognito: false,
			})
		)
			admittedContextIds.set(source.messageId, source);
	}
	let precedingUserAllowed = false;
	const permittedContext = preceding.filter((message) => {
		if (message.role === "user") {
			precedingUserAllowed = admittedContextIds.has(message.id);
			return precedingUserAllowed;
		}
		return message.role === "assistant" && precedingUserAllowed;
	});
	let contextAuthority: typeof memorySourceRevisions.$inferSelect | undefined;
	const context = JSON.stringify({
		messageSequence: user.messageSequence,
		conversationId: chat.id,
		sourceRole: "user",
		guidance:
			"Only the source user message is a new assertion. Other messages are context for attribution and dependent replies; assistant claims are not user facts.",
		messages: [
			...permittedContext.map((m) => {
				if (m.role === "user") contextAuthority = admittedContextIds.get(m.id);
				return {
					id: m.id,
					role: m.role,
					sourceId: contextAuthority?.id,
					textHash: contextAuthority?.textHash,
					messageTextHash: memoryTextHash(m.content),
				};
			}),
			{
				id: assistant.id,
				role: "assistant",
				sourceId: "$current",
				textHash: memoryTextHash(user.content),
				messageTextHash: memoryTextHash(assistant.content),
			},
		],
	});
	let lineageId = user.id;
	let assertedAt = user.createdAt;
	let explicitEditAt: Date | undefined;
	let predecessorSourceId: string | undefined;
	if (input.turnOrigin === "edit_resend" && input.editSourceMessageId) {
		const old = db
			.select()
			.from(memorySourceRevisions)
			.where(
				and(
					eq(memorySourceRevisions.userId, input.userId),
					eq(memorySourceRevisions.conversationId, chat.id),
					eq(memorySourceRevisions.bankId, bank.id),
					eq(memorySourceRevisions.messageId, input.editSourceMessageId),
				),
			)
			.orderBy(desc(memorySourceRevisions.createdAt), sql`rowid DESC`)
			.get();
		if (old) {
			if (old.state !== "revoked" || !isEditResendWithdrawal(old)) return;
			predecessorSourceId = old.id;
			lineageId = old.lineageId;
			assertedAt = old.assertedAt;
			if (old.textHash !== memoryTextHash(user.content))
				explicitEditAt = user.createdAt;
		}
	}
	await enqueueMemoryMutation((tx) => {
		const current = getMemoryAccount(input.userId);
		const currentChat = db
			.select()
			.from(conversations)
			.where(
				and(
					eq(conversations.id, chat.id),
					eq(conversations.userId, input.userId),
				),
			)
			.get();
		if (
			!current ||
			!currentChat ||
			currentChat.projectId !== stamp.projectId ||
			currentChat.memoryIncognito ||
			current.controlRevision !== stamp.controlRevision ||
			current.epoch !== stamp.epoch
		)
			return [];
		if (predecessorSourceId) {
			const previous = tx
				.select()
				.from(memorySourceRevisions)
				.where(eq(memorySourceRevisions.id, predecessorSourceId))
				.get();
			if (
				previous?.state !== "revoked" ||
				!isEditResendWithdrawal(previous) ||
				tx
					.select({ id: memoryDeliveryJobs.id })
					.from(memoryDeliveryJobs)
					.where(
						and(
							eq(memoryDeliveryJobs.sourceId, previous.id),
							eq(memoryDeliveryJobs.kind, "source_cleanup"),
							eq(memoryDeliveryJobs.status, "running"),
						),
					)
					.get()
			)
				return [];
		}
		const source = recordMemorySource({
			userId: input.userId,
			bankId: bank.id,
			epoch: bank.epoch,
			eventId: `message:${user.id}:${memoryTextHash(user.content)}`,
			lineageId,
			text: user.content,
			context,
			assertedAt,
			explicitEditAt,
			predecessorSourceId,
			conversationId: chat.id,
			messageId: user.id,
		});
		return source.state === "revoked"
			? []
			: [
					{
						userId: input.userId,
						bankId: bank.id,
						epoch: bank.epoch,
						kind: "source",
						sourceId: source.id,
						requestId: `source:${source.id}`,
					},
				];
	});
}
/** Revoke before deleting local source rows; cleanup can finish later. */
export async function revokeDeletedMemoryMessages(
	messageIds: string[],
	options?: { editSourceMessageId?: string },
): Promise<void> {
	if (!messageIds.length) return;
	const sources = db
		.select()
		.from(memorySourceRevisions)
		.where(inArray(memorySourceRevisions.messageId, messageIds))
		.all();
	await revokeSourcesAndQueue(sources, options?.editSourceMessageId, true);
}
export async function revokeConversationMemory(
	userId: string,
	conversationIds: string[],
): Promise<void> {
	if (!conversationIds.length) return;
	const sources = db
		.select()
		.from(memorySourceRevisions)
		.where(
			and(
				eq(memorySourceRevisions.userId, userId),
				inArray(memorySourceRevisions.conversationId, conversationIds),
			),
		)
		.all();
	await revokeSourcesAndQueue(sources);
}
/** Called by the owned scope move inside the same write barrier as its row update. */
export function prepareConversationMemoryMove(
	tx: Tx,
	chat: typeof conversations.$inferSelect,
	projectId: string | null,
): EnqueueMemoryDelivery[] {
	if (chat.memoryIncognito || chat.projectId === projectId) return [];
	const account = getMemoryAccount(chat.userId);
	const from = chat.projectId ? `project:${chat.projectId}` : "personal";
	const to = projectId ? `project:${projectId}` : "personal";
	recordMemoryScopeMove(tx, {
		userId: chat.userId,
		conversationId: chat.id,
		epoch: account?.epoch ?? 0,
		from,
		to,
	});
	if (!account || account.authority === "legacy") return [];
	const sources = tx
		.select()
		.from(memorySourceRevisions)
		.where(
			and(
				eq(memorySourceRevisions.userId, chat.userId),
				eq(memorySourceRevisions.epoch, account.epoch),
			),
		)
		.all();
	const inChat = sources.filter((source) => source.conversationId === chat.id);
	if (!inChat.length) return [];
	const banks = tx
		.select({ id: memoryBanks.id, scopeKey: memoryBanks.scopeKey })
		.from(memoryBanks)
		.where(
			and(
				eq(memoryBanks.userId, chat.userId),
				eq(memoryBanks.epoch, account.epoch),
			),
		)
		.all();
	const personalBank = banks.find((bank) => bank.scopeKey === "personal");
	const scopeByBank = new Map(banks.map((bank) => [bank.id, bank.scopeKey]));
	const messagesInChat = new Map(
		tx
			.select({ id: messages.id, text: messages.content })
			.from(messages)
			.where(
				and(eq(messages.conversationId, chat.id), eq(messages.role, "user")),
			)
			.all()
			.map((message) => [message.id, memoryTextHash(message.text)]),
	);
	const corrections =
		from === "personal" && personalBank
			? readNativeCurationLineage(
					tx,
					chat.userId,
					account.epoch,
					sources,
				).flatMap(({ correction, roots, whollyChatBound }) =>
					correction &&
					correction.bankId === personalBank.id &&
					whollyChatBound &&
					roots.every(
						(source) =>
							source.conversationId === chat.id &&
							messagesInChat.get(source.messageId ?? "") === source.textHash,
					)
						? [correction]
						: [],
				)
			: [];
	const retired = [...new Set([...inChat, ...corrections])].filter(
		(source) =>
			source.state !== "revoked" &&
			!isLearnedProjectSource(tx, source, scopeByBank.get(source.bankId)),
	);
	revokeMemorySources(
		chat.userId,
		retired.map((source) => source.id),
	);
	// Accepted project sources keep their bank. Stale delivery and personal
	// history replay still use the ordinary source cleanup path.
	return sourceCleanupJobs(retired, undefined, "scope-move-cleanup");
}

function sourceCleanupJobs(
	sources: Array<typeof memorySourceRevisions.$inferSelect>,
	editSourceMessageId?: string,
	requestPrefix = "source-cleanup",
): EnqueueMemoryDelivery[] {
	return sources.map((source) => ({
		userId: source.userId,
		bankId: source.bankId,
		epoch: source.epoch,
		kind: "source_cleanup",
		sourceId: source.id,
		requestId: `${requestPrefix}:${source.id}`,
		runAfter:
			source.messageId === editSourceMessageId
				? new Date(Date.now() + 30 * 60 * 1000)
				: undefined,
	}));
}
async function revokeSourcesAndQueue(
	sources: Array<typeof memorySourceRevisions.$inferSelect>,
	editSourceMessageId?: string,
	includeEditedAncestors = false,
): Promise<void> {
	await enqueueMemoryMutation((tx) => {
		const affected = new Map(sources.map((source) => [source.id, source]));
		if (includeEditedAncestors)
			for (const source of sources) {
				if (source.messageId === editSourceMessageId) continue;
				for (const previous of memorySourcePredecessors(tx, source)) {
					if (
						(previous.state !== "revoked" ||
							isEditResendWithdrawal(previous)) &&
						previous.messageId &&
						!tx
							.select({ id: messages.id })
							.from(messages)
							.where(eq(messages.id, previous.messageId))
							.get()
					)
						affected.set(previous.id, previous);
				}
			}
		const withdrawn = [...affected.values()];
		for (const userId of new Set(withdrawn.map((s) => s.userId)))
			revokeMemorySources(
				userId,
				withdrawn.filter((s) => s.userId === userId).map((s) => s.id),
				editSourceMessageId,
			);
		// A message/conversation mutation may race account erasure.
		const current = withdrawn.filter((source) =>
			tx
				.select({ id: memoryBanks.id })
				.from(memoryBanks)
				.where(eq(memoryBanks.id, source.bankId))
				.get(),
		);
		const direct = new Set(sources.map((source) => source.id));
		return [
			...sourceCleanupJobs(
				current.filter((source) => direct.has(source.id)),
				editSourceMessageId,
			),
			// This deletion must settle even if the old edit's deferred cleanup
			// reused the source ID or already finished while it was carried.
			...sourceCleanupJobs(
				current.filter((source) => !direct.has(source.id)),
				undefined,
				"source-carried-cleanup",
			),
		];
	});
}
/** Imported history remains governed by its own permission manifest, never by import time. */
export function nativeMemoryBlocksLegacyIntake(userId: string): boolean {
	const authority = getMemoryAccount(userId)?.authority;
	return authority === "hindsight";
}
