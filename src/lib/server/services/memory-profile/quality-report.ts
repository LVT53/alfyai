import {
	and,
	asc,
	desc,
	eq,
	inArray,
	isNotNull,
	ne,
	or,
	sql,
} from "drizzle-orm";
import {
	type MemoryKind,
	type MemoryScope,
	memorySubjectsFor,
} from "$lib/memory-types";
import { db } from "$lib/server/db";
import {
	memoryAccounts,
	memoryBanks,
	memoryDeliveryAttempts,
	memoryDeliveryJobs,
	memoryHistoryChoices,
	memoryPublishedRows,
	memorySourceRevisions,
	users,
} from "$lib/server/db/schema";
import { readFactLabels } from "./fact-labels";
import { MemoryRequestError } from "./memory-request";
import { memoryMigrationGuard } from "./migration-guard";
import { MEMORY_QUALITY_CONSENT_CHANGED } from "./quality-judge";
import { readScopeEntries } from "./subject-read";

/**
 * The Memory quality report, Layer 1: how an account's Memory came out of its
 * deliveries, counted inside the process so nobody has to read it. The report
 * holds numbers only: counts, numbers of seconds, and keys that name a bucket,
 * a state or a code. No text, no title, no date of an entry, a fact or a
 * message, and no id (an entry's, a fact's, a source's, a job's, a bank's or
 * an account's) ever enters it. Memory content is read only to be counted and
 * is dropped once it has been: an entry's text, for the duplicates, and a
 * message's length, which SQLite works out, so this module's own queries never
 * load a message. (`readScopeEntries` loads messages inside, as the Memory
 * page does.)
 *
 * Entries are read as the Memory page reads them (`readScopeEntries`), so
 * their kind, subject and age are the page's own and never derived again here.
 * The tool writes nothing, and it never holds SQLite's write lock for long:
 * every `db.transaction` begins immediate, so the only one it opens is the
 * page's own short one inside `readScopeEntries`, once per bank. Everything
 * else is a plain read of its own. The numbers may therefore straddle a
 * delivery that lands between two reads, which is fine for counts. Counting
 * (the duplicates above all) runs after the reads, never inside one.
 */

/**
 * Where a message came from. `imported` is the ChatGPT import only; `history`
 * is the person's own chats from before native Memory, which preparation
 * records the same way (`migration-message:`) but without the import's mark.
 */
export const MESSAGE_ORIGINS = [
	"imported",
	"history",
	"live",
	"note",
	"other",
] as const;
export type MessageOrigin = (typeof MESSAGE_ORIGINS)[number];
export const BANK_KINDS = ["personal", "project"] as const;
export type BankKind = (typeof BANK_KINDS)[number];

/** Facts a delivery acknowledged for one message. */
export const FACT_BUCKETS = ["0", "1", "2", "3", "4-5", "6+"] as const;
export type FactsBucket = (typeof FACT_BUCKETS)[number];
/** A message's length in characters. */
export const LENGTH_BUCKETS = [
	"<100",
	"100-299",
	"300-999",
	"1000-2999",
	"3000-7999",
	"8000+",
] as const;
export type LengthBucket = (typeof LENGTH_BUCKETS)[number];
/** Raw facts one entry rests on. "0" is never expected: it would be an entry shown with no support. */
export const SUPPORT_BUCKETS = ["0", "1", "2", "3-4", "5-9", "10+"] as const;
export type SupportBucket = (typeof SUPPORT_BUCKETS)[number];
/** A ChatGPT-imported fact's event date against the day its message was said. */
export const DATE_BUCKETS = [
	"no_date",
	"within_a_day",
	"later_2_30_days",
	"later_31_365_days",
	"later_over_a_year",
	"earlier_2_30_days",
	"earlier_31_365_days",
	"earlier_over_a_year",
] as const;
export type DateBucket = (typeof DATE_BUCKETS)[number];

const KIND_KEYS = ["lasting", "ongoing", "temporary", "unlabelled"] as const;
const TIME_STATES = ["current", "quiet", "earlier"] as const;
const DAY_MS = 86_400_000;
const TENTHS = 10;

export interface MessageCounts {
	total: number;
	byState: Record<string, number>;
}

export interface DeliveredCounts {
	/** Messages a delivery accepted (state `accepted`). */
	messages: number;
	/** Facts those messages acknowledged. */
	facts: number;
	factsPerMessage: Record<FactsBucket, number>;
	/** Messages by length bucket, then by how many facts they gave. */
	byLength: Record<LengthBucket, Record<FactsBucket, number>>;
}

export interface DuplicateCounts {
	/** Entries that share their normalised text with another entry of their bank. */
	exactEntries: number;
	/** How many different texts those entries share between them. */
	exactGroups: number;
	/** Pairs of entries that are not exact copies but share 80% of their words. */
	nearPairs: number;
	/** Entries in at least one such pair. */
	nearEntries: number;
	/** Entries under three words, which the near comparison leaves out. */
	tooShortToCompare: number;
}

export interface EntryCounts {
	total: number;
	/** Entries resting on at least one fact a ChatGPT-imported message gave. */
	withImportedFact: number;
	/** Entries resting on history, live, note or other facts only. */
	withoutImportedFact: number;
	supportingFacts: Record<SupportBucket, number>;
	kind: Record<(typeof KIND_KEYS)[number], number>;
	timeState: Record<(typeof TIME_STATES)[number], number>;
	/** By subject slug, with `other` for an entry the bank kind's list does not name. */
	subject: Record<string, number>;
	duplicates: DuplicateCounts;
}

export interface DurationStats {
	/** Jobs the figures are over. */
	jobs: number;
	medianSeconds: number | null;
	/** Nearest rank: the value at ceil(0.9 * jobs) in the sorted list. */
	p90Seconds: number | null;
}

