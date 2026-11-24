import { eq } from "drizzle-orm";
import type {
	MemoryKind,
	MemoryOverview,
	MemoryScope,
	MemorySubject,
	MemorySubjectEntry,
} from "$lib/memory-types";
import { db } from "$lib/server/db";
import { memoryOverviews, projects, users } from "$lib/server/db/schema";
import { estimateTokenCount } from "$lib/utils/tokens";
import { memoryAdmissionFor } from "./admission";
import { type CurationModel, createCurationModel } from "./curation";
import { NativeMemoryError } from "./hindsight-client";
import { isJsonRecord } from "./internal-json";
import { MemoryRequestError, parseMemoryScope } from "./memory-request";
import { memoryScopeKey, memoryTextHash } from "./revisions";
import { readScopeEntries } from "./subject-read";

/**
 * The Overview of a scope (Memory part 3): one paragraph the local model
 * writes when the person opens it, only from the entries the page shows as
 * current, in the person's language. It is stored one row per bank and kept
 * until any entry of the scope changes: migration 144's triggers delete it on
 * every change of the bank's entries, and a read whose current entries no
 * longer match the ones it was written from deletes it. It is never stored
 * with earlier versions (a rewrite replaces the row) and never read by recall
 * or a chat: this module is the table's only reader.
 */

/** What one call is given at most: the most recently mentioned entries that fit. */
export const OVERVIEW_INPUT_TOKEN_BUDGET = 6_000;
const OVERVIEW_MAX_CHARS = 3_000;

/** Model-facing subject names: ASCII English (ruling 79); the page's words are the browser's. */
const SUBJECT_NAMES: Record<MemorySubject, string> = {
	about_you: "About the person",
	home_family: "Home and family",
	work_study: "Work and study",
	health: "Health",
	projects: "Projects",
	interests: "Interests",
	other: "Other",
	goals_decisions: "Goals and decisions",
	people: "People",
	facts_figures: "Facts and figures",
	plans_status: "Plans and status",
};

/**
 * The Overview is a screen the person reads under Memory, not a turn, so it is
 * written in the account's UI language, like the nightly persona summary
 * (`tests/integration/english-request-purity.test.ts`): the one line below
 * names it, and nothing else in the request does.
 */
const LANGUAGE_NAMES = { en: "English", hu: "Hungarian" } as const;
type OverviewLanguage = keyof typeof LANGUAGE_NAMES;

const OVERVIEW_SCHEMA = {
	type: "object",
	properties: { overview: { type: "string" } },
	required: ["overview"],
	additionalProperties: false,
};

export interface OverviewEntry {
	subject: MemorySubject;
	kind: MemoryKind | null;
	text: string;
}

function overviewPrompt(
	scopeKind: MemoryScope["kind"],
	language: OverviewLanguage,
): string {
	return [
		scopeKind === "project"
			? "Write the short overview a person reads at the top of a project's Memory page: what is remembered about the project, as one paragraph."
			: "Write the short overview a person reads at the top of their Memory page: what is remembered about them, as one paragraph.",
		`Write the paragraph in ${LANGUAGE_NAMES[language]}.`,
		"Use that language's own everyday words: translate any term in the entries into it, but keep every name exactly as written, accents included. Copy no word from another language out of an entry, however common it has become (it is spelt the way that other language spells it): write this language's own everyday word for the same thing, and keep the borrowed word only when there is none.",
		"Use only the entries given. Do not add, guess or generalise beyond them, and leave out what they do not say. Keep each detail with the entry it comes from: never move a time, place, name or number to another entry, and keep what is being learned, planned or looked for as learning, planning or looking.",
		"An entry marked ongoing is under way now and one marked temporary is a passing state; present nothing as finished or past unless an entry says so.",
		scopeKind === "project"
			? "Refer to the project by its name when one is given."
			: "Refer to the person by their name, in the third person, when a name is given; otherwise address them as you.",
		"Cover every subject the entries are filed under, with at least one short, plain sentence for each, and leave no entry out: when a subject has several small entries, name each in a few words within one sentence rather than dropping any. Use as many sentences as that takes, never more than ten, each one simple, with no fact twice; no headings, lists, quotation marks or emphasis. Never mention memory, entries, lists or this task.",
		'Return JSON: {"overview": "<the paragraph>"}.',
	].join("\n");
}

