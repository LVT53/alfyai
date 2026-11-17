import { describe, expect, it } from "vitest";
import type { ScriptSentence, SpeechScript } from "./speech-script";
import {
	estimateSeconds,
	formatClock,
	HEADING_NOTCHES_PAST,
	headingNotches,
	notchAtShare,
	notches,
	PARAGRAPH_GAP_SECONDS,
	SENTENCE_GAP_SECONDS,
	SessionTimeline,
	sentenceAtShare,
	shareAt,
} from "./timeline";

/** A script of sentences as tokens; ranges are not read here. */
function scriptOf(
	parts: Array<{
		tokens: string[];
		language?: "en" | "hu";
		paragraphStart?: boolean;
		heading?: boolean;
	}>,
): SpeechScript {
	let charStart = 0;
	const sentences: ScriptSentence[] = parts.map((part, index) => {
		const text = part.tokens.join(" ");
		const sentence: ScriptSentence = {
			id: `s${index}`,
			index,
			language: part.language ?? "en",
			paragraphStart: part.paragraphStart ?? index === 0,
			continues: false,
			heading: part.heading ?? false,
			words: [],
			tokens: part.tokens,
			ranges: [],
			text,
			charStart,
			chars: text.length + 1,
		};
		charStart += sentence.chars;
		return sentence;
	});
	return {
		sentences,
		totalChars: charStart,
		missingLanguage: null,
		nothingToRead: false,
	};
}

const script = scriptOf([
	{ tokens: ["The", "bread", "rises."] },
	{ tokens: ["Then", "it", "bakes", "for", "an", "hour."] },
	{ tokens: ["Enjoy", "it", "warm."], paragraphStart: true },
]);

describe("SessionTimeline", () => {
	it("knows nothing before the first sentence event", () => {
		expect(new SessionTimeline(script, 0).locate(1)).toBeNull();
	});

	it("locates the sentence and word for a time", () => {
		const timeline = new SessionTimeline(script, 0);
		timeline.addSentence("s0", 0.025, 2.025);
		timeline.addSentence("s1", 2.325, 4.0);
		// A sentence's words may come after the next sentence's event: they are matched by id.
		timeline.addWords("s0", [
			[0.025, 0.5],
			[0.6, 1.0],
			[1.1, 2.06],
		]);
		// Before the first start (the encoder's delay) it is the first sentence, at its start.
		expect(timeline.locate(0.01)).toEqual({
			sentence: 0,
			word: null,
			within: 0,
		});
		expect(timeline.locate(0.7)).toEqual({
			sentence: 0,
			word: 1,
			within: ("The".length + 1) / "The bread rises. ".length,
		});
		expect(timeline.locate(0.025)).toEqual({ sentence: 0, word: 0, within: 0 });
		// In the gap after a sentence the last word stays marked.
		expect(timeline.locate(2.2)?.word).toBe(2);
		// A sentence with no words yet moves by time.
		expect(timeline.locate(3.0)).toEqual({
			sentence: 1,
			word: null,
			within: (3.0 - 2.325) / (4.0 - 2.325),
		});
	});

	it("clamps word times to their sentence", () => {
		const timeline = new SessionTimeline(script, 0);
		timeline.addSentence("s0", 1.0, 2.0);
		timeline.addSentence("s1", 2.3, 4.0);
		// The first word starts 40 ms before its sentence, the last ends 60 ms after it.
		timeline.addWords("s0", [
			[0.96, 1.3],
			[1.4, 1.7],
			[1.8, 2.06],
		]);
		expect(timeline.locate(1.0)?.word).toBe(0);
		expect(timeline.locate(2.3)?.sentence).toBe(1);
	});

	it("a sentence without word times moves by time", () => {
		const timeline = new SessionTimeline(script, 0);
		timeline.addSentence("s0", 0.025, 2.025);
		timeline.addWords("s0", [null, null, null]);
		expect(timeline.locate(1.025)).toEqual({
			sentence: 0,
			word: null,
			within: expect.closeTo(0.5),
		});
		expect(timeline.locate(9)).toEqual({ sentence: 0, word: null, within: 1 });
	});

	it("starts a session at its first sentence and reports what it has heard", () => {
		const timeline = new SessionTimeline(script, 1);
		timeline.addSentence("s1", 0.025, 1.525);
		timeline.addSentence("s2", 2.125, 3.125);
		expect(timeline.locate(0.5)?.sentence).toBe(1);
		expect(timeline.locate(2.5)?.sentence).toBe(2);
		expect(timeline.durations()).toEqual(
			new Map([
				[1, 1.5],
				[2, 1],
			]),
		);
		// An id that is not the script's is ignored.
		timeline.addSentence("s9", 4, 5);
		expect(timeline.durations().size).toBe(2);
	});
});

