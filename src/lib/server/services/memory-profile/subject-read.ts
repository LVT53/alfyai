import {
	type MemoryPage,
	type MemoryScope,
	type MemorySubject,
	type MemorySubjectEntry,
	type MemorySubjectIndex,
	type MemorySubjectKey,
	type MemorySubjectPage,
	memorySubjectsFor,
} from "$lib/memory-types";
import { getMemoryAgingThresholds } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { parseEarlierStates } from "../memory-context/recall-format";
import { groupFactsById, memoryEntryView } from "./entry-view";
import { readFactLabels } from "./fact-labels";
import { isJsonRecord } from "./internal-json";
import { MemoryRequestError, parseMemoryScope } from "./memory-request";
import {
	authorityOf,
	memoryBankStatus,
	readMemoryScope,
	rowsFor,
} from "./native-read";
import { admittedNativeFacts } from "./publication";

/**
 * The Memory page's subject index (layout C, Memory part 3): the scope's
 * published entries, each built as recall builds it (`memoryEntryView`),
 * grouped by subject, with Earlier entries folded away. Current means what
 * the page shows as current: current and quiet entries. Reads only; being
 * shown never moves an entry's date.
 */

const WEEK_MS = 7 * 86_400_000;
const SUBJECT_PAGE_SIZE = 100;
const PREVIEW_CHARS = 200;
const EARLIER_PREVIEWS = 3;

export interface ScopeEntries {
	/** The bank the entries were read from; null when Memory shows nothing here. */
	bankId: string | null;
	authority: MemoryPage["authority"];
	generation: string;
	status: MemoryPage["status"];
	/** Every published entry, most recently mentioned first. */
	entries: MemorySubjectEntry[];
}

function sourceIds(json: string): unknown[] {
	try {
		const ids: unknown = JSON.parse(json);
		return Array.isArray(ids) ? ids : [];
	} catch {
		return [];
	}
}

function newestFirst(a: MemorySubjectEntry, b: MemorySubjectEntry): number {
	const at = (entry: MemorySubjectEntry) =>
		entry.lastMentionedAt === null ? -1 : Date.parse(entry.lastMentionedAt);
	return at(b) - at(a) || a.ref.rowId.localeCompare(b.ref.rowId);
}

/**
 * The scope's entries as the page shows them, on one clock. Memory off, an
 * account not on native Memory and a scope without a bank read as empty,
 * with the status and authority the list page reports.
 */
export function readScopeEntries(
	userId: string,
	scope: MemoryScope,
	now: Date,
): ScopeEntries {
	return db.transaction(() => {
		const { user, account, bank } = readMemoryScope(userId, scope);
		const authority = authorityOf(account);
		const empty: ScopeEntries = {
			bankId: null,
			authority,
			generation: bank?.generation ?? "",
			status: user.memoryEnabled ? "ready" : "off",
			entries: [],
		};
		if (!user.memoryEnabled || authority !== "hindsight" || !bank) return empty;
		const rows = rowsFor(userId, bank.id);
		const factsById = groupFactsById(admittedNativeFacts(userId, bank.id));
		const labels = readFactLabels(db, bank.id);
		const thresholds = getMemoryAgingThresholds();
		const subjects: readonly MemorySubject[] = memorySubjectsFor(scope.kind);
		const entries = rows.map((row): MemorySubjectEntry => {
			const view = memoryEntryView(
				{ sourceIds: sourceIds(row.sourceIdsJson), factsById, labels },
				now,
				thresholds,
			);
			const said =
				view.lastMentionedAt === null ? null : Date.parse(view.lastMentionedAt);
			return {
				ref: { scope, generation: row.generation, rowId: row.nativeId },
				text: row.text,
				subject:
					view.subject && subjects.includes(view.subject)
						? view.subject
						: "other",
				kind: view.kind,
				timeState: view.timeState,
				lastMentionedAt: view.lastMentionedAt,
				quietWeeks:
					view.timeState === "quiet" && said !== null
						? Math.floor((now.getTime() - said) / WEEK_MS)
						: null,
				earlierStates: parseEarlierStates(row.nativeText, row.text),
			};
		});
		return {
			bankId: bank.id,
			authority,
			generation: rows[0]?.generation ?? bank.generation ?? "",
			status: memoryBankStatus(userId, bank),
			entries: entries.sort(newestFirst),
		};
	});
}

