// OpenRouteService (ORS) routing provider + a Nominatim geocoder.
//
// Talks to a self-hosted ORS v2 JSON API for directions / matrix / isochrones
// and to a self-hosted Nominatim geocoder for place-name → coordinate lookups.
// Both base URLs are config (ORS_BASE_URL / GEOCODER_BASE_URL): nothing leaves
// the box. Dependency-injected fetch keeps the module testable with no network.
//
// GEOCODER DECISION: self-hosted ORS core does NOT ship geocoding, so geocode
// talks to a separate Nominatim service (OSM-native, pairs with the OSM routing
// stack; here a direct Hungary import). Its `/search` endpoint returns a JSON
// ARRAY of results with `lat`/`lon` STRINGS, a `display_name` label and an
// `importance` score (0..1) — we parse the coordinates to numbers and carry
// importance through as `confidence`. Results arrive relevance-ordered, and a
// `near` point biases the search via `viewbox`+`bounded`. Nominatim's usage
// policy asks callers to send a User-Agent, so we identify with the app name.
// The provider is written against Nominatim's response shape; swapping to
// Photon/Pelias would be a new provider behind the same RoutingProvider seam.

import { isoMinutes } from "./gtfs-feeds";
import {
	type GeocodeMatch,
	type GeocodeOutcome,
	type IsochroneData,
	type IsochroneOutcome,
	type LatLng,
	type MatrixData,
	type MatrixOutcome,
	MODE_TO_PROFILE,
	PUBLIC_TRANSPORT_PROFILE,
	type RouteData,
	type RouteLeg,
	type RouteOutcome,
	type RouteStep,
	type RoutingFailureReason,
	type RoutingMode,
	type RoutingProvider,
	type RoutingProviderDeps,
	type TransitData,
	type TransitItinerary,
	type TransitLeg,
	type TransitOutcome,
	type TransitQuery,
	type TransitScheduleQuery,
	type TransitStop,
} from "./types";

export type OrsProviderConfig = {
	// ORS v2 API base, e.g. "http://127.0.0.1:8080/ors". Empty/undefined =>
	// routing degrades to "unconfigured".
	orsBaseUrl?: string;
	// Nominatim geocoder base, e.g. "http://127.0.0.1:8081". Empty/undefined =>
	// geocode degrades to "geocoder_unconfigured".
	geocoderBaseUrl?: string;
	// Region the loaded ORS graph covers (ORS_COVERAGE_LABEL, e.g. "Hungary").
	// Purely descriptive: it never gates a call, it only makes coverage misses
	// explainable.
	coverageLabel?: string;
};

const DEFAULT_TIMEOUT_MS = 20_000;
const ERROR_BODY_CHARS = 300;

// Nominatim's usage policy asks every caller to identify itself with a
// User-Agent. We self-host, but sending it keeps us well-behaved and lets ops
// attribute traffic; the app name is enough.
const NOMINATIM_USER_AGENT = "AlfyAI";
// Half-degree box (~55 km per side) drawn around a `near` point to bias the
// search to that region (Nominatim `viewbox` + `bounded=1`).
const NEAR_VIEWBOX_DELTA_DEG = 0.5;

// ORS's own default for `walking_time` is PT15M; we send it explicitly so the
// value the model sees echoed back is always the one that was used.
export const DEFAULT_WALKING_TIME_MINUTES = 15;
// "Next departures" defaults: a two-hour window, six rows.
export const DEFAULT_SCHEDULE_WINDOW_MINUTES = 120;
export const DEFAULT_SCHEDULE_ROWS = 6;

function trimBase(url: string): string {
	return url.trim().replace(/\/+$/, "");
}

// [lng, lat] — ORS coordinate order.
function toOrsCoord(point: LatLng): [number, number] {
	return [point.lng, point.lat];
}

async function readErrorBody(res: Response): Promise<string> {
	const text = await res.text().catch(() => "");
	return text.slice(0, ERROR_BODY_CHARS).trim();
}

