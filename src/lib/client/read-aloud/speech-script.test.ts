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
				'<h2>Making bread at home</h2><p>Bread needs flour, water and salt.</p><ul><li>Use strong white flour for a good rise.</li></ul><blockquote><p>Patience is the secret ingredient.</p></blockquote></div><div class="markdown-checklist-block"><ul class="markdown-checklist"><li class="markdown-checklist__row markdown-checklist__row--task"><input type="checkbox" class="markdown-checklist__box" disabled><div class="markdown-checklist__text">Preheat the oven to a high heat.</div></li></ul></div><div>',
			),
		);
		expect(script.sentences.map((s) => s.text)).toEqual([
			"Making bread at home.",
			"Bread needs flour, water and salt.",
			"Use strong white flour for a good rise.",
			"Patience is the secret ingredient.",
			"Preheat the oven to a high heat.",
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
		expect(script.sentences.map((s) => s.tokens)).toEqual([
			["Call", "get", "User", "Name."],
			["Then", "use", "arrow", "and", "here."],
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
				"<p>See https://www.example.com/docs now [1].</p><p>The area is $\\pi r^2$ for a circle 🎉.</p><p>It costs $5 and $10 at most [^note], by [2, 3] two.</p>",
			),
		);
		expect(script.sentences.map((s) => s.tokens)).toEqual([
			["See", "example", "dot", "com", "now."],
			["The", "area", "is", "for", "a", "circle."],
			["It", "costs", "$5", "and", "$10", "at", "most,", "by", "two."],
		]);
	});

	it("drops formulas written in \\(…\\) and \\[…\\], which the chat shows in plain brackets", () => {
		// marked reads \( and \[ as escapes, so the reply shows "(x^2 + y^2 = z^2)" (early review R13).
		const script = build(
			reply(
				"<p>The formula (x^2 + y^2 = z^2) holds, and [\\frac{a}{b} = c] too (as noted).</p>",
			),
		);
		const spoken = bare(tokensOf(script)).replace(/[()]/g, "");
		expect(spoken).not.toMatch(/\^|\\|frac|x2|y2|z2/);
		expect(spoken).toContain("The formula holds and too as noted");
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
				`<p>Read ${chip("https://example.com/a_(b)", "the docs")} and visit ${chip("https://www.example.com/docs", "example.com")} today.</p><p>Or go to ${chip("http://www.example.org", "example.org")} first.</p>`,
			),
		);
		expect(script.sentences.map((s) => s.tokens)).toEqual([
			[
				"Read",
				"the",
				"docs",
				"and",
				"visit",
				"example",
				"dot",
				"com",
				"today.",
			],
			["Or", "go", "to", "example", "dot", "org", "first."],
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
				'<ol start="3"><li>Mix the flour well</li><li>Add the water slowly</li></ol>',
			),
		);
		const [first, second] = script.sentences;
		expect(first?.tokens.slice(0, 2)).toEqual(["Three.", "Mix"]);
		expect(first?.ranges[0]).toBe(first?.ranges[1]);
		expect(first?.words[0]).toMatchObject({ shown: "3.", kind: "listNumber" });
		expect(second?.tokens.slice(0, 2)).toEqual(["Four.", "Add"]);
		const bullets = build(reply("<ul><li>Mix the flour well</li></ul>"));
		expect(bullets.sentences[0]?.tokens[0]).toBe("Mix");
	});

	it("ends a heading with a full stop", () => {
		const script = build(
			reply(
				"<h3>Why the dough rises</h3><p>Yeast makes gas in the dough.</p><h4>What you need:</h4><p>Only flour, water and time.</p>",
			),
		);
		expect(script.sentences.map((s) => s.tokens.at(-1))).toEqual([
			"rises.",
			"dough.",
			"need:",
			"time.",
		]);
	});

	it("never ends a sentence after a number or a listed abbreviation", () => {
		const script = build(
			reply(
				"<p>A vásár 2026. november 16. Hétfőn nyit. Pl. Kenyér is lesz.</p>",
			),
		);
		expect(script.sentences).toHaveLength(2);
		expect(script.sentences.every((s) => s.language === "hu")).toBe(true);
		expect(script.sentences[1]?.tokens[0]).toBe("Például");
	});

	it("pauses after a word before an arrow between items", () => {
		expect(tokensOf(build(reply("<p>Home → Settings → Profile</p>")))).toEqual([
			"Home,",
			"Settings,",
			"Profile",
		]);
		expect(
			tokensOf(build(reply("<p>Open the menu · then pick a theme</p>"))),
		).toEqual(["Open", "the", "menu,", "then", "pick", "a", "theme"]);
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
				"<p>It rises in an hour. Then it bakes for forty minutes! Is it done yet?</p>",
			),
		);
		expect(script.sentences.map((s) => s.text)).toEqual([
			"It rises in an hour.",
			"Then it bakes for forty minutes!",
			"Is it done yet?",
		]);
		expect(script.sentences.map((s) => s.paragraphStart)).toEqual([
			true,
			false,
			false,
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
			tokens: ["Ingredients.", "Flour,", "Water,", "Salt"],
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
		expect(script.sentences[0]?.text.endsWith(",")).toBe(true);
		expect(script.sentences.map((s) => s.paragraphStart)).toEqual(
			script.sentences.map((_, i) => i === 0),
		);
		expect(script.sentences.flatMap((s) => s.tokens).join(" ")).toBe(text);
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
		document.body.innerHTML = `<div data-message-id="a"><div class="markdown-container"><p>The first part is here.</p></div></div><div data-message-id="b"><div class="markdown-container"><p>The last part is here.</p></div></div>`;
		const roots = [...document.querySelectorAll(".markdown-container")];
		const script = buildSpeechScript(roots, detect, { fallbackLanguage: "en" });
		expect(script.sentences.map((s) => s.text)).toEqual([
			"The first part is here.",
			"The last part is here.",
		]);
	});

	it("skips closed details but reads their summary", () => {
		const script = build(
			reply(
				"<details><summary>Show the full recipe</summary><p>HIDDENTEXT is inside.</p></details><p>And this is outside.</p>",
			),
		);
		expect(tokensOf(script).join(" ")).not.toContain("HIDDENTEXT");
		expect(script.sentences.map((s) => s.text)).toEqual([
			"Show the full recipe",
			"And this is outside.",
		]);
	});
});

describe("sentenceAtPoint", () => {
	it("finds the sentence holding a selection's start", () => {
		const root = reply(
			"<p>The first sentence is here. The second one is here.</p><table><tbody><tr><td>cell</td></tr></tbody></table><p>The third one ends it.</p>",
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
		// The end of the last word, and the end of the reply, are after every sentence.
		expect(sentenceAtPoint(script, text2, text2.data.length)).toBeNull();
		expect(sentenceAtPoint(script, root, root.childNodes.length)).toBeNull();
	});
});
