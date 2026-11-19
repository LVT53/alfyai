import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { MemoryScope } from "$lib/memory-types";
import { db } from "$lib/server/db";
import {
	conversations,
	memoryAccounts,
	memoryActions,
	memoryBanks,
	memoryMigrationManifests,
	memoryProfileItems,
	memoryReviewResolutions,
	memoryRevocations,
	memorySourceRevisions,
	messages,
	projects,
	users,
} from "$lib/server/db/schema";
import type { Tx } from "../jobs/types";
import {
	carriedMemorySources,
	hasExactCarryOwner,
	isEditResendWithdrawal,
	memorySourcePredecessors,
} from "./curation-lineage";
import { holdExplicitDependents } from "./dependency-plan";
import { isHistoricalMemorySourceEligible } from "./history-eligibility";
import { parseJsonRecord } from "./internal-json";
import {
	hasConflictingScopeOrigin,
	memoryScopeAt,
	readMemoryScopeMoves,
} from "./scope-history";
import { isUserAuthoredMemoryMetadata } from "./types";

export {
	acceptedCorrectionSources,
	carriedMemorySources,
	isEditResendWithdrawal,
	memorySourcePredecessors,
} from "./curation-lineage";

export function memoryTextHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
export function memoryScopeKey(scope: MemoryScope): string {
	return scope.kind === "personal" ? "personal" : `project:${scope.projectId}`;
}
export function getMemoryAccount(userId: string) {
	return (
		db
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, userId))
			.get() ?? null
	);
}

