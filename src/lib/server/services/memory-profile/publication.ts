import { randomUUID } from "node:crypto";
import { and, eq, inArray, not, notInArray, or, sql } from "drizzle-orm";
import { type DatabaseInstance, db } from "$lib/server/db";
import {
	memoryActions,
	memoryBanks,
	memoryDeliveryJobs,
	memoryProfileItems,
	memoryPublishedRows,
	memoryRevocations,
	memorySourceRevisions,
} from "$lib/server/db/schema";
import type { Tx } from "../jobs/types";
import type { NativeMemory } from "./contracts";
import {
	type ActionIntentRecord,
	parseActionIntent,
	sourceEditTakenFacts,
} from "./curation-intent";
import { recordNativeFactLabels } from "./fact-labels";
import { NativeMemoryError } from "./hindsight-client";
import { parseJsonRecord } from "./internal-json";
import { splitNativeNotes } from "./presentation";
import {
	assertMemoryActionOriginCurrent,
	assertMemoryBankAccess,
	assertMemoryBankFence,
	assertMemoryCurationSourceCurrent,
	assertMemorySourceCurrent,
	memoryTextHash,
} from "./revisions";
import { parseMemoryItemMetadata } from "./types";
export interface AcknowledgedFact {
	id: string;
	text: string;
	mentionedAt?: string | null;
	assertedAtMs?: number;
}
type ObservationReceipt = {
	support: string;
	presentation: string;
	timing: string;
};
type StoredFact = AcknowledgedFact & {
	admittedObservation?: ObservationReceipt;
};

function readStoredFacts(json: string): StoredFact[] {
	const value: unknown = JSON.parse(json);
	if (
		!Array.isArray(value) ||
		value.some(
			(v) => !v || typeof v.id !== "string" || typeof v.text !== "string",
		)
	)
		throw new Error("memory_source_corrupt");
	return value;
}

export function readAcknowledgedFacts(json: string): AcknowledgedFact[] {
	return readStoredFacts(json).map(
		({ admittedObservation: _, ...fact }) => fact,
	);
}

export function memorySupportFingerprint(facts: AcknowledgedFact[]): string {
	return memoryTextHash(
		JSON.stringify(
			facts
				.map(({ id, text }) => [id, text])
				.sort(([a], [b]) => a.localeCompare(b)),
		),
	);
}

export function memoryPresentationFingerprint(
	text: string,
	nativeText: string,
): string {
	return memoryTextHash(JSON.stringify([text, nativeText]));
}

function memoryTimingFingerprint(facts: AcknowledgedFact[]) {
	return memoryTextHash(
		JSON.stringify(
			facts
				.map(
					({ id, mentionedAt, assertedAtMs }) =>
						[id, mentionedAt ?? null, assertedAtMs ?? null] as const,
				)
				.sort(([a], [b]) => a.localeCompare(b)),
		),
	);
}

/** Keep exact, individually attributable manual rows after display generations rotate. */
export function manualPublicationReceipts(
	tx: Tx,
	bankId: string,
	epoch: number,
	generation: string,
	memories: NativeMemory[],
	sourceId: string,
) {
	const ids = new Set(
		memories
			.filter(
				(fact) =>
					fact.fact_type !== "observation" && fact.document_id === sourceId,
			)
			.map(({ id }) => id),
	);
	if (!ids.size || ids.size > 100) return;
	const rows = uniquePublishedSupport(
		publishedRowsForGeneration(tx, bankId, epoch, generation),
	).filter(({ facts }) => facts.every((fact) => ids.has(fact.id)));
	if (!rows.length || rows.length > 64) return;
	return rows.map(({ row, facts }) => observationReceipt(row, facts));
}

function observationReceipt(
	row: Pick<typeof memoryPublishedRows.$inferSelect, "text" | "nativeText">,
	facts: AcknowledgedFact[],
): ObservationReceipt {
	return {
		support: memorySupportFingerprint(facts),
		presentation: memoryPresentationFingerprint(row.text, row.nativeText),
		timing: memoryTimingFingerprint(facts),
	};
}

function isIndependentPhysicalSource(
	source: typeof memorySourceRevisions.$inferSelect,
) {
	return (
		!!(source.conversationId && source.messageId) ||
		parseJsonRecord(source.context).migrationAuthoredId === source.lineageId
	);
}

function recordIndependentSourceObservations(
	tx: Tx,
	bank: typeof memoryBanks.$inferSelect,
	generation: string,
	sources: Array<typeof memorySourceRevisions.$inferSelect>,
	ownership: ReadonlyMap<
		string,
		{ source: typeof memorySourceRevisions.$inferSelect }
	>,
	raw: ReadonlyMap<string, NativeMemory>,
) {
	const tracked = new Map(
		sources
			.filter(
				(source) =>
					source.state === "staged" &&
					source.nativeAcknowledged &&
					source.userId === bank.userId &&
					source.epoch === bank.epoch &&
					isIndependentPhysicalSource(source),
			)
			.map((source) => [source.id, new Map<string, ObservationReceipt>()]),
	);
	if (!tracked.size) return;
	for (const { row, facts } of uniquePublishedSupport(
		publishedRowsForGeneration(tx, bank.id, bank.epoch, generation),
	)) {
		const id = facts[0].id;
		const sourceId = ownership.get(id)?.source.id;
		const receipts = sourceId ? tracked.get(sourceId) : undefined;
		if (
			receipts &&
			facts.every(
				(fact) =>
					ownership.get(fact.id)?.source.id === sourceId &&
					raw.get(fact.id)?.document_id === sourceId,
			)
		)
			receipts.set(id, observationReceipt(row, facts));
	}
	for (const source of sources) {
		const receipts = tracked.get(source.id);
		if (!receipts?.size || receipts.size > 64) continue;
		try {
			assertMemoryCurationSourceCurrent(tx, source, bank);
		} catch {
			continue;
		}
		const facts = readStoredFacts(source.acknowledgedFactsJson);
		if (facts.length > 100) continue;
		tx.update(memorySourceRevisions)
			.set({
				acknowledgedFactsJson: JSON.stringify(
					facts.map((fact) => ({
						...fact,
						admittedObservation:
							receipts.get(fact.id) ?? fact.admittedObservation,
					})),
				),
			})
			.where(eq(memorySourceRevisions.id, source.id))
			.run();
	}
}

export function publishedRowsForGeneration(
	database: Pick<DatabaseInstance, "select">,
	bankId: string,
	epoch: number,
	generation: string,
) {
	return database
		.select()
		.from(memoryPublishedRows)
		.where(
			and(
				eq(memoryPublishedRows.bankId, bankId),
				eq(memoryPublishedRows.epoch, epoch),
				eq(memoryPublishedRows.generation, generation),
			),
		)
		.all();
}

export function uniquePublishedSupport(
	rows: Array<typeof memoryPublishedRows.$inferSelect>,
) {
	const counts = new Map<string, number>();
	const captured = rows.map((row) => {
		const facts = readAcknowledgedFacts(row.sourceFingerprintsJson);
		for (const { id } of facts) counts.set(id, (counts.get(id) ?? 0) + 1);
		return { row, facts };
	});
	return captured.filter(
		({ facts }) =>
			facts.length && facts.every(({ id }) => counts.get(id) === 1),
	);
}

export function nativeRankSupportKey(ids: string[]) {
	return ids.length && new Set(ids).size === ids.length
		? JSON.stringify([...ids].sort())
		: null;
}

