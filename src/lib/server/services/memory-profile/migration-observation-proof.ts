import { and, eq } from "drizzle-orm";
import { memoryActions, type memoryPublishedRows } from "$lib/server/db/schema";
import type { Tx } from "../jobs/types";
import type { NativeMemory } from "./contracts";
import { parseJsonRecord } from "./internal-json";
import {
	inspectMemoryMigration,
	recordedMeaningCheck,
} from "./migration-progress";
import { splitNativeNotes } from "./presentation";
import {
	admittedNativeFacts,
	approvedMigrationObservationWording,
	approvedMigrationRankFamily,
	matchVerifiedObservationRows,
	readAcknowledgedFacts,
	readPublishedMemory,
	reconnectVerifiedObservations,
	samePriorObservation,
	sameSupport,
	verifiedMigrationAuthoredWording,
} from "./publication";
import {
	knownQuarantineWithdrawal,
	normalizeQuarantineText,
} from "./quarantine-policy";
import { assertMemorySourceCurrent, memoryScopeKey } from "./revisions";

type PublishedRow = typeof memoryPublishedRows.$inferSelect;

export {
	reconnectVerifiedObservations,
	samePriorObservation,
} from "./publication";

/** A plain rewind may verify one regenerated ordinary presentation. */
export function matchPriorMigrationRepresentation(
	prior: PublishedRow[],
	memories: NativeMemory[],
	allowRenumbered: boolean,
	protectedRows?: PublishedRow[],
) {
	const byId = new Map(memories.map((row) => [row.id, row]));
	const raw = new Map(
		memories
			.filter((row) => row.fact_type !== "observation")
			.map((row) => [row.id, row]),
	);
	const used = new Set<string>();
	const exact: PublishedRow[] = [];
	const unresolved: PublishedRow[] = [];
	for (const row of prior) {
		const live = byId.get(row.nativeId);
		if (live && !used.has(live.id) && samePriorObservation(row, live, raw)) {
			used.add(live.id);
			exact.push(row);
		} else unresolved.push(row);
	}
	if (unresolved.length && !allowRenumbered) return null;
	const missing: PublishedRow[] = [];
	for (const row of unresolved) {
		const candidates = memories.filter(
			(m) => !used.has(m.id) && samePriorObservation(row, m, raw),
		);
		if (candidates.length > 1) return null;
		const [match] = candidates;
		if (!match) {
			missing.push(row);
			continue;
		}
		used.add(match.id);
		exact.push(row);
	}
	if (!missing.length) return { exact, regenerated: null };
	const [row] = missing;
	if (
		missing.length !== 1 ||
		!protectedRows ||
		protectedRows.some((p) => p.id === row.id)
	)
		return null;
	// Confirm the raw evidence also survives in an independently exact
	// prior observation. The regenerated row cannot be its only witness.
	const preservedEvidence = new Set(
		exact.flatMap((priorRow) =>
			readAcknowledgedFacts(priorRow.sourceFingerprintsJson).map(
				(fact) => fact.id,
			),
		),
	);
	if (
		!readAcknowledgedFacts(row.sourceFingerprintsJson).every((fact) =>
			preservedEvidence.has(fact.id),
		)
	)
		return null;
	const candidates = memories.filter(
		(live) => !used.has(live.id) && sameSupport(row, live, raw),
	);
	return candidates.length === 1
		? { exact, regenerated: { prior: row, nativeId: candidates[0].id } }
		: null;
}

/** Match each prior publication to exactly one unchanged native counterpart. */
export function matchPriorMigrationObservations(
	prior: PublishedRow[],
	memories: NativeMemory[],
	allowRenumbered: boolean,
) {
	return (
		matchPriorMigrationRepresentation(prior, memories, allowRenumbered) !== null
	);
}