interface ProcessCounts {
	sourceJobs: number;
	byStatus: Record<string, number>;
	/** Status, then error code (`none` for a job with no code). */
	byStatusAndCode: Record<string, Record<string, number>>;
}

interface Counts {
	banks: { personal: number; project: number; skipped: number };
	messages: Record<MessageOrigin, MessageCounts>;
	delivered: Record<MessageOrigin, DeliveredCounts>;
	entries: Record<BankKind, EntryCounts>;
	importedFactDates: Record<DateBucket, number>;
	process: ProcessCounts;
}

export interface MemoryQualityReport extends Counts {
	measuredAt: string;
	/** Milliseconds spent reading the account's rows (a baseline's is the sum over its accounts); the counting after the reads is not in it. */
	readMs: number;
	process: ProcessCounts & {
		deliverySeconds: {
			overall: DurationStats;
			/** Tenths of the succeeded jobs in completion order, the earliest first. */
			perTenth: DurationStats[];
		};
	};
}

/** An entry's counts without its subjects: see `BaselineNumbers`. */
export type BaselineEntryCounts = Omit<EntryCounts, "subject">;

/**
 * A baseline needs this many accounts. In a family app the others may be one or
 * two people, and then their numbers are as good as the people themselves.
 */
export const BASELINE_MIN_ACCOUNTS = 3;

/**
 * The same numbers summed over the other native accounts, without the subject
 * counts (a subject's count over a few accounts can say whose it is).
 */
export interface BaselineNumbers extends Omit<MemoryQualityReport, "entries"> {
	/** Native accounts summed. */
	accounts: number;
	entries: Record<BankKind, BaselineEntryCounts>;
}

/** Fewer accounts than `BASELINE_MIN_ACCOUNTS`: how many there are, and no number of theirs. */
export interface BaselineWithheld {
	accounts: number;
	reason: "too_few_accounts";
}

export type MemoryBaselineReport = BaselineNumbers | BaselineWithheld;

/**
 * Where a message came from, by the id of its source's event and whether its
 * context carries the ChatGPT import's mark. The import (`imported-history.ts`)
 * always writes `migrationImported: true`; preparation (`migration.ts`) writes
 * it only for a message that came from an import, and records the person's own
 * earlier chats under the same event ids without it. `readSources` reads the
 * mark in SQL, so there is one definition of it.
 */
export function originOf(eventId: string, importMark: boolean): MessageOrigin {
	if (eventId.startsWith("migration-message:"))
		return importMark ? "imported" : "history";
	if (eventId.startsWith("message:")) return "live";
	if (eventId.startsWith("manual:")) return "note";
	return "other";
}

export function factsBucket(count: number): FactsBucket {
	if (count < 1) return "0";
	if (count === 1) return "1";
	if (count === 2) return "2";
	if (count === 3) return "3";
	return count <= 5 ? "4-5" : "6+";
}

export function lengthBucket(characters: number): LengthBucket {
	if (characters < 100) return "<100";
	if (characters < 300) return "100-299";
	if (characters < 1000) return "300-999";
	if (characters < 3000) return "1000-2999";
	return characters < 8000 ? "3000-7999" : "8000+";
}

export function supportBucket(count: number): SupportBucket {
	if (count < 1) return "0";
	if (count === 1) return "1";
	if (count === 2) return "2";
	if (count <= 4) return "3-4";
	return count <= 9 ? "5-9" : "10+";
}

/**
 * Where a fact's event date falls against the day its message was said, in
 * whole days (a gap of 1 day and 23 hours is 1 day). The owner reads a gap of
 * more than a year, later or earlier, as suspicious and the rest as plausible
 * plans and history; the other buckets show how those are spread.
 */
export function dateBucket(
	eventAtMs: number | null,
	assertedAtMs: number,
): DateBucket {
	if (eventAtMs === null || Number.isNaN(eventAtMs)) return "no_date";
	const gap = eventAtMs - assertedAtMs;
	const days = Math.floor(Math.abs(gap) / DAY_MS);
	if (days <= 1) return "within_a_day";
	const later = gap > 0;
	if (days <= 30) return later ? "later_2_30_days" : "earlier_2_30_days";
	if (days <= 365) return later ? "later_31_365_days" : "earlier_31_365_days";
	return later ? "later_over_a_year" : "earlier_over_a_year";
}

/** The words of a text as duplicates compare them: letters and numbers, case and Unicode form folded. */
function wordsOf(text: string): string[] {
	return (
		text
			.normalize("NFC")
			.toLowerCase()
			.match(/[\p{L}\p{N}]+/gu) ?? []
	);
}

const NEAR_MIN_WORDS = 3;
// Near-duplicates share four fifths of their words (token Jaccard 0.8). The
// comparison is in whole numbers so 0.8 is never a rounding edge.
const NEAR_SHARED = 4;
const NEAR_OF = 5;

/**
 * Duplicates among one bank's entry texts. Exact: the same words after
 * lower-casing and dropping everything but letters and numbers. Near: not
 * exact, yet at least 80% alike by word set (an exact pair is counted as
 * exact only). The texts are compared here and not kept.
 *
 * The near comparison is every pair, cut down by size: two sets whose sizes
 * differ by more than a fifth cannot reach 0.8, so each set is only compared
 * with the sets just above its size in a list sorted by size.
 */