// ORS error bodies look like {"error":{"code":2010,"message":"..."}}. The
// last two digits of the code are shared across the directions (2xxx),
// isochrones (3xxx) and matrix (6xxx) endpoints: xx09 = "route could not be
// found", xx10 = "point not found" (could not snap within the snapping
// radius — in practice: outside the loaded extract). We match on both the
// code and the message so a coverage miss is never reported as an outage.
function extractOrsError(text: string): { code?: number; message: string } {
	try {
		const parsed = JSON.parse(text) as {
			error?: { code?: unknown; message?: unknown } | string;
		};
		if (typeof parsed?.error === "string") {
			return { message: parsed.error };
		}
		const code =
			typeof parsed?.error?.code === "number" ? parsed.error.code : undefined;
		const message =
			typeof parsed?.error?.message === "string" ? parsed.error.message : text;
		return { ...(code !== undefined ? { code } : {}), message };
	} catch {
		return { message: text };
	}
}

export function classifyOrsFailure(error: {
	code?: number;
	message: string;
}): RoutingFailureReason {
	const sub = error.code !== undefined ? error.code % 1000 : undefined;
	if (
		sub === 10 ||
		/routable point|point not found|could not find point/i.test(error.message)
	) {
		return "out_of_coverage";
	}
	if (
		sub === 9 ||
		/route could not be found|could not find a route|no route found/i.test(
			error.message,
		)
	) {
		return "no_route";
	}
	return "provider_error";
}

// Race an upstream fetch against a timeout, chaining the caller's abort signal.
// A timeout or abort surfaces as a rejected fetch, which each method maps to a
// `provider_error` outcome (never thrown to the tool).
async function fetchWithTimeout(
	input: string,
	init: RequestInit,
	deps: RoutingProviderDeps,
): Promise<Response> {
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const controller = new AbortController();
	const signal = deps.signal
		? AbortSignal.any([deps.signal, controller.signal])
		: controller.signal;
	let timer: ReturnType<typeof setTimeout> | undefined;
	if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
		timer = setTimeout(() => {
			controller.abort(
				new Error(`routing request timed out after ${timeoutMs}ms`),
			);
		}, timeoutMs);
		timer.unref?.();
	}
	try {
		return await deps.fetch(input, { ...init, signal });
	} finally {
		if (timer) clearTimeout(timer);
	}
}

// ── ORS raw response shapes (loosely typed; we defensively narrow) ──

type OrsStep = {
	distance?: number;
	duration?: number;
	instruction?: string;
	name?: string;
	// ORS's manoeuvre code, and the step's span in the route geometry.
	type?: number;
	way_points?: number[];
};

type OrsSegment = {
	distance?: number;
	duration?: number;
	steps?: OrsStep[];
};

type OrsDirectionsResponse = {
	routes?: Array<{
		summary?: {
			distance?: number;
			duration?: number;
			// Emitted only when `elevation: true` was asked for.
			ascent?: number;
			descent?: number;
		};
		segments?: OrsSegment[];
		geometry?: string;
	}>;
};

// ── ORS public-transport response shapes ───────────────────────
//
// Field names taken VERBATIM from openrouteservice v9.10.0:
//   ors-api/.../responses/routing/json/JSONIndividualRouteResponse.java
//     — routes[]: geometry, summary, segments, way_points, legs, departure,
//       arrival, bbox, extras, warnings
//   ors-api/.../responses/routing/json/JSONSummary.java
//     — distance, duration, ascent, descent, transfers, fare
//       (transfers/fare are emitted ONLY for a PT request, and suppressed when
//        they are -1, hence both are optional here)
//   ors-api/.../responses/routing/json/JSONLeg.java
//     — type ("walk" | "pt"), departure_location, trip_headsign,
//       route_long_name, route_short_name, route_desc, route_type, distance,
//       duration, departure, arrival, feed_id, trip_id, route_id,
//       is_in_same_vehicle_as_previous, geometry, instructions, stops
//   ors-api/.../responses/routing/json/JSONPtStop.java
//     — stop_id, name, location ([lng, lat]), arrival_time,
//       planned_arrival_time, predicted_arrival_time, arrival_cancelled,
//       departure_time, planned_departure_time, predicted_departure_time,
//       departure_cancelled
//
// Both leg classes are @JsonInclude(NON_EMPTY), so absent fields simply do not
// appear — every one of them is optional here and defensively narrowed.

