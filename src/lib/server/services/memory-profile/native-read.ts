import { and, desc, eq, inArray, isNotNull, notLike, sql } from "drizzle-orm";
import type {
	MemoryDetail,
	MemoryPage,
	MemoryRef,
	MemoryRow,
	MemoryScope,
	MemorySource,
} from "$lib/memory-types";
import { type DatabaseInstance, db } from "$lib/server/db";
import {
	conversations,
	memoryAccounts,
	memoryActions,
	memoryBanks,
	memoryDeliveryJobs,
	memoryRevocations,
	memorySourceRevisions,
	messages,
	projects,
	users,
} from "$lib/server/db/schema";
import {
	matchesAllTerms,
	searchTerms,
} from "$lib/shared/workspace-search-text";
import { isJsonRecord } from "./internal-json";
import {
	MemoryRequestError,
	parseMemoryRef,
	parseMemoryScope,
} from "./memory-request";
import {
	admittedNativeFacts,
	entryLastSaidAt,
	factSaidTimes,
	memoryPresentationFingerprint,
	memorySupportFingerprint,
	publishedRowsForGeneration,
	readAcknowledgedFacts,
	readPublishedMemory,
	uniquePublishedSupport,
} from "./publication";
import { memoryScopeKey } from "./revisions";

export {
	MemoryRequestError,
	parseMemoryRef,
	parseMemoryScope,
} from "./memory-request";
export function readMemoryScope(userId: string, scope: MemoryScope) {
	const user = db.select().from(users).where(eq(users.id, userId)).get();
	if (!user) throw new MemoryRequestError("not_found", 404);
	if (
		scope.kind === "project" &&
		!db
			.select({ id: projects.id })
			.from(projects)
			.where(and(eq(projects.id, scope.projectId), eq(projects.userId, userId)))
			.get()
	)
		throw new MemoryRequestError("not_found", 404);
	const account = db
		.select()
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, userId))
		.get();
	const bank = account
		? db
				.select()
				.from(memoryBanks)
				.where(
					and(
						eq(memoryBanks.userId, userId),
						eq(memoryBanks.scopeKey, memoryScopeKey(scope)),
						eq(memoryBanks.epoch, account.epoch),
					),
				)
				.get()
		: undefined;
	return { user, account, bank };
}
type Published = ReturnType<typeof readPublishedMemory>[number];
type HistoryEntry = {
	action: typeof memoryActions.$inferSelect;
	sourceIds: string[];
	support?: string;
	presentation?: string;
	generation?: string;
	previousActionId?: string;
};
function memoryPublicRow(
	row: Published,
	scope: MemoryScope,
	sourceCount: number,
	legacyDates: ReadonlyMap<string, number | null>,
): MemoryRow {
	const facts = readAcknowledgedFacts(row.sourceFingerprintsJson);
	const date = row.updatedAt.getTime();
	const known =
		facts.length === 1 ||
		facts.every(
			(fact) => (fact.assertedAtMs ?? legacyDates.get(fact.id)) === date,
		);
	return {
		ref: { scope, generation: row.generation, rowId: row.nativeId },
		text: row.text,
		updatedAt: known ? row.updatedAt.toISOString() : null,
		sourceCount,
	};
}
function legacySupportingDates(
	userId: string,
	bankId: string,
	rows: Published[],
) {
	const missing = new Set(
		rows.flatMap((row) => {
			const facts = readAcknowledgedFacts(row.sourceFingerprintsJson);
			return facts.length > 1
				? facts
						.filter((fact) => fact.assertedAtMs === undefined)
						.map((fact) => fact.id)
				: [];
		}),
	);
	const dates = new Map<string, number | null>();
	if (!missing.size) return dates;
	for (const fact of admittedNativeFacts(userId, bankId)) {
		if (!missing.has(fact.id)) continue;
		const date = (
			fact.source.explicitEditAt ?? fact.source.assertedAt
		).getTime();
		dates.set(
			fact.id,
			dates.has(fact.id) && dates.get(fact.id) !== date ? null : date,
		);
	}
	return dates;
}
export function authorityOf(
	account: { authority: string } | undefined,
): MemoryPage["authority"] {
	return account?.authority === "hindsight"
		? "hindsight"
		: account?.authority === "preparing"
			? "preparing"
			: "legacy";
}
/** The rows the Memory page shows for a bank: the page's own read, which search and the subject index share. */
export function rowsFor(userId: string, bankId: string, generation?: string) {
	try {
		return readPublishedMemory(userId, bankId, generation);
	} catch (error) {
		if (error instanceof Error && error.message === "memory_generation_stale")
			throw new MemoryRequestError("stale_memory", 409);
		throw error;
	}
}
/** Whether the bank's Memory is being updated, or an update failed: the page's status line. */
export function memoryBankStatus(
	userId: string,
	bank: { id: string; epoch: number },
): MemoryPage["status"] {
	const jobs = db
		.select({
			status: memoryDeliveryJobs.status,
			kind: memoryDeliveryJobs.kind,
			actionId: memoryDeliveryJobs.actionId,
		})
		.from(memoryDeliveryJobs)
		.where(
			and(
				eq(memoryDeliveryJobs.userId, userId),
				eq(memoryDeliveryJobs.bankId, bank.id),
				eq(memoryDeliveryJobs.epoch, bank.epoch),
			),
		)
		.all();
	const outstandingCleanup = new Set(
		db
			.select({ id: memoryActions.id })
			.from(memoryActions)
			.where(
				and(
					eq(memoryActions.bankId, bank.id),
					eq(memoryActions.cleanupPending, true),
				),
			)
			.all()
			.map((a) => a.id),
	);
	return jobs.some((j) => j.status === "running")
		? "working"
		: jobs.some((j) => j.status === "queued")
			? "queued"
			: jobs.some(
						(j) =>
							(j.status === "failed" && j.kind !== "action") ||
							((j.status === "failed" || j.status === "cancelled") &&
								outstandingCleanup.has(j.actionId ?? "")),
					)
				? "failed"
				: "ready";
}
interface Cursor {
	bank: string;
	generation: string;
	query: string;
	date: number;
	id: string;
}
export function listMemory(
	userId: string,
	options: { scope: MemoryScope; query?: string; cursor?: string },
): MemoryPage {
	const scope = parseMemoryScope(options.scope);
	const query = (options.query ?? "").trim().toLocaleLowerCase();
	if (query.length > 500) throw new MemoryRequestError("invalid_query");
	// The box matches as search does: every word, in any order, case and accents
	// folded. A query with no words once cleaned is no query.
	const terms = searchTerms(query);
	return db.transaction(() => {
		const { user, account, bank } = readMemoryScope(userId, scope);
		const authority = authorityOf(account);
		const base: MemoryPage = {
			authority,
			scope,
			generation: bank?.generation ?? "",
			rows: [],
			nextCursor: null,
			status: user.memoryEnabled ? "ready" : "off",
			total: 0,
		};
		if (!user.memoryEnabled || authority !== "hindsight" || !bank) return base;
		let cursor: Cursor | undefined;
		if (options.cursor) {
			try {
				const parsed: unknown = JSON.parse(
					Buffer.from(options.cursor, "base64url").toString(),
				);
				if (
					!isJsonRecord(parsed) ||
					parsed.bank !== bank.id ||
					typeof parsed.generation !== "string" ||
					parsed.query !== query ||
					typeof parsed.date !== "number" ||
					!Number.isFinite(parsed.date) ||
					typeof parsed.id !== "string"
				)
					throw Error();
				cursor = parsed as unknown as Cursor;
			} catch {
				throw new MemoryRequestError("invalid_cursor");
			}
		}
		const generation = cursor?.generation ?? bank.generation ?? "";
		const published = rowsFor(userId, bank.id, generation || undefined);
		const rows = published
			.filter((r) => terms.length === 0 || matchesAllTerms(r.text, terms))
			.sort(
				(a, b) =>
					b.updatedAt.getTime() - a.updatedAt.getTime() ||
					a.nativeId.localeCompare(b.nativeId),
			);
		const visible = cursor
			? rows.filter(
					(r) =>
						r.updatedAt.getTime() < cursor.date ||
						(r.updatedAt.getTime() === cursor.date &&
							r.nativeId.localeCompare(cursor.id) > 0),
				)
			: rows;
		const page = visible.slice(0, 50);
		const legacyDates = legacySupportingDates(userId, bank.id, page);
		const last = page.at(-1);
		const status = memoryBankStatus(userId, bank);
		const sourceIndex = new Map<string, Set<string>>();
		const sources = conversationSources(userId, bank.id, bank.epoch);
		const history = publishedMemoryHistory(
			userId,
			bank.id,
			bank.epoch,
			generation,
		);
		for (const source of sources.values()) {
			for (const fact of readAcknowledgedFacts(source.acknowledgedFactsJson)) {
				const ids = sourceIndex.get(fact.id) ?? new Set<string>();
				ids.add(source.id);
				sourceIndex.set(fact.id, ids);
			}
		}
		return {
			...base,
			generation,
			rows: page.map((r) =>
				memoryPublicRow(
					r,
					scope,
					new Set([
						...readAcknowledgedFacts(r.sourceFingerprintsJson).flatMap((f) => [
							...(sourceIndex.get(f.id) ?? []),
						]),
						...(history.get(r.nativeId) ?? []).flatMap((entry) =>
							entry.sourceIds.filter((id) => sources.has(id)),
						),
					]).size,
					legacyDates,
				),
			),
			total: rows.length,
			status,
			nextCursor:
				visible.length > 50 && last
					? Buffer.from(
							JSON.stringify({
								bank: bank.id,
								generation,
								query,
								date: last.updatedAt.getTime(),
								id: last.nativeId,
							} satisfies Cursor),
						).toString("base64url")
					: null,
		};
	});
}
export interface MemorySearchEntry {
	ref: MemoryRef;
	text: string;
	/** The project's name; null for the personal bank. */
	projectName: string | null;
	/** When the person last said it, ISO; null when no source has a date. */
	lastSaidAt: string | null;
}

