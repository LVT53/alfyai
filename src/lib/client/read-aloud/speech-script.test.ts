import { afterEach, describe, expect, it } from "vitest";
import {
	buildSpeechScript,
	CODE_BLOCK_MAX_LINES,
	LONG_SENTENCE_CHARS,
	type SpeechScript,
	sentenceAtPoint,
} from "./speech-script";

/** A stub detector keyed by what a paragraph says: nothing for no letters, Hungarian letters, German words, else English. */
const detect = (text: string) =>
	!/\p{L}/u.test(text)
		? ""
		: /[áéíóöőúüű]/i.test(text)
			? "hu"
			: /\b(der|die|das|und|ist|nicht)\b/i.test(text)
				? "de"
				: "en";

const escapeHtml = (text: string) =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** A reply shaped like MarkdownRenderer's output: the prose lane's wrapper inside `.markdown-container`. */
function reply(html: string, id = "m1"): HTMLElement {
	document.body.innerHTML = `<div data-message-id="${id}"><div class="markdown-container" aria-hidden="false"><div class="prose max-w-none markdown-html">${html}</div></div></div>`;
	return document.querySelector(".markdown-container") as HTMLElement;
}

/** A code block shaped like CodeBlock.svelte's, with Shiki's `pre code > span.line`. */
function codeBlock(language: string, lines: string[]): string {
	const body = lines
		.map(
			(line) =>
				`<span class="line">${line
					.split(/(\s+)/)
					.map((part) => `<span>${escapeHtml(part)}</span>`)
					.join("")}</span>`,
		)
		.join("\n");
	return `</div><div class=""><div class="code-block relative" data-language="${language}"><div class="code-header"><button type="button" class="code-toggle" aria-label="Collapse"><span class="chevron"><svg aria-hidden="true"></svg></span><span class="lowercase">${language || "code"}</span></button><button type="button" class="copy-button" aria-label="Copy code"><svg aria-hidden="true"></svg></button></div><div class="code-body"><div class="code-clip"><div class="code-content"><pre class="shiki github-light" tabindex="0"><code>${body}</code></pre></div></div></div></div></div><div class="prose max-w-none markdown-html">`;
}

/** A link as a chat reply draws it: a source chip whose label is the link's text, or the host of a bare address. */
const chip = (href: string, label: string) =>
	`<a href="${href}" class="source-link-chip" target="_blank"><span class="source-link-chip__favicon-wrap" aria-hidden="true"><span class="source-link-chip__favicon-fallback" aria-hidden="true"></span></span><span class="source-link-chip__label">${label}</span><span class="source-link-chip__icon" aria-hidden="true"></span></a>`;

const build = (
	root: Element,
	options: { fallbackLanguage?: "en" | "hu"; readBlock?: Element | null } = {},
) => buildSpeechScript([root], detect, { fallbackLanguage: "en", ...options });

const tokensOf = (script: SpeechScript) =>
	script.sentences.flatMap((s) => s.tokens);
const bare = (tokens: readonly string[]) =>
	tokens.join(" ").replace(/[.,;:!?…]/g, "");

afterEach(() => {
	document.body.innerHTML = "";
});

