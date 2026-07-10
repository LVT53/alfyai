import { describe, expect, it } from "vitest";
import {
	escapeHistoryLikeTerm,
	scoreHistoryText,
	tokenizeQuery,
} from "./query";

describe("memory-context query helpers", () => {
	it("lowercases, dedupes, drops short terms and stopwords", () => {
		expect(tokenizeQuery("What do you know about my BIKE bike setup")).toEqual([
			"bike",
			"setup",
		]);
	});

	it("keeps SQL wildcard characters as part of literal terms", () => {
		expect(tokenizeQuery("bike_%")).toEqual(["bike_%"]);
	});

	it("drops purely-symbolic low-signal queries", () => {
		expect(tokenizeQuery("what do you know about my % _ \\")).toEqual([]);
	});

	it("filters Hungarian stopwords", () => {
		expect(tokenizeQuery("mit tudsz a bicikliről")).toEqual(["bicikliről"]);
	});

	it("escapes LIKE wildcard and escape characters", () => {
		expect(escapeHistoryLikeTerm("bike_%\\x")).toBe("bike\\_\\%\\\\x");
	});

	it("scores by number of matched terms, 1 when no terms", () => {
		expect(scoreHistoryText(["bike", "setup"], "bike setup notes")).toBe(2);
		expect(scoreHistoryText(["bike", "car"], "bike notes")).toBe(1);
		expect(scoreHistoryText([], "anything")).toBe(1);
	});
});