export function countDuplicates(texts: readonly string[]): DuplicateCounts {
	const words = texts.map(wordsOf);
	const keys = words.map((list) => list.join(" "));
	const sizes = new Map<string, number>();
	for (const key of keys) if (key) sizes.set(key, (sizes.get(key) ?? 0) + 1);
	let exactEntries = 0;
	let exactGroups = 0;
	for (const size of sizes.values()) {
		if (size < 2) continue;
		exactEntries += size;
		exactGroups++;
	}

	const wordIds = new Map<string, number>();
	const groupIds = new Map<string, number>();
	const sets: { entry: number; group: number; words: number[] }[] = [];
	let tooShortToCompare = 0;
	words.forEach((list, entry) => {
		if (list.length < NEAR_MIN_WORDS) {
			tooShortToCompare++;
			return;
		}
		const unique = new Set<number>();
		for (const word of list) {
			let id = wordIds.get(word);
			if (id === undefined) {
				id = wordIds.size;
				wordIds.set(word, id);
			}
			unique.add(id);
		}
		let group = groupIds.get(keys[entry]);
		if (group === undefined) {
			group = groupIds.size;
			groupIds.set(keys[entry], group);
		}
		sets.push({ entry, group, words: [...unique] });
	});
	sets.sort((a, b) => a.words.length - b.words.length);

	// `marked[word] === a` says the smaller set of the current round holds the word.
	const marked = new Int32Array(wordIds.size).fill(-1);
	const inPair = new Uint8Array(texts.length);
	let nearPairs = 0;
	for (let a = 0; a < sets.length; a++) {
		const small = sets[a];
		for (const word of small.words) marked[word] = a;
		for (let b = a + 1; b < sets.length; b++) {
			const large = sets[b];
			if (small.words.length * NEAR_OF < large.words.length * NEAR_SHARED)
				break;
			if (small.group === large.group) continue;
			let shared = 0;
			for (const word of large.words) if (marked[word] === a) shared++;
			const union = small.words.length + large.words.length - shared;
			if (shared * NEAR_OF < union * NEAR_SHARED) continue;
			nearPairs++;
			inPair[small.entry] = 1;
			inPair[large.entry] = 1;
		}
	}
	let nearEntries = 0;
	for (const flag of inPair) nearEntries += flag;
	return {
		exactEntries,
		exactGroups,
		nearPairs,
		nearEntries,
		tooShortToCompare,
	};
}

function durationStats(samples: readonly number[]): DurationStats {
	if (!samples.length)
		return { jobs: 0, medianSeconds: null, p90Seconds: null };
	const sorted = [...samples].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return {
		jobs: sorted.length,
		medianSeconds:
			sorted.length % 2
				? sorted[middle]
				: (sorted[middle - 1] + sorted[middle]) / 2,
		// ceil(0.9 n) in whole numbers.
		p90Seconds: sorted[Math.floor((9 * sorted.length + 9) / 10) - 1],
	};
}

/** A key that names a state or a code, or a stand-in: a report never carries free text as a key. */
function codeKey(value: string | null | undefined, empty: string): string {
	if (value === null || value === undefined || value === "") return empty;
	return /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : "unrecognised";
}

function zeros<Key extends string>(keys: readonly Key[]): Record<Key, number> {
	return Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
}

function bump(record: Record<string, number>, key: string, by = 1): void {
	record[key] = (Object.hasOwn(record, key) ? record[key] : 0) + by;
}

function emptyDelivered(): DeliveredCounts {
	return {
		messages: 0,
		facts: 0,
		factsPerMessage: zeros(FACT_BUCKETS),
		byLength: Object.fromEntries(
			LENGTH_BUCKETS.map((length) => [length, zeros(FACT_BUCKETS)]),
		) as DeliveredCounts["byLength"],
	};
}

function emptyEntries(kind: BankKind): EntryCounts {
	return {
		total: 0,
		withImportedFact: 0,
		withoutImportedFact: 0,
		supportingFacts: zeros(SUPPORT_BUCKETS),
		kind: zeros(KIND_KEYS),
		timeState: zeros(TIME_STATES),
		subject: zeros(memorySubjectsFor(kind)),
		duplicates: {
			exactEntries: 0,
			exactGroups: 0,
			nearPairs: 0,
			nearEntries: 0,
			tooShortToCompare: 0,
		},
	};
}

function emptyCounts(): Counts {
	const perOrigin = <Value>(make: () => Value) =>
		Object.fromEntries(
			MESSAGE_ORIGINS.map((origin) => [origin, make()]),
		) as Record<MessageOrigin, Value>;
	return {
		banks: { personal: 0, project: 0, skipped: 0 },
		messages: perOrigin(() => ({ total: 0, byState: {} })),
		delivered: perOrigin(emptyDelivered),
		entries: {
			personal: emptyEntries("personal"),
			project: emptyEntries("project"),
		},
		importedFactDates: zeros(DATE_BUCKETS),
		process: { sourceJobs: 0, byStatus: {}, byStatusAndCode: {} },
	};
}

/**
 * Adds every number of `from` into `into`, creating the keys it lacks. Counts
 * are nested records of numbers (states, codes and subjects are keys), so one
 * walk sums any of them and a new counter needs no code here.
 */
function addCounts(into: object, from: object): void {
	const target = into as Record<string, unknown>;
	for (const [key, value] of Object.entries(from)) {
		if (typeof value === "number") {
			const known = Object.hasOwn(target, key) ? target[key] : 0;
			target[key] = (typeof known === "number" ? known : 0) + value;
		} else if (value && typeof value === "object") {
			if (!Object.hasOwn(target, key)) target[key] = {};
			addCounts(target[key] as object, value);
		}
	}
}

/** Raw job times kept beside the counts: percentiles cannot be summed, so accounts pool them. */
interface Samples {
	overall: number[];
	tenths: number[][];
}

function emptySamples(): Samples {
	return {
		overall: [],
		tenths: Array.from({ length: TENTHS }, () => []),
	};
}

interface EntryRead {
	text: string;
	subject: string;
	kind: MemoryKind | null;
	timeState: "current" | "quiet" | "earlier";
	/** Raw facts the entry rests on that the page still admits. */
	support: number;
	imported: boolean;
}

interface SourceRead {
	origin: MessageOrigin;
	state: string;
	characters: number;
	/** Facts the delivery acknowledged. */
	facts: number;
	assertedAtMs: number;
	/** Of an accepted imported message: each fact's event date, null when it has none. */
	eventAtMs: (number | null)[];
}