describe("buildSpeechScript", () => {
	it("reads paragraphs, headings, list items, checklist items and quotes in order", () => {
		const script = build(
			reply(
				'<h2>Making bread at home</h2><p>Bread needs flour, water, salt and a little patience.</p><ul><li>Use strong white flour for a good rise and a chewy crumb.</li></ul><blockquote><p>Patience is the secret ingredient in every good loaf of bread.</p></blockquote></div><div class="markdown-checklist-block"><ul class="markdown-checklist"><li class="markdown-checklist__row markdown-checklist__row--task"><input type="checkbox" class="markdown-checklist__box" disabled><div class="markdown-checklist__text">Preheat the oven to a high heat before the dough goes in.</div></li></ul></div><div>',
			),
		);
		expect(script.sentences.map((s) => s.text)).toEqual([
			"Making bread at home.",
			"Bread needs flour, water, salt and a little patience.",
			"Use strong white flour for a good rise and a chewy crumb.",
			"Patience is the secret ingredient in every good loaf of bread.",
			"Preheat the oven to a high heat before the dough goes in.",
		]);
		expect(
			script.sentences.map((s) => [
				s.id,
				s.index,
				s.language,
				s.paragraphStart,
			]),
		).toEqual([
			["s0", 0, "en", true],
			["s1", 1, "en", true],
			["s2", 2, "en", true],
			["s3", 3, "en", true],
			["s4", 4, "en", true],
		]);
		let charStart = 0;
		for (const sentence of script.sentences) {
			expect(sentence.text).toBe(sentence.tokens.join(" "));
			expect(sentence.chars).toBe(sentence.text.length + 1);
			expect(sentence.charStart).toBe(charStart);
			expect(sentence.ranges).toHaveLength(sentence.tokens.length);
			charStart += sentence.chars;
		}
		expect(script.totalChars).toBe(charStart);
		expect(script).toMatchObject({
			missingLanguage: null,
			nothingToRead: false,
		});
	});

	it("reads a code block of up to three lines the way a teacher says it", () => {
		const root = reply(
			`<p>Here is the sum in Python:</p>${codeBlock("python", ["total = price * 2", "print(total)"])}`,
		);
		const script = build(root);
		expect(bare(tokensOf(script))).toContain(
			"total equals price star two print total",
		);
		const code = script.sentences.find((s) => s.tokens[0] === "total");
		expect(code?.paragraphStart).toBe(true);
		expect(code?.words.every((w) => w.kind === "code")).toBe(true);
		expect(CODE_BLOCK_MAX_LINES).toBe(3);
	});

	it("leaves out a longer code block, tables, CSV, charts, Mermaid, images, front matter and picture chips", () => {
		const script = build(
			reply(
				`<p>Before the code.</p>${codeBlock("ts", ["const secretCode = 42;", "console.log(secretCode);", "export {};", "let a = 1;", "let b = 2;"])}<div class="markdown-table-wrap"><table class="markdown-table"><tbody><tr><td>TABLECELL</td></tr></tbody></table></div></div><div class="markdown-diagram-block"><div>CSVCELL</div></div><div class="prose markdown-html"><p><span class="markdown-image-frame"><img class="markdown-image" alt="ALTTEXT" src="x.png"></span> After the picture.</p><aside class="markdown-frontmatter" aria-label="Document metadata"><dl><dt>title</dt><dd>FRONTMATTER</dd></dl></aside><p>See <a href="https://example.com/cat.png" class="source-link-chip source-link-chip--image"><span class="source-link-chip__image-icon" aria-hidden="true"></span><span class="source-link-chip__label">CATPICTURE</span></a> here.</p><svg><text>SVGTEXT</text></svg>`,
			),
		);
		const tokens = tokensOf(script);
		expect(tokens.join(" ")).not.toMatch(
			/secret|TABLECELL|CSVCELL|ALTTEXT|FRONTMATTER|CATPICTURE|SVGTEXT/i,
		);
		expect(bare(tokens)).toBe("Before the code After the picture See here");
	});

	it("reads a long code block that Read from here starts in", () => {
		const root = reply(
			`<p>Before the code.</p>${codeBlock("ts", ["const secretCode = 42;", "console.log(secretCode);", "export {};", "let a = 1;", "let b = 2;"])}`,
		);
		const block = root.querySelector(".code-block");
		const script = build(root, { readBlock: block });
		expect(bare(tokensOf(script))).toContain(
			"const secret Code equals forty-two",
		);
		const lines = script.sentences.filter((s) =>
			s.words.every((w) => w.kind === "code"),
		);
		expect(lines.length).toBeGreaterThanOrEqual(4);
		expect(lines[0]?.paragraphStart).toBe(true);
		expect(lines.slice(1).every((s) => !s.paragraphStart)).toBe(true);
	});

	it("reads inline code the way a teacher says it, and marks the whole name", () => {
		const script = build(
			reply(
				"<p>Call <code>getUserName()</code>. Then use <code>=&gt;</code> and <code>{}</code> here.</p>",
			),
		);
		// Two short sentences of one paragraph are one unit (short-sentences.ts).
		expect(script.sentences.map((s) => s.tokens)).toEqual([
			["Call", "get", "User", "Name.", "Then", "use", "arrow", "and", "here."],
		]);
		const first = script.sentences[0];
		expect(first?.ranges[1]).toBe(first?.ranges[2]);
		expect(first?.ranges[2]).toBe(first?.ranges[3]);
		expect(first?.ranges[1]?.toString()).toBe("getUserName()");
		expect(first?.words[1]).toMatchObject({
			shown: "getUserName()",
			kind: "code",
			tokens: ["get", "User", "Name."],
		});
	});

	it("says the pipe of an inline shell command", () => {
		const script = build(
			reply("<p>Run <code>ls | grep x</code> to find it.</p>"),
		);
		expect(tokensOf(script)).toContain("pipe");
		expect(script.sentences[0]?.words.find((w) => w.shown === "|")?.kind).toBe(
			"shell",
		);
	});

	it("reads a bare address by its site name, and drops emoji, formulas and citation and footnote marks", () => {
		const script = build(
			reply(
				"<p>See https://www.example.com/docs now, for the full guide and the examples [1].</p><p>The area is $\\pi r^2$ for a circle, a round shape with no corners 🎉.</p><p>It costs $5 and $10 at most [^note], by [2, 3] two people sharing the bill.</p>",
			),
		);
		expect(script.sentences.map((s) => s.tokens)).toEqual([
			[
				"See",
				"example",
				"dot",
				"com",
				"now,",
				"for",
				"the",
				"full",
				"guide",
				"and",
				"the",
				"examples.",
			],
			[
				"The",
				"area",
				"is",
				"for",
				"a",
				"circle,",
				"a",
				"round",
				"shape",
				"with",
				"no",
				"corners.",
			],
			[
				"It",
				"costs",
				"$5",
				"and",
				"$10",
				"at",
				"most,",
				"by",
				"two",
				"people",
				"sharing",
				"the",
				"bill.",
			],
		]);
	});

	it("reads simple formulas written in \\(…\\) and \\[…\\], which the chat shows in plain brackets, and drops the rest", () => {
		// marked reads \( and \[ as escapes, so the reply shows "(x^2 + y^2 = z^2)" (early review R13).
		// Simple math is read as words (the owner's staging find); no TeX reaches the voice.
		const script = build(
			reply(
				"<p>The formula (x^2 + y^2 = z^2) holds, and [\\frac{a}{b} = c] too, unlike (\\sum_{i=1}^{n} i) (as noted).</p>",
			),
		);
		const spoken = bare(tokensOf(script)).replace(/[()]/g, "");
		expect(spoken).not.toMatch(/\^|\\|frac|sum|x2|y2|z2/);
		expect(spoken).toBe(
			"The formula x squared plus y squared equals z squared holds and a over b equals c too unlike as noted",
		);
	});

	it("reads a snake_case name in brackets, which is no formula", () => {
		// The fix verification's P2: "_" marks a formula only before a digit or "{".
		const script = build(
			reply(
				"<p>Open the file (config_file.json) and set (MAX_SIZE) to ten, as (a_1 + a_{n}) says.</p>",
			),
		);
		const spoken = bare(tokensOf(script)).toLowerCase();
		expect(spoken).toContain("config");
		expect(spoken).toContain("max");
		expect(spoken).not.toMatch(/a_1|a_\{n\}/);
	});

	it("drops HTML entities the chat shows as written", () => {
		const script = build(
			reply(
				"<p>Salt &amp;amp; pepper, then &amp;lt;div&amp;gt; and <code>a &amp;amp; b</code> &amp;#169; done.</p>",
			),
		);
		expect(tokensOf(script)).toEqual([
			"Salt",
			"pepper,",
			"then",
			"div",
			"and",
			"a",
			"b",
			"done.",
		]);
	});

	it("reads a link's text from its chip, and a bare address's chip by its site name", () => {
		const script = build(
			reply(
				`<p>Please read ${chip("https://example.com/a_(b)", "the docs")} and then visit ${chip("https://www.example.com/docs", "example.com")} again today.</p><p>Or go to ${chip("http://www.example.org", "example.org")} first, and then come back to the main page.</p>`,
			),
		);
		expect(script.sentences.map((s) => s.tokens)).toEqual([
			[
				"Please",
				"read",
				"the",
				"docs",
				"and",
				"then",
				"visit",
				"example",
				"dot",
				"com",
				"again",
				"today.",
			],
			[
				"Or",
				"go",
				"to",
				"example",
				"dot",
				"org",
				"first,",
				"and",
				"then",
				"come",
				"back",
				"to",
				"the",
				"main",
				"page.",
			],
		]);
		const address = script.sentences[0]?.words.find(
			(w) => w.tokens[0] === "example",
		);
		// The containment check finds the address's letters in the reply's Markdown, where it is written whole.
		expect(address).toMatchObject({
			shown: "https://www.example.com",
			kind: "prose",
		});
		expect(address?.range.toString()).toBe("example.com");
		expect(
			script.sentences[1]?.words.find((w) => w.tokens[0] === "example")?.shown,
		).toBe("www.example.org");
	});

	it("sends a Unicode or logged-in address's chip as the reply writes it, never as punycode", () => {
		// marked percent-encodes the href, and URL turns a Unicode host into punycode
		// ("xn--bcher-kva.de"), whose letters are nowhere in the reply (early review R4).
		const script = build(
			reply(
				`<p>Buy at ${chip("https://b%C3%BCcher.de/x", "xn--bcher-kva.de")} or ${chip("https://user:pw@example.com/x", "example.com")} today.</p>`,
			),
		);
		const shown = script.sentences[0]?.words.map((w) => w.shown) ?? [];
		expect(shown).toContain("https://bücher.de");
		expect(shown).toContain("https://example.com");
		expect(shown.join(" ")).not.toMatch(/xn--|user|pw@/);
	});

	it("reads a numbered list's numbers", () => {
		const script = build(
			reply(
				'<ol start="3"><li>Mix the flour, the salt and the yeast well in a large bowl</li><li>Add the water slowly while you keep stirring the dough</li></ol>',
			),
		);
		const [first, second] = script.sentences;
		expect(first?.tokens.slice(0, 2)).toEqual(["Three.", "Mix"]);
		expect(first?.ranges[0]).toBe(first?.ranges[1]);
		expect(first?.words[0]).toMatchObject({ shown: "3.", kind: "listNumber" });
		expect(second?.tokens.slice(0, 2)).toEqual(["Four.", "Add"]);
		const bullets = build(
			reply(
				"<ul><li>Mix the flour, the salt and the yeast well in a large bowl</li></ul>",
			),
		);
		expect(bullets.sentences[0]?.tokens[0]).toBe("Mix");
	});

	it("ends a heading with a full stop", () => {
		const script = build(
			reply(
				"<h3>Why the dough rises</h3><p>Yeast makes gas in the dough.</p><h4>What you need:</h4><p>Only flour, water and time.</p>",
			),
		);
		// A colon at the end of a unit is the stop's place too: see "the closing stop".
		expect(script.sentences.map((s) => s.tokens.at(-1))).toEqual([
			"rises.",
			"dough.",
			"need.",
			"time.",
		]);
	});

	it("never ends a sentence after a number or a listed abbreviation", () => {
		const script = build(
			reply(
				"<p>A vásár 2026. november 16. hétfőn nyit a főtéren, és egész nap tart. Pl. kenyér, sajt és friss gyümölcs is lesz a standokon.</p>",
			),
		);
		expect(script.sentences).toHaveLength(2);
		expect(script.sentences.every((s) => s.language === "hu")).toBe(true);
		expect(script.sentences[1]?.tokens[0]).toBe("Például");
	});

	it("ends the sentence at an etc. or stb. that a capital letter follows, and keeps its full stop (early review R19)", () => {
		// Each part is over fifty characters, so the script keeps them as two sentences.
		const en = build(
			reply(
				"<p>We need eggs, flour, sugar, butter, milk, vanilla, salt etc. Then we bake it for an hour in a hot oven until it is done.</p>",
			),
		);
		expect(en.sentences).toHaveLength(2);
		expect(en.sentences[0]?.tokens.slice(-2)).toEqual(["et", "cetera."]);
		expect(en.sentences[1]?.tokens[0]).toBe("Then");
		const hu = build(
			reply(
				"<p>Kell hozzá tojás, liszt, cukor, vaj, tej, vanília, só stb. Utána megsütjük a kenyeret egy óráig a forró sütőben.</p>",
			),
			{ fallbackLanguage: "hu" },
		);
		expect(hu.sentences).toHaveLength(2);
		expect(hu.sentences[0]?.tokens.slice(-3)).toEqual(["és", "a", "többi."]);
		expect(hu.sentences[1]?.tokens[0]).toBe("Utána");
		// A short sentence still joins the next, with the stop the abbreviation now keeps.
		const short = build(
			reply(
				"<p>We need eggs, flour, salt etc. Then we bake it for an hour in a hot oven until it is done.</p>",
			),
		);
		expect(short.sentences).toHaveLength(1);
		expect(tokensOf(short).slice(4, 8)).toEqual(["salt", "et", "cetera.", "Then"]);
		// The abbreviation inside a sentence leaves it whole, and without a stop.
		const inside = build(
			reply(
				"<p>We need eggs, flour, salt etc. and a little patience, and then we bake it for an hour.</p>",
			),
		);
		expect(inside.sentences).toHaveLength(1);
		expect(tokensOf(inside)).toContain("cetera");
		expect(tokensOf(inside)).not.toContain("cetera.");
		// A capital after an abbreviation that cannot end a sentence is a name, not a new sentence.
		const names = build(
			reply(
				"<p>Many cities, e.g. Budapest and Vienna, are old, and they keep their markets open all year long.</p>",
			),
		);
		expect(names.sentences).toHaveLength(1);
		expect(tokensOf(names).slice(2, 5)).toEqual(["for", "example", "Budapest"]);
		const pl = build(
			reply(
				"<p>Sok város, pl. Budapest és Bécs, régi, és egész évben nyitva tartják a piacaikat a főtéren.</p>",
			),
			{ fallbackLanguage: "hu" },
		);
		expect(pl.sentences).toHaveLength(1);
	});

	it("says each line of a paragraph broken by single newlines as its own sentence, so it gets its own pause (early review R18)", () => {
		const lines = build(
			reply(
				"<p>The first line is long enough to stand alone as a unit of its own<br>The second line is long enough to stand alone as another unit</p>",
			),
		);
		expect(lines.sentences).toHaveLength(2);
		expect(lines.sentences[0]?.tokens.at(-1)).toBe("own.");
		expect(lines.sentences[1]?.tokens[0]).toBe("The");
		// Short lines join into one unit, each ended by the pause mark a join across units makes.
		const short = build(reply("<p>Name: John<br>Age: 42<br>City: Budapest</p>"));
		expect(tokensOf(short)).toEqual([
			"Name:",
			"John,",
			"Age:",
			"42,",
			"City:",
			"Budapest.",
		]);
		// A break that ends a paragraph, or opens one, says nothing.
		expect(tokensOf(build(reply("<p>Trailing break here<br></p>")))).toEqual([
			"Trailing",
			"break",
			"here.",
		]);
		// A picture between two words stays the space it was, and a break beside one is still a break.
		expect(
			tokensOf(build(reply('<p>before <img src="x.png" alt="ALT"> after</p>'))),
		).toEqual(["before", "after."]);
		expect(
			tokensOf(
				build(
					reply(
						'<p>The first line is long enough to stand alone as a unit<img src="x.png" alt="ALT"><br>The second line is long enough to stand alone as another unit</p>',
					),
				),
			),
		).not.toContain("ALT");
	});

	it("pauses after a word before an arrow between items", () => {
		expect(tokensOf(build(reply("<p>Home → Settings → Profile</p>")))).toEqual([
			"Home,",
			"Settings,",
			"Profile.",
		]);
		expect(
			tokensOf(build(reply("<p>Open the menu · then pick a theme</p>"))),
		).toEqual(["Open", "the", "menu,", "then", "pick", "a", "theme."]);
	});

	it("turns a dash between words into a pause after the word before it", () => {
		expect(
			tokensOf(
				build(reply("<p>Then — and this is the key — fold in the eggs.</p>")),
			),
		).toEqual([
			"Then,",
			"and",
			"this",
			"is",
			"the",
			"key,",
			"fold",
			"in",
			"the",
			"eggs.",
		]);
		expect(
			tokensOf(
				build(reply("<p>Ezután – és ez a lényeg – add hozzá a tojást.</p>")),
			),
		).toEqual([
			"Ezután,",
			"és",
			"ez",
			"a",
			"lényeg,",
			"add",
			"hozzá",
			"a",
			"tojást.",
		]);
		expect(
			tokensOf(build(reply("<p>It works -- mostly -- on Tuesdays.</p>"))),
		).toEqual(["It", "works,", "mostly,", "on", "Tuesdays."]);
	});

	it("reads a spaced hyphen between words as a dash, and between numbers as nothing", () => {
		expect(
			tokensOf(build(reply("<p>Add the eggs - one at a time - and stir.</p>"))),
		).toEqual([
			"Add",
			"the",
			"eggs,",
			"one",
			"at",
			"a",
			"time,",
			"and",
			"stir.",
		]);
		expect(tokensOf(build(reply("<p>It costs 5 - 3 euros.</p>")))).toEqual([
			"It",
			"costs",
			"5",
			"3",
			"euros.",
		]);
	});

	it("keeps the pause a dash makes from doubling one that is already there", () => {
		expect(tokensOf(build(reply("<p>Well, — he said — fine.</p>")))).toEqual([
			"Well,",
			"he",
			"said,",
			"fine.",
		]);
		// A dash with no word before it has nothing to pause after.
		expect(tokensOf(build(reply("<p>— Hello — said Ann.</p>")))).toEqual([
			"Hello,",
			"said",
			"Ann.",
		]);
	});

	it("turns an em dash inside a run of words into a pause", () => {
		expect(
			tokensOf(
				build(reply("<p>Fold in the eggs—one at a time—then stir.</p>")),
			),
		).toEqual([
			"Fold",
			"in",
			"the",
			"eggs,",
			"one",
			"at",
			"a",
			"time,",
			"then",
			"stir.",
		]);
	});

	it("says a parenthetical as words set off by pauses", () => {
		expect(
			tokensOf(
				build(reply("<p>Fold in the eggs (one at a time) and stir.</p>")),
			),
		).toEqual([
			"Fold",
			"in",
			"the",
			"eggs,",
			"one",
			"at",
			"a",
			"time,",
			"and",
			"stir.",
		]);
		expect(
			tokensOf(build(reply("<p>Add the eggs (one at a time).</p>"))),
		).toEqual(["Add", "the", "eggs,", "one", "at", "a", "time."]);
		expect(
			tokensOf(build(reply("<p>Add the eggs (slowly), then stir.</p>"))),
		).toEqual(["Add", "the", "eggs,", "slowly,", "then", "stir."]);
		expect(
			tokensOf(build(reply("<p>Tedd bele a tojásokat (egyesével).</p>"))),
		).toEqual(["Tedd", "bele", "a", "tojásokat,", "egyesével."]);
		expect(
			tokensOf(build(reply("<p>Add the eggs [one at a time] and stir.</p>"))),
		).toEqual([
			"Add",
			"the",
			"eggs,",
			"one",
			"at",
			"a",
			"time,",
			"and",
			"stir.",
		]);
	});

	it("ends a paragraph that closes on a bracket without a comma", () => {
		expect(
			tokensOf(build(reply("<p>Add the eggs (one at a time)</p>"))),
		).toEqual(["Add", "the", "eggs,", "one", "at", "a", "time."]);
	});

	it("sets off a parenthetical inside a parenthetical, and one that closes after a quote", () => {
		expect(
			tokensOf(build(reply("<p>Mix it (the flour (sifted) first) well.</p>"))),
		).toEqual(["Mix", "it,", "the", "flour,", "sifted,", "first,", "well."]);
		expect(tokensOf(build(reply('<p>He said ("fine") and left.</p>')))).toEqual(
			["He", "said,", '"fine",', "and", "left."],
		);
	});

	it("leaves a bracket that opens nothing, and the brackets of a code word, alone", () => {
		expect(tokensOf(build(reply("<p>1) Mix the flour well.</p>")))).toEqual([
			"1)",
			"Mix",
			"the",
			"flour",
			"well.",
		]);
		expect(
			tokensOf(build(reply("<p>Call <code>run()</code> now.</p>"))),
		).toEqual(["Call", "run", "now."]);
	});

	it("keeps each token's range on its own characters when a bracket goes", () => {
		const root = reply("<p>Add the eggs (one at a time) now.</p>");
		const script = build(root);
		const [sentence] = script.sentences;
		expect(sentence?.ranges.map((range) => range.toString())).toEqual([
			"Add",
			"the",
			"eggs",
			"(one",
			"at",
			"a",
			"time)",
			"now.",
		]);
	});

	it("no syntax reaches the tokens", () => {
		const script = build(
			reply(
				`<h2>A <strong>quick</strong> tour</h2><p>Call <code>getUserName()</code> and read ${chip("https://example.com/x", "the guide")} first 👋.</p>${codeBlock("python", ["total = price * 2", "print(total)"])}<ol><li>Mix <em>well</em></li></ol><blockquote><p>Say it [1] once.</p></blockquote><p>Visit https://www.example.com/docs today.</p>`,
			),
		);
		const tokens = tokensOf(script);
		for (const token of tokens) {
			expect([
				"*",
				"_",
				"#",
				"|",
				"`",
				"[",
				"]",
				"(",
				")",
				"<",
				">",
			]).not.toContain(token);
			expect(token).not.toContain("`");
			expect(token).toMatch(/^\S{1,80}$/);
		}
	});

	it("never lets a pause mark push a token past 80 characters", () => {
		const long = "a".repeat(80);
		const script = build(
			reply(
				`<p>Look at this ${long} [1].</p><h2>Heading ${long}</h2><p>One ${long} → two three four.</p>`,
			),
		);
		for (const token of tokensOf(script))
			expect(token.length).toBeLessThanOrEqual(80);
		expect(tokensOf(script)).toContain(long);
	});

	it("keeps each token's range on its own characters", () => {
		const script = build(
			reply("<p>A <strong>bo</strong>ld and <em>quiet</em> move.</p>"),
		);
		const sentence = script.sentences[0];
		expect(sentence?.tokens).toEqual(["A", "bold", "and", "quiet", "move."]);
		expect(sentence?.ranges.map((r) => r.toString())).toEqual([
			"A",
			"bold",
			"and",
			"quiet",
			"move.",
		]);
	});

	it("splits sentences with Intl.Segmenter in the paragraph's language", () => {
		const script = build(
			reply(
				"<p>It rises in an hour when the kitchen is warm enough for the yeast. Then it bakes for forty minutes, and the whole house smells of bread! Is it done yet, or should we give it another few minutes in the oven?</p>",
			),
		);
		expect(script.sentences.map((s) => s.text)).toEqual([
			"It rises in an hour when the kitchen is warm enough for the yeast.",
			"Then it bakes for forty minutes, and the whole house smells of bread!",
			"Is it done yet, or should we give it another few minutes in the oven?",
		]);
		expect(script.sentences.map((s) => s.paragraphStart)).toEqual([
			true,
			false,
			false,
		]);
	});

	it("joins a sentence under fifty characters to the next one of its paragraph, each word keeping its range", () => {
		const root = reply(
			"<p>Sure. Here is the file you asked for, with every change we talked about.</p>",
		);
		const script = build(root);
		expect(script.sentences).toHaveLength(1);
		const [sentence] = script.sentences;
		expect(sentence?.text).toBe(
			"Sure. Here is the file you asked for, with every change we talked about.",
		);
		expect(sentence?.paragraphStart).toBe(true);
		expect(sentence?.ranges[0]?.toString()).toBe("Sure.");
		expect(sentence?.ranges[1]?.toString()).toBe("Here");
		// A point in the second part is in the one unit: Read from here starts at its start.
		const text = root.querySelector("p")?.firstChild as Text;
		expect(sentenceAtPoint(script, text, text.data.indexOf("Here"))).toBe(0);
	});

	it("joins the last sentence of a paragraph, if it is short, to the one before it", () => {
		const script = build(
			reply(
				"<p>This sentence is long enough to stand alone in the script on its own. Thanks a lot.</p>",
			),
		);
		expect(script.sentences).toHaveLength(1);
		expect(script.sentences[0]?.text.endsWith(" Thanks a lot.")).toBe(true);
	});

	it("joins a paragraph of one short sentence to the paragraph after it, and keeps a heading apart", () => {
		const script = build(
			reply(
				"<h2>A short title here</h2><p>Right, that works.</p><p>This paragraph is long enough to be a sentence of its own, really.</p><p>And this one is long enough to stand on its own as well, too.</p>",
			),
		);
		expect(script.sentences.map((s) => s.text)).toEqual([
			"A short title here.",
			"Right, that works. This paragraph is long enough to be a sentence of its own, really.",
			"And this one is long enough to stand on its own as well, too.",
		]);
		// The unit starts a paragraph, as the paragraph of one sentence did; the one after does too.
		expect(script.sentences.map((s) => s.paragraphStart)).toEqual([
			true,
			true,
			true,
		]);
	});

	it("joins the short items of a list into one sentence, each item ended by its own stop", () => {
		const root = reply(
			"<ul><li>Eggs and milk</li><li>Butter and flour</li><li>Sugar and salt</li></ul>",
		);
		const script = build(root);
		expect(script.sentences.map((s) => s.text)).toEqual([
			"Eggs and milk. Butter and flour. Sugar and salt.",
		]);
		const [sentence] = script.sentences;
		expect(sentence?.paragraphStart).toBe(true);
		// Every word keeps the range of its own characters, in whichever item it is.
		expect(sentence?.ranges.map((r) => r.toString())).toEqual([
			"Eggs",
			"and",
			"milk",
			"Butter",
			"and",
			"flour",
			"Sugar",
			"and",
			"salt",
		]);
		// A point in the second item is in the one unit: Read from here starts at its start.
		const second = root.querySelectorAll("li")[1]?.firstChild as Text;
		expect(sentenceAtPoint(script, second, 3)).toBe(0);
	});

	it("keeps the numbers of a numbered list when its items join", () => {
		const script = build(
			reply(
				"<ol><li>Mix the flour well</li><li>Add the water slowly</li></ol>",
			),
		);
		expect(script.sentences.map((s) => s.text)).toEqual([
			"One. Mix the flour well. Two. Add the water slowly.",
		]);
	});

	it("keeps the list of an item the script has already merged with the one after it", () => {
		// "Eggs" is one word: the script merges it into the next item (with a comma), and the unit
		// that makes still belongs to the list, so the item after joins it.
		const script = build(
			reply(
				"<ul><li>Eggs</li><li>Milk and flour</li><li>Butter and sugar</li></ul>",
			),
		);
		expect(script.sentences.map((s) => s.text)).toEqual([
			"Eggs, Milk and flour. Butter and sugar.",
		]);
		// The unit stays an item of its list, not a paragraph of one sentence: it does not take
		// the paragraph after the list.
		const alone = build(
			reply(
				"<ul><li>Eggs</li><li>Milk and flour</li></ul><p>This paragraph is long enough to be a sentence of its own, really. And this second sentence is long enough to stand on its own, too.</p>",
			),
		);
		expect(alone.sentences.map((s) => s.text)).toEqual([
			"Eggs, Milk and flour.",
			"This paragraph is long enough to be a sentence of its own, really.",
			"And this second sentence is long enough to stand on its own, too.",
		]);
	});

	it("joins the items of one list only: two lists, and a heading between, stay apart", () => {
		const two = build(
			reply(
				"<ul><li>Eggs and milk</li></ul><ul><li>Butter and flour</li></ul>",
			),
		);
		expect(two.sentences.map((s) => s.text)).toEqual([
			"Eggs and milk.",
			"Butter and flour.",
		]);
		const headed = build(
			reply(
				"<ul><li>Eggs and milk</li></ul><h2>What comes next</h2><ul><li>Butter and flour</li></ul>",
			),
		);
		expect(headed.sentences.map((s) => s.text)).toEqual([
			"Eggs and milk.",
			"What comes next.",
			"Butter and flour.",
		]);
	});

	it("takes the first item of a list into a short line that introduces it", () => {
		const script = build(
			reply(
				"<p>You will need:</p><ul><li>Eggs and milk</li><li>Butter and flour</li></ul>",
			),
		);
		expect(script.sentences.map((s) => s.text)).toEqual([
			"You will need: Eggs and milk. Butter and flour.",
		]);
	});

	it("joins a one-line paragraph to the first sentence of the paragraph after it", () => {
		const script = build(
			reply(
				"<p>Sure, I can do that.</p><p>Here is the file you asked for, with every change we talked about. It also has the notes you wanted, in a separate file at the end.</p>",
			),
		);
		expect(script.sentences.map((s) => s.text)).toEqual([
			"Sure, I can do that. Here is the file you asked for, with every change we talked about.",
			"It also has the notes you wanted, in a separate file at the end.",
		]);
		// The unit starts a paragraph; the sentence after it is no paragraph's start now.
		expect(script.sentences.map((s) => s.paragraphStart)).toEqual([
			true,
			false,
		]);
	});

	it("joins a one-line paragraph that ends the reply to the paragraph before it", () => {
		const script = build(
			reply(
				"<p>This paragraph is long enough to stand alone in the script, as it should.</p><p>Hope this helps you.</p>",
			),
		);
		expect(script.sentences.map((s) => s.text)).toEqual([
			"This paragraph is long enough to stand alone in the script, as it should. Hope this helps you.",
		]);
		expect(script.sentences[0]?.paragraphStart).toBe(true);
	});

	it("never joins a one-line paragraph to a code block", () => {
		const script = build(
			reply(
				`<p>Here is the sum in Python:</p>${codeBlock("python", ["total = price * 2", "print(total)"])}`,
			),
		);
		expect(script.sentences).toHaveLength(2);
		expect(script.sentences[0]?.text).toBe("Here is the sum in Python.");
	});

	it("never joins into a unit the script would have to split again", () => {
		// A capital after the full stop, or Intl.Segmenter finds no sentence boundary there.
		const long = `Word ${"word ".repeat(43)}end.`; // 224 characters
		const script = build(reply(`<p>A short one here. ${long}</p>`));
		expect(script.sentences.map((s) => s.text.length)).toEqual([
			"A short one here.".length,
			long.length,
		]);
	});

	it("merges short sentences across paragraphs with a pause mark", () => {
		const script = build(
			reply(
				"<h2>Ingredients</h2><ul><li>Flour</li><li>Water</li><li>Salt</li></ul>",
			),
		);
		expect(script.sentences).toHaveLength(1);
		expect(script.sentences[0]).toMatchObject({
			tokens: ["Ingredients.", "Flour,", "Water,", "Salt."],
			paragraphStart: true,
		});
		// A short last sentence joins the one before it.
		const tail = build(
			reply("<p>The dough is ready to bake now.</p><p>Enjoy!</p>"),
		);
		expect(tail.sentences.map((s) => s.tokens)).toEqual([
			["The", "dough", "is", "ready", "to", "bake", "now.", "Enjoy!"],
		]);
		// Within a paragraph a short sentence keeps its own mark.
		const inside = build(reply("<p>Yes. It is ready to bake.</p>"));
		expect(inside.sentences.map((s) => s.text)).toEqual([
			"Yes. It is ready to bake.",
		]);
	});

	it("splits a sentence over 240 characters at a comma", () => {
		const clause =
			"the dough rests in a warm bowl under a clean towel for about an hour";
		const text = `First ${clause}, then ${clause}, and after that ${clause}, until ${clause} at last.`;
		const script = build(reply(`<p>${text}</p>`));
		expect(LONG_SENTENCE_CHARS).toBe(240);
		expect(script.sentences.length).toBeGreaterThan(1);
		for (const sentence of script.sentences)
			expect(sentence.text.length).toBeLessThanOrEqual(240);
		// The part ends where the comma was, and the unit ends in a stop in its place.
		expect(script.sentences[0]?.text.endsWith(".")).toBe(true);
		expect(script.sentences.map((s) => s.paragraphStart)).toEqual(
			script.sentences.map((_, i) => i === 0),
		);
		const unmarked = (value: string) => value.replace(/[.,]/g, "");
		expect(unmarked(script.sentences.flatMap((s) => s.tokens).join(" "))).toBe(
			unmarked(text),
		);
		// With no comma, it splits at the last word that keeps a part within 240.
		const long = Array.from(
			{ length: 60 },
			(_, i) => `word${i % 10 === 0 ? "s" : ""}`,
		).join(" ");
		const plain = build(reply(`<p>${long}.</p>`));
		for (const sentence of plain.sentences) {
			expect(sentence.text.length).toBeLessThanOrEqual(240);
			expect(sentence.tokens.length).toBeGreaterThanOrEqual(3);
		}
	});

	it("never splits off a part of fewer than three tokens", () => {
		const long = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
		const script = build(reply(`<p>Well, ${long} end.</p>`));
		expect(script.sentences.length).toBeGreaterThan(1);
		for (const sentence of script.sentences) {
			expect(sentence.tokens.length).toBeGreaterThanOrEqual(3);
			expect(sentence.text.length).toBeLessThanOrEqual(240);
		}
	});

	it("skips a German paragraph, and names German when nothing is voiced", () => {
		const mixed = build(
			reply(
				"<p>This English paragraph has more than enough letters to be named.</p><p>Das ist ein deutscher Absatz und die Stimme liest ihn nicht vor.</p>",
			),
		);
		expect(mixed.sentences.map((s) => s.tokens[0])).toEqual(["This"]);
		expect(mixed).toMatchObject({
			missingLanguage: null,
			nothingToRead: false,
		});
		const german = build(
			reply(
				"<p>Das ist ein deutscher Absatz und die Stimme liest ihn nicht vor.</p>",
			),
		);
		expect(german).toMatchObject({
			sentences: [],
			missingLanguage: "de",
			nothingToRead: false,
		});
	});

	it("reads a reply of only code in the fallback language", () => {
		const script = build(
			reply(codeBlock("python", ["total = price * 2", "print(total)"])),
			{ fallbackLanguage: "hu" },
		);
		expect(script.sentences.every((s) => s.language === "hu")).toBe(true);
		expect(bare(tokensOf(script))).toBe(
			"total egyenlő price csillag kettő print total",
		);
		const nothing = build(
			reply(codeBlock("ts", ["a();", "b();", "c();", "d();", "e();"])),
		);
		expect(nothing).toMatchObject({
			sentences: [],
			nothingToRead: true,
			missingLanguage: null,
		});
	});

	it("reads a segmented reply's roots in order", () => {
		reply("");
		document.body.innerHTML = `<div data-message-id="a"><div class="markdown-container"><p>The first part is here, and it is long enough to stand alone.</p></div></div><div data-message-id="b"><div class="markdown-container"><p>The last part is here, and it is long enough to stand alone too.</p></div></div>`;
		const roots = [...document.querySelectorAll(".markdown-container")];
		const script = buildSpeechScript(roots, detect, { fallbackLanguage: "en" });
		expect(script.sentences.map((s) => s.text)).toEqual([
			"The first part is here, and it is long enough to stand alone.",
			"The last part is here, and it is long enough to stand alone too.",
		]);
	});

	it("skips closed details but reads their summary", () => {
		const script = build(
			reply(
				"<details><summary>Show the full recipe with all the steps and amounts</summary><p>HIDDENTEXT is inside.</p></details><p>And this is outside, so it is read after the summary.</p>",
			),
		);
		expect(tokensOf(script).join(" ")).not.toContain("HIDDENTEXT");
		expect(script.sentences.map((s) => s.text)).toEqual([
			"Show the full recipe with all the steps and amounts.",
			"And this is outside, so it is read after the summary.",
		]);
	});
});

