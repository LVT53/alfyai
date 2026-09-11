import { describe, expect, it } from "vitest";
import type {
	MemoryProfileCategory,
	MemoryProfilePublicItem,
	MemoryProfilePublicPayload,
} from "$lib/memory-profile-types";
import {
	buildMemoryCategoryView,
	buildMemoryCategoryViews,
	buildMemoryFilterChips,
	countActiveMemories,
	MEMORY_CATEGORY_PAGE_SIZE,
	matchesMemoryFilter,
	sortMemoriesNewestFirst,
	toggleExpandedCategory,
} from "./memory-categories";

const ORDER: MemoryProfileCategory[] = [
	"about_you",
	"preferences",
	"goals_ongoing_work",
	"constraints_boundaries",
];

function item(
	id: string,
	statement: string,
	updatedAt: string,
	category: MemoryProfileCategory = "about_you",
): MemoryProfilePublicItem {
	return {
		id,
		itemKey: `key-${id}`,
		category,
		statement,
		scope: { type: "global" },
		status: "active",
		revision: 1,
		updatedAt,
		confidence: "stated",
		canEdit: true,
		canDelete: true,
		canSuppress: true,
	};
}

/** N memories in a category, newest last so ordering is actually exercised. */
function manyItems(count: number, category: MemoryProfileCategory) {
	return Array.from({ length: count }, (_, index) =>
		item(
			`${category}-${index}`,
			`${category} memory number ${index}`,
			`2026-01-${String((index % 28) + 1).padStart(2, "0")}T03:00:00.000Z`,
			category,
		),
	);
}

function profile(
	counts: Partial<Record<MemoryProfileCategory, number>>,
): MemoryProfilePublicPayload {
	return {
		resetGeneration: 1,
		projectionRevision: 7,
		categories: ORDER.map((category) => ({
			category,
			items: manyItems(counts[category] ?? 0, category),
		})),
		review: { visibleItems: [], openCount: 0, overflowCount: 0 },
	};
}

describe("sortMemoriesNewestFirst", () => {
	it("puts the most recently updated memory first", () => {
		const sorted = sortMemoriesNewestFirst([
			item("a", "older", "2026-01-01T00:00:00.000Z"),
			item("c", "newest", "2026-03-01T00:00:00.000Z"),
			item("b", "middle", "2026-02-01T00:00:00.000Z"),
		]);
		expect(sorted.map((entry) => entry.id)).toEqual(["c", "b", "a"]);
	});

	it("breaks ties on id so equal timestamps never reshuffle", () => {
		const same = "2026-01-01T00:00:00.000Z";
		const sorted = sortMemoriesNewestFirst([
			item("z", "z", same),
			item("a", "a", same),
		]);
		expect(sorted.map((entry) => entry.id)).toEqual(["a", "z"]);
	});

	it("does not mutate the input", () => {
		const input = [
			item("a", "older", "2026-01-01T00:00:00.000Z"),
			item("b", "newer", "2026-02-01T00:00:00.000Z"),
		];
		sortMemoriesNewestFirst(input);
		expect(input.map((entry) => entry.id)).toEqual(["a", "b"]);
	});
});

describe("matchesMemoryFilter", () => {
	it("matches on the words of the memory, case-insensitively", () => {
		const memory = item("a", "Reads and writes in English and Hungarian.", "x");
		expect(matchesMemoryFilter(memory, "hungarian")).toBe(true);
		expect(matchesMemoryFilter(memory, "HUNGARIAN")).toBe(true);
		expect(matchesMemoryFilter(memory, "immich")).toBe(false);
	});

	it("treats an empty or whitespace-only filter as no filter", () => {
		const memory = item("a", "anything", "x");
		expect(matchesMemoryFilter(memory, "")).toBe(true);
		expect(matchesMemoryFilter(memory, "   ")).toBe(true);
	});
});

describe("buildMemoryCategoryView", () => {
	it("shows the first five and counts the rest as hidden", () => {
		const view = buildMemoryCategoryView({
			category: "about_you",
			items: manyItems(23, "about_you"),
		});
		expect(view.total).toBe(23);
		expect(view.matching).toBe(23);
		expect(view.visible).toHaveLength(MEMORY_CATEGORY_PAGE_SIZE);
		expect(view.hiddenCount).toBe(18);
		expect(view.expanded).toBe(false);
		expect(view.filtered).toBe(false);
	});

	it("shows everything and hides nothing once expanded", () => {
		const view = buildMemoryCategoryView({
			category: "about_you",
			items: manyItems(23, "about_you"),
			expanded: true,
		});
		expect(view.visible).toHaveLength(23);
		expect(view.hiddenCount).toBe(0);
		expect(view.expanded).toBe(true);
	});

	it("scales past fifty memories in one category", () => {
		const view = buildMemoryCategoryView({
			category: "about_you",
			items: manyItems(57, "about_you"),
		});
		expect(view.total).toBe(57);
		expect(view.visible).toHaveLength(5);
		expect(view.hiddenCount).toBe(52);
	});

	it("keeps the total honest while a filter narrows the matches", () => {
		const items = [
			item("a", "Keeps files in Nextcloud.", "2026-01-03T00:00:00.000Z"),
			item("b", "Photos live in Immich.", "2026-01-02T00:00:00.000Z"),
			item("c", "Nextcloud folders are audited.", "2026-01-01T00:00:00.000Z"),
		];
		const view = buildMemoryCategoryView({
			category: "about_you",
			items,
			filterText: "nextcloud",
		});
		// "2 of 3 match" — the heading must not show 2 as if it were the total.
		expect(view.total).toBe(3);
		expect(view.matching).toBe(2);
		expect(view.filtered).toBe(true);
		expect(view.visible.map((entry) => entry.id)).toEqual(["a", "c"]);
	});

	it("reports no hidden rows when a filter leaves fewer than a page", () => {
		const view = buildMemoryCategoryView({
			category: "about_you",
			items: manyItems(23, "about_you"),
			filterText: "number 1",
		});
		expect(view.matching).toBeGreaterThan(0);
		expect(view.matching).toBeLessThanOrEqual(23);
		expect(view.hiddenCount).toBe(Math.max(0, view.matching - 5));
	});

	it("draws the newest memories on the unexpanded page", () => {
		const view = buildMemoryCategoryView({
			category: "about_you",
			items: [
				item("old", "old", "2026-01-01T00:00:00.000Z"),
				item("new", "new", "2026-06-01T00:00:00.000Z"),
			],
			pageSize: 1,
		});
		expect(view.visible.map((entry) => entry.id)).toEqual(["new"]);
		expect(view.hiddenCount).toBe(1);
	});
});

