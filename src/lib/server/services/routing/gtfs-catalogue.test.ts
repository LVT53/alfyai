import { describe, expect, it } from "vitest";
import {
	catalogueFeedByUrl,
	catalogueFeedsForRegion,
	catalogueRegionIds,
	GTFS_CATALOGUE,
	transitCoverageLabelFor,
	transitCoverageNote,
} from "./gtfs-catalogue";

describe("the shipped catalogue", () => {
	const everyFeed = Object.values(GTFS_CATALOGUE).flat();

	it("gives every feed a unique, filename-safe id and an http(s) url", () => {
		const ids = everyFeed.map((feed) => feed.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const feed of everyFeed) {
			expect(feed.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
			expect(feed.url).toMatch(/^https?:\/\//);
			expect(feed.name.trim()).not.toBe("");
			expect(feed.refreshDays ?? 1).toBeGreaterThan(0);
		}
	});

	it("covers Hungary with the whole national bundle, not just Budapest", () => {
		const ids = catalogueFeedsForRegion("hungary").map((feed) => feed.id);
		// The three pillars plus the city operators: Hungary publishes no
		// national feed, so this list IS one.
		expect(ids).toEqual(
			expect.arrayContaining(["bkk", "volanbusz", "mav-gysev"]),
		);
		expect(ids.length).toBeGreaterThan(15);
	});

	it("records the licence an operator has to honour for the rail feed", () => {
		const rail = catalogueFeedsForRegion("hungary").find(
			(feed) => feed.id === "mav-gysev",
		);
		expect(rail?.licence).toContain("MÁV");
		expect(rail?.notes).toContain("request form");
	});

	it("finds a feed by its exact url and nothing else", () => {
		const bkk = catalogueFeedsForRegion("hungary").find(
			(feed) => feed.id === "bkk",
		);
		if (!bkk) throw new Error("expected a bkk entry");
		expect(catalogueFeedByUrl(bkk.url)).toEqual(bkk);
		expect(catalogueFeedByUrl(`${bkk.url}?x=1`)).toBeNull();
	});

	it("lists exactly the regions it has entries for", () => {
		expect(catalogueRegionIds().sort()).toEqual(
			Object.keys(GTFS_CATALOGUE).sort(),
		);
		expect(catalogueFeedsForRegion("austria")).toEqual([]);
	});
});

describe("transitCoverageNote", () => {
	it("claims national Hungarian coverage only with rail, coaches AND Budapest", () => {
		const note = transitCoverageNote("hungary", [
			"mav-gysev",
			"volanbusz",
			"bkk",
			"debrecen",
			"szeged",
		]);
		expect(note).toContain("national coverage");
		expect(note).toContain("MÁV/GYSEV rail");
		expect(note).toContain("Volánbusz coaches");
		expect(note).toContain("2 city operators");
	});

	it("drops the national claim when the rail feed was excluded", () => {
		const note = transitCoverageNote("hungary", ["volanbusz", "bkk"]);
		expect(note).not.toContain("national");
		expect(note).not.toContain("rail");
		expect(note).toContain("Volánbusz coaches");
	});

	it("says nothing at all when no feed actually loaded", () => {
		expect(transitCoverageNote("hungary", [])).toBeNull();
		expect(transitCoverageNote("austria", ["whatever"])).toBeNull();
	});

	it("describes the single-feed regions from their loaded feed", () => {
		expect(transitCoverageNote("netherlands", ["ovapi-nl"])).toContain(
			"NS rail",
		);
		expect(
			transitCoverageNote("ireland-and-northern-ireland", ["tfi-all"]),
		).toContain("Republic of Ireland");
	});
});

describe("transitCoverageLabelFor", () => {
	it("appends the note in parentheses", () => {
		expect(
			transitCoverageLabelFor("netherlands", "Netherlands", ["ovapi-nl"]),
		).toBe("Netherlands (national coverage: all operators incl. NS rail)");
	});

	it("falls back to the bare region name when there is nothing to add", () => {
		expect(transitCoverageLabelFor("austria", "Austria", ["x"])).toBe(
			"Austria",
		);
	});
});
