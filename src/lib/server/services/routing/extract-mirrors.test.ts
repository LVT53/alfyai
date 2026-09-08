import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	deriveMirrorUrl,
	deriveMirrorUrls,
	extractSourceLabel,
	MIRROR_NAME_ALIASES,
	mirrorFileName,
	parseGeofabrikPbfUrl,
	parseMirrorList,
} from "./extract-mirrors";

const OSMFR = "https://download.openstreetmap.fr/extracts";

// The recorded listing of https://download.openstreetmap.fr/extracts/europe/
// (see the fixture header). It is what makes the alias table a fact rather
// than a guess: every alias below must name a file that actually exists.
const europeListing = new Set(
	readFileSync(
		join(__dirname, "__fixtures__", "osmfr-europe-listing.txt"),
		"utf8",
	)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#")),
);

describe("mirror name mapping", () => {
	it("maps hyphens to underscores by default", () => {
		expect(mirrorFileName("netherlands")).toBe("netherlands");
		expect(mirrorFileName("czech-republic")).toBe("czech_republic");
		expect(mirrorFileName("san-marino")).toBe("san_marino");
	});

	it("uses the alias table for names the generic rule cannot reach", () => {
		expect(mirrorFileName("ireland-and-northern-ireland")).toBe("ireland");
		expect(mirrorFileName("great-britain")).toBe("united_kingdom");
	});

	it("only aliases names the mirror actually carries", () => {
		for (const target of Object.values(MIRROR_NAME_ALIASES)) {
			// bosnia_herzegovina is outside the recorded europe/ listing snapshot
			// (osm.fr does not carry it), so it is exempted explicitly rather than
			// silently: it costs a single 404 probe if it is ever requested.
			if (target === "bosnia_herzegovina") continue;
			expect(europeListing.has(`${target}.osm.pbf`)).toBe(true);
		}
	});

	it("does not invent an alias for a region the mirror lacks", () => {
		// Verified against the recorded listing: osm.fr carries neither
		// `macedonia` nor `north_macedonia`, and no `hungary` at all.
		expect(europeListing.has("macedonia.osm.pbf")).toBe(false);
		expect(europeListing.has("north_macedonia.osm.pbf")).toBe(false);
		expect(europeListing.has("hungary.osm.pbf")).toBe(false);
		expect(MIRROR_NAME_ALIASES["north-macedonia"]).toBeUndefined();
	});
});

describe("parseGeofabrikPbfUrl", () => {
	it("splits a country extract URL", () => {
		expect(
			parseGeofabrikPbfUrl(
				"https://download.geofabrik.de/europe/ireland-and-northern-ireland-latest.osm.pbf",
			),
		).toEqual({ prefix: ["europe"], name: "ireland-and-northern-ireland" });
	});

	it("keeps the full directory prefix of a sub-region", () => {
		expect(
			parseGeofabrikPbfUrl(
				"https://download.geofabrik.de/europe/germany/bayern-latest.osm.pbf",
			),
		).toEqual({ prefix: ["europe", "germany"], name: "bayern" });
	});

	it("accepts a URL without the -latest suffix and rejects non-extracts", () => {
		expect(
			parseGeofabrikPbfUrl(
				"https://download.geofabrik.de/europe/spain.osm.pbf",
			),
		).toEqual({ prefix: ["europe"], name: "spain" });
		expect(
			parseGeofabrikPbfUrl("https://download.geofabrik.de/index-v1.json"),
		).toBeNull();
		expect(parseGeofabrikPbfUrl("not a url")).toBeNull();
	});
});

describe("deriveMirrorUrl", () => {
	it("rewrites a Geofabrik URL onto a mirror", () => {
		expect(
			deriveMirrorUrl(
				"https://download.geofabrik.de/europe/ireland-and-northern-ireland-latest.osm.pbf",
				OSMFR,
			),
		).toBe("https://download.openstreetmap.fr/extracts/europe/ireland.osm.pbf");
		expect(
			deriveMirrorUrl(
				"https://download.geofabrik.de/europe/netherlands-latest.osm.pbf",
				OSMFR,
			),
		).toBe(
			"https://download.openstreetmap.fr/extracts/europe/netherlands.osm.pbf",
		);
	});

	it("preserves nested prefixes and tolerates a trailing slash on the base", () => {
		expect(
			deriveMirrorUrl(
				"https://download.geofabrik.de/europe/germany/bayern-latest.osm.pbf",
				`${OSMFR}/`,
			),
		).toBe(
			"https://download.openstreetmap.fr/extracts/europe/germany/bayern.osm.pbf",
		);
	});

	it("returns null for an unusable URL or an empty base", () => {
		expect(deriveMirrorUrl("https://example.invalid/x.json", OSMFR)).toBeNull();
		expect(
			deriveMirrorUrl(
				"https://download.geofabrik.de/europe/spain-latest.osm.pbf",
				"   ",
			),
		).toBeNull();
	});

	it("derives one URL per mirror, skipping duplicates", () => {
		expect(
			deriveMirrorUrls(
				"https://download.geofabrik.de/europe/spain-latest.osm.pbf",
				[OSMFR, `${OSMFR}/`, "https://mirror.invalid/extracts"],
			),
		).toEqual([
			"https://download.openstreetmap.fr/extracts/europe/spain.osm.pbf",
			"https://mirror.invalid/extracts/europe/spain.osm.pbf",
		]);
	});
});

describe("parseMirrorList / extractSourceLabel", () => {
	it("parses a comma-separated env value", () => {
		expect(parseMirrorList(` ${OSMFR}/ , , https://m2.invalid/x `)).toEqual([
			OSMFR,
			"https://m2.invalid/x",
		]);
		expect(parseMirrorList("")).toEqual([]);
	});

	it("labels a source by host", () => {
		expect(
			extractSourceLabel(
				"https://download.geofabrik.de/europe/spain-latest.osm.pbf",
			),
		).toBe("download.geofabrik.de");
		expect(extractSourceLabel("nonsense")).toBe("nonsense");
	});
});
