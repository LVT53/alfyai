import { redirect } from "@sveltejs/kit";
import {
	getKnowledgeLibraryPage,
	type KnowledgeDocumentKindFilter,
	type KnowledgeLibrarySortDirection,
	type KnowledgeLibrarySortKey,
} from "$lib/server/services/knowledge";
import type { PageServerLoad } from "./$types";

const SORT_KEYS = new Set<KnowledgeLibrarySortKey>([
	"name",
	"size",
	"type",
	"date",
]);
const SORT_DIRECTIONS = new Set<KnowledgeLibrarySortDirection>(["asc", "desc"]);
// No "file" bucket (ruling 46, corrected): a produced file groups under
// "uploaded" with its own format pill.
const KIND_FILTERS = new Set<KnowledgeDocumentKindFilter>([
	"document",
	"canvas",
	"app",
	"slides",
	"uploaded",
]);
const DOCUMENT_TAB_PARAMS = ["q", "sort", "dir", "page", "pageSize", "type"];

function parsePositiveInteger(value: string | null): number | null {
	if (!value) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseSortKey(value: string | null): KnowledgeLibrarySortKey | null {
	const sortKey = value as KnowledgeLibrarySortKey | null;
	return sortKey && SORT_KEYS.has(sortKey) ? sortKey : null;
}

function parseSortDirection(
	value: string | null,
): KnowledgeLibrarySortDirection | null {
	const direction = value as KnowledgeLibrarySortDirection | null;
	return direction && SORT_DIRECTIONS.has(direction) ? direction : null;
}

function parseKindFilter(
	value: string | null,
): KnowledgeDocumentKindFilter | null {
	const kind = value as KnowledgeDocumentKindFilter | null;
	// Unrecognised value silently ignored — same rule as sort/dir.
	return kind && KIND_FILTERS.has(kind) ? kind : null;
}

function resolveInitialTab(url: URL): "memory" | "documents" {
	const requestedTab = url.searchParams.get("tab");
	const hasDocumentQuery = DOCUMENT_TAB_PARAMS.some((param) =>
		url.searchParams.has(param),
	);
	return requestedTab === "documents" || hasDocumentQuery
		? "documents"
		: "memory";
}

export const load: PageServerLoad = async (event) => {
	const user = event.locals.user;
	if (!user) {
		throw redirect(302, "/login");
	}
	const library = await getKnowledgeLibraryPage(user.id, {
		query: event.url.searchParams.get("q"),
		sortKey: parseSortKey(event.url.searchParams.get("sort")),
		sortDirection: parseSortDirection(event.url.searchParams.get("dir")),
		page: parsePositiveInteger(event.url.searchParams.get("page")),
		pageSize: parsePositiveInteger(event.url.searchParams.get("pageSize")),
		kindFilter: parseKindFilter(event.url.searchParams.get("type")),
	});

	return {
		documents: library.documents,
		library,
		userDisplayName: user.displayName,
		initialTab: resolveInitialTab(event.url),
	};
};
