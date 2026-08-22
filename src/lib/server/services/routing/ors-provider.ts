// OpenRouteService (ORS) routing provider + a Photon geocoder.
//
// Talks to a self-hosted ORS v2 JSON API for directions / matrix / isochrones
// and to a self-hosted Photon geocoder for place-name → coordinate lookups.
// Both base URLs are config (ORS_BASE_URL / GEOCODER_BASE_URL): nothing leaves
// the box. Dependency-injected fetch keeps the module testable with no network.
//
// GEOCODER DECISION: self-hosted ORS core does NOT ship geocoding, so geocode
// talks to a separate Photon service (OSM-native, pairs with the OSM routing
// stack, returns GeoJSON with [lng,lat] coordinates and a simple `/api?q=`
// endpoint). Photon exposes no normalized confidence score, so `confidence` is
// left undefined for Photon results (results already arrive relevance-ordered).
// The provider is written against Photon's response shape; swapping to
// Nominatim/Pelias would be a new provider behind the same RoutingProvider seam.

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
	// Photon geocoder base, e.g. "http://127.0.0.1:2322". Empty/undefined =>
	// geocode degrades to "geocoder_unconfigured".
	geocoderBaseUrl?: string;
};

const DEFAULT_TIMEOUT_MS = 20_000;
const ERROR_BODY_CHARS = 300;

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

type PhotonResponse = {
	features?: Array<{
		geometry?: { coordinates?: [number, number] };
		properties?: Record<string, unknown>;
	}>;
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

// Build a human-readable label from a Photon feature's properties. Photon
// splits an address across name/street/housenumber/city/state/country; we join
// the meaningful parts, de-duplicating, so the model gets something like
// "Brandenburg Gate, Berlin, Germany".
function photonLabel(props: Record<string, unknown>): string {
	const str = (key: string): string | undefined => {
		const value = props[key];
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	};
	const street = [str("housenumber"), str("street")]
		.filter(Boolean)
		.join(" ")
		.trim();
	const head = str("name") ?? (street.length > 0 ? street : undefined);
	const parts = [head, str("city"), str("state"), str("country")].filter(
		(part): part is string => Boolean(part),
	);
	const seen = new Set<string>();
	const deduped = parts.filter((part) => {
		const key = part.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return deduped.join(", ");
}

function mapPhotonResponse(body: PhotonResponse): GeocodeMatch[] {
	const features = Array.isArray(body.features) ? body.features : [];
	const matches: GeocodeMatch[] = [];
	for (const feature of features) {
		const coords = feature.geometry?.coordinates;
		if (!Array.isArray(coords) || coords.length < 2) continue;
		const [lng, lat] = coords;
		if (typeof lng !== "number" || typeof lat !== "number") continue;
		const props = feature.properties ?? {};
		const match: GeocodeMatch = {
			name: photonLabel(props) || "Unnamed place",
			lat,
			lng,
		};
		const type = props.type ?? props.osm_value;
		if (typeof type === "string" && type.trim()) {
			match.type = type;
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
		const params = new URLSearchParams({ q: input.query });
		const limit =
			input.limit && input.limit > 0 ? Math.min(input.limit, 10) : 5;
		params.set("limit", String(limit));
		if (input.near) {
			params.set("lat", String(input.near.lat));
			params.set("lon", String(input.near.lng));
		}
		try {
			const res = await fetchWithTimeout(
				`${geocoderBase}/api?${params.toString()}`,
				{ method: "GET", headers: { accept: "application/json" } },
				deps,
			);
			if (!res.ok) {
				const detail = await readErrorBody(res);
				return providerError(
					`Geocoder failed: ${res.status} ${res.statusText} ${detail}`.trim(),
				);
			}
			const body = (await res.json()) as PhotonResponse;
			const results = mapPhotonResponse(body).slice(0, limit);
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
