/**
 * What a Mermaid source may ask for (decisions.md ruling 74; FX-E). A diagram a
 * model writes is the model's own words, and anything that reaches the reader
 * through the chat can have come from a page the model read, so the source is
 * read as untrusted: Mermaid does what it says. Measured against Mermaid 11.17 in
 * Chromium (`securityLevel: "strict"`, labels as SVG text), a source can
 *
 * - make the browser fetch an address while the diagram is drawn: an image shape
 *   (`A@{ img: "https://…" }`, which Mermaid decodes itself, before any sanitizer
 *   runs; the YAML inside may spell its keys with escapes), a directive or a
 *   front-matter `config:` that turns HTML labels on so an `<img>` in a label is
 *   loaded, or one that carries `themeCSS` / `fontFamily`, and a CSS `url(…)` in
 *   a class or state diagram's `classDef` / `style` (also spelt `\75rl(…)`);
 * - show a link inside the picture: `click`, and a sequence diagram's `link` and
 *   `links`, which survive Mermaid's own sanitizer as an `<a>`; and a sequence
 *   diagram's `properties A: {"icon": "https://…"}` draws an `<image>` for the
 *   actor, which the browser asks for as the diagram is measured.
 *
 * One function, `sanitizeMermaidSource`, takes those out of a source before
 * Mermaid reads it, whatever draws it: the chat's reply, a board's diagram block,
 * the reader's own edit of one. It removes and does not refuse, so the rest of the
 * diagram is drawn. `mermaidSourceProblem` is the door a model writes a diagram
 * onto a board through (ruling 74): the same list, said as a refusal, since a
 * board keeps what it is given and what is stored should be what is drawn. The
 * SVG Mermaid makes is the second gate (`utils/html-sanitizer.ts`), and the
 * renderer's configuration (`components/chat/Mermaid.svelte`) the third.
 *
 * Browser-safe, and nothing but one pure helper imported: the server judges a
 * model's diagram with it and the browser loads it lazily with Mermaid.
 */
import { decodeCssEscapes } from "../../utils/css-escapes";

type Hazard =
	| "image-shape"
	| "shape-block"
	| "click"
	| "link"
	| "properties"
	| "directive"
	| "config"
	| "css-address";

/** More than Mermaid reads (its `maxTextSize` is 50,000, past which it draws a notice), so the work is bounded and a long source still gets that notice. */
const MAX_SOURCE = 51_200;
/** Taking one thing out can leave the pieces around it touching; a few passes reach a fixed point, and a source that will not is not drawn. */
const MAX_PASSES = 6;

// ---- Taking spans out of a text ----------------------------------------

function lineStartOf(text: string, index: number): number {
	let at = index;
	while (at > 0 && text[at - 1] !== "\n" && text[at - 1] !== "\r") at -= 1;
	return at;
}

function lineEndOf(text: string, index: number): number {
	let at = index;
	while (at < text.length && text[at] !== "\n" && text[at] !== "\r") at += 1;
	return at;
}

function blank(text: string, from: number, to: number): boolean {
	for (let at = from; at < to; at += 1) {
		if (text[at] !== " " && text[at] !== "\t") return false;
	}
	return true;
}

/** A span that is alone on its lines goes with them; one in the middle of a line leaves the rest of it. */
function widen(text: string, start: number, end: number): [number, number] {
	const lineStart = lineStartOf(text, start);
	const lineEnd = lineEndOf(text, end);
	if (!blank(text, lineStart, start) || !blank(text, end, lineEnd)) {
		return [start, end];
	}
	let to = lineEnd;
	if (text[to] === "\r") to += 1;
	if (text[to] === "\n") to += 1;
	return [lineStart, to];
}

/** `text` without these spans, in one pass; the last line goes with the line break before it, so nothing dangles. */
function removeSpans(text: string, spans: Array<[number, number]>): string {
	if (spans.length === 0) return text;
	const cuts = spans
		.map(([start, end]) => widen(text, start, end))
		.sort((a, b) => a[0] - b[0]);
	let out = "";
	let at = 0;
	for (const [start, end] of cuts) {
		if (end <= at) continue;
		out += text.slice(at, Math.max(start, at));
		at = end;
	}
	// What is left ends where the last line was: its break goes too, unless the text had one of its own.
	if (at >= text.length && out.length < text.length && !/[\r\n]$/.test(text)) {
		out = out.replace(/\r?\n$/, "");
	}
	return out + text.slice(at);
}

// ---- Directives -----------------------------------------------------------

