/**
 * The speech script: what read aloud says, built from the reply as rendered
 * on screen (spec §4.4), never from its Markdown, so no syntax reaches the
 * voice. A reply becomes paragraphs, paragraphs become sentences, and each
 * written word keeps its DOM `Range` and the tokens it is spoken as. The
 * tokens come only from the shared reading dictionary (`speakWord`), which the
 * session route checks them with.
 */

import { MAX_SHOWN_CHARS } from "$lib/shared/read-aloud/session-limits";
import {
	codeKindOf,
	isSeparator,
	isSimpleMath,
	keepsSentenceOpen,
	MAX_TOKEN_CHARS,
	speakWord,
	type WordKind,
} from "$lib/shared/read-aloud/spoken-forms";
import { assignLanguages, type Detect, isVoiced } from "./language";
import { ENDS_IN_PAUSE, joinShortSentences } from "./short-sentences";

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
 * A sentence longer than this, as it is sent (with the stop that closes it), is split. Measured on
 * the box (2026-11-16): it keeps every clip under 30 s even at the slowest Pace, so the aligner
 * never enters its long-form mode.
 */
export const LONG_SENTENCE_CHARS = 240;

/** Zonos misfires on inputs of one or two words. */
const SHORT_SENTENCE_TOKENS = 3;

const PARAGRAPH_TAG_SET: ReadonlySet<string> = new Set(PARAGRAPH_TAGS);
const HEADING = /^H[1-6]$/;
const WHITESPACE = /\s/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const LETTERS = /\p{L}/gu;
const LETTER = /\p{L}/u;
/** Marks a stray word hands to the word before it: what ends a clause or closes something. */
const HANDED_MARKS = /[.,;:!?…)\]}"'”’»]/gu;
const ENDS_A_HEADING = /[.!?…:]$/u;
/** The brackets that set a parenthetical off, at the start of its first word and at the end of its last. */
const OPENING_BRACKETS = /^[([]+/u;
const CLOSING_BRACKETS = /([)\]]+)([.,;:!?…"'”’»]*)$/u;

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
 * other than "-", "–" and "/" (`ARITHMETIC_SIGN`): between two numbers alone, those are a
 * range or a date ("2026 - 2027"), and an en dash there is the dash's pause. In a sum an
 * en dash is a minus ("12 – 5 = 7"), never the dash's pause (Track A's dashes, merged).
 */
const ARITHMETIC_OPERAND = String.raw`(?:[-\u2212]?[€£]?\d+(?:[.,]\d+)*(?:[ \u00a0\u202f]?[%€£])?|[A-Za-z])`;
const ARITHMETIC_RUN = String.raw`${ARITHMETIC_OPERAND}(?:\s+[-\u2212\u2013+×·÷/=≈≠*]\s+${ARITHMETIC_OPERAND})+`;
const ARITHMETIC = new RegExp(
	String.raw`(?<![\p{L}\p{N}_.,€£])(?:\(${ARITHMETIC_RUN}\)|${ARITHMETIC_RUN})(?![\p{L}\p{N}_€£%])`,
	"gu",
);
const ARITHMETIC_SIGN = /\s[+×·÷=≈≠*\u2212]\s/u;
/**
 * A sum that touches another spaced operator goes on past what can be read ("total =
 * 3 + 4", "2x - 3 = 7"): the whole of it is left to the prose's reading, as before,
 * never its tail alone. A "-", "–" or "/" counts only beside a word with a digit in it:
 * beside a plain word it is a dash ("3 + 4 = 7 - that is all").
 */
const ARITHMETIC_GOES_ON_BEFORE =
	/(?:[+×·÷=≈≠*\u2212]|(?:^|\s)\S*\p{N}\S*\s+[-\u2013/])\s+$/u;
const ARITHMETIC_GOES_ON_AFTER =
	/^\s+(?:[+×·÷=≈≠*\u2212](?:\s|$)|[-\u2013/]\s+\S*\p{N})/u;
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
	/** The list the draft's last part is an item of (the items of one list share the key), or null outside a list. */
	list: string | null;
	/** A line of a code block, or a draft that holds one: the short-sentence join leaves it alone. */
	code: boolean;
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
	const lists = new Map<Element, string>();
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
						lists,
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

	const sentences = finish(
		closeSentences(
			// One character of room is left for the stop that closes a unit, so `splitLong` never
			// has to cut a unit the join has made.
			splitLong(
				joinShortSentences(mergeShort(drafts), LONG_SENTENCE_CHARS - 1),
			),
		),
	);
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
	let measured = false;
	for (const sentence of script.sentences) {
		const first = sentence.ranges[0];
		const last = sentence.ranges[sentence.ranges.length - 1];
		if (!first || !last) continue;
		const start = comparePoint(first, node, offset);
		if (start === null) continue;
		measured = true;
		if (start < 0) return sentence.index;
		const end = last.cloneRange();
		end.collapse(false);
		const after = comparePoint(end, node, offset);
		if (after !== null && after < 0) return sentence.index;
	}
	// A point after the last word (a trailing emoji or space, the end of the reply): the
	// nearest sentence to read from is the last one, not none (early review R23). A point
	// that could not be placed against any sentence is not in this reply.
	return measured ? (script.sentences.at(-1)?.index ?? null) : null;
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
	// What separates the words on either side of a tag that is not read: a space, or a line
	// feed for a `<br>`, which the chat draws as a line break (`breaks: true`), so that
	// "Name: John<br>Age: 42" is two sentences and each line gets its own pause (early review R18).
	let gap: " " | "\n" | null = null;

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
			current.chars.push(gap);
			current.map.push(null);
			current.atoms.push(null);
		}
		gap = null;
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
			if (element.tagName === "BR") {
				gap = "\n";
				continue;
			}
			if (element.matches(SKIPPED_SELECTOR)) {
				gap ??= " ";
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
					else gap ??= " ";
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

/** How many generic brackets `text` leaves open: a `<` straight after a name opens one, a `>` closes one. */
function openGenerics(text: string): number {
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charAt(i);
		if (c === "<" && i > 0 && /[\p{L}\p{Nd}_$]/u.test(text.charAt(i - 1)))
			depth += 1;
		else if (c === ">" && depth > 0) depth -= 1;
	}
	return depth;
}