type OrsPtStop = {
	stop_id?: unknown;
	name?: unknown;
	location?: unknown;
	arrival_time?: unknown;
	planned_arrival_time?: unknown;
	departure_time?: unknown;
	planned_departure_time?: unknown;
};

type OrsLeg = {
	type?: unknown;
	departure_location?: unknown;
	trip_headsign?: unknown;
	route_long_name?: unknown;
	route_short_name?: unknown;
	route_desc?: unknown;
	route_type?: unknown;
	distance?: unknown;
	duration?: unknown;
	departure?: unknown;
	arrival?: unknown;
	is_in_same_vehicle_as_previous?: unknown;
	geometry?: unknown;
	stops?: unknown;
};

type OrsPtRoute = {
	summary?: {
		distance?: unknown;
		duration?: unknown;
		transfers?: unknown;
		fare?: unknown;
	};
	geometry?: unknown;
	departure?: unknown;
	arrival?: unknown;
	legs?: unknown;
};

type OrsPtDirectionsResponse = { routes?: unknown };

type OrsMatrixResponse = {
	durations?: (number | null)[][];
	distances?: (number | null)[][];
};

type OrsIsochronesResponse = {
	features?: Array<{
		properties?: { value?: number };
		geometry?: unknown;
	}>;
};

// A single Nominatim `/search` result (jsonv2). Loosely typed — we defensively
// narrow. `lat`/`lon` arrive as STRINGS; jsonv2 renames Nominatim's `class` to
// `category`, so we read both. `importance` is a 0..1 relevance score.
type NominatimResult = {
	lat?: string | number;
	lon?: string | number;
	display_name?: string;
	name?: string;
	type?: string;
	class?: string;
	category?: string;
	importance?: number;
};

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function mapRouteStep(raw: OrsStep): RouteStep {
	const step: RouteStep = {
		distance_m: num(raw.distance),
		duration_s: num(raw.duration),
	};
	if (typeof raw.instruction === "string" && raw.instruction.trim()) {
		step.instruction = raw.instruction;
	}
	if (typeof raw.name === "string" && raw.name.trim()) {
		step.name = raw.name;
	}
	if (typeof raw.type === "number" && Number.isFinite(raw.type)) {
		step.type = raw.type;
	}
	// `way_points` is a two-element [first, last] index pair into the route
	// geometry. Anything else (a shorter array, non-numeric members) is dropped
	// rather than half-carried, so the card never highlights a made-up span.
	const span = raw.way_points;
	if (
		Array.isArray(span) &&
		span.length === 2 &&
		typeof span[0] === "number" &&
		typeof span[1] === "number" &&
		Number.isFinite(span[0]) &&
		Number.isFinite(span[1])
	) {
		step.way_points = [span[0], span[1]];
	}
	return step;
}

function mapDirectionsResponse(
	body: OrsDirectionsResponse,
	coords: RouteData["coords"],
	options?: { elevation?: boolean },
): RouteData | null {
	const route = body.routes?.[0];
	if (!route) return null;
	const legs: RouteLeg[] = (route.segments ?? []).map((segment) => {
		const leg: RouteLeg = {
			distance_m: num(segment.distance),
			duration_s: num(segment.duration),
		};
		if (segment.steps && segment.steps.length > 0) {
			leg.steps = segment.steps.map(mapRouteStep);
		}
		return leg;
	});
	const data: RouteData = {
		distance_m: num(route.summary?.distance),
		duration_s: num(route.summary?.duration),
		legs,
		coords,
	};
	if (typeof route.geometry === "string" && route.geometry.length > 0) {
		data.polyline = route.geometry;
		// With elevation on, ORS packs a third value per point into the SAME
		// encoded string — a 2D decoder would read that altitude as the next
		// point's latitude, so the dimension count travels with the geometry.
		if (options?.elevation) data.polylineDimensions = 3;
	}
	const ascent = route.summary?.ascent;
	if (typeof ascent === "number" && Number.isFinite(ascent)) {
		data.ascent_m = ascent;
	}
	const descent = route.summary?.descent;
	if (typeof descent === "number" && Number.isFinite(descent)) {
		data.descent_m = descent;
	}
	return data;
}

