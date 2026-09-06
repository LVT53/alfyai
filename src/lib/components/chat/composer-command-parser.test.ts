import { describe, expect, it } from "vitest";
import {
	findActiveComposerCommandToken,
	findActiveComposerCommandTokenWithArgument,
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
		expect(findActiveComposerCommandToken("/doc", 4)).toMatchObject({
			prefix: "/",
			query: "doc",
			start: 0,
			end: 4,
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

	// Reviewer report — "I want /remember to be a feature" opened the tray and
	// Enter saved a memory note instead of sending the sentence. A slash only
	// starts a command when it is the first non-whitespace character typed.
	it("ignores a slash command typed mid-sentence", () => {
		const text = "I want /remember to be a feature";

		expect(
			findActiveComposerCommandToken(text, "I want /remember".length),
		).toBeNull();
		expect(
			findActiveComposerCommandTokenWithArgument(text, text.length, [
				"remember",
			]),
		).toBeNull();
		expect(
			replaceActiveComposerCommandToken(text, "I want /remember".length, ""),
		).toBeNull();
		expect(findActiveComposerCommandToken("Summarize /doc", 14)).toBeNull();
	});

	it("still recognizes a slash command that opens the composer text", () => {
		expect(findActiveComposerCommandToken("   /remember", 12)).toMatchObject({
			prefix: "/",
			query: "remember",
			start: 3,
			end: 12,
		});
		expect(
			findActiveComposerCommandTokenWithArgument("  /remember oat milk", 20, [
				"remember",
			]),
		).toMatchObject({
			command: "remember",
			argument: "oat milk",
			start: 2,
		});
	});

	// `$` skill mentions are meant to be dropped mid-sentence, so the new
	// leading-slash rule must not touch them.
	it("still recognizes a $ skill token typed mid-sentence", () => {
		expect(findActiveComposerCommandToken("Use $interview", 14)).toMatchObject({
			prefix: "$",
			query: "interview",
			start: 4,
		});
	});

	it("replaces only the active command token and preserves surrounding text", () => {
		const result = replaceActiveComposerCommandToken("/model this", 6, "");

		expect(result).toEqual({
			text: " this",
			cursor: 0,
		});
	});

	it("replaces the full active command token when the cursor is inside it", () => {
		const slashResult = replaceActiveComposerCommandToken(
			"/document now",
			4,
			"",
		);
		const dollarResult = replaceActiveComposerCommandToken(
			"Use $interview today",
			8,
			"",
		);

		expect(findActiveComposerCommandToken("/document now", 4)).toMatchObject({
			prefix: "/",
			query: "doc",
			start: 0,
			end: 9,
			token: "/document",
		});
		expect(slashResult).toEqual({
			text: " now",
			cursor: 0,
		});
		expect(dollarResult).toEqual({
			text: "Use  today",
			cursor: 4,
		});
	});
});

describe("findActiveComposerCommandTokenWithArgument", () => {
	const commandIds = ["document", "remember"];

	it("captures free text typed after a bare command name as the argument", () => {
		const text = "/remember I love oat milk";
		expect(
			findActiveComposerCommandTokenWithArgument(text, text.length, commandIds),
		).toMatchObject({
			prefix: "/",
			command: "remember",
			argument: "I love oat milk",
			start: 0,
			end: text.length,
			token: text,
		});
	});

	it("has no argument yet while only the command name has been typed", () => {
		const text = "/document";
		expect(
			findActiveComposerCommandTokenWithArgument(text, text.length, commandIds),
		).toMatchObject({
			command: "document",
			argument: undefined,
			query: "document",
		});
	});

	it("trims the captured argument and drops it when it is only whitespace", () => {
		const blank = "/document   ";
		expect(
			findActiveComposerCommandTokenWithArgument(
				blank,
				blank.length,
				commandIds,
			),
		).toMatchObject({
			command: "document",
			argument: undefined,
		});
		const withArgument = "/document  quarterly report  ";
		expect(
			findActiveComposerCommandTokenWithArgument(
				withArgument,
				withArgument.length,
				commandIds,
			),
		).toMatchObject({
			command: "document",
			argument: "quarterly report",
		});
	});

	it("does not match a command id outside the provided list", () => {
		const text = "/model gpt-5";
		expect(
			findActiveComposerCommandTokenWithArgument(text, text.length, commandIds),
		).toBeNull();
	});

	it("only matches a token anchored at the start of the composer text", () => {
		const text = "literal/document now";
		expect(
			findActiveComposerCommandTokenWithArgument(
				text,
				text.indexOf(" now"),
				commandIds,
			),
		).toBeNull();
	});

	it("ignores a command name that is really a URL or path segment", () => {
		for (const text of [
			"https://example.com/document quarterly",
			"see /document/archive quarterly",
			"~/document notes",
		]) {
			expect(
				findActiveComposerCommandTokenWithArgument(
					text,
					text.length,
					commandIds,
				),
				text,
			).toBeNull();
		}
	});

	it("returns null when no command id is configured to take an argument", () => {
		expect(
			findActiveComposerCommandTokenWithArgument("/document search", 16, []),
		).toBeNull();
	});
});
