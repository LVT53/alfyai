import { describe, expect, it } from "vitest";
import { catalogueFeedsForRegion, GTFS_CATALOGUE } from "./gtfs-catalogue";
import {
	feedIdForUrl,
	formatLocalClock,
	formatLocalDateTime,
	isoMinutes,
	parseGtfsFeedExcludes,
	parseGtfsFeedUrls,
	resolveGtfsFeeds,
	timezoneForRegion,
	toRegionLocalDateTime,
	transitModeLabel,
} from "./gtfs-feeds";

describe("parseGtfsFeedUrls", () => {
	it("parses the single-url-per-region form", () => {
		const feeds = parseGtfsFeedUrls(
			"hungary=https://go.bkk.hu/api/static/v1/public-gtfs/budapest_gtfs.zip," +
				"ireland-and-northern-ireland=https://www.transportforireland.ie/transitData/Data/GTFS_All.zip," +
				"netherlands=http://gtfs.ovapi.nl/nl/gtfs-nl.zip",
		);
		expect([...feeds.keys()]).toEqual([
			"hungary",
			"ireland-and-northern-ireland",
			"netherlands",
		]);
		expect(feeds.get("netherlands")).toEqual([
			"http://gtfs.ovapi.nl/nl/gtfs-nl.zip",
		]);
	});

	it("parses the many-feeds-per-region form, `|` inside and `,` between", () => {
		const feeds = parseGtfsFeedUrls(
			"hungary=https://a.test/bkk.zip|https://b.test/volan.zip|https://c.test/mav.zip," +
				"austria=https://d.test/at.zip",
		);
		expect(feeds.get("hungary")).toEqual([
			"https://a.test/bkk.zip",
			"https://b.test/volan.zip",
			"https://c.test/mav.zip",
		]);
		expect(feeds.get("austria")).toEqual(["https://d.test/at.zip"]);
	});

	it("tolerates whitespace and ignores malformed or non-http entries", () => {
		const feeds = parseGtfsFeedUrls(
			"  hungary = https://feeds.test/hu.zip | ftp://nope , broken , =https://x , austria= ",
		);
		expect([...feeds.entries()]).toEqual([
			["hungary", ["https://feeds.test/hu.zip"]],
		]);
	});

	it("keeps the FIRST list for a duplicated region id", () => {
		const feeds = parseGtfsFeedUrls(
			"hungary=https://good.test/a.zip,hungary=https://typo.test/b.zip",
		);
		expect(feeds.get("hungary")).toEqual(["https://good.test/a.zip"]);
	});

	it("returns an empty map for empty config", () => {
		expect(parseGtfsFeedUrls("").size).toBe(0);
	});
});

describe("parseGtfsFeedExcludes", () => {
	it("groups feed ids by region and ignores malformed entries", () => {
		const excludes = parseGtfsFeedExcludes(
			" hungary:mav-gysev , hungary:bahart , netherlands:* , broken , :x , austria: ",
		);
		expect([...(excludes.get("hungary") ?? [])]).toEqual([
			"mav-gysev",
			"bahart",
		]);
		expect([...(excludes.get("netherlands") ?? [])]).toEqual(["*"]);
		expect(excludes.has("austria")).toBe(false);
	});
});

describe("feedIdForUrl", () => {
	it("derives a filename-safe id from the host plus a digest of the url", () => {
		const id = feedIdForUrl("https://gtfs.menetbrand.com/download/mav");
		expect(id).toMatch(/^gtfs-menetbrand-com-[0-9a-f]{8}$/);
	});

	it("distinguishes two feeds from the same host", () => {
		expect(feedIdForUrl("https://x.test/a")).not.toBe(
			feedIdForUrl("https://x.test/b"),
		);
	});
});

describe("resolveGtfsFeeds", () => {
	it("uses the shipped catalogue when the env is unset", () => {
		const feeds = resolveGtfsFeeds("");
		expect([...feeds.keys()].sort()).toEqual(
			Object.keys(GTFS_CATALOGUE).sort(),
		);
		expect(feeds.get("hungary")?.map((feed) => feed.id)).toContain("volanbusz");
		// Hungary needs many feeds — that is the whole point of the catalogue.
		expect((feeds.get("hungary") ?? []).length).toBeGreaterThan(15);
	});

	it("uses the catalogue for the explicit `catalogue` token too", () => {
		expect(resolveGtfsFeeds("catalogue").get("hungary")).toEqual(
			catalogueFeedsForRegion("hungary"),
		);
	});

	it("lets an explicit list override the catalogue entirely", () => {
		const feeds = resolveGtfsFeeds(
			"austria=https://at.test/a.zip|https://at.test/b.zip",
		);
		expect([...feeds.keys()]).toEqual(["austria"]);
		expect(feeds.get("austria")?.map((feed) => feed.url)).toEqual([
			"https://at.test/a.zip",
			"https://at.test/b.zip",
		]);
	});

	it("opts one region back into the catalogue with regionId=catalogue", () => {
		const feeds = resolveGtfsFeeds(
			"hungary=catalogue,austria=https://at.test/a.zip",
		);
		expect(feeds.get("hungary")).toEqual(catalogueFeedsForRegion("hungary"));
		expect(feeds.has("netherlands")).toBe(false);
	});

	it("keeps a catalogue feed's identity when its url is pasted in by hand", () => {
		const bkk = catalogueFeedsForRegion("hungary").find(
			(feed) => feed.id === "bkk",
		);
		if (!bkk) throw new Error("expected a bkk catalogue entry");
		const feeds = resolveGtfsFeeds(`hungary=${bkk.url}`);
		expect(feeds.get("hungary")).toEqual([bkk]);
	});

	it("drops excluded feeds — the MÁV licence case", () => {
		const feeds = resolveGtfsFeeds("catalogue", "hungary:mav-gysev");
		const ids = feeds.get("hungary")?.map((feed) => feed.id) ?? [];
		expect(ids).not.toContain("mav-gysev");
		expect(ids).toContain("volanbusz");
	});

	it("drops a whole region with `*`, leaving it without timetables", () => {
		const feeds = resolveGtfsFeeds("catalogue", "netherlands:*");
		expect(feeds.has("netherlands")).toBe(false);
		expect(feeds.has("hungary")).toBe(true);
	});

	it("de-duplicates a feed listed twice", () => {
		const bkk = catalogueFeedsForRegion("hungary").find(
			(feed) => feed.id === "bkk",
		);
		if (!bkk) throw new Error("expected a bkk catalogue entry");
		const feeds = resolveGtfsFeeds(`hungary=catalogue|${bkk.url}`);
		const ids = feeds.get("hungary")?.map((feed) => feed.id) ?? [];
		expect(ids.filter((id) => id === "bkk")).toHaveLength(1);
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
