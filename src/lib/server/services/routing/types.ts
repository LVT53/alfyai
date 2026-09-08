// Routing provider seam (Tier D — map/route tool).
//
// A `RoutingProvider` abstracts geocoding, routing, distance/ETA matrices and
// isochrones behind a swappable interface, so the concrete provider (ORS +
// a geocoder today; Valhalla+Photon or a commercial API tomorrow) is chosen by
// config — the same swap pattern the web-search mode switch already uses.
//
// The whole surface is DEGRADE-FIRST: expected conditions (provider not
// configured, geocoder not configured, place not found, upstream failure) are
// returned as an explicit `{ ok: false, reason, message }` outcome, never
// thrown. This mirrors research-web.ts's discipline — the tool NEVER fabricates
// a route; when it can't compute one it says so plainly.

// A single geographic point. `lng` (not `lon`) to match the tool schema's
// `{lat,lng}` contract; ORS speaks [lng,lat] pairs, which the provider maps.
export type LatLng = { lat: number; lng: number };

// Friendly travel mode exposed to the model. Maps to an ORS profile.
export type RoutingMode = "drive" | "walk" | "bike";

// ORS v2 routing profiles, keyed by our friendly mode (see MODE_TO_PROFILE).
export type OrsProfile = "driving-car" | "foot-walking" | "cycling-regular";

export const MODE_TO_PROFILE: Record<RoutingMode, OrsProfile> = {
	drive: "driving-car",
	walk: "foot-walking",
	bike: "cycling-regular",
};

// The required OSM attribution string carried on every routing result so the
// model surfaces it on user-facing routing output (ODbL/OSM requirement).
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

// An origin/destination as the model may supply it: either explicit
// coordinates or a free-text place string (auto-geocoded when a geocoder is
// configured).
export type PlaceInput = LatLng | string;

export function isLatLng(value: unknown): value is LatLng {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		typeof (value as LatLng).lat === "number" &&
		typeof (value as LatLng).lng === "number"
	);
}

// ── Structured results ─────────────────────────────────────────

export type GeocodeMatch = {
	name: string;
	lat: number;
	lng: number;
	type?: string;
	// 0..1 where available; omitted when the geocoder exposes no score.
	confidence?: number;
};

export type RouteStep = {
	distance_m: number;
	duration_s: number;
	instruction?: string;
	name?: string;
};

export type RouteLeg = {
	distance_m: number;
	duration_s: number;
	steps?: RouteStep[];
};

export type RouteData = {
	distance_m: number;
	duration_s: number;
	legs: RouteLeg[];
	// Encoded polyline (ORS default geometry) when the provider returns one.
	polyline?: string;
	// The resolved coordinates actually routed (so the model can echo what a
	// place string resolved to).
	coords: {
		origin: LatLng;
		destination: LatLng;
		waypoints?: LatLng[];
	};
};

// ── Public transport ───────────────────────────────────────────
//
// ORS serves timetables through a dedicated `public-transport` profile built
// from a GTFS feed. Its response shape is NOT the road one: a PT route carries
// `legs` (walk / pt) instead of `segments`, and `summary.transfers`. These
// types mirror the ORS 9.10.0 response classes 1:1 —
// JSONIndividualRouteResponse (routes[].legs, .departure, .arrival, .geometry,
// .summary.transfers), JSONLeg and JSONPtStop — so nothing here is guessed.

// ORS's `public-transport` profile name, as it appears in the directions path
// and in `/v2/status`'s `profiles` object.
export const PUBLIC_TRANSPORT_PROFILE = "public-transport";

// One stop on a public-transport leg (ORS JSONPtStop).
export type TransitStop = {
	name?: string;
	stopId?: string;
	// ISO instants exactly as ORS emitted them.
	arrival?: string;
	departure?: string;
	lat?: number;
	lng?: number;
};

// One leg of an itinerary. `type` is ORS's own leg type: "walk" or "pt".
export type TransitLeg = {
	type: "walk" | "pt";
	// ISO instants (offset-bearing) as ORS emitted them.
	departure?: string;
	arrival?: string;
	// Human labels for the leg's ends: the boarding stop and the alighting stop
	// for a pt leg; omitted for a walk leg, which has no named endpoints.
	from?: string;
	to?: string;
	// Line identity: `route_short_name` where the feed has one ("39A"), with
	// `lineLong` carrying `route_long_name`.
	line?: string;
	lineLong?: string;
	headsign?: string;
	// GTFS route_type (0 tram, 1 metro, 2 rail, 3 bus, …). Absent on walk legs
	// (ORS emits -1 there, which we drop).
	routeType?: number;
	// Intermediate + terminal stops ORS listed for this leg.
	stopsCount?: number;
	distance_m: number;
	duration_s: number;
	// The leg continues in the same physical vehicle as the previous one.
	sameVehicleAsPrevious?: boolean;
	// Encoded polyline for this leg alone.
	polyline?: string;
};

export type TransitItinerary = {
	// ISO instants for the whole journey (ORS route-level departure/arrival).
	departure?: string;
	arrival?: string;
	duration_s: number;
	distance_m: number;
	// Number of vehicle changes. ORS reports it in `summary.transfers`; when it
	// is absent we derive it from the pt-leg count.
	transfers: number;
	legs: TransitLeg[];
	// Whole-journey encoded polyline (ORS route-level geometry).
	polyline?: string;
};

