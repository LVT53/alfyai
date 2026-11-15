// The title a new item gets: the model's own when it gave one, else the
// person's first words, which are in their language — never the English prompt
// the model wrote for the machine. Shared by make_image and make_video so a
// writer in Hungarian gets a Hungarian title from either.

import { oneLineName } from "$lib/server/services/vision/turn-images";

const TITLE_MAX_CHARS = 80;
const TITLE_FALLBACK_WORDS = 8;

/** Short words whose dot is an abbreviation's, not a sentence's end (English and Hungarian). */
const ABBREVIATIONS = new Set([
	"dr",
	"mr",
	"mrs",
	"ms",
	"prof",
	"st",
	"no",
	"vs",
	"etc",
	"e.g",
	"i.e",
	"pl",
	"kb",
	"ld",
	"stb",
	"ill",
	"ún",
	"id",
	"ifj",
	"özv",
	"sz",
	"u",
]);

/**
 * The first words of a message, at most `max`, ending with its first sentence: a
 * word ending in ! ? … ends it, and so does a dot unless the word is an
 * initial ("J.") or a known abbreviation ("Dr.", "pl."), so "Dr. Kovács's
 * office" is not cut to "Dr" (fix round 1).
 */
function firstSentenceWords(text: string, max: number): string[] {
	const words: string[] = [];
	for (const word of text.trim().split(/\s+/).filter(Boolean)) {
		words.push(word);
		if (words.length >= max) break;
		if (/[!?…]$/u.test(word)) break;
		if (word.endsWith(".")) {
			const bare = word.slice(0, -1).toLowerCase();
			const initial = /^\p{L}$/u.test(bare);
			if (!initial && !ABBREVIATIONS.has(bare)) break;
		}
	}
	return words;
}

/**
 * The model's own title (the tool asks for one on every call that starts an
 * item). Without one, the first words of the person's message, which are in
 * their language: at most eight, never past the first sentence's end, and
 * without its closing punctuation, so a sentence never becomes "room." (and its
 * download "room..png"). `fallback` names the kind when there are no words at
 * all.
 */
export function titleFor(
	given: string | undefined,
	requestText: string,
	fallback: string,
): string {
	const own = oneLineName(given ?? "", TITLE_MAX_CHARS);
	if (own) return own;
	return (
		oneLineName(
			firstSentenceWords(requestText, TITLE_FALLBACK_WORDS)
				.join(" ")
				.replace(/[\s.!?…,;:]+$/u, ""),
			TITLE_MAX_CHARS,
		) || fallback
	);
}