/** A merged generic never grows past this many characters. */
const MAX_GENERIC_CHARS = 200;

/**
 * The spans with a generic's arguments the page splits at a space made one: `Map<K,` and `V>` are
 * one code name, so the dictionary reads `Map of K V` (and the marker covers `Map<K, V>`). A span
 * that leaves a generic open and ends in a comma takes the span after it, while both are the
 * same code (an inline code element, or a code block's line) and the brackets stay open; a
 * comparison ("a < b, c > d") opens none (early review R6).
 */
function joinGenerics<S extends { start: number; end: number }>(
	spans: readonly S[],
	view: string,
	atoms: ReadonlyArray<Element | null>,
	inlineCodeOnly: boolean,
): S[] {
	const out: S[] = [];
	for (let i = 0; i < spans.length; i++) {
		let span = spans[i] as S;
		const code = atoms[span.start];
		if (inlineCodeOnly && code?.tagName !== "CODE") {
			out.push(span);
			continue;
		}
		for (;;) {
			const next = spans[i + 1];
			const text = view.slice(span.start, span.end);
			if (
				!next ||
				!text.endsWith(",") ||
				("math" in next && next.math === true) ||
				atoms[next.start] !== code ||
				next.end - span.start > MAX_GENERIC_CHARS ||
				openGenerics(text) === 0
			)
				break;
			span = { ...span, end: next.end };
			i += 1;
		}
		out.push(span);
	}
	return out;
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

/** The session route refuses a token over `MAX_TOKEN_CHARS`, so a mark that would pass it is left off. */
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
 * A lone hyphen between words is a dash ("eggs - one at a time - and"), said as a pause; between
 * two numbers it may be a minus, and stays unsaid.
 */
function isSpacedHyphen(
	shown: string,
	view: string,
	spans: ReadonlyArray<{ start: number; end: number }>,
	index: number,
): boolean {
	if (shown !== "-") return false;
	const before = spans[index - 1];
	const after = spans[index + 1];
	return (
		(before !== undefined && LETTER.test(view.charAt(before.end - 1))) ||
		(after !== undefined && LETTER.test(view.charAt(after.start)))
	);
}

/**
 * A parenthetical is said as words set off by pauses, as a reader says it: "the eggs (one at a
 * time) and" is "the eggs, one at a time, and". The word before the opening bracket takes a comma,
 * the brackets themselves are not said, and the word that closes it takes a comma unless a mark
 * ends it already or nothing follows. A bracket that opens nothing ("1)"), and the brackets inside
 * a word ("run()") stay as written, as do those of code.
 */
function setOffBrackets(words: DraftWord[]) {
	let depth = 0;
	words.forEach((word, index) => {
		if (word.kind !== "prose") return;
		const first = word.tokens[0] ?? "";
		const opens = OPENING_BRACKETS.exec(first)?.[0].length ?? 0;
		if (opens > 0) {
			depth += opens;
			word.tokens[0] = first.slice(opens);
			addPause(words[index - 1], ",");
		}
		const lastIndex = word.tokens.length - 1;
		const last = word.tokens[lastIndex] ?? "";
		const closing = CLOSING_BRACKETS.exec(last);
		if (!closing || depth === 0) return;
		const brackets = closing[1] ?? "";
		const marks = closing[2] ?? "";
		const closed = Math.min(brackets.length, depth);
		depth -= closed;
		word.tokens[lastIndex] =
			last.slice(0, last.length - closing[0].length) +
			brackets.slice(0, brackets.length - closed) +
			marks;
		if (marks === "" && index < words.length - 1) addPause(word, ",");
	});
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
	const spans = joinGenerics(
		spansWithMath(view, paragraph.atoms, math),
		view,
		paragraph.atoms,
		true,
	);
	for (const [index, span] of spans.entries()) {
		const { start, end } = span;
		const atom = span.math ? null : (paragraph.atoms[start] ?? null);
		const inCode = atom?.tagName === "CODE";
		const kind: WordKind = span.math
			? "math"
			: inCode && atom
				? codeKindOf("", firstWordOf(atom.textContent ?? ""))
				: "prose";
		let shown = view.slice(start, end);
		if (
			kind === "prose" &&
			(isSeparator(shown) || isSpacedHyphen(shown, view, spans, index))
		) {
			addPause(words[words.length - 1], ",");
			continue;
		}
		if (atom && !inCode) shown = chipAddress(atom) ?? shown;
		// The route refuses a request with a word written longer than this, whatever the word is read
		// as (a long address is read as its host alone): such a word is left out (early review R20).
		if (shown.length > MAX_SHOWN_CHARS) continue;
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
	setOffBrackets(words);
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
		if (
			!keepsSentenceOpen(
				view.slice(0, segment.index),
				language,
				view.slice(segment.index),
			)
		)
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

/** The list a paragraph is an item of, as the key its items share (the first paragraph of a list makes it); null outside a list. */
function listOf(
	paragraph: Paragraph,
	lists: Map<Element, string>,
): string | null {
	const list = paragraph.element.closest("li")?.parentElement;
	if (!list) return null;
	let key = lists.get(list);
	if (key === undefined) {
		key = `${lists.size}`;
		lists.set(list, key);
	}
	return key;
}

function proseDrafts(
	paragraph: Paragraph,
	view: string,
	math: readonly MathSpan[],
	language: Voiced,
	unit: string,
	numbered: Set<Element>,
	lists: Map<Element, string>,
): Draft[] {
	const words = proseWords(paragraph, view, math, language, numbered);
	if (words.length === 0) return [];
	const list = listOf(paragraph, lists);
	// A boundary the splitter finds inside one inline code element (the "!" of `!important`, the
	// "?" of a ternary) is no sentence end: the code word is read whole (early review R6).
	const starts = sentenceStarts(view, language).filter((start) => {
		const before = paragraph.atoms[start - 1];
		return !(
			start > 0 &&
			before !== null &&
			before !== undefined &&
			before === paragraph.atoms[start] &&
			before.tagName === "CODE"
		);
	});
	const groups = new Map<number, DraftWord[]>();
	for (const word of words) {
		let segment = 0;
		for (const start of starts) if (start <= word.start) segment = start;
		const group = groups.get(segment);
		if (group) group.push(word);
		else groups.set(segment, [word]);
	}
	// Each line of a paragraph a `<br>` breaks is a unit of its own, as a line of code is: the
	// short ones that join then get the pause mark a join across units makes (early review R18).
	const lineBreaks = [...view.matchAll(/\n/gu)].map((match) => match.index);
	const lineOf = (offset: number) =>
		lineBreaks.filter((at) => at < offset).length;
	const drafts: Draft[] = [];
	for (const group of groups.values()) {
		keepFullStop(group);
		const line = lineOf(group[0]?.start ?? 0);
		drafts.push({
			language,
			paragraphStart: drafts.length === 0,
			words: group,
			unit: line === 0 ? unit : `${unit}:${line}`,
			list,
			code: false,
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
		for (const { start, end } of joinGenerics(
			wordSpans(view, paragraph.atoms, from, from + line.length),
			view,
			paragraph.atoms,
			false,
		)) {
			const shown = view.slice(start, end);
			if (shown.length > MAX_SHOWN_CHARS) continue;
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
				list: null,
				code: true,
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
	return {
		...a,
		words: [...a.words, ...b.words],
		unit: b.unit,
		list: b.list,
		code: a.code || b.code,
	};
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

/** What ends a sentence for the voice, a closing quote or bracket after it allowed ("now."). An ellipsis trails off: it ends one too. */
const ENDS_A_SENTENCE = /[.!?…][)\]}"'”’»]*$/u;
/** A mark that pauses and does not end a sentence: the closing stop takes its place. */
const OPEN_MARK = /[,;:]$/u;

/** The token as `closeSentences` leaves it at the end of a unit, or null when it needs no stop or cannot take one. */
function withClosingStop(token: string): string | null {
	if (ENDS_A_SENTENCE.test(token)) return null;
	const closed = `${token.replace(OPEN_MARK, "")}.`;
	return closed.length <= MAX_TOKEN_CHARS ? closed : null;
}

const textLength = (words: readonly DraftWord[]) => {
	const tokens = words.flatMap((word) => word.tokens);
	return (
		tokens.reduce((sum, token) => sum + token.length, 0) +
		Math.max(tokens.length - 1, 0)
	);
};

/** The characters the closing stop adds to a unit that ends in `word`: one where it ends in no mark, none where the stop replaces a mark or is left off. */
function stopCost(word: DraftWord | undefined): number {
	if (!word) return 0;
	const token = lastToken(word);
	const closed = withClosingStop(token);
	return closed === null ? 0 : closed.length - token.length;
}

/** The characters a unit is sent as: its text, and the stop that closes it. */
const sentLength = (words: readonly DraftWord[]) =>
	textLength(words) + stopCost(words[words.length - 1]);

/**
 * A sentence over {@link LONG_SENTENCE_CHARS} (as it is sent, with its closing stop) splits after
 * the last word that ends in "," or ";" and keeps the first part within the limit, else after the
 * last word that keeps it within; a word is never split. A cut that would leave a part of fewer
 * than three tokens is taken only when no other fits.
 */
function splitLong(drafts: readonly Draft[]): Draft[] {
	const out: Draft[] = [];
	for (const draft of drafts) {
		let words = draft.words;
		let first = true;
		while (sentLength(words) > LONG_SENTENCE_CHARS && words.length > 1) {
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
		// The part is sent with the stop that closes it, one character more where it ends in no mark.
		if (length + stopCost(word) > LONG_SENTENCE_CHARS) continue;
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

/**
 * Every sentence the voice is sent ends in a mark that ends a sentence (the walk's Final 1,
 * 2026-11-17). Zonos can end a clip before the last words of a text that ends in no mark: "Egy
 * csipet só", the last item of a joined list, was never said, and the same text ending in a full
 * stop is. A unit that ends in no mark gets a full stop; one that ends in a comma, a semicolon
 * or a colon (the first part of a split sentence, a line that introduces what follows) has that
 * mark replaced by one. It runs last, after the joins and the splits, so every unit it is given is
 * the one that is sent. Only punctuation changes: the containment check compares letters, and the
 * token count, so every token's range, stays. A stop that would take a token past the session
 * route's limit is left off.
 */
function closeSentences(drafts: readonly Draft[]): Draft[] {
	for (const draft of drafts) {
		const last = draft.words[draft.words.length - 1];
		if (!last) continue;
		const closed = withClosingStop(lastToken(last));
		if (closed !== null) setLastToken(last, closed);
	}
	return [...drafts];
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
