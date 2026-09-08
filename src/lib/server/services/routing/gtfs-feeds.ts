// Public-transport timetable feeds and the region timezone they are read in.
//
// ORS's `public-transport` profile is built from exactly ONE GTFS zip per
// profile (`ors.engine.profiles.public-transport.build.gtfs_file`), so a region
// carries at most one feed. Which feed belongs to which Geofabrik region is
// operator config — `ROUTING_GTFS_FEEDS` — parsed here.
//
// TIMEZONE: ORS's `departure` / `arrival` parameters are LOCAL date-times with
// no offset ("2026-09-08T08:30:00"), so turning "now" into a request needs the
// region's own timezone, not the server's. There is no timezone in the
// Geofabrik catalogue, so it is derived once and stored on the region row:
//
//   1. an explicit id → IANA table for the regions we ship feeds for, then
//   2. a coarse longitude/latitude bounding-box table (Europe only, where all
//      three shipped feeds live), then
//   3. null — the caller falls back to the server's own local time and says so.
//
// This is deliberately small and auditable rather than a full tz-boundary
// dataset: a timetable query is only ever issued for a region that has a feed,
// and every such region is named in the table above.

// `regionId=url[,regionId=url...]`. Whitespace around entries is ignored; the
// FIRST occurrence of a region id wins so a typo'd duplicate cannot silently
// replace a good feed.
export function parseGtfsFeeds(raw: string): Map<string, string> {
	const feeds = new Map<string, string>();
	for (const entry of (raw ?? "").split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const id = trimmed.slice(0, eq).trim();
		const url = trimmed.slice(eq + 1).trim();
		if (!id || !url) continue;
		if (!/^https?:\/\//i.test(url)) continue;
		if (feeds.has(id)) continue;
		feeds.set(id, url);
	}
	return feeds;
}

// Geofabrik region id → IANA timezone, for every region we ship a feed for
// plus its immediate neighbours in the same catalogue level.
const REGION_TIMEZONES: Record<string, string> = {
	hungary: "Europe/Budapest",
	"ireland-and-northern-ireland": "Europe/Dublin",
	netherlands: "Europe/Amsterdam",
	austria: "Europe/Vienna",
	belgium: "Europe/Brussels",
	"czech-republic": "Europe/Prague",
	germany: "Europe/Berlin",
	slovakia: "Europe/Bratislava",
	slovenia: "Europe/Ljubljana",
	croatia: "Europe/Zagreb",
	romania: "Europe/Bucharest",
	serbia: "Europe/Belgrade",
	poland: "Europe/Warsaw",
	"great-britain": "Europe/London",
	france: "Europe/Paris",
	spain: "Europe/Madrid",
	portugal: "Europe/Lisbon",
	italy: "Europe/Rome",
	switzerland: "Europe/Zurich",
	denmark: "Europe/Copenhagen",
	sweden: "Europe/Stockholm",
	norway: "Europe/Oslo",
	finland: "Europe/Helsinki",
};

// Coarse fallback for a point in Europe: the three offsets that cover the
// continent, named by a representative zone so DST is still handled correctly
// by Intl. Ordered west → east; the first box containing the point wins.
const EUROPE_TIMEZONE_BOXES: Array<{
	timezone: string;
	minLng: number;
	maxLng: number;
	minLat: number;
	maxLat: number;
}> = [
	// UTC+0 (British Isles, Portugal)
	{
		timezone: "Europe/London",
		minLng: -11,
		maxLng: 0.5,
		minLat: 35,
		maxLat: 61,
	},
	// UTC+1 (most of Western/Central Europe)
	{
		timezone: "Europe/Berlin",
		minLng: 0.5,
		maxLng: 22.9,
		minLat: 35,
		maxLat: 71,
	},
	// UTC+2 (Finland, the Baltics, the Balkans east of ~23°E)
	{
		timezone: "Europe/Helsinki",
		minLng: 22.9,
		maxLng: 32,
		minLat: 34,
		maxLat: 71,
	},
];

export type RegionBox = {
	minLng: number;
	minLat: number;
	maxLng: number;
	maxLat: number;
};

// Resolves a region's IANA timezone, preferring the explicit id table and
// falling back to the bounding box's centre. Returns null when neither
// answers — the caller must then say it used the server's local time.
export function timezoneForRegion(
	id: string,
	bbox?: RegionBox | null,
): string | null {
	const known = REGION_TIMEZONES[id];
	if (known) return known;
	if (!bbox) return null;
	const lng = (bbox.minLng + bbox.maxLng) / 2;
	const lat = (bbox.minLat + bbox.maxLat) / 2;
	for (const box of EUROPE_TIMEZONE_BOXES) {
		if (
			lng >= box.minLng &&
			lng <= box.maxLng &&
			lat >= box.minLat &&
			lat <= box.maxLat
		) {
			return box.timezone;
		}
	}
	return null;
}

function pad(value: number, width = 2): string {
	return String(value).padStart(width, "0");
}

// Formats an instant as the LOCAL date-time ORS wants: "YYYY-MM-DDTHH:mm:ss",
// no offset, no trailing Z. `timezone` null/invalid => the server's own local
// time (Intl throws on an unknown zone, which we swallow rather than fail a
// timetable lookup over a config typo).
export function formatLocalDateTime(
	date: Date,
	timezone?: string | null,
): string {
	if (timezone) {
		try {
			const parts = new Intl.DateTimeFormat("en-CA", {
				timeZone: timezone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				hour12: false,
			}).formatToParts(date);
			const get = (type: string) =>
				parts.find((part) => part.type === type)?.value ?? "";
			const year = get("year");
			const month = get("month");
			const day = get("day");
			// en-CA renders midnight as "24" in some ICU versions; normalize it.
			const hour = get("hour") === "24" ? "00" : get("hour");
			const minute = get("minute");
			const second = get("second");
			if (year && month && day && hour && minute && second) {
				return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
			}
		} catch {
			// Fall through to server-local formatting.
		}
	}
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// "HH:MM" in the region's timezone, for the compact model-facing payload and
// the chat card. Accepts anything `new Date()` parses (ORS emits offset-bearing
// ISO strings such as "2026-09-08T08:31:00+02:00").
export function formatLocalClock(
	value: string | null | undefined,
	timezone?: string | null,
): string | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return undefined;
	const local = formatLocalDateTime(date, timezone);
	return local.slice(11, 16);
}

// ORS's local-date-time shape, with the seconds optional on input.
const LOCAL_DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/;
const CLOCK_ONLY_RE = /^(\d{1,2}):(\d{2})$/;

// Normalizes whatever time the model supplied into the LOCAL date-time ORS
// takes. Three shapes are accepted, and nothing else:
//
//   "2026-09-08T08:30"      already local — used as given (seconds filled in)
//   "2026-09-08T06:30:00Z"  an absolute instant — converted into `timezone`
//   "08:30"                 a bare clock time — placed on the region's TODAY
//
// Returns null for anything unparseable, so the caller can say the time was
// not understood instead of silently querying "now".
export function toRegionLocalDateTime(
	value: string,
	timezone: string | null | undefined,
	nowMs: number,
): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const local = LOCAL_DATE_TIME_RE.exec(trimmed);
	if (local) return `${local[1]}T${local[2]}:${local[3] ?? "00"}`;
	const clock = CLOCK_ONLY_RE.exec(trimmed);
	if (clock) {
		const hour = Number(clock[1]);
		const minute = Number(clock[2]);
		if (hour > 23 || minute > 59) return null;
		const today = formatLocalDateTime(new Date(nowMs), timezone).slice(0, 10);
		return `${today}T${pad(hour)}:${pad(minute)}:00`;
	}
	const parsed = new Date(trimmed);
	if (Number.isNaN(parsed.getTime())) return null;
	return formatLocalDateTime(parsed, timezone);
}