/** Link a durable Edit only to the uniquely supported result of that explicit action. */
export function publishedEditResult(
	tx: Tx,
	action: typeof memoryActions.$inferSelect,
	intent: ActionIntentRecord,
	generation: string,
) {
	if (!action.generation || !action.rowId) return null;
	const row = tx
		.select({ facts: memoryPublishedRows.sourceFingerprintsJson })
		.from(memoryPublishedRows)
		.where(
			and(
				eq(memoryPublishedRows.bankId, action.bankId),
				eq(memoryPublishedRows.epoch, action.epoch),
				eq(memoryPublishedRows.generation, action.generation),
				eq(memoryPublishedRows.nativeId, action.rowId),
			),
		)
		.get();
	if (!row) return null;
	const original = readAcknowledgedFacts(row.facts);
	const originalById = new Map(original.map((fact) => [fact.id, fact.text]));
	const resultFacts = intent.nativeFacts?.length
		? intent.nativeFacts
		: (intent.proposal ?? []).filter(
				(fact) => fact.text.trim() && originalById.has(fact.id),
			);
	if (!resultFacts.length) return null;
	const support = memorySupportFingerprint(resultFacts);
	const ids = new Set(resultFacts.map((fact) => fact.id));
	const matches = tx
		.select()
		.from(memoryPublishedRows)
		.where(
			and(
				eq(memoryPublishedRows.bankId, action.bankId),
				eq(memoryPublishedRows.epoch, action.epoch),
				eq(memoryPublishedRows.generation, generation),
			),
		)
		.all()
		.filter((candidate) =>
			readAcknowledgedFacts(candidate.sourceFingerprintsJson).some((fact) =>
				ids.has(fact.id),
			),
		);
	const match = matches.length === 1 ? matches[0] : undefined;
	if (
		!match ||
		memorySupportFingerprint(
			readAcknowledgedFacts(match.sourceFingerprintsJson),
		) !== support
	)
		return null;
	return {
		rowId: match.nativeId,
		support,
		presentation: memoryPresentationFingerprint(match.text, match.nativeText),
		originSourceIds: [
			...new Set(
				intent.facts
					.filter((fact) => originalById.get(fact.id) === fact.text)
					.map((fact) => fact.sourceId),
			),
		],
	};
}

/** A rejected draft can make native consolidation regenerate row IDs without changing accepted evidence. */
export function republishRenumberedNativeObservations(
	tx: Tx,
	input: {
		userId: string;
		bankId: string;
		epoch: number;
		expectedRevision: number;
		generation: string;
		actionId: string;
		memories: NativeMemory[];
	},
) {
	const admitted = admittedNativeFacts(input.userId, input.bankId, tx);
	const accepted = readPublishedMemory(
		input.userId,
		input.bankId,
		input.generation,
		tx,
	);
	const match = matchAcceptedSnapshot(
		input.memories,
		admitted,
		accepted.map(snapshotObservationProof),
	);
	if (match?.renumbered)
		publishNativeSnapshot(tx, {
			...input,
			prepared: match.prepared,
			checkedActionIds: [input.actionId],
		});
}

function snapshotObservationProof(
	row: typeof memoryPublishedRows.$inferSelect,
) {
	const facts = readAcknowledgedFacts(row.sourceFingerprintsJson);
	return {
		id: row.nativeId,
		support: memorySupportFingerprint(facts),
		presentation: memoryPresentationFingerprint(row.text, row.nativeText),
		facts,
	};
}

function matchAcceptedSnapshot(
	memories: NativeMemory[],
	admitted: ReturnType<typeof admittedNativeFacts>,
	accepted: ReturnType<typeof snapshotObservationProof>[],
	prepared = prepareNativeSnapshot(memories),
) {
	const raw = new Map(
		memories
			.filter((memory) => memory.fact_type !== "observation")
			.map((memory) => [memory.id, memory]),
	);
	if (
		raw.size !== admitted.length ||
		admitted.some(
			(fact) =>
				raw.get(fact.id)?.text !== fact.text ||
				raw.get(fact.id)?.document_id !== fact.source.id,
		)
	)
		return;

	const observations = memories.filter(
		(memory) => memory.fact_type === "observation",
	);
	if (accepted.length !== observations.length) return;
	const key = (presentation: string, support: string) =>
		JSON.stringify([presentation, support]);
	const priorRows = new Map(
		accepted.map((row) => [key(row.presentation, row.support), row.id]),
	);
	if (priorRows.size !== accepted.length) return;
	for (const row of accepted)
		if (
			row.facts.some(
				(fact) =>
					fact.mentionedAt !== undefined &&
					fact.mentionedAt !== (raw.get(fact.id)?.mentioned_at ?? null),
			)
		)
			return;

	let renumbered = false;
	for (const observation of observations) {
		const ids = observation.source_memory_ids ?? [];
		if (
			!ids.length ||
			new Set(ids).size !== ids.length ||
			ids.some((id) => !raw.has(id))
		)
			return;
		const signature = key(
			memoryPresentationFingerprint(
				prepared.get(observation.id) ?? observation.text,
				observation.text,
			),
			memorySupportFingerprint(
				ids.map((id) => ({ id, text: raw.get(id)?.text ?? "" })),
			),
		);
		const oldId = priorRows.get(signature);
		if (!oldId) return;
		priorRows.delete(signature);
		if (oldId !== observation.id) renumbered = true;
	}
	return { prepared, renumbered };
}