/** A row's one line: the entry's text, cut for the wire (the row clips it). */
function previewOf(text: string): string {
	const line = text.trim();
	return line.length > PREVIEW_CHARS ? line.slice(0, PREVIEW_CHARS) : line;
}

/** An Earlier fold's previews are joined on one line, so each loses its final full stop. */
function foldPreviewOf(text: string): string {
	return previewOf(text).replace(/\.$/u, "");
}

export function readMemorySubjectIndex(
	userId: string,
	input: MemoryScope,
	now = new Date(),
): MemorySubjectIndex {
	const scope = parseMemoryScope(input);
	const read = readScopeEntries(userId, scope, now);
	const current = read.entries.filter(
		({ timeState }) => timeState !== "earlier",
	);
	const earlier = read.entries.filter(
		({ timeState }) => timeState === "earlier",
	);
	return {
		authority: read.authority,
		scope,
		generation: read.generation,
		status: read.status,
		subjects: memorySubjectsFor(scope.kind).flatMap((subject) => {
			const mine = current.filter((entry) => entry.subject === subject);
			if (!mine.length) return [];
			const folded = earlier.filter((entry) => entry.subject === subject);
			return [
				{
					subject,
					count: mine.length,
					preview: previewOf(mine[0].text),
					active:
						subject === "projects" &&
						mine.some(
							(entry) =>
								entry.kind === "ongoing" && entry.timeState === "current",
						),
					earlierCount: folded.length,
					earlierPreview: folded
						.slice(0, EARLIER_PREVIEWS)
						.map((entry) => foldPreviewOf(entry.text)),
				},
			];
		}),
		earlier: {
			count: earlier.length,
			preview: earlier
				.slice(0, EARLIER_PREVIEWS)
				.map((entry) => foldPreviewOf(entry.text)),
		},
		currentCount: current.length,
	};
}

interface SubjectCursor {
	generation: string;
	subject: string;
	state: string;
	offset: number;
}

function readCursor(value: string): SubjectCursor {
	try {
		const parsed: unknown = JSON.parse(
			Buffer.from(value, "base64url").toString(),
		);
		if (
			isJsonRecord(parsed) &&
			typeof parsed.generation === "string" &&
			typeof parsed.subject === "string" &&
			typeof parsed.state === "string" &&
			typeof parsed.offset === "number" &&
			Number.isInteger(parsed.offset) &&
			parsed.offset > 0
		)
			return parsed as unknown as SubjectCursor;
	} catch {
		// An unreadable cursor is an invalid one.
	}
	throw new MemoryRequestError("invalid_cursor");
}

/** A subject's current or Earlier entries (or every subject's), most recently mentioned first, 100 a page. */
export function listMemorySubject(
	userId: string,
	input: {
		scope: MemoryScope;
		subject: MemorySubjectKey;
		state: "current" | "earlier";
		cursor?: string;
	},
	now = new Date(),
): MemorySubjectPage {
	const scope = parseMemoryScope(input.scope);
	const subjects: readonly string[] = memorySubjectsFor(scope.kind);
	if (input.subject !== "all" && !subjects.includes(input.subject))
		throw new MemoryRequestError("invalid_subject");
	if (input.state !== "current" && input.state !== "earlier")
		throw new MemoryRequestError("invalid_state");
	const read = readScopeEntries(userId, scope, now);
	const cursor = input.cursor ? readCursor(input.cursor) : null;
	if (
		cursor &&
		(cursor.subject !== input.subject || cursor.state !== input.state)
	)
		throw new MemoryRequestError("invalid_cursor");
	if (cursor && cursor.generation !== read.generation)
		throw new MemoryRequestError("stale_memory", 409);
	const matching = read.entries.filter(
		(entry) =>
			(input.subject === "all" || entry.subject === input.subject) &&
			(input.state === "earlier") === (entry.timeState === "earlier"),
	);
	const offset = cursor?.offset ?? 0;
	const next = offset + SUBJECT_PAGE_SIZE;
	return {
		scope,
		generation: read.generation,
		subject: input.subject,
		state: input.state,
		entries: matching.slice(offset, next),
		total: matching.length,
		nextCursor:
			next < matching.length
				? Buffer.from(
						JSON.stringify({
							generation: read.generation,
							subject: input.subject,
							state: input.state,
							offset: next,
						} satisfies SubjectCursor),
					).toString("base64url")
				: null,
	};
}