/** An entry as the model receives it. */
function inputEntry(entry: OverviewEntry) {
	return {
		subject: SUBJECT_NAMES[entry.subject],
		...(entry.kind && entry.kind !== "lasting" ? { kind: entry.kind } : {}),
		text: entry.text,
	};
}

/** What an entry costs the call: its exact JSON, and the comma after it. */
function entryTokens(entry: OverviewEntry): number {
	return estimateTokenCount(JSON.stringify(inputEntry(entry))) + 1;
}

/**
 * The most recently mentioned entries that fit the budget, in that order
 * (entries arrive newest first); at least the newest one.
 */
export function selectOverviewEntries<Entry extends OverviewEntry>(
	entries: readonly Entry[],
	budget = OVERVIEW_INPUT_TOKEN_BUDGET,
): Entry[] {
	const chosen: Entry[] = [];
	let used = 0;
	for (const entry of entries) {
		const cost = entryTokens(entry);
		if (chosen.length && used + cost > budget) break;
		chosen.push(entry);
		used += cost;
	}
	return chosen;
}

/**
 * The Overview's one model call: an English prompt, the entries as data, the
 * paragraph back as JSON, read by a person (the family's sampling profile).
 */
export async function composeMemoryOverview(
	input: {
		scopeKind: MemoryScope["kind"];
		/** The person's name for a personal scope, the project's for a project. */
		name: string | null;
		language: OverviewLanguage;
		entries: readonly OverviewEntry[];
	},
	model: CurationModel,
): Promise<string> {
	const result = await model(
		overviewPrompt(input.scopeKind, input.language),
		{
			about: input.scopeKind === "project" ? "a project" : "a person",
			name: input.name,
			entries: input.entries.map(inputEntry),
		},
		OVERVIEW_SCHEMA,
		"off",
		undefined,
		{ readBy: "person" },
	);
	const text =
		isJsonRecord(result) && typeof result.overview === "string"
			? result.overview.trim()
			: "";
	if (!text || text.length > OVERVIEW_MAX_CHARS)
		throw new NativeMemoryError("memory_overview_invalid", true);
	return text;
}

function accountLanguage(userId: string): OverviewLanguage {
	const row = db
		.select({ language: users.uiLanguage })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	return row?.language === "hu" ? "hu" : "en";
}

function scopeName(userId: string, scope: MemoryScope): string | null {
	if (scope.kind === "project")
		return (
			db
				.select({ name: projects.name })
				.from(projects)
				.where(eq(projects.id, scope.projectId))
				.get()?.name ?? null
		);
	const name = db
		.select({ name: users.name })
		.from(users)
		.where(eq(users.id, userId))
		.get()?.name;
	return name?.trim() || null;
}

/** The entries the page shows as current, newest first. */
function currentEntries(entries: readonly MemorySubjectEntry[]) {
	return entries.filter(({ timeState }) => timeState !== "earlier");
}

/**
 * Which entries an Overview was written from: every current entry's identity
 * and everything the model is told of it (its text, its kind and its subject),
 * so an entry that was relabelled is a different entry.
 */
function entriesHash(current: readonly MemorySubjectEntry[]): string {
	return memoryTextHash(
		JSON.stringify(
			current.map((entry) => [
				entry.ref.rowId,
				entry.text,
				entry.kind,
				entry.subject,
			]),
		),
	);
}

function none(currentCount: number): MemoryOverview {
	return {
		state: "none",
		currentCount,
		text: null,
		writtenFrom: null,
		writtenAt: null,
	};
}

/**
 * The stored Overview, when it still matches the scope's current entries and
 * the account's language; otherwise it is deleted here and the answer is
 * "none", with the count the sheet writes from.
 */
