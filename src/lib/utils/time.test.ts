import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatMediumDateTime, formatRelativeTime } from "./time";

describe("formatRelativeTime", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2024-03-15T12:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns "just now" for less than 30 seconds ago', () => {
		const timestamp = new Date("2024-03-15T11:59:45.000Z").getTime();
		expect(formatRelativeTime(timestamp)).toBe("just now");
	});

	it('returns "[n] min ago" for less than 60 minutes ago', () => {
		const timestamp = new Date("2024-03-15T11:55:00.000Z").getTime();
		expect(formatRelativeTime(timestamp)).toBe("5 min ago");
	});

	it("pluralises hours in the English fallback", () => {
		const one = new Date("2024-03-15T11:00:00.000Z").getTime();
		const two = new Date("2024-03-15T10:00:00.000Z").getTime();
		expect(formatRelativeTime(one)).toBe("1 hour ago");
		expect(formatRelativeTime(two)).toBe("2 hours ago");
	});

	it("speaks through the dictionary when one is passed", () => {
		const t = (key: string, params?: Record<string, string | number>) =>
			`${key}:${params?.count ?? ""}`;
		const two = new Date("2024-03-15T10:00:00.000Z").getTime();
		expect(formatRelativeTime(two, { t })).toBe("time.relative.hours:2");
		const older = new Date("2024-03-12T12:00:00.000Z").getTime();
		expect(formatRelativeTime(older, { t, locale: "en-US" })).toBe("Mar 12");
	});

	it('returns "Yesterday" for between 1 and 2 days ago', () => {
		const timestamp = new Date("2024-03-14T08:00:00.000Z").getTime();
		expect(formatRelativeTime(timestamp)).toBe("Yesterday");
	});

	it("returns date string for older dates", () => {
		const timestamp = new Date("2024-03-12T12:00:00.000Z").getTime();
		expect(formatRelativeTime(timestamp, { locale: "en-US" })).toBe("Mar 12");
	});

	it("prints the year of an older date only when it is not the current year", () => {
		const older = new Date("2015-10-21T12:00:00.000Z").getTime();
		expect(
			formatRelativeTime(older, {
				locale: "en-US",
				yearWhenNotCurrent: true,
			}),
		).toBe("Oct 21, 2015");
		// A date in the current year keeps the short form the card already had.
		const sameYear = new Date("2024-03-12T12:00:00.000Z").getTime();
		expect(
			formatRelativeTime(sameYear, {
				locale: "en-US",
				yearWhenNotCurrent: true,
			}),
		).toBe("Mar 12");
	});

	it("handles unix timestamp in seconds", () => {
		const timestamp = Math.floor(
			new Date("2024-03-15T11:55:00.000Z").getTime() / 1000,
		);
		expect(formatRelativeTime(timestamp)).toBe("5 min ago");
	});
});

describe("formatMediumDateTime", () => {
	it("returns an em dash for missing or invalid timestamps", () => {
		expect(formatMediumDateTime(null)).toBe("—");
		expect(formatMediumDateTime(Number.NaN)).toBe("—");
	});

	it("formats timestamps with medium date and short time style", () => {
		const expected = new Intl.DateTimeFormat(undefined, {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(new Date("2024-03-15T12:00:00.000Z").getTime());

		expect(
			formatMediumDateTime(new Date("2024-03-15T12:00:00.000Z").getTime()),
		).toBe(expected);
	});
});
