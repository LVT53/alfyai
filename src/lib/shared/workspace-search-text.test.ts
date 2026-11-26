import { describe, expect, it } from "vitest";
import {
	foldForSearch,
	matchesAllTerms,
	matchRanges,
	SEARCH_MAX_TERMS,
	SEARCH_MIN_QUERY_CHARS,
	searchSnippet,
	searchTerms,
	typedSearchWords,
} from "./workspace-search-text";

describe("workspace search text", () => {
	it("names the two limits the query rules rest on", () => {
		expect(SEARCH_MIN_QUERY_CHARS).toBe(2);
		expect(SEARCH_MAX_TERMS).toBe(8);
	});

	it("folds case and accents", () => {
		expect(foldForSearch("ÁRVÍZTŰRŐ Tükörfúrógép")).toBe(
			"arvizturo tukorfurogep",
		);
		expect(
			matchesAllTerms("Árvíztűrő tükörfúrógép", searchTerms("arviz")),
		).toBe(true);
		expect(
			matchesAllTerms("Árvíztűrő tükörfúrógép", searchTerms("ÁRVÍZ")),
		).toBe(true);
	});

	it("folds an accent written as a separate mark the same way", () => {
		expect(foldForSearch("Árvíz")).toBe("arviz");
		expect(foldForSearch("İstanbul")).toBe("istanbul");
	});

	it("takes words in any order and inside longer words", () => {
		expect(
			matchesAllTerms("Plan for the kitchen", searchTerms("kitchen plan")),
		).toBe(true);
		expect(
			matchesAllTerms("szállásajánlatok a projektben", searchTerms("ajánlat")),
		).toBe(true);
		expect(
			matchesAllTerms("Plan for the kitchen", searchTerms("kitchen budget")),
		).toBe(false);
	});

	it("splits a query into at most eight clean words", () => {
		expect(searchTerms('  "Kitchen,"  plan!  plan  ')).toEqual([
			"kitchen",
			"plan",
		]);
		expect(searchTerms("e-mail 1:50")).toEqual(["e-mail", "1:50"]);
		expect(searchTerms("a b c d e f g h i j")).toHaveLength(8);
		expect(searchTerms("!!")).toEqual([]);
		expect(matchesAllTerms("anything", [])).toBe(false);
		expect(typedSearchWords('"ÁRVÍZ" kitchen árvíz arviz')).toEqual([
			"árvíz",
			"kitchen",
		]);
	});

	it("keeps the # and + that end a language's name", () => {
		expect(searchTerms("C# C++ F#")).toEqual(["c#", "c++", "f#"]);
		expect(searchTerms("c++, and c#!")).toEqual(["c++", "and", "c#"]);
		expect(typedSearchWords("C#")).toEqual(["c#"]);
		expect(matchesAllTerms("I write C# daily", searchTerms("c#"))).toBe(true);
		// Only after a letter or digit: alone they are still punctuation.
		expect(searchTerms("+++ ### #tag")).toEqual(["tag"]);
		expect(searchTerms('"Kitchen,"')).toEqual(["kitchen"]);
	});

	it("drops control characters from the words", () => {
		expect(searchTerms("gar\u0000den\u0007 kit\u001bchen")).toEqual([
			"garden",
			"kitchen",
		]);
		expect(typedSearchWords("Gar\u0000den")).toEqual(["garden"]);
		expect(searchTerms("\u0000\u0001")).toEqual([]);
	});

	it("cuts each word to 64 characters", () => {
		const [term] = searchTerms("x".repeat(100));
		expect(term).toHaveLength(64);
		const [typed] = typedSearchWords("Á".repeat(100));
		expect(Array.from(typed)).toHaveLength(64);
	});

	it("keeps each typed word beside the folded word it belongs to", () => {
		const query = '  "ÁRVÍZ"  Kitchen, árvíz  e-mail  ';
		const terms = searchTerms(query);
		const words = typedSearchWords(query);
		expect(words).toEqual(["árvíz", "kitchen", "e-mail"]);
		expect(terms).toEqual(["arviz", "kitchen", "e-mail"]);
		expect(words.map(foldForSearch)).toEqual(terms);
	});

	it("returns ranges of the original text for every word", () => {
		expect(matchRanges("Árvíz and the árvíz", searchTerms("arviz"))).toEqual([
			{ start: 0, end: 5 },
			{ start: 14, end: 19 },
		]);
	});

	it("merges ranges that overlap or touch, in order", () => {
		expect(matchRanges("abc", ["ab", "bc"])).toEqual([{ start: 0, end: 3 }]);
		expect(matchRanges("arviz", ["viz", "ar"])).toEqual([{ start: 0, end: 5 }]);
		expect(matchRanges("x kitchen y plan z", ["plan", "kitchen"])).toEqual([
			{ start: 2, end: 9 },
			{ start: 12, end: 16 },
		]);
		expect(matchRanges("anything", [])).toEqual([]);
		expect(matchRanges("anything", ["nothing"])).toEqual([]);
	});

	it("keeps a letter's accent mark and a ligature inside its range", () => {
		expect(matchRanges("Árviz", ["a"])).toEqual([{ start: 0, end: 2 }]);
		expect(matchRanges("ﬁsh", ["fi"])).toEqual([{ start: 0, end: 1 }]);
	});

	it("cuts a snippet around the first match", () => {
		const text = `${"x ".repeat(200)}the thesis model ${"y ".repeat(200)}`;
		const snippet = searchSnippet(text, searchTerms("thesis"));
		expect(snippet).toContain("thesis");
		expect(snippet?.startsWith("…")).toBe(true);
		expect(snippet?.endsWith("…")).toBe(true);
		expect(snippet?.length).toBeLessThanOrEqual(162);
		expect(searchSnippet("nothing here", searchTerms("thesis"))).toBeNull();
	});

	it("folds whitespace in a snippet and returns a short text whole", () => {
		expect(searchSnippet("a\n\n  b \t thesis\n", ["thesis"])).toBe(
			"a b thesis",
		);
		expect(searchSnippet("Árvíz", searchTerms("arviz"))).toBe("Árvíz");
	});

	it("cuts to the width it is given, without the cut marks in the count", () => {
		const text = `${"x ".repeat(60)}needle ${"y ".repeat(60)}`;
		const snippet = searchSnippet(text, ["needle"], 40);
		expect(snippet).toContain("needle");
		expect(Array.from(snippet ?? "").length).toBeLessThanOrEqual(42);
		const atStart = searchSnippet(`needle ${"y ".repeat(60)}`, ["needle"], 40);
		expect(atStart?.startsWith("needle")).toBe(true);
		expect(atStart?.endsWith("…")).toBe(true);
	});

	it("never cuts a surrogate pair in half", () => {
		const text = `${"😀".repeat(100)}needle${"😀".repeat(100)}`;
		const snippet = searchSnippet(text, ["needle"], 41) ?? "";
		expect(snippet).toContain("needle");
		expect(snippet).not.toMatch(/(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/);
		expect(snippet).not.toMatch(/[\uD800-\uDBFF](?:$|[^\uDC00-\uDFFF])/);
	});
});