export function hasNativeMemoryScopeBoundary(userId: string): boolean {
	const account = getMemoryAccount(userId);
	if (!account) return false;
	if (account.authority === "hindsight" || account.authority === "preparing")
		return true;

	// Rollback restores the legacy reader, but does not make outputs from the
	// native period eligible for cross-chat evidence. Verification can replace
	// the manifest status, so use the retained cutover checkpoint.
	return db
		.select({ checkpoint: memoryMigrationManifests.checkpointJson })
		.from(memoryMigrationManifests)
		.where(eq(memoryMigrationManifests.userId, userId))
		.all()
		.some(
			({ checkpoint }) =>
				typeof parseJsonRecord(checkpoint).cutoverAt === "string",
		);
}
export function ensureMemoryBank(userId: string, scope: MemoryScope) {
	return db.transaction((tx) => {
		const user = tx.select().from(users).where(eq(users.id, userId)).get();
		if (!user) throw new Error("memory_unauthorized");
		if (
			scope.kind === "project" &&
			!tx
				.select()
				.from(projects)
				.where(
					and(eq(projects.id, scope.projectId), eq(projects.userId, userId)),
				)
				.get()
		)
			throw new Error("memory_unauthorized");
		tx.insert(memoryAccounts)
			.values({ userId, tenantId: randomUUID() })
			.onConflictDoNothing()
			.run();
		const account = tx
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, userId))
			.get();
		if (!account) throw new Error("memory_unauthorized");
		if (account.lifecycleState !== "active")
			throw new Error("memory_account_erasing");
		const scopeKey = memoryScopeKey(scope);
		tx.insert(memoryBanks)
			.values({ id: randomUUID(), userId, scopeKey, epoch: account.epoch })
			.onConflictDoNothing()
			.run();
		const bank = tx
			.select()
			.from(memoryBanks)
			.where(
				and(
					eq(memoryBanks.userId, userId),
					eq(memoryBanks.scopeKey, scopeKey),
					eq(memoryBanks.epoch, account.epoch),
				),
			)
			.get();
		if (!bank) throw new Error("memory_bank_unavailable");
		return bank;
	});
}
export interface RecordMemorySourceInput {
	userId: string;
	bankId: string;
	eventId: string;
	lineageId: string;
	text: string;
	context: string;
	assertedAt: Date;
	explicitEditAt?: Date;
	conversationId?: string | null;
	messageId?: string | null;
	epoch: number;
	predecessorSourceId?: string;
}
export function recordMemorySource(input: RecordMemorySourceInput) {
	return db.transaction((tx) => {
		assertMemoryBankFence(tx, input.userId, input.bankId, input.epoch);
		const account = tx
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, input.userId))
			.get();
		if (!account) throw new Error("memory_unauthorized");
		if (account.lifecycleState !== "active")
			throw new Error("memory_account_erasing");
		if (input.predecessorSourceId) {
			const previous = tx
				.select()
				.from(memorySourceRevisions)
				.where(eq(memorySourceRevisions.id, input.predecessorSourceId))
				.get();
			if (
				!previous ||
				previous.userId !== input.userId ||
				previous.bankId !== input.bankId ||
				previous.lineageId !== input.lineageId
			)
				throw new Error("memory_predecessor_invalid");
		}
		const existing = tx
			.select()
			.from(memorySourceRevisions)
			.where(
				and(
					eq(memorySourceRevisions.userId, input.userId),
					eq(memorySourceRevisions.eventId, input.eventId),
				),
			)
			.get();
		if (existing) {
			if (
				existing.bankId !== input.bankId ||
				existing.textHash !== memoryTextHash(input.text) ||
				existing.lineageId !== input.lineageId ||
				existing.conversationId !== (input.conversationId ?? null) ||
				existing.messageId !== (input.messageId ?? null) ||
				existing.epoch !== input.epoch ||
				existing.assertedAt.getTime() !==
					Math.floor(input.assertedAt.getTime() / 1000) * 1000 ||
				(existing.explicitEditAt?.getTime() ?? null) !==
					(input.explicitEditAt
						? Math.floor(input.explicitEditAt.getTime() / 1000) * 1000
						: null) ||
				existing.predecessorSourceId !== (input.predecessorSourceId ?? null)
			)
				throw new Error("memory_event_conflict");
			return existing;
		}
		tx.insert(memorySourceRevisions)
			.values({
				...input,
				id: randomUUID(),
				textHash: memoryTextHash(input.text),
				nativeOperationId: randomUUID(),
				controlRevision: account.controlRevision,
			})
			.run();
		const row = tx
			.select()
			.from(memorySourceRevisions)
			.where(
				and(
					eq(memorySourceRevisions.userId, input.userId),
					eq(memorySourceRevisions.eventId, input.eventId),
				),
			)
			.get();
		if (!row) throw new Error("memory_source_unavailable");
		return row;
	});
}
export function assertMemoryBankFence(
	tx: Tx,
	userId: string,
	bankId: string,
	epoch: number,
) {
	return assertMemoryBankAccess(tx, userId, bankId, epoch, "memory");
}
/** Explicit owner export is independent of the learn/recall switch; identity, scope and epoch still apply. */
export function assertMemoryBankAccess(
	tx: Tx,
	userId: string,
	bankId: string,
	epoch: number,
	mode: "memory" | "owner-export",
) {
	const account = tx
		.select()
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, userId))
		.get();
	const user = tx
		.select({ enabled: users.memoryEnabled })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	const bank = tx
		.select()
		.from(memoryBanks)
		.where(and(eq(memoryBanks.id, bankId), eq(memoryBanks.userId, userId)))
		.get();
	if (
		account?.lifecycleState !== "active" ||
		!user ||
		(mode === "memory" && !user.enabled) ||
		!bank ||
		bank.status === "retired" ||
		bank.status === "repair_blocked" ||
		account.epoch !== epoch ||
		bank.epoch !== epoch ||
		account.authority === "legacy"
	)
		throw new Error("memory_fence_stale");
	if (
		bank.scopeKey.startsWith("project:") &&
		!tx
			.select({ id: projects.id })
			.from(projects)
			.where(
				and(
					eq(projects.id, bank.scopeKey.slice(8)),
					eq(projects.userId, userId),
				),
			)
			.get()
	)
		throw new Error("memory_scope_removed");
	return bank;
}
/** An exact in-bank repair inherits the learned scope of its accepted source. */
export function isLearnedProjectSource(
	tx: Tx,
	source: typeof memorySourceRevisions.$inferSelect,
	scopeKey: string | undefined,
): boolean {
	if (!scopeKey?.startsWith("project:") || source.state === "revoked")
		return false;
	if (source.acceptedGeneration) return true;
	if (!source.eventId.startsWith("dependency:")) return false;
	const previous = memorySourcePredecessors(tx, source).next().value;
	if (
		!previous?.acceptedGeneration ||
		previous.state !== "repair_held" ||
		previous.textHash !== source.textHash
	)
		return false;
	if (previous.messageId === source.messageId) return true;

	// A repair of an exact resend belongs to the physical owner's learned
	// bank, with authority drawn from the verified current chat message.
	const bank = tx
		.select()
		.from(memoryBanks)
		.where(
			and(
				eq(memoryBanks.id, source.bankId),
				eq(memoryBanks.scopeKey, scopeKey),
				eq(memoryBanks.userId, source.userId),
				eq(memoryBanks.epoch, source.epoch),
			),
		)
		.get();
	if (!bank) return false;
	try {
		const { live } = assertMemoryDependencySourceCurrent(tx, previous.id, bank);
		return live.messageId === source.messageId;
	} catch {
		return false;
	}
}