// ── Public-transport parsing ───────────────────────────────────

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// ORS emits every PT timestamp as an offset-bearing ISO string (ZonedDateTime
// on the route/leg, java.util.Date on a stop). We keep whatever it sent
// verbatim as long as it parses as a date, and drop anything that does not —
// a broken timestamp must never become a fabricated one.
function isoInstant(value: unknown): string | undefined {
	const text = optionalString(value);
	if (!text) return undefined;
	return Number.isNaN(new Date(text).getTime()) ? undefined : text;
}

export function mapPtStop(raw: OrsPtStop): TransitStop {
	const stop: TransitStop = {};
	const name = optionalString(raw.name);
	if (name) stop.name = name;
	const stopId = optionalString(raw.stop_id);
	if (stopId) stop.stopId = stopId;
	// planned_* is the scheduled time; *_time is the effective one (equal to
	// planned unless the feed carries realtime updates). Prefer the effective.
	const arrival =
		isoInstant(raw.arrival_time) ?? isoInstant(raw.planned_arrival_time);
	if (arrival) stop.arrival = arrival;
	const departure =
		isoInstant(raw.departure_time) ?? isoInstant(raw.planned_departure_time);
	if (departure) stop.departure = departure;
	// JSONPtStop.location is [lng, lat] (its @Schema example is
	// "[8.6912542, 49.399979]" for Heidelberg — longitude first).
	if (Array.isArray(raw.location) && raw.location.length >= 2) {
		const lng = optionalNumber(raw.location[0]);
		const lat = optionalNumber(raw.location[1]);
		if (lat !== undefined && lng !== undefined) {
			stop.lat = lat;
			stop.lng = lng;
		}
	}
	return stop;
}

export function mapTransitLeg(raw: OrsLeg): TransitLeg {
	// ORS only ever emits "walk" or "pt" (RouteLeg copies GraphHopper's
	// Trip.Leg.type, and JSONLeg branches on type.equals("pt")); anything else
	// is treated as a walk so an unknown value can never claim to be a service.
	const type = optionalString(raw.type) === "pt" ? "pt" : "walk";
	const stops = Array.isArray(raw.stops)
		? (raw.stops as OrsPtStop[]).map(mapPtStop)
		: [];
	const leg: TransitLeg = {
		type,
		distance_m: num(raw.distance),
		duration_s: num(raw.duration),
	};
	const departure = isoInstant(raw.departure);
	if (departure) leg.departure = departure;
	const arrival = isoInstant(raw.arrival);
	if (arrival) leg.arrival = arrival;
	const polyline = optionalString(raw.geometry);
	if (polyline) leg.polyline = polyline;
	if (type === "pt") {
		// `departure_location` is the boarding stop's name; fall back to the
		// first listed stop when the feed left it empty.
		const from = optionalString(raw.departure_location) ?? stops[0]?.name;
		if (from) leg.from = from;
		const to = stops[stops.length - 1]?.name;
		if (to) leg.to = to;
		const short = optionalString(raw.route_short_name);
		const long = optionalString(raw.route_long_name);
		// Prefer the short name ("39A"); a feed with only a long name still
		// gets a usable line label.
		const line = short ?? long;
		if (line) leg.line = line;
		if (long && long !== line) leg.lineLong = long;
		const headsign = optionalString(raw.trip_headsign);
		if (headsign) leg.headsign = headsign;
		// RouteLeg sets routeType to -1 for a walk leg; a real GTFS route_type
		// is >= 0, so anything negative is dropped rather than surfaced.
		const routeType = optionalNumber(raw.route_type);
		if (routeType !== undefined && routeType >= 0) leg.routeType = routeType;
		if (stops.length > 0) leg.stopsCount = stops.length;
		// GTFS `platform_code` on the boarding stop, when the feed carries one.
		// Most feeds (and ORS's own JSONPtStop) omit it, so this is read
		// defensively off the raw stop and simply absent otherwise — the card
		// renders a platform only when there genuinely is one.
		const rawStops = Array.isArray(raw.stops)
			? (raw.stops as Array<Record<string, unknown>>)
			: [];
		const platform = optionalString(rawStops[0]?.platform_code);
		if (platform) leg.platform = platform;
		if (typeof raw.is_in_same_vehicle_as_previous === "boolean") {
			leg.sameVehicleAsPrevious = raw.is_in_same_vehicle_as_previous;
		}
	}
	return leg;
}

