// Memory profile category paging + filtering (everyday-screens redesign,
// Knowledge board).
//
// The profile is drawn at the size it really is: a category can hold fifty
// memories, so each one shows its newest few and discloses the rest INLINE
// (the section grows in place; the other sections keep their position). The
// counts stay honest — while a text filter is on a heading reads
// "3 of 23 match" rather than silently showing a short list, because a
// filtered count that looks like a total is how people come to believe the
// assistant forgot something.
//
// Pure logic, no Svelte: KnowledgeMemoryView renders what these return.

import type {
	MemoryProfileCategory,
	MemoryProfilePublicItem,
	MemoryProfilePublicPayload,
} from "$lib/memory-profile-types";

/** Rows drawn before a category has to be expanded. */
export const MEMORY_CATEGORY_PAGE_SIZE = 5;

/** The chip filter: one category, or every category at once. */
export type MemoryCategorySelection = MemoryProfileCategory | "all";

export interface MemoryCategoryView {
	category: MemoryProfileCategory;
	/** Everything the category holds, before any filter. */
	total: number;
	/** How many of those match the current text filter. */
	matching: number;
	/** The rows to draw, newest first. */
	visible: MemoryProfilePublicItem[];
	/** Matching rows not drawn yet — what "Show all N" would reveal. */
	hiddenCount: number;
	expanded: boolean;
	/** True while a text filter narrows this category. */
	filtered: boolean;
}

export interface MemoryFilterChip {
	id: MemoryCategorySelection;
	/** Everything in scope for this chip, before the text filter. */
	total: number;
	/** How much of that matches the text filter. */
	matching: number;
}

function categoryItems(
	profile: MemoryProfilePublicPayload | null,
	category: MemoryProfileCategory,
): MemoryProfilePublicItem[] {
	return (
		profile?.categories.find((group) => group.category === category)?.items ??
		[]
	);
}

/** Newest first — the order the disclosure row promises ("N more, newest first"). */
export function sortMemoriesNewestFirst(
	items: readonly MemoryProfilePublicItem[],
): MemoryProfilePublicItem[] {
	return [...items].sort((left, right) => {
		const byUpdated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
		if (Number.isFinite(byUpdated) && byUpdated !== 0) return byUpdated;
		return left.id.localeCompare(right.id);
	});
}

/**
 * Does this memory match the free-text filter? Matches the words of the
 * memory itself — the statement — which is what the box says it filters.
 */
export function matchesMemoryFilter(
	item: MemoryProfilePublicItem,
	filterText: string,
): boolean {
	const needle = filterText.trim().toLowerCase();
	if (!needle) return true;
	return item.statement.toLowerCase().includes(needle);
}

export function buildMemoryCategoryView(params: {
	category: MemoryProfileCategory;
	items: readonly MemoryProfilePublicItem[];
	filterText?: string;
	expanded?: boolean;
	pageSize?: number;
}): MemoryCategoryView {
	const filterText = params.filterText ?? "";
	const pageSize = params.pageSize ?? MEMORY_CATEGORY_PAGE_SIZE;
	const expanded = params.expanded ?? false;
	const filtered = filterText.trim().length > 0;

	const ordered = sortMemoriesNewestFirst(params.items);
	const matches = filtered
		? ordered.filter((item) => matchesMemoryFilter(item, filterText))
		: ordered;

	const visible = expanded ? matches : matches.slice(0, pageSize);

	return {
		category: params.category,
		total: ordered.length,
		matching: matches.length,
		visible,
		hiddenCount: Math.max(0, matches.length - visible.length),
		expanded,
		filtered,
	};
}

/**
 * Every category the page draws, in the given order. A chip selection other
 * than "all" narrows the list to that one category; the text filter narrows
 * the rows inside every category that survives.
 */
export function buildMemoryCategoryViews(params: {
	profile: MemoryProfilePublicPayload | null;
	order: readonly MemoryProfileCategory[];
	filterText?: string;
	selection?: MemoryCategorySelection;
	expanded?: ReadonlySet<MemoryProfileCategory>;
	pageSize?: number;
}): MemoryCategoryView[] {
	const selection = params.selection ?? "all";
	return params.order
		.filter((category) => selection === "all" || selection === category)
		.map((category) =>
			buildMemoryCategoryView({
				category,
				items: categoryItems(params.profile, category),
				filterText: params.filterText,
				expanded: params.expanded?.has(category) ?? false,
				pageSize: params.pageSize,
			}),
		);
}

/**
 * The filter chips: "All 52", then one per category with its own count. The
 * totals never move with the text filter (they say what is held); `matching`
 * is what the chip would show you if you picked it.
 */
export function buildMemoryFilterChips(params: {
	profile: MemoryProfilePublicPayload | null;
	order: readonly MemoryProfileCategory[];
	filterText?: string;
}): MemoryFilterChip[] {
	const filterText = params.filterText ?? "";
	const perCategory = params.order.map((category) => {
		const items = categoryItems(params.profile, category);
		return {
			id: category as MemoryCategorySelection,
			total: items.length,
			matching: items.filter((item) => matchesMemoryFilter(item, filterText))
				.length,
		};
	});

	const all: MemoryFilterChip = {
		id: "all",
		total: perCategory.reduce((sum, chip) => sum + chip.total, 0),
		matching: perCategory.reduce((sum, chip) => sum + chip.matching, 0),
	};

	return [all, ...perCategory];
}

/** Total active memories held across every category. */
export function countActiveMemories(
	profile: MemoryProfilePublicPayload | null,
): number {
	return (profile?.categories ?? []).reduce(
		(total, group) => total + group.items.length,
		0,
	);
}

/** Toggling a category's inline disclosure. Returns a new set. */
export function toggleExpandedCategory(
	expanded: ReadonlySet<MemoryProfileCategory>,
	category: MemoryProfileCategory,
): Set<MemoryProfileCategory> {
	const next = new Set(expanded);
	if (next.has(category)) {
		next.delete(category);
	} else {
		next.add(category);
	}
	return next;
}