export function revokeMemorySources(
	userId: string,
	sourceIds: string[],
	editSourceMessageId?: string,
): void {
	if (!sourceIds.length) return;
	db.transaction((tx) => {
		const sources = tx
			.select()
			.from(memorySourceRevisions)
			.where(
				and(
					eq(memorySourceRevisions.userId, userId),
					inArray(memorySourceRevisions.id, sourceIds),
				),
			)
			.all();
		for (const source of sources) {
			holdExplicitDependents(tx, userId, source.bankId, source.epoch, [
				source.id,
			]);
			tx.insert(memoryRevocations)
				.values({
					id: randomUUID(),
					userId,
					bankId: source.bankId,
					epoch: source.epoch,
					sourceId: source.id,
				})
				.run();
			const editResend =
				!!editSourceMessageId &&
				source.messageId === editSourceMessageId &&
				!!source.conversationId &&
				(source.state !== "revoked" || isEditResendWithdrawal(source)) &&
				memoryTextHash(
					tx
						.select({ text: messages.content })
						.from(messages)
						.where(
							and(
								eq(messages.id, editSourceMessageId),
								eq(messages.conversationId, source.conversationId),
								eq(messages.role, "user"),
							),
						)
						.get()?.text ?? "",
				) === source.textHash;
			const context =
				editResend || isEditResendWithdrawal(source)
					? JSON.stringify({
							...parseJsonRecord(source.context),
							editResendWithdrawal: editResend,
						})
					: source.context;
			tx.update(memorySourceRevisions)
				.set({ state: "revoked", context })
				.where(eq(memorySourceRevisions.id, source.id))
				.run();
		}
	});
}

/** Last-boundary eligibility for an immutable live source; standalone user-authored notes have no chat. */
export function assertMemoryActionOriginCurrent(
	tx: Tx,
	bank: typeof memoryBanks.$inferSelect,
	conversationId: string | null | undefined,
) {
	if (!conversationId) return;
	const chat = tx
		.select()
		.from(conversations)
		.where(
			and(
				eq(conversations.id, conversationId),
				eq(conversations.userId, bank.userId),
			),
		)
		.get();
	if (
		!chat ||
		chat.memoryIncognito ||
		(chat.projectId ? `project:${chat.projectId}` : "personal") !==
			bank.scopeKey
	)
		throw new Error("memory_source_scope_changed");
}