/** Admitted facts from authored statements or explicit edits. */
function protectedMigrationFacts(
	admitted: ReturnType<typeof admittedNativeFacts>,
) {
	return new Set(
		admitted
			.filter(
				({ source }) =>
					typeof parseJsonRecord(source.context).migrationAuthoredId ===
						"string" || source.explicitEditAt !== null,
			)
			.map(({ id }) => id),
	);
}

// Default historical replay may consolidate its own claims. Explicit authored
// observations already published during preparation stay exact.
export function protectedMigrationObservations(
	tx: Tx,
	userId: string,
	bankId: string,
) {
	const protectedIds = protectedMigrationFacts(
		admittedNativeFacts(userId, bankId, tx),
	);
	return readPublishedMemory(userId, bankId, undefined, tx).filter((row) =>
		readAcknowledgedFacts(row.sourceFingerprintsJson).some((fact) =>
			protectedIds.has(fact.id),
		),
	);
}

export function assertHistoryPreservesAuthoredObservations(
	tx: Tx,
	userId: string,
	bankId: string,
	memories: NativeMemory[],
	incoming?: { sourceId: string; scopeKey: string },
) {
	const protectedRows = protectedMigrationObservations(tx, userId, bankId);
	const approved = approvedMigrationObservationWording(
		tx,
		userId,
		bankId,
		protectedRows,
		true,
	);
	// Ordinary history that corroborates a protected row may also have its own
	// observation; only the authored and explicitly edited facts that a
	// protected row presents must not be presented again outside it.
	const protectedFacts = protectedMigrationFacts(
		admittedNativeFacts(userId, bankId, tx),
	);
	const guarded = new Set(
		protectedRows.flatMap((row) =>
			readAcknowledgedFacts(row.sourceFingerprintsJson)
				.map((fact) => fact.id)
				.filter((id) => protectedFacts.has(id)),
		),
	);
	if (
		reconnectVerifiedObservations(protectedRows, memories, approved, guarded) ||
		(incoming &&
			corroboratedAuthoredObservations(
				tx,
				{ userId, bankId, ...incoming },
				protectedRows,
				memories,
				approved,
				guarded,
			))
	)
		return;
	throw Error("memory_migration_authored_observation_changed");
}

/** A plain authored statement: no exact pinned wording, edit, removal or family. */
function plainAuthoredSource(
	tx: Tx,
	source: ReturnType<typeof admittedNativeFacts>[number]["source"],
) {
	const context = parseJsonRecord(source.context);
	return (
		context.migrationExactWording !== true &&
		context.migrationExactWordingFamily !== true &&
		typeof context.legacyReviewResolutionId !== "string" &&
		verifiedMigrationAuthoredWording(tx, source, false) === source.text &&
		verifiedMigrationAuthoredWording(tx, source, true) === undefined
	);
}

/**
 * Older eligible history may corroborate a generated observation of a plain
 * authored statement without changing what it shows. The published support
 * must be the statement's own facts only, so the wording came from the
 * statement and not from a chat. The observation keeps its native ID, its
 * shown wording and its facts; its native text may differ only by Hindsight's
 * dated notes made from the facts the job adds. Every added fact comes from
 * the incoming history source, which is older than the statement. It may also
 * form an observation of its own, or appear only inside this row (the owner
 * extended the rule to that on 21 November 2026). A note is Hindsight's record
 * of an earlier state, kept only in the native text; it is never shown. A row
 * that already carries chat evidence
 * (corroborated before, or mixed when history ran first) stays exact. Exact
 * edits, their companions, explicit edits and statements tied to an edit or
 * removal stay exact. Publication keeps the observation's native support;
 * the final exact reconnect still decides.
 */
