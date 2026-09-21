// The one place that decides what a document's page count may be CALLED.
//
// Two surfaces read it and they used to disagree: the prompt citation already
// knew that a DOCX's `declared: 1` is not a page, while every chip in the app
// printed "N pp" for slides, sheets and declared counts alike.

import { describe, expect, it } from "vitest";
import {
	displayablePageCountUnit,
	isPageCountKind,
	PAGE_COUNT_KINDS,
	pageCountUnit,
} from "./page-count";

describe("pageCountUnit", () => {
	it("names a unit only for the kinds that count something turnable", () => {
		expect(pageCountUnit("physical")).toBe("page");
		// EPUB's reading order is as close to a page as an EPUB gets.
		expect(pageCountUnit("spine")).toBe("page");
		expect(pageCountUnit("slide")).toBe("slide");
		expect(pageCountUnit("sheet")).toBe("sheet");
	});

	it("refuses the three kinds that count nothing a reader can turn to", () => {
		// DOCX asserts `declared`, which is 1 for a four-heading document; CSV
		// and HTML assert `logical`; PNG/JPEG report no metadata at all.
		expect(pageCountUnit("declared")).toBeNull();
		expect(pageCountUnit("logical")).toBeNull();
		expect(pageCountUnit("unknown")).toBeNull();
		expect(pageCountUnit(null)).toBeNull();
		expect(pageCountUnit(undefined)).toBeNull();
		expect(pageCountUnit("")).toBeNull();
		expect(pageCountUnit("PAGE")).toBeNull();
	});

	it("tolerates the casing and padding a stored metadata value may carry", () => {
		expect(pageCountUnit("  Physical ")).toBe("page");
		expect(pageCountUnit("SLIDE")).toBe("slide");
	});

	it("has an answer for every kind the parser can produce", () => {
		for (const kind of PAGE_COUNT_KINDS) {
			expect(() => pageCountUnit(kind)).not.toThrow();
			expect(isPageCountKind(kind)).toBe(true);
		}
		expect(isPageCountKind("chapters")).toBe(false);
		expect(isPageCountKind(3)).toBe(false);
	});
});

describe("displayablePageCountUnit", () => {
	it("shows a real count in its own unit", () => {
		expect(displayablePageCountUnit(24, "physical")).toBe("page");
		expect(displayablePageCountUnit(12, "slide")).toBe("slide");
		expect(displayablePageCountUnit(3, "sheet")).toBe("sheet");
		expect(displayablePageCountUnit(41, "spine")).toBe("page");
	});

	it("shows nothing when the kind is missing", () => {
		// Every document parsed before the structured extractor. Defaulting the
		// absence to "physical" would relabel the whole library.
		expect(displayablePageCountUnit(24, null)).toBeNull();
		expect(displayablePageCountUnit(24, undefined)).toBeNull();
	});

	it("shows a single physical page but not a single slide, sheet or spine", () => {
		expect(displayablePageCountUnit(1, "physical")).toBe("page");
		expect(displayablePageCountUnit(1, "slide")).toBeNull();
		expect(displayablePageCountUnit(1, "sheet")).toBeNull();
		expect(displayablePageCountUnit(1, "spine")).toBeNull();
	});

	it("refuses a count that is not a positive integer", () => {
		for (const count of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(displayablePageCountUnit(count, "physical")).toBeNull();
		}
		expect(displayablePageCountUnit(null, "physical")).toBeNull();
		expect(displayablePageCountUnit(undefined, "physical")).toBeNull();
	});
});
