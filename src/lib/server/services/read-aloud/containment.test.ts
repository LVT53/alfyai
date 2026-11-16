import { describe, expect, it } from "vitest";
import { speakWord, type WordKind } from "$lib/shared/read-aloud/spoken-forms";
import {
	type CheckedWord,
	letterKey,
	replyKey,
	wordsFitReply,
} from "./containment";

const said = (
	shown: string,
	kind: WordKind = "prose",
	language: "en" | "hu" = "en",
): CheckedWord => ({ shown, kind, tokens: speakWord(shown, kind, language) });
const en = (...words: CheckedWord[]) => ({ language: "en" as const, words });

describe("the containment check", () => {
	it("accepts what the browser reads from a reply with links, images, entities, inline code and a bare address", () => {
		const md =
			"See [the docs](https://example.com/a_(b)) now. ![a cat](cat.png) Salt &amp; pepper, `getUserName()` and **bold**. Visit https://www.example.com/x today.";
		expect(
			wordsFitReply(md, [
				en(said("See"), said("the"), said("docs"), said("now.")),
				en(
					said("Salt"),
					said("pepper,"),
					said("getUserName()", "code"),
					said("and"),
					said("bold."),
				),
				en(said("Visit"), said("https://www.example.com/x"), said("today.")),
			]),
		).toBeNull();
	});

	it("steps over a formula, emoji or spaced number inside a sentence", () => {
		expect(
			wordsFitReply("The area is $\\pi r^2$ for a circle.", [
				en(
					said("The"),
					said("area"),
					said("is"),
					said("for"),
					said("a"),
					said("circle."),
				),
			]),
		).toBeNull();
		const hu = ["A", "jegy", "ára", "12", "990", "Ft."].map((w) =>
			said(w, "prose", "hu"),
		);
		expect(
			wordsFitReply("A jegy ára 12 990 Ft 🎟️.", [{ language: "hu", words: hu }]),
		).toBeNull();
	});

	it("accepts list numbers that the Markdown writes differently", () =>
		expect(
			wordsFitReply("1. Flour\n1. Water", [
				en(said("1.", "listNumber"), said("Flour")),
				en(said("2.", "listNumber"), said("Water")),
			]),
		).toBeNull());

	it("refuses tokens the dictionary does not make", () =>
		expect(
			wordsFitReply("Use `a.b` here.", [
				en({ shown: "a.b", kind: "code", tokens: ["free", "speech"] }),
			]),
		).toBe(0));

	it("names the first sentence that is not in the reply", () =>
		expect(
			wordsFitReply("One two three.", [
				en(said("One"), said("two")),
				en(said("Free"), said("speech")),
			]),
		).toBe(1));

	it("refuses words out of order", () =>
		expect(
			wordsFitReply("Alpha beta. Gamma delta.", [
				en(said("Gamma"), said("delta.")),
				en(said("Alpha"), said("beta.")),
			]),
		).toBe(1));

	it("refuses a word that is only found before the previous one", () =>
		expect(wordsFitReply("Alpha beta", [en(said("beta"), said("Alpha"))])).toBe(
			0,
		));

	it("ignores the pause marks the script adds to a token", () =>
		expect(
			wordsFitReply("Flour, water and salt.", [
				en(
					{ shown: "Flour,", kind: "prose", tokens: ["Flour,"] },
					{ shown: "water", kind: "prose", tokens: ["water."] },
					said("and"),
					{ shown: "salt.", kind: "prose", tokens: ["salt,"] },
				),
			]),
		).toBeNull());

	it("refuses a list number that is not a list number", () => {
		for (const shown of ["1.2.", "x.", "12345.", "1"])
			expect(
				wordsFitReply("1. Flour", [
					en({ shown, kind: "listNumber", tokens: ["One."] }),
				]),
				shown,
			).toBe(0);
	});

	it("reads the numeric and named entities of the reply", () =>
		expect(
			wordsFitReply("Caf&#233; &#x41;u&nbsp;lait &lt;3", [
				en(said("Café"), said("Au"), said("lait"), said("3")),
			]),
		).toBeNull());

	it("reads every named entity the browser draws, not only the common few", () => {
		const cases: Array<[markdown: string, written: string[]]> = [
			["Ten 10&ndash;20 now", ["Ten", "10–20", "now"]],
			["A caf&eacute; here", ["A", "café", "here"]],
			["word&mdash;word", ["word—word"]],
			["3&times;4 and 20&deg;C", ["3×4", "and", "20°C"]],
			// 128 to 159 are Windows-1252 in a browser: 156 is "œ".
			["c&#156;ur", ["cœur"]],
		];
		for (const [markdown, written] of cases)
			expect(
				wordsFitReply(markdown, [en(...written.map((w) => said(w)))]),
				markdown,
			).toBeNull();
	});

	it("counts a word with no letters as found", () =>
		expect(
			wordsFitReply("Alpha beta", [en(said("Alpha"), said("—"), said("beta"))]),
		).toBeNull());

	it("takes a code block's or a table's words, which the source holds", () =>
		expect(
			wordsFitReply("Text.\n\n```py\ntotal = price * 2\n```\n", [
				en(
					said("total", "code"),
					said("=", "code"),
					said("price", "code"),
					said("*", "code"),
					said("2", "code"),
				),
			]),
		).toBeNull());
});

describe("letter keys", () => {
	it("keeps letters and digits, lower-cased and normalised", () => {
		expect(letterKey("Ｆull-Width １２!")).toBe("fullwidth12");
		expect(letterKey("Árvíztűrő, tükörfúrógép")).toBe("árvíztűrőtükörfúrógép");
		expect(letterKey("  — … ")).toBe("");
	});

	it("decodes entities before it keys the reply, as the browser does", () => {
		expect(replyKey("Salt &amp; pepper &#33; &nbsp;")).toBe("saltpepper");
		// An entity the browser does not know stays as text; a number that is no
		// character becomes the replacement character, which is no letter.
		expect(replyKey("&unknown; &#99999999;")).toBe("unknown");
	});
});
