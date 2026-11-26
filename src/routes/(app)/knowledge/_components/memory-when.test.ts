import { describe, expect, it } from "vitest";
import { mentionedWhen, monthAndYear } from "./memory-when";

const NOW = new Date("2026-11-24T12:00:00Z");

describe("when an entry was last mentioned", () => {
	it("says today, yesterday and a few days ago", () => {
		expect(mentionedWhen("2026-11-24T08:00:00Z", NOW, "en")).toEqual({
			kind: "today",
		});
		expect(mentionedWhen("2026-11-23T12:00:00Z", NOW, "en")).toEqual({
			kind: "yesterday",
		});
		expect(mentionedWhen("2026-11-21T12:00:00Z", NOW, "hu")).toEqual({
			kind: "daysAgo",
			count: 3,
		});
	});

	it("gives a day and month after six days, and the year when it is another", () => {
		expect(mentionedWhen("2026-11-14T12:00:00Z", NOW, "en")).toEqual({
			kind: "date",
			text: "14 November",
		});
		expect(mentionedWhen("2026-11-14T12:00:00Z", NOW, "hu")).toEqual({
			kind: "date",
			text: "november 14.",
		});
		expect(mentionedWhen("2025-11-14T12:00:00Z", NOW, "en")).toEqual({
			kind: "date",
			text: "14 November 2025",
		});
		expect(mentionedWhen("2025-11-14T12:00:00Z", NOW, "hu")).toEqual({
			kind: "date",
			text: "2025. november 14.",
		});
	});

	it("says nothing for no date or a date it cannot read", () => {
		expect(mentionedWhen(null, NOW, "en")).toBeNull();
		expect(mentionedWhen("not a date", NOW, "en")).toBeNull();
	});
});

describe("the date an earlier state is given", () => {
	const later = new Date("2026-11-24T12:00:00Z");
	it("gives the month and year in either language", () => {
		expect(monthAndYear("2025-03-14T09:30:00.000Z", later, "en")).toBe(
			"March 2025",
		);
		expect(monthAndYear("2025-03-14T09:30:00.000Z", later, "hu")).toBe(
			"2025. március",
		);
		expect(monthAndYear(null, later, "en")).toBeNull();
	});

	it("gives none for a date after now (an older fact about a plan carries the plan's date)", () => {
		expect(monthAndYear("2027-03-01T09:00:00.000Z", later, "en")).toBeNull();
		expect(monthAndYear("2026-11-24T12:00:01.000Z", later, "hu")).toBeNull();
		expect(monthAndYear("2026-11-24T12:00:00.000Z", later, "en")).toBe(
			"November 2026",
		);
	});
});
