import {
	SEARCH_MIN_QUERY_CHARS,
	searchTerms,
	typedSearchWords,
} from "$lib/shared/workspace-search-text";
import { recentChats, searchChats } from "./chats";
import { recentDocuments, searchDocuments } from "./documents";
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

// Until the "View all in Knowledge" row goes (it is replaced by the chips and
// "Show all"), the response still says whether more documents exist.
function buildKnowledgeHref(query: string): string {
	const url = new URL("/knowledge", "http://localhost");
	url.searchParams.set("query", query);
	return `${url.pathname}${url.search}`;
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
		const [conversations, documents] = await Promise.all([
			recentChats(userId, SEARCH_ALL_PER_KIND),
			recentDocuments(userId, SEARCH_ALL_PER_KIND),
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
			memorySearchable: false,
			nextCursor: null,
			documentOverflow: false,
			knowledgeHref: null,
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
	const [chatResults, documentResults] = await Promise.all([
		searchChats(userId, { terms, words: typedSearchWords(query) }, chatWindow),
		searchDocuments(
			userId,
			{ terms, words: typedSearchWords(query) },
			scope,
			documentWindow,
		),
	]);

	const shown = documentResults.results.length;
	const documentTotal =
		documentResults.totals.documents +
		documentResults.totals.media +
		documentResults.totals.apps;
	const overflow = documentTotal > shown;
	let nextCursor: string | null = null;
	if (scope === "chats" && chatResults.hasMore) {
		nextCursor = `o:${chatWindow.offset + chatWindow.limit}`;
	} else if (documentKind && documentResults.hasMore) {
		nextCursor = `o:${documentWindow.offset + documentWindow.limit}`;
	}
	return {
		query,
		mode,
		scope,
		conversations: chatResults.results,
		memories: [],
		documents: documentResults.results,
		totals: { chats: chatResults.total, memory: 0, ...documentResults.totals },
		memorySearchable: false,
		nextCursor,
		documentOverflow: overflow,
		knowledgeHref: overflow ? buildKnowledgeHref(query) : null,
	};
}