function corroboratedAuthoredObservations(
	tx: Tx,
	input: { userId: string; bankId: string; scopeKey: string; sourceId: string },
	protectedRows: PublishedRow[],
	memories: NativeMemory[],
	approved: ReadonlyMap<string, string>,
	protectedFacts: ReadonlySet<string>,
) {
	const { userId, bankId, scopeKey, sourceId } = input;
	const inventory = ordinaryMigrationInventory(inspectMemoryMigration(userId));
	const incoming = assertMemorySourceCurrent(tx, sourceId, userId, bankId);
	if (!ordinaryMigrationSource(incoming, scopeKey, inventory)) return false;
	const raw = new Map(
		memories
			.filter((row) => row.fact_type !== "observation")
			.map((row) => [row.id, row]),
	);
	const observations = memories.filter(
		(row) => row.fact_type === "observation",
	);
	const admitted = new Map(
		admittedNativeFacts(userId, bankId, tx).map((fact) => [fact.id, fact]),
	);
	const family = approvedMigrationRankFamily(
		tx,
		userId,
		bankId,
		readPublishedMemory(userId, bankId, undefined, tx),
	);
	const trimmed = new Map<string, NativeMemory>();
	for (const old of protectedRows) {
		const live = observations.find((row) => row.id === old.nativeId);
		if (
			!live ||
			samePriorObservation(old, live, raw) ||
			approved.has(old.nativeId) ||
			family?.rows.some((row) => row.id === old.id)
		)
			continue;
		const original = readAcknowledgedFacts(old.sourceFingerprintsJson);
		const originalIds = original.map((fact) => fact.id);
		const support = live.source_memory_ids ?? [];
		const added = support.filter((id) => !originalIds.includes(id));
		const facts = (ids: string[]) =>
			ids.flatMap((id) => {
				const fact = raw.get(id);
				return fact ? [fact] : [];
			});
		// Only the added facts' own dated notes may have been appended.
		const notesOnly =
			live.text === old.nativeText ||
			splitNativeNotes(live, facts(added)) === old.nativeText;
		if (
			!notesOnly ||
			!original.length ||
			!added.length ||
			new Set(support).size !== support.length ||
			!original.every((fact) => {
				const source = admitted.get(fact.id)?.source;
				const current = raw.get(fact.id);
				return (
					support.includes(fact.id) &&
					!!source &&
					admitted.get(fact.id)?.text === fact.text &&
					current?.document_id === source.id &&
					current.text === fact.text &&
					(current.mentioned_at ?? null) === (fact.mentionedAt ?? null) &&
					fact.assertedAtMs === source.assertedAt.getTime() &&
					fact.assertedAtMs > incoming.assertedAt.getTime() &&
					plainAuthoredSource(tx, source)
				);
			}) ||
			!added.every(
				(id) =>
					raw.get(id)?.document_id === incoming.id &&
					!admitted.has(id) &&
					!protectedFacts.has(id),
			) ||
			splitNativeNotes(live, facts(support)) !== old.text
		)
			continue;
		const view = {
			...live,
			text: old.nativeText,
			source_memory_ids: originalIds,
		};
		if (samePriorObservation(old, view, raw)) trimmed.set(live.id, view);
	}
	return (
		trimmed.size > 0 &&
		!!reconnectVerifiedObservations(
			protectedRows,
			memories.map((row) => trimmed.get(row.id) ?? row),
			approved,
			protectedFacts,
		)
	);
}

// Observation count and wording may change, but every prior raw fact must
// remain exactly present and represented by a current native observation.
export function matchOrdinaryMigrationEvidence(
	prior: PublishedRow[],
	memories: NativeMemory[],
) {
	const raw = new Map(
		memories
			.filter((row) => row.fact_type !== "observation")
			.map((row) => [row.id, row]),
	);
	const support = new Set(
		memories
			.filter((row) => row.fact_type === "observation")
			.flatMap((row) => row.source_memory_ids ?? []),
	);
	return prior.every((row) => {
		const facts = readAcknowledgedFacts(row.sourceFingerprintsJson);
		return (
			facts.length > 0 &&
			facts.every((fact) => {
				const live = raw.get(fact.id);
				return (
					support.has(fact.id) &&
					live?.text === fact.text &&
					(live.mentioned_at ?? null) === (fact.mentionedAt ?? null)
				);
			})
		);
	});
}

