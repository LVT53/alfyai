// The containment check: a reading may speak only what the reply says (spec
// §6.1). The session route is not a free text-to-speech service, so every
// written word of a request must occur in the reply's text, in order, and its
// tokens must be the shared dictionary's reading of it.

import { decodeHTMLStrict } from "entities";
import { speakWord, type WordKind } from "$lib/shared/read-aloud/spoken-forms";

/** A word as the browser sends it. */
export type CheckedWord = {
	shown: string;
	kind: WordKind;
	tokens: readonly string[];
};

const LIST_NUMBER = /^\d{1,4}[.)]$/u;

/** The letters and digits of a text, NFKC-normalised and lower-cased, and nothing else. */
export function letterKey(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * The letter key of the reply's Markdown, after its entities are decoded the way
 * the browser decodes them: `decodeHTMLStrict` knows the whole HTML5 table, the
 * Windows-1252 rule for 128 to 159 and that an entity needs its semicolon. The
 * renderer passes an entity through, so the screen shows what it decodes to.
 * Nothing else is cleaned away: link destinations, image syntax and tags only
 * put letters between the words, and the search steps over them.
 */
export function replyKey(markdown: string): string {
	return letterKey(decodeHTMLStrict(markdown));
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