export function readMemoryOverview(
	userId: string,
	input: MemoryScope,
	now = new Date(),
): MemoryOverview {
	const scope = parseMemoryScope(input);
	const read = readScopeEntries(userId, scope, now);
	const current = currentEntries(read.entries);
	if (!read.bankId) return none(current.length);
	const bankId = read.bankId;
	const stored = db
		.select()
		.from(memoryOverviews)
		.where(eq(memoryOverviews.bankId, bankId))
		.get();
	if (!stored) return none(current.length);
	if (
		stored.userId !== userId ||
		stored.entriesHash !== entriesHash(current) ||
		stored.language !== accountLanguage(userId)
	) {
		db.delete(memoryOverviews).where(eq(memoryOverviews.bankId, bankId)).run();
		return none(current.length);
	}
	return {
		state: "written",
		currentCount: current.length,
		text: stored.text,
		writtenFrom: stored.writtenFrom,
		writtenAt: stored.createdAt.toISOString(),
	};
}

/** One write in flight per bank: a second request waits for the first's answer. */
const writing = new Map<string, Promise<MemoryOverview>>();

/**
 * Writes the scope's Overview with one model call and stores it, unless a
 * stored one still matches and no rewrite was asked for. It is stored only if
 * the scope's current entries are the same after the call as before it; when
 * they changed (a removal while it was written), it is written once more from
 * the new entries, and a second change refuses with `overview_changed`.
 */
export async function writeMemoryOverview(
	userId: string,
	input: MemoryScope,
	options: {
		rewrite: boolean;
		signal?: AbortSignal;
		model?: CurationModel;
		now?: Date;
	},
): Promise<MemoryOverview> {
	const scope = parseMemoryScope(input);
	const now = options.now ?? new Date();
	const key = `${userId}:${memoryScopeKey(scope)}`;
	const running = writing.get(key);
	if (running) return running;
	const task = (async () => {
		if (!options.rewrite) {
			const stored = readMemoryOverview(userId, scope, now);
			if (stored.state === "written") return stored;
		}
		// The memory model path, through Hindsight's admission gateway. A person
		// waits for this answer, so it is an interactive call in the account's
		// own lane: it overtakes background work in the queue (admission.ts).
		const model =
			options.model ??
			createCurationModel(
				options.signal ?? new AbortController().signal,
				undefined,
				memoryAdmissionFor(userId, "interactive"),
			);
		for (let attempt = 0; attempt < 2; attempt++) {
			const read = readScopeEntries(userId, scope, now);
			const current = currentEntries(read.entries);
			if (!read.bankId || !current.length)
				throw new MemoryRequestError("overview_empty", 409);
			const bankId = read.bankId;
			const chosen = selectOverviewEntries(current);
			const language = accountLanguage(userId);
			const text = await composeMemoryOverview(
				{
					scopeKind: scope.kind,
					name: scopeName(userId, scope),
					language,
					entries: chosen,
				},
				model,
			);
			const hash = entriesHash(current);
			const written = db.transaction((tx): MemoryOverview | null => {
				const again = readScopeEntries(userId, scope, now);
				if (
					again.bankId !== bankId ||
					entriesHash(currentEntries(again.entries)) !== hash ||
					accountLanguage(userId) !== language
				)
					return null;
				const createdAt = new Date();
				const row = {
					userId,
					language,
					text,
					entriesHash: hash,
					writtenFrom: chosen.length,
					currentCount: current.length,
					createdAt,
				};
				tx.insert(memoryOverviews)
					.values({ bankId, ...row })
					.onConflictDoUpdate({ target: memoryOverviews.bankId, set: row })
					.run();
				return {
					state: "written",
					currentCount: current.length,
					text,
					writtenFrom: chosen.length,
					writtenAt: createdAt.toISOString(),
				};
			});
			if (written) return written;
		}
		throw new MemoryRequestError("overview_changed", 409);
	})().finally(() => writing.delete(key));
	writing.set(key, task);
	return task;
}
