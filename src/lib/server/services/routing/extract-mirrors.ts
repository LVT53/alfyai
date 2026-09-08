// Mirror fallback for OSM extract downloads.
//
// Geofabrik is the catalogue (index-v1.json gives every region its polygon and
// its `*-latest.osm.pbf` URL), but it is not a reliable *download* host: in
// September 2026 `download.geofabrik.de` served the index with 200 while every
// `*.osm.pbf` answered 502 for days, which left a queued region stuck in
// `error` with nothing to fall back to.
//
// So the downloader keeps Geofabrik as the primary source and falls back to
// plain HTTP mirrors that publish the same extracts under a slightly different
// naming scheme. The osm.fr mirror is the default:
//
//   Geofabrik  https://download.geofabrik.de/europe/ireland-and-northern-ireland-latest.osm.pbf
//   osm.fr     https://download.openstreetmap.fr/extracts/europe/ireland.osm.pbf
//
// Two differences to bridge: the `-latest` suffix is absent, and names use
// underscores rather than hyphens. A handful of regions are also named
// differently enough that the mechanical rule cannot reach them, hence the
// alias table below.

// Geofabrik region name → mirror file name. Verified against a recorded
// listing of https://download.openstreetmap.fr/extracts/europe/ (see
// __fixtures__/osmfr-europe-listing.txt); entries that the generic rule would
// already produce are kept for documentation.
//
// Deliberately NOT here: `north-macedonia`. The osm.fr europe listing has
// neither `macedonia` nor `north_macedonia`, so guessing an alias would only
// produce a 404 that costs a probe.
export const MIRROR_NAME_ALIASES: Readonly<Record<string, string>> = {
	"ireland-and-northern-ireland": "ireland",
	"great-britain": "united_kingdom",
	"czech-republic": "czech_republic",
	"bosnia-herzegovina": "bosnia_herzegovina",
};

// Generic rule: hyphens become underscores.
export function mirrorFileName(regionName: string): string {
	return MIRROR_NAME_ALIASES[regionName] ?? regionName.replace(/-/g, "_");
}

// Split a Geofabrik pbf URL into the directory prefix and the region name:
// ".../europe/germany/bayern-latest.osm.pbf" → ["europe", "germany"], "bayern".
export function parseGeofabrikPbfUrl(
	pbfUrl: string,
): { prefix: string[]; name: string } | null {
	let path: string;
	try {
		path = new URL(pbfUrl).pathname;
	} catch {
		return null;
	}
	const segments = path.split("/").filter(Boolean);
	const file = segments.pop();
	if (!file) return null;
	const match = file.match(/^(.+?)(?:-latest)?\.osm\.pbf$/);
	if (!match) return null;
	return { prefix: segments, name: match[1] };
}

// Mirror URL for one mirror base, or null when the URL is not a recognizable
// extract URL. Continent-level extracts (no directory prefix) are mapped too;
// they are refused later by the size cap, not here.
export function deriveMirrorUrl(
	pbfUrl: string,
	mirrorBase: string,
): string | null {
	const parsed = parseGeofabrikPbfUrl(pbfUrl);
	if (!parsed) return null;
	const base = mirrorBase.trim().replace(/\/+$/, "");
	if (!base) return null;
	const parts = [...parsed.prefix, `${mirrorFileName(parsed.name)}.osm.pbf`];
	return `${base}/${parts.join("/")}`;
}

export function deriveMirrorUrls(
	pbfUrl: string,
	mirrorBases: readonly string[],
): string[] {
	const urls: string[] = [];
	for (const base of mirrorBases) {
		const url = deriveMirrorUrl(pbfUrl, base);
		if (url && !urls.includes(url) && url !== pbfUrl) urls.push(url);
	}
	return urls;
}

// Comma-separated env value → mirror bases.
export function parseMirrorList(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim().replace(/\/+$/, ""))
		.filter(Boolean);
}

// Short label persisted in `routing_regions.extract_source` and logged.
export function extractSourceLabel(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
