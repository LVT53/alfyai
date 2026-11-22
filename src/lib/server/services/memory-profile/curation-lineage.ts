import { and, eq, inArray, sql } from "drizzle-orm";
import {
	memoryActions,
	memoryBanks,
	memorySourceRevisions,
} from "$lib/server/db/schema";
import type { Tx } from "../jobs/types";
import { NativeMemoryError } from "./contracts";
import { parseActionIntent } from "./curation-intent";
import { parseJsonRecord } from "./internal-json";
import {
	hasConflictingScopeOrigin,
	readMemoryScopeMoves,
} from "./scope-history";

type Source = typeof memorySourceRevisions.$inferSelect;

export function isEditResendWithdrawal(
	source: Pick<typeof memorySourceRevisions.$inferSelect, "context">,
): boolean {
	return parseJsonRecord(source.context).editResendWithdrawal === true;
}

/** Walk only recorded predecessors inside one admitted chat lineage. */
export function* memorySourcePredecessors(
	tx: Tx,
	source: typeof memorySourceRevisions.$inferSelect,
) {
	const seen = new Set([source.id]);
	let id = source.predecessorSourceId;
	while (id && !seen.has(id)) {
		const previous = tx
			.select()
			.from(memorySourceRevisions)
			.where(eq(memorySourceRevisions.id, id))
			.get();
		if (
			!previous ||
			previous.userId !== source.userId ||
			previous.bankId !== source.bankId ||
			previous.epoch !== source.epoch ||
			previous.conversationId !== source.conversationId ||
			previous.lineageId !== source.lineageId
		)
			return;
		yield previous;
		seen.add(id);
		id = previous.predecessorSourceId;
	}
}

/** Continue through exact withdrawals only while the intervening sources were never admitted. */
export function memoryResendTransitions(tx: Tx, source: Source): Source[] {
	if (!source.eventId.startsWith("message:") || !source.predecessorSourceId)
		return [];
	const transitions: Source[] = [];
	for (const previous of memorySourcePredecessors(tx, source)) {
		if (
			transitions.length === 64 ||
			previous.state !== "revoked" ||
			!isEditResendWithdrawal(previous)
		)
			break;
		transitions.push(previous);
		if (
			previous.textHash !== source.textHash ||
			previous.explicitEditAt ||
			previous.nativeSubmitted ||
			previous.nativeAcknowledged ||
			previous.acceptedGeneration ||
			previous.acknowledgedFactsJson !== "[]"
		)
			return transitions;
		if (!previous.predecessorSourceId) return transitions;
	}
	throw new NativeMemoryError("memory_predecessor_invalid", false);
}

function verifiedOwnerIds(
	source: Source,
	bank: typeof memoryBanks.$inferSelect,
	ids: unknown,
): string[] {
	if (
		!Array.isArray(ids) ||
		ids.length > 64 ||
		ids.some((id) => typeof id !== "string") ||
		new Set(ids).size !== ids.length ||
		!source.acceptedGeneration ||
		![bank.generation, bank.previousGeneration].includes(
			source.acceptedGeneration,
		) ||
		(source.state !== "accepted" && !isEditResendWithdrawal(source))
	)
		throw new Error("memory_unchanged_source_unverified");
	return ids;
}

/** Prove an exact receipt owns a physical ancestor, including while it is held for repair. */
export function hasExactCarryOwner(
	tx: Tx,
	tip: Source,
	bank: typeof memoryBanks.$inferSelect,
	owner: Source,
): boolean {
	const carry = parseJsonRecord(tip.context).carriedSourceIds;
	if (
		carry === undefined ||
		tip.nativeSubmitted ||
		tip.textHash !== owner.textHash ||
		!verifiedOwnerIds(tip, bank, carry).includes(owner.id)
	)
		return false;
	let distance = 0;
	for (const prior of memorySourcePredecessors(tx, tip)) {
		if (++distance > 64) break;
		if (prior.id === owner.id) return true;
	}
	return false;
}

