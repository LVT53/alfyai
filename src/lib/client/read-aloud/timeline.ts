/**
 * The reading's clock (spec §4.3, "Before the later sentences exist"). The audio's
 * `currentTime` is mapped through the speech service's timeline events to the sentence
 * and word being read. Synthesis runs only about two sentences ahead, so the notches,
 * the scrubber and the progress follow the share of TEXT read, which never moves; only
 * the total time is an estimate, corrected as sentences are made.
 */

import type { ScriptSentence, SpeechScript } from "./speech-script";

/** The silence between two sentences, and before a paragraph's first (the speech service's values). */
export const SENTENCE_GAP_SECONDS = 0.3;
export const PARAGRAPH_GAP_SECONDS = 0.6;

type Span = { start: number; end: number };

/**
 * One session's timeline: the sentences from `firstIndex` on, as the service reports them.
 * Times are seconds on the stream's clock: the first sentence starts after the encoder's
 * delay (about 0.025 s), not at 0, and word times may lie tens of milliseconds outside their
 * sentence, so they are clamped to it.
 */
export class SessionTimeline {
	private readonly indexOf = new Map<string, number>();
	private readonly spans = new Map<number, Span>();
	private readonly words = new Map<number, Array<[number, number] | null>>();

	constructor(
		private readonly script: SpeechScript,
		firstIndex: number,
	) {
		for (const sentence of script.sentences) {
			if (sentence.index >= firstIndex)
				this.indexOf.set(sentence.id, sentence.index);
		}
	}

	addSentence(id: string, start: number, end: number): void {
		const index = this.indexOf.get(id);
		if (index !== undefined)
			this.spans.set(index, { start, end: Math.max(start, end) });
	}

	/** One entry per token, matched by the sentence's id: the event can come after the next sentence's. */
	addWords(id: string, times: Array<[number, number] | null>): void {
		const index = this.indexOf.get(id);
		if (index !== undefined) this.words.set(index, times);
	}

	/**
	 * The sentence whose start is the last at or before `t` (the first known one before it starts),
	 * the last timed token that has started, and how far into the sentence's text that is.
	 */
	locate(
		t: number,
	): { sentence: number; word: number | null; within: number } | null {
		let current: number | null = null;
		let first: number | null = null;
		for (const [index, span] of this.spans) {
			if (first === null || index < first) first = index;
			if (span.start <= t && (current === null || index > current))
				current = index;
		}
		if (first === null) return null;
		if (current === null) return { sentence: first, word: null, within: 0 };
		const span = this.spans.get(current) as Span;
		const sentence = this.script.sentences[current];
		const word = this.wordAt(current, span, t);
		if (word !== null && sentence) {
			let offset = word;
			for (let i = 0; i < word; i++) offset += sentence.tokens[i]?.length ?? 0;
			return { sentence: current, word, within: offset / sentence.chars };
		}
		const length = span.end - span.start;
		const within =
			length > 0 ? Math.min(1, Math.max(0, (t - span.start) / length)) : 0;
		return { sentence: current, word: null, within };
	}

	/** The known length of each sentence of the session, by its index in the script. */
	durations(): Map<number, number> {
		const durations = new Map<number, number>();
		for (const [index, span] of this.spans)
			durations.set(index, span.end - span.start);
		return durations;
	}

	private wordAt(index: number, span: Span, t: number): number | null {
		const times = this.words.get(index);
		if (!times) return null;
		let word: number | null = null;
		times.forEach((time, i) => {
			if (time === null) return;
			const start = Math.min(span.end, Math.max(span.start, time[0]));
			if (start <= t) word = i;
		});
		return word;
	}
}

/** Each sentence's share of the reply's text: where its notch sits. */
export function notches(script: SpeechScript): number[] {
	return script.sentences.map((sentence) =>
		script.totalChars > 0 ? sentence.charStart / script.totalChars : 0,
	);
}

/**
 * How far apart two drawn notches stay, as a share of the line: 6 px of the narrowest line the
 * player draws, a 360 px phone's, which is about 170 px (measured: 201 px on a 390 px phone; a
 * desktop's is wider). A notch is 2 px wide; closer than that, notches stop reading as separate
 * marks and merge into a ruler that says nothing (the owner, 2026-11-18, on long replies: "too
 * many dots in the timeline and they just look like clutter").
 */
export const NOTCH_MIN_GAP = 6 / 170;

/**
 * How many sentences a scrubber may notch one by one: 28 put the notches 6 px apart on that
 * line on average. Past it, it notches the reading's structure instead.
 */