export type TransitData = {
	// One entry for a journey query; several (the next departures) for a
	// schedule query.
	itineraries: TransitItinerary[];
	coords: { origin: LatLng; destination: LatLng };
	// The region's IANA timezone, so callers can render local clock times.
	// Absent when it could not be derived (times are then server-local).
	timezone?: string;
	// What was actually asked of ORS, echoed for the model.
	query: {
		departure?: string;
		arrival?: string;
		schedule?: boolean;
		walkingTimeMinutes?: number;
	};
};

export type MatrixData = {
	// [originIndex][destinationIndex]. `null` where the provider could not
	// compute a value (ORS emits null for unreachable pairs).
	durations_s: (number | null)[][];
	distances_m: (number | null)[][];
};

export type IsochronePolygon = {
	range_s: number;
	// Raw GeoJSON geometry (Polygon/MultiPolygon) — passed through untouched.
	geojson: unknown;
};

export type IsochroneData = {
	polygons: IsochronePolygon[];
	origin: LatLng;
};

// ── Outcomes (degrade-first) ───────────────────────────────────

export type RoutingFailureReason =
	// ORS_BASE_URL unset — routing/matrix/isochrone can't run.
	| "unconfigured"
	// GEOCODER_BASE_URL unset — a place-name string can't be resolved.
	| "geocoder_unconfigured"
	// The geocoder ran but returned no match for the query.
	| "not_found"
	// The routing engine could not snap a coordinate to its road network —
	// the point lies outside the loaded map extract (or far from any road).
	// Distinct from provider_error so the tool can say "outside coverage"
	// instead of "service unavailable".
	| "out_of_coverage"
	// Both points snapped, but no path exists between them in the graph
	// (islands, disconnected components, profile restrictions).
	| "no_route"
	// On-demand coverage: the region covering the points is still being
	// downloaded / built / started. Not an outage — ask again later.
	| "region_preparing"
	// The points span more than one map region; single-region routing only.
	| "multi_region"
	// The region cannot be served (too large for the cap, on-demand disabled,
	// or its build failed).
	| "region_unavailable"
	// The region routes fine, but has no public-transport graph: no GTFS feed
	// is configured for it, or the timetable graph is still being built.
	// Distinct from region_preparing (that one is about the ROAD graph) so the
	// tool can say "no timetables for this region" instead of "not ready yet".
	| "transit_unavailable"
	// Network error, non-2xx, malformed body, or timeout from the upstream.
	| "provider_error";

export type ProviderOutcome<T> =
	| { ok: true; data: T }
	| { ok: false; reason: RoutingFailureReason; message: string };

export type GeocodeOutcome = ProviderOutcome<{ results: GeocodeMatch[] }>;
export type RouteOutcome = ProviderOutcome<RouteData>;
export type MatrixOutcome = ProviderOutcome<MatrixData>;
export type IsochroneOutcome = ProviderOutcome<IsochroneData>;
export type TransitOutcome = ProviderOutcome<TransitData>;

// A public-transport journey request. `departure` / `arrival` are LOCAL
// date-times without an offset ("2026-09-08T08:30:00") — the exact format
// ORS's LocalDateTime parameters take. At most one of them is honoured;
// `arrival` wins when both are set, matching "arrive by".
export type TransitQuery = {
	origin: LatLng;
	destination: LatLng;
	departure?: string;
	arrival?: string;
	// Maximum walking time for access/egress, in minutes (ORS default 15).
	walkingTimeMinutes?: number;
};

// A "next departures" request: the same journey search, run repeatedly over a
// window (ORS `schedule` + `schedule_duration` + `schedule_rows`).
export type TransitScheduleQuery = TransitQuery & {
	windowMinutes?: number;
	rows?: number;
};

// ── Provider interface ─────────────────────────────────────────

export interface RoutingProviderDeps {
	fetch: typeof fetch;
	signal?: AbortSignal;
	// Per-call timeout guard (ms). Optional — the tool envelope already applies
	// its own outer timeout; this bounds the individual upstream fetch.
	timeoutMs?: number;
}

export interface RoutingProvider {
	// Whether ORS routing is configured (ORS_BASE_URL present). Drives both the
	// registration gate and the in-tool degrade check.
	routingConfigured(): boolean;
	// Whether a geocoder is configured (GEOCODER_BASE_URL present).
	geocoderConfigured(): boolean;
	// Optional human-readable description of the region the routing graph
	// covers (e.g. "Hungary"). Surfaced to the model in the tool description
	// and in out_of_coverage failures so it can explain the limit honestly.
	coverageLabel?(): string;
	// Optional human-readable list of the regions whose timetables are loaded
	// ("Hungary, Ireland"). Empty/undefined => no region has a GTFS graph.
	transitCoverageLabel?(): string;

	geocode(input: {
		query: string;
		near?: LatLng;
		limit?: number;
	}): Promise<GeocodeOutcome>;

	route(input: {
		origin: LatLng;
		destination: LatLng;
		waypoints?: LatLng[];
		mode: RoutingMode;
	}): Promise<RouteOutcome>;

	matrix(input: {
		origins: LatLng[];
		destinations: LatLng[];
		mode: RoutingMode;
	}): Promise<MatrixOutcome>;

	isochrone(input: {
		origin: LatLng;
		mode: RoutingMode;
		rangesS: number[];
	}): Promise<IsochroneOutcome>;

	// Public transport. Optional on the interface so a provider without a GTFS
	// graph simply omits them; the tool reports `transit_unavailable` then.
	transit?(input: TransitQuery): Promise<TransitOutcome>;
	transitSchedule?(input: TransitScheduleQuery): Promise<TransitOutcome>;
}
