import { and, eq, inArray } from "drizzle-orm";
import {
	MEMORY_KINDS,
	type MemoryKind,
	type MemoryScope,
	type MemorySubject,
	memorySubjectsFor,
} from "$lib/memory-types";
import type { DatabaseInstance } from "$lib/server/db";
import { memoryFactLabels } from "$lib/server/db/schema";
import type { Tx } from "../jobs/types";
import type { NativeMemory } from "./contracts";
import { parseJsonRecord } from "./internal-json";

/**
 * The one place labels are read and written (Memory part 2). Labels live
 * app-side, keyed by bank and Hindsight fact id: at the pin, changing a fact's
 * entities or tags in Hindsight regenerates its observations, which a label
 * migration must never do. New facts are labelled inside Hindsight's
 * extraction (`entity_labels`, bank config 2) and publication copies those
 * labels here; the classifier writes the rest. An entry with no labelled fact
 * reads as lasting.
 */
export interface FactLabels {
	kind: MemoryKind | null;
	subject: MemorySubject | null;
	/** When the fact's event happened or will happen: Hindsight's `occurred_end ?? occurred_start`. */
	eventAt: string | null;
	origin: "extraction" | "classifier";
}

/** A supporting fact of an entry: when it was said, and whether the person wrote it. */
export interface EntryFact {
	id: string;
	/** Its source's `explicitEditAt ?? assertedAt`, as part 1 dates an entry. */
	saidAtMs: number;
	authored: boolean;
}
export interface EntryLabels {
	kind: MemoryKind | null;
	subject: MemorySubject | null;
	/** The latest event date of any supporting fact. */
	eventAt: string | null;
	/** An entry with any fact the person added or edited never ages. */
	authored: boolean;
}

/** `kind:` and `subject:` from a fact's tags: known values of the bank kind's lists only. */
export function labelsFromNativeTags(
	tags: readonly string[] | undefined,
	scopeKind: MemoryScope["kind"],
): { kind: MemoryKind | null; subject: MemorySubject | null } {
	const pick = <T extends string>(
		prefix: string,
		allowed: readonly T[],
	): T | null => {
		for (const tag of tags ?? []) {
			if (!tag.startsWith(prefix)) continue;
			// Hindsight checks a label against its list without regard to case.
			const value = tag.slice(prefix.length).trim().toLowerCase();
			const known = allowed.find((option) => option === value);
			if (known) return known;
		}
		return null;
	};
	return {
		kind: pick("kind:", MEMORY_KINDS),
		subject: pick("subject:", memorySubjectsFor(scopeKind)),
	};
}

function eventDate(fact: NativeMemory): Date | null {
	const raw = fact.occurred_end ?? fact.occurred_start;
	if (!raw) return null;
	const at = Date.parse(raw);
	return Number.isNaN(at) ? null : new Date(at);
}

const DELETE_CHUNK = 500;
/** Every subject either bank kind can hold; anything else reads as no label. */
const KNOWN_SUBJECTS: ReadonlySet<string> = new Set([
	...memorySubjectsFor("personal"),
	...memorySubjectsFor("project"),
]);

/**
 * Copies a published snapshot's labels and event dates into the store: each
 * raw fact's extraction labels (never over a classifier's) and its event
 * date. A fact gone from the snapshot loses its row. Writes only what changed.
 */