export const NOTCH_EVERY_SENTENCE_UP_TO = 28;

/**
 * The sentences whose notch a scrubber draws, for a reply, a Document and a report alike.
 * Up to {@link NOTCH_EVERY_SENTENCE_UP_TO} sentences, every sentence's. Past that, the
 * sentences that begin a heading when there are at least two; else those that begin a
 * paragraph when there are at least two; else every sentence's. Then never two closer than
 * {@link NOTCH_MIN_GAP}: walking from the start, a notch is drawn only that far from the last
 * one drawn, so a crowd is thinned evenly and the line holds about 29 marks at most. Null
 * when every sentence's is drawn. It changes only what is drawn: a drag, a tap or a key
 * still lands on any sentence.
 */
export function drawnNotches(script: SpeechScript): number[] | null {
	const sentences = script.sentences;
	const starting = (begins: (sentence: ScriptSentence) => boolean) =>
		sentences.filter(begins).map((sentence) => sentence.index);
	let candidates = sentences.map((sentence) => sentence.index);
	if (sentences.length > NOTCH_EVERY_SENTENCE_UP_TO) {
		const headings = starting((sentence) => sentence.heading);
		const paragraphs = starting((sentence) => sentence.paragraphStart);
		if (headings.length >= 2) candidates = headings;
		else if (paragraphs.length >= 2) candidates = paragraphs;
	}
	const shares = notches(script);
	const drawn: number[] = [];
	let last = Number.NEGATIVE_INFINITY;
	for (const index of candidates) {
		const share = shares[index] ?? 0;
		// A hair of slack for the shares' rounding: 40 equal sentences sit exactly the gap apart.
		if (share - last < NOTCH_MIN_GAP - 1e-9) continue;
		drawn.push(index);
		last = share;
	}
	return drawn.length === sentences.length ? null : drawn;
}

/** The sentence a share of the text falls in, clamped to the first and the last. */
export function sentenceAtShare(script: SpeechScript, share: number): number {
	return notchAtShare(notches(script), share);
}

/** The same from the notches alone (what the scrubber holds): the last notch at or before the share. */
export function notchAtShare(marks: readonly number[], share: number): number {
	const at = Math.min(1, Math.max(0, share));
	let found = 0;
	marks.forEach((mark, index) => {
		if (mark <= at) found = index;
	});
	return found;
}

/** The share of the text read at `within` of a sentence. */
export function shareAt(
	script: SpeechScript,
	sentence: number,
	within: number,
): number {
	const s = script.sentences[sentence];
	if (!s || script.totalChars <= 0) return 0;
	return (
		(s.charStart + Math.min(1, Math.max(0, within)) * s.chars) /
		script.totalChars
	);
}

/**
 * The listening time of the whole reading at speed 1, or of what comes before sentence `before`:
 * each sentence's known length, else its characters at the voice's rate, and the gaps up to it.
 * It stays an estimate while any of those lengths is unknown.
 */
export function estimateSeconds(
	script: SpeechScript,
	known: ReadonlyMap<number, number>,
	charsPerSecond: Record<"en" | "hu", number>,
	before?: number,
): { seconds: number; estimate: boolean } {
	const end =
		before === undefined
			? script.sentences.length
			: Math.min(before, script.sentences.length);
	let seconds = 0;
	let estimate = false;
	for (let i = 0; i < end; i++) {
		const sentence = script.sentences[i];
		if (!sentence) continue;
		if (i > 0)
			seconds += sentence.paragraphStart
				? PARAGRAPH_GAP_SECONDS
				: SENTENCE_GAP_SECONDS;
		const length = known.get(i);
		if (length === undefined) {
			estimate = true;
			seconds +=
				sentence.chars / Math.max(1, charsPerSecond[sentence.language]);
		} else {
			seconds += length;
		}
	}
	const next = before === undefined ? undefined : script.sentences[end];
	if (next && end > 0)
		seconds += next.paragraphStart
			? PARAGRAPH_GAP_SECONDS
			: SENTENCE_GAP_SECONDS;
	return { seconds, estimate };
}

/** `m:ss`, and `h:mm:ss` from an hour on. */
export function formatClock(seconds: number): string {
	const whole =
		Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
	const s = String(whole % 60).padStart(2, "0");
	const minutes = Math.floor(whole / 60);
	if (minutes < 60) return `${minutes}:${s}`;
	return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${s}`;
}
