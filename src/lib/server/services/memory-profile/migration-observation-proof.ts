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

export function samePriorObservation(
	prior: PublishedRow,
	observed: NativeMemory,
	raw: ReadonlyMap<string, NativeMemory>,
) {
	if (
		observed.fact_type !== "observation" ||
		observed.text !== prior.nativeText ||
		splitNativeNotes(
			observed,
			(observed.source_memory_ids ?? []).flatMap((id) => {
				const fact = raw.get(id);
				return fact ? [fact] : [];
			}),
		) !== prior.text
	)
		return false;
	const supports = readAcknowledgedFacts(prior.sourceFingerprintsJson);
	const ids = new Set(observed.source_memory_ids ?? []);
	return (
		ids.size === supports.length &&
		supports.every((fact) => {
			const current = raw.get(fact.id);
			return (
				ids.has(fact.id) &&
				current?.text === fact.text &&
				(current.mentioned_at ?? null) === (fact.mentionedAt ?? null)
			);
		})
	);
}

/** Match each prior publication to exactly one unchanged native counterpart. */
export function matchPriorMigrationObservations(
	prior: PublishedRow[],
	memories: NativeMemory[],
	allowRenumbered: boolean,
) {
	const byId = new Map(memories.map((row) => [row.id, row]));
	const raw = new Map(
		memories
			.filter((row) => row.fact_type !== "observation")
			.map((row) => [row.id, row]),
	);
	const matched = new Set<string>();
	for (const row of prior) {
		const live = byId.get(row.nativeId);
		let exact = live && samePriorObservation(row, live, raw) ? live : undefined;
		if (!exact && allowRenumbered) {
			const choices = memories.filter((m) => samePriorObservation(row, m, raw));
			if (choices.length === 1) exact = choices[0];
		}
		if (!exact || matched.has(exact.id)) return false;
		matched.add(exact.id);
	}
	return true;
}

// Default historical replay may consolidate its own claims. Explicit authored
// observations already published during preparation stay exact.
export function assertHistoryPreservesAuthoredObservations(
	tx: Tx,
	userId: string,
	bankId: string,
	memories: NativeMemory[],
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
	if (!protectedIds.size) return;
	const protectedRows = readPublishedMemory(
		userId,
		bankId,
		undefined,
		tx,
	).filter((row) =>
		readAcknowledgedFacts(row.sourceFingerprintsJson).some((fact) =>
			protectedIds.has(fact.id),
		),
	);
	if (!matchPriorMigrationObservations(protectedRows, memories, false))
		throw Error("memory_migration_authored_observation_changed");
}
