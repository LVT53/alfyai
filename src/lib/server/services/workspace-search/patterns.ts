import {
	foldForSearch,
	searchSnippet,
} from "$lib/shared/workspace-search-text";

/**
 * SQL patterns for Workspace Search's candidate queries. SQLite's `LIKE` and
 * `lower()` fold ASCII only, so a word is looked for in two ways:
 *
 * - Short text (a title, a name) with `foldedGlob`: a GLOB pattern whose every
 *   letter is the class of all the letters that fold to it, so "arviz" finds
 *   "Árvíztűrő" and "ÁRVÍZ" without a schema change or a SQL function.
 * - Long text (a message, a document body) through the full-text index
 *   (`messages_fts`, `artifacts_fts`, migration 145) with `indexPhrase`, which
 *   folds case and accents itself; a word under three letters, which a trigram
 *   index cannot match, with `likeSpellings`: the word as typed, capitalised
 *   and in capitals, because LIKE compares non-ASCII letters exactly.
 *
 * Both only choose candidates. The server confirms every hit with the shared
 * matcher, so a pattern may be wider than the matcher but never narrower for
 * the letters it knows.
 */

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function capitalise(word: string): string {
	const [first = "", ...rest] = Array.from(word);
	return first.toLocaleUpperCase() + rest.join("");
}

/** The spellings a word is looked for in: as typed, capitalised, in capitals. */
export function wordSpellings(word: string): string[] {
	return Array.from(
		new Set([word, capitalise(word), word.toLocaleUpperCase()]),
	);
}

/** `LIKE` patterns, with `\` as the escape character, for each spelling. */
export function likeSpellings(word: string): string[] {
	return wordSpellings(word).map((spelling) => `%${escapeLike(spelling)}%`);
}

// Letters that fold to one character: ASCII, Latin-1 Supplement, Latin
// Extended-A and Latin Extended-B. Wider ranges would grow every pattern; a
// word is at most 64 letters and SQLite refuses a pattern over 50,000 bytes.
const CLASS_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x41, 0x5a],
	[0x61, 0x7a],
	[0xc0, 0x24f],
];

let foldClasses: Map<string, string> | null = null;

function classOf(character: string): string | undefined {
	if (!foldClasses) {
		const groups = new Map<string, Set<string>>();
		for (const [from, to] of CLASS_RANGES) {
			for (let code = from; code <= to; code++) {
				const letter = String.fromCodePoint(code);
				const folded = foldForSearch(letter);
				if (folded.length !== 1 || folded === letter) continue;
				const group = groups.get(folded) ?? new Set([folded]);
				group.add(letter);
				groups.set(folded, group);
			}
		}
		foldClasses = new Map(
			Array.from(groups, ([folded, group]) => [
				folded,
				`[${Array.from(group).join("")}]`,
			]),
		);
	}
	return foldClasses.get(character);
}

function escapeGlob(character: string): string {
	return character === "*" || character === "?" || character === "["
		? `[${character}]`
		: character;
}

/**
 * A GLOB pattern that finds `term` anywhere in a text, whatever the case and
 * accents of either. GLOB is case-sensitive, so each letter is a class of
 * every case and accent it folds from.
 */
export function foldedGlob(term: string): string {
	let pattern = "*";
	for (const character of foldForSearch(term)) {
		pattern += classOf(character) ?? escapeGlob(character);
	}
	return `${pattern}*`;
}

/** The fewest characters a trigram index can match; shorter words use `likeSpellings`. */
export const INDEX_MIN_TERM_CHARS = 3;

/** Whether a folded word is looked up in the full-text index (three characters or more). */
export function usesSearchIndex(term: string): boolean {
	return Array.from(term).length >= INDEX_MIN_TERM_CHARS;
}

/**
 * A word as one quoted `MATCH` phrase: its characters are text, never query
 * syntax (`NOT`, `NEAR(`, `*`, `^`, `:`), and a quote inside it is doubled.
 */
export function indexPhrase(term: string): string {
	return `"${term.replaceAll('"', '""')}"`;
}

const FOLD_MARKS = /\p{M}/gu;
/** Characters of the original text read on each side of a folded hit. */
const SNIPPET_WINDOW_CHARS = 600;
/** Longest text folded whole when the window misses. */
const WHOLE_FOLD_MAX_CHARS = 200_000;

/**
 * A snippet of a long text around the first place one of the words folds to,
 * for a hit the index found but no typed spelling locates (a word typed without
 * accents, or in another case). The platform folds the whole text in one pass,
 * the shared matcher then cuts the snippet from a window of the original around
 * that place; only when folding shifted positions past the window (ligatures
 * and the like) is the whole text folded with the matcher, and only when it is
 * not long. `null` when no word is there.
 */
export function foldedSnippet(
	text: string,
	terms: readonly string[],
	maxChars: number,
): string | null {
	if (text === "" || terms.length === 0) return null;
	const folded = text.normalize("NFKD").replace(FOLD_MARKS, "").toLowerCase();
	const hits = terms
		.map((term) => folded.indexOf(term))
		.filter((at) => at !== -1);
	if (hits.length > 0) {
		const at = Math.min(...hits);
		const start = Math.max(0, at - SNIPPET_WINDOW_CHARS);
		const end = Math.min(text.length, at + SNIPPET_WINDOW_CHARS);
		const snippet = searchSnippet(text.slice(start, end), terms, maxChars);
		if (snippet) {
			const before = start > 0 && !snippet.startsWith("…") ? "…" : "";
			const after = end < text.length && !snippet.endsWith("…") ? "…" : "";
			return `${before}${snippet}${after}`;
		}
	}
	return text.length <= WHOLE_FOLD_MAX_CHARS
		? searchSnippet(text, terms, maxChars)
		: null;
}
