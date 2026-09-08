// The shipped GTFS feed catalogue.
//
// ORS's `public-transport` profile is configured with a single
// `gtfs_file` STRING — but GraphHopper 4.14 (the reader-gtfs inside ORS 9.10)
// splits that string on commas and loads each path as its own feed
// (`gtfs_<n>`), and ORS hands the configured value to `Path.toAbsolutePath()`
// unchanged. So one region can carry MANY feeds:
//
//   gtfs_file=/home/ors/files/hungary-gtfs-bkk.zip,/home/ors/files/hungary-gtfs-volanbusz.zip,…
//
// Overlapping feeds are fine: two operators that both serve a stop are simply
// two sets of trips, and a transfer between them is a walk on the street graph
// like any other. That is what makes national coverage possible in countries
// that publish no single national feed — Hungary has ~21 official feeds and no
// merged one, so the catalogue below IS the national feed.
//
// Every URL here was fetched from the production host and answered 200/206
// with a zip magic number. Entries are DATA, not promises: a feed that is down
// on the day a region builds costs that operator's trips and nothing else (see
// `region-manager.ts`, which skips failed feeds and builds from the rest).

// One feed in the catalogue, or one resolved from `ROUTING_GTFS_FEEDS`.
export type GtfsFeed = {
	// Stable, filename-safe id. It names the downloaded zip
	// (`files/<slug>-gtfs-<id>.zip`) and keys the per-feed state, so changing
	// one re-downloads that feed.
	id: string;
	// Human label for the admin table and the log line.
	name: string;
	url: string;
	// Licence / terms, where the publisher states them. Recorded so an operator
	// can see what they are redistributing before switching a region on.
	licence?: string;
	// Published by (or on behalf of) the transport authority itself.
	official?: boolean;
	notes?: string;
	// Per-feed refresh cadence in days. Falls back to
	// ROUTING_GTFS_REFRESH_DAYS when absent.
	refreshDays?: number;
};

// Geofabrik region id → the feeds that cover it.
export const GTFS_CATALOGUE: Readonly<Record<string, readonly GtfsFeed[]>> = {
	netherlands: [
		{
			id: "ovapi-nl",
			name: "OVapi Netherlands (all operators, incl. NS rail)",
			url: "http://gtfs.ovapi.nl/nl/gtfs-nl.zip",
			licence: "open",
			official: true,
			refreshDays: 3,
		},
	],
	"ireland-and-northern-ireland": [
		{
			id: "tfi-all",
			name: "Transport for Ireland combined (104 agencies: Dublin Bus, Bus Éireann, Irish Rail, Luas, Go-Ahead, Local Link, Aircoach, Citylink, …)",
			url: "https://www.transportforireland.ie/transitData/Data/GTFS_All.zip",
			licence: "open (NTA)",
			official: true,
			refreshDays: 7,
			// Northern Ireland (Translink) publishes no GTFS at all; its ATCO-CIF
			// open datasets are years stale, so the North is deliberately absent.
			notes: "Republic of Ireland only — Translink publishes no GTFS",
		},
	],
	hungary: [
		{
			id: "bkk",
			name: "BKK Budapest (incl. MÁV-HÉV)",
			url: "https://go.bkk.hu/api/static/v1/public-gtfs/budapest_gtfs.zip",
			licence: "open",
			official: true,
			refreshDays: 1,
		},
		{
			id: "volanbusz",
			name: "Volánbusz national + regional buses (61 agencies)",
			url: "https://gtfs.kti.hu/public-gtfs/volanbusz_gtfs.zip",
			licence: "CC0-1.0",
			official: true,
			refreshDays: 7,
		},
		{
			id: "mav-gysev",
			name: "MÁV-START + GYSEV + Gyermekvasút rail",
			url: "https://gtfs.menetbrand.com/download/mav",
			// The data is MÁV's own, relayed by menetbrand. MÁV asks users to file
			// its (free) GTFS request form; an operator without that permission
			// should exclude this feed — see ROUTING_GTFS_FEED_EXCLUDE.
			licence: "MÁV terms (free request form)",
			official: true,
			refreshDays: 7,
			notes:
				"MÁV asks GTFS users to file its free request form; exclude this feed if you have not",
		},
		{
			id: "debrecen",
			name: "DKV Debrecen",
			url: "https://gtfs.menetbrand.com/download/debrecen",
			official: true,
			refreshDays: 7,
		},
		{
			id: "szeged",
			name: "SZKT Szeged",
			url: "https://gtfs.menetbrand.com/download/szeged",
			official: true,
			refreshDays: 7,
		},
		{
			id: "pecs",
			name: "Tüke Busz Pécs",
			url: "https://gtfs.menetbrand.com/download/pecs",
			official: true,
			refreshDays: 7,
		},
		{
			id: "miskolc",
			name: "MVK Miskolc",
			url: "https://gtfs.menetbrand.com/download/miskolc",
			official: true,
			refreshDays: 7,
		},
		{
			id: "kaposvar",
			name: "KVK Kaposvár",
			url: "https://gtfs.menetbrand.com/download/kaposvar",
			official: true,
			refreshDays: 7,
		},
		{
			id: "tatabanya",
			name: "T-Busz Tatabánya",
			url: "https://gtfs.menetbrand.com/download/tatabanya",
			official: true,
			refreshDays: 7,
		},
		{
			id: "veszprem",
			name: "V-Busz Veszprém",
			url: "https://gtfs.menetbrand.com/download/veszprem",
			official: true,
			refreshDays: 7,
		},
		{
			id: "szombathely",
			name: "Blaguss Agora Szombathely",
			url: "https://gtfs.menetbrand.com/download/szombathely",
			official: true,
			refreshDays: 7,
		},
		{
			id: "szekesfehervar",
			name: "Székesfehérvár",
			url: "https://gtfs.menetbrand.com/download/szekesfehervar",
			official: true,
			refreshDays: 7,
		},
		{
			id: "kiskunhalas",
			name: "Halasbusz Kiskunhalas",
			url: "https://gtfs.menetbrand.com/download/kiskunhalas",
			official: true,
			refreshDays: 14,
		},
		{
			id: "paks",
			name: "Paks",
			url: "https://gtfs.menetbrand.com/download/paks",
			official: true,
			refreshDays: 14,
		},
		{
			id: "hodmezovasarhely",
			name: "Hódmezővásárhely",
			url: "https://gtfs.menetbrand.com/download/hodmezovasarhely",
			official: true,
			refreshDays: 14,
		},
		{
			id: "dombovar",
			name: "Dombóvár",
			url: "https://gtfs.menetbrand.com/download/dombovar",
			official: true,
			refreshDays: 14,
		},
		{
			id: "varpalota",
			name: "Thury-Busz Várpalota",
			url: "https://gtfs.menetbrand.com/download/varpalota",
			official: true,
			refreshDays: 14,
		},
		{
			id: "budaors",
			name: "Budaörs",
			url: "https://gtfs.menetbrand.com/download/budaors",
			official: true,
			refreshDays: 14,
		},
		{
			id: "bahart",
			name: "Bahart Balaton ferries",
			url: "https://gtfs.menetbrand.com/download/bahart",
			official: true,
			refreshDays: 14,
		},
		{
			id: "weekendbus",
			name: "WeekendBus Csömör/Pécel",
			url: "https://gtfs.menetbrand.com/download/weekendbus",
			official: true,
			refreshDays: 14,
		},
		{
			id: "oroshaza",
			name: "Orosháza (FlexCom)",
			url: "https://gtfs.gpspositions.net/storage/exports/OROSH_V_ONK/gtfs_latest.zip",
			official: true,
			refreshDays: 14,
		},
	],
};