/** A source-only withdrawal can uncover an already admitted independent observation. */
export function verifiedSourceCleanupSnapshot(
	tx: Tx,
	input: {
		userId: string;
		bankId: string;
		epoch: number;
		expectedRevision: number;
		withdrawnSourceId: string;
		memories: NativeMemory[];
		learningEnabled: boolean;
	},
) {
	const bank = assertMemoryBankAccess(
		tx,
		input.userId,
		input.bankId,
		input.epoch,
		"owner-export",
	);
	if (
		!bank.generation ||
		!bank.previousGeneration ||
		bank.revision !== input.expectedRevision
	)
		return;
	const withdrawn = tx
		.select()
		.from(memorySourceRevisions)
		.where(
			and(
				eq(memorySourceRevisions.id, input.withdrawnSourceId),
				eq(memorySourceRevisions.userId, bank.userId),
				eq(memorySourceRevisions.bankId, bank.id),
				eq(memorySourceRevisions.epoch, bank.epoch),
				eq(memorySourceRevisions.state, "revoked"),
				eq(memorySourceRevisions.nativeAcknowledged, true),
			),
		)
		.get();
	if (!withdrawn) return;
	const nativeOwners = new Set(
		input.memories
			.filter((fact) => fact.fact_type !== "observation")
			.map((fact) => fact.document_id),
	);
	if (nativeOwners.has(withdrawn.id)) return;
	// One deletion can schedule several cleanup jobs for the physical sources
	// of the same edited chat message. The last job sees the complete readback.
	const lineage = withdrawn.conversationId
		? tx
				.select()
				.from(memorySourceRevisions)
				.where(
					and(
						eq(memorySourceRevisions.userId, bank.userId),
						eq(memorySourceRevisions.bankId, bank.id),
						eq(memorySourceRevisions.epoch, bank.epoch),
						eq(memorySourceRevisions.conversationId, withdrawn.conversationId),
						eq(memorySourceRevisions.lineageId, withdrawn.lineageId),
						eq(memorySourceRevisions.state, "revoked"),
						eq(memorySourceRevisions.nativeAcknowledged, true),
						eq(memorySourceRevisions.acceptedGeneration, bank.generation),
					),
				)
				.limit(65)
				.all()
		: [];
	if (lineage.length > 64) return;
	const removed = new Map(
		[withdrawn, ...lineage]
			.filter((source) => !nativeOwners.has(source.id))
			.flatMap((source) => readAcknowledgedFacts(source.acknowledgedFactsJson))
			.map(({ id, text }) => [id, text]),
	);
	if (!removed.size) return;
	const candidates = new Map<string, string>();
	for (const row of publishedRowsForGeneration(
		tx,
		bank.id,
		bank.epoch,
		bank.generation,
	)) {
		const facts = readAcknowledgedFacts(row.sourceFingerprintsJson);
		if (!facts.some((fact) => removed.get(fact.id) === fact.text)) continue;
		for (const fact of facts)
			if (!removed.has(fact.id)) candidates.set(fact.id, fact.text);
	}
	if (!candidates.size) return;
	const admitted = admittedNativeFacts(
		bank.userId,
		bank.id,
		tx,
		"owner-export",
	);
	const survivors = admitted.filter(
		(fact) =>
			candidates.get(fact.id) === fact.text &&
			fact.source.userId === bank.userId &&
			fact.source.epoch === bank.epoch &&
			fact.source.nativeAcknowledged &&
			(fact.source.eventId === `manual:${fact.source.lineageId}` ||
				isIndependentPhysicalSource(fact.source)),
	);
	if (!survivors.length) return;
	const survivingOwners = new Map(
		survivors.map(({ source }) => [source.id, source]),
	);
	const manualActions = [
		...new Set(
			survivors.flatMap(({ source }) =>
				source.eventId === `manual:${source.lineageId}`
					? [source.lineageId]
					: [],
			),
		),
	];
	const unverified = { kind: "unverified" as const };
	if (
		survivors.length > 100 ||
		survivingOwners.size > 64 ||
		!input.learningEnabled
	)
		return unverified;
	const actions = tx
		.select()
		.from(memoryActions)
		.where(
			and(
				eq(memoryActions.userId, bank.userId),
				eq(memoryActions.bankId, bank.id),
				eq(memoryActions.epoch, bank.epoch),
				inArray(memoryActions.kind, ["add", "edit"]),
				inArray(memoryActions.id, manualActions),
			),
		)
		.all();
	const receipts = new Map(
		actions.map((action) => [action.id, parseActionIntent(action.intentJson)]),
	);
	const currentOwners = new Set<string>();
	for (const source of survivingOwners.values()) {
		try {
			if (source.eventId === `manual:${source.lineageId}`) {
				const receipt = receipts.get(source.lineageId);
				if (
					receipt?.outcome !== "accepted" ||
					receipt.addedSourceId !== source.id ||
					(receipt.originConversationId ?? null) !== source.conversationId
				)
					continue;
				assertMemoryActionOriginCurrent(tx, bank, receipt.originConversationId);
			} else assertMemoryCurationSourceCurrent(tx, source, bank);
			currentOwners.add(source.id);
		} catch {
			// Permission can change while the native delete is being settled.
		}
	}
	const authorized = new Set(
		survivors
			.filter(({ source }) => currentOwners.has(source.id))
			.map(({ id }) => id),
	);
	if (!authorized.size) return;
	const existing = readPublishedMemory(
		bank.userId,
		bank.id,
		bank.generation,
		tx,
		"owner-export",
	);
	const accepted = existing.map(snapshotObservationProof);
	const currentSignatures = new Set(
		accepted.map((row) => `${row.support}:${row.presentation}`),
	);
	const uniquePriorIds = new Set(
		uniquePublishedSupport(
			publishedRowsForGeneration(
				tx,
				bank.id,
				bank.epoch,
				bank.previousGeneration,
			),
		).map(({ row }) => row.nativeId),
	);
	const recoverable = readPublishedMemory(
		bank.userId,
		bank.id,
		bank.previousGeneration,
		tx,
		"owner-export",
	)
		.map(snapshotObservationProof)
		.filter(
			({ id, facts, support, presentation }) =>
				uniquePriorIds.has(id) &&
				!currentSignatures.has(`${support}:${presentation}`) &&
				facts.every((fact) => authorized.has(fact.id)),
		);
	const knownSupport = new Set(
		[...accepted, ...recoverable].map((row) => row.support),
	);
	const prepared = prepareNativeSnapshot(input.memories);
	const durable = durableCleanupProofs(
		input.memories,
		prepared,
		admitted,
		authorized,
		receipts,
		knownSupport,
	);
	const known = [...accepted, ...recoverable, ...durable];
	const covered = new Set(
		known.flatMap(({ facts }) => facts.map(({ id }) => id)),
	);
	const match =
		[...authorized].every((id) => covered.has(id)) &&
		matchAcceptedSnapshot(input.memories, admitted, known, prepared);
	if (match && (recoverable.length || durable.length))
		return { kind: "exact" as const, prepared: match.prepared };
	if (match) return;

	// Another withdrawal in this bank can hold the complete readback. Keep
	// this job responsible for its own family until that source has settled.
	const admittedIds = new Set(admitted.map(({ id }) => id));
	const extra = input.memories.filter(
		(fact) => fact.fact_type !== "observation" && !admittedIds.has(fact.id),
	);
	const owners = [...new Set(extra.flatMap((fact) => fact.document_id ?? []))];
	if (!owners.length || owners.length > 64) return unverified;
	const pending = tx
		.selectDistinct({ source: memorySourceRevisions })
		.from(memorySourceRevisions)
		.innerJoin(
			memoryDeliveryJobs,
			and(
				eq(memoryDeliveryJobs.sourceId, memorySourceRevisions.id),
				eq(memoryDeliveryJobs.userId, bank.userId),
				eq(memoryDeliveryJobs.bankId, bank.id),
				eq(memoryDeliveryJobs.epoch, bank.epoch),
				eq(memoryDeliveryJobs.kind, "source_cleanup"),
				inArray(memoryDeliveryJobs.status, ["queued", "running"]),
			),
		)
		.where(
			and(
				inArray(memorySourceRevisions.id, owners),
				eq(memorySourceRevisions.userId, bank.userId),
				eq(memorySourceRevisions.bankId, bank.id),
				eq(memorySourceRevisions.epoch, bank.epoch),
				eq(memorySourceRevisions.state, "revoked"),
				eq(memorySourceRevisions.nativeAcknowledged, true),
			),
		)
		.all();
	const pendingFacts = new Map(
		pending.map(({ source }) => [
			source.id,
			new Map(
				readAcknowledgedFacts(source.acknowledgedFactsJson).map(
					({ id, text }) => [id, text],
				),
			),
		]),
	);
	if (
		!extra.every(
			(fact) =>
				fact.document_id &&
				pendingFacts.get(fact.document_id)?.get(fact.id) === fact.text,
		)
	)
		return unverified;
	if (
		pending.some(
			({ source }) =>
				source.conversationId !== withdrawn.conversationId ||
				source.lineageId !== withdrawn.lineageId,
		)
	)
		return { kind: "waiting" as const };
}

function durableCleanupProofs(
	memories: NativeMemory[],
	prepared: ReadonlyMap<string, string>,
	admitted: ReturnType<typeof admittedNativeFacts>,
	affected: ReadonlySet<string>,
	receipts: ReadonlyMap<string, ActionIntentRecord>,
	knownSupport: ReadonlySet<string>,
) {
	const raw = new Map(
		memories
			.filter((fact) => fact.fact_type !== "observation")
			.map((fact) => [fact.id, fact]),
	);
	const liveFacts = new Map(admitted.map((fact) => [fact.id, fact]));
	return memories.flatMap((row) => {
		if (row.fact_type !== "observation") return [];
		const ids = row.source_memory_ids ?? [];
		const source = liveFacts.get(ids[0])?.source;
		if (
			!source ||
			!ids.some((id) => affected.has(id)) ||
			new Set(ids).size !== ids.length
		)
			return [];
		const candidate = receipts.get(source.lineageId);
		const receipt =
			candidate?.addedSourceId === source.id ? candidate : undefined;
		const assertedAtMs = (source.explicitEditAt ?? source.assertedAt).getTime();
		const facts: AcknowledgedFact[] = [];
		for (const id of ids) {
			const fact = raw.get(id);
			const accepted = liveFacts.get(id);
			if (
				!fact ||
				accepted?.source.id !== source.id ||
				fact.document_id !== source.id ||
				fact.text !== accepted.text
			)
				return [];
			facts.push({
				id,
				text: fact.text,
				mentionedAt: fact.mentioned_at ?? null,
				assertedAtMs,
			});
		}
		const support = memorySupportFingerprint(facts);
		if (knownSupport.has(support)) return [];
		const presentation = memoryPresentationFingerprint(
			prepared.get(row.id) ?? row.text,
			row.text,
		);
		const timing = memoryTimingFingerprint(facts);
		const stored =
			receipt?.resultRows ??
			readStoredFacts(source.acknowledgedFactsJson).flatMap(
				({ admittedObservation }) =>
					admittedObservation ? [admittedObservation] : [],
			);
		const recorded = stored.some(
			(entry) =>
				entry.support === support &&
				entry.presentation === presentation &&
				entry.timing === timing,
		);
		const legacyEdit =
			!stored.length &&
			receipt?.resultSupport === support &&
			receipt.resultPresentation === presentation &&
			receipt.nativeFacts?.length === facts.length &&
			facts.every((fact) =>
				receipt.nativeFacts?.some(
					(record) =>
						record.id === fact.id &&
						record.text === fact.text &&
						record.native_mentioned_at === fact.mentionedAt &&
						Date.parse(record.assertion_at ?? "") === fact.assertedAtMs,
				),
			);
		return recorded || legacyEdit
			? [{ id: row.id, support, presentation, facts }]
			: [];
	});
}
export function admittedNativeFacts(
	userId: string,
	bankId: string,
	database: DatabaseInstance | Tx = db,
	mode: "memory" | "owner-export" = "memory",
) {
	return database.transaction((tx) => {
		const bank = tx
			.select()
			.from(memoryBanks)
			.where(and(eq(memoryBanks.id, bankId), eq(memoryBanks.userId, userId)))
			.get();
		if (!bank) return [];
		assertMemoryBankAccess(tx, userId, bankId, bank.epoch, mode);
		const revoked = tx
			.select()
			.from(memoryRevocations)
			.where(eq(memoryRevocations.bankId, bankId))
			.all();
		return tx
			.select()
			.from(memorySourceRevisions)
			.where(
				and(
					eq(memorySourceRevisions.bankId, bankId),
					eq(memorySourceRevisions.state, "accepted"),
				),
			)
			.all()
			.flatMap((source) =>
				revoked.some((r) => r.sourceId === source.id)
					? []
					: readAcknowledgedFacts(source.acknowledgedFactsJson)
							.filter(
								(f) =>
									!revoked.some(
										(r) =>
											r.nativeFactId === f.id &&
											(r.nativeTextHash === null ||
												r.nativeTextHash === memoryTextHash(f.text)),
									),
							)
							.map((f) => ({ ...f, source })),
			);
	});
}
/**
 * When each admitted fact was last said, in milliseconds: the newest of its
 * sources' dates, where an explicit edit counts as the day it was said again.
 * A fact several sources acknowledge has the newest of them.
 */
