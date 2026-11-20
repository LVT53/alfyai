import { and, eq } from "drizzle-orm";
import { memoryActions, type memoryPublishedRows } from "$lib/server/db/schema";
import type { Tx } from "../jobs/types";
import type { NativeMemory } from "./contracts";
import { parseJsonRecord } from "./internal-json";
import { inspectMemoryMigration } from "./migration-progress";
import { splitNativeNotes } from "./presentation";
import {
	admittedNativeFacts,
	readAcknowledgedFacts,
	readPublishedMemory,
} from "./publication";
import {
	knownQuarantineWithdrawal,
	normalizeQuarantineText,
} from "./quarantine-policy";
import { assertMemorySourceCurrent, memoryScopeKey } from "./revisions";

type PublishedRow = typeof memoryPublishedRows.$inferSelect;

function sameSupport(
	prior: PublishedRow,
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
	prior: PublishedRow,
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

// Default historical replay may consolidate its own claims. Explicit authored
// observations already published during preparation stay exact.
export function protectedMigrationObservations(
	tx: Tx,
	userId: string,
	bankId: string,
) {
	const protectedIds = new Set(
		admittedNativeFacts(userId, bankId, tx)
			.filter(
				({ source }) =>
					typeof parseJsonRecord(source.context).migrationAuthoredId ===
						"string" || source.explicitEditAt !== null,
			)
			.map(({ id }) => id),
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
) {
	const protectedRows = protectedMigrationObservations(tx, userId, bankId);
	if (!matchPriorMigrationObservations(protectedRows, memories, false))
		throw Error("memory_migration_authored_observation_changed");
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

/** Only current, unedited default-history originals may use the optional rule.
 * All other evidence and anything tied to an explicit action stay exact.
 */
export function matchApprovedOrdinaryRecovery(
	tx: Tx,
	userId: string,
	bankId: string,
	scopeKey: string,
	prior: PublishedRow[],
	memories: NativeMemory[],
) {
	if (!matchOrdinaryMigrationEvidence(prior, memories)) return null;
	const explicitAction = tx
		.select({ id: memoryActions.id })
		.from(memoryActions)
		.where(
			and(eq(memoryActions.userId, userId), eq(memoryActions.bankId, bankId)),
		)
		.get();
	if (explicitAction)
		return matchPriorMigrationRepresentation(prior, memories, true);
	const inventory = inspectMemoryMigration(userId);
	const originals = new Map(
		inventory.sources.map((source) => [source.id, source]),
	);
	const linked = new Set(
		inventory.actions.flatMap((action) => action.sourceIds),
	);
	const unlocated = inventory.actions.filter(
		(action) =>
			action.kind !== "authored" &&
			!action.sourceIds.length &&
			(!action.scope || memoryScopeKey(action.scope) === scopeKey),
	);
	if (
		unlocated.some(
			(action) =>
				action.kind !== "remove" ||
				!action.scope ||
				!action.before ||
				!inventory.exceptions.some(
					({ id, reason }) => id === action.id && reason === "missing_source",
				),
		)
	)
		return matchPriorMigrationRepresentation(prior, memories, true);
	if (
		unlocated.length &&
		memories.some((row) =>
			unlocated.some((action) =>
				action.before.split(/\r?\n/u).some((fragment) => {
					const withdrawn = normalizeQuarantineText(fragment);
					return (
						withdrawn && normalizeQuarantineText(row.text).includes(withdrawn)
					);
				}),
			),
		)
	)
		return null;
	const ordinaryIds = new Set<string>();
	for (const fact of admittedNativeFacts(userId, bankId, tx)) {
		const source = fact.source;
		const context = parseJsonRecord(source.context);
		const original = originals.get(source.messageId ?? "");
		if (
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
		) {
			assertMemorySourceCurrent(tx, source.id, userId, bankId);
			ordinaryIds.add(fact.id);
		}
	}
	const strict = prior.filter((row) => {
		const facts = readAcknowledgedFacts(row.sourceFingerprintsJson);
		return !facts.length || !facts.every((fact) => ordinaryIds.has(fact.id));
	});
	return unlocated.length
		? matchOrdinaryMigrationCompanions(prior, strict, memories)
		: matchPriorMigrationRepresentation(strict, memories, true);
}