export function assertMemorySourceCurrent(
	tx: Tx,
	sourceId: string,
	userId: string,
	bankId: string,
) {
	const source = tx
		.select()
		.from(memorySourceRevisions)
		.where(eq(memorySourceRevisions.id, sourceId))
		.get();
	if (
		!source ||
		source.userId !== userId ||
		source.bankId !== bankId ||
		source.state === "revoked"
	)
		throw new Error("memory_source_revoked");
	const context = parseJsonRecord(source.context);
	const authored = typeof context.migrationAuthoredId === "string";
	if (
		(context.migration === true || authored) &&
		!isHistoricalMemorySourceEligible({
			userId,
			assertedAt: source.explicitEditAt ?? source.assertedAt,
			incognito: false,
			userAuthored: authored,
		})
	)
		throw Error("memory_historical_permission_changed");
	if (authored) assertAuthoredMigrationSourceCurrent(tx, source, context);
	if (source.conversationId) {
		const chat = tx
			.select()
			.from(conversations)
			.where(
				and(
					eq(conversations.id, source.conversationId),
					eq(conversations.userId, userId),
				),
			)
			.get();
		const bank = tx
			.select()
			.from(memoryBanks)
			.where(eq(memoryBanks.id, bankId))
			.get();
		// A learned project source can be checked or repaired in its original
		// bank after its chat moves. The persisted message still has to match.
		if (
			!chat ||
			chat.memoryIncognito ||
			!bank ||
			(bank.scopeKey !==
				(chat.projectId ? `project:${chat.projectId}` : "personal") &&
				!isLearnedProjectSource(tx, source, bank.scopeKey))
		)
			throw new Error("memory_source_scope_changed");
		const message = source.messageId
			? tx
					.select()
					.from(messages)
					.where(
						and(
							eq(messages.id, source.messageId),
							eq(messages.conversationId, chat.id),
						),
					)
					.get()
			: null;
		if (
			message?.role !== "user" ||
			parseJsonRecord(message.metadataJson).forkCopy ||
			(context.migration === true &&
				message.createdAt.toISOString() !==
					(context.migrationMessageAt ?? source.assertedAt.toISOString())) ||
			memoryTextHash(message.content) !== source.textHash
		)
			throw new Error("memory_source_changed");
	}
	return source;
}

/** A verified source edit can carry earlier native facts after the original message is gone. */
export function assertMemoryCurationSourceCurrent(
	tx: Tx,
	source: typeof memorySourceRevisions.$inferSelect,
	bank: typeof memoryBanks.$inferSelect,
) {
	if (source.userId !== bank.userId || source.epoch !== bank.epoch)
		throw new Error("memory_source_revoked");
	try {
		return assertMemorySourceCurrent(tx, source.id, bank.userId, bank.id);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			error.message !== "memory_source_changed" ||
			source.state !== "accepted"
		)
			throw error;
	}
	const tip = assertCarriedMemoryTip(tx, source, bank);
	if (
		carriedMemorySources(tx, tip, bank)?.some((owner) => owner.id === source.id)
	)
		return tip;
	const successors = [tip.id];
	for (const previous of memorySourcePredecessors(tx, tip)) {
		if (successors.length > 64) break;
		if (previous.id === source.id) {
			const receipts = tx
				.select({ intentJson: memoryActions.intentJson })
				.from(memoryActions)
				.where(
					and(
						eq(memoryActions.userId, bank.userId),
						eq(memoryActions.bankId, bank.id),
						eq(memoryActions.epoch, bank.epoch),
						eq(memoryActions.kind, "source_edit"),
						inArray(memoryActions.requestId, successors),
					),
				)
				.all();
			if (
				receipts.some((receipt) => {
					const intent = parseJsonRecord(receipt.intentJson ?? "");
					return (
						intent.outcome === "accepted" &&
						Array.isArray(intent.sourceIds) &&
						intent.sourceIds.includes(source.id)
					);
				})
			)
				return tip;
			break;
		}
		successors.push(previous.id);
	}
	throw new Error("memory_source_changed");
}

