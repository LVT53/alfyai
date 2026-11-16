/**
 * The reading's clock (spec §4.3, "Before the later sentences exist"). The audio's
 * `currentTime` is mapped through the speech service's timeline events to the sentence
 * and word being read. Synthesis runs only about two sentences ahead, so the notches,
 * the scrubber and the progress follow the share of TEXT read, which never moves; only
 * the total time is an estimate, corrected as sentences are made.
 */

import type { SpeechScript } from "./speech-script";

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

/** The sentence a share of the text falls in, clamped to the first and the last. */
export function sentenceAtShare(script: SpeechScript, share: number): number {
	const at = Math.min(1, Math.max(0, share)) * script.totalChars;
	let found = 0;
	for (const sentence of script.sentences)
		if (sentence.charStart <= at) found = sentence.index;
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
