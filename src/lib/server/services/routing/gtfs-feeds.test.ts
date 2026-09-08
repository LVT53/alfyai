import { describe, expect, it } from "vitest";
import {
	formatLocalClock,
	formatLocalDateTime,
	isoMinutes,
	parseGtfsFeeds,
	timezoneForRegion,
	toRegionLocalDateTime,
	transitModeLabel,
} from "./gtfs-feeds";

describe("parseGtfsFeeds", () => {
	it("parses the documented three-region configuration", () => {
		const feeds = parseGtfsFeeds(
			"hungary=https://go.bkk.hu/api/static/v1/public-gtfs/budapest_gtfs.zip," +
				"ireland-and-northern-ireland=https://www.transportforireland.ie/transitData/Data/GTFS_All.zip," +
				"netherlands=http://gtfs.ovapi.nl/nl/gtfs-nl.zip",
		);
		expect([...feeds.keys()]).toEqual([
			"hungary",
			"ireland-and-northern-ireland",
			"netherlands",
		]);
		expect(feeds.get("netherlands")).toBe(
			"http://gtfs.ovapi.nl/nl/gtfs-nl.zip",
		);
	});

	it("tolerates whitespace and ignores malformed or non-http entries", () => {
		const feeds = parseGtfsFeeds(
			"  hungary = https://feeds.test/hu.zip , broken , =https://x , austria= , ftp=ftp://nope",
		);
		expect([...feeds.entries()]).toEqual([
			["hungary", "https://feeds.test/hu.zip"],
		]);
	});

	it("keeps the FIRST url for a duplicated region id", () => {
		const feeds = parseGtfsFeeds(
			"hungary=https://good.test/a.zip,hungary=https://typo.test/b.zip",
		);
		expect(feeds.get("hungary")).toBe("https://good.test/a.zip");
	});

	it("returns an empty map for empty config", () => {
		expect(parseGtfsFeeds("").size).toBe(0);
	});
});

describe("timezoneForRegion", () => {
	it("uses the explicit table for the regions we ship feeds for", () => {
		expect(timezoneForRegion("hungary")).toBe("Europe/Budapest");
		expect(timezoneForRegion("ireland-and-northern-ireland")).toBe(
			"Europe/Dublin",
		);
		expect(timezoneForRegion("netherlands")).toBe("Europe/Amsterdam");
	});

	it("falls back to the bounding box for an unlisted region", () => {
		// Somewhere in central Europe → UTC+1 block.
		expect(
			timezoneForRegion("some-unlisted-state", {
				minLng: 10,
				maxLng: 12,
				minLat: 47,
				maxLat: 49,
			}),
		).toBe("Europe/Berlin");
		// Finland-ish → UTC+2 block.
		expect(
			timezoneForRegion("another-unlisted", {
				minLng: 24,
				maxLng: 26,
				minLat: 60,
				maxLat: 62,
			}),
		).toBe("Europe/Helsinki");
	});

	it("returns null when nothing answers", () => {
		expect(timezoneForRegion("mars")).toBeNull();
		expect(
			timezoneForRegion("mid-pacific", {
				minLng: -160,
				maxLng: -150,
				minLat: 0,
				maxLat: 10,
			}),
		).toBeNull();
	});
});

describe("formatLocalDateTime", () => {
	// 2026-07-01T10:00:00Z: Budapest is UTC+2 (CEST), Dublin UTC+1 (IST).
	const summer = new Date("2026-07-01T10:00:00Z");

	it("renders ORS's offsetless local date-time in the region's zone", () => {
		expect(formatLocalDateTime(summer, "Europe/Budapest")).toBe(
			"2026-07-01T12:00:00",
		);
		expect(formatLocalDateTime(summer, "Europe/Dublin")).toBe(
			"2026-07-01T11:00:00",
		);
	});

	it("honours the winter offset of the same zone", () => {
		const winter = new Date("2026-01-15T10:00:00Z");
		expect(formatLocalDateTime(winter, "Europe/Budapest")).toBe(
			"2026-01-15T11:00:00",
		);
	});

	it("falls back to server-local time for an unknown zone", () => {
		const value = formatLocalDateTime(summer, "Not/AZone");
		expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
	});
});

describe("formatLocalClock", () => {
	it("renders an offset-bearing ORS timestamp as HH:MM in the region's zone", () => {
		expect(
			formatLocalClock("2026-07-01T12:31:00+02:00", "Europe/Budapest"),
		).toBe("12:31");
		expect(formatLocalClock("2026-07-01T10:31:00Z", "Europe/Budapest")).toBe(
			"12:31",
		);
	});

	it("returns undefined for missing or unparseable values", () => {
		expect(formatLocalClock(undefined, "Europe/Budapest")).toBeUndefined();
		expect(formatLocalClock("not a time", "Europe/Budapest")).toBeUndefined();
	});
});

describe("toRegionLocalDateTime", () => {
	const nowMs = new Date("2026-07-01T10:00:00Z").getTime();

	it("passes a local date-time through, filling in seconds", () => {
		expect(
			toRegionLocalDateTime("2026-09-08T08:30", "Europe/Budapest", nowMs),
		).toBe("2026-09-08T08:30:00");
		expect(
			toRegionLocalDateTime("2026-09-08T08:30:15", "Europe/Budapest", nowMs),
		).toBe("2026-09-08T08:30:15");
	});

	it("converts an absolute instant into the region's local time", () => {
		expect(
			toRegionLocalDateTime("2026-07-01T06:30:00Z", "Europe/Budapest", nowMs),
		).toBe("2026-07-01T08:30:00");
	});

	it("places a bare clock time on the region's today", () => {
		expect(toRegionLocalDateTime("8:05", "Europe/Budapest", nowMs)).toBe(
			"2026-07-01T08:05:00",
		);
	});

	it("returns null for something it cannot understand", () => {
		expect(
			toRegionLocalDateTime("tomorrow morning", "Europe/Budapest", nowMs),
		).toBeNull();
		expect(toRegionLocalDateTime("99:99", "Europe/Budapest", nowMs)).toBeNull();
		expect(toRegionLocalDateTime("   ", "Europe/Budapest", nowMs)).toBeNull();
	});
});

describe("isoMinutes", () => {
	it("renders ORS's ISO-8601 minute durations", () => {
		expect(isoMinutes(15)).toBe("PT15M");
		expect(isoMinutes(120)).toBe("PT120M");
		expect(isoMinutes(0)).toBe("PT1M");
	});
});

describe("transitModeLabel", () => {
	it("names the basic GTFS route types", () => {
		expect(transitModeLabel(0)).toBe("tram");
		expect(transitModeLabel(1)).toBe("metro");
		expect(transitModeLabel(2)).toBe("train");
		expect(transitModeLabel(3)).toBe("bus");
		expect(transitModeLabel(4)).toBe("ferry");
		expect(transitModeLabel(11)).toBe("trolleybus");
	});

	it("groups the extended route types by their hundreds block", () => {
		expect(transitModeLabel(109)).toBe("train");
		expect(transitModeLabel(200)).toBe("coach");
		expect(transitModeLabel(401)).toBe("metro");
		expect(transitModeLabel(702)).toBe("bus");
		expect(transitModeLabel(900)).toBe("tram");
		expect(transitModeLabel(1400)).toBe("funicular");
	});

	it("says nothing for a walk leg (-1) or an unknown value", () => {
		expect(transitModeLabel(-1)).toBeUndefined();
		expect(transitModeLabel(undefined)).toBeUndefined();
		expect(transitModeLabel(42)).toBeUndefined();
		expect(transitModeLabel(1700)).toBeUndefined();
	});
});
