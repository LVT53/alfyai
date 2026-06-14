import { redirect } from "@sveltejs/kit";
import { isHonchoEnabled } from "$lib/server/services/honcho";
import {
	getKnowledgeLibraryPage,
	type KnowledgeLibrarySortDirection,
	type KnowledgeLibrarySortKey,
} from "$lib/server/services/knowledge";
import type { PageServerLoad } from "./$types";

function parsePositiveInteger(value: string | null): number | null {
	if (!value) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseSortKey(value: string | null): KnowledgeLibrarySortKey | null {
	return value === "name" ||
		value === "size" ||
		value === "type" ||
		value === "date"
		? value
		: null;
}

function parseSortDirection(
	value: string | null,
): KnowledgeLibrarySortDirection | null {
	return value === "asc" || value === "desc" ? value : null;
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
	});

	return {
		documents: library.documents,
		library,
		honchoEnabled: isHonchoEnabled(),
		userDisplayName: user.displayName,
	};
};
