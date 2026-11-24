import { searchMemoryEntries } from "$lib/server/services/memory-profile/native-read";
import { SEARCH_COUNT_CAP, type WorkspaceSearchMemoryResult } from "./types";

/**
 * Where an entry opens: the Memory tab, on that entry, with the search filled
 * in for the case where the entry has changed since. The parameter names are
 * Memory's own: `q` would turn the Knowledge page to Documents.
 */
function memoryHref(
	entry: Pick<WorkspaceSearchMemoryResult, "id" | "scope">,
	query: string,
): string {
	const scope =
		entry.scope.kind === "personal"
			? "personal"
			: `project:${entry.scope.projectId}`;
	return `/knowledge?tab=memory&memoryScope=${encodeURIComponent(scope)}&memoryEntry=${encodeURIComponent(entry.id)}&memoryQuery=${encodeURIComponent(query)}`;
}

/**
 * The Memory entries that hold every word, newest said first, for an account on
 * native Memory with Memory on (`searchable` says so; nothing is searched
 * otherwise). Which entries are found is `searchMemoryEntries`'s: exactly the
 * ones the Memory page shows.
 */
export async function searchMemories(
	userId: string,
	terms: readonly string[],
	query: string,
	window: { offset: number; limit: number },
): Promise<{
	results: WorkspaceSearchMemoryResult[];
	total: number;
	hasMore: boolean;
	searchable: boolean;
}> {
	const found = searchMemoryEntries(userId, terms, {
		...window,
		countCap: SEARCH_COUNT_CAP,
	});
	const typed = query.trim().replace(/\s+/g, " ");
	return {
		results: found.entries.map((entry) => {
			const result = {
				id: entry.ref.rowId,
				scope: entry.ref.scope,
				projectName: entry.projectName,
				text: entry.text,
				lastSaidAt: entry.lastSaidAt,
			};
			return { ...result, href: memoryHref(result, typed) };
		}),
		total: found.total,
		hasMore: found.hasMore,
		searchable: found.searchable,
	};
}
