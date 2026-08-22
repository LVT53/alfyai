import { describe, expect, it } from "vitest";
import {
	MAX_NEW_WORDS_PER_TICK,
	shouldAnimateWords,
	WORD_ANIMATION_MAX_CHARS,
	wrapNewWords,
} from "./stream-word-wrap";

/**
 * Pure unit tests for the streaming word-reveal wrapping (C3). The DOM walk runs
 * against jsdom elements — no component, no throttle — so the threshold + cap
 * guards can be asserted directly.
 */

function div(html: string): HTMLDivElement {
	const el = document.createElement("div");
	el.innerHTML = html;
	return el;
}

function newWordTexts(el: HTMLElement): string[] {
	return Array.from(el.querySelectorAll(".word-new")).map(
		(span) => span.textContent ?? "",
	);
}

describe("shouldAnimateWords (C3 length threshold)", () => {
	it("animates normal-length answers", () => {
		expect(shouldAnimateWords(0)).toBe(true);
		expect(shouldAnimateWords(500)).toBe(true);
		expect(shouldAnimateWords(WORD_ANIMATION_MAX_CHARS)).toBe(true);
	});

	it("skips the per-word reveal once past the threshold", () => {
		expect(shouldAnimateWords(WORD_ANIMATION_MAX_CHARS + 1)).toBe(false);
		expect(shouldAnimateWords(50_000)).toBe(false);
	});
});

describe("wrapNewWords", () => {
	it("wraps only words at or beyond startIndex, leaving earlier words as text", () => {
		const el = div("one two three four");
		const total = wrapNewWords(el, 2);

		// Four words total; words 0 and 1 stay text, words 2 and 3 get spans.
		expect(total).toBe(4);
		expect(newWordTexts(el)).toEqual(["three", "four"]);
		// The already-rendered words are still present as plain text.
		expect(el.textContent).toBe("one two three four");
	});

	it("wraps every word when startIndex is 0", () => {
		const el = div("alpha beta gamma");
		const total = wrapNewWords(el, 0);
		expect(total).toBe(3);
		expect(newWordTexts(el)).toEqual(["alpha", "beta", "gamma"]);
	});

	it("returns the running count so successive ticks only wrap the fresh words", () => {
		const first = div("one two");
		const afterFirst = wrapNewWords(first, 0);
		expect(afterFirst).toBe(2);

		// Next tick: the block now has two more words; only those two are new.
		const second = div("one two three four");
		const afterSecond = wrapNewWords(second, afterFirst);
		expect(afterSecond).toBe(4);
		expect(newWordTexts(second)).toEqual(["three", "four"]);
	});

	it("caps the number of freshly-wrapped words per tick; the rest stay plain text", () => {
		const words = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
		const el = div(words);

		const total = wrapNewWords(el, 0, 25);

		// The word count is fully advanced (so the next tick doesn't re-wrap)...
		expect(total).toBe(200);
		// ...but only the cap's worth of spans were created.
		expect(el.querySelectorAll(".word-new")).toHaveLength(25);
		// The capped-out words are still present as plain text.
		expect(el.textContent).toBe(words);
	});

	it("defaults the per-tick cap to MAX_NEW_WORDS_PER_TICK", () => {
		const words = Array.from(
			{ length: MAX_NEW_WORDS_PER_TICK + 50 },
			(_, i) => `w${i}`,
		).join(" ");
		const el = div(words);

		wrapNewWords(el, 0);

		expect(el.querySelectorAll(".word-new")).toHaveLength(
			MAX_NEW_WORDS_PER_TICK,
		);
	});

	it("does not wrap words inside a source-link chip", () => {
		const el = div(
			'before <a class="source-link-chip"><span class="source-link-chip__label">Example</span></a> after',
		);
		wrapNewWords(el, 0);

		const texts = newWordTexts(el);
		expect(texts).toContain("before");
		expect(texts).toContain("after");
		// The chip's inner text is never wrapped.
		expect(texts).not.toContain("Example");
		expect(el.querySelector(".source-link-chip .word-new")).toBeNull();
	});

	it("wraps words across nested inline elements without descending into scripts/styles", () => {
		const el = div("hello <strong>bold</strong> <style>.x{}</style> world");
		wrapNewWords(el, 0);

		const texts = newWordTexts(el);
		expect(texts).toEqual(expect.arrayContaining(["hello", "bold", "world"]));
		// The <style> body is not walked.
		expect(el.querySelector("style .word-new")).toBeNull();
	});
});
