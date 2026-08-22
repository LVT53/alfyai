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

import {
	type GeocodeMatch,
	type GeocodeOutcome,
	type IsochroneData,
	type IsochroneOutcome,
	type LatLng,
	type MatrixData,
	type MatrixOutcome,
	MODE_TO_PROFILE,
	type RouteData,
	type RouteLeg,
	type RouteOutcome,
	type RouteStep,
	type RoutingMode,
	type RoutingProvider,
	type RoutingProviderDeps,
} from "./types";

export type OrsProviderConfig = {
	// ORS v2 API base, e.g. "http://127.0.0.1:8080/ors". Empty/undefined =>
	// routing degrades to "unconfigured".
	orsBaseUrl?: string;
	// Nominatim geocoder base, e.g. "http://127.0.0.1:8081". Empty/undefined =>
	// geocode degrades to "geocoder_unconfigured".
	geocoderBaseUrl?: string;
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
};

type OrsSegment = {
	distance?: number;
	duration?: number;
	steps?: OrsStep[];
};

type OrsDirectionsResponse = {
	routes?: Array<{
		summary?: { distance?: number; duration?: number };
		segments?: OrsSegment[];
		geometry?: string;
	}>;
};

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
	return step;
}

function mapDirectionsResponse(
	body: OrsDirectionsResponse,
	coords: RouteData["coords"],
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
	}
	return data;
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

	function providerError(message: string): {
		ok: false;
		reason: "provider_error";
		message: string;
	} {
		return { ok: false, reason: "provider_error", message };
	}

	async function postOrs<T>(
		path: string,
		payload: unknown,
	): Promise<{ ok: true; body: T } | { ok: false; message: string }> {
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
		const result = await postOrs<OrsDirectionsResponse>(
			`/v2/directions/${profile}`,
			{ coordinates },
		);
		if (!result.ok) return providerError(result.message);
		const data = mapDirectionsResponse(result.body, {
			origin: input.origin,
			destination: input.destination,
			...(input.waypoints && input.waypoints.length > 0
				? { waypoints: input.waypoints }
				: {}),
		});
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
		if (!result.ok) return providerError(result.message);
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
		if (!result.ok) return providerError(result.message);
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

	return {
		routingConfigured,
		geocoderConfigured,
		geocode,
		route,
		matrix,
		isochrone,
	};
}
