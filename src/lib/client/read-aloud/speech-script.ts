/**
 * The speech script: what read aloud says, built from the reply as rendered
 * on screen (spec §4.4), never from its Markdown, so no syntax reaches the
 * voice. A reply becomes paragraphs, paragraphs become sentences, and each
 * written word keeps its DOM `Range` and the tokens it is spoken as. The
 * tokens come only from the shared reading dictionary (`speakWord`), which the
 * session route checks them with.
 */

import {
	codeKindOf,
	isSeparator,
	isSimpleMath,
	keepsSentenceOpen,
	speakWord,
	type WordKind,
} from "$lib/shared/read-aloud/spoken-forms";
import { assignLanguages, type Detect, isVoiced } from "./language";

type Voiced = "en" | "hu";

/** A written word as it stands on screen, how it is read, and its range (which may span several text nodes). */
export type ScriptWord = {
	shown: string;
	kind: WordKind;
	tokens: string[];
	range: Range;
};

export type ScriptSentence = {
	/** `s<index>`, the id the session and the speech service know it by. */
	id: string;
	index: number;
	language: Voiced;
	paragraphStart: boolean;
	/**
	 * It goes on from the sentence before: a written sentence over
	 * {@link LONG_SENTENCE_CHARS} split for the voice. Read from here never starts
	 * at one (`sentenceAtPoint`): the voice makes words up from a short fragment.
	 */
	continues: boolean;
	words: ScriptWord[];
	/** The words' tokens in order, pause marks included. */
	tokens: string[];
	/** `ranges[i]` is the range of token i's word, so a word read as several tokens stays marked whole. */
	ranges: Range[];
	/** `tokens.join(" ")`. */
	text: string;
	/** The running sum of `chars` before this sentence. */
	charStart: number;
	/** `text.length + 1`. */
	chars: number;
};

export type SpeechScript = {
	sentences: ScriptSentence[];
	totalChars: number;
	/** The language with the most letters when no paragraph has a voice, else null. */
	missingLanguage: string | null;
	/** Nothing in the reply can be read: no paragraph had a word. */
	nothingToRead: boolean;
};

/**
 * What is never read. Code blocks are not skipped whole: their language label and buttons fall
 * under `button`, and their fade under `[aria-hidden='true']`. A link chip is read by its label
 * (its favicon and icon are hidden); a picture's chip stands where a picture was not loaded.
 */
const SKIPPED_SELECTOR =
	".markdown-diagram-block, .markdown-table-wrap, table, .markdown-frontmatter, .markdown-image-frame, img, svg, figure, button, input, a.source-link-chip--image, [aria-hidden='true'], script, style";

const PARAGRAPH_TAGS = [
	"P",
	"LI",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"BLOCKQUOTE",
	"SUMMARY",
	"DT",
	"DD",
	"DIV",
	"ASIDE",
] as const;

/** A code block of at most this many non-blank lines is read; a longer one only when Read from here starts in it. */
export const CODE_BLOCK_MAX_LINES = 3;

/**
 * A sentence longer than this is split. Measured on the box (2026-11-16): it keeps every clip under
 * 30 s even at the slowest Pace, so the aligner never enters its long-form mode.
 */
export const LONG_SENTENCE_CHARS = 240;

/** Zonos misfires on inputs of one or two words. */
const SHORT_SENTENCE_TOKENS = 3;

const PARAGRAPH_TAG_SET: ReadonlySet<string> = new Set(PARAGRAPH_TAGS);
const HEADING = /^H[1-6]$/;
const WHITESPACE = /\s/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const LETTERS = /\p{L}/gu;
/** Marks a stray word hands to the word before it: what ends a clause or closes something. */
const HANDED_MARKS = /[.,;:!?…)\]}"'”’»]/gu;
const ENDS_IN_PAUSE = /[.!?,;:…]$/u;
const ENDS_A_HEADING = /[.!?…:]$/u;

