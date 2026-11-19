// The containment check: a reading may speak only what the reply says (spec
// §6.1). The session route is not a free text-to-speech service, so every
// written word of a request must occur in the reply's text, in order, and its
// tokens must be the shared dictionary's reading of it.

import { createHash } from "node:crypto";
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
 * The letter key of a standard report's HTML (`renderers/standard-report-html.ts`,
 * read aloud's report target): the text its markup shows, with its comments,
 * scripts, styles, templates and drawings taken out and every tag with its
 * attributes (so a picture's `data:` address too), then its entities decoded as
 * the browser decodes them. The report's renderer escapes every `<` of its text,
 * so whatever looks like a tag is markup, never text. A tag is taken out without a
 * space, as `stripInline` does, so a word with markup inside it keeps its letters
 * together (`H<sub>2</sub>O`).
 */
export function reportKey(html: string): string {
	const shown = html
		.replace(/<!--[\s\S]*?-->/gu, "")
		.replace(
			/<(script|style|template|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/giu,
			"",
		)
		.replace(/<[!/?]?[A-Za-z][^<>]*>/gu, "");
	return letterKey(decodeHTMLStrict(shown));
}

type CheckedSentences = ReadonlyArray<{
	language: "en" | "hu";
	words: readonly CheckedWord[];
}>;

/** `wordsFitKey` against a reply's Markdown. */
export function wordsFitReply(
	replyMarkdown: string,
	sentences: CheckedSentences,
): number | null {
	return wordsFitKey(replyKey(replyMarkdown), sentences);
}

/**
 * A report's letter key, kept by the sha256 of its bytes (security review M4): every
 * start, jump, resume and retry of a reading checks its words against the same
 * report, which can be over 12 MB, and keying it is the costly part. At most `limit`
 * reports and `maxChars` characters of keys are kept, the one read longest ago going
 * first; a key longer than `maxChars` alone is never kept. In memory only.
 */
export function createReportKeyCache(options: {
	limit: number;
	maxChars: number;
	key?: (html: string) => string;
}): (html: string) => string {
	const keyOf = options.key ?? reportKey;
	const keys = new Map<string, string>();
	let chars = 0;
	return (html) => {
		const digest = createHash("sha256").update(html, "utf8").digest("base64");
		const kept = keys.get(digest);
		if (kept !== undefined) {
			keys.delete(digest);
			keys.set(digest, kept);
			return kept;
		}
		const key = keyOf(html);
		if (key.length > options.maxChars) return key;
		keys.set(digest, key);
		chars += key.length;
		for (const [oldest, value] of keys) {
			if (keys.size <= options.limit && chars <= options.maxChars) break;
			keys.delete(oldest);
			chars -= value.length;
		}
		return key;
	};
}

/** The reports a reading may be of right now: a handful, at a few MB of key each at most. */
const keptReportKey = createReportKeyCache({
	limit: 16,
	maxChars: 32_000_000,
});

/** `wordsFitKey` against a standard report's HTML: the words read from the page's copy of it. */
export function wordsFitReport(
	reportHtml: string,
	sentences: CheckedSentences,
): number | null {
	return wordsFitKey(keptReportKey(reportHtml), sentences);
}

/**
 * Walks the words of every sentence in order. A word that is not a list number
 * has its letters found in the text at or after where the previous word's
 * letters ended (a word with no letters counts as found); a list number is not
 * searched, because the renderer numbers a list and Markdown may write "1." for
 * every item, but it must look like one. Every word's tokens must read, ignoring
 * the pause marks the script adds, as the dictionary reads its written form.
 * Returns null when every word passes, else the index of the first sentence
 * that holds a word that does not.
 */
function wordsFitKey(
	reply: string,
	sentences: CheckedSentences,
): number | null {
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