interface JobRead {
	/** Only to put succeeded jobs in completion order; never reported. */
	order: string;
	status: string;
	code: string;
	completedAtMs: number;
	/** Seconds its attempts ran; null when none has both times. */
	seconds: number | null;
}

interface AccountRead {
	/** Milliseconds the reads took: the clock is read inside `readAccount`, so nothing counted afterwards is in it. */
	readMs: number;
	banks: Counts["banks"];
	entries: { kind: BankKind; list: EntryRead[] }[];
	sources: SourceRead[];
	jobs: JobRead[];
}

function scopeOf(scopeKey: string): MemoryScope | null {
	if (scopeKey === "personal") return { kind: "personal" };
	return scopeKey.startsWith("project:")
		? { kind: "project", projectId: scopeKey.slice("project:".length) }
		: null;
}

function idsOf(json: string | undefined): string[] {
	try {
		const parsed: unknown = JSON.parse(json ?? "[]");
		return Array.isArray(parsed)
			? [
					...new Set(
						parsed.filter((id): id is string => typeof id === "string"),
					),
				]
			: [];
	} catch {
		return [];
	}
}

/** A bank the page itself would refuse to read: Memory's own codes and a missing project. */
function unreadable(error: unknown): boolean {
	return (
		error instanceof MemoryRequestError ||
		(error instanceof Error && /^memory_[a-z_]+$/.test(error.message))
	);
}

/**
 * One bank's entries as the page shows them, with what each rests on; null for
 * a bank that cannot be read. `readScopeEntries` is the page's own read and
 * keeps its own short transaction. What each entry rests on comes from a plain
 * read of the rows it showed (`sourceIdsJson`, by the generation it read) and
 * from the facts the account's accepted ChatGPT-imported messages
 * acknowledged, so no message is loaded again here. That is the page's own
 * answer: an entry is shown only when every fact it rests on is admitted, and
 * the only source-level revocation writes the source's state with it
 * (`revokeMemorySources`), so an `accepted` source is an admitted one.
 */
function readBank(
	userId: string,
	bank: typeof memoryBanks.$inferSelect,
	now: Date,
	importedFacts: ReadonlySet<string> | undefined,
): { kind: BankKind; list: EntryRead[] } | null {
	const scope = scopeOf(bank.scopeKey);
	if (!scope || bank.status !== "ready") return null;
	try {
		const shown = readScopeEntries(userId, scope, now);
		// Memory off, or no bank to read: the page shows nothing to count.
		if (shown.bankId === null) return null;
		const rests = new Map(
			db
				.select({
					nativeId: memoryPublishedRows.nativeId,
					sourceIdsJson: memoryPublishedRows.sourceIdsJson,
				})
				.from(memoryPublishedRows)
				.where(
					and(
						eq(memoryPublishedRows.bankId, bank.id),
						eq(memoryPublishedRows.generation, shown.generation),
					),
				)
				.all()
				.map((row) => [row.nativeId, idsOf(row.sourceIdsJson)]),
		);
		const list = shown.entries.map((entry): EntryRead => {
			// A row the shown generation no longer holds (two deliveries landed
			// since the read) has no support to count: it shows in the "0" bucket.
			const facts = rests.get(entry.ref.rowId) ?? [];
			return {
				text: entry.text,
				subject: entry.subject,
				kind: entry.kind,
				timeState: entry.timeState,
				support: facts.length,
				imported: facts.some((id) => importedFacts?.has(id)),
			};
		});
		return { kind: scope.kind, list };
	} catch (error) {
		if (unreadable(error)) return null;
		throw error;
	}
}

/** Facts a message's acknowledgement list holds: how many, and the ids it names. */
function acknowledgedFacts(json: string): { count: number; ids: string[] } {
	try {
		const parsed: unknown = JSON.parse(json);
		if (!Array.isArray(parsed)) return { count: 0, ids: [] };
		const ids = parsed.flatMap((fact) =>
			fact && typeof fact === "object" && typeof fact.id === "string"
				? [fact.id as string]
				: [],
		);
		return { count: parsed.length, ids };
	} catch {
		return { count: 0, ids: [] };
	}
}

/**
 * The account's messages as counted, and by bank the facts its accepted
 * ChatGPT-imported messages acknowledged (what an entry rests on is imported
 * when one of its facts is among them). The import's mark is read in SQL, from
 * a context that is JSON, so a context that is not holds none and the query
 * never fails on it.
 */
function readSources(
	userId: string,
	bankIds: string[],
): { sources: SourceRead[]; importedFacts: Map<string, Set<string>> } {
	const importedFacts = new Map<string, Set<string>>();
	if (!bankIds.length) return { sources: [], importedFacts };
	const labels = new Map<string, ReturnType<typeof readFactLabels>>();
	const labelsOf = (bankId: string) => {
		let held = labels.get(bankId);
		if (!held) {
			held = readFactLabels(db, bankId);
			labels.set(bankId, held);
		}
		return held;
	};
	const context = memorySourceRevisions.context;
	const sources = db
		.select({
			bankId: memorySourceRevisions.bankId,
			eventId: memorySourceRevisions.eventId,
			state: memorySourceRevisions.state,
			assertedAt: memorySourceRevisions.assertedAt,
			// SQLite counts characters here, so the message itself is never read.
			characters: sql<number>`length(${memorySourceRevisions.text})`,
			acknowledged: memorySourceRevisions.acknowledgedFactsJson,
			// The import's mark: only a JSON `true` is one (`json_type` says so), so a
			// string, a number, an array or a context that is not JSON holds none.
			marked: sql<number>`coalesce(json_type(case when json_valid(${context}) then ${context} else '{}' end, '$.migrationImported') = 'true', 0)`,
		})
		.from(memorySourceRevisions)
		.where(
			and(
				eq(memorySourceRevisions.userId, userId),
				inArray(memorySourceRevisions.bankId, bankIds),
			),
		)
		.all()
		.map((source): SourceRead => {
			const origin = originOf(source.eventId, source.marked === 1);
			const accepted = source.state === "accepted";
			const facts = accepted
				? acknowledgedFacts(source.acknowledged)
				: { count: 0, ids: [] };
			const imported = origin === "imported" && accepted;
			if (imported) {
				let held = importedFacts.get(source.bankId);
				if (!held) {
					held = new Set();
					importedFacts.set(source.bankId, held);
				}
				for (const id of facts.ids) held.add(id);
			}
			const labelled = imported ? labelsOf(source.bankId) : null;
			return {
				origin,
				state: codeKey(source.state, "unknown"),
				characters: source.characters,
				facts: facts.count,
				assertedAtMs: source.assertedAt.getTime(),
				eventAtMs: labelled
					? facts.ids.map((id) => {
							const at = labelled.get(id)?.eventAt;
							return at ? Date.parse(at) : null;
						})
					: [],
			};
		});
	return { sources, importedFacts };
}

