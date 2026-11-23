import { describe, expect, it } from "vitest";
import { ageBucket } from "./age-buckets";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const daysAgo = (days: number) => NOW - days * DAY;

describe("ageBucket", () => {
	it("counts whole days elapsed, and says today for less than a day", () => {
		expect(ageBucket(NOW, NOW)).toEqual({ unit: "today" });
		expect(ageBucket(NOW - (DAY - 1), NOW)).toEqual({ unit: "today" });
		expect(ageBucket(daysAgo(1), NOW)).toEqual({ unit: "yesterday" });
		expect(ageBucket(daysAgo(1) - (DAY - 1), NOW)).toEqual({
			unit: "yesterday",
		});
	});

	it("gives days up to thirteen, then weeks, months and years", () => {
		const bucket = (days: number) => ageBucket(daysAgo(days), NOW);
		expect(bucket(2)).toEqual({ unit: "days", count: 2 });
		expect(bucket(3)).toEqual({ unit: "days", count: 3 });
		expect(bucket(13)).toEqual({ unit: "days", count: 13 });
		expect(bucket(14)).toEqual({ unit: "weeks", count: 2 });
		expect(bucket(59)).toEqual({ unit: "weeks", count: 8 });
		expect(bucket(60)).toEqual({ unit: "months", count: 2 });
		expect(bucket(729)).toEqual({ unit: "months", count: 24 });
		expect(bucket(730)).toEqual({ unit: "years", count: 2 });
		expect(bucket(1100)).toEqual({ unit: "years", count: 3 });
	});

	it("counts a date after now as today", () => {
		expect(ageBucket(NOW + 5 * DAY, NOW)).toEqual({ unit: "today" });
	});
});