// An unlocated withdrawal permits no new representation of a dropped row's
// raw support. Its exact, already-visible companion must still be present.
export function matchOrdinaryMigrationCompanions(
	prior: PublishedRow[],
	strict: PublishedRow[],
	memories: NativeMemory[],
) {
	const raw = new Map(
		memories
			.filter((row) => row.fact_type !== "observation")
			.map((row) => [row.id, row]),
	);
	const observations = memories.filter(
		(row) => row.fact_type === "observation",
	);
	const priorRawIds = new Set(
		prior.flatMap((row) =>
			readAcknowledgedFacts(row.sourceFingerprintsJson).map((fact) => fact.id),
		),
	);
	const priorByNativeId = new Map(prior.map((row) => [row.nativeId, row]));
	if (
		observations.some((live) => {
			if (!live.source_memory_ids?.some((id) => priorRawIds.has(id)))
				return false;
			const old = priorByNativeId.get(live.id);
			return !old || !samePriorObservation(old, live, raw);
		})
	)
		return null;
	const strictIds = new Set(strict.map((row) => row.id));
	const missing = prior.filter(
		(row) => !observations.some((live) => samePriorObservation(row, live, raw)),
	);
	if (missing.some((row) => strictIds.has(row.id))) return null;
	for (const row of missing) {
		const ids = new Set(
			readAcknowledgedFacts(row.sourceFingerprintsJson).map((fact) => fact.id),
		);
		const representations = observations.filter((live) =>
			live.source_memory_ids?.some((id) => ids.has(id)),
		);
		if (
			representations.length !== 1 ||
			!sameSupport(row, representations[0], raw) ||
			!prior.some(
				(old) =>
					old.nativeId === representations[0].id &&
					samePriorObservation(old, representations[0], raw),
			)
		)
			return null;
	}
	return matchPriorMigrationRepresentation(
		prior.filter((row) => !missing.includes(row)),
		memories,
		true,
	);
}

function unlocatedScopeActions(
	inventory: ReturnType<typeof inspectMemoryMigration>,
	scopeKey: string,
) {
	return inventory.actions.filter(
		(action) =>
			action.kind !== "authored" &&
			!action.sourceIds.length &&
			(!action.scope || memoryScopeKey(action.scope) === scopeKey),
	);
}

function containsWithdrawnWording(
	actions: ReturnType<typeof unlocatedScopeActions>,
	texts: string[],
) {
	const withdrawn = actions.flatMap((action) =>
		action.kind === "edit" || action.kind === "remove"
			? action.before
					.split(/\r?\n/u)
					.map(normalizeQuarantineText)
					.filter(Boolean)
			: [],
	);
	return (
		withdrawn.length > 0 &&
		texts.some((text) => {
			const normalized = normalizeQuarantineText(text);
			return withdrawn.some((fragment) => normalized.includes(fragment));
		})
	);
}

export function assertMigrationWithdrawalWording(
	userId: string,
	scopeKey: string,
	memories: NativeMemory[],
) {
	const actions = unlocatedScopeActions(
		inspectMemoryMigration(userId),
		scopeKey,
	);
	if (
		containsWithdrawnWording(
			actions,
			memories.map((row) => row.text),
		)
	)
		throw Error("memory_migration_withdrawal_boundary");
}