describe("text shares", () => {
	it("every notch, and the share a sentence starts at, maps back to that sentence (early review R17)", () => {
		// The review swept sentence lengths of 100, 151 and 337 characters (and others) and found
		// about 1,600 of 42,000 notches landing one sentence early: a share that is a float
		// away from `charStart / totalChars`. A sweep of mixed lengths now finds none.
		const lengths = [100, 151, 337, 7, 64, 240, 13, 999, 58, 31, 202, 87];
		let misses = 0;
		let checked = 0;
		for (let a = 0; a < lengths.length; a++) {
			for (let b = 0; b < lengths.length; b++) {
				for (let c = 0; c < lengths.length; c++) {
					const sweep = scriptOf(
						[lengths[a], lengths[b], lengths[c], lengths[(a + b + c) % 12]].map(
							(length) => ({ tokens: ["x".repeat(Math.max(1, length - 1))] }),
						),
					);
					const marks = notches(sweep);
					sweep.sentences.forEach((_sentence, index) => {
						checked += 1;
						if (sentenceAtShare(sweep, marks[index] ?? 0) !== index)
							misses += 1;
						if (sentenceAtShare(sweep, shareAt(sweep, index, 0)) !== index)
							misses += 1;
						if (notchAtShare(marks, marks[index] ?? 0) !== index) misses += 1;
					});
				}
			}
		}
		expect(checked).toBeGreaterThan(5000);
		expect(misses).toBe(0);
	});

	it("notches are text shares and never move", () => {
		expect(notches(script)[0]).toBe(0);
		expect(notches(script)).toEqual(
			script.sentences.map((s) => s.charStart / script.totalChars),
		);
	});

	it("a pointer share maps back to its sentence", () => {
		const [, second = 0, third = 0] = notches(script);
		expect(sentenceAtShare(script, 0)).toBe(0);
		expect(sentenceAtShare(script, second - 0.001)).toBe(0);
		expect(sentenceAtShare(script, second)).toBe(1);
		expect(sentenceAtShare(script, third + 0.01)).toBe(2);
		expect(sentenceAtShare(script, 1)).toBe(2);
		expect(sentenceAtShare(script, 1.5)).toBe(2);
		expect(sentenceAtShare(script, -1)).toBe(0);
		expect(notchAtShare([0, 0.3, 0.7], 0.5)).toBe(1);
		expect(notchAtShare([0, 0.3, 0.7], 0.7)).toBe(2);
		expect(notchAtShare([], 0.5)).toBe(0);
		expect(shareAt(script, 1, 0)).toBe(second);
		expect(shareAt(script, 2, 1)).toBe(1);
		expect(shareAt(script, 0, 0.5)).toBeCloseTo(
			(0.5 * "The bread rises. ".length) / script.totalChars,
		);
	});
});

describe("estimates and clocks", () => {
	const cps = { en: 15, hu: 12 };

	it("the total is an estimate until every sentence is known, gaps included", () => {
		const hu = scriptOf([
			{ tokens: ["Egy", "kettő", "három."], language: "hu" },
			{ tokens: ["Then", "it", "bakes", "for", "an", "hour."] },
			{ tokens: ["Enjoy", "it", "warm."], paragraphStart: true },
		]);
		const [a, b, c] = hu.sentences.map((s) => s.chars) as [
			number,
			number,
			number,
		];
		expect(SENTENCE_GAP_SECONDS).toBe(0.3);
		expect(PARAGRAPH_GAP_SECONDS).toBe(0.6);
		const none = estimateSeconds(hu, new Map(), cps);
		expect(none.estimate).toBe(true);
		expect(none.seconds).toBeCloseTo(a / 12 + 0.3 + b / 15 + 0.6 + c / 15);
		const some = estimateSeconds(hu, new Map([[0, 2]]), cps);
		expect(some).toEqual({
			seconds: expect.closeTo(2 + 0.3 + b / 15 + 0.6 + c / 15),
			estimate: true,
		});
		const all = estimateSeconds(
			hu,
			new Map([
				[0, 2],
				[1, 3],
				[2, 1],
			]),
			cps,
		);
		expect(all).toEqual({
			seconds: expect.closeTo(2 + 0.3 + 3 + 0.6 + 1),
			estimate: false,
		});
		// The time before a sentence: the ones before it and the gaps up to it.
		expect(estimateSeconds(hu, new Map([[0, 2]]), cps, 2)).toEqual({
			seconds: expect.closeTo(2 + 0.3 + b / 15 + 0.6),
			estimate: true,
		});
		expect(estimateSeconds(hu, new Map(), cps, 0)).toEqual({
			seconds: 0,
			estimate: false,
		});
	});

	it("formats 9, 65 and 3725 seconds", () => {
		expect(formatClock(9)).toBe("0:09");
		expect(formatClock(65)).toBe("1:05");
		expect(formatClock(3725)).toBe("1:02:05");
		expect(formatClock(59.9)).toBe("0:59");
		expect(formatClock(-3)).toBe("0:00");
		expect(formatClock(Number.NaN)).toBe("0:00");
	});
});

describe("a long Document's notches", () => {
	/** `count` sentences of five words, those at `headings` beginning a heading. */
	const longScript = (count: number, headings: number[]) =>
		scriptOf(
			Array.from({ length: count }, (_, index) => ({
				tokens: ["One", "two", "three", "four", "five."],
				heading: headings.includes(index),
				paragraphStart: headings.includes(index),
			})),
		);

	it("past 40 sentences, only the sentences that begin a heading are notched", () => {
		expect(HEADING_NOTCHES_PAST).toBe(40);
		expect(headingNotches(longScript(41, [0, 12, 30]))).toEqual([0, 12, 30]);
		expect(headingNotches(longScript(300, [5, 120, 299]))).toEqual([
			5, 120, 299,
		]);
	});

	it("up to 40 sentences, every sentence keeps its notch", () => {
		expect(headingNotches(longScript(40, [0, 12, 30]))).toBeNull();
		expect(headingNotches(longScript(3, [0]))).toBeNull();
	});

	it("a long Document with no heading draws no notch, rather than a ruler of them", () => {
		expect(headingNotches(longScript(80, []))).toEqual([]);
	});
});