/**
 * The entries the Memory page shows that hold every word, across the personal
 * bank and every project the person owns, newest said first. An entry is shown
 * exactly when the page would show it (the page's own read, `rowsFor`), and a
 * bank that cannot be read (retired, blocked, a stale generation) is skipped so
 * one bad bank never hides the rest. `searchable` is false, with nothing
 * searched, when Memory is off or the account is not on native Memory.
 */
export function searchMemoryEntries(
	userId: string,
	terms: readonly string[],
	window: { offset: number; limit: number; countCap: number },
): {
	entries: MemorySearchEntry[];
	total: number;
	hasMore: boolean;
	searchable: boolean;
} {
	const none = { entries: [], total: 0, hasMore: false, searchable: false };
	return db.transaction(() => {
		const user = db.select().from(users).where(eq(users.id, userId)).get();
		const account = db
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, userId))
			.get();
		if (
			!(user?.memoryEnabled && account) ||
			authorityOf(account) !== "hindsight" ||
			account.lifecycleState !== "active"
		)
			return none;
		if (terms.length === 0) return { ...none, searchable: true };
		const projectNames = new Map(
			db
				.select({ id: projects.id, name: projects.name })
				.from(projects)
				.where(eq(projects.userId, userId))
				.all()
				.map((project) => [project.id, project.name]),
		);
		const found: MemorySearchEntry[] = [];
		for (const bank of db
			.select()
			.from(memoryBanks)
			.where(
				and(
					eq(memoryBanks.userId, userId),
					eq(memoryBanks.epoch, account.epoch),
				),
			)
			.all()) {
			const scope: MemoryScope | null =
				bank.scopeKey === "personal"
					? { kind: "personal" }
					: bank.scopeKey.startsWith("project:")
						? { kind: "project", projectId: bank.scopeKey.slice(8) }
						: null;
			// A bank whose project the person no longer owns is not theirs to search.
			if (
				!scope ||
				(scope.kind === "project" && !projectNames.has(scope.projectId))
			)
				continue;
			try {
				const rows = rowsFor(userId, bank.id).filter((row) =>
					matchesAllTerms(row.text, terms),
				);
				if (rows.length === 0) continue;
				const saidAt = factSaidTimes(admittedNativeFacts(userId, bank.id));
				for (const row of rows)
					found.push({
						ref: { scope, generation: row.generation, rowId: row.nativeId },
						text: row.text,
						projectName:
							scope.kind === "project"
								? (projectNames.get(scope.projectId) ?? null)
								: null,
						lastSaidAt: entryLastSaidAt(
							readAcknowledgedFacts(row.sourceFingerprintsJson).map(
								(fact) => fact.id,
							),
							saidAt,
						),
					});
			} catch {
				// A retired or blocked bank, a stale generation: skip this bank only.
			}
		}
		found.sort(
			(left, right) =>
				(right.lastSaidAt ?? "").localeCompare(left.lastSaidAt ?? "") ||
				left.ref.rowId.localeCompare(right.ref.rowId),
		);
		return {
			entries: found.slice(window.offset, window.offset + window.limit),
			total: Math.min(found.length, window.countCap),
			hasMore: window.offset + window.limit < found.length,
			searchable: true,
		};
	});
}
function conversationSources(userId: string, bankId: string, epoch: number) {
	const revoked = new Set(
		db
			.select({ id: memoryRevocations.sourceId })
			.from(memoryRevocations)
			.where(
				and(
					eq(memoryRevocations.userId, userId),
					eq(memoryRevocations.bankId, bankId),
					eq(memoryRevocations.epoch, epoch),
				),
			)
			.all()
			.map(({ id }) => id),
	);
	return new Map(
		db
			.select()
			.from(memorySourceRevisions)
			.where(
				and(
					eq(memorySourceRevisions.userId, userId),
					eq(memorySourceRevisions.bankId, bankId),
					eq(memorySourceRevisions.epoch, epoch),
					eq(memorySourceRevisions.state, "accepted"),
				),
			)
			.all()
			.filter((s) => !s.eventId.startsWith("manual:") && !revoked.has(s.id))
			.map((s) => [s.id, s]),
	);
}