export function factSaidTimes(
	facts: ReadonlyArray<{
		id: string;
		source: { assertedAt: Date; explicitEditAt: Date | null };
	}>,
): Map<string, number> {
	const times = new Map<string, number>();
	for (const fact of facts) {
		const said = (
			fact.source.explicitEditAt ?? fact.source.assertedAt
		).getTime();
		const known = times.get(fact.id);
		if (known === undefined || said > known) times.set(fact.id, said);
	}
	return times;
}

/**
 * When the person last said an entry, as an ISO date: the newest of its
 * facts' times (`factSaidTimes`), null when none of them is admitted. Recall
 * puts it after each entry, and Workspace Search shows it on a memory row, so
 * both give one answer.
 */
export function entryLastSaidAt(
	sourceFactIds: readonly string[],
	saidAt: ReadonlyMap<string, number>,
): string | null {
	let newest: number | null = null;
	for (const id of sourceFactIds) {
		const said = saidAt.get(id);
		if (said !== undefined && (newest === null || said > newest)) newest = said;
	}
	return newest === null ? null : new Date(newest).toISOString();
}
export function prepareNativeSnapshot(memories: NativeMemory[]) {
	const ids = new Set<string>();
	for (const memory of memories) {
		if (ids.has(memory.id)) throw new Error("memory_candidate_duplicate");
		ids.add(memory.id);
		if (
			memory.fact_type !== "observation" &&
			(!memory.consolidated_at || memory.consolidation_failed_at)
		)
			throw new Error("memory_consolidation_incomplete");
	}
	const byId = new Map(memories.map((m) => [m.id, m]));
	return new Map(
		memories
			.filter((m) => m.fact_type === "observation")
			.map((row) => [
				row.id,
				splitNativeNotes(
					row,
					(row.source_memory_ids ?? []).flatMap((id) => {
						const source = byId.get(id);
						return source ? [source] : [];
					}),
				),
			]),
	);
}
/**
 * The actions among `actionIds` whose delivery ended without running again:
 * a job failed or cancelled, and none queued or running. An action with no
 * job row has not ended.
 */
function endedActionIds(tx: Tx, actionIds: string[]) {
	const ended = new Set<string>();
	if (!actionIds.length) return ended;
	const running = new Set<string>();
	for (const job of tx
		.select({
			actionId: memoryDeliveryJobs.actionId,
			status: memoryDeliveryJobs.status,
		})
		.from(memoryDeliveryJobs)
		.where(inArray(memoryDeliveryJobs.actionId, actionIds))
		.all()) {
		if (!job.actionId) continue;
		if (job.status === "queued" || job.status === "running")
			running.add(job.actionId);
		else if (job.status === "failed" || job.status === "cancelled")
			ended.add(job.actionId);
	}
	for (const id of running) ended.delete(id);
	return ended;
}

/** The repair steps a delivery's checkpoint records, or none when it records none. */
function heldRepairSteps(
	checkpoint: string | null,
): Array<{ originalId: string; replacementId: string }> {
	const plan = parseJsonRecord(checkpoint).dependencyRepair;
	if (!plan || typeof plan !== "object" || !("steps" in plan)) return [];
	const steps = (plan as { steps: unknown }).steps;
	return Array.isArray(steps)
		? steps.filter(
				(step): step is { originalId: string; replacementId: string } =>
					typeof step?.originalId === "string" &&
					typeof step?.replacementId === "string",
			)
		: [];
}

/** The code a source delivery ends with when its own final check refused it. */
const HELD_SOURCE_REFUSAL = "memory_dependency_check_rejected";

/**
 * What publication leaves out for good instead of waiting on it, so a
 * refused item does not hold the bank's later learning.
 *
 * Every Remove the person asked for that has not applied keeps its
 * exclusion here, whether its job has ended, is queued again or runs, so
 * the exclusion never lapses between a check and a publication; only the
 * Remove's own job (`ownActionId`), which judges its own candidate, sees
 * past it. It covers the facts the Remove revoked, by id whatever their
 * native text is now; the dependents it held for repair (`repair_held`
 * sources and their replacements, whose extraction read the removed chat);
 * and, once its proposal was saved (its native write may have run before the
 * final check refused the result), the facts that shared an observation with
 * the targeted facts (`familyFactIds`) and the facts its proposal changed:
 * Hindsight rebuilt their observations and nobody approved them. A changed
 * resend refused for good leaves out, whatever its job is doing, every fact
 * its edit took away from the chats it carried (`sourceEditTakenFacts`,
 * the owner's privacy-first rule): a retry never writes its proposal again.
 * A source refused for its content (its delivery failed
 * `memory_dependency_check_rejected`, or its changed resend's source edit was
 * refused for good) never published, and its native facts are left out with
 * it. A source still queued or running is not here: it is waited for, as
 * before.
 */
export function excludedNativeEvidence(
	tx: Tx,
	bank: { id: string; userId: string; epoch: number },
	ownActionId?: string,
) {
	const factIds = new Set<string>();
	const sourceIds = new Set<string>();
	const removals = tx
		.select({ id: memoryActions.id, intentJson: memoryActions.intentJson })
		.from(memoryActions)
		.where(
			and(
				eq(memoryActions.userId, bank.userId),
				eq(memoryActions.bankId, bank.id),
				eq(memoryActions.epoch, bank.epoch),
				eq(memoryActions.kind, "remove"),
				eq(memoryActions.exclusionAcknowledged, true),
				sql`coalesce(json_extract(${memoryActions.intentJson}, '$.outcome'), '') <> 'accepted'`,
			),
		)
		.all()
		.filter(({ id }) => id !== ownActionId);
	if (removals.length) {
		for (const revocation of tx
			.select({ factId: memoryRevocations.nativeFactId })
			.from(memoryRevocations)
			.where(
				and(
					eq(memoryRevocations.bankId, bank.id),
					eq(memoryRevocations.epoch, bank.epoch),
					inArray(
						memoryRevocations.actionId,
						removals.map(({ id }) => id),
					),
				),
			)
			.all())
			if (revocation.factId) factIds.add(revocation.factId);
		for (const removal of removals) {
			const intent = parseActionIntent(removal.intentJson);
			for (const step of intent.dependencyRepair?.steps ?? []) {
				sourceIds.add(step.originalId);
				sourceIds.add(step.replacementId);
			}
			if (!intent.proposal) continue;
			const original = new Map(intent.facts.map(({ id, text }) => [id, text]));
			for (const id of intent.familyFactIds ?? [...original.keys()])
				factIds.add(id);
			for (const fact of intent.proposal)
				if (original.get(fact.id) !== fact.text) factIds.add(fact.id);
		}
	}
	for (const edit of tx
		.select({ intentJson: memoryActions.intentJson })
		.from(memoryActions)
		.where(
			and(
				eq(memoryActions.userId, bank.userId),
				eq(memoryActions.bankId, bank.id),
				eq(memoryActions.epoch, bank.epoch),
				eq(memoryActions.kind, "source_edit"),
				sql`json_extract(${memoryActions.intentJson}, '$.outcome') = 'rejected'`,
			),
		)
		.all())
		for (const fact of sourceEditTakenFacts(parseActionIntent(edit.intentJson)))
			factIds.add(fact.id);
	const sources = tx
		.select({
			id: memorySourceRevisions.id,
			status: memoryDeliveryJobs.status,
			errorCode: memoryDeliveryJobs.errorCode,
			checkpoint: memoryDeliveryJobs.checkpoint,
		})
		.from(memorySourceRevisions)
		.innerJoin(
			memoryDeliveryJobs,
			and(
				eq(memoryDeliveryJobs.sourceId, memorySourceRevisions.id),
				eq(memoryDeliveryJobs.kind, "source"),
			),
		)
		.where(
			and(
				eq(memorySourceRevisions.userId, bank.userId),
				eq(memorySourceRevisions.bankId, bank.id),
				eq(memorySourceRevisions.epoch, bank.epoch),
				inArray(memorySourceRevisions.state, ["pending", "staged"]),
			),
		)
		.all();
	const waiting = new Set(
		sources
			.filter(({ status }) => status === "queued" || status === "running")
			.map(({ id }) => id),
	);
	// Only a source refused for its content is held: its own final check
	// refused it, or its changed resend's source edit was refused for good
	// (`excludeRefusedSourceEdit` records that as the edit's outcome). A
	// source that failed for another reason (a wait, a hold, a migration step)
	// may still be recovered and published, and is waited for.
	const stopped = sources.filter(
		({ id, status }) =>
			(status === "failed" || status === "cancelled") && !waiting.has(id),
	);
	const refusedEdits = new Set(
		stopped.length
			? tx
					.select({ requestId: memoryActions.requestId })
					.from(memoryActions)
					.where(
						and(
							eq(memoryActions.userId, bank.userId),
							eq(memoryActions.bankId, bank.id),
							eq(memoryActions.epoch, bank.epoch),
							eq(memoryActions.kind, "source_edit"),
							inArray(
								memoryActions.requestId,
								stopped.map(({ id }) => id),
							),
							sql`json_extract(${memoryActions.intentJson}, '$.outcome') = 'rejected'`,
						),
					)
					.all()
					.map(({ requestId }) => requestId)
			: [],
	);
	for (const { id, status, errorCode, checkpoint } of stopped) {
		if (
			!(status === "failed" && errorCode === HELD_SOURCE_REFUSAL) &&
			!refusedEdits.has(id)
		)
			continue;
		sourceIds.add(id);
		// The later messages its own dependency repair held, and their
		// replacements: their extraction read the refused resend.
		for (const step of heldRepairSteps(checkpoint)) {
			sourceIds.add(step.originalId);
			sourceIds.add(step.replacementId);
		}
	}
	return { factIds, sourceIds };
}