// Maps ONE ORS route object into an itinerary. `transfers` comes from
// summary.transfers when ORS emitted it (it suppresses the value when it is
// -1); otherwise it is derived as "one fewer than the number of pt legs",
// which is what a transfer count means.
export function mapTransitItinerary(raw: OrsPtRoute): TransitItinerary {
	const legs = Array.isArray(raw.legs)
		? (raw.legs as OrsLeg[]).map(mapTransitLeg)
		: [];
	const ptLegs = legs.filter((leg) => leg.type === "pt").length;
	const reported = optionalNumber(raw.summary?.transfers);
	const itinerary: TransitItinerary = {
		duration_s: num(raw.summary?.duration),
		distance_m: num(raw.summary?.distance),
		transfers:
			reported !== undefined && reported >= 0
				? reported
				: Math.max(0, ptLegs - 1),
		legs,
	};
	const departure = isoInstant(raw.departure) ?? legs[0]?.departure;
	if (departure) itinerary.departure = departure;
	const arrival = isoInstant(raw.arrival) ?? legs[legs.length - 1]?.arrival;
	if (arrival) itinerary.arrival = arrival;
	const polyline = optionalString(raw.geometry);
	if (polyline) itinerary.polyline = polyline;
	return itinerary;
}

// A schedule request returns one `routes[]` entry per departure, so the same
// parser serves both actions; a journey request simply yields one itinerary.
export function mapTransitResponse(
	body: OrsPtDirectionsResponse,
): TransitItinerary[] {
	const routes = Array.isArray(body.routes)
		? (body.routes as OrsPtRoute[])
		: [];
	return routes.map(mapTransitItinerary);
}

// A directions call against a profile the engine did not build fails with an
// error that NAMES the profile ("Unable to find an appropriate routing
// profile…"), or — when the request never reached a controller — a bare 404.
// Either means "this region has no timetable graph".
//
// Returns null to hand the failure back to the ordinary ORS classifier. That
// matters: ORS answers 404 for a coverage miss (2010) and for "no route found"
// (2009) too, so status alone would report a point outside the extract as
// "there are no timetables here", which is a different and misleading claim.
export function classifyTransitFailure(error: {
	status?: number;
	code?: number;
	message: string;
}): RoutingFailureReason | null {
	// A recognized ORS routing error is about the QUERY, not the profile.
	if (error.code !== undefined) {
		const ordinary = classifyOrsFailure({
			code: error.code,
			message: error.message,
		});
		if (ordinary !== "provider_error") return null;
	}
	if (
		/unknown profile|profile .*not (?:found|supported|available)|unable to find an appropriate routing profile|public-transport/i.test(
			error.message,
		)
	) {
		return "transit_unavailable";
	}
	if (error.status === 404 && error.code === undefined) {
		return "transit_unavailable";
	}
	return null;
}