/** Emoji, regional indicators, the zero-width joiner and the emoji variation selector, one code point at a time. */
const EMOJI = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\u200D|\uFE0F/gu;
/** TeX: `$$…$$` and `$…$` holding `\ ^ _ { } =`, and `\(…\)` and `\[…\]`. */
const TEX_DOLLARS = /\$\$[^$]+?\$\$|\$[^$\n]+?\$/gu;
const TEX_SPECIAL = /[\\^_{}=]/u;
const TEX_BRACKETS = /\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/gu;
/**
 * `\(…\)` and `\[…\]` as the chat shows them: marked reads `\(` and `\[` as escapes, so
 * the page holds "(x^2 + y^2)" in plain brackets. A bracketed run with a TeX mark in it
 * (`\ ^ { }`, or "_" before a digit or "{") is a formula (early review R13); "(a = b)"
 * and "(config_file.json)" in prose are still read (the fix verification's P2).
 */
const TEX_PLAIN_BRACKETS =
	/\((?=[^()\n]*(?:[\\^{}]|_[\d{]))[^()\n]*\)|\[(?=[^[\]]*(?:[\\^{}]|_[\d{]))[^[\]]*\]/gu;
/**
 * Plain arithmetic in a sentence (the second and third re-walks' New 4): numbers or
 * single letters joined by spaced operators, bracketed or not ("3 + 4 = 7",
 * "(12 − 5 = 7)", "€10 + €5 = €15", "1,5 + 2,25 = 3,75", "x + 2 = 7"). A number may
 * group its thousands, carry a decimal comma or point, and have a € or £ before or
 * after it or a % after it. It is read as simple math only when it holds an operator
 * other than "-" and "/" (`ARITHMETIC_SIGN`): between two numbers alone, those are a
 * range or a date ("2026 - 2027").
 */
const ARITHMETIC_OPERAND = String.raw`(?:[-\u2212]?[€£]?\d+(?:[.,]\d+)*(?:[ \u00a0\u202f]?[%€£])?|[A-Za-z])`;
const ARITHMETIC_RUN = String.raw`${ARITHMETIC_OPERAND}(?:\s+[-\u2212+×·÷/=≈≠*]\s+${ARITHMETIC_OPERAND})+`;
const ARITHMETIC = new RegExp(
	String.raw`(?<![\p{L}\p{N}_.,€£])(?:\(${ARITHMETIC_RUN}\)|${ARITHMETIC_RUN})(?![\p{L}\p{N}_€£%])`,
	"gu",
);
const ARITHMETIC_SIGN = /\s[+×·÷=≈≠*\u2212]\s/u;
/**
 * A sum that touches another spaced operator goes on past what can be read ("total =
 * 3 + 4", "2x - 3 = 7"): the whole of it is left to the prose's reading, as before,
 * never its tail alone. A "-" or "/" counts only beside a word with a digit in it: beside
 * a plain word it is a dash ("3 + 4 = 7 - that is all").
 */
const ARITHMETIC_GOES_ON_BEFORE =
	/(?:[+×·÷=≈≠*\u2212]|(?:^|\s)\S*\p{N}\S*\s+[-/])\s+$/u;
const ARITHMETIC_GOES_ON_AFTER =
	/^\s+(?:[+×·÷=≈≠*\u2212](?:\s|$)|[-/]\s+\S*\p{N})/u;
/** How far around a sum `ARITHMETIC_GOES_ON_*` look. */
const ARITHMETIC_REACH = 24;
/**
 * An HTML entity the chat shows as written (`&amp;`, `&#169;`: it does for some replies): markup,
 * never said, and decoded away by the containment check, so its letters must not be sent.
 */
const ENTITY = /&(?:[a-z][a-z0-9]{1,31}|#\d{1,7}|#x[0-9a-f]{1,6});/giu;
/** Citation and footnote marks: `[1]`, `[2, 3]`, `[4–6]`, `[^1]`, `[^note]`. */
const CITATION = /\[(?:\^[^\]\s]+|\d+(?:\s*[,–-]\s*\d+)*)\]/gu;

type Position = { node: Text; offset: number };

/** One paragraph as collected from the DOM: its characters, where each one is, and the inline code or chip label each sits in. */
type Paragraph = {
	element: Element;
	chars: string[];
	map: Array<Position | null>;
	atoms: Array<Element | null>;
	heading: boolean;
	/** The code block's language, for a code block; null for prose. */
	code: string | null;
};

type DraftWord = ScriptWord & { start: number; heading: boolean };

type Draft = {
	language: Voiced;
	paragraphStart: boolean;
	/** A part after the first of a split sentence. */
	continues?: boolean;
	words: DraftWord[];
	/** The paragraph (or code line) the draft's last part came from: a join across two of them adds a pause mark. */
	unit: string;
};

export function buildSpeechScript(
	roots: readonly Element[],
	detect: Detect,
	options: { fallbackLanguage: Voiced; readBlock?: Element | null },
): SpeechScript {
	const paragraphs = roots.flatMap((root) =>
		collectParagraphs(root, options.readBlock ?? null),
	);
	const spoken = paragraphs.map(spokenView);
	// The language is told from the words: a formula read as math is left out of it.
	const views = spoken.map((part) => part.detect);
	const codes = assignLanguages(
		paragraphs.map((p, i) => (p.code === null ? (views[i] ?? "") : "")),
		detect,
	);

	const drafts: Draft[] = [];
	const unvoicedLetters = new Map<string, number>();
	const numbered = new Set<Element>();
	let anyWord = false;
	paragraphs.forEach((paragraph, index) => {
		const view = views[index] ?? "";
		const language = codes[index] || options.fallbackLanguage;
		if (!isVoiced(language)) {
			if (LETTER_OR_DIGIT.test(view)) {
				anyWord = true;
				unvoicedLetters.set(
					language,
					(unvoicedLetters.get(language) ?? 0) +
						(view.match(LETTERS)?.length ?? 0),
				);
			}
			return;
		}
		const said = spoken[index] ?? { view, math: [] };
		const made =
			paragraph.code === null
				? proseDrafts(
						paragraph,
						said.view,
						said.math,
						language,
						`${index}`,
						numbered,
					)
				: codeDrafts(
						paragraph,
						said.view,
						paragraph.code,
						language,
						`${index}`,
					);
		if (made.length > 0) anyWord = true;
		drafts.push(...made);
	});

	const sentences = finish(splitLong(mergeShort(drafts)));
	const totalChars = sentences.reduce((sum, s) => sum + s.chars, 0);
	if (sentences.length > 0)
		return {
			sentences,
			totalChars,
			missingLanguage: null,
			nothingToRead: false,
		};
	let missingLanguage: string | null = null;
	let most = 0;
	for (const [language, letters] of unvoicedLetters) {
		if (letters > most) {
			most = letters;
			missingLanguage = language;
		}
	}
	return {
		sentences,
		totalChars,
		missingLanguage,
		nothingToRead: !anyWord || missingLanguage === null,
	};
}

/**
 * Where Read from here starts: the sentence holding the point (from its first word's start up to
 * its last word's end, which belongs to what follows), else the first one after it; null when the
 * point is after every sentence. A part of a split sentence gives the sentence's first part, so a
 * reading never starts with a fragment of one (the voice makes words up from a short one).
 */
export function sentenceAtPoint(
	script: SpeechScript,
	node: Node,
	offset: number,
): number | null {
	const found = sentenceHoldingPoint(script, node, offset);
	if (found === null) return null;
	let index = found;
	while (index > 0 && script.sentences[index]?.continues) index -= 1;
	return index;
}

function sentenceHoldingPoint(
	script: SpeechScript,
	node: Node,
	offset: number,
): number | null {
	for (const sentence of script.sentences) {
		const first = sentence.ranges[0];
		const last = sentence.ranges[sentence.ranges.length - 1];
		if (!first || !last) continue;
		const start = comparePoint(first, node, offset);
		if (start === null) continue;
		if (start < 0) return sentence.index;
		const end = last.cloneRange();
		end.collapse(false);
		const after = comparePoint(end, node, offset);
		if (after !== null && after < 0) return sentence.index;
	}
	return null;
}

function comparePoint(range: Range, node: Node, offset: number): number | null {
	try {
		return range.comparePoint(node, offset);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Walking the DOM
// ---------------------------------------------------------------------------

function isCodeBlock(element: Element): boolean {
	return (
		element.classList.contains("code-block") ||
		(element.tagName === "PRE" && !element.closest(".code-block"))
	);
}

function nearestParagraph(element: Element, root: Element): Element {
	for (
		let current: Element | null = element;
		current && current !== root;
		current = current.parentElement
	) {
		if (PARAGRAPH_TAG_SET.has(current.tagName)) return current;
	}
	return root;
}

/** The inline code or link-chip label a text node sits in: a word never runs across its edge. */
function atomOf(text: Text, paragraph: Element): Element | null {
	const atom =
		text.parentElement?.closest("code, .source-link-chip__label") ?? null;
	return atom && paragraph.contains(atom) ? atom : null;
}

function collectParagraphs(
	root: Element,
	readBlock: Element | null,
): Paragraph[] {
	const paragraphs: Paragraph[] = [];
	let current: Paragraph | null = null;
	let gap = false;

	const addText = (text: Text) => {
		if (text.data.length === 0) return;
		const parent = text.parentElement ?? root;
		const element = nearestParagraph(parent, root);
		if (
			current === null ||
			current.element !== element ||
			current.code !== null
		) {
			current = {
				element,
				chars: [],
				map: [],
				atoms: [],
				heading: HEADING.test(element.tagName),
				code: null,
			};
			paragraphs.push(current);
		} else if (gap) {
			current.chars.push(" ");
			current.map.push(null);
			current.atoms.push(null);
		}
		gap = false;
		const atom = atomOf(text, element);
		for (let offset = 0; offset < text.data.length; offset++) {
			current.chars.push(text.data.charAt(offset));
			current.map.push({ node: text, offset });
			current.atoms.push(atom);
		}
	};

	const addCode = (block: Element) => {
		current = null;
		const pre = block.tagName === "PRE" ? block : block.querySelector("pre");
		if (!pre) return;
		const paragraph: Paragraph = {
			element: block,
			chars: [],
			map: [],
			atoms: [],
			heading: false,
			code: block.getAttribute("data-language") ?? "",
		};
		const walker = pre.ownerDocument.createTreeWalker(
			pre,
			NodeFilter.SHOW_TEXT,
		);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const text = node as Text;
			for (let offset = 0; offset < text.data.length; offset++) {
				paragraph.chars.push(text.data.charAt(offset));
				paragraph.map.push({ node: text, offset });
				paragraph.atoms.push(null);
			}
		}
		const lines = paragraph.chars
			.join("")
			.split("\n")
			.filter((line) => line.trim() !== "").length;
		const chosen =
			readBlock !== null &&
			(block === readBlock ||
				block.contains(readBlock) ||
				readBlock.contains(block));
		if (lines > 0 && (lines <= CODE_BLOCK_MAX_LINES || chosen))
			paragraphs.push(paragraph);
	};

	const walk = (node: Node) => {
		for (let child = node.firstChild; child; child = child.nextSibling) {
			if (child.nodeType === Node.TEXT_NODE) {
				addText(child as Text);
				continue;
			}
			if (child.nodeType !== Node.ELEMENT_NODE) continue;
			const element = child as Element;
			if (element.tagName === "BR" || element.matches(SKIPPED_SELECTOR)) {
				gap = true;
				continue;
			}
			if (isCodeBlock(element)) {
				addCode(element);
				continue;
			}
			if (element.tagName === "DETAILS" && !element.hasAttribute("open")) {
				for (let part = element.firstChild; part; part = part.nextSibling) {
					if (
						part.nodeType === Node.ELEMENT_NODE &&
						(part as Element).tagName === "SUMMARY"
					)
						walk(part);
					else gap = true;
				}
				continue;
			}
			walk(element);
		}
	};

	walk(root);
	return paragraphs;
}

// ---------------------------------------------------------------------------
// The spoken view: characters replaced by spaces, never removed, so every offset holds
// ---------------------------------------------------------------------------

/** Where a formula read as simple math sits in a paragraph: one `math` word, its spaces and all. */
type MathSpan = { start: number; end: number };

/**
 * What is said of a paragraph (`view`), the formulas in it read as simple math
 * (`math`), and the view with those formulas blanked too, to tell its language by
 * (`detect`). A formula that is not simple math is blanked in both, as it always was.
 */
function spokenView(paragraph: Paragraph): {
	view: string;
	detect: string;
	math: MathSpan[];
} {
	const chars = [...paragraph.chars];
	const text = chars.join("");
	const math: MathSpan[] = [];
	const blank = (from: number, to: number) => {
		for (let i = from; i < to; i++) chars[i] = " ";
	};
	const formula = (from: number, to: number) => {
		if (isSimpleMath(text.slice(from, to))) math.push({ start: from, end: to });
		else blank(from, to);
	};
	const touchesCode = (from: number, to: number) => {
		for (let i = from; i < to; i++)
			if (paragraph.atoms[i]?.tagName === "CODE") return true;
		return false;
	};
	for (const pattern of [EMOJI, ENTITY]) {
		for (const match of text.matchAll(pattern))
			blank(match.index, match.index + match[0].length);
	}
	if (paragraph.code === null) {
		// Citation and footnote marks first: "[^note]" is never a formula.
		const marks: MathSpan[] = [];
		for (const match of text.matchAll(CITATION)) {
			const end = match.index + match[0].length;
			if (touchesCode(match.index, end)) continue;
			blank(match.index, end);
			marks.push({ start: match.index, end });
		}
		const taken = (start: number, end: number) =>
			[...marks, ...math].some((span) => span.start < end && start < span.end);
		for (const match of text.matchAll(TEX_DOLLARS)) {
			const end = match.index + match[0].length;
			if (
				TEX_SPECIAL.test(match[0]) &&
				!touchesCode(match.index, end) &&
				!taken(match.index, end)
			)
				formula(match.index, end);
		}
		for (const pattern of [TEX_BRACKETS, TEX_PLAIN_BRACKETS]) {
			for (const match of text.matchAll(pattern)) {
				const end = match.index + match[0].length;
				if (!touchesCode(match.index, end) && !taken(match.index, end))
					formula(match.index, end);
			}
		}
		// Plain arithmetic: read as math when it is, else left to the prose's own reading.
		for (const match of text.matchAll(ARITHMETIC)) {
			const end = match.index + match[0].length;
			const before = text.slice(
				Math.max(0, match.index - ARITHMETIC_REACH),
				match.index,
			);
			const after = text.slice(end, end + ARITHMETIC_REACH);
			if (
				ARITHMETIC_SIGN.test(match[0]) &&
				!ARITHMETIC_GOES_ON_BEFORE.test(before) &&
				!ARITHMETIC_GOES_ON_AFTER.test(after) &&
				!touchesCode(match.index, end) &&
				!taken(match.index, end) &&
				isSimpleMath(match[0])
			)
				math.push({ start: match.index, end });
		}
	}
	math.sort((a, b) => a.start - b.start);
	const view = chars.join("");
	const detect = [...chars];
	for (const span of math)
		for (let i = span.start; i < span.end; i++) detect[i] = " ";
	return { view, detect: detect.join(""), math };
}

/** The word spans of [from, to), each formula in `math` one span, its spaces and all. */
function spansWithMath(
	view: string,
	atoms: ReadonlyArray<Element | null>,
	math: readonly MathSpan[],
): Array<{ start: number; end: number; math: boolean }> {
	const spans: Array<{ start: number; end: number; math: boolean }> = [];
	let from = 0;
	for (const span of math) {
		if (span.start < from) continue;
		for (const word of wordSpans(view, atoms, from, span.start))
			spans.push({ ...word, math: false });
		spans.push({ start: span.start, end: span.end, math: true });
		from = span.end;
	}
	for (const word of wordSpans(view, atoms, from, view.length))
		spans.push({ ...word, math: false });
	return spans;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** Runs of non-whitespace in [from, to), split where inline code or a chip label starts or ends. */
function wordSpans(
	view: string,
	atoms: ReadonlyArray<Element | null>,
	from: number,
	to: number,
) {
	const spans: Array<{ start: number; end: number }> = [];
	let start = -1;
	for (let i = from; i < to; i++) {
		const space = WHITESPACE.test(view.charAt(i));
		if (start >= 0 && (space || atoms[i] !== atoms[start])) {
			spans.push({ start, end: i });
			start = -1;
		}
		if (!space && start < 0) start = i;
	}
	if (start >= 0) spans.push({ start, end: to });
	return spans;
}

function makeRange(
	paragraph: Paragraph,
	start: number,
	end: number,
): Range | null {
	const first = paragraph.map[start];
	const last = paragraph.map[end - 1];
	if (!first || !last) return null;
	const range = first.node.ownerDocument.createRange();
	range.setStart(first.node, first.offset);
	range.setEnd(last.node, last.offset + 1);
	return range;
}

const lastToken = (word: DraftWord) =>
	word.tokens[word.tokens.length - 1] ?? "";

/** The session route refuses a token over 80 characters, so a mark that would pass it is left off. */
const MAX_TOKEN_CHARS = 80;

function setLastToken(word: DraftWord, token: string) {
	if (token.length <= MAX_TOKEN_CHARS)
		word.tokens[word.tokens.length - 1] = token;
}

/** Ends the word's last token with `mark` unless it already pauses. */
function addPause(word: DraftWord | undefined, mark: string) {
	if (!word) return;
	const token = lastToken(word);
	if (!ENDS_IN_PAUSE.test(token)) setLastToken(word, token + mark);
}

/** A stray word's closing marks go on the word before it ("now [1]." reads "now."). */
function handMarks(word: DraftWord | undefined, shown: string) {
	if (!word) return;
	let marks = (shown.match(HANDED_MARKS) ?? []).join("");
	let token = lastToken(word);
	while (marks.length > 0 && token.endsWith(marks.charAt(0)))
		marks = marks.slice(1);
	if (marks.length > 0) token += marks;
	setLastToken(word, token);
}

/**
 * A bare address shows in a chat reply as a chip labelled with its host; it is read by its site
 * name, from the address the reply wrote (scheme and host, whose letters the containment check finds).
 */
function chipAddress(label: Element): string | null {
	const chip = label.closest("a.source-link-chip");
	const href = chip?.getAttribute("href");
	if (!href) return null;
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	// The host as the reply writes it: marked percent-encodes the href, and URL gives a
	// Unicode host as punycode ("xn--bcher-kva.de"), whose letters the reply does not
	// hold (early review R4). A login before the host is left out.
	let written = href;
	try {
		written = decodeURI(href);
	} catch {
		// A malformed escape: the href as it stands.
	}
	const host =
		/^https?:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(written)?.[1] ?? url.hostname;
	const bare = (name: string) => name.replace(/^www\./i, "").toLowerCase();
	const shown = (label.textContent ?? "").trim().toLowerCase();
	if (shown !== bare(url.hostname) && shown !== bare(host)) return null;
	// GFM links a bare `www.` address as `http://www.…`: its letters are the `www.` part.
	return url.protocol === "http:" && /^www\./i.test(host)
		? host
		: `${url.protocol}//${host}`;
}

function firstWordOf(text: string): string {
	return text.trim().split(/\s+/u)[0] ?? "";
}

function listNumberOf(
	paragraph: Paragraph,
	numbered: Set<Element>,
): { item: Element; shown: string } | null {
	const item = paragraph.element.closest("li");
	if (!item || numbered.has(item) || item.parentElement?.tagName !== "OL")
		return null;
	if (!item.contains(paragraph.element) && item !== paragraph.element)
		return null;
	const list = item.parentElement;
	const start = Number.parseInt(list.getAttribute("start") ?? "1", 10);
	const index = [...list.children]
		.filter((child) => child.tagName === "LI")
		.indexOf(item);
	return { item, shown: `${(Number.isFinite(start) ? start : 1) + index}.` };
}

function proseWords(
	paragraph: Paragraph,
	view: string,
	math: readonly MathSpan[],
	language: Voiced,
	numbered: Set<Element>,
): DraftWord[] {
	const words: DraftWord[] = [];
	for (const span of spansWithMath(view, paragraph.atoms, math)) {
		const { start, end } = span;
		const atom = span.math ? null : (paragraph.atoms[start] ?? null);
		const inCode = atom?.tagName === "CODE";
		const kind: WordKind = span.math
			? "math"
			: inCode && atom
				? codeKindOf("", firstWordOf(atom.textContent ?? ""))
				: "prose";
		let shown = view.slice(start, end);
		if (kind === "prose" && isSeparator(shown)) {
			addPause(words[words.length - 1], ",");
			continue;
		}
		if (atom && !inCode) shown = chipAddress(atom) ?? shown;
		const tokens = speakWord(shown, kind, language);
		if (tokens.length === 0) {
			if (kind === "prose" && !LETTER_OR_DIGIT.test(shown))
				handMarks(words[words.length - 1], shown);
			continue;
		}
		const range = makeRange(paragraph, start, end);
		if (!range) continue;
		words.push({
			shown,
			kind,
			tokens,
			range,
			start,
			heading: paragraph.heading,
		});
	}
	const first = words[0];
	const number = first ? listNumberOf(paragraph, numbered) : null;
	if (first && number) {
		const tokens = speakWord(number.shown, "listNumber", language);
		if (tokens.length > 0) {
			numbered.add(number.item);
			words.unshift({
				shown: number.shown,
				kind: "listNumber",
				tokens,
				range: first.range,
				start: first.start,
				heading: false,
			});
		}
	}
	const last = words[words.length - 1];
	if (paragraph.heading && last && !ENDS_A_HEADING.test(lastToken(last)))
		setLastToken(last, `${lastToken(last)}.`);
	return words;
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

/** Sentence starts in a prose paragraph: Intl.Segmenter's boundaries, less those after a number or an abbreviation. */
function sentenceStarts(view: string, language: Voiced): number[] {
	const starts = [0];
	if (typeof Intl.Segmenter !== "function") return starts;
	for (const segment of new Intl.Segmenter(language, {
		granularity: "sentence",
	}).segment(view)) {
		if (segment.index === 0) continue;
		if (!keepsSentenceOpen(view.slice(0, segment.index), language))
			starts.push(segment.index);
	}
	return starts;
}

/** A written full stop is kept: "etc." read as "et cetera" still ends its sentence. */
function keepFullStop(words: DraftWord[]) {
	const last = words[words.length - 1];
	if (last?.shown.endsWith(".") && !lastToken(last).endsWith("."))
		setLastToken(last, `${lastToken(last)}.`);
}

function proseDrafts(
	paragraph: Paragraph,
	view: string,
	math: readonly MathSpan[],
	language: Voiced,
	unit: string,
	numbered: Set<Element>,
): Draft[] {
	const words = proseWords(paragraph, view, math, language, numbered);
	if (words.length === 0) return [];
	const starts = sentenceStarts(view, language);
	const groups = new Map<number, DraftWord[]>();
	for (const word of words) {
		let segment = 0;
		for (const start of starts) if (start <= word.start) segment = start;
		const group = groups.get(segment);
		if (group) group.push(word);
		else groups.set(segment, [word]);
	}
	const drafts: Draft[] = [];
	for (const group of groups.values()) {
		keepFullStop(group);
		drafts.push({
			language,
			paragraphStart: drafts.length === 0,
			words: group,
			unit,
		});
	}
	return drafts;
}

function codeDrafts(
	paragraph: Paragraph,
	view: string,
	blockLanguage: string,
	language: Voiced,
	unit: string,
): Draft[] {
	const drafts: Draft[] = [];
	let lineStart = 0;
	view.split("\n").forEach((line, lineIndex) => {
		const from = lineStart;
		lineStart += line.length + 1;
		if (line.trim() === "") return;
		const kind = codeKindOf(blockLanguage, firstWordOf(line));
		const words: DraftWord[] = [];
		for (const { start, end } of wordSpans(
			view,
			paragraph.atoms,
			from,
			from + line.length,
		)) {
			const shown = view.slice(start, end);
			const tokens = speakWord(shown, kind, language);
			const range = tokens.length > 0 ? makeRange(paragraph, start, end) : null;
			if (range)
				words.push({ shown, kind, tokens, range, start, heading: false });
		}
		if (words.length > 0)
			drafts.push({
				language,
				paragraphStart: drafts.length === 0,
				words,
				unit: `${unit}:${lineIndex}`,
			});
	});
	return drafts;
}

const tokenCount = (draft: Draft) =>
	draft.words.reduce((sum, word) => sum + word.tokens.length, 0);

/** Joins b onto a; across a paragraph or a code line the pause survives: "." after a heading, "," after anything else. */
function join(a: Draft, b: Draft): Draft {
	if (a.unit !== b.unit) {
		const last = a.words[a.words.length - 1];
		addPause(last, last?.heading ? "." : ",");
	}
	return { ...a, words: [...a.words, ...b.words], unit: b.unit };
}

/** A sentence of fewer than three tokens joins the next one of its language, or else the one before. */
function mergeShort(drafts: readonly Draft[]): Draft[] {
	const out: Draft[] = [];
	for (const draft of drafts) {
		const previous = out[out.length - 1];
		if (
			previous &&
			tokenCount(previous) < SHORT_SENTENCE_TOKENS &&
			previous.language === draft.language
		) {
			out[out.length - 1] = join(previous, draft);
		} else {
			out.push(draft);
		}
	}
	for (let i = 1; i < out.length; ) {
		const draft = out[i] as Draft;
		const previous = out[i - 1] as Draft;
		if (
			tokenCount(draft) < SHORT_SENTENCE_TOKENS &&
			previous.language === draft.language
		) {
			out[i - 1] = join(previous, draft);
			out.splice(i, 1);
		} else {
			i++;
		}
	}
	return out;
}

const textLength = (words: readonly DraftWord[]) => {
	const tokens = words.flatMap((word) => word.tokens);
	return (
		tokens.reduce((sum, token) => sum + token.length, 0) +
		Math.max(tokens.length - 1, 0)
	);
};

/**
 * A sentence over {@link LONG_SENTENCE_CHARS} splits after the last word that ends in "," or ";" and
 * keeps the first part within the limit, else after the last word that keeps it within; a word is
 * never split. A cut that would leave a part of fewer than three tokens is taken only when no other fits.
 */
function splitLong(drafts: readonly Draft[]): Draft[] {
	const out: Draft[] = [];
	for (const draft of drafts) {
		let words = draft.words;
		let first = true;
		while (textLength(words) > LONG_SENTENCE_CHARS && words.length > 1) {
			const cut = chooseCut(words);
			out.push({
				...draft,
				words: words.slice(0, cut + 1),
				paragraphStart: first && draft.paragraphStart,
				continues: !first,
			});
			words = words.slice(cut + 1);
			first = false;
		}
		out.push({
			...draft,
			words,
			paragraphStart: first && draft.paragraphStart,
			continues: !first,
		});
	}
	return out;
}

function chooseCut(words: readonly DraftWord[]): number {
	const total = words.reduce((sum, word) => sum + word.tokens.length, 0);
	let pause = -1;
	let fits = -1;
	let pauseAny = -1;
	let fitsAny = -1;
	let length = -1;
	let before = 0;
	for (let k = 0; k < words.length - 1; k++) {
		const word = words[k] as DraftWord;
		length += 1 + word.tokens.join(" ").length;
		before += word.tokens.length;
		if (length > LONG_SENTENCE_CHARS) break;
		const pauses = /[,;]$/u.test(lastToken(word));
		fitsAny = k;
		if (pauses) pauseAny = k;
		// Both parts keep at least three tokens: the voice misfires on one or two words.
		if (
			before >= SHORT_SENTENCE_TOKENS &&
			total - before >= SHORT_SENTENCE_TOKENS
		) {
			fits = k;
			if (pauses) pause = k;
		}
	}
	for (const cut of [pause, fits, pauseAny, fitsAny]) if (cut >= 0) return cut;
	return 0;
}

function finish(drafts: readonly Draft[]): ScriptSentence[] {
	let charStart = 0;
	return drafts.map((draft, index) => {
		const words = draft.words.map(({ shown, kind, tokens, range }) => ({
			shown,
			kind,
			tokens,
			range,
		}));
		const tokens = words.flatMap((word) => word.tokens);
		const ranges = words.flatMap((word) => word.tokens.map(() => word.range));
		const text = tokens.join(" ");
		const sentence: ScriptSentence = {
			id: `s${index}`,
			index,
			language: draft.language,
			paragraphStart: draft.paragraphStart,
			continues: draft.continues === true,
			words,
			tokens,
			ranges,
			text,
			charStart,
			chars: text.length + 1,
		};
		charStart += sentence.chars;
		return sentence;
	});
}