/** Repair authorizes the held physical document through the live exact assertion. */
export function assertMemoryDependencySourceCurrent(
	tx: Tx,
	sourceId: string,
	bank: typeof memoryBanks.$inferSelect,
) {
	const original = tx
		.select()
		.from(memorySourceRevisions)
		.where(eq(memorySourceRevisions.id, sourceId))
		.get();
	if (
		!original ||
		original.userId !== bank.userId ||
		original.bankId !== bank.id ||
		original.epoch !== bank.epoch ||
		original.state !== "repair_held"
	)
		throw new Error("memory_dependency_source_changed");
	try {
		return {
			original,
			live: assertMemorySourceCurrent(tx, sourceId, bank.userId, bank.id),
		};
	} catch (error) {
		if (!(error instanceof Error) || error.message !== "memory_source_changed")
			throw error;
	}
	const live = assertCarriedMemoryTip(tx, original, bank);
	if (!hasExactCarryOwner(tx, live, bank, original))
		throw new Error("memory_dependency_source_changed");
	return { original, live };
}

function assertCarriedMemoryTip(
	tx: Tx,
	source: typeof memorySourceRevisions.$inferSelect,
	bank: typeof memoryBanks.$inferSelect,
) {
	if (
		!source.conversationId ||
		!source.messageId ||
		!source.nativeAcknowledged ||
		!bank.generation ||
		source.acceptedGeneration !== bank.generation ||
		tx
			.select({ id: messages.id })
			.from(messages)
			.where(eq(messages.id, source.messageId))
			.get()
	)
		throw new Error("memory_source_changed");
	const live = tx
		.select({ source: memorySourceRevisions })
		.from(memorySourceRevisions)
		.innerJoin(messages, eq(messages.id, memorySourceRevisions.messageId))
		.where(
			and(
				eq(memorySourceRevisions.userId, bank.userId),
				eq(memorySourceRevisions.bankId, bank.id),
				eq(memorySourceRevisions.epoch, bank.epoch),
				eq(memorySourceRevisions.conversationId, source.conversationId),
				eq(memorySourceRevisions.lineageId, source.lineageId),
				eq(memorySourceRevisions.state, "accepted"),
				eq(memorySourceRevisions.acceptedGeneration, bank.generation),
			),
		)
		.limit(2)
		.all();
	if (live.length !== 1) throw new Error("memory_source_changed");
	const tip = live[0].source;
	assertMemorySourceCurrent(tx, tip.id, bank.userId, bank.id);
	const withdrawn = tx
		.select({ id: memoryRevocations.id })
		.from(memoryRevocations)
		.where(
			and(
				eq(memoryRevocations.userId, bank.userId),
				eq(memoryRevocations.bankId, bank.id),
				eq(memoryRevocations.epoch, bank.epoch),
				inArray(memoryRevocations.sourceId, [source.id, tip.id]),
			),
		)
		.get();
	if (withdrawn) throw new Error("memory_source_revoked");
	return tip;
}