// Parse a Nominatim coordinate, which arrives as a numeric STRING (e.g.
// "52.516"). Returns null for missing/blank/non-numeric values so a malformed
// row is skipped rather than fabricated as 0,0 (Number("") === 0).
function parseCoord(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function trimmedString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Map Nominatim's `/search` array into GeocodeMatch[]: lat/lon strings → numbers,
// `display_name` (else `name`) as the label, `type` (else `class`/`category`)
// as the kind, and `importance` (0..1) carried through as `confidence`.
function mapNominatimResponse(body: unknown): GeocodeMatch[] {
	const results: NominatimResult[] = Array.isArray(body) ? body : [];
	const matches: GeocodeMatch[] = [];
	for (const result of results) {
		const lat = parseCoord(result.lat);
		const lng = parseCoord(result.lon);
		if (lat === null || lng === null) continue;
		const label =
			trimmedString(result.display_name) ?? trimmedString(result.name);
		const match: GeocodeMatch = {
			name: label ?? "Unnamed place",
			lat,
			lng,
		};
		const type =
			trimmedString(result.type) ??
			trimmedString(result.class) ??
			trimmedString(result.category);
		if (type) {
			match.type = type;
		}
		if (
			typeof result.importance === "number" &&
			Number.isFinite(result.importance)
		) {
			// Nominatim importance is already normalized to 0..1; clamp defensively
			// so the contract's "0..1 where available" always holds.
			match.confidence = Math.min(1, Math.max(0, result.importance));
		}
		matches.push(match);
	}
	return matches;
}

export function createOrsProvider(
	config: OrsProviderConfig,
	deps: RoutingProviderDeps,
): RoutingProvider {
	const orsBase = config.orsBaseUrl ? trimBase(config.orsBaseUrl) : "";
	const geocoderBase = config.geocoderBaseUrl
		? trimBase(config.geocoderBaseUrl)
		: "";

	const routingConfigured = () => orsBase.length > 0;
	const geocoderConfigured = () => geocoderBase.length > 0;
	const coverageLabel = () => (config.coverageLabel ?? "").trim();

	function providerError(message: string): {
		ok: false;
		reason: "provider_error";
		message: string;
	} {
		return { ok: false, reason: "provider_error", message };
	}

	// Map a failed ORS call to the most specific failure reason we can prove
	// from the response. Only a parsed ORS error body can yield out_of_coverage
	// / no_route; transport errors stay provider_error.
	function orsFailure(result: {
		message: string;
		orsError?: { code?: number; message: string };
	}): { ok: false; reason: RoutingFailureReason; message: string } {
		if (!result.orsError) return providerError(result.message);
		return {
			ok: false,
			reason: classifyOrsFailure(result.orsError),
			message: result.orsError.message,
		};
	}

	async function postOrs<T>(
		path: string,
		payload: unknown,
	): Promise<
		| { ok: true; body: T }
		| {
				ok: false;
				message: string;
				// HTTP status of the failed response; absent for transport errors.
				status?: number;
				orsError?: { code?: number; message: string };
		  }
	> {
		try {
			const res = await fetchWithTimeout(
				`${orsBase}${path}`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
				},
				deps,
			);
			if (!res.ok) {
				const detail = await readErrorBody(res);
				return {
					ok: false,
					message:
						`ORS ${path} failed: ${res.status} ${res.statusText} ${detail}`.trim(),
					status: res.status,
					orsError: extractOrsError(detail),
				};
			}
			const body = (await res.json()) as T;
			return { ok: true, body };
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "ORS request failed";
			return { ok: false, message };
		}
	}

	async function geocode(input: {
		query: string;
		near?: LatLng;
		limit?: number;
	}): Promise<GeocodeOutcome> {
		if (!geocoderConfigured()) {
			return {
				ok: false,
				reason: "geocoder_unconfigured",
				message:
					"Geocoding is not configured on this server. Pass explicit {lat,lng} coordinates instead of a place name.",
			};
		}
		const limit =
			input.limit && input.limit > 0 ? Math.min(input.limit, 10) : 5;
		const params = new URLSearchParams({
			q: input.query,
			format: "jsonv2",
			limit: String(limit),
			// We build our own label from display_name, so skip the address breakdown.
			addressdetails: "0",
		});
		if (input.near) {
			// Bias the search toward `near` with a box around the point. Nominatim's
			// viewbox is <minLon>,<minLat>,<maxLon>,<maxLat>; bounded=1 keeps results
			// within it.
			const d = NEAR_VIEWBOX_DELTA_DEG;
			const { lat, lng } = input.near;
			params.set("viewbox", `${lng - d},${lat - d},${lng + d},${lat + d}`);
			params.set("bounded", "1");
		}
		try {
			const res = await fetchWithTimeout(
				`${geocoderBase}/search?${params.toString()}`,
				{
					method: "GET",
					headers: {
						accept: "application/json",
						"user-agent": NOMINATIM_USER_AGENT,
					},
				},
				deps,
			);
			if (!res.ok) {
				const detail = await readErrorBody(res);
				return providerError(
					`Geocoder failed: ${res.status} ${res.statusText} ${detail}`.trim(),
				);
			}
			const body = (await res.json()) as unknown;
			const results = mapNominatimResponse(body).slice(0, limit);
			if (results.length === 0) {
				return {
					ok: false,
					reason: "not_found",
					message: `No place matched "${input.query}".`,
				};
			}
			return { ok: true, data: { results } };
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Geocoder request failed";
			return providerError(message);
		}
	}

	async function route(input: {
		origin: LatLng;
		destination: LatLng;
		waypoints?: LatLng[];
		mode: RoutingMode;
	}): Promise<RouteOutcome> {
		if (!routingConfigured()) {
			return {
				ok: false,
				reason: "unconfigured",
				message: "Routing is not configured on this server.",
			};
		}
		const profile = MODE_TO_PROFILE[input.mode];
		const coordinates = [
			toOrsCoord(input.origin),
			...(input.waypoints ?? []).map(toOrsCoord),
			toOrsCoord(input.destination),
		];
		// Elevation is asked for on the self-powered profiles only: a climb is
		// what a walker or a cyclist plans around, and the driving graph has no
		// use for it. ORS answers with `summary.ascent`/`descent` and a 3D
		// geometry (see polylineDimensions).
		const elevation = input.mode === "walk" || input.mode === "bike";
		const result = await postOrs<OrsDirectionsResponse>(
			`/v2/directions/${profile}`,
			{
				coordinates,
				// Turn-by-turn steps are the route card's Directions list, so they
				// are requested explicitly rather than left to a server default.
				instructions: true,
				...(elevation ? { elevation: true } : {}),
			},
		);
		if (!result.ok) return orsFailure(result);
		const data = mapDirectionsResponse(
			result.body,
			{
				origin: input.origin,
				destination: input.destination,
				...(input.waypoints && input.waypoints.length > 0
					? { waypoints: input.waypoints }
					: {}),
			},
			{ elevation },
		);
		if (!data) {
			return providerError("ORS returned no route for those coordinates.");
		}
		return { ok: true, data };
	}

	async function matrix(input: {
		origins: LatLng[];
		destinations: LatLng[];
		mode: RoutingMode;
	}): Promise<MatrixOutcome> {
		if (!routingConfigured()) {
			return {
				ok: false,
				reason: "unconfigured",
				message: "Routing is not configured on this server.",
			};
		}
		const profile = MODE_TO_PROFILE[input.mode];
		const locations = [...input.origins, ...input.destinations].map(toOrsCoord);
		const sources = input.origins.map((_, index) => index);
		const destinations = input.destinations.map(
			(_, index) => input.origins.length + index,
		);
		const result = await postOrs<OrsMatrixResponse>(`/v2/matrix/${profile}`, {
			locations,
			sources,
			destinations,
			metrics: ["distance", "duration"],
		});
		if (!result.ok) return orsFailure(result);
		const data: MatrixData = {
			durations_s: Array.isArray(result.body.durations)
				? result.body.durations
				: [],
			distances_m: Array.isArray(result.body.distances)
				? result.body.distances
				: [],
		};
		return { ok: true, data };
	}

	async function isochrone(input: {
		origin: LatLng;
		mode: RoutingMode;
		rangesS: number[];
	}): Promise<IsochroneOutcome> {
		if (!routingConfigured()) {
			return {
				ok: false,
				reason: "unconfigured",
				message: "Routing is not configured on this server.",
			};
		}
		const profile = MODE_TO_PROFILE[input.mode];
		const result = await postOrs<OrsIsochronesResponse>(
			`/v2/isochrones/${profile}`,
			{
				locations: [toOrsCoord(input.origin)],
				range: input.rangesS,
				range_type: "time",
			},
		);
		if (!result.ok) return orsFailure(result);
		const features = Array.isArray(result.body.features)
			? result.body.features
			: [];
		const data: IsochroneData = {
			origin: input.origin,
			polygons: features.map((feature, index) => ({
				range_s: num(feature.properties?.value ?? input.rangesS[index]),
				geojson: feature.geometry ?? null,
			})),
		};
		return { ok: true, data };
	}

	// One request builder for both PT actions: the journey search and the
	// "next departures" schedule differ only by ORS's `schedule` flag and its
	// two window parameters (RouteRequest.PARAM_SCHEDULE / _DURATION / _ROWS).
	async function postTransit(
		input: TransitQuery & {
			schedule?: { windowMinutes: number; rows: number };
		},
	): Promise<TransitOutcome> {
		if (!routingConfigured()) {
			return {
				ok: false,
				reason: "unconfigured",
				message: "Routing is not configured on this server.",
			};
		}
		const walkingTimeMinutes =
			input.walkingTimeMinutes && input.walkingTimeMinutes > 0
				? input.walkingTimeMinutes
				: DEFAULT_WALKING_TIME_MINUTES;
		// ORS honours ONE of departure/arrival. "Arrive by" wins when both are
		// present, because that is the stricter constraint the user asked for.
		const timing = input.arrival
			? { arrival: input.arrival }
			: input.departure
				? { departure: input.departure }
				: {};
		const payload: Record<string, unknown> = {
			coordinates: [toOrsCoord(input.origin), toOrsCoord(input.destination)],
			// Walk legs get their duration from the sum of their instruction
			// durations (ORS RouteLeg), so instructions must be ON or every walk
			// leg would report 0 s.
			instructions: true,
			geometry: true,
			walking_time: isoMinutes(walkingTimeMinutes),
			ignore_transfers: false,
			...timing,
		};
		if (input.schedule) {
			payload.schedule = true;
			payload.schedule_duration = isoMinutes(input.schedule.windowMinutes);
			payload.schedule_rows = input.schedule.rows;
		}
		const result = await postOrs<OrsPtDirectionsResponse>(
			`/v2/directions/${PUBLIC_TRANSPORT_PROFILE}`,
			payload,
		);
		if (!result.ok) {
			const transit = classifyTransitFailure({
				...(result.status !== undefined ? { status: result.status } : {}),
				...(result.orsError?.code !== undefined
					? { code: result.orsError.code }
					: {}),
				message: result.orsError?.message ?? result.message,
			});
			if (transit) {
				return {
					ok: false,
					reason: transit,
					message:
						"This area has no public transport timetable loaded on this server.",
				};
			}
			return orsFailure(result);
		}
		const itineraries = mapTransitResponse(result.body);
		if (itineraries.length === 0) {
			return {
				ok: false,
				reason: "no_route",
				message:
					"No public transport journey was found between those points at that time.",
			};
		}
		const data: TransitData = {
			itineraries,
			coords: { origin: input.origin, destination: input.destination },
			query: {
				...timing,
				...(input.schedule ? { schedule: true } : {}),
				walkingTimeMinutes,
			},
		};
		return { ok: true, data };
	}

	return {
		routingConfigured,
		geocoderConfigured,
		coverageLabel,
		geocode,
		route,
		matrix,
		isochrone,
		transit: (input: TransitQuery) => postTransit(input),
		transitSchedule: (input: TransitScheduleQuery) =>
			postTransit({
				...input,
				schedule: {
					windowMinutes:
						input.windowMinutes && input.windowMinutes > 0
							? input.windowMinutes
							: DEFAULT_SCHEDULE_WINDOW_MINUTES,
					rows:
						input.rows && input.rows > 0 ? input.rows : DEFAULT_SCHEDULE_ROWS,
				},
			}),
	};
}
