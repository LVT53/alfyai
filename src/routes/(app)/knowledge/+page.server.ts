import { redirect } from "@sveltejs/kit";
import {
	getKnowledgeLibraryPage,
	type KnowledgeLibrarySortDirection,
	type KnowledgeLibrarySortKey,
} from "$lib/server/services/knowledge";
import {
	parseFileFamilyFilter,
	parseKnowledgeKindFilter,
} from "./_components/documents-table";
import type { PageServerLoad } from "./$types";

const SORT_KEYS = new Set<KnowledgeLibrarySortKey>([
	"name",
	"size",
	"type",
	"date",
]);
const SORT_DIRECTIONS = new Set<KnowledgeLibrarySortDirection>(["asc", "desc"]);

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
		kindFilter: parseKnowledgeKindFilter(event.url.searchParams.get("type")),
		fileFamilyFilter: parseFileFamilyFilter(
			event.url.searchParams.get("family"),
		),
	});

	return { library };
};
