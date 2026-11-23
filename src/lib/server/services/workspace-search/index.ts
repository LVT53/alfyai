import {
	SEARCH_MIN_QUERY_CHARS,
	searchTerms,
	typedSearchWords,
} from "$lib/shared/workspace-search-text";
import { recentChats, searchChats } from "./chats";
import { recentDocuments, searchDocuments } from "./documents";
import { searchMemories } from "./memories";
import {
	SEARCH_ALL_PER_KIND,
	SEARCH_PAGE_SIZE,
	type WorkspaceSearchKind,
	type WorkspaceSearchResponse,
	type WorkspaceSearchScope,
} from "./types";

export * from "./types";

const CURSOR_PATTERN = /^o:(\d{1,6})$/;

function normalizeQuery(value: string | null | undefined): string {
	return (value ?? "").trim();
}

/** A cursor is "o:<offset>"; one that cannot be read counts as none. */
function readCursorOffset(cursor: string | null | undefined): number {
	const match = CURSOR_PATTERN.exec(cursor ?? "");
	return match ? Number(match[1]) : 0;
}

/**
 * What a kind returns for the chosen scope: "All" shows a few of each kind from
 * the top, a kind's own scope shows its page from the cursor, any other kind
 * shows nothing (its count is still read, so every chip stays true).
 */
function windowFor(
	kind: WorkspaceSearchKind,
	scope: WorkspaceSearchScope,
	offset: number,
): { offset: number; limit: number } {
	if (scope === "all") return { offset: 0, limit: SEARCH_ALL_PER_KIND };
	if (scope === kind) return { offset, limit: SEARCH_PAGE_SIZE };
	return { offset: 0, limit: 0 };
}

export async function searchWorkspace(
	userId: string,
	options: {
		query?: string | null;
		scope?: WorkspaceSearchScope | null;
		cursor?: string | null;
	} = {},
): Promise<WorkspaceSearchResponse> {
	const query = normalizeQuery(options.query);
	const terms = searchTerms(query);
	// A query with no words once cleaned ("!!") shows the empty-query view.
	const mode =
		terms.join("").length >= SEARCH_MIN_QUERY_CHARS ? "query" : "default";

	if (mode === "default") {
		const [conversations, documents, memory] = await Promise.all([
			recentChats(userId, SEARCH_ALL_PER_KIND),
			recentDocuments(userId, SEARCH_ALL_PER_KIND),
			searchMemories(userId, [], query, { offset: 0, limit: 0 }),
		]);
		const countOf = (kind: "documents" | "media" | "apps") =>
			documents.filter((row) => row.searchKind === kind).length;
		return {
			query,
			mode,
			scope: "all",
			conversations,
			memories: [],
			documents,
			totals: {
				chats: conversations.length,
				memory: 0,
				documents: countOf("documents"),
				media: countOf("media"),
				apps: countOf("apps"),
			},
			memorySearchable: memory.searchable,
			nextCursor: null,
		};
	}

	const scope = options.scope ?? "all";
	const offset = readCursorOffset(options.cursor);
	const chatWindow = windowFor("chats", scope, offset);
	const documentKind =
		scope === "documents" || scope === "media" || scope === "apps"
			? scope
			: null;
	const documentWindow = documentKind
		? windowFor(documentKind, scope, offset)
		: windowFor("documents", scope, offset);
	const [chatResults, documentResults, memoryResults] = await Promise.all([
		searchChats(userId, { terms, words: typedSearchWords(query) }, chatWindow),
		searchDocuments(
			userId,
			{ terms, words: typedSearchWords(query) },
			scope,
			documentWindow,
		),
		searchMemories(userId, terms, query, windowFor("memory", scope, offset)),
	]);

	let nextCursor: string | null = null;
	if (scope === "chats" && chatResults.hasMore) {
		nextCursor = `o:${chatWindow.offset + chatWindow.limit}`;
	} else if (scope === "memory" && memoryResults.hasMore) {
		nextCursor = `o:${offset + SEARCH_PAGE_SIZE}`;
	} else if (documentKind && documentResults.hasMore) {
		nextCursor = `o:${documentWindow.offset + documentWindow.limit}`;
	}
	return {
		query,
		mode,
		scope,
		conversations: chatResults.results,
		memories: memoryResults.results,
		documents: documentResults.results,
		totals: {
			chats: chatResults.total,
			memory: memoryResults.total,
			...documentResults.totals,
		},
		memorySearchable: memoryResults.searchable,
		nextCursor,
	};
}