/** The accepted logical revision keeps the existing native document owners. */
export function carriedMemorySources(
	tx: Tx,
	source: typeof memorySourceRevisions.$inferSelect,
	bank: typeof memoryBanks.$inferSelect,
) {
	const carry = parseJsonRecord(source.context).carriedSourceIds;
	const edited =
		carry === undefined &&
		source.messageId &&
		source.nativeSubmitted &&
		source.explicitEditAt &&
		source.predecessorSourceId
			? tx
					.select({ intent: memoryActions.intentJson })
					.from(memoryActions)
					.where(
						and(
							eq(memoryActions.userId, source.userId),
							eq(memoryActions.bankId, source.bankId),
							eq(memoryActions.epoch, source.epoch),
							eq(memoryActions.kind, "source_edit"),
							eq(memoryActions.requestId, source.id),
							sql`json_extract(${memoryActions.intentJson}, '$.outcome') = 'accepted'`,
						),
					)
					.get()
			: undefined;
	if (carry === undefined && !edited) return null;
	const ids = verifiedOwnerIds(
		source,
		bank,
		edited ? parseJsonRecord(edited.intent ?? "").sourceIds : carry,
	);
	const ownerRows = tx
		.select()
		.from(memorySourceRevisions)
		.where(
			and(
				eq(memorySourceRevisions.userId, source.userId),
				eq(memorySourceRevisions.bankId, source.bankId),
				eq(memorySourceRevisions.epoch, source.epoch),
				eq(memorySourceRevisions.state, "accepted"),
				inArray(memorySourceRevisions.id, ids),
			),
		)
		.all();
	const ancestors = new Set<string>();
	for (const previous of memorySourcePredecessors(tx, source)) {
		ancestors.add(previous.id);
		if (ancestors.size > 64)
			throw new Error("memory_unchanged_source_unverified");
	}
	// A changed edit receipt can mention its retired logical predecessor.
	// Only accepted, physical ancestors still supply carried chat context.
	const owners = edited
		? ownerRows.filter((owner) => ancestors.has(owner.id))
		: ownerRows;
	if (
		(!edited && owners.length !== ids.length) ||
		owners.some(
			(owner) =>
				owner.acceptedGeneration !== bank.generation ||
				(!ancestors.has(owner.id) && !owner.eventId.startsWith("manual:")),
		)
	)
		throw new Error("memory_unchanged_source_unverified");
	const attached = acceptedCorrectionSources(tx, bank, [
		source.id,
		...ancestors,
		...owners.map((owner) => owner.id),
	]);
	const authorized = [
		...new Map(
			[...(source.nativeSubmitted ? [source] : []), ...owners, ...attached].map(
				(owner) => [owner.id, owner],
			),
		).values(),
	];
	if (authorized.length > 64)
		throw new Error("memory_unchanged_source_unverified");
	return authorized;
}

/** Resolve accepted explicit corrections attached to this exact lineage. */
export function acceptedCorrectionSources(
	tx: Tx,
	bank: typeof memoryBanks.$inferSelect,
	lineage: string[],
) {
	const scope = new Set(lineage);
	const result: Array<typeof memorySourceRevisions.$inferSelect> = [];
	const actions = tx
		.select()
		.from(memoryActions)
		.where(
			and(
				eq(memoryActions.userId, bank.userId),
				eq(memoryActions.bankId, bank.id),
				eq(memoryActions.epoch, bank.epoch),
				eq(memoryActions.kind, "edit"),
				sql`json_extract(${memoryActions.intentJson}, '$.outcome') = 'accepted'`,
			),
		)
		.orderBy(sql`rowid`)
		.all();
	for (const action of actions) {
		const intent = parseJsonRecord(action.intentJson ?? "");
		if (
			typeof intent.addedSourceId !== "string" ||
			!Array.isArray(intent.sourceIds) ||
			!intent.sourceIds.length ||
			!intent.sourceIds.every((id) => typeof id === "string" && scope.has(id))
		)
			continue;
		const owner = tx
			.select()
			.from(memorySourceRevisions)
			.where(
				and(
					eq(memorySourceRevisions.id, intent.addedSourceId),
					eq(memorySourceRevisions.userId, bank.userId),
					eq(memorySourceRevisions.bankId, bank.id),
					eq(memorySourceRevisions.epoch, bank.epoch),
					eq(memorySourceRevisions.state, "accepted"),
					eq(memorySourceRevisions.eventId, `manual:${action.id}`),
				),
			)
			.get();
		if (!owner || owner.acceptedGeneration !== bank.generation) continue;
		scope.add(owner.id);
		result.push(owner);
	}
	return result;
}

/** A saved action follows one persisted assertion revision, not a bank document or a topic. */
function curationAssertionKey(
	source: Pick<
		Source,
		| "userId"
		| "epoch"
		| "conversationId"
		| "messageId"
		| "lineageId"
		| "textHash"
		| "assertedAt"
		| "explicitEditAt"
	>,
): string | null {
	return source.conversationId && source.messageId
		? JSON.stringify([
				source.userId,
				source.epoch,
				source.conversationId,
				source.messageId,
				source.lineageId,
				source.textHash,
				source.assertedAt.getTime(),
				source.explicitEditAt?.getTime() ?? null,
			])
		: null;
}

/** Resolve only saved accepted intent and explicit correction ancestry. */
export function readNativeCurationLineage(
	tx: Tx,
	userId: string,
	epoch: number,
	sources: Source[],
) {
	const byId = new Map(
		sources
			.filter((source) => source.userId === userId && source.epoch === epoch)
			.map((source) => [source.id, source]),
	);
	const addedRoots = new Map<string, Source[]>();
	return tx
		.select({ action: memoryActions, order: sql<number>`rowid` })
		.from(memoryActions)
		.where(
			and(
				eq(memoryActions.userId, userId),
				eq(memoryActions.epoch, epoch),
				inArray(memoryActions.kind, ["edit", "remove"]),
			),
		)
		.orderBy(sql`rowid`)
		.all()
		.flatMap(({ action, order }) => {
			const intent = parseActionIntent(action.intentJson);
			if (
				(action.kind === "edit" && intent.outcome !== "accepted") ||
				(action.kind === "remove" && !action.exclusionAcknowledged)
			)
				return [];
			const inputs = intent.sourceIds.map((id) => {
				const source = byId.get(id);
				if (!source || source.bankId !== action.bankId) return [];
				return curationAssertionKey(source)
					? [source]
					: (addedRoots.get(id) ?? []);
			});
			const roots = [...new Set(inputs.flat())];
			if (!roots.length) return [];
			const whollyChatBound = inputs.every((group) => group.length > 0);
			const added = intent.addedSourceId
				? byId.get(intent.addedSourceId)
				: undefined;
			const correction =
				action.kind === "edit" &&
				added?.bankId === action.bankId &&
				added.lineageId === action.id &&
				added.eventId === `manual:${action.id}`
					? added
					: undefined;
			if (correction && whollyChatBound) addedRoots.set(correction.id, roots);
			return [{ action, intent, order, roots, whollyChatBound, correction }];
		});
}

