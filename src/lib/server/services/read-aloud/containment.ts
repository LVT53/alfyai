// The containment check: a reading may speak only what the reply says (spec
// §6.1). The session route is not a free text-to-speech service, so every
// written word of a request must occur in the reply's text, in order, and its
// tokens must be the shared dictionary's reading of it.

import { speakWord, type WordKind } from "$lib/shared/read-aloud/spoken-forms";

/** A word as the browser sends it. */
export type CheckedWord = {
	shown: string;
	kind: WordKind;
	tokens: readonly string[];
};

const LIST_NUMBER = /^\d{1,4}[.)]$/u;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

/** The letters and digits of a text, NFKC-normalised and lower-cased, and nothing else. */
export function letterKey(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]/gu, "");
}

function isCodePoint(code: number): boolean {
	return (
		Number.isInteger(code) &&
		code >= 0 &&
		code <= 0x10ffff &&
		!(code >= 0xd800 && code <= 0xdfff)
	);
}

function decodeEntities(text: string): string {
	return text.replace(
		/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/gu,
		(match, decimal?: string, hex?: string, name?: string) => {
			if (name) return NAMED_ENTITIES[name] ?? match;
			const code =
				decimal !== undefined
					? Number(decimal)
					: Number.parseInt(hex ?? "", 16);
			return isCodePoint(code) ? String.fromCodePoint(code) : match;
		},
	);
}

/**
 * The letter key of the reply's Markdown, after its numeric entities and the
 * six named ones are decoded. Nothing else is cleaned away: link destinations,
 * image syntax and tags only put letters between the words, and the search
 * steps over them.
 */
export function replyKey(markdown: string): string {
	return letterKey(decodeEntities(markdown));
}

/**
 * Walks the words of every sentence in order. A word that is not a list number
 * has its letters found in the reply at or after where the previous word's
 * letters ended (a word with no letters counts as found); a list number is not
 * searched, because the renderer numbers a list and Markdown may write "1." for
 * every item, but it must look like one. Every word's tokens must read, ignoring
 * the pause marks the script adds, as the dictionary reads its written form.
 * Returns null when every word passes, else the index of the first sentence
 * that holds a word that does not.
 */
export function wordsFitReply(
	replyMarkdown: string,
	sentences: ReadonlyArray<{
		language: "en" | "hu";
		words: readonly CheckedWord[];
	}>,
): number | null {
	const reply = replyKey(replyMarkdown);
	let cursor = 0;
	for (let index = 0; index < sentences.length; index++) {
		const sentence = sentences[index];
		if (!sentence) continue;
		for (const word of sentence.words) {
			if (word.kind === "listNumber") {
				if (!LIST_NUMBER.test(word.shown)) return index;
			} else {
				const key = letterKey(word.shown);
				if (key !== "") {
					const at = reply.indexOf(key, cursor);
					if (at === -1) return index;
					cursor = at + key.length;
				}
			}
			const expected = speakWord(word.shown, word.kind, sentence.language);
			if (letterKey(word.tokens.join(" ")) !== letterKey(expected.join(" ")))
				return index;
		}
	}
	return null;
}
