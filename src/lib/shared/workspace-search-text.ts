/**
 * The one matcher Workspace Search uses, in the server and in the modal's
 * highlighting, so both read a query and a text the same way.
 *
 * SQLite's `lower()` and `LIKE` fold ASCII only, so "árvíz" never meets
 * "Árvíztűrő" there. This module folds in JavaScript instead: case and accent
 * marks are dropped per code point, and a query is a set of words that must all
 * be present, in any order, inside longer words too.
 */

export const SEARCH_MIN_QUERY_CHARS = 2;
export const SEARCH_MAX_TERMS = 8;
/**
 * A kind's count is the true number of matches up to this many, so a count at
 * the cap reads "99+".
 */
export const SEARCH_COUNT_CAP = 100;

const SEARCH_MAX_TERM_CHARS = 64;
const SNIPPET_DEFAULT_CHARS = 160;
const MARKS = /\p{M}/gu;
const EDGE_NON_WORD_CHARS = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

interface TextRange {
	start: number;
	end: number;
}

function isAscii(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) > 0x7f) return false;
	}
	return true;
}

function foldCodePoint(character: string): string {
	if (character.charCodeAt(0) < 0x80) return character.toLowerCase();
	return character.normalize("NFKD").replace(MARKS, "").toLowerCase();
}

/** Lower-cases `text` and drops its accent marks, one code point at a time. */
export function foldForSearch(text: string): string {
	if (isAscii(text)) return text.toLowerCase();
	let folded = "";
	for (const character of text) folded += foldCodePoint(character);
	return folded;
}

function trimEdges(word: string): string {
	return word.replace(EDGE_NON_WORD_CHARS, "");
}

function cutToChars(word: string, maxChars: number): string {
	if (word.length <= maxChars) return word;
	return Array.from(word).slice(0, maxChars).join("");
}

interface QueryWord {
	typed: string;
	folded: string;
}

/**
 * The query's words, each as typed (accents kept, lower case) and as folded.
 * One pass makes both lists, so `typed[i]` is always the spelling of `folded[i]`.
 */
function queryWords(query: string): QueryWord[] {
	const words: QueryWord[] = [];
	const seen = new Set<string>();
	for (const token of query.normalize("NFC").toLowerCase().split(/\s+/u)) {
		if (words.length >= SEARCH_MAX_TERMS) break;
		const typed = cutToChars(trimEdges(token), SEARCH_MAX_TERM_CHARS);
		const folded = trimEdges(foldForSearch(typed));
		if (typed === "" || folded === "" || seen.has(folded)) continue;
		seen.add(folded);
		words.push({ typed, folded });
	}
	return words;
}

/**
 * The folded words a result must all contain. An empty list means the query has
 * no words (for example "!!"), and the empty-query view is shown instead.
 */
export function searchTerms(query: string): string[] {
	return queryWords(query).map((word) => word.folded);
}

/** The same words in the same order, as typed: lower case, accents kept. */
export function typedSearchWords(query: string): string[] {
	return queryWords(query).map((word) => word.typed);
}

/** Every term occurs in `text` once folded; false when there are no terms. */
export function matchesAllTerms(
	text: string,
	terms: readonly string[],
): boolean {
	if (terms.length === 0) return false;
	const folded = foldForSearch(text);
	return terms.every((term) => folded.includes(term));
}

/**
 * `text` folded, with for each folded character the range of the original text
 * it came from. An accent mark or other code point that folds away stays inside
 * the letter before it, so a highlight never cuts a letter from its accent.
 */
function foldWithMap(text: string): {
	folded: string;
	starts: number[];
	ends: number[];
} {
	let folded = "";
	const starts: number[] = [];
	const ends: number[] = [];
	let offset = 0;
	let previousUnits = 0;
	for (const character of text) {
		const piece = foldCodePoint(character);
		const next = offset + character.length;
		if (piece === "") {
			for (
				let index = ends.length - previousUnits;
				index < ends.length;
				index++
			) {
				ends[index] = next;
			}
		} else {
			folded += piece;
			for (let index = 0; index < piece.length; index++) {
				starts.push(offset);
				ends.push(next);
			}
			previousUnits = piece.length;
		}
		offset = next;
	}
	return { folded, starts, ends };
}

/**
 * Every occurrence of every term, as ranges of the original text, sorted, with
 * the ranges that overlap or touch merged into one.
 */
export function matchRanges(
	text: string,
	terms: readonly string[],
): TextRange[] {
	const usable = terms.filter((term) => term !== "");
	if (usable.length === 0 || text === "") return [];
	const { folded, starts, ends } = foldWithMap(text);
	const found: TextRange[] = [];
	for (const term of usable) {
		for (
			let at = folded.indexOf(term);
			at !== -1;
			at = folded.indexOf(term, at + 1)
		) {
			found.push({ start: starts[at], end: ends[at + term.length - 1] });
		}
	}
	found.sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: TextRange[] = [];
	for (const range of found) {
		const last = merged[merged.length - 1];
		if (last && range.start <= last.end) {
			last.end = Math.max(last.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Up to `maxChars` characters of the original text around its earliest match,
 * whitespace folded, with "…" where the text is cut; null when nothing matches.
 */
export function searchSnippet(
	text: string,
	terms: readonly string[],
	maxChars = SNIPPET_DEFAULT_CHARS,
): string | null {
	const flat = text.replace(/\s+/g, " ").trim();
	const [first] = matchRanges(flat, terms);
	if (!first) return null;
	if (flat.length <= maxChars) return flat;
	const matchLength = Math.min(first.end - first.start, maxChars);
	let from = Math.max(
		0,
		first.start - Math.floor((maxChars - matchLength) / 2),
	);
	let to = Math.min(flat.length, from + maxChars);
	from = Math.max(0, to - maxChars);
	if (from > 0 && isLowSurrogate(flat.charCodeAt(from))) from += 1;
	if (to < flat.length && isHighSurrogate(flat.charCodeAt(to - 1))) to -= 1;
	const cut = flat.slice(from, to).trim();
	return `${from > 0 ? "…" : ""}${cut}${to < flat.length ? "…" : ""}`;
}