/** Reconnect one surviving correction only when the durable hold bound its evidence. */
export function matchCorrectionHoldAuthoredRekey(
	tx: Tx,
	userId: string,
	bankId: string,
	rewound: Record<string, unknown>,
	prior: PublishedRow[],
	memories: NativeMemory[],
) {
	if (
		rewound.holdCorrectionConflict !== true ||
		typeof rewound.correctionAuthoredObservationId !== "string" ||
		!Array.isArray(rewound.sourceIds) ||
		rewound.sourceIds.length !== 1 ||
		!Array.isArray(rewound.correctionHolds) ||
		rewound.correctionHolds.length !== 1
	)
		return null;
	const hold = parseJsonRecord(JSON.stringify(rewound.correctionHolds[0]));
	const sourceIds = hold.protectedSourceIds;
	if (
		!Array.isArray(sourceIds) ||
		sourceIds.length !== 1 ||
		typeof sourceIds[0] !== "string" ||
		typeof hold.assertedAt !== "string"
	)
		return null;
	const admitted = admittedNativeFacts(userId, bankId, tx);
	const byId = new Map(admitted.map((fact) => [fact.id, fact]));
	const raw = new Map(
		memories
			.filter((row) => row.fact_type !== "observation")
			.map((row) => [row.id, row]),
	);
	if (
		raw.size !== admitted.length ||
		admitted.some((fact) => {
			const live = raw.get(fact.id);
			return live?.document_id !== fact.source.id || live.text !== fact.text;
		})
	)
		return null;
	const observations = memories.filter(
		(row) => row.fact_type === "observation",
	);
	const missing = prior.filter(
		(row) => !observations.some((live) => samePriorObservation(row, live, raw)),
	);
	if (missing.length !== 1) return null;
	const [target] = missing;
	if (target.nativeId !== rewound.correctionAuthoredObservationId) return null;
	const support = readAcknowledgedFacts(target.sourceFingerprintsJson);
	const heldDate = Date.parse(hold.assertedAt);
	if (
		!support.length ||
		support.some(
			(fact) =>
				byId.get(fact.id)?.source.id !== sourceIds[0] ||
				typeof fact.assertedAtMs !== "number" ||
				!(fact.assertedAtMs > heldDate),
		)
	)
		return null;
	const approved = approvedMigrationObservationWording(tx, userId, bankId, [
		target,
	]);
	const text = approved.get(target.nativeId);
	if (!text) return null;
	const source = assertMemorySourceCurrent(tx, sourceIds[0], userId, bankId);
	if (text !== source.text) return null;
	const ids = new Set(support.map((fact) => fact.id));
	const companions = prior.filter(
		(row) =>
			row.id !== target.id &&
			readAcknowledgedFacts(row.sourceFingerprintsJson).some((fact) =>
				ids.has(fact.id),
			),
	);
	if (companions.length !== 0 && companions.length !== 2) return null;
	if (companions.some((row) => row.text === text)) return null;
	const matches = matchVerifiedObservationRows(prior, memories, approved);
	if (!matches || matches.size !== observations.length) return null;
	const successor = [...matches].find(
		([, match]) => match.prior.id === target.id,
	);
	if (!successor) return null;
	return {
		target,
		nativeId: successor[0],
		text,
		source,
		family: companions.length > 0,
		prepared: new Map([...matches].map(([id, match]) => [id, match.text])),
	};
}

/**
 * Whether an operator-approved unlocated removal stops holding this
 * publication back. A delivery that is not default history (an authored
 * statement or an explicitly included chat) is not the history the removal is
 * checked against. A default-history chat qualifies only once its own forget
 * step recorded a passed final review for this revision.
 */
function meaningChecked(
	tx: Tx,
	userId: string,
	action: ReturnType<typeof unlocatedScopeActions>[number],
	applyingDefault: boolean,
	delivery: { sourceId: string },
) {
	if (!action.curateAllHistory) return false;
	if (!applyingDefault) return true;
	return recordedMeaningCheck(tx, userId, action.id, delivery.sourceId);
}

