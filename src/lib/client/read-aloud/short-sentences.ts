// Short sentences join their neighbours (spec §4.4; owner's call, 2026-11-17).
//
// Zonos misfires on a short text: it goes on speaking after the words are done, or stalls with a
// long silence. Measured on the Mac's build, with six voices and six seeds (deploy/speech-service,
// `speech_service/steady.py` has the numbers): of the clips of fragments of three to sixteen
// characters, 85 to 90% were far longer than their words in Berta's and Imre's voices, 82% in
// Wyatt's and 42% in Imogen's; a third of those of sentences under 45 characters; about one in
// fourteen of 40 to 49; about one in a hundred from 50 on. The service makes a clip that went
// wrong again (the stall guard), which mends most sentences but not most fragments. So the script
// sends no more of them than it must: a unit under `SHORT_SENTENCE_CHARS` written characters is
// read as one unit with a neighbour. Three kinds of short unit have one:
//
// - a sentence takes the next sentence of its paragraph, or the one before if it is the last;
// - a list item takes the next item of its list, or the one before if it is the last (a short
//   item takes a long one too, as a short sentence does);
// - a paragraph of one sentence ("Sure!", "Thanks!") takes the first sentence of the next
//   paragraph, whatever that is but a heading, a code line or another language; and when that
//   cannot be, the last sentence of the one before.
//
// The tint then covers the joined unit, and word marks stay per word: the sentences of a script
// are only what the speech service is sent as one text. The full stop that ends a sentence is the
// pause between it and what follows, and the join makes one where there is none (a list item
// rarely ends in a mark): Zonos pauses there, and the service lengthens it. What it loses is the
// longer gap the service puts before a paragraph: inside a unit the pause is the stop's.

import { MAX_TOKEN_CHARS } from "$lib/shared/read-aloud/spoken-forms";

/** A unit of fewer written characters than this is joined to a neighbour. */
export const SHORT_SENTENCE_CHARS = 50;

/** A token that ends in one of these pauses where it ends: Zonos pauses at the marks it is given. */
export const ENDS_IN_PAUSE = /[.!?,;:…]$/u;

type JoinableWord = { tokens: readonly string[]; heading: boolean };

/** The fields of a speech script's draft that the join reads (the script's own type is private). */
type Joinable = {
	language: string;
	/** The paragraph (or code line) the draft came from: its last part's, once drafts are joined. */
	unit: string;
	/** The list the draft is an item of: the items of one list share the key. Null outside a list. */
	list?: string | null;
	/** A line of a code block: never joined. */
	code?: boolean;
	words: ReadonlyArray<JoinableWord>;
};

/** The characters the draft is sent as: its tokens, one space between each. */
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

const hasHeading = (draft: Joinable) =>
	draft.words.some((word) => word.heading);

/** Whether a full stop belongs after the draft when something follows it in one unit: it ends in no pause mark, and a stop would not make its last token too long. */
function takesStop(draft: Joinable): boolean {
	const word = draft.words[draft.words.length - 1];
	const token = word?.tokens[word.tokens.length - 1];
	return (
		token !== undefined &&
		!ENDS_IN_PAUSE.test(token) &&
		token.length < MAX_TOKEN_CHARS
	);
}

/** The words with a full stop on the last token: a copy, the words it is given are left as they are. */
function withStop<W extends JoinableWord>(words: readonly W[]): W[] {
	const last = words[words.length - 1];
	if (!last) return [...words];
	const token = last.tokens[last.tokens.length - 1];
	return [
		...words.slice(0, -1),
		{ ...last, tokens: [...last.tokens.slice(0, -1), `${token}.`] },
	];
}

/**
 * Whether `b` may follow `a` as one unit. Never across a code line, a heading or a language, and
 * never into a unit longer than `maxChars`; and then only
 * - within a paragraph, or
 * - between two items of one list, or
 * - when the short one of the two is a paragraph of one sentence (`lone`), whose neighbour is
 *   then any paragraph, item or sentence that those rules allow.
 */
function canJoin(
	a: Joinable,
	b: Joinable,
	lone: boolean,
	maxChars: number,
): boolean {
	if (
		a.code ||
		b.code ||
		a.language !== b.language ||
		hasHeading(a) ||
		hasHeading(b)
	)
		return false;
	const sameParagraph = a.unit === b.unit;
	const sameList = a.list != null && a.list === b.list;
	if (!sameParagraph && !sameList && !lone) return false;
	return written(a) + (takesStop(a) ? 1 : 0) + 1 + written(b) <= maxChars;
}

/** `b` after `a`, as one: `a` keeps its place in the script (a paragraph's start is the first one's). */
function joined<D extends Joinable>(a: D, b: D): D {
	return {
		...a,
		words: [...(takesStop(a) ? withStop(a.words) : a.words), ...b.words],
		unit: b.unit,
		list: b.list,
	} as D;
}

/** Whether the draft at `index` is a paragraph of one sentence: not a list item, and no neighbour is of its unit. (A code line is never joined, whatever it is.) */
function isLoneParagraph(drafts: readonly Joinable[], index: number): boolean {
	const draft = drafts[index];
	return (
		draft !== undefined &&
		draft.list == null &&
		drafts[index - 1]?.unit !== draft.unit &&
		drafts[index + 1]?.unit !== draft.unit
	);
}

/**
 * The sentences of a script (its drafts, in order) with each short one joined to a neighbour:
 * - a unit under `SHORT_SENTENCE_CHARS` written characters takes the next one it may join (the
 *   next sentence of its paragraph, the next item of its list, or, for a paragraph of one
 *   sentence, the first sentence of the next paragraph), and again while the unit is still short;
 * - one still short with no next to take joins the one before it, by the same rules;
 * - never across a heading, a code line or a change of language, and never into a unit longer
 *   than `maxChars`, the length the script splits at; a short unit with no neighbour that fits
 *   stands alone;
 * - where a unit that is joined to one after it ends in no pause mark, the join gives it a full stop.
 * It returns new drafts and leaves the ones it is given as they are.
 */
export function joinShortSentences<D extends Joinable>(
	drafts: readonly D[],
	maxChars: number,
): D[] {
	// A unit that began as a paragraph of one sentence may cross a paragraph, and goes on doing so
	// while it is short; one that began as a sentence of a longer paragraph or as an item joins
	// only within its paragraph or its list.
	const forward: D[] = [];
	const lone: boolean[] = [];
	let current: D | undefined;
	let currentLone = false;
	drafts.forEach((draft, index) => {
		if (
			current &&
			isShort(current) &&
			canJoin(current, draft, currentLone, maxChars)
		) {
			current = joined(current, draft);
		} else {
			if (current) {
				forward.push(current);
				lone.push(currentLone);
			}
			current = draft;
			currentLone = isLoneParagraph(drafts, index);
		}
	});
	if (current) {
		forward.push(current);
		lone.push(currentLone);
	}

	const out: D[] = [];
	forward.forEach((draft, index) => {
		const previous = out[out.length - 1];
		if (
			previous &&
			isShort(draft) &&
			canJoin(previous, draft, lone[index] === true, maxChars)
		)
			out[out.length - 1] = joined(previous, draft);
		else out.push(draft);
	});
	return out;
}