/** The current owned scope and recorded moves both have to authorize cross-bank replay. */
export function nativeCurationForMigration(
	tx: Tx,
	userId: string,
	epoch: number,
) {
	const sources = tx
		.select()
		.from(memorySourceRevisions)
		.where(
			and(
				eq(memorySourceRevisions.userId, userId),
				eq(memorySourceRevisions.epoch, epoch),
			),
		)
		.orderBy(sql`rowid`)
		.all();
	const byId = new Map(sources.map((source) => [source.id, source]));
	const byMessage = new Map<string, Source[]>();
	for (const source of sources) {
		if (!source.messageId) continue;
		const known = byMessage.get(source.messageId) ?? [];
		known.push(source);
		byMessage.set(source.messageId, known);
	}
	const revision = (
		message: Pick<
			Source,
			"messageId" | "conversationId" | "textHash" | "assertedAt"
		>,
	) => {
		const candidates = (byMessage.get(message.messageId ?? "") ?? []).filter(
			(source) =>
				source.conversationId === message.conversationId &&
				source.textHash === message.textHash,
		);
		const explicit = candidates.find(
			(source) =>
				source.explicitEditAt?.getTime() === message.assertedAt.getTime(),
		);
		if (explicit) return explicit;
		return candidates.find((source) => {
			if (source.explicitEditAt) return false;
			const old = source.predecessorSourceId
				? byId.get(source.predecessorSourceId)
				: undefined;
			return (
				source.assertedAt.getTime() === message.assertedAt.getTime() ||
				(old?.conversationId === source.conversationId &&
					old?.lineageId === source.lineageId &&
					old?.textHash === source.textHash &&
					old?.assertedAt.getTime() === source.assertedAt.getTime())
			);
		});
	};
	const byAssertion = new Map<
		string,
		ReturnType<typeof readNativeCurationLineage>
	>();
	for (const entry of readNativeCurationLineage(tx, userId, epoch, sources)) {
		const keys = new Set(entry.roots.map(curationAssertionKey));
		for (const key of keys) {
			if (!key) continue;
			const entries = byAssertion.get(key) ?? [];
			entries.push(entry);
			byAssertion.set(key, entries);
		}
	}
	const scopes = new Map(
		tx
			.select({ id: memoryBanks.id, scope: memoryBanks.scopeKey })
			.from(memoryBanks)
			.where(and(eq(memoryBanks.userId, userId), eq(memoryBanks.epoch, epoch)))
			.all()
			.map((bank) => [bank.id, bank.scope]),
	);
	const moves = readMemoryScopeMoves(tx, userId, epoch);
	const plan = (
		identity: Parameters<typeof curationAssertionKey>[0],
		targetScope: string,
		messageAt: Date,
	) => {
		const key = curationAssertionKey(identity);
		const relevant = key ? (byAssertion.get(key) ?? []) : [];
		const paths = moves.get(identity.conversationId ?? "") ?? [];
		const firstSource = (byMessage.get(identity.messageId ?? "") ?? []).find(
			(source) => curationAssertionKey(source) === key,
		);
		if (
			hasConflictingScopeOrigin(
				paths,
				targetScope,
				messageAt,
				firstSource ? scopes.get(firstSource.bankId) : undefined,
			)
		)
			return { blocked: true, ids: [] as string[] };
		if (!relevant.length) return { blocked: false, ids: [] as string[] };
		const reachable = new Set([targetScope]);
		// Work backwards over the same chat's owned scope moves. Project
		// actions stay in their original scope, including on a personal return.
		for (let priorSize = 0; priorSize !== reachable.size; ) {
			priorSize = reachable.size;
			for (const move of paths)
				if (move.subjectId && move.relatedId && reachable.has(move.relatedId))
					reachable.add(move.subjectId);
		}
		for (const entry of relevant) {
			const origin = scopes.get(entry.action.bankId);
			if (origin === targetScope) continue;
			if (
				origin !== "personal" ||
				!reachable.has(origin) ||
				!entry.whollyChatBound ||
				entry.roots.some(
					(source) => source.conversationId !== identity.conversationId,
				)
			)
				return { blocked: true, ids: [] as string[] };
		}
		return { blocked: false, ids: relevant.map(({ action }) => action.id) };
	};
	return { revision, plan };
}