export function assertDefaultHistoryWithdrawalBoundary(
	tx: Tx,
	userId: string,
	bankId: string,
	scopeKey: string,
	memories: NativeMemory[],
	applyingDefault = true,
	delivery?: { sourceId: string },
) {
	const actions = unlocatedScopeActions(
		inspectMemoryMigration(userId),
		scopeKey,
	);
	if (!actions.length) return;
	if (
		!applyingDefault &&
		!admittedNativeFacts(userId, bankId, tx).some(
			({ source }) =>
				parseJsonRecord(source.context).migrationDefaultHistory === true,
		)
	)
		return;
	// An approved removal's own wording stays refused whatever its check found.
	if (
		containsWithdrawnWording(
			actions,
			memories.map((row) => row.text),
		)
	)
		throw Error("memory_migration_withdrawal_boundary");
	// Only a delivery can be let through; recovery tools stay held.
	if (
		delivery &&
		actions.every((action) =>
			meaningChecked(tx, userId, action, applyingDefault, delivery),
		)
	)
		return;
	const prior = readPublishedMemory(userId, bankId, undefined, tx);
	if (
		!reconnectVerifiedObservations(
			prior,
			memories,
			approvedMigrationObservationWording(tx, userId, bankId, prior, true),
		)
	)
		throw Error("memory_migration_withdrawal_boundary");
}

export function assertMigratedHistoryWithdrawalBoundary(
	tx: Tx,
	userId: string,
	banks: { id: string; scopeKey: string }[],
) {
	const inventory = inspectMemoryMigration(userId);
	for (const bank of banks) {
		const actions = unlocatedScopeActions(inventory, bank.scopeKey);
		if (!actions.length) continue;
		const historical = admittedNativeFacts(userId, bank.id, tx).filter(
			({ source }) =>
				parseJsonRecord(source.context).migrationDefaultHistory === true,
		);
		if (!historical.length) continue;
		const ids = new Set(historical.map((fact) => fact.id));
		const derived = readPublishedMemory(userId, bank.id, undefined, tx).filter(
			(row) =>
				readAcknowledgedFacts(row.sourceFingerprintsJson).some((fact) =>
					ids.has(fact.id),
				),
		);
		if (
			containsWithdrawnWording(actions, [
				...historical.map((fact) => fact.text),
				...derived.flatMap((row) => [row.text, row.nativeText]),
			])
		)
			throw Error("memory_migration_withdrawal_boundary");
	}
}

function ordinaryMigrationInventory(
	inventory: ReturnType<typeof inspectMemoryMigration>,
) {
	return {
		inventory,
		originals: new Map(inventory.sources.map((source) => [source.id, source])),
		linked: new Set(inventory.actions.flatMap((action) => action.sourceIds)),
	};
}

function ordinaryMigrationSource(
	source: ReturnType<typeof assertMemorySourceCurrent>,
	scopeKey: string,
	{
		inventory,
		originals,
		linked,
	}: ReturnType<typeof ordinaryMigrationInventory>,
) {
	const context = parseJsonRecord(source.context);
	const original = originals.get(source.messageId ?? "");
	return (
		source.messageId &&
		!source.explicitEditAt &&
		!source.predecessorSourceId &&
		context.migrationDefaultHistory === true &&
		typeof context.migrationAuthoredId !== "string" &&
		!linked.has(source.messageId) &&
		!linked.has(source.lineageId) &&
		!linked.has(source.id) &&
		original?.defaultHistory &&
		original.eligibility === "eligible" &&
		!original.replayActionIds?.length &&
		!knownQuarantineWithdrawal(inventory, original, source.text) &&
		original.text === source.text &&
		original.assertedAt === source.assertedAt.toISOString() &&
		original.lineageId === source.lineageId &&
		original.conversationId === source.conversationId &&
		memoryScopeKey(original.scope) === scopeKey
	);
}

function ordinaryMigrationFacts(
	tx: Tx,
	userId: string,
	bankId: string,
	scopeKey: string,
	inventory: ReturnType<typeof ordinaryMigrationInventory>,
) {
	const ordinaryIds = new Map<string, number>();
	const eligibility = new Map<string, boolean>();
	for (const fact of admittedNativeFacts(userId, bankId, tx)) {
		const source = fact.source;
		if (!eligibility.has(source.id)) {
			const eligible = Boolean(
				ordinaryMigrationSource(source, scopeKey, inventory),
			);
			if (eligible) assertMemorySourceCurrent(tx, source.id, userId, bankId);
			eligibility.set(source.id, eligible);
		}
		if (eligibility.get(source.id))
			ordinaryIds.set(fact.id, source.assertedAt.getTime());
	}
	return ordinaryIds;
}