/** A saved review/edit can be withdrawn while its inactive bank is preparing. */
function assertAuthoredMigrationSourceCurrent(
	tx: Tx,
	source: typeof memorySourceRevisions.$inferSelect,
	context: Record<string, unknown>,
): void {
	if (typeof context.legacyItemId === "string") {
		const item = tx
			.select()
			.from(memoryProfileItems)
			.where(
				and(
					eq(memoryProfileItems.userId, source.userId),
					eq(memoryProfileItems.id, context.legacyItemId),
				),
			)
			.get();
		if (
			item?.status !== "active" ||
			!isUserAuthoredMemoryMetadata(item.metadataJson) ||
			item.statement !== source.text ||
			item.updatedAt.getTime() !== source.assertedAt.getTime()
		)
			throw Error("memory_source_changed");
		if (item.scopeType === "conversation") {
			const chat = tx
				.select()
				.from(conversations)
				.where(
					and(
						eq(conversations.id, item.scopeId),
						eq(conversations.userId, source.userId),
					),
				)
				.get();
			const bank = tx
				.select()
				.from(memoryBanks)
				.where(eq(memoryBanks.id, source.bankId))
				.get();
			if (
				!chat ||
				chat.memoryIncognito ||
				!bank ||
				bank.scopeKey !==
					memoryScopeAt(
						readMemoryScopeMoves(tx, source.userId, source.epoch, chat.id).get(
							chat.id,
						) ?? [],
						chat.projectId ? `project:${chat.projectId}` : "personal",
						source.assertedAt,
					)
			)
				throw Error("memory_source_scope_changed");
		}
		return;
	}
	const id = context.legacyReviewResolutionId;
	const resolution =
		typeof id === "string"
			? tx
					.select()
					.from(memoryReviewResolutions)
					.where(
						and(
							eq(memoryReviewResolutions.userId, source.userId),
							eq(memoryReviewResolutions.id, id),
						),
					)
					.get()
			: undefined;
	if (
		resolution?.resolutionType !== "edit_fact" ||
		resolution.editedStatement !== source.text ||
		resolution.createdAt.getTime() !== source.assertedAt.getTime()
	)
		throw Error("memory_source_changed");
}

