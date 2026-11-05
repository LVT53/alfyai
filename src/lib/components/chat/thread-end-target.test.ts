import { describe, expect, it } from "vitest";
import {
	THREAD_END_CARD_INSET_PX,
	threadEndScrollTop,
} from "./thread-end-target";

// The view's scroll position when it goes to the end of the thread: a jump to the latest
// message, a hold while the thread settles, a follow. The end is the bottom, unless the
// last row draws a question that waits and the card with what follows it does not fit:
// then it is the top of the card, so the reader meets the question and the X, and not
// the rows under the card.
//
// A thread 1400 px tall seen through a 500 px view scrolls 900 px at most.
describe("threadEndScrollTop", () => {
	const inset = THREAD_END_CARD_INSET_PX;
	const maxScrollTop = 900;
	const scrollHeight = 1400;

	it("is the bottom when the last row draws no waiting card", () => {
		expect(
			threadEndScrollTop({
				bottom: scrollHeight,
				maxScrollTop,
				waitingCardTop: null,
			}),
		).toBe(scrollHeight);
	});

	it("is the bottom when the card fits: its top stays under the inset line with the thread at the bottom", () => {
		// At the bottom the card's top is 950 - 900 = 50 px into the view.
		expect(
			threadEndScrollTop({
				bottom: scrollHeight,
				maxScrollTop,
				waitingCardTop: 950,
			}),
		).toBe(scrollHeight);
	});

	it("is the bottom when the card's top lands exactly on the inset line at the bottom", () => {
		expect(
			threadEndScrollTop({
				bottom: scrollHeight,
				maxScrollTop,
				waitingCardTop: maxScrollTop + inset,
			}),
		).toBe(scrollHeight);
	});

	it("is the card's top less the inset when the card does not fit", () => {
		// At the bottom the card's top would be 100 px above the view.
		expect(
			threadEndScrollTop({
				bottom: scrollHeight,
				maxScrollTop,
				waitingCardTop: 800,
			}),
		).toBe(800 - inset);
		// One pixel short of fitting.
		expect(
			threadEndScrollTop({
				bottom: scrollHeight,
				maxScrollTop,
				waitingCardTop: maxScrollTop + inset - 1,
			}),
		).toBe(maxScrollTop - 1);
	});

	it("never goes above the top of the thread", () => {
		expect(
			threadEndScrollTop({
				bottom: scrollHeight,
				maxScrollTop,
				waitingCardTop: inset - 3,
			}),
		).toBe(0);
	});

	it("gives the caller's own bottom back, however the caller counts it", () => {
		// A glide aims at the furthest scroll position, a jump at the full height.
		expect(
			threadEndScrollTop({
				bottom: maxScrollTop,
				maxScrollTop,
				waitingCardTop: 950,
			}),
		).toBe(maxScrollTop);
		expect(
			threadEndScrollTop({
				bottom: maxScrollTop,
				maxScrollTop,
				waitingCardTop: 800,
			}),
		).toBe(800 - inset);
	});

	it("is the bottom for a thread that does not scroll, card or not", () => {
		expect(
			threadEndScrollTop({
				bottom: 400,
				maxScrollTop: 0,
				waitingCardTop: 120,
			}),
		).toBe(400);
	});
});