function sourceEvidence(
	userId: string,
	scope: MemoryScope,
	row: Published,
	history: HistoryEntry[],
) {
	const ids = new Set(
		readAcknowledgedFacts(row.sourceFingerprintsJson).map((f) => f.id),
	);
	const originIds = new Set(history.flatMap((entry) => entry.sourceIds));
	const sources: MemorySource[] = [
		...conversationSources(userId, row.bankId, row.epoch).values(),
	]
		.filter(
			(s) =>
				originIds.has(s.id) ||
				readAcknowledgedFacts(s.acknowledgedFactsJson).some((f) =>
					ids.has(f.id),
				),
		)
		.map((source) => {
			const chat = source.conversationId
				? db
						.select()
						.from(conversations)
						.where(
							and(
								eq(conversations.id, source.conversationId),
								eq(conversations.userId, userId),
							),
						)
						.get()
				: null;
			const message =
				chat && source.messageId
					? db
							.select()
							.from(messages)
							.where(
								and(
									eq(messages.id, source.messageId),
									eq(messages.conversationId, chat.id),
									eq(messages.role, "user"),
								),
							)
							.get()
					: null;
			// The original source is an immutable quotation; a current edited message is never substituted.
			const available =
				!!chat &&
				!chat.memoryIncognito &&
				(chat.projectId ? `project:${chat.projectId}` : "personal") ===
					memoryScopeKey(scope) &&
				!!message &&
				message.content === source.text;
			return {
				id: source.id,
				conversationId: available ? chat.id : null,
				messageId: available ? message.id : null,
				title: available ? chat.title : "",
				quote: available ? source.text : "",
				assertedAt: (source.explicitEditAt ?? source.assertedAt).toISOString(),
				available,
			};
		});
	const knownIds = [...new Set([...originIds, ...sources.map(({ id }) => id)])];
	const conversationOrigin =
		knownIds.length > 0 &&
		!!db
			.select({ id: memorySourceRevisions.id })
			.from(memorySourceRevisions)
			.where(
				and(
					inArray(memorySourceRevisions.id, knownIds),
					eq(memorySourceRevisions.userId, userId),
					eq(memorySourceRevisions.bankId, row.bankId),
					eq(memorySourceRevisions.epoch, row.epoch),
					isNotNull(memorySourceRevisions.conversationId),
					isNotNull(memorySourceRevisions.messageId),
					notLike(memorySourceRevisions.eventId, "manual:%"),
				),
			)
			.get();
	return { sources, conversationOrigin };
}
export function getMemoryDetail(
	userId: string,
	input: MemoryRef,
): MemoryDetail & { origin: "manual" | "conversation" | "unknown" } {
	const ref = parseMemoryRef(input);
	return db.transaction(() => {
		const { user, account, bank } = readMemoryScope(userId, ref.scope);
		if (!user.memoryEnabled || account?.authority !== "hindsight" || !bank)
			throw new MemoryRequestError("not_found", 404);
		const published = rowsFor(userId, bank.id, ref.generation);
		const row = published.find((r) => r.nativeId === ref.rowId);
		if (!row) throw new MemoryRequestError("stale_memory", 409);
		const verified =
			publishedMemoryHistory(userId, bank.id, bank.epoch, ref.generation).get(
				row.nativeId,
			) ?? [];
		const { sources, conversationOrigin } = sourceEvidence(
			userId,
			ref.scope,
			row,
			verified,
		);
		return {
			row: memoryPublicRow(
				row,
				ref.scope,
				sources.length,
				legacySupportingDates(userId, bank.id, [row]),
			),
			sources,
			versions: verified.flatMap(({ action: a }) =>
				a.previousText
					? [{ text: a.previousText, changedAt: a.createdAt.toISOString() }]
					: [],
			),
			origin: verified.some(({ action: a }) => a.kind === "add")
				? "manual"
				: conversationOrigin
					? "conversation"
					: "unknown",
			canEdit: bank.generation === ref.generation,
			canRemove: bank.generation === ref.generation,
		};
	});
}