/**
 * `%%{ … }%%`. Mermaid reads these anywhere in the text and applies them to the
 * renderer, and `htmlLabels`, `themeCSS`, `themeVariables` and the rest are not in
 * its own list of keys a directive may not set. An unterminated one runs to the
 * end, as it does for Mermaid's own pattern.
 */
function removeDirectives(text: string, found: Set<Hazard>): string {
	const spans: Array<[number, number]> = [];
	let at = 0;
	for (;;) {
		const open = text.indexOf("%%{", at);
		if (open < 0) break;
		const close = text.indexOf("}%%", open + 3);
		const end = close < 0 ? text.length : close + 3;
		spans.push([open, end]);
		at = end;
	}
	if (spans.length === 0) return text;
	found.add("directive");
	return removeSpans(text, spans);
}

// ---- Front matter -----------------------------------------------------------

const LINE_BREAK = String.raw`(?:\r\n|\n|\r)`;
const FRONT_MATTER = new RegExp(
	String.raw`^\s*---[^\S\n\r]*${LINE_BREAK}([\s\S]*?)${LINE_BREAK}[^\S\n\r]*---[^\S\n\r]*(?:${LINE_BREAK}|$)`,
);

/** A title that is one plain line: no YAML that could mean more than it says (anchors, aliases, tags, block scalars, flow collections, escapes). */
const PLAIN_TITLE =
	/^title:[ \t]+(?:"[^"\\\n]*"|'[^'\\\n]*'|[^\s"'|>&*!%@`{}[\],#\\][^#\\{}[\]\n]*?)[ \t]*$/;

/**
 * A `--- … ---` block at the start is YAML that Mermaid reads before the
 * directives, and its `config:` is a directive by another name. A title is all
 * that stays.
 */
function cleanFrontMatter(text: string, found: Set<Hazard>): string {
	const match = FRONT_MATTER.exec(text);
	if (!match) return text;
	let title: string | null = null;
	let more = false;
	for (const line of match[1].split(/\r\n|\n|\r/)) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		if (title === null && PLAIN_TITLE.test(trimmed)) {
			title = trimmed;
			continue;
		}
		more = true;
	}
	if (!more) return text;
	found.add("config");
	const kept = title === null ? "" : `---\n${title}\n---\n`;
	return kept + text.slice(match[0].length);
}

// ---- Image and icon shapes ------------------------------------------------

/**
 * What a `@{ … }` block may hold: how a node is shaped, worded and moves, a kanban
 * card's facts, and a sequence participant's type. Never `img`, `icon`, `pos`,
 * `w`, `h`, `form` or `constraint`, which are for pictures.
 */
const SHAPE_KEYS = new Set([
	"shape",
	"label",
	"labeltype",
	"animate",
	"animation",
	"curve",
	"type",
	"ticket",
	"assigned",
	"priority",
	"view",
]);

const PAIR = String.raw`(?:"[A-Za-z]+"|[A-Za-z]+)[ \t]*:[ \t]*(?:"[^"\\\n]*"|'[^'\\\n]*'|[A-Za-z0-9_. -]+?)`;
/** One line, `key: value` pairs, keys bare or quoted, values quoted (no escapes) or plain words: nothing YAML can read twice. */
const CANONICAL_BLOCK = new RegExp(
	String.raw`^[ \t]*(?:${PAIR}(?:[ \t]*,[ \t]*${PAIR})*[ \t]*,?[ \t]*)?$`,
);
const EACH_PAIR =
	/(?:"([A-Za-z]+)"|([A-Za-z]+))[ \t]*:[ \t]*("[^"\\\n]*"|'[^'\\\n]*'|[A-Za-z0-9_. -]+?)(?=[ \t]*(?:,|$))/g;
const MAX_BLOCK = 300;