// ISO-8601 duration for a whole number of minutes ("PT15M"), which is the only
// shape ORS's `walking_time` / `schedule_duration` need.
export function isoMinutes(minutes: number): string {
	const safe = Math.max(1, Math.round(minutes));
	return `PT${safe}M`;
}

// GTFS `route_type` → a plain word the model can say. The basic types are
// spec-fixed (0–12); the "extended" three-digit types are grouped by their
// hundreds block, which is how the GTFS extended route types are organized.
const BASIC_ROUTE_TYPES: Record<number, string> = {
	0: "tram",
	1: "metro",
	2: "train",
	3: "bus",
	4: "ferry",
	5: "cable tram",
	6: "cable car",
	7: "funicular",
	11: "trolleybus",
	12: "monorail",
};

// Hundreds block → word, per the GTFS extended route types:
// 100 railway, 200 coach, 300 suburban rail, 400/500/600 metro & underground,
// 700 bus, 800 trolleybus, 900 tram, 1000 water, 1100 air, 1200 ferry,
// 1300 aerial lift, 1400 funicular, 1500 taxi, 1700 miscellaneous.
const EXTENDED_ROUTE_TYPE_BLOCKS: Record<number, string> = {
	1: "train",
	2: "coach",
	3: "train",
	4: "metro",
	5: "metro",
	6: "metro",
	7: "bus",
	8: "trolleybus",
	9: "tram",
	10: "ferry",
	11: "air",
	12: "ferry",
	13: "cable car",
	14: "funicular",
	15: "taxi",
};

export function transitModeLabel(
	routeType: number | undefined,
): string | undefined {
	if (routeType === undefined || routeType < 0) return undefined;
	const basic = BASIC_ROUTE_TYPES[routeType];
	if (basic) return basic;
	if (routeType >= 100 && routeType < 1600) {
		return EXTENDED_ROUTE_TYPE_BLOCKS[Math.floor(routeType / 100)];
	}
	return undefined;
}
