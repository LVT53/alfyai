// Workspace search scope chips (everyday-screens redesign, Search board).
//
// Today the only filter is the two fixed sections, whose headings silently
// rename themselves between "Recent conversations" and "Conversations". The
// chips say what is searchable, carry the per-kind count and let you narrow
// before you read.
//
// What each scope can actually reach, checked against the backend
// (src/lib/server/services/workspace-search.ts):
//   • Conversations — indexed (titles and message bodies).
//   • Documents     — indexed (artifact names, labels, summaries, content).
//   • Reports       — indexed, via the document index: an Atlas report's
//                     output lands in the Knowledge Base as a generated
//                     artifact, so this scope reaches real results rather than
//                     pretending to be a separate index. Documents and Reports
//                     partition the document results between them — a generated
//                     artifact is a report and appears once, under Reports — so
//                     no result is counted twice and the chips add up to All.
//   • Connections   — NOT indexed. Nothing in workspace-search reads calendar,
//                     mail or any other connector, so the chip ships disabled
//                     and labelled as coming soon rather than returning an
//                     empty list that reads like "you have nothing there".
//
// Pure logic, no Svelte — SearchModal renders what these return.

export type SearchScopeId =
	| "all"
	| "conversations"
	| "documents"
	| "reports"
	| "connections";

export const SEARCH_SCOPE_ORDER: readonly SearchScopeId[] = [
	"all",
	"conversations",
	"documents",
	"reports",
	"connections",
];

/** The kind of a rendered row, as far as scoping is concerned. */
export type SearchRowKind = "conversation" | "document" | "knowledge-overflow";

export interface ScopeableRow {
	id: string;
	kind: SearchRowKind;
	/** Only meaningful for document rows. */
	documentOrigin?: "uploaded" | "generated" | "skill_note" | null;
}

export interface SearchScopeChip {
	id: SearchScopeId;
	/** How many currently loaded results this scope would show. */
	count: number;
	/**
	 * False when the backend indexes nothing of this kind — the chip is drawn
	 * greyed and is not selectable.
	 */
	available: boolean;
}

/** Scopes the backend can actually answer for. */
export function isScopeAvailable(scope: SearchScopeId): boolean {
	return scope !== "connections";
}

function isReportRow(row: ScopeableRow): boolean {
	return row.kind === "document" && row.documentOrigin === "generated";
}

/**
 * Does this row belong in the given scope? The "View all documents in
 * Knowledge" overflow row is kept wherever documents are shown, because it is
 * the way out of a truncated document list.
 */
export function rowMatchesScope(
	row: ScopeableRow,
	scope: SearchScopeId,
): boolean {
	if (scope === "all") return true;
	if (scope === "conversations") return row.kind === "conversation";
	if (scope === "documents") {
		return (
			(row.kind === "document" && !isReportRow(row)) ||
			row.kind === "knowledge-overflow"
		);
	}
	if (scope === "reports") return isReportRow(row);
	return false;
}

export function filterRowsByScope<Row extends ScopeableRow>(
	rows: readonly Row[],
	scope: SearchScopeId,
): Row[] {
	if (scope === "all") return [...rows];
	return rows.filter((row) => rowMatchesScope(row, scope));
}

/**
 * The chip row. Counts describe the results currently loaded — the chips are
 * filters over what came back, not a claim about how much exists on the
 * server. The overflow row is never counted: it is a way out, not a result.
 */
export function buildSearchScopeChips(
	rows: readonly ScopeableRow[],
): SearchScopeChip[] {
	const countable = rows.filter((row) => row.kind !== "knowledge-overflow");
	return SEARCH_SCOPE_ORDER.map((id) => ({
		id,
		count: isScopeAvailable(id)
			? countable.filter((row) => rowMatchesScope(row, id)).length
			: 0,
		available: isScopeAvailable(id),
	}));
}

/**
 * A scope that stops being reachable (or stops having anything in it once the
 * query changes) falls back to All rather than leaving the palette empty under
 * a chip the user cannot see results for.
 */
export function resolveActiveScope(
	requested: SearchScopeId,
	chips: readonly SearchScopeChip[],
): SearchScopeId {
	if (requested === "all") return "all";
	const chip = chips.find((candidate) => candidate.id === requested);
	if (!chip?.available || chip.count === 0) return "all";
	return requested;
}

/** "6 results across 4 kinds" — the footer count, once something is typed. */
export function summariseScopedResults(rows: readonly ScopeableRow[]): {
	results: number;
	kinds: number;
} {
	const countable = rows.filter((row) => row.kind !== "knowledge-overflow");
	const kinds = new Set<SearchScopeId>();
	for (const row of countable) {
		if (row.kind === "conversation") kinds.add("conversations");
		else if (isReportRow(row)) kinds.add("reports");
		else kinds.add("documents");
	}
	return { results: countable.length, kinds: kinds.size };
}