describe("buildMemoryCategoryViews", () => {
	it("returns every category in the given order", () => {
		const views = buildMemoryCategoryViews({
			profile: profile({
				about_you: 23,
				preferences: 14,
				goals_ongoing_work: 9,
				constraints_boundaries: 6,
			}),
			order: ORDER,
		});
		expect(views.map((view) => view.category)).toEqual(ORDER);
		expect(views.map((view) => view.total)).toEqual([23, 14, 9, 6]);
		expect(views.every((view) => view.visible.length <= 5)).toBe(true);
	});

	it("narrows to one category when a chip is picked", () => {
		const views = buildMemoryCategoryViews({
			profile: profile({ about_you: 23, preferences: 14 }),
			order: ORDER,
			selection: "preferences",
		});
		expect(views).toHaveLength(1);
		expect(views[0].category).toBe("preferences");
		expect(views[0].total).toBe(14);
	});

	it("expands only the categories asked for, leaving the others paged", () => {
		const views = buildMemoryCategoryViews({
			profile: profile({ about_you: 23, preferences: 14 }),
			order: ORDER,
			expanded: new Set<MemoryProfileCategory>(["about_you"]),
		});
		const about = views.find((view) => view.category === "about_you");
		const prefs = views.find((view) => view.category === "preferences");
		expect(about?.visible).toHaveLength(23);
		expect(prefs?.visible).toHaveLength(5);
	});

	it("survives a missing profile", () => {
		const views = buildMemoryCategoryViews({ profile: null, order: ORDER });
		expect(views).toHaveLength(4);
		expect(views.every((view) => view.total === 0)).toBe(true);
		expect(views.every((view) => view.hiddenCount === 0)).toBe(true);
	});
});

describe("buildMemoryFilterChips", () => {
	it("leads with All carrying the grand total", () => {
		const chips = buildMemoryFilterChips({
			profile: profile({
				about_you: 23,
				preferences: 14,
				goals_ongoing_work: 9,
				constraints_boundaries: 6,
			}),
			order: ORDER,
		});
		expect(chips[0].id).toBe("all");
		expect(chips[0].total).toBe(52);
		expect(chips.slice(1).map((chip) => chip.total)).toEqual([23, 14, 9, 6]);
	});

	it("keeps chip totals fixed while the filter moves the match counts", () => {
		const built = profile({ about_you: 23, preferences: 14 });
		const chips = buildMemoryFilterChips({
			profile: built,
			order: ORDER,
			filterText: "preferences memory number 3",
		});
		const preferences = chips.find((chip) => chip.id === "preferences");
		const about = chips.find((chip) => chip.id === "about_you");
		expect(preferences?.total).toBe(14);
		expect(preferences?.matching).toBe(1);
		expect(about?.total).toBe(23);
		expect(about?.matching).toBe(0);
		expect(chips[0].matching).toBe(1);
	});

	it("sums the per-category matches into All", () => {
		const chips = buildMemoryFilterChips({
			profile: profile({ about_you: 4, preferences: 3 }),
			order: ORDER,
			filterText: "memory number",
		});
		const perCategory = chips
			.slice(1)
			.reduce((sum, chip) => sum + chip.matching, 0);
		expect(chips[0].matching).toBe(perCategory);
	});
});

describe("countActiveMemories", () => {
	it("counts every category", () => {
		expect(
			countActiveMemories(
				profile({
					about_you: 23,
					preferences: 14,
					goals_ongoing_work: 9,
					constraints_boundaries: 6,
				}),
			),
		).toBe(52);
	});

	it("is zero without a profile", () => {
		expect(countActiveMemories(null)).toBe(0);
	});
});

describe("toggleExpandedCategory", () => {
	it("opens a closed category and closes an open one", () => {
		const opened = toggleExpandedCategory(
			new Set<MemoryProfileCategory>(),
			"about_you",
		);
		expect(opened.has("about_you")).toBe(true);
		const closed = toggleExpandedCategory(opened, "about_you");
		expect(closed.has("about_you")).toBe(false);
	});

	it("leaves the other categories where they were", () => {
		const next = toggleExpandedCategory(
			new Set<MemoryProfileCategory>(["preferences"]),
			"about_you",
		);
		expect(next.has("preferences")).toBe(true);
		expect(next.has("about_you")).toBe(true);
	});

	it("does not mutate the set it is given", () => {
		const original = new Set<MemoryProfileCategory>(["preferences"]);
		toggleExpandedCategory(original, "about_you");
		expect(original.has("about_you")).toBe(false);
	});
});