export type SelectiveSupportExpansion = {
	observationId: string;
	appendId: string;
};

/** Preserve one ordinary presentation when another eligible original supports it. */
export function matchSelectiveSupportExpansion(
	tx: Tx,
	input: { userId: string; bankId: string; scopeKey: string; sourceId: string },
	prior: PublishedRow[],
	memories: NativeMemory[],
	approved: ReadonlyMap<string, string>,
	expected?: SelectiveSupportExpansion,
) {
	const { userId, bankId, scopeKey, sourceId } = input;
	const inventory = inspectMemoryMigration(userId);
	if (
		unlocatedScopeActions(inventory, scopeKey).length ||
		tx
			.select({ id: memoryActions.id })
			.from(memoryActions)
			.where(
				and(eq(memoryActions.userId, userId), eq(memoryActions.bankId, bankId)),
			)
			.get()
	)
		return null;
	const indexed = ordinaryMigrationInventory(inventory);
	const incoming = assertMemorySourceCurrent(tx, sourceId, userId, bankId);
	if (!ordinaryMigrationSource(incoming, scopeKey, indexed)) return null;
	const ordinary = ordinaryMigrationFacts(
		tx,
		userId,
		bankId,
		scopeKey,
		indexed,
	);
	const raw = new Map(
		memories
			.filter((row) => row.fact_type !== "observation")
			.map((row) => [row.id, row]),
	);
	const candidates = prior.flatMap((old) => {
		const live = memories.find((row) => row.id === old.nativeId);
		if (live?.fact_type !== "observation" || live.text !== old.nativeText)
			return [];
		const original = readAcknowledgedFacts(old.sourceFingerprintsJson);
		const originalIds = original.map((fact) => fact.id);
		const support = live.source_memory_ids ?? [];
		const added = support.filter((id) => !originalIds.includes(id));
		if (
			!originalIds.length ||
			!original.every(
				(fact) =>
					typeof fact.assertedAtMs === "number" &&
					ordinary.get(fact.id) === fact.assertedAtMs &&
					support.includes(fact.id),
			) ||
			support.length !== originalIds.length + 1 ||
			added.length !== 1 ||
			raw.get(added[0])?.document_id !== sourceId ||
			memories.filter(
				(row) =>
					row.fact_type === "observation" &&
					row.source_memory_ids?.includes(added[0]),
			).length !== 1
		)
			return [];
		const trimmed = { ...live, source_memory_ids: originalIds };
		return samePriorObservation(old, trimmed, raw)
			? [
					{
						live,
						trimmed,
						expansion: { observationId: live.id, appendId: added[0] },
					},
				]
			: [];
	});
	if (candidates.length !== 1) return null;
	const [{ live, trimmed, expansion }] = candidates;
	if (
		expected &&
		(expected.observationId !== expansion.observationId ||
			expected.appendId !== expansion.appendId)
	)
		return null;
	const prepared = reconnectVerifiedObservations(
		prior,
		memories.map((row) => (row === live ? trimmed : row)),
		approved,
	);
	return prepared && { prepared, expansion };
}

/** Only current, unedited default-history originals may use the optional rule.
 * All other evidence and anything tied to an explicit action stay exact.
 */