/**
 * Hindsight's snapshot without the excluded raw facts and without every
 * observation that rests on one of them, even in part: an observation is the
 * smallest thing publication shows.
 */
export function withoutExcludedEvidence(
	memories: NativeMemory[],
	excluded: {
		factIds: ReadonlySet<string>;
		sourceIds: ReadonlySet<string>;
	},
) {
	if (!excluded.factIds.size && !excluded.sourceIds.size) return memories;
	const dropped = new Set(excluded.factIds);
	for (const memory of memories)
		if (
			memory.fact_type !== "observation" &&
			memory.document_id &&
			excluded.sourceIds.has(memory.document_id)
		)
			dropped.add(memory.id);
	return memories.filter((memory) =>
		memory.fact_type === "observation"
			? !(memory.source_memory_ids ?? []).some((id) => dropped.has(id))
			: !dropped.has(memory.id),
	);
}

/**
 * Keep another delivery from adopting or adding to an unresolved manual
 * candidate. A Remove holds the bank only while its job may still run: once
 * it ended without applying, its exclusion stays (`excludedNativeEvidence`)
 * and the bank learns again.
 */
export function assertCurationPublication(
	tx: Tx,
	bankId: string,
	epoch: number,
	options: { checkedActionIds?: string[]; replaySourceIds?: string[] } = {},
) {
	const replaySources = options.replaySourceIds ?? [];
	const outstanding = tx
		.select({ id: memoryActions.id, kind: memoryActions.kind })
		.from(memoryActions)
		.where(
			and(
				eq(memoryActions.bankId, bankId),
				eq(memoryActions.epoch, epoch),
				notInArray(memoryActions.id, options.checkedActionIds ?? []),
				or(
					and(
						eq(memoryActions.kind, "remove"),
						eq(memoryActions.exclusionAcknowledged, true),
						eq(memoryActions.cleanupPending, true),
						replaySources.length
							? not(sql`exists (
						select 1 from json_each(${memoryActions.intentJson}, '$.sourceIds')
						where value in ${replaySources}
					)`)
							: undefined,
					),
					and(
						eq(memoryActions.kind, "edit"),
						or(
							sql`json_extract(${memoryActions.intentJson}, '$.rollbackPending') = 1`,
							and(
								sql`json_type(${memoryActions.intentJson}, '$.proposal') = 'array'`,
								sql`json_extract(${memoryActions.intentJson}, '$.outcome') IS NULL`,
							),
						),
					),
				),
			),
		)
		.all();
	if (!outstanding.length) return;
	const ended = endedActionIds(
		tx,
		outstanding.filter(({ kind }) => kind === "remove").map(({ id }) => id),
	);
	if (outstanding.some(({ id, kind }) => kind !== "remove" || !ended.has(id)))
		throw new NativeMemoryError("memory_curation_publication_held", true);
}

/** Accepted edit support cannot authorize a new observation from an unrelated publication. */
function acceptedEditPresentations(
	tx: Tx,
	bank: typeof memoryBanks.$inferSelect,
) {
	const known: Array<{
		row: typeof memoryPublishedRows.$inferSelect;
		facts: AcknowledgedFact[];
	}> = [];
	if (!bank.generation) return known;
	const edits = tx
		.select({
			rowId: memoryActions.resultRowId,
			intentJson: memoryActions.intentJson,
		})
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
		.all();
	if (!edits.length) return known;
	const receipts = edits.flatMap(({ rowId, intentJson }) => {
		const intent = parseActionIntent(intentJson);
		return rowId && intent.resultSupport ? [{ rowId, intent }] : [];
	});
	for (const row of publishedRowsForGeneration(
		tx,
		bank.id,
		bank.epoch,
		bank.generation,
	)) {
		const facts = readAcknowledgedFacts(row.sourceFingerprintsJson);
		const support = memorySupportFingerprint(facts);
		const presentation = memoryPresentationFingerprint(
			row.text,
			row.nativeText,
		);
		if (
			!receipts.some(
				({ rowId, intent }) =>
					intent.resultSupport === support &&
					(intent.resultPresentation === presentation ||
						(!intent.resultPresentation &&
							intent.resultGeneration === row.generation &&
							rowId === row.nativeId)),
			)
		)
			continue;
		known.push({ row, facts });
	}
	return known;
}

/** A native rank can select an already approved row through its complete, uniquely captured support. */
export function curatedNativeRankKeys(
	tx: Tx,
	bank: typeof memoryBanks.$inferSelect,
) {
	const keys = new Map<string, string>();
	if (!bank.generation) return keys;

	const captured = publishedRowsForGeneration(
		tx,
		bank.id,
		bank.epoch,
		bank.generation,
	);
	const edited = new Set(
		acceptedEditPresentations(tx, bank).map(({ row }) => row.id),
	);
	let authored: ReadonlyMap<string, string>;
	try {
		authored = approvedMigrationObservationWording(
			tx,
			bank.userId,
			bank.id,
			readPublishedMemory(bank.userId, bank.id, bank.generation, tx),
			true,
		);
	} catch {
		authored = new Map();
	}
	if (!edited.size && !authored.size) return keys;
	for (const { row, facts } of uniquePublishedSupport(captured)) {
		if (!edited.has(row.id) && authored.get(row.nativeId) !== row.text)
			continue;
		const support = nativeRankSupportKey(facts.map(({ id }) => id));
		if (support) keys.set(support, row.nativeId);
	}
	return keys;
}

/**
 * A native rank can reach any published row through its complete, unique
 * support. Hindsight can rebuild an observation under a new id or in new
 * words over exactly the same facts (a refused correction's staged draft
 * deleted, a consolidation after a cleanup) while the page keeps showing the
 * published card until the next publication. Keys each row of the current
 * generation whose facts no other row of it holds (hidden rows counted) to the
 * row's native id. Recall confirms every such rank against Hindsight's live
 * list before it orders the row, and only ever shows the row's own wording.
 */
export function publishedSupportRankKeys(
	tx: Tx,
	bank: typeof memoryBanks.$inferSelect,
) {
	const keys = new Map<string, string>();
	if (!bank.generation) return keys;
	for (const { row, facts } of uniquePublishedSupport(
		publishedRowsForGeneration(tx, bank.id, bank.epoch, bank.generation),
	)) {
		const support = nativeRankSupportKey(facts.map(({ id }) => id));
		if (support) keys.set(support, row.nativeId);
	}
	return keys;
}