export function catalogueFeedsForRegion(regionId: string): GtfsFeed[] {
	return [...(GTFS_CATALOGUE[regionId] ?? [])];
}

export function catalogueRegionIds(): string[] {
	return Object.keys(GTFS_CATALOGUE);
}

// The catalogue feed whose URL is exactly `url`, so an operator who pastes a
// catalogue URL into ROUTING_GTFS_FEEDS still gets its id, name and cadence.
export function catalogueFeedByUrl(url: string): GtfsFeed | null {
	const wanted = url.trim();
	for (const feeds of Object.values(GTFS_CATALOGUE)) {
		for (const feed of feeds) {
			if (feed.url === wanted) return feed;
		}
	}
	return null;
}

// ── Coverage wording for the tool description ──────────────────
//
// The model is told which regions have timetables. For a region whose
// catalogue is a bundle of operator feeds, "Hungary" alone under-sells it and
// "Hungary (national)" over-sells it when the rail feed was excluded — so the
// sentence is built from the feeds that ACTUALLY loaded.

// The Hungarian catalogue's three pillars. National coverage is only claimed
// when all three are present.
const HU_RAIL = "mav-gysev";
const HU_COACH = "volanbusz";
const HU_BUDAPEST = "bkk";

// A short parenthetical describing what a region's loaded feeds cover, or null
// when the region name already says everything.
export function transitCoverageNote(
	regionId: string,
	loadedFeedIds: readonly string[],
): string | null {
	const ids = new Set(loadedFeedIds);
	if (ids.size === 0) return null;
	if (regionId === "hungary") {
		const parts: string[] = [];
		if (ids.has(HU_RAIL)) parts.push("MÁV/GYSEV rail");
		if (ids.has(HU_COACH)) parts.push("Volánbusz coaches");
		if (ids.has(HU_BUDAPEST)) parts.push("Budapest BKK");
		const cities = [...ids].filter(
			(id) => id !== HU_RAIL && id !== HU_COACH && id !== HU_BUDAPEST,
		).length;
		if (cities > 0) parts.push(`${cities} city operators`);
		if (parts.length === 0) return null;
		const national =
			ids.has(HU_RAIL) && ids.has(HU_COACH) && ids.has(HU_BUDAPEST);
		return `${national ? "national coverage: " : ""}${parts.join(", ")}`;
	}
	if (regionId === "netherlands" && ids.has("ovapi-nl")) {
		return "national coverage: all operators incl. NS rail";
	}
	if (regionId === "ireland-and-northern-ireland" && ids.has("tfi-all")) {
		return "Republic of Ireland: Irish Rail, Dublin Bus, Bus Éireann, Luas and 100 more";
	}
	return null;
}

// "Hungary (national coverage: MÁV/GYSEV rail, Volánbusz coaches, …)".
export function transitCoverageLabelFor(
	regionId: string,
	regionName: string,
	loadedFeedIds: readonly string[],
): string {
	const note = transitCoverageNote(regionId, loadedFeedIds);
	return note ? `${regionName} (${note})` : regionName;
}
