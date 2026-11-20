import type { memoryPublishedRows } from "$lib/server/db/schema";
import type { Tx } from "../jobs/types";
import type { NativeMemory } from "./contracts";
import { parseJsonRecord } from "./internal-json";
import { splitNativeNotes } from "./presentation";
import {
	admittedNativeFacts,
	readAcknowledgedFacts,
	readPublishedMemory,
} from "./publication";

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