export function legacyMemoryAvailable(userId: string): boolean {
	return (
		db
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, userId))
			.get()?.authority !== "hindsight"
	);
}

export function verifiedMemoryHistory(
	userId: string,
	bankId: string,
	epoch: number,
	nativeId: string,
	database: Pick<DatabaseInstance, "select"> = db,
) {
	const bank = database
		.select({ generation: memoryBanks.generation })
		.from(memoryBanks)
		.where(
			and(
				eq(memoryBanks.id, bankId),
				eq(memoryBanks.userId, userId),
				eq(memoryBanks.epoch, epoch),
			),
		)
		.get();
	if (!bank?.generation) return [];
	return (
		publishedMemoryHistory(
			userId,
			bankId,
			epoch,
			bank.generation,
			database,
		).get(nativeId) ?? []
	).map(({ action }) => action);
}

function publishedMemoryHistory(
	userId: string,
	bankId: string,
	epoch: number,
	generation: string,
	database: Pick<DatabaseInstance, "select"> = db,
) {
	// Live revocations may hide a competing result but cannot change the native capture.
	const rows = publishedRowsForGeneration(database, bankId, epoch, generation);
	const resultRows = new Map(
		uniquePublishedSupport(rows).map(({ row, facts }) => [
			memorySupportFingerprint(facts),
			row,
		]),
	);
	const rowIds = new Set(rows.map(({ nativeId }) => nativeId));
	const result = new Map<string, HistoryEntry[]>();
	const actions = database
		.select()
		.from(memoryActions)
		.where(
			and(
				eq(memoryActions.userId, userId),
				eq(memoryActions.bankId, bankId),
				eq(memoryActions.epoch, epoch),
			),
		)
		.orderBy(desc(memoryActions.createdAt), sql`rowid desc`)
		.all();
	const history = new Map<string, HistoryEntry>();
	// The publication transaction records authority on the action; job retention cannot erase it.
	for (const action of actions) {
		if (!action.resultRowId) continue;
		try {
			const intent: unknown = JSON.parse(action.intentJson ?? "null");
			if (!isJsonRecord(intent) || intent.outcome !== "accepted") continue;
			history.set(action.id, {
				action,
				sourceIds: Array.isArray(intent.resultOriginSourceIds)
					? intent.resultOriginSourceIds.filter((id) => typeof id === "string")
					: [],
				support:
					typeof intent.resultSupport === "string"
						? intent.resultSupport
						: undefined,
				presentation:
					typeof intent.resultPresentation === "string"
						? intent.resultPresentation
						: undefined,
				generation:
					typeof intent.resultGeneration === "string"
						? intent.resultGeneration
						: undefined,
				previousActionId:
					typeof intent.previousResultActionId === "string"
						? intent.previousResultActionId
						: undefined,
			});
		} catch {
			// Corrupt action history cannot prove provenance.
		}
	}
	for (const entry of history.values()) {
		const { support, action } = entry;
		const row = support ? resultRows.get(support) : undefined;
		const nativeId = support
			? row &&
				(entry.presentation
					? memoryPresentationFingerprint(row.text, row.nativeText) ===
						entry.presentation
					: entry.generation === generation &&
						row.nativeId === action.resultRowId)
				? row.nativeId
				: undefined
			: action.resultRowId &&
					entry.generation === generation &&
					rowIds.has(action.resultRowId)
				? action.resultRowId
				: undefined;
		if (!nativeId || result.has(nativeId)) continue;
		const lineage = [entry];
		const seen = new Set([action.id]);
		let ancestry = entry.previousActionId;
		while (ancestry && !seen.has(ancestry)) {
			const parent = history.get(ancestry);
			if (!parent?.support) break;
			lineage.push(parent);
			seen.add(ancestry);
			ancestry = parent.previousActionId;
		}
		result.set(nativeId, lineage);
	}
	return result;
}