function readJobs(userId: string, bankIds: string[]): JobRead[] {
	if (!bankIds.length) return [];
	const mine = and(
		eq(memoryDeliveryJobs.userId, userId),
		eq(memoryDeliveryJobs.kind, "source"),
		inArray(memoryDeliveryJobs.bankId, bankIds),
	);
	const seconds = new Map<string, number>();
	for (const attempt of db
		.select({
			jobId: memoryDeliveryAttempts.jobId,
			claimedAt: memoryDeliveryAttempts.claimedAt,
			finishedAt: memoryDeliveryAttempts.finishedAt,
		})
		.from(memoryDeliveryAttempts)
		.innerJoin(
			memoryDeliveryJobs,
			eq(memoryDeliveryAttempts.jobId, memoryDeliveryJobs.id),
		)
		.where(
			and(
				mine,
				isNotNull(memoryDeliveryAttempts.claimedAt),
				isNotNull(memoryDeliveryAttempts.finishedAt),
			),
		)
		.all()) {
		if (!attempt.claimedAt || !attempt.finishedAt) continue;
		const ran =
			(attempt.finishedAt.getTime() - attempt.claimedAt.getTime()) / 1000;
		seconds.set(
			attempt.jobId,
			(seconds.get(attempt.jobId) ?? 0) + Math.max(0, ran),
		);
	}
	return db
		.select({
			id: memoryDeliveryJobs.id,
			status: memoryDeliveryJobs.status,
			errorCode: memoryDeliveryJobs.errorCode,
			completedAt: memoryDeliveryJobs.completedAt,
			updatedAt: memoryDeliveryJobs.updatedAt,
		})
		.from(memoryDeliveryJobs)
		.where(mine)
		.all()
		.map((job) => ({
			order: job.id,
			status: codeKey(job.status, "unknown"),
			code: codeKey(job.errorCode, "none"),
			completedAtMs: (job.completedAt ?? job.updatedAt).getTime(),
			seconds: seconds.get(job.id) ?? null,
		}));
}

/**
 * Everything the report counts for one native account. The account's banks are
 * its current epoch's that are not retired; a bank the page would not read
 * (repair blocked, its project gone, Memory off) is counted as skipped and its
 * entries are left out, while its messages and jobs still count. There is no
 * transaction around it (see the head of this file): the reads are separate,
 * so the numbers may straddle a delivery that lands between them.
 */
function readAccount(userId: string, now: Date): AccountRead {
	const started = performance.now();
	if (
		!db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get()
	)
		throw new Error("memory_quality_account_unknown");
	const account = db
		.select()
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, userId))
		.get();
	if (account?.authority !== "hindsight")
		throw new Error("memory_quality_not_native");
	const banks = db
		.select()
		.from(memoryBanks)
		.where(
			and(
				eq(memoryBanks.userId, userId),
				eq(memoryBanks.epoch, account.epoch),
				ne(memoryBanks.status, "retired"),
			),
		)
		.orderBy(asc(memoryBanks.id))
		.all();
	const bankIds = banks.map((bank) => bank.id);
	const { sources, importedFacts } = readSources(userId, bankIds);
	const read: AccountRead = {
		readMs: 0,
		banks: { personal: 0, project: 0, skipped: 0 },
		entries: [],
		sources,
		jobs: [],
	};
	for (const bank of banks) {
		const entries = readBank(userId, bank, now, importedFacts.get(bank.id));
		if (!entries) {
			read.banks.skipped++;
			continue;
		}
		read.banks[entries.kind]++;
		read.entries.push(entries);
	}
	read.jobs = readJobs(userId, bankIds);
	read.readMs = performance.now() - started;
	return read;
}

/** The counts and the raw job times of one account's read. */
function tally(read: AccountRead): { counts: Counts; samples: Samples } {
	const counts = emptyCounts();
	const samples = emptySamples();
	counts.banks = { ...read.banks };

	for (const source of read.sources) {
		const messages = counts.messages[source.origin];
		messages.total++;
		bump(messages.byState, source.state);
		if (source.state !== "accepted") continue;
		const delivered = counts.delivered[source.origin];
		const bucket = factsBucket(source.facts);
		delivered.messages++;
		delivered.facts += source.facts;
		delivered.factsPerMessage[bucket]++;
		delivered.byLength[lengthBucket(source.characters)][bucket]++;
		for (const eventAtMs of source.eventAtMs)
			counts.importedFactDates[dateBucket(eventAtMs, source.assertedAtMs)]++;
	}

	for (const { kind, list } of read.entries) {
		const into = counts.entries[kind];
		for (const entry of list) {
			into.total++;
			into[entry.imported ? "withImportedFact" : "withoutImportedFact"]++;
			into.supportingFacts[supportBucket(entry.support)]++;
			into.kind[entry.kind ?? "unlabelled"]++;
			into.timeState[entry.timeState]++;
			bump(into.subject, entry.subject);
		}
		// Duplicates are looked for within a bank, and a kind's banks add up.
		addCounts(into.duplicates, countDuplicates(list.map((e) => e.text)));
	}

	counts.process.sourceJobs = read.jobs.length;
	for (const job of read.jobs) {
		bump(counts.process.byStatus, job.status);
		if (!Object.hasOwn(counts.process.byStatusAndCode, job.status))
			counts.process.byStatusAndCode[job.status] = {};
		bump(counts.process.byStatusAndCode[job.status], job.code);
	}
	const timed = read.jobs
		.filter((job) => job.status === "succeeded" && job.seconds !== null)
		.sort(
			(a, b) =>
				a.completedAtMs - b.completedAtMs || a.order.localeCompare(b.order),
		);
	timed.forEach((job, index) => {
		const ran = job.seconds ?? 0;
		samples.overall.push(ran);
		samples.tenths[Math.floor((index * TENTHS) / timed.length)].push(ran);
	});
	return { counts, samples };
}