/** A verified receipt identifies the prior family to compare within the captured generation. */
export function curatedObservationChanges(
	tx: Tx,
	bank: typeof memoryBanks.$inferSelect,
	live: NativeMemory[],
	prepared: Map<string, string>,
	incomingSourceId?: string,
	excluded: ReturnType<typeof excludedNativeEvidence> = excludedNativeEvidence(
		tx,
		bank,
	),
) {
	// An accepted edit's card resting on what a refused item left out is left
	// out with it; it neither counts as changed nor as missing.
	const memories = withoutExcludedEvidence(live, excluded);
	const known = acceptedEditPresentations(tx, bank).filter(
		({ facts }) => !facts.some(({ id }) => excluded.factIds.has(id)),
	);
	if (!known.length) return [];
	const admitted = new Map(
		admittedNativeFacts(bank.userId, bank.id, tx).map((fact) => [
			fact.id,
			fact.text,
		]),
	);
	const baselines = known.filter(({ facts }) =>
		facts.every((fact) => admitted.get(fact.id) === fact.text),
	);
	const byFactId = new Map<string, typeof baselines>();
	const byNativeId = new Map(
		baselines.map((baseline) => [baseline.row.nativeId, baseline]),
	);
	for (const baseline of baselines) {
		for (const fact of baseline.facts) {
			const matches = byFactId.get(fact.id) ?? [];
			matches.push(baseline);
			byFactId.set(fact.id, matches);
		}
	}
	const raw = new Map(
		memories.filter((m) => m.fact_type !== "observation").map((m) => [m.id, m]),
	);
	const changed = [];
	const incoming = [];
	const covered = new Set<string>();
	for (const observation of memories) {
		if (observation.fact_type !== "observation") continue;
		const sameId = byNativeId.get(observation.id);
		const facts = (observation.source_memory_ids ?? []).flatMap((id) => {
			const fact = raw.get(id);
			return fact ? [fact] : [];
		});
		const prior = new Set(sameId ? [sameId] : []);
		for (const fact of facts)
			for (const baseline of byFactId.get(fact.id) ?? [])
				if (
					baseline.facts.some(
						(accepted) =>
							accepted.id === fact.id && accepted.text === fact.text,
					)
				)
					prior.add(baseline);
		for (const { row } of prior) covered.add(row.nativeId);
		const text = prepared.get(observation.id) ?? observation.text;
		const previous = [...prior].filter(
			({ row }) => row.text !== text || row.nativeText !== observation.text,
		);
		const candidate = { observation, text, facts, previous };
		if (previous.length) changed.push(candidate);
		if (
			incomingSourceId &&
			facts.some((fact) => fact.document_id === incomingSourceId)
		)
			incoming.push(candidate);
	}
	const missing = baselines.filter(({ row }) => !covered.has(row.nativeId));
	if (missing.length) {
		if (!incoming.length)
			throw new NativeMemoryError("memory_candidate_curation_drift", true);
		for (const candidate of incoming) {
			if (!candidate.previous.length) changed.push(candidate);
			candidate.previous.push(...missing);
		}
	}
	return changed.map(({ observation, text, facts, previous }) => ({
		observation,
		text,
		facts,
		previous,
		proof: memoryTextHash(
			JSON.stringify({
				generation: bank.generation,
				previous: previous.map(({ row }) => row.id).sort(),
				id: observation.id,
				text,
				nativeText: observation.text,
				facts: facts.map(({ id, text, document_id, mentioned_at }) => [
					id,
					text,
					document_id,
					mentioned_at,
				]),
			}),
		),
	}));
}

/** Called only inside the engine's fenced synchronous write. Capturing all pages happens before this transaction. */
export function verifiedMigrationAuthoredWording(
	tx: Tx,
	source: typeof memorySourceRevisions.$inferSelect,
	requiresPin: boolean,
) {
	const context = parseJsonRecord(source.context);
	if (
		source.messageId ||
		source.predecessorSourceId ||
		source.explicitEditAt ||
		typeof context.migrationAuthoredId !== "string" ||
		context.migrationAuthoredId !== source.lineageId
	)
		return undefined;
	if (
		requiresPin &&
		context.migrationExactWording !== true &&
		typeof context.legacyReviewResolutionId !== "string"
	) {
		const item =
			typeof context.legacyItemId === "string"
				? tx
						.select({ metadata: memoryProfileItems.metadataJson })
						.from(memoryProfileItems)
						.where(
							and(
								eq(memoryProfileItems.userId, source.userId),
								eq(memoryProfileItems.id, context.legacyItemId),
							),
						)
						.get()
				: undefined;
		if (parseMemoryItemMetadata(item?.metadata).reviewResolution !== "edited")
			return undefined;
	}
	const action = tx
		.select({ id: memoryActions.id })
		.from(memoryActions)
		.where(
			and(
				eq(memoryActions.userId, source.userId),
				eq(memoryActions.bankId, source.bankId),
				eq(memoryActions.epoch, source.epoch),
				inArray(memoryActions.kind, [
					"edit",
					"remove",
					"migration_edit",
					"migration_remove",
				]),
				sql`exists (select 1 from json_each(${memoryActions.intentJson}, '$.sourceIds') where value = ${source.id})`,
			),
		)
		.get();
	if (action) return undefined;
	assertMemorySourceCurrent(tx, source.id, source.userId, source.bankId);
	return source.text;
}

export function sameSupport(
	prior: typeof memoryPublishedRows.$inferSelect,
	observed: NativeMemory,
	raw: ReadonlyMap<string, NativeMemory>,
) {
	if (observed.fact_type !== "observation") return false;
	const support = readAcknowledgedFacts(prior.sourceFingerprintsJson);
	const ids = new Set(observed.source_memory_ids ?? []);
	return (
		support.length > 0 &&
		ids.size === support.length &&
		observed.source_memory_ids?.length === support.length &&
		support.every((fact) => {
			const live = raw.get(fact.id);
			return (
				ids.has(fact.id) &&
				live?.text === fact.text &&
				(live.mentioned_at ?? null) === (fact.mentionedAt ?? null)
			);
		})
	);
}

export function samePriorObservation(
	prior: typeof memoryPublishedRows.$inferSelect,
	observed: NativeMemory,
	raw: ReadonlyMap<string, NativeMemory>,
) {
	return (
		observed.text === prior.nativeText &&
		sameSupport(prior, observed, raw) &&
		splitNativeNotes(
			observed,
			(observed.source_memory_ids ?? []).flatMap((id) => {
				const fact = raw.get(id);
				return fact ? [fact] : [];
			}),
		) === prior.text
	);
}

/**
 * Reconnect only a unique, complete support match. An ordinary observation
 * must retain its full previous presentation. A current approved authored
 * statement may keep its own wording above that same underlying evidence.
 * No other observation may present the prior rows' raw facts; `guarded`
 * narrows that to the given facts (default: all of the prior rows' facts).
 */
export function matchVerifiedObservationRows(
	prior: Array<typeof memoryPublishedRows.$inferSelect>,
	memories: NativeMemory[],
	approved: ReadonlyMap<string, string>,
	guarded?: ReadonlySet<string>,
) {
	const raw = new Map(
		memories
			.filter((row) => row.fact_type !== "observation")
			.map((row) => [row.id, row]),
	);
	const observations = memories.filter(
		(row) => row.fact_type === "observation",
	);
	if (new Set(memories.map((row) => row.id)).size !== memories.length)
		return null;
	const matched = new Map<
		string,
		{ prior: (typeof prior)[number]; text: string }
	>();
	const sequence = [
		...prior.filter((old) => !approved.has(old.nativeId)),
		...prior.filter((old) => approved.has(old.nativeId)),
	];
	for (const old of sequence) {
		const wording = approved.get(old.nativeId);
		const candidates = observations.filter((row) =>
			wording
				? !matched.has(row.id) && sameSupport(old, row, raw)
				: samePriorObservation(old, row, raw),
		);
		if (candidates.length !== 1 || matched.has(candidates[0].id)) return null;
		matched.set(candidates[0].id, { prior: old, text: wording ?? old.text });
	}
	const priorRaw =
		guarded ??
		new Set(
			prior.flatMap((row) =>
				readAcknowledgedFacts(row.sourceFingerprintsJson).map(
					(fact) => fact.id,
				),
			),
		);
	if (
		observations.some(
			(row) =>
				!matched.has(row.id) &&
				row.source_memory_ids?.some((id) => priorRaw.has(id)),
		)
	)
		return null;
	return matched;
}

