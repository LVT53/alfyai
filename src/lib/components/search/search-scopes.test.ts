import { describe, expect, it } from "vitest";
import {
	buildSearchScopeChips,
	formatScopeCount,
	resolveActiveScope,
	rowMatchesScope,
	SEARCH_SCOPE_ORDER,
	summariseTotals,
} from "./search-scopes";

const totals = (
	overrides: Partial<{
		chats: number;
		memory: number;
		documents: number;
		media: number;
		apps: number;
	}> = {},
) => ({ chats: 0, memory: 0, documents: 0, media: 0, apps: 0, ...overrides });

describe("the scope chips", () => {
	it("are All, Chats, Memory, Documents, Pictures & videos and Apps, in that order", () => {
		expect(SEARCH_SCOPE_ORDER).toEqual([
			"all",
			"chats",
			"memory",
			"documents",
			"media",
			"apps",
		]);
		expect(
			buildSearchScopeChips(totals(), true).map((chip) => chip.id),
		).toEqual(["all", "chats", "memory", "documents", "media", "apps"]);
	});

	it("carry the server's count of each kind", () => {
		const chips = buildSearchScopeChips(
			totals({ chats: 2, memory: 3, documents: 5, media: 2, apps: 1 }),
			true,
		);
		expect(
			Object.fromEntries(chips.map((chip) => [chip.id, chip.count])),
		).toEqual({
			all: 13,
			chats: 2,
			memory: 3,
			documents: 5,
			media: 2,
			apps: 1,
		});
	});

	it("make All the sum of the kinds", () => {
		expect(
			buildSearchScopeChips(totals({ chats: 40, documents: 7 }), true)[0],
		).toEqual({ id: "all", count: 47 });
	});

	it("hide the Memory chip when memory is not searchable", () => {
		const chips = buildSearchScopeChips(totals({ chats: 1, memory: 0 }), false);
		expect(chips.map((chip) => chip.id)).toEqual([
			"all",
			"chats",
			"documents",
			"media",
			"apps",
		]);
		// And what memory holds is never added to All.
		expect(chips[0].count).toBe(1);
	});

	it("never include Connections or Reports", () => {
		const ids = buildSearchScopeChips(totals(), true).map((chip) => chip.id);
		expect(ids).not.toContain("connections");
		expect(ids).not.toContain("reports");
	});

	it("show 99+ at the cap and the number below it", () => {
		expect(formatScopeCount(0)).toBe("0");
		expect(formatScopeCount(99)).toBe("99");
		expect(formatScopeCount(100)).toBe("99+");
		expect(formatScopeCount(412)).toBe("99+");
	});
});

describe("resolveActiveScope", () => {
	const chips = buildSearchScopeChips(totals({ chats: 4, memory: 0 }), true);

	it("keeps a picked scope that has something in it", () => {
		expect(resolveActiveScope("chats", chips)).toBe("chats");
		expect(resolveActiveScope("all", chips)).toBe("all");
	});

	it("falls back to All for a scope that has nothing, or is not a chip any more", () => {
		expect(resolveActiveScope("memory", chips)).toBe("all");
		expect(
			resolveActiveScope("memory", buildSearchScopeChips(totals(), false)),
		).toBe("all");
	});
});

describe("rowMatchesScope", () => {
	const chat = { id: "c", kind: "conversation" } as const;
	const memory = { id: "m", kind: "memory" } as const;
	const doc = { id: "d", kind: "document", searchKind: "documents" } as const;
	const picture = { id: "p", kind: "document", searchKind: "media" } as const;
	const app = { id: "a", kind: "document", searchKind: "apps" } as const;

	it("sorts each row by its own kind", () => {
		const scopesOf = (row: Parameters<typeof rowMatchesScope>[0]) =>
			SEARCH_SCOPE_ORDER.filter((scope) => rowMatchesScope(row, scope));
		expect(scopesOf(chat)).toEqual(["all", "chats"]);
		expect(scopesOf(memory)).toEqual(["all", "memory"]);
		expect(scopesOf(doc)).toEqual(["all", "documents"]);
		expect(scopesOf(picture)).toEqual(["all", "media"]);
		expect(scopesOf(app)).toEqual(["all", "apps"]);
	});
});

describe("summariseTotals", () => {
	it("adds the kinds up and counts the kinds that hold something", () => {
		expect(
			summariseTotals(totals({ chats: 2, memory: 3, documents: 5, apps: 1 })),
		).toEqual({ results: 11, kinds: 4, capped: false });
		expect(summariseTotals(totals())).toEqual({
			results: 0,
			kinds: 0,
			capped: false,
		});
	});

	it("says when a kind's count stopped at the cap", () => {
		expect(summariseTotals(totals({ chats: 100, documents: 3 }))).toEqual({
			results: 103,
			kinds: 2,
			capped: true,
		});
	});
});