export function recordNativeFactLabels(
	tx: Tx,
	bankId: string,
	scopeKind: MemoryScope["kind"],
	memories: readonly NativeMemory[],
): void {
	const existing = new Map(
		tx
			.select()
			.from(memoryFactLabels)
			.where(eq(memoryFactLabels.bankId, bankId))
			.all()
			.map((row) => [row.nativeFactId, row]),
	);
	const live = new Set<string>();
	const now = new Date();
	for (const fact of memories) {
		if (fact.fact_type === "observation") continue;
		live.add(fact.id);
		const eventAt = eventDate(fact);
		const tagged = labelsFromNativeTags(fact.tags, scopeKind);
		const row = existing.get(fact.id);
		if (!row) {
			tx.insert(memoryFactLabels)
				.values({
					bankId,
					nativeFactId: fact.id,
					kind: tagged.kind,
					subject: tagged.subject,
					origin: "extraction",
					eventAt,
					updatedAt: now,
				})
				.run();
			continue;
		}
		const labels =
			row.origin === "classifier"
				? { kind: row.kind, subject: row.subject }
				: tagged;
		if (
			labels.kind === row.kind &&
			labels.subject === row.subject &&
			(eventAt?.getTime() ?? null) === (row.eventAt?.getTime() ?? null)
		)
			continue;
		tx.update(memoryFactLabels)
			.set({ ...labels, eventAt, updatedAt: now })
			.where(
				and(
					eq(memoryFactLabels.bankId, bankId),
					eq(memoryFactLabels.nativeFactId, fact.id),
				),
			)
			.run();
	}
	const gone = [...existing.keys()].filter((id) => !live.has(id));
	for (let start = 0; start < gone.length; start += DELETE_CHUNK)
		tx.delete(memoryFactLabels)
			.where(
				and(
					eq(memoryFactLabels.bankId, bankId),
					inArray(
						memoryFactLabels.nativeFactId,
						gone.slice(start, start + DELETE_CHUNK),
					),
				),
			)
			.run();
}

/**
 * The classifier's writer: the label migration's, and the fallback's. Its
 * labels win over extraction's from then on; a fact's event date is kept.
 * Call it inside a write fenced like any Memory write (bank epoch and status).
 */
export function recordClassifiedFactLabels(
	tx: Tx,
	bankId: string,
	labels: ReadonlyMap<string, { kind: MemoryKind; subject: MemorySubject }>,
): void {
	const now = new Date();
	for (const [nativeFactId, { kind, subject }] of labels)
		tx.insert(memoryFactLabels)
			.values({
				bankId,
				nativeFactId,
				kind,
				subject,
				origin: "classifier",
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [memoryFactLabels.bankId, memoryFactLabels.nativeFactId],
				set: { kind, subject, origin: "classifier", updatedAt: now },
			})
			.run();
}

export function readFactLabels(
	database: DatabaseInstance | Tx,
	bankId: string,
): Map<string, FactLabels> {
	return new Map(
		database
			.select()
			.from(memoryFactLabels)
			.where(eq(memoryFactLabels.bankId, bankId))
			.all()
			.map((row) => [
				row.nativeFactId,
				{
					kind: (MEMORY_KINDS as readonly string[]).includes(row.kind ?? "")
						? (row.kind as MemoryKind)
						: null,
					subject: KNOWN_SUBJECTS.has(row.subject ?? "")
						? (row.subject as MemorySubject)
						: null,
					eventAt: row.eventAt?.toISOString() ?? null,
					origin: row.origin,
				},
			]),
	);
}

/** A Memory page add or edit, or a user-authored item migrated from the legacy system. */
export function isAuthoredMemorySource(source: {
	eventId: string;
	context: string;
}): boolean {
	return (
		source.eventId.startsWith("manual:") ||
		typeof parseJsonRecord(source.context).migrationAuthoredId === "string"
	);
}

/**
 * An entry's labels from its supporting facts. Kind and subject each come from
 * the newest-said fact that has one (a tie goes to the larger fact id, so the
 * order facts arrive in never matters); the event date is the latest of any.
 */
export function entryLabels(
	facts: readonly EntryFact[],
	labels: ReadonlyMap<string, FactLabels>,
): EntryLabels {
	const newestFirst = [...facts].sort(
		(a, b) =>
			b.saidAtMs - a.saidAtMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
	);
	const first = <K extends "kind" | "subject">(key: K) => {
		for (const fact of newestFirst) {
			const value = labels.get(fact.id)?.[key];
			if (value) return value as FactLabels[K];
		}
		return null;
	};
	let eventAt: string | null = null;
	for (const fact of facts) {
		const at = labels.get(fact.id)?.eventAt ?? null;
		if (at && (!eventAt || Date.parse(at) > Date.parse(eventAt))) eventAt = at;
	}
	return {
		kind: first("kind"),
		subject: first("subject"),
		eventAt,
		authored: facts.some((fact) => fact.authored),
	};
}
