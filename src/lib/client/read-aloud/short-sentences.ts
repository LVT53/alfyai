// Short sentences join their neighbours (spec §4.4; owner's call, 2026-11-17).
//
// Zonos misfires on a short text: it goes on speaking after the words are done, or stalls with a
// long silence. Measured on the Mac's build, with six voices and six seeds (deploy/speech-service,
// `speech_service/steady.py` has the numbers): of the clips of fragments of three to sixteen
// characters, 85 to 90% were far longer than their words in Berta's and Imre's voices, 82% in
// Wyatt's and 42% in Imogen's; a third of those of sentences under 45 characters; about one in
// fourteen of 40 to 49; about one in a hundred from 50 on. The service makes a clip that went
// wrong again (the stall guard), which mends most sentences but not most fragments. So the script
// sends no more of them than it must: a sentence under `SHORT_SENTENCE_CHARS` written characters
// is read as one unit with a neighbour.
//
// The tint then covers the joined unit, and word marks stay per word: the sentences of a script
// are only what the speech service is sent as one text. The join makes no pause mark of its own,
// because the full stop that ends the first sentence is the pause; Zonos pauses there, and the
// service lengthens it.

/** A sentence of fewer written characters than this is joined to a neighbour. */
export const SHORT_SENTENCE_CHARS = 50;

/** The fields of a speech script's draft that the join reads (the script's own type is private). */
type Joinable = {
	language: string;
	/** The paragraph (or code line) the sentence came from: only sentences of one unit are joined. */
	unit: string;
	words: ReadonlyArray<{ tokens: readonly string[]; heading: boolean }>;
};

/** The characters the sentence is sent as: its tokens, one space between each. */
function written(draft: Joinable): number {
	let tokens = 0;
	let chars = 0;
	for (const word of draft.words)
		for (const token of word.tokens) {
			tokens += 1;
			chars += token.length;
		}
	return chars + Math.max(tokens - 1, 0);
}

const isShort = (draft: Joinable) => written(draft) < SHORT_SENTENCE_CHARS;

/** Whether `a` and `b` (in that order) may be one unit: one paragraph, one language, no heading, not too long. */
function fits(a: Joinable, b: Joinable, maxChars: number): boolean {
	return (
		a.unit === b.unit &&
		a.language === b.language &&
		!a.words.some((word) => word.heading) &&
		!b.words.some((word) => word.heading) &&
		written(a) + 1 + written(b) <= maxChars
	);
}

/** `b` after `a`, as one: `a` keeps its place in the script (a paragraph's start is the first one's). */
function joined<D extends Joinable>(a: D, b: D): D {
	return { ...a, words: [...a.words, ...b.words] } as D;
}

/**
 * The sentences of a script (its drafts, in order) with each short one joined to a neighbour:
 * - a sentence under `SHORT_SENTENCE_CHARS` written characters takes the next sentence of its
 *   paragraph, and again while the unit is still short;
 * - one still short with no next sentence to take (the last of its paragraph, or the next too long)
 *   joins the one before it;
 * - never across a paragraph, a heading or a change of language, and never into a unit longer
 *   than `maxChars`, the length the script splits at; a short sentence with no neighbour that fits
 *   stands alone.
 * It returns new drafts and leaves the ones it is given as they are.
 */
export function joinShortSentences<D extends Joinable>(
	drafts: readonly D[],
	maxChars: number,
): D[] {
	const forward: D[] = [];
	let current: D | undefined;
	for (const draft of drafts) {
		if (current && isShort(current) && fits(current, draft, maxChars)) {
			current = joined(current, draft);
		} else {
			if (current) forward.push(current);
			current = draft;
		}
	}
	if (current) forward.push(current);

	const out: D[] = [];
	for (const draft of forward) {
		const previous = out[out.length - 1];
		if (previous && isShort(draft) && fits(previous, draft, maxChars))
			out[out.length - 1] = joined(previous, draft);
		else out.push(draft);
	}
	return out;
}