describe("the closing stop", () => {
	// The walk's Final 1 (2026-11-17): Zonos can end a clip before the last words of a text that
	// ends in no mark ("Egy csipet só" after a list was never said; the same text ending in a
	// full stop is read in full). So every unit the voice is sent ends in a mark that ends a
	// sentence, after the joins and the splits; only punctuation changes.
	const stops = (script: SpeechScript) => script.sentences.map((s) => s.text);

	it("gives the last item of a list, which ends in no mark, a full stop", () => {
		const script = build(
			reply(
				"<ul><li>Eggs and milk</li><li>Butter and flour</li><li>A pinch of salt</li></ul>",
			),
		);
		expect(stops(script)).toEqual([
			"Eggs and milk. Butter and flour. A pinch of salt.",
		]);
	});

	it("ends the walk's Hungarian list in a stop, so its last item is said", () => {
		const script = build(
			reply(
				"<p>Persze, segítek ebben.</p><p>Ezekre lesz szükséged:</p><ul><li>Tojás</li><li>Túró</li><li>Sütőpor</li><li>Egy csipet só</li></ul>",
			),
		);
		expect(stops(script)).toEqual([
			"Persze, segítek ebben. Ezekre lesz szükséged: Tojás, Túró, Sütőpor. Egy csipet só.",
		]);
		expect(script.sentences[0]?.language).toBe("hu");
	});

	it("gives a paragraph with no final mark, and a one-word one after it, a stop", () => {
		const bare = build(
			reply(
				"<p>This paragraph has no final mark but it is long enough to stand alone</p>",
			),
		);
		expect(stops(bare)).toEqual([
			"This paragraph has no final mark but it is long enough to stand alone.",
		]);
		const tail = build(
			reply(
				"<p>This paragraph is long enough to stand alone in the script, as it should.</p><p>Thanks</p>",
			),
		);
		expect(stops(tail)).toEqual([
			"This paragraph is long enough to stand alone in the script, as it should. Thanks.",
		]);
	});

	it("gives a line of code a stop too", () => {
		const script = build(
			reply(
				`<p>Here is a long enough line to tell what follows.</p>${codeBlock("python", ["total = price * 2", "print(total)"])}`,
			),
		);
		for (const sentence of script.sentences)
			expect(sentence.tokens.at(-1)).toMatch(/[.!?…]$/u);
	});

	it("puts the stop where a comma, a semicolon or a colon ended the unit", () => {
		const colon = build(
			reply(
				"<p>Here is the sum in Python:</p>" +
					codeBlock("python", ["total = price * 2", "print(total)"]),
			),
		);
		expect(colon.sentences[0]?.text).toBe("Here is the sum in Python.");
		const heading = build(reply("<h4>What you need:</h4>"));
		expect(stops(heading)).toEqual(["What you need."]);
		// The first part of a sentence that is split at a comma, or at a semicolon.
		const clause =
			"the dough rests in a warm bowl under a clean towel for about an hour";
		const split = build(
			reply(
				`<p>First ${clause}; then ${clause}; and after that ${clause}; until ${clause} at last.</p>`,
			),
		);
		expect(split.sentences.length).toBeGreaterThan(1);
		for (const sentence of split.sentences)
			expect(sentence.tokens.at(-1)).toMatch(/[.!?…]$/u);
		expect(split.sentences[0]?.text.endsWith("hour.")).toBe(true);
	});

	it("leaves a unit that ends in a full stop, a question mark, an exclamation mark or an ellipsis as it is", () => {
		for (const mark of [".", "?", "!", "…"]) {
			const script = build(
				reply(
					`<p>This sentence is long enough to stand alone in the script${mark}</p>`,
				),
			);
			expect(stops(script)).toEqual([
				`This sentence is long enough to stand alone in the script${mark}`,
			]);
		}
	});

	it("does not double a stop that a closing quote or bracket follows", () => {
		const lead = "The teacher looked at the whole class and then she";
		const cases: Array<[string, string]> = [
			[`${lead} said "stop it now."`, 'now."'],
			[`${lead} asked “why did you do it?”`, "it?”"],
			[`${lead} left (as she should have.)`, "have."],
			[`${lead} said "stop it now".`, 'now".'],
		];
		for (const [text, last] of cases) {
			const script = build(reply(`<p>${text}</p>`));
			expect(script.sentences.at(-1)?.tokens.at(-1)).toBe(last);
		}
		// A closing quote that follows no mark has the stop after it.
		const bare = build(reply(`<p>${lead} said "stop it now"</p>`));
		expect(bare.sentences.at(-1)?.tokens.at(-1)).toBe('now".');
	});

	it("leaves room for the stop: a unit is never joined to 240 characters that its stop would make 241", () => {
		// A capital after the full stop, or Intl.Segmenter finds no sentence boundary there. The long
		// sentence ends in no mark: 17 + 1 + 222 = 240 characters joined, 241 closed, which the script
		// would have to split again; so the short one stays apart and the long one has its stop.
		const long = `Word ${"word ".repeat(42)}${"e".repeat(7)}`;
		expect(long).toHaveLength(222);
		const script = build(reply(`<p>A short one here. ${long}</p>`));
		expect(stops(script)).toEqual(["A short one here.", `${long}.`]);
		for (const sentence of script.sentences)
			expect(sentence.text.length).toBeLessThanOrEqual(240);
	});

	it("counts the stop towards the length a unit is split at, and only when it adds one", () => {
		// 47 words of four letters and one of five: 240 characters, which is within the limit, but
		// with its stop 241, so it is split.
		const bare = `${"word ".repeat(47)}eeeee`;
		expect(bare).toHaveLength(240);
		const split = build(reply(`<p>${bare}</p>`));
		expect(split.sentences.length).toBeGreaterThan(1);
		for (const sentence of split.sentences)
			expect(sentence.text.length).toBeLessThanOrEqual(240);
		// The same length ending in a stop, or in a token that cannot take one, is not split.
		const stopped = build(reply(`<p>${"word ".repeat(47)}eeee.</p>`));
		expect(stopped.sentences).toHaveLength(1);
		const full = "a".repeat(80);
		const edge = build(reply(`<p>${"word ".repeat(32)}${full}</p>`));
		expect(edge.sentences).toHaveLength(1);
		expect(edge.sentences[0]?.text).toHaveLength(240);
		expect(edge.sentences[0]?.tokens.at(-1)).toBe(full);
	});

	it("never makes a token longer than the session route takes", () => {
		const long = "a".repeat(80);
		const script = build(
			reply(`<p>This is a paragraph that ends in a very long word ${long}</p>`),
		);
		for (const token of tokensOf(script))
			expect(token.length).toBeLessThanOrEqual(80);
		expect(script.sentences[0]?.tokens.at(-1)).toBe(long);
	});

	it("keeps the count of tokens, so every token keeps its range", () => {
		const script = build(
			reply(
				"<ul><li>Eggs and milk</li><li>Butter and flour</li><li>A pinch of salt</li></ul>",
			),
		);
		const [sentence] = script.sentences;
		expect(sentence?.ranges).toHaveLength(sentence?.tokens.length ?? -1);
		expect(sentence?.ranges.at(-1)?.toString()).toBe("salt");
		expect(sentence?.chars).toBe((sentence?.text.length ?? 0) + 1);
	});
});

