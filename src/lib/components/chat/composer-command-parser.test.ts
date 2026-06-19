import { describe, expect, it } from "vitest";
import {
	findActiveComposerCommandToken,
	replaceActiveComposerCommandToken,
} from "./composer-command-parser";

describe("composer command parser", () => {
	it("recognizes only active slash or dollar tokens at the cursor", () => {
		expect(findActiveComposerCommandToken("/", 1)).toMatchObject({
			prefix: "/",
			query: "",
			start: 0,
			end: 1,
		});
		expect(findActiveComposerCommandToken("Summarize /doc", 14)).toMatchObject({
			prefix: "/",
			query: "doc",
			start: 10,
			end: 14,
		});
		expect(findActiveComposerCommandToken("Use $", 5)).toMatchObject({
			prefix: "$",
			query: "",
			start: 4,
			end: 5,
		});

		expect(
			findActiveComposerCommandToken("https://example.com/a", 9),
		).toBeNull();
		expect(findActiveComposerCommandToken("It costs $12", 12)).toBeNull();
		expect(findActiveComposerCommandToken("literal/path", 12)).toBeNull();
		expect(
			findActiveComposerCommandToken("mention /model here", 19),
		).toBeNull();
	});

	it("replaces only the active command token and preserves surrounding text", () => {
		const result = replaceActiveComposerCommandToken(
			"Please /model this",
			13,
			"",
		);

		expect(result).toEqual({
			text: "Please  this",
			cursor: 7,
		});
	});

	it("replaces the full active command token when the cursor is inside it", () => {
		const slashResult = replaceActiveComposerCommandToken(
			"Please /document now",
			11,
			"",
		);
		const dollarResult = replaceActiveComposerCommandToken(
			"Use $interview today",
			8,
			"",
		);

		expect(
			findActiveComposerCommandToken("Please /document now", 11),
		).toMatchObject({
			prefix: "/",
			query: "doc",
			start: 7,
			end: 16,
			token: "/document",
		});
		expect(slashResult).toEqual({
			text: "Please  now",
			cursor: 7,
		});
		expect(dollarResult).toEqual({
			text: "Use  today",
			cursor: 4,
		});
	});
});
