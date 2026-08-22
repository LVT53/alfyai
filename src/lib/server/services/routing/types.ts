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
	// Network error, non-2xx, malformed body, or timeout from the upstream.
	| "provider_error";

export type ProviderOutcome<T> =
	| { ok: true; data: T }
	| { ok: false; reason: RoutingFailureReason; message: string };

export type GeocodeOutcome = ProviderOutcome<{ results: GeocodeMatch[] }>;
export type RouteOutcome = ProviderOutcome<RouteData>;
export type MatrixOutcome = ProviderOutcome<MatrixData>;
export type IsochroneOutcome = ProviderOutcome<IsochroneData>;

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
}
