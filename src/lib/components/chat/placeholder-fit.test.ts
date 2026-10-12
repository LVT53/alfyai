import { describe, expect, it } from "vitest";
import { fitPlaceholder } from "./placeholder-fit";

// Seven pixels a letter, an ellipsis one letter: enough to say what is cut where.
const measure = (text: string) => [...text].length * 7;
const ROOM = 280; // 40 letters

describe("fitPlaceholder", () => {
	it("leaves a placeholder that fits exactly as it is", () => {
		expect(fitPlaceholder("Kérdezz erről: Útiterv", ROOM, measure)).toBe(
			"Kérdezz erről: Útiterv",
		);
	});

	it("cuts the title at a word and ends in an ellipsis, so the line never wraps", () => {
		const fitted = fitPlaceholder(
			"Kérdezz erről: Bécsi hétvégi útiterv — szombat és vasárnap",
			ROOM,
			measure,
		);

		expect(fitted).toBe("Kérdezz erről: Bécsi hétvégi útiterv…");
		expect(measure(fitted)).toBeLessThanOrEqual(ROOM);
	});

	it("never leaves a dash or a colon dangling before the ellipsis", () => {
		const fitted = fitPlaceholder(
			"Kérdezz erről: Bécsi hétvégi útiterv — szombat és vasárnap",
			// Room for the text up to and including the dash, but not for the next word.
			"Kérdezz erről: Bécsi hétvégi útiterv —…".length * 7,
			measure,
		);

		expect(fitted).toBe("Kérdezz erről: Bécsi hétvégi útiterv…");
	});

	it("says the start of the sentence alone when a word of the title does not fit either", () => {
		expect(
			fitPlaceholder("Kérdezz erről: Bécsi útiterv", 15 * 7, measure),
		).toBe("Kérdezz erről…");
	});

	it("keeps the start of a title that is one long word instead of dropping it", () => {
		const fitted = fitPlaceholder(
			"Kérj módosítást: Borravaló-kalkulátor-és-számlafelosztó",
			ROOM,
			measure,
		);

		expect(fitted.startsWith("Kérj módosítást: Borravaló-")).toBe(true);
		expect(fitted.endsWith("…")).toBe(true);
		expect(measure(fitted)).toBeLessThanOrEqual(ROOM);
	});

	it("is never longer than the text, never empty, and leaves the text alone when there is no room to measure", () => {
		const text = "Ask about Weekend plan";
		expect(fitPlaceholder(text, 0, measure)).toBe(text);
		expect(fitPlaceholder(text, -5, measure)).toBe(text);
		expect(fitPlaceholder(text, Number.NaN, measure)).toBe(text);
		const tiny = fitPlaceholder(text, 3, measure);
		expect(tiny.length).toBeGreaterThan(0);
		expect(tiny.length).toBeLessThanOrEqual(text.length);
	});
});