function sortedKeys<Value>(
	record: Record<string, Value>,
): Record<string, Value> {
	return Object.fromEntries(
		Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
}

function finish(
	counts: Counts,
	samples: Samples,
	now: Date,
	readMs: number,
): MemoryQualityReport {
	for (const origin of MESSAGE_ORIGINS)
		counts.messages[origin].byState = sortedKeys(
			counts.messages[origin].byState,
		);
	const byStatusAndCode = Object.fromEntries(
		Object.entries(sortedKeys(counts.process.byStatusAndCode)).map(
			([status, codes]) => [status, sortedKeys(codes)],
		),
	);
	return {
		measuredAt: now.toISOString(),
		readMs: Math.round(readMs),
		...counts,
		process: {
			...counts.process,
			byStatus: sortedKeys(counts.process.byStatus),
			byStatusAndCode,
			deliverySeconds: {
				overall: durationStats(samples.overall),
				perTenth: samples.tenths.map(durationStats),
			},
		},
	};
}

/** One account's counts and raw job times, and the milliseconds its reads took. */
function measureAccount(userId: string, now: Date) {
	const read = readAccount(userId, now);
	return { ...tally(read), readMs: read.readMs };
}

/**
 * One account's numbers. An account that does not exist, or that is not on
 * native Memory, is refused rather than reported as all zeros: a mistyped id
 * must not read as an empty Memory.
 */
export function measureMemoryQuality(input: {
	userId: string;
	now: Date;
}): MemoryQualityReport {
	const { counts, samples, readMs } = measureAccount(input.userId, input.now);
	return finish(counts, samples, input.now, readMs);
}

function withoutSubjects({
	subject: _subject,
	...counts
}: EntryCounts): BaselineEntryCounts {
	return counts;
}

/**
 * The same numbers summed over every native account but the ones named and the
 * permanent tester (read through the migration guard, like every other tool
 * that must keep away from that account), without the subject counts. Counts
 * add; the job times of all the accounts are pooled, with each account's own
 * tenths kept together so "the first tenth" is still early in an account's
 * life. With fewer than `BASELINE_MIN_ACCOUNTS` accounts it gives only how many
 * there are, and reads none of them. Accounts are read one at a time, so only
 * one account's entries are held at once.
 */
export function measureMemoryBaseline(input: {
	excludeUserIds: readonly string[];
	now: Date;
}): MemoryBaselineReport {
	const left = new Set(input.excludeUserIds);
	const accountIds = db
		.select({ userId: memoryAccounts.userId })
		.from(memoryAccounts)
		.where(
			and(
				eq(memoryAccounts.authority, "hindsight"),
				eq(memoryAccounts.lifecycleState, "active"),
			),
		)
		.orderBy(asc(memoryAccounts.userId))
		.all()
		.map(({ userId }) => userId)
		.filter(
			(userId) => !left.has(userId) && memoryMigrationGuard(userId).allowed,
		);
	if (accountIds.length < BASELINE_MIN_ACCOUNTS)
		return { accounts: accountIds.length, reason: "too_few_accounts" };
	const total = emptyCounts();
	const pooled = emptySamples();
	let accounts = 0;
	let readMs = 0;
	for (const userId of accountIds) {
		let measured: ReturnType<typeof measureAccount>;
		try {
			measured = measureAccount(userId, input.now);
		} catch (error) {
			// An account that stopped being native between the list and the read.
			if (
				error instanceof Error &&
				/^memory_quality_(account_unknown|not_native)$/.test(error.message)
			)
				continue;
			throw error;
		}
		accounts++;
		readMs += measured.readMs;
		addCounts(total, measured.counts);
		for (const ran of measured.samples.overall) pooled.overall.push(ran);
		measured.samples.tenths.forEach((tenth, index) => {
			for (const ran of tenth) pooled.tenths[index].push(ran);
		});
	}
	if (accounts < BASELINE_MIN_ACCOUNTS)
		return { accounts, reason: "too_few_accounts" };
	const { entries, ...rest } = finish(total, pooled, input.now, readMs);
	return {
		...rest,
		accounts,
		entries: {
			personal: withoutSubjects(entries.personal),
			project: withoutSubjects(entries.project),
		},
	};
}

const DATE_WORDS: Record<DateBucket, string> = {
	no_date: "no date",
	within_a_day: "within a day",
	later_2_30_days: "later by 2-30 days",
	later_31_365_days: "later by 31-365 days",
	later_over_a_year: "later by over a year",
	earlier_2_30_days: "earlier by 2-30 days",
	earlier_31_365_days: "earlier by 31-365 days",
	earlier_over_a_year: "earlier by over a year",
};

function share(part: number, whole: number): string {
	return whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "n/a";
}

function shares(
	record: Readonly<Record<string, number>>,
	keys: readonly string[],
	whole: number,
	words: Readonly<Record<string, string>> = {},
): string {
	// Buckets with nothing in them are left out, so the line stays short.
	return (
		keys
			.filter((key) => (record[key] ?? 0) > 0)
			.map((key) => `${words[key] ?? key} ${share(record[key] ?? 0, whole)}`)
			.join(", ") || "none"
	);
}

function seconds(value: number | null): string {
	return value === null ? "-" : String(Math.round(value * 10) / 10);
}

/**
 * The report as a few readable lines, with percentages worked out from the
 * counts. Content-free like the report: it only ever formats its numbers. A
 * baseline has no subject counts, and a withheld one has no numbers at all.
 */
export function summarizeMemoryQuality(
	report: MemoryQualityReport | BaselineNumbers | BaselineWithheld,
	title: string,
): string[] {
	if ("reason" in report)
		return [
			`${title}: not reported, ${report.accounts} other native accounts (it needs at least ${BASELINE_MIN_ACCOUNTS}, so that no one's numbers are the baseline)`,
		];
	const lines: string[] = [
		`${title} (measured ${report.measuredAt}${"accounts" in report ? `, ${report.accounts} accounts` : ""}, read in ${report.readMs} ms)`,
		`  banks read: ${report.banks.personal} personal, ${report.banks.project} project; not read: ${report.banks.skipped}`,
	];

	for (const origin of MESSAGE_ORIGINS) {
		const { total, byState } = report.messages[origin];
		if (!total) continue;
		const others = Object.entries(byState)
			.filter(([state]) => state !== "accepted")
			.map(([state, count]) => `${state} ${count}`);
		lines.push(
			`  ${origin} messages: ${total}, accepted ${share(byState.accepted ?? 0, total)}${others.length ? ` (${others.join(", ")})` : ""}`,
		);
	}
	for (const origin of MESSAGE_ORIGINS) {
		const delivered = report.delivered[origin];
		if (!delivered.messages) continue;
		lines.push(
			`  delivered ${origin} messages: ${delivered.messages}, ${delivered.facts} facts (${(delivered.facts / delivered.messages).toFixed(1)} per message)`,
			`    facts per message: ${shares(delivered.factsPerMessage, FACT_BUCKETS, delivered.messages)}`,
		);
		const short = delivered.byLength["<100"];
		const shortTotal = FACT_BUCKETS.reduce((sum, key) => sum + short[key], 0);
		if (shortTotal)
			lines.push(
				`    under 100 characters: ${short["3"] + short["4-5"] + short["6+"]} of ${shortTotal} gave 3 or more facts (${share(short["3"] + short["4-5"] + short["6+"], shortTotal)})`,
			);
	}

	for (const kind of BANK_KINDS) {
		const entries = report.entries[kind];
		if (!entries.total) continue;
		const { duplicates } = entries;
		lines.push(
			`  ${kind} entries: ${entries.total}, ${entries.withImportedFact} rest on ChatGPT-imported facts (${share(entries.withImportedFact, entries.total)})`,
			`    kind: ${shares(entries.kind, KIND_KEYS, entries.total)}`,
			`    time: ${shares(entries.timeState, TIME_STATES, entries.total)}`,
			`    supporting facts: ${shares(entries.supportingFacts, SUPPORT_BUCKETS, entries.total)}`,
			...("subject" in entries
				? [
						`    subjects: ${shares(entries.subject, Object.keys(entries.subject), entries.total)}`,
					]
				: []),
			`    duplicates: exact ${duplicates.exactEntries} entries (${share(duplicates.exactEntries, entries.total)}) in ${duplicates.exactGroups} groups; near ${duplicates.nearPairs} pairs (${duplicates.nearEntries} entries, ${share(duplicates.nearEntries, entries.total)}); ${duplicates.tooShortToCompare} too short to compare`,
		);
	}

	const dated = DATE_BUCKETS.reduce(
		(sum, key) => sum + report.importedFactDates[key],
		0,
	);
	if (dated)
		lines.push(
			`  ChatGPT-imported fact dates (${dated} facts): ${shares(report.importedFactDates, DATE_BUCKETS, dated, DATE_WORDS)}`,
		);

	const { process: health } = report;
	if (health.sourceJobs) {
		const states = Object.entries(health.byStatusAndCode).map(
			([status, codes]) => {
				const named = Object.entries(codes).filter(([code]) => code !== "none");
				return `${status} ${health.byStatus[status]}${named.length ? ` (${named.map(([code, count]) => `${code} ${count}`).join(", ")})` : ""}`;
			},
		);
		const { overall, perTenth } = health.deliverySeconds;
		lines.push(
			`  source jobs: ${health.sourceJobs}: ${states.join(", ")}`,
			`  delivery seconds per succeeded job (${overall.jobs} timed): median ${seconds(overall.medianSeconds)}, p90 ${seconds(overall.p90Seconds)}`,
			`    by tenth, median/p90: ${perTenth.map((tenth) => `${seconds(tenth.medianSeconds)}/${seconds(tenth.p90Seconds)}`).join(", ")}`,
		);
	}
	return lines;
}

/**
 * The judge's consent fence (`--judge` of `scripts/memory-quality-report.ts`).
 * The judge sends the account's entries to the Memory model, and a run takes
 * minutes, so the command asks before every batch, and right before every call,
 * whether the person's consent still stands as the run found it:
 *  - Memory is still on and the account is native and active, as the label
 *    migration asks;
 *  - the epoch is the same (Clear Memory starts a new one);
 *  - the control revision is the same: it moves each time Memory is switched
 *    off or on (`setMemoryEnabled`), so an off and on again between two asks
 *    shows;
 *  - the newest history choice is the same row (`recordHistoryImportChoice`
 *    writes one for each request): declining history revokes the imported
 *    chats and the person's earlier ones, the very entries the judge would send.
 * The error it throws is the one the judge recognises
 * (`MEMORY_QUALITY_CONSENT_CHANGED`, its contract): it ends the run instead of
 * counting as a failed batch. It lives here, with the tests of the report, so
 * it is tested against the real tables and the command only wires it.
 */

export interface JudgeConsent {
	epoch: number;
	controlRevision: number;
	/** The newest history choice (by `decided_at`, then the row written last): its id and what it chose; null before any. */
	history: { id: string; choice: string } | null;
}

/** The consent as it stands now; null when Memory is off or the account is not native and active. */
export function readJudgeConsent(userId: string): JudgeConsent | null {
	const user = db
		.select({ enabled: users.memoryEnabled })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	const account = db
		.select({
			authority: memoryAccounts.authority,
			lifecycleState: memoryAccounts.lifecycleState,
			epoch: memoryAccounts.epoch,
			controlRevision: memoryAccounts.controlRevision,
		})
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, userId))
		.get();
	if (
		!user?.enabled ||
		account?.authority !== "hindsight" ||
		account.lifecycleState !== "active"
	)
		return null;
	const history = db
		.select({
			id: memoryHistoryChoices.id,
			choice: memoryHistoryChoices.choice,
		})
		.from(memoryHistoryChoices)
		.where(eq(memoryHistoryChoices.userId, userId))
		.orderBy(desc(memoryHistoryChoices.decidedAt), sql`rowid desc`)
		.limit(1)
		.get();
	return {
		epoch: account.epoch,
		controlRevision: account.controlRevision,
		history: history ?? null,
	};
}