export function reconnectVerifiedObservations(
	prior: Array<typeof memoryPublishedRows.$inferSelect>,
	memories: NativeMemory[],
	approved: ReadonlyMap<string, string>,
	guarded?: ReadonlySet<string>,
) {
	const matches = matchVerifiedObservationRows(
		prior,
		memories,
		approved,
		guarded,
	);
	return (
		matches && new Map([...matches].map(([id, match]) => [id, match.text]))
	);
}

export function approvedMigrationObservationWording(
	tx: Tx,
	userId: string,
	bankId: string,
	prior: Array<typeof memoryPublishedRows.$inferSelect>,
	requiresPin = false,
) {
	const admitted = new Map(
		admittedNativeFacts(userId, bankId, tx).map((f) => [f.id, f]),
	);
	const result = new Map<string, string>();
	for (const old of prior) {
		const facts = readAcknowledgedFacts(old.sourceFingerprintsJson);
		const source = admitted.get(facts[0]?.id)?.source;
		if (
			!source ||
			!facts.every(
				(fact) =>
					admitted.get(fact.id)?.source.id === source.id &&
					admitted.get(fact.id)?.text === fact.text &&
					fact.assertedAtMs === source.assertedAt.getTime(),
			)
		)
			continue;
		const sourceFacts = readAcknowledgedFacts(source.acknowledgedFactsJson);
		if (sourceFacts.length !== facts.length) continue;
		const text = verifiedMigrationAuthoredWording(tx, source, requiresPin);
		if (
			text &&
			(!requiresPin ||
				parseJsonRecord(source.context).migrationExactWordingFamily !== true ||
				old.text === text)
		)
			result.set(old.nativeId, text);
	}
	return result;
}

/** Companions share the source, but only the exact original edit is pinned. */
export function approvedMigrationRankFamily(
	tx: Tx,
	userId: string,
	bankId: string,
	prior: Array<typeof memoryPublishedRows.$inferSelect>,
) {
	const marked = new Set(
		admittedNativeFacts(userId, bankId, tx)
			.filter(
				({ source }) =>
					parseJsonRecord(source.context).migrationExactWordingFamily === true,
			)
			.map(({ id }) => id),
	);
	if (!marked.size) return undefined;
	const rows = prior.filter((row) =>
		readAcknowledgedFacts(row.sourceFingerprintsJson).some((f) =>
			marked.has(f.id),
		),
	);
	if (!rows.length) return undefined;
	const approved = approvedMigrationObservationWording(
		tx,
		userId,
		bankId,
		rows,
		true,
	);
	const ids = new Set(
		rows.flatMap((row) =>
			readAcknowledgedFacts(row.sourceFingerprintsJson).map((f) => f.id),
		),
	);
	return { rows, approved, ids };
}

/**
 * One row for observations Hindsight wrote twice: the same wording over the
 * same supporting facts (an engine merge it dropped after a deleted
 * document's re-consolidation). Every observation was checked before; this
 * only leaves out exact twins, keeping the one the current generation
 * already shows, else the smallest id. A row whose wording or support differs
 * in any way is kept.
 */
function withoutTwinObservations(
	checked: Array<{ observation: NativeMemory; text: string }>,
	acknowledged: ReadonlyMap<string, AcknowledgedFact>,
	shown: Array<typeof memoryPublishedRows.$inferSelect>,
) {
	const published = new Set(shown.map(({ nativeId }) => nativeId));
	const kept = new Map<string, (typeof checked)[number]>();
	for (const entry of checked) {
		const ids = entry.observation.source_memory_ids ?? [];
		const key =
			new Set(ids).size === ids.length
				? JSON.stringify([
						memoryPresentationFingerprint(entry.text, entry.observation.text),
						memorySupportFingerprint(
							ids.map((id) => ({ id, text: acknowledged.get(id)?.text ?? "" })),
						),
					])
				: `observation:${entry.observation.id}`;
		const twin = kept.get(key);
		const preferred =
			!twin ||
			(published.has(entry.observation.id) &&
				!published.has(twin.observation.id)) ||
			(published.has(entry.observation.id) ===
				published.has(twin.observation.id) &&
				entry.observation.id < twin.observation.id);
		if (preferred) kept.set(key, entry);
	}
	const chosen = new Set([...kept.values()]);
	return checked.filter((entry) => chosen.has(entry));
}