/** Context references are resolved from live authorized rows at the final dispatch boundary. */
export function resolveMemorySourceContext(
	tx: Tx,
	source: typeof memorySourceRevisions.$inferSelect,
): string {
	let input: unknown;
	try {
		input = JSON.parse(source.context);
	} catch {
		return "";
	}
	if (
		!input ||
		typeof input !== "object" ||
		!("messages" in input) ||
		!Array.isArray(input.messages)
	)
		return "";
	const admitted: Array<{
		id: string;
		role: string;
		text: string;
		date: string;
	}> = [];
	let historicalScope:
		| {
				key: string | undefined;
				moves: ReturnType<typeof readMemoryScopeMoves>;
		  }
		| undefined;
	for (const raw of input.messages.slice(-6)) {
		if (
			!raw ||
			typeof raw !== "object" ||
			typeof raw.sourceId !== "string" ||
			typeof raw.id !== "string" ||
			(raw.role !== "user" && raw.role !== "assistant")
		)
			continue;
		try {
			const dependency = assertMemorySourceCurrent(
				tx,
				raw.sourceId === "$current" ? source.id : raw.sourceId,
				source.userId,
				source.bankId,
			);
			if (
				dependency.state === "repair_held" ||
				dependency.epoch !== source.epoch ||
				dependency.controlRevision !== source.controlRevision ||
				dependency.textHash !== raw.textHash
			)
				continue;
			if (raw.role === "user" && raw.id !== dependency.messageId) continue;
			const bank = tx
				.select()
				.from(memoryBanks)
				.where(eq(memoryBanks.id, dependency.bankId))
				.get();
			const owners = (bank
				? carriedMemorySources(tx, dependency, bank)
				: null) ?? [dependency];
			const facts = owners.flatMap((owner) => {
				const values: unknown = JSON.parse(owner.acknowledgedFactsJson);
				if (!Array.isArray(values)) return [];
				return values.flatMap((fact) =>
					typeof fact?.id === "string" && typeof fact?.text === "string"
						? [{ id: fact.id as string, text: fact.text as string, owner }]
						: [],
				);
			});
			const sourceIds = [
				...new Set([dependency.id, ...owners.map((owner) => owner.id)]),
			];
			const revocations = tx
				.select()
				.from(memoryRevocations)
				.where(
					and(
						eq(memoryRevocations.bankId, source.bankId),
						eq(memoryRevocations.epoch, source.epoch),
						or(
							inArray(memoryRevocations.sourceId, sourceIds),
							inArray(
								memoryRevocations.nativeFactId,
								facts.map((fact) => fact.id),
							),
						),
					),
				)
				.all();
			if (revocations.some((r) => r.sourceId === dependency.id)) continue;
			if (
				dependency.state === "accepted" &&
				raw.sourceId !== "$current" &&
				raw.role === "user"
			) {
				for (const fact of facts) {
					if (
						revocations.some(
							(r) =>
								r.sourceId === fact.owner.id ||
								(r.nativeFactId === fact.id &&
									(r.nativeTextHash === null ||
										r.nativeTextHash === memoryTextHash(fact.text))),
						)
					)
						continue;
					admitted.push({
						id: fact.id,
						role: "prior-memory",
						text: fact.text,
						date: (
							fact.owner.explicitEditAt ?? fact.owner.assertedAt
						).toISOString(),
					});
				}
				continue;
			}
			if (revocations.length) continue;
			if (
				raw.role === "assistant" &&
				tx
					.select({ id: memoryActions.id })
					.from(memoryActions)
					.where(
						and(
							eq(memoryActions.userId, source.userId),
							eq(memoryActions.bankId, source.bankId),
							eq(memoryActions.epoch, source.epoch),
							sql`${memoryActions.kind} <> 'add'`,
							or(
								eq(memoryActions.exclusionAcknowledged, true),
								sql`json_extract(${memoryActions.intentJson}, '$.outcome') = 'accepted'`,
							),
							sql`exists (
						select 1 from json_each(${memoryActions.intentJson}, '$.sourceIds')
						where value in ${sourceIds}
					)`,
						),
					)
					.get()
			)
				continue;
			const message = tx
				.select()
				.from(messages)
				.where(
					and(
						eq(messages.id, raw.id),
						eq(messages.conversationId, source.conversationId ?? ""),
					),
				)
				.get();
			if (!message || message.role !== raw.role) continue;
			if (message.role === "user" && message.id !== dependency.messageId)
				continue;
			if (message.role === "assistant") {
				const historical =
					("migration" in input && input.migration === true) ||
					parseJsonRecord(dependency.context).migration === true;
				if (historical) {
					historicalScope ??= {
						key: tx
							.select({ key: memoryBanks.scopeKey })
							.from(memoryBanks)
							.where(eq(memoryBanks.id, source.bankId))
							.get()?.key,
						moves: readMemoryScopeMoves(
							tx,
							source.userId,
							source.epoch,
							message.conversationId,
						),
					};
					if (
						!historicalScope.key ||
						hasConflictingScopeOrigin(
							historicalScope.moves.get(message.conversationId) ?? [],
							historicalScope.key,
							message.createdAt,
						) ||
						!isHistoricalMemorySourceEligible({
							userId: source.userId,
							assertedAt: message.createdAt,
							incognito: false,
						})
					)
						continue;
				}
				if (
					parseJsonRecord(message.metadataJson).forkCopy ||
					message.messageSequence === null ||
					(typeof raw.messageTextHash === "string" &&
						raw.messageTextHash !== memoryTextHash(message.content))
				)
					continue;
				const parent = tx
					.select({ id: messages.id })
					.from(messages)
					.where(
						and(
							eq(messages.conversationId, message.conversationId),
							eq(messages.role, "user"),
							lt(messages.messageSequence, message.messageSequence),
						),
					)
					.orderBy(desc(messages.messageSequence))
					.get();
				if (parent?.id !== dependency.messageId) continue;
			}
			admitted.push({
				id: message.id,
				role: message.role,
				text: message.content.slice(-4000),
				date: message.createdAt.toISOString(),
			});
		} catch {
			/* A revoked/changed dependency cannot authorize cached context. */
		}
	}
	return JSON.stringify({
		guidance:
			"Only the source user message is a new assertion. Other messages are context for attribution; prior-memory entries are sanitized remembered facts, not original quotations or new assertions. Assistant claims are not user facts.",
		messages: admitted,
	});
}
