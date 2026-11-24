import type { MemoryKind, MemorySubject } from "$lib/memory-types";
import {
	type MemoryAgingThresholds,
	type MemoryTimeState,
	memoryEntryTimeState,
} from "./entry-time";
import {
	entryLabels,
	type FactLabels,
	isAuthoredMemorySource,
} from "./fact-labels";
import { entryLastSaidAt, factSaidTimes } from "./publication";

/**
 * One published entry as recall and the Memory page read it (part 2's
 * contract): its supporting facts are its row's source ids looked up among
 * the admitted facts, it takes kind and subject from its newest labelled
 * fact, it was last mentioned when its newest fact was said, and whether it
 * is current, quiet or Earlier is decided on the caller's one clock. Recall
 * (`memory-context/native.ts`) and the page (`subject-read.ts`) both build
 * entries here, so they can never disagree about an entry.
 */
export interface AdmittedEntryFact {
	id: string;
	source: {
		assertedAt: Date;
		explicitEditAt: Date | null;
		eventId: string;
		context: string;
	};
}

export interface MemoryEntryView {
	kind: MemoryKind | null;
	subject: MemorySubject | null;
	lastMentionedAt: string | null;
	timeState: MemoryTimeState;
	/** An entry with a fact the person added or edited: it never ages. */
	authored: boolean;
}

/** Admitted facts by id; a fact several sources acknowledge appears once per source. */
export function groupFactsById<Fact extends AdmittedEntryFact>(
	facts: readonly Fact[],
): Map<string, Fact[]> {
	const byId = new Map<string, Fact[]>();
	for (const fact of facts)
		byId.set(fact.id, [...(byId.get(fact.id) ?? []), fact]);
	return byId;
}

export function memoryEntryView(
	input: {
		/** The published row's `sourceIdsJson`, parsed; anything not a string is ignored. */
		sourceIds: readonly unknown[];
		factsById: ReadonlyMap<string, readonly AdmittedEntryFact[]>;
		labels: ReadonlyMap<string, FactLabels>;
	},
	now: Date,
	thresholds: MemoryAgingThresholds,
): MemoryEntryView {
	const ids = input.sourceIds.filter(
		(id): id is string => typeof id === "string",
	);
	const supporting = ids.flatMap((id) => input.factsById.get(id) ?? []);
	const labelled = entryLabels(
		supporting.map((fact) => ({
			id: fact.id,
			saidAtMs: (
				fact.source.explicitEditAt ?? fact.source.assertedAt
			).getTime(),
			authored: isAuthoredMemorySource(fact.source),
		})),
		input.labels,
	);
	const lastMentionedAt = entryLastSaidAt(ids, factSaidTimes(supporting));
	return {
		kind: labelled.kind,
		subject: labelled.subject,
		lastMentionedAt,
		timeState: memoryEntryTimeState(
			{ ...labelled, lastMentionedAt },
			now,
			thresholds,
		),
		authored: labelled.authored,
	};
}