describe("simple math (the owner's staging find, 2026-11-17)", () => {
	const SUM = "(€4{,}341.0505 \\times 0.88 = €3{,}820.12444)";

	it("reads the owner's sum, as one word marked whole while it is said", () => {
		const root = reply(`<p>It wouldn't read this at all: ${SUM}</p>`);
		const script = build(root);
		const words = script.sentences.flatMap((s) => s.words);
		const sum = words.find((word) => word.kind === "math");
		expect(sum?.shown).toBe(SUM);
		// The sum ends the paragraph, so the stop that closes every unit is on its last token.
		expect(sum?.tokens).toEqual([
			"€4341.0505",
			"times",
			"0.88",
			"equals",
			"€3820.12444.",
		]);
		expect(sum?.range.toString()).toBe(SUM);
		expect(tokensOf(script).join(" ")).toBe(
			"It wouldn't read this at all: €4341.0505 times 0.88 equals €3820.12444.",
		);
	});

	it("reads it in Hungarian, with the dictionary's words", () => {
		const script = build(reply(`<p>Így számolj: ${SUM} és kész.</p>`));
		expect(script.sentences[0]?.language).toBe("hu");
		expect(tokensOf(script).join(" ")).toBe(
			"Így számolj: 4341,0505 € szorozva 0,88 egyenlő 3820,12444 € és kész.",
		);
	});

	it("reads plain arithmetic in a sentence, its operators too (the second re-walk's New 4)", () => {
		const said = (html: string, language: "en" | "hu" = "en") =>
			bare(tokensOf(build(reply(html), { fallbackLanguage: language })));
		expect(said("<p>We know that 3 + 4 = 7 here.</p>")).toBe(
			"We know that 3 plus 4 equals 7 here",
		);
		expect(said("<p>So 12 − 5 = 7 now.</p>")).toBe(
			"So 12 minus 5 equals 7 now",
		);
		expect(said("<p>So 12 - 5 = 7 now.</p>")).toBe(
			"So 12 minus 5 equals 7 now",
		);
		expect(said("<p>Then 10 / 2 = 5 again.</p>")).toBe(
			"Then 10 over 2 equals 5 again",
		);
		expect(said("<p>And 7 × 8 = 56 too.</p>")).toBe(
			"And 7 times 8 equals 56 too",
		);
		expect(said("<p>It holds (3 + 4 = 7) today.</p>")).toBe(
			"It holds 3 plus 4 equals 7 today",
		);
		expect(said("<p>Ez igaz: 3 + 4 = 7 és kész.</p>", "hu")).toBe(
			"Ez igaz 3 plusz 4 egyenlő 7 és kész",
		);
		// A spaced hyphen or slash between numbers alone is a range or a date, not math.
		expect(said("<p>The years 2026 - 2027 were busy.</p>")).toBe(
			"The years 2026 2027 were busy",
		);
	});

	/** The `math` words of a one-paragraph reply, each as its tokens joined. */
	const mathWords = (html: string, language: "en" | "hu") =>
		build(reply(html), { fallbackLanguage: language })
			.sentences.flatMap((sentence) => sentence.words)
			.filter((word) => word.kind === "math")
			.map((word) => word.tokens.join(" "));

	it("reads plain arithmetic with money, thousands, decimal commas and letters, in English and Hungarian (the third re-walk's New 4)", () => {
		expect(mathWords("<p>So €10 + €5 = €15 in all.</p>", "en")).toEqual([
			"€10 plus €5 equals €15",
		]);
		expect(mathWords("<p>Tehát €10 + €5 = €15 összesen.</p>", "hu")).toEqual([
			"10 € plusz 5 € egyenlő 15 €",
		]);
		expect(mathWords("<p>So 1,000 + 2,000 = 3,000 in all.</p>", "en")).toEqual([
			"1000 plus 2000 equals 3000",
		]);
		expect(
			mathWords("<p>Tehát 1,000 + 2,000 = 3,000 összesen.</p>", "hu"),
		).toEqual(["1000 plusz 2000 egyenlő 3000"]);
		expect(mathWords("<p>So 1,5 + 2,25 = 3,75 in all.</p>", "en")).toEqual([
			"1.5 plus 2.25 equals 3.75",
		]);
		expect(mathWords("<p>Tehát 1,5 + 2,25 = 3,75 összesen.</p>", "hu")).toEqual(
			["1,5 plusz 2,25 egyenlő 3,75"],
		);
		expect(mathWords("<p>Let x = 5 for now.</p>", "en")).toEqual([
			"x equals 5",
		]);
		expect(
			mathWords("<p>Legyen x = 5 és akkor a feladat könnyű lesz.</p>", "hu"),
		).toEqual(["x egyenlő 5"]);
		// The whole sum, never its tail alone (the second re-walk's fix read "x, 2 equals 7").
		expect(mathWords("<p>Solve x + 2 = 7 for x.</p>", "en")).toEqual([
			"x plus 2 equals 7",
		]);
		expect(mathWords("<p>Oldd meg az x + 2 = 7 egyenletet.</p>", "hu")).toEqual(
			["x plusz 2 egyenlő 7"],
		);
	});

	it("leaves a sum it only partly understands as it was, and a hyphen beside a word is a dash", () => {
		// A word is not a letter: the whole sum goes to the prose reading, not its tail alone.
		expect(mathWords("<p>Let total = 3 + 4 now.</p>", "en")).toEqual([]);
		expect(mathWords("<p>Solve 2x - 3 = 7 now.</p>", "en")).toEqual([]);
		expect(mathWords("<p>Then 3 + 4 = 2x today.</p>", "en")).toEqual([]);
		// A spaced hyphen beside a plain word is a dash, not a minus: the sum is read
		// whole, and the dash after it is a pause.
		expect(mathWords("<p>So 3 + 4 = 7 - that is all.</p>", "en")).toEqual([
			"3 plus 4 equals 7,",
		]);
		// Ranges and signs read as before.
		expect(mathWords("<p>From 1,000 - 2,000 people came.</p>", "en")).toEqual(
			[],
		);
		expect(mathWords("<p>Call +36 1 234 5678 today.</p>", "en")).toEqual([]);
	});

	it("never makes an operator a dash's pause: a minus in a sum is said (Track A's dashes, merged)", () => {
		const said = (html: string) =>
			tokensOf(build(reply(html), { fallbackLanguage: "en" })).join(" ");
		// "−" is an operator, never a dash.
		expect(said("<p>So 12 − 5 = 7 now.</p>")).toContain("12 minus 5 equals 7");
		expect(said("<p>So 12 − 5 = 7 now.</p>")).not.toContain(",");
		expect(said("<p>So 12 − 5 now.</p>")).toContain("12 minus 5");
		expect(said("<p>So 12 − 5 now.</p>")).not.toContain(",");
		// Left to the prose reading, a minus is still unsaid, never a pause.
		expect(said("<p>Let total − 5 = 7 now.</p>")).not.toContain(",");
		// An en dash in a sum is a minus too; alone between two numbers it is a
		// range, and the dash's pause.
		expect(said("<p>So 12 – 5 = 7 now.</p>")).toContain("12 minus 5 equals 7");
		expect(said("<p>So 12 – 5 = 7 now.</p>")).not.toContain(",");
		expect(said("<p>The years 2026 – 2027 were busy.</p>")).toContain(
			"2026, 2027",
		);
	});

	it("still skips a formula it cannot read", () => {
		const script = build(
			reply("<p>The area is (\\sum_{i=1}^{n} i) here today.</p>"),
		);
		expect(bare(tokensOf(script))).toBe("The area is here today");
		expect(
			script.sentences.flatMap((s) => s.words).some((w) => w.kind === "math"),
		).toBe(false);
	});
});

