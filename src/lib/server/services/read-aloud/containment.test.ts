import { describe, expect, it } from "vitest";
import { speakWord, type WordKind } from "$lib/shared/read-aloud/spoken-forms";
import {
	type CheckedWord,
	letterKey,
	replyKey,
	reportKey,
	wordsFitReply,
	wordsFitReport,
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

	it("accepts the pauses the script makes of dashes and brackets, which are marks and no letters", () => {
		const md =
			"Then \u2014 and this is key \u2014 fold in the eggs (one at a time) and stir\u2014gently.";
		// What the script sends: a comma after the word before each dash, the brackets not said, a
		// comma after the one that closes them, and the word an em dash is inside split in two.
		const sent = (shown: string, ...tokens: string[]): CheckedWord => ({
			shown,
			kind: "prose",
			tokens,
		});
		expect(
			wordsFitReply(md, [
				en(
					sent("Then", "Then,"),
					sent("and", "and"),
					sent("this", "this"),
					sent("is", "is"),
					sent("key", "key,"),
					sent("fold", "fold"),
					sent("in", "in"),
					sent("the", "the"),
					sent("eggs", "eggs,"),
					sent("(one", "one"),
					sent("at", "at"),
					sent("a", "a"),
					sent("time)", "time,"),
					sent("and", "and"),
					sent("stir\u2014gently.", "stir,", "gently."),
				),
			]),
		).toBeNull();
		// A word that is not in the reply still fails, whatever marks come with it.
		expect(wordsFitReply(md, [en(sent("village,", "village,"))])).toBe(0);
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

	it("accepts simple math read from the reply's TeX, and refuses math it does not say", () => {
		const markdown =
			"It wouldn't read this at all: \\(€4{,}341.0505 \\times 0.88 = €3{,}820.12444\\)";
		const sum = "(€4{,}341.0505 \\times 0.88 = €3{,}820.12444)";
		const words = ["It", "wouldn't", "read", "this", "at", "all:"].map((w) =>
			said(w),
		);
		expect(
			wordsFitReply(markdown, [en(...words, said(sum, "math"))]),
		).toBeNull();
		// Its tokens must be the dictionary's reading of it.
		expect(
			wordsFitReply(markdown, [
				en(...words, { shown: sum, kind: "math", tokens: ["one", "million"] }),
			]),
		).toBe(0);
		// And its letters must be in the reply.
		expect(
			wordsFitReply("No sums here.", [en(said("(2 \\times 3 = 6)", "math"))]),
		).toBe(0);
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

	it("steps over the tags, comments and link destinations that sit inside a word", () => {
		const cases: Array<[markdown: string, written: string[], language?: "hu"]> =
			[
				[
					"Press <kbd>Ctrl</kbd>+<kbd>C</kbd> now.",
					["Press", "Ctrl+C", "now."],
				],
				["Water is H<sub>2</sub>O.", ["Water", "is", "H2O."]],
				["It is x<sup>2</sup> here.", ["It", "is", "x2", "here."]],
				["A foo<!-- hidden -->bar word.", ["A", "foobar", "word."]],
				[
					"See the [README](docs/README.md)-ben.",
					["See", "the", "README-ben."],
					"hu",
				],
				[
					"See [the docs](https://example.com/a_(b))s now.",
					["See", "the", "docss", "now."],
				],
			];
		for (const [markdown, written, language] of cases)
			expect(
				wordsFitReply(markdown, [
					{
						language: language ?? "en",
						words: written.map((w) => said(w, "prose", language ?? "en")),
					},
				]),
				markdown,
			).toBeNull();
	});

	it("keeps the tags that code shows as written, and the ones an entity makes text", () => {
		// Inline code and a fenced block show `<div>` as it is.
		expect(
			wordsFitReply("Use `<div>` here.", [
				en(said("Use"), said("<div>", "code"), said("here.")),
			]),
		).toBeNull();
		expect(
			wordsFitReply('Text.\n\n```html\n<div class="x">\n```\n', [
				en(said("<div", "code")),
			]),
		).toBeNull();
		// "&lt;kbd&gt;" is the letters kbd on the screen, not a tag.
		expect(
			wordsFitReply("Write &lt;kbd&gt; for a key.", [
				en(said("Write"), said("<kbd>"), said("for")),
			]),
		).toBeNull();
	});

	it("looks for an address by the host it is spoken as, wherever the reply names it", () => {
		// "(bbc.com)" becomes a source chip whose address is the one given before.
		const chip = {
			shown: "https://www.bbc.com",
			kind: "prose" as const,
			tokens: speakWord("https://www.bbc.com", "prose", "en"),
		};
		expect(
			wordsFitReply(
				"Source: https://www.bbc.com/news/x is good. As reported (bbc.com) it holds.",
				[
					en(
						said("Source:"),
						said("https://www.bbc.com/news/x"),
						said("is"),
						said("good."),
						said("As"),
						said("reported"),
						chip,
						said("it"),
						said("holds."),
					),
				],
			),
		).toBeNull();
		// Credentials and a port in the address are not spoken, so are not searched.
		expect(
			wordsFitReply("Go to https://user:pw@example.com/x now.", [
				en(
					said("Go"),
					said("to"),
					said("https://user:pw@example.com/x"),
					said("now."),
				),
			]),
		).toBeNull();
		// An address whose host the reply never names is still refused.
		expect(
			wordsFitReply("Go to example.org now.", [
				en(said("Go"), said("to"), said("https://evil.test/")),
			]),
		).toBe(0);
	});

	it("does not let a code word speak what the reply does not say beside its address", () => {
		// A code word speaks the names around its address too: "Free Speech Here
		// example dot com". Only a prose word is spoken as its host alone.
		const reply = "Open https://example.com in your browser.";
		for (const [shown, kind] of [
			["FreeSpeechHere(https://example.com)", "code"],
			["Nothing_in_the_reply.https://example.com/x", "code"],
			["FreeSpeechHere(https://example.com)", "shell"],
		] as const)
			expect(
				wordsFitReply(reply, [
					en({ shown, kind, tokens: speakWord(shown, kind, "en") }),
				]),
				`${kind}: ${shown}`,
			).toBe(0);
		// A code word that is only the address shows it whole on the screen: accepted.
		expect(
			wordsFitReply("Call `https://example.com/api` now.", [
				en(said("Call"), said("https://example.com/api", "code"), said("now.")),
			]),
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

// A standard report is HTML the app's own renderer made, every `<` of its text
// escaped: the words read from the page's copy must be in what its markup shows.
describe("the containment check for a report", () => {
	const REPORT = `<!doctype html><html><head><title>Weekend report</title><style>.report-content{font-family:Garamondish}</style></head><body><article id="report-content"><h1>Weekend report</h1><p>The train leaves at nine &amp; arrives at noon<button class="basis-marker" data-note="Secretword"><span class="basis-tooltip">Supported claim</span></button> from the main station.</p><p>H<sub>2</sub>O is water.</p><!-- Hiddencomment --><img alt="" src="data:image/png;base64,QWxwaGFiZXRzb3VwWnp6"></article><script>const greeting = "Scriptword";</script></body></html>`;

	it("accepts the words the report shows, its entities decoded, across inline markup", () => {
		expect(
			wordsFitReport(REPORT, [
				en(said("Weekend"), said("report")),
				en(
					said("The"),
					said("train"),
					said("leaves"),
					said("at"),
					said("nine"),
					said("arrives"),
					said("at"),
					said("noon"),
					said("from"),
					said("the"),
					said("main"),
					said("station."),
				),
				en(said("H2O"), said("is"), said("water.")),
			]),
		).toBeNull();
	});

	it("refuses words found only in its scripts, styles, comments, attributes or pictures", () => {
		for (const word of [
			"Scriptword",
			"Garamondish",
			"Hiddencomment",
			"Secretword",
			"basis",
			"QWxwaGFiZXRzb3VwWnp6",
		])
			expect(wordsFitReport(REPORT, [en(said(word))]), word).toBe(0);
	});

	it("refuses made-up words, and words out of order", () => {
		expect(
			wordsFitReport(REPORT, [en(said("The"), said("plane"), said("leaves."))]),
		).toBe(0);
		expect(
			wordsFitReport(REPORT, [
				en(said("water.")),
				en(said("The"), said("train.")),
			]),
		).toBe(1);
	});

	it("keys what the markup shows: tags, comments, scripts and styles out, entities decoded", () => {
		expect(
			reportKey(
				'<p>Salt &amp; <b>pep</b>per<!-- x --></p><style>p{}</style><script>y()</script><p data-z="q">H<sub>2</sub>O</p>',
			),
		).toBe("saltpepperh2o");
	});
});