export function matchPlainMigrationRewind(
	tx: Tx,
	userId: string,
	bankId: string,
	scopeKey: string,
	prior: PublishedRow[],
	memories: NativeMemory[],
	allowOrdinary: boolean,
	reviewedSourceId?: string,
) {
	const fallback = () =>
		matchPriorMigrationRepresentation(
			prior,
			memories,
			true,
			allowOrdinary
				? undefined
				: protectedMigrationObservations(tx, userId, bankId),
		);
	const inventory = inspectMemoryMigration(userId);
	const unlocated = unlocatedScopeActions(inventory, scopeKey);
	if (!allowOrdinary && !unlocated.length) return fallback();
	if (!matchOrdinaryMigrationEvidence(prior, memories)) return null;
	if (
		containsWithdrawnWording(
			unlocated,
			memories.map((row) => row.text),
		)
	)
		return null;
	const explicitAction = tx
		.select({ id: memoryActions.id })
		.from(memoryActions)
		.where(
			and(eq(memoryActions.userId, userId), eq(memoryActions.bankId, bankId)),
		)
		.get();
	if (
		unlocated.some(
			(action) =>
				action.kind !== "remove" ||
				!action.scope ||
				!normalizeQuarantineText(action.before) ||
				!inventory.exceptions.some(
					({ id, reason }) => id === action.id && reason === "missing_source",
				),
		)
	)
		return reviewedSourceId
			? null
			: matchOrdinaryMigrationCompanions(prior, prior, memories);
	if (reviewedSourceId && explicitAction) return null;
	if (!allowOrdinary || explicitAction)
		return unlocated.length
			? matchOrdinaryMigrationCompanions(prior, prior, memories)
			: fallback();
	const ordinaryIds = ordinaryMigrationFacts(
		tx,
		userId,
		bankId,
		scopeKey,
		ordinaryMigrationInventory(inventory),
	);
	const strict = prior.filter((row) => {
		const facts = readAcknowledgedFacts(row.sourceFingerprintsJson);
		return !facts.length || !facts.every((fact) => ordinaryIds.has(fact.id));
	});
	if (reviewedSourceId) {
		if (!unlocated.length) return null;
		const raw = new Map(
			memories
				.filter((row) => row.fact_type !== "observation")
				.map((row) => [row.id, row]),
		);
		const observations = memories.filter(
			(row) => row.fact_type === "observation",
		);
		const exact = prior.filter((row) =>
			observations.some(
				(live) =>
					live.id === row.nativeId && samePriorObservation(row, live, raw),
			),
		);
		const missing = prior.filter((row) => !exact.includes(row));
		if (missing.length !== 1 || strict.includes(missing[0])) return null;
		const oldSupport = new Set(
			readAcknowledgedFacts(missing[0].sourceFingerprintsJson).map(
				(fact) => fact.id,
			),
		);
		const priorRaw = new Set(
			prior.flatMap((row) =>
				readAcknowledgedFacts(row.sourceFingerprintsJson).map(
					(fact) => fact.id,
				),
			),
		);
		const exactIds = new Set(exact.map((row) => row.nativeId));
		const changed = observations.filter(
			(live) =>
				!exactIds.has(live.id) &&
				live.source_memory_ids?.some((id) => priorRaw.has(id)),
		);
		if (changed.length !== 1 || changed[0].id !== missing[0].nativeId)
			return null;
		if (
			observations.some((live) => {
				if (exactIds.has(live.id) || live.id === changed[0].id) return false;
				const ids = live.source_memory_ids ?? [];
				return (
					!ids.length ||
					ids.some((id) => raw.get(id)?.document_id !== reviewedSourceId)
				);
			})
		)
			return null;
		const support = changed[0].source_memory_ids ?? [];
		const added = support.filter((id) => !oldSupport.has(id));
		if (
			new Set(support).size !== support.length ||
			![...oldSupport].every((id) => support.includes(id)) ||
			!added.length ||
			!added.every((id) => raw.get(id)?.document_id === reviewedSourceId)
		)
			return null;
		return { exact, regenerated: null };
	}
	return unlocated.length
		? matchOrdinaryMigrationCompanions(prior, strict, memories)
		: matchPriorMigrationRepresentation(strict, memories, true);
}
