// Workspace search scope chips.
//
// A chip is a kind of thing a person keeps in AlfyAI, with the true number of
// matches of that kind: the server counts every kind up to the cap on every
// search, so a chip never reads 0 while matches exist. "All" is the sum, and
// "Memory" is left out for an account whose Memory is off or not native.
//
// Pure logic, no Svelte: SearchModal renders what these return.

import type {
	WorkspaceSearchKind,
	WorkspaceSearchScope,
} from "$lib/server/services/workspace-search/types";
import { SEARCH_COUNT_CAP } from "$lib/shared/workspace-search-text";

export type SearchScopeId = WorkspaceSearchScope;

export const SEARCH_SCOPE_ORDER: readonly SearchScopeId[] = [
	"all",
	"chats",
	"memory",
	"documents",
	"media",
	"apps",
];

/** The kind of a rendered row, as far as scoping is concerned. */
export type SearchRowKind = "conversation" | "memory" | "document";

export interface ScopeableRow {
	id: string;
	kind: SearchRowKind;
	/** Only meaningful for document rows: which chip they sit under. */
	searchKind?: "documents" | "media" | "apps";
}

export interface SearchScopeChip {
	id: SearchScopeId;
	/** The true number of matches of this kind, counted up to the cap. */
	count: number;
}

/** "99+" at the cap, the number below it. */
export function formatScopeCount(count: number): string {
	return count >= SEARCH_COUNT_CAP ? `${SEARCH_COUNT_CAP - 1}+` : String(count);
}

/**
 * The chip row: All and a chip per kind, each with its count. All is the sum of
 * the kinds, and Memory is not a chip when memory cannot be searched.
 */
export function buildSearchScopeChips(
	totals: Record<WorkspaceSearchKind, number>,
	memorySearchable: boolean,
): SearchScopeChip[] {
	const kinds = SEARCH_SCOPE_ORDER.filter(
		(id): id is WorkspaceSearchKind =>
			id !== "all" && (id !== "memory" || memorySearchable),
	);
	const sum = kinds.reduce((total, kind) => total + (totals[kind] ?? 0), 0);
	return [
		{ id: "all", count: sum },
		...kinds.map((id) => ({ id, count: totals[id] ?? 0 })),
	];
}

/** Does this row belong in the given scope? Used to narrow the empty-query view. */
export function rowMatchesScope(
	row: ScopeableRow,
	scope: SearchScopeId,
): boolean {
	if (scope === "all") return true;
	if (scope === "chats") return row.kind === "conversation";
	if (scope === "memory") return row.kind === "memory";
	return row.kind === "document" && row.searchKind === scope;
}

/**
 * A scope that stops being a chip (Memory, once it cannot be searched) or stops
 * having anything in it once the query changes falls back to All, rather than
 * leaving the palette empty under a chip nobody can see results for.
 */
export function resolveActiveScope(
	requested: SearchScopeId,
	chips: readonly SearchScopeChip[],
): SearchScopeId {
	if (requested === "all") return "all";
	const chip = chips.find((candidate) => candidate.id === requested);
	if (!chip || chip.count === 0) return "all";
	return requested;
}

/**
 * "13 results across 5 kinds": the footer's count, from the server's totals.
 * `capped` says a kind's count stopped at the cap, so the sum is not exact.
 */
export function summariseTotals(totals: Record<WorkspaceSearchKind, number>): {
	results: number;
	kinds: number;
	capped: boolean;
} {
	const counts = Object.values(totals);
	return {
		results: counts.reduce((total, count) => total + count, 0),
		kinds: counts.filter((count) => count > 0).length,
		capped: counts.some((count) => count >= SEARCH_COUNT_CAP),
	};
}