/** Throws the judge's consent error unless the consent is still what the run found. */
export function assertJudgeConsent(userId: string, found: JudgeConsent): void {
	const now = readJudgeConsent(userId);
	if (
		!now ||
		now.epoch !== found.epoch ||
		now.controlRevision !== found.controlRevision ||
		now.history?.id !== found.history?.id ||
		now.history?.choice !== found.history?.choice
	)
		throw new Error(MEMORY_QUALITY_CONSENT_CHANGED);
}

const ID_CHUNK = 500;

/**
 * The observation (Hindsight's native id) each of these ids names, for ids of
 * published rows, or native ids, in the current or the previous generation of
 * one of the person's ready banks of their current epoch (a delivery may have
 * landed since the entries were read). An id it cannot place is not in the map.
 */
function observationsOf(
	userId: string,
	ids: readonly string[],
): Map<string, string> {
	const observation = new Map<string, string>();
	for (let start = 0; start < ids.length; start += ID_CHUNK) {
		const chunk = ids.slice(start, start + ID_CHUNK);
		const rows = db
			.select({
				id: memoryPublishedRows.id,
				nativeId: memoryPublishedRows.nativeId,
			})
			.from(memoryPublishedRows)
			.innerJoin(memoryBanks, eq(memoryBanks.id, memoryPublishedRows.bankId))
			.innerJoin(
				memoryAccounts,
				and(
					eq(memoryAccounts.userId, memoryBanks.userId),
					eq(memoryAccounts.epoch, memoryBanks.epoch),
				),
			)
			.where(
				and(
					eq(memoryBanks.userId, userId),
					eq(memoryBanks.status, "ready"),
					or(
						eq(memoryPublishedRows.generation, memoryBanks.generation),
						eq(memoryPublishedRows.generation, memoryBanks.previousGeneration),
					),
					or(
						inArray(memoryPublishedRows.id, chunk),
						inArray(memoryPublishedRows.nativeId, chunk),
					),
				),
			)
			.all();
		for (const row of rows) {
			observation.set(row.id, row.nativeId);
			observation.set(row.nativeId, row.nativeId);
		}
	}
	return observation;
}

