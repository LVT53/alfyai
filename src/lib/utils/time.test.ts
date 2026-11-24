import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "$lib/i18n";
import { uiLanguage } from "$lib/stores/settings";
import { formatAgo, formatMediumDateTime, formatRelativeTime } from "./time";

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

describe("formatAgo", () => {
	const DAY = 86_400_000;
	const NOW = Date.parse("2026-11-23T12:00:00.000Z");
	const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

	afterEach(() => {
		uiLanguage.set("en");
	});

	it.each([
		[
			"en",
			[
				"today",
				"yesterday",
				"3 days ago",
				"2 weeks ago",
				"2 months ago",
				"2 years ago",
			],
		],
		["hu", ["ma", "tegnap", "3 napja", "2 hete", "2 hónapja", "2 éve"]],
	] as const)(
		"says it in whole days, weeks, months and years in %s",
		(language, words) => {
			uiLanguage.set(language);
			const translate = get(t);
			const days = [0, 1, 3, 14, 60, 730];
			expect(
				days.map((count) => formatAgo(ago(count), { t: translate, now: NOW })),
			).toEqual([...words]);
		},
	);

	it("reads a unix time in seconds or milliseconds, and says nothing for a time it cannot read", () => {
		const translate = get(t);
		const threeDays = NOW - 3 * DAY;
		expect(
			formatAgo(Math.floor(threeDays / 1000), { t: translate, now: NOW }),
		).toBe("3 days ago");
		expect(formatAgo(threeDays, { t: translate, now: NOW })).toBe("3 days ago");
		expect(formatAgo("not a date", { t: translate, now: NOW })).toBe("");
	});

	it("counts a time in the future as today and defaults to the clock", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		try {
			const translate = get(t);
			expect(formatAgo(NOW + 5 * DAY, { t: translate })).toBe("today");
			expect(formatAgo(ago(3), { t: translate })).toBe("3 days ago");
		} finally {
			vi.useRealTimers();
		}
	});
});
