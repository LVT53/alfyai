import { describe, expect, it } from "vitest";
import { chipLabel, chipValues, STATUS_CHIP_VALUES } from "./chips";

describe("chips: chipValues", () => {
	it("lists the status kind's fixed vocabulary in order", () => {
		expect(chipValues("status")).toEqual([...STATUS_CHIP_VALUES]);
	});

	it("has no fixed vocabulary for the date kind", () => {
		expect(chipValues("date")).toEqual([]);
	});
});

describe("chips: chipLabel", () => {
	it("renders the English label for a canonical status token in English", () => {
		expect(chipLabel("status", "Booked", "en")).toBe("Booked");
		expect(chipLabel("status", "To book", "en")).toBe("To book");
		expect(chipLabel("status", "Paid", "en")).toBe("Paid");
		expect(chipLabel("status", "Cancelled", "en")).toBe("Cancelled");
	});

	it("renders the Hungarian label for the SAME canonical token", () => {
		expect(chipLabel("status", "Booked", "hu")).toBe("Lefoglalva");
		expect(chipLabel("status", "To book", "hu")).toBe("Lefoglalandó");
		expect(chipLabel("status", "Paid", "hu")).toBe("Kifizetve");
		expect(chipLabel("status", "Cancelled", "hu")).toBe("Lemondva");
	});

	it("shows an unrecognised value verbatim rather than crashing", () => {
		expect(chipLabel("status", "Some hand-typed value", "hu")).toBe(
			"Some hand-typed value",
		);
	});

	it("formats a stored ISO date for display, in the given locale", () => {
		const en = chipLabel("date", "2026-03-14", "en");
		const hu = chipLabel("date", "2026-03-14", "hu");
		expect(en).toContain("2026");
		expect(hu).toContain("2026");
		// The two locales format dates differently — this is the one place the
		// STORED value (unchanged, asserted elsewhere) is allowed to look
		// different on screen.
		expect(en).not.toBe(hu);
	});

	it('shows an unparsable date verbatim instead of "Invalid Date"', () => {
		expect(chipLabel("date", "not-a-date", "en")).toBe("not-a-date");
	});
});