/** Which of these observations are in the current generation of one of the person's ready banks of their current epoch: one query. */
function observationsPublished(
	userId: string,
	nativeIds: readonly string[],
): Set<string> {
	if (!nativeIds.length) return new Set();
	return new Set(
		db
			.select({ nativeId: memoryPublishedRows.nativeId })
			.from(memoryPublishedRows)
			.innerJoin(
				memoryBanks,
				and(
					eq(memoryBanks.id, memoryPublishedRows.bankId),
					eq(memoryBanks.generation, memoryPublishedRows.generation),
				),
			)
			.innerJoin(
				memoryAccounts,
				and(
					eq(memoryAccounts.userId, memoryBanks.userId),
					eq(memoryAccounts.epoch, memoryBanks.epoch),
				),
			)
			.where(
				and(
					eq(memoryBanks.userId, userId),
					eq(memoryBanks.status, "ready"),
					inArray(memoryPublishedRows.nativeId, [...nativeIds]),
				),
			)
			.all()
			.map((row) => row.nativeId),
	);
}

/**
 * The fence on what a judge run may still send, built when the run starts from
 * the ids of every entry it will show, its candidates too. It answers, for
 * the ids of one batch (the batch's entries, then their candidates), which are
 * still published: the observation behind the id is in the current generation
 * of one of the person's ready banks of their current epoch, in one small query.
 * An id the fence could not place at the start is never allowed.
 *
 * The judge names an entry by its published row's id, which is new at every
 * publication, and the observation behind the row (its native id) is not. So
 * the ids are translated once, here, and the question asked is about the
 * observation: a delivery landing during a run (the import's drain, a chat)
 * does not withdraw what is left of it, while an entry the person removed, once
 * a publication has dropped its observation, is withdrawn. A row a Remove hid
 * still counts until that publication, which follows the Remove within its job;
 * `assertJudgeConsent` is what stops a run when consent itself changes.
 */
export function publishedEntryFence(
	userId: string,
	ids: readonly string[],
): (batch: readonly string[]) => Set<string> {
	const observation = observationsOf(userId, [...new Set(ids)]);
	return (batch) => {
		const published = observationsPublished(userId, [
			...new Set(batch.flatMap((id) => observation.get(id) ?? [])),
		]);
		return new Set(
			batch.filter((id) => {
				const native = observation.get(id);
				return native !== undefined && published.has(native);
			}),
		);
	};
}