describe("sentenceAtPoint", () => {
	it("finds the sentence holding a selection's start", () => {
		const root = reply(
			"<p>The first sentence is here, and it is long enough to stand alone. The second one is here too, and it is just as long as the first one.</p><table><tbody><tr><td>cell</td></tr></tbody></table><p>The third one ends it, and it is the last sentence of the reply.</p>",
		);
		const script = build(root);
		const [p1, , p2] = [...root.querySelectorAll("p, table")];
		const text1 = p1?.firstChild as Text;
		expect(sentenceAtPoint(script, text1, text1.data.indexOf("second"))).toBe(
			1,
		);
		expect(sentenceAtPoint(script, text1, 0)).toBe(0);
		// Between two sentences, the one after the point.
		expect(
			sentenceAtPoint(script, text1, text1.data.indexOf(" The second")),
		).toBe(1);
		// In a part that is not read, the next sentence.
		const cell = root.querySelector("td")?.firstChild as Text;
		expect(sentenceAtPoint(script, cell, 1)).toBe(2);
		const text2 = p2?.firstChild as Text;
		expect(sentenceAtPoint(script, text2, text2.data.length - 1)).toBe(2);
		// The end of the last word, and the end of the reply, are after every sentence:
		// the last sentence is the nearest one (early review R23), never nothing.
		expect(sentenceAtPoint(script, text2, text2.data.length)).toBe(2);
		expect(sentenceAtPoint(script, root, root.childNodes.length)).toBe(2);
	});

	it("a selection that starts after the last word, a trailing emoji's say, reads the last sentence (early review R23)", () => {
		const root = reply(
			"<p>The first sentence is here, and it is long enough to stand alone. The second one is here too, and it is just as long as the first one. 🙂</p>",
		);
		const script = build(root);
		expect(script.sentences).toHaveLength(2);
		const text = root.querySelector("p")?.firstChild as Text;
		expect(sentenceAtPoint(script, text, text.data.indexOf("🙂"))).toBe(1);
		expect(sentenceAtPoint(script, text, text.data.length)).toBe(1);
		// A reply with nothing to read has no sentence to start in.
		expect(
			sentenceAtPoint(build(reply("<p>🙂</p>")), document.body, 0),
		).toBeNull();
	});

	it("never starts in the middle of a written sentence that was split for the voice", () => {
		// The voice makes words up from a short fragment, so Read from here starts where the
		// written sentence starts, even when it was split in parts over 240 characters.
		const clause =
			"the dough rests in a warm bowl under a clean towel for about an hour";
		const root = reply(
			`<p>A short opener comes first. First ${clause}, then ${clause}, and after that ${clause}, until it rises at last.</p>`,
		);
		const script = build(root);
		expect(script.sentences.length).toBeGreaterThan(2);
		expect(script.sentences.map((s) => s.continues)).toEqual(
			script.sentences.map((_, i) => i > 1),
		);
		const text = root.querySelector("p")?.firstChild as Text;
		// A selection that starts mid-sentence, in the split sentence's last part.
		expect(sentenceAtPoint(script, text, text.data.indexOf("until"))).toBe(1);
		// A one-word selection there too.
		expect(sentenceAtPoint(script, text, text.data.indexOf("rises"))).toBe(1);
		// The sentence before the split one is still its own.
		expect(sentenceAtPoint(script, text, text.data.indexOf("opener"))).toBe(0);
	});
});
