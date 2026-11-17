// The containment check: a reading may speak only what the reply says (spec
// §6.1). The session route is not a free text-to-speech service, so every
// written word of a request must occur in the reply's text, in order, and its
// tokens must be the shared dictionary's reading of it.

import { decodeHTMLStrict } from "entities";
import {
	addressHost,
	speakWord,
	type WordKind,
} from "$lib/shared/read-aloud/spoken-forms";

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

const FENCE = /^ {0,3}(`{3,}|~{3,})/u;

/**
 * Text outside code with what the renderer never shows taken out: HTML comments,
 * HTML tags and link destinations. They sit between the words, but also inside
 * one (`Ctrl+<kbd>C</kbd>`, `H<sub>2</sub>O`, `[README](docs/README.md)-ben`),
 * where their letters would split the word the screen shows. Inline code keeps
 * its tags, as the screen does: `<div>` in ticks is the letters "div".
 */
function stripInline(text: string): string {
	const strip = (part: string): string =>
		part
			.replace(/<!--[\s\S]*?-->/gu, "")
			.replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/gu, "")
			.replace(/\]\([^)]*\)/gu, "]");
	let out = "";
	let from = 0;
	while (from < text.length) {
		const tick = text.indexOf("`", from);
		if (tick === -1) return out + strip(text.slice(from));
		out += strip(text.slice(from, tick));
		let end = tick;
		while (text[end] === "`") end += 1;
		const run = text.slice(tick, end);
		const close = text.indexOf(run, end);
		// A run of ticks with no match is text.
		const stop = close === -1 ? end : close + run.length;
		out += text.slice(tick, stop);
		from = stop;
	}
	return out;
}

/** The Markdown with `stripInline` applied outside fenced code, which is kept as it is. */
function stripMarkup(markdown: string): string {
	let out = "";
	let plain = "";
	let fence: string | null = null;
	for (const line of markdown.split("\n")) {
		const mark = FENCE.exec(line)?.[1];
		if (fence !== null) {
			out += `${line}\n`;
			// The closing fence: the same character, at least as many, nothing after.
			if (
				mark &&
				mark[0] === fence[0] &&
				mark.length >= fence.length &&
				line.trim() === mark
			)
				fence = null;
		} else if (mark) {
			out += `${stripInline(plain)}${line}\n`;
			plain = "";
			fence = mark;
		} else plain += `${line}\n`;
	}
	return out + stripInline(plain);
}

/**
 * The letter key of the reply's Markdown, after its entities are decoded the way
 * the browser decodes them: `decodeHTMLStrict` knows the whole HTML5 table, the
 * Windows-1252 rule for 128 to 159 and that an entity needs its semicolon. The
 * renderer passes an entity through, so the screen shows what it decodes to.
 * The markup that sits inside a word is taken out first (`stripMarkup`); what is
 * left between words only puts letters there, and the search steps over them.
 */
export function replyKey(markdown: string): string {
	// Strip first: "&lt;kbd&gt;" decodes to text that is shown, not to a tag.
	return letterKey(decodeHTMLStrict(stripMarkup(markdown)));
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
				// A prose word that is an address is spoken as its host alone, and the
				// page may show it only so (a source chip). A code word also speaks
				// the names around its address, so it is searched whole.
				const host = word.kind === "prose" ? addressHost(word.shown) : null;
				const key = letterKey(host ?? word.shown);
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