/** Whether this block says nothing but the words of a shape, a label or a motion. */
function harmlessBlock(body: string): boolean {
	if (body.length > MAX_BLOCK || !CANONICAL_BLOCK.test(body)) return false;
	for (const [, quoted, plain, value] of body.matchAll(EACH_PAIR)) {
		const key = (quoted ?? plain).toLowerCase();
		if (!SHAPE_KEYS.has(key)) return false;
		const word = value
			.replace(/^["']|["']$/g, "")
			.trim()
			.toLowerCase();
		if (key === "shape" && /^(?:icon|img|image)/.test(word)) return false;
	}
	return true;
}

/** A label this module can read whole: a quoted string with no escape in it, as a key written plainly. */
const PLAIN_LABEL =
	/(?:^|[\s,{])"?label"?[ \t]*:[ \t]*("[^"\\\n]*"|'[^'\\\n]*')/;

/**
 * A node's `@{ … }` block is YAML, and the block that names an image makes Mermaid
 * decode the picture itself while it draws (twice, before any sanitizer), so a
 * block is kept only when it is one this module can read all of. Any other goes, to
 * its first `}`, whatever it was trying to say, but for a label it says plainly: a
 * box that was to hold a picture and a caption keeps the caption.
 */
function removeShapeBlocks(text: string, found: Set<Hazard>): string {
	let out = "";
	let at = 0;
	for (;;) {
		const open = text.indexOf("@{", at);
		if (open < 0) break;
		const close = text.indexOf("}", open + 2);
		const end = close < 0 ? lineEndOf(text, open) : close + 1;
		const block = text.slice(open, end);
		out += text.slice(at, open);
		at = end;
		if (close >= 0 && harmlessBlock(text.slice(open + 2, close))) {
			out += block;
			continue;
		}
		found.add(
			/img|icon|image|\\[uxU]/i.test(block) ? "image-shape" : "shape-block",
		);
		const label = PLAIN_LABEL.exec(block.slice(2))?.[1];
		if (label !== undefined) out += `@{ label: ${label} }`;
	}
	return out + text.slice(at);
}

// ---- Click and link lines ---------------------------------------------------

/**
 * Where a statement may begin: a line, after `;`, and where the flowchart grammar
 * lets one follow `end` or `direction XX` with no break between them.
 */
const STATEMENT_START = String.raw`(?:^|[;\n\r]|\bend\b|\bdirection[ \t]+[A-Za-z]{2}\b)[ \t]*`;

/** `click ID href "…"`, `click ID "…"`, `click ID call f()`, `click ID callback …`: flowchart, class, state and Gantt (the last three read it in any case). */
const CLICK_STATEMENT = new RegExp(
	String.raw`${STATEMENT_START}(click[ \t]+[^\s;"']+[ \t]+(?:href\b|call\b|callback\b|["'])[^\n\r;]*)`,
	"gimd",
);
/** A sequence diagram's `link A: Label @ address` and `links A: {…}`, and a class diagram's `link Foo "address"`. */
const LINK_STATEMENT = new RegExp(
	String.raw`${STATEMENT_START}(links?[ \t]+(?:[^\s:;"']+[ \t]*:|[^\s;"']+[ \t]+["'])[^\n\r;]*)`,
	"gimd",
);

/** A sequence diagram's `properties A: {"icon": "…"}`: the actor is drawn with that picture, which the browser asks for as the diagram is measured. */
const PROPERTIES_STATEMENT = new RegExp(
	String.raw`${STATEMENT_START}(properties[ \t]+[^\s:;<>=-][^:;\n\r]*:[^\n\r;]*)`,
	"gimd",
);

function removeStatements(
	text: string,
	pattern: RegExp,
	hazard: Hazard,
	found: Set<Hazard>,
): string {
	const spans: Array<[number, number]> = [];
	for (const match of text.matchAll(pattern)) {
		const [start, end] = (
			match as RegExpMatchArray & { indices: Array<[number, number]> }
		).indices[1];
		spans.push([start, end]);
	}
	if (spans.length === 0) return text;
	found.add(hazard);
	return removeSpans(text, spans);
}

// ---- CSS addresses -----------------------------------------------------------

/** A CSS identifier, escapes included (`\75rl` is `url`): the name of a function or at-rule. */
const CSS_NAME =
	/(?:[\w-]|[\u0080-￿]|\\(?:[0-9A-Fa-f]{1,6}[ \t\n\r\f]?|[^\n\r\f0-9A-Fa-f]))+/g;

/** The name as the CSS parser reads it: escapes undone, case folded. */
function cssName(raw: string): string {
	return decodeCssEscapes(raw).toLowerCase();
}

/** The functions that make a browser fetch an address: `url()`, `image-set()` (which takes a string), and `src()`. */
const FETCHING = new Set(["url", "image-set", "-webkit-image-set", "src"]);
const AT_RULES = new Set(["import", "font-face"]);

/** `src(` is a word a flowchart node can be called, so it counts only with a string or an address in it. */
function takesAnAddress(text: string, open: number): boolean {
	return /^\(\s*(?:["']|\/\/|[A-Za-z][A-Za-z0-9+.-]*:)/.test(
		text.slice(open, open + 40),
	);
}

/**
 * A browser fetches an address for a `url()` (and the few functions like it) in
 * any value it reads as CSS, and a class or state diagram's `classDef` / `style`
 * puts what it is given into one. The source cannot be told apart from a label
 * without Mermaid's grammar, so the name is broken instead: `url (` is not a
 * function to CSS, and in a label it is a space in a word. The same for the
 * at-rules that load a sheet or a font (`@ import`).
 */
function breakCssAddresses(text: string, found: Set<Hazard>): string {
	const gaps: number[] = [];
	for (const match of text.matchAll(CSS_NAME)) {
		const start = match.index;
		const end = start + match[0].length;
		const name = cssName(match[0]);
		if (text[end] === "(" && FETCHING.has(name)) {
			if (name !== "src" || takesAnAddress(text, end)) gaps.push(end);
		}
		if (start > 0 && text[start - 1] === "@" && AT_RULES.has(name)) {
			gaps.push(start);
		}
	}
	if (gaps.length === 0) return text;
	found.add("css-address");
	let out = "";
	let at = 0;
	for (const gap of gaps) {
		out += `${text.slice(at, gap)} `;
		at = gap;
	}
	return out + text.slice(at);
}

/**
 * What a directive in a source may not set, as Mermaid's own `secure` list (it
 * replaces Mermaid's default, so the six it starts with are here): the keys that
 * could bring HTML labels, CSS or an address in. The wall behind the sanitizer,
 * which takes directives out first; handed to `mermaid.initialize` by the one
 * component that calls it.
 */
export const MERMAID_SECURE_KEYS = [
	"secure",
	"securityLevel",
	"startOnLoad",
	"maxTextSize",
	"suppressErrorRendering",
	"maxEdges",
	"htmlLabels",
	"themeCSS",
	"themeVariables",
	"fontFamily",
	"altFontFamily",
	"ticketBaseUrl",
];

// ---- The sanitizer ----------------------------------------------------------

/**
 * The source Mermaid is to read, and what was taken out of it (in the order it was
 * found). Everything else is as it was written: a source with nothing in it that
 * asks for anything comes back byte for byte. Running it on its own result changes
 * nothing, and a source it cannot make settle comes back empty.
 */
export function sanitizeMermaidSource(source: string): {
	source: string;
	removed: string[];
} {
	const found = new Set<Hazard>();
	let text = source.length > MAX_SOURCE ? source.slice(0, MAX_SOURCE) : source;
	for (let pass = 0; pass < MAX_PASSES; pass += 1) {
		let next = removeDirectives(text, found);
		next = cleanFrontMatter(next, found);
		next = removeShapeBlocks(next, found);
		next = removeStatements(next, CLICK_STATEMENT, "click", found);
		next = removeStatements(next, LINK_STATEMENT, "link", found);
		next = removeStatements(next, PROPERTIES_STATEMENT, "properties", found);
		next = breakCssAddresses(next, found);
		if (next === text) return { source: text, removed: [...found] };
		text = next;
	}
	return { source: "", removed: [...found] };
}

// ---- The door a model writes a diagram through ---------------------------------

/** What each is called when a model is told, in the order the first one found is told. */
const REFUSED_AS: ReadonlyArray<readonly [Hazard, string]> = [
	["image-shape", "an image or icon shape"],
	[
		"shape-block",
		"a @{ … } block with anything but a shape, a label or a motion in it",
	],
	["click", "a click line"],
	["link", "a link line"],
	["properties", "a properties line, which can name a picture to load"],
	["directive", "a %%{ … }%% directive"],
	["config", "a front-matter config block"],
	["css-address", "a CSS address (url(), image-set() or @import)"],
];

/**
 * What is wrong with a diagram source the MODEL wrote, in a sentence it can act
 * on, or null (ruling 74, on the reasoning of ruling 67). A board keeps what a
 * model writes and draws it again on every open, so what asks the reader's
 * browser to fetch an address, or hands them a link inside the picture, is not
 * written onto one: the drawing would leave it out, and what is stored should be
 * what is drawn. It is the sanitizer's own list, read as a refusal, and any click
 * line and any web address besides (a model has no use for either on a board).
 * What a reader inserts from the chat or types into the block's form is not
 * judged here: it is drawn through the sanitizer.
 */
export function mermaidSourceProblem(code: string): string | null {
	const found = new Set(sanitizeMermaidSource(code).removed);
	if (/^[ \t]*click[ \t]/im.test(code)) found.add("click");
	const named =
		REFUSED_AS.find(([hazard]) => found.has(hazard))?.[1] ??
		(/\bhttps?:\/\//i.test(code) ? "a web address" : null);
	if (named === null) return null;
	return `a diagram's source may not contain ${named}: the board draws boxes, arrows and words, and anything that loads or links an address would reach whoever opens it. Write the diagram without it.`;
}