export function publishNativeSnapshot(
	tx: Tx,
	input: {
		userId: string;
		bankId: string;
		epoch: number;
		expectedRevision: number;
		memories: NativeMemory[];
		sourceIds?: string[];
		prepared?: Map<string, string>;
		checkedActionIds?: string[];
		verifiedCuratedChanges?: boolean;
		verifiedCuratedDiff?: { sourceId: string; proofs: ReadonlySet<string> };
		/** The publishing Remove itself: its own exclusion does not apply to its own result. */
		ownActionId?: string;
	},
) {
	const prepared = new Map(
		input.prepared ?? prepareNativeSnapshot(input.memories),
	);
	const bank = assertMemoryBankFence(
		tx,
		input.userId,
		input.bankId,
		input.epoch,
	);
	if (bank.revision !== input.expectedRevision)
		throw new Error("memory_publication_stale");
	assertCurationPublication(tx, bank.id, bank.epoch, input);
	// A refused item is left out for good instead of holding the bank.
	const excluded = excludedNativeEvidence(tx, bank, input.ownActionId);
	const memories = withoutExcludedEvidence(input.memories, excluded);
	const sources = tx
		.select()
		.from(memorySourceRevisions)
		.where(
			and(
				eq(memorySourceRevisions.bankId, bank.id),
				inArray(memorySourceRevisions.state, ["accepted", "staged"]),
			),
		)
		.all()
		.filter(
			(source) =>
				source.state === "accepted" ||
				(input.sourceIds ?? []).includes(source.id),
		);
	const revoked = tx
		.select()
		.from(memoryRevocations)
		.where(eq(memoryRevocations.bankId, bank.id))
		.all();
	const acknowledged = new Map(
		sources.flatMap((source) =>
			readAcknowledgedFacts(source.acknowledgedFactsJson).map(
				(f) => [f.id, { ...f, source }] as const,
			),
		),
	);
	const raw = new Map(
		memories.filter((m) => m.fact_type !== "observation").map((m) => [m.id, m]),
	);
	const selectivelyArchived = new Map(
		sources.flatMap((source) => {
			const hash = parseJsonRecord(
				source.context,
			).migrationSelectiveArchivedHash;
			return typeof hash === "string" ? [[source.id, hash] as const] : [];
		}),
	);
	if (
		selectivelyArchived.size &&
		[...raw.values()].some(
			(fact) =>
				fact.document_id &&
				selectivelyArchived.get(fact.document_id) === memoryTextHash(fact.text),
		)
	)
		throw Error("memory_candidate_unaccepted");

	if (bank.generation) {
		const prior = readPublishedMemory(
			input.userId,
			bank.id,
			bank.generation,
			tx,
		);
		const approved = approvedMigrationObservationWording(
			tx,
			input.userId,
			bank.id,
			prior,
			true,
		);
		const required = new Set(
			prior
				.filter((row) => approved.has(row.nativeId))
				.flatMap((row) =>
					readAcknowledgedFacts(row.sourceFingerprintsJson).map((f) => f.id),
				),
		);
		if (required.size) {
			const family = prior.filter((row) =>
				readAcknowledgedFacts(row.sourceFingerprintsJson).some((f) =>
					required.has(f.id),
				),
			);
			const matched = reconnectVerifiedObservations(family, memories, approved);
			if (
				!matched ||
				family.some((row) =>
					readAcknowledgedFacts(row.sourceFingerprintsJson).some((fact) => {
						const source = acknowledged.get(fact.id)?.source;
						return (
							!source ||
							raw.get(fact.id)?.document_id !== source.id ||
							fact.assertedAtMs !==
								(source.explicitEditAt ?? source.assertedAt).getTime()
						);
					}),
				)
			)
				throw new NativeMemoryError(
					"memory_migration_authored_observation_changed",
					false,
				);
			for (const [id, text] of matched) prepared.set(id, text);
		}
	}

	// A complete standalone authored statement is its own approved display.
	// Never project it onto a mixed-support or ambiguous derived observation.
	for (const source of sources) {
		const facts = readAcknowledgedFacts(source.acknowledgedFactsJson);
		const ids = new Set(facts.map((fact) => fact.id));
		if (!ids.size || ids.size !== facts.length) continue;
		if (
			facts.some(
				(fact) =>
					raw.get(fact.id)?.document_id !== source.id ||
					raw.get(fact.id)?.text !== fact.text,
			)
		)
			continue;
		const candidates = memories.filter(
			(row) =>
				row.fact_type === "observation" &&
				row.source_memory_ids?.some((id) => ids.has(id)),
		);
		const [candidate] = candidates;
		if (
			candidates.length !== 1 ||
			candidate.source_memory_ids?.length !== ids.size ||
			new Set(candidate.source_memory_ids).size !== ids.size ||
			!candidate.source_memory_ids.every((id) => ids.has(id))
		)
			continue;
		const wording = verifiedMigrationAuthoredWording(tx, source, true);
		if (wording) prepared.set(candidate.id, wording);
	}

	const correctionDates = new Map<string, number>();
	const replayEdits = tx
		.select()
		.from(memoryActions)
		.where(
			and(
				eq(memoryActions.userId, bank.userId),
				eq(memoryActions.bankId, bank.id),
				eq(memoryActions.epoch, bank.epoch),
				eq(memoryActions.kind, "migration_edit"),
			),
		)
		.all();
	for (const edit of replayEdits) {
		const intent = parseActionIntent(edit.intentJson);
		if (!intent.replayOriginActionId || intent.outcome !== "accepted") continue;
		for (const receipt of intent.replayFactDates ?? []) {
			const fact = raw.get(receipt.id);
			const accepted = acknowledged.get(receipt.id);
			if (
				fact?.document_id !== receipt.sourceId ||
				accepted?.source.id !== receipt.sourceId ||
				accepted.text !== fact.text ||
				memoryTextHash(fact.text) !== receipt.textHash
			)
				continue;
			const time = edit.createdAt.getTime();
			correctionDates.set(
				receipt.id,
				Math.max(time, correctionDates.get(receipt.id) ?? time),
			);
		}
	}
	for (const [id, date] of correctionDates)
		if (Date.parse(raw.get(id)?.mentioned_at ?? "") !== date)
			throw new Error("memory_candidate_correction_date");
	if (
		!input.verifiedCuratedChanges &&
		curatedObservationChanges(
			tx,
			bank,
			memories,
			prepared,
			input.verifiedCuratedDiff?.sourceId,
			excluded,
		).some(({ proof }) => !input.verifiedCuratedDiff?.proofs.has(proof))
	)
		throw new NativeMemoryError("memory_candidate_curation_drift", true);
	const generation = randomUUID();
	const checked: Array<{ observation: NativeMemory; text: string }> = [];
	for (const observation of memories.filter(
		(m) => m.fact_type === "observation",
	)) {
		const ids = observation.source_memory_ids ?? [];
		// Any unrecognized, changed or revoked supporting fact quarantines the whole candidate row.
		if (
			!ids.length ||
			ids.some((id) => {
				const a = acknowledged.get(id);
				return (
					!a ||
					raw.get(id)?.text !== a.text ||
					revoked.some(
						(r) =>
							r.sourceId === a.source.id ||
							(r.nativeFactId === id &&
								(r.nativeTextHash === null ||
									r.nativeTextHash === memoryTextHash(a.text))),
					)
				);
			})
		)
			throw new Error("memory_candidate_unaccepted");
		checked.push({
			observation,
			text: prepared.get(observation.id) ?? observation.text,
		});
	}
	for (const { observation, text } of withoutTwinObservations(
		checked,
		acknowledged,
		bank.generation
			? publishedRowsForGeneration(tx, bank.id, bank.epoch, bank.generation)
			: [],
	)) {
		const ids = observation.source_memory_ids ?? [];
		const dates = ids.map(
			(id) =>
				correctionDates.get(id) ??
				(
					acknowledged.get(id)?.source.explicitEditAt ??
					acknowledged.get(id)?.source.assertedAt
				)?.getTime() ??
				0,
		);
		tx.insert(memoryPublishedRows)
			.values({
				id: randomUUID(),
				bankId: bank.id,
				generation,
				epoch: bank.epoch,
				nativeId: observation.id,
				text,
				nativeText: observation.text,
				sourceIdsJson: JSON.stringify(ids),
				sourceFingerprintsJson: JSON.stringify(
					ids.map((id, index) => ({
						id,
						text: acknowledged.get(id)?.text,
						mentionedAt: raw.get(id)?.mentioned_at ?? null,
						assertedAtMs: dates[index],
					})),
				),
				updatedAt: new Date(Math.max(...dates)),
			})
			.run();
	}
	recordIndependentSourceObservations(
		tx,
		bank,
		generation,
		sources,
		acknowledged,
		raw,
	);
	tx.update(memorySourceRevisions)
		.set({ state: "accepted", acceptedGeneration: generation })
		.where(
			and(
				eq(memorySourceRevisions.userId, input.userId),
				eq(memorySourceRevisions.bankId, bank.id),
				eq(memorySourceRevisions.epoch, bank.epoch),
				or(
					eq(memorySourceRevisions.state, "accepted"),
					and(
						eq(memorySourceRevisions.state, "staged"),
						inArray(memorySourceRevisions.id, input.sourceIds ?? []),
					),
				),
			),
		)
		.run();
	tx.update(memoryBanks)
		.set({
			generation,
			previousGeneration: bank.generation,
			revision: bank.revision + 1,
			status: "ready",
		})
		.where(eq(memoryBanks.id, bank.id))
		.run();
	tx.delete(memoryPublishedRows)
		.where(
			and(
				eq(memoryPublishedRows.bankId, bank.id),
				notInArray(memoryPublishedRows.generation, [
					generation,
					...(bank.generation ? [bank.generation] : []),
				]),
			),
		)
		.run();
	// The labels Hindsight's extraction wrote, and each fact's event date,
	// go where recall and the page read them.
	recordNativeFactLabels(
		tx,
		bank.id,
		bank.scopeKey === "personal" ? "personal" : "project",
		memories,
	);
	return generation;
}
/**
 * Accepts an unchanged resend into the generation the person already sees,
 * publishing nothing new: used when Hindsight's display for its facts cannot
 * be verified (re-rendered, renumbered, an unchecked extra observation or a
 * moved date), so the reviewed rows stay as they were instead of the chat's
 * facts going unpublished. Fenced and held exactly like a publication.
 */
export function keepPublishedGeneration(
	tx: Tx,
	input: {
		userId: string;
		bankId: string;
		epoch: number;
		expectedRevision: number;
		sourceIds: string[];
	},
) {
	const bank = assertMemoryBankFence(
		tx,
		input.userId,
		input.bankId,
		input.epoch,
	);
	if (bank.revision !== input.expectedRevision)
		throw new Error("memory_publication_stale");
	if (!bank.generation) throw new Error("memory_generation_missing");
	assertCurationPublication(tx, bank.id, bank.epoch);
	tx.update(memorySourceRevisions)
		.set({ state: "accepted", acceptedGeneration: bank.generation })
		.where(
			and(
				eq(memorySourceRevisions.userId, input.userId),
				eq(memorySourceRevisions.bankId, bank.id),
				eq(memorySourceRevisions.epoch, bank.epoch),
				eq(memorySourceRevisions.state, "staged"),
				inArray(memorySourceRevisions.id, input.sourceIds),
			),
		)
		.run();
	return bank.generation;
}

/** Revocations are read on every page/detail/recall, including old generation references. */
export function readPublishedMemory(
	userId: string,
	bankId: string,
	generation?: string,
	database: DatabaseInstance | Tx = db,
	mode: "memory" | "owner-export" = "memory",
) {
	return database.transaction((tx) => {
		const bank = tx
			.select()
			.from(memoryBanks)
			.where(and(eq(memoryBanks.id, bankId), eq(memoryBanks.userId, userId)))
			.get();
		if (!bank) return [];
		const admitted = new Map(
			admittedNativeFacts(userId, bankId, database, mode).map((f) => [f.id, f]),
		);
		if (
			generation &&
			generation !== bank.generation &&
			generation !== bank.previousGeneration
		)
			throw new Error("memory_generation_stale");
		const selected = generation ?? bank.generation;
		if (!selected) return [];
		return publishedRowsForGeneration(tx, bankId, bank.epoch, selected).filter(
			(row) => {
				const facts = readAcknowledgedFacts(row.sourceFingerprintsJson);
				return (
					facts.length > 0 &&
					facts.every((f) => admitted.get(f.id)?.text === f.text)
				);
			},
		);
	});
}
