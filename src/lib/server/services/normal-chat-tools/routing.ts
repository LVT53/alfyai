// map_route tool (Tier D) — geography reasoning for the chat model:
// geocoding, routes (drive/walk/bike), distance/ETA matrices and isochrones,
// backed by a self-hosted OpenRouteService via the RoutingProvider seam.
//
// INDEPENDENT OF OWNTRACKS (owner decision): this tool never reads the user's
// location. It takes explicit {lat,lng} coordinates or place-name strings only.
// If the model needs the user's current position it calls the `location` tool
// separately and passes the coordinates in — the two compose via distinct tool
// calls, they are not coupled.
//
// DEGRADE-FIRST: when ORS/geocoder is unconfigured or an upstream call fails,
// the tool returns a clear "unavailable" payload and NEVER fabricates a route
// (mirrors research-web.ts's discipline). Every user-facing result carries the
// required OSM attribution so the model surfaces it.

import { z } from "zod";
import type { ToolEvidenceCandidate } from "$lib/server/services/message-evidence";
import {
	type GeocodeMatch,
	type IsochroneData,
	isLatLng,
	type LatLng,
	type MatrixData,
	OSM_ATTRIBUTION,
	type PlaceInput,
	type RouteData,
	type RoutingMode,
	type RoutingProvider,
} from "$lib/server/services/routing/types";

// ── Input schema (v1) ──────────────────────────────────────────

// Coordinates are range-bounded so an out-of-range pair is rejected at the seam
// instead of round-tripping to ORS for a 400. (NaN/Infinity are already rejected
// by z.number(), which only accepts finite numbers.)
const latLngSchema = z
	.object({
		lat: z.number().min(-90).max(90),
		lng: z.number().min(-180).max(180),
	})
	.strict();

// A place is EITHER {lat,lng} OR a non-empty place-name string.
const placeSchema = z.union([latLngSchema, z.string().min(1)]);

const modeSchema = z.enum(["drive", "walk", "bike"]);

// Cap the point-list inputs (DoS guard). Place STRINGS are geocoded
// sequentially in a loop, so an unbounded matrix/route would fire one upstream
// geocoder request per element (a 25×25 matrix already resolves up to 50
// serial geocodes) plus emit a huge ORS body. 25 keeps the tool genuinely
// useful — a matrix needs more than the 10 cap that fits `ranges_s`/`limit`,
// yet a real distance/ETA query rarely spans more than a couple dozen points —
// while bounding the burst. Over-cap input is rejected by the schema (same path
// as the other rejections), so the runner never partially executes.
const MAX_PLACES = 25;

export const routingToolInputSchema = z.object({
	action: z.enum(["geocode", "route", "matrix", "isochrone"]),
	// geocode
	query: z.string().min(1).optional(),
	near: latLngSchema.optional(),
	limit: z.number().int().positive().max(10).optional(),
	// route (+ isochrone origin)
	origin: placeSchema.optional(),
	destination: placeSchema.optional(),
	waypoints: z
		.array(placeSchema)
		.max(MAX_PLACES, {
			error: `waypoints supports at most ${MAX_PLACES} places`,
		})
		.optional(),
	// matrix
	origins: z
		.array(placeSchema)
		.max(MAX_PLACES, { error: `origins supports at most ${MAX_PLACES} places` })
		.optional(),
	destinations: z
		.array(placeSchema)
		.max(MAX_PLACES, {
			error: `destinations supports at most ${MAX_PLACES} places`,
		})
		.optional(),
	// isochrone
	ranges_s: z.array(z.number().positive()).max(10).optional(),
	// shared travel mode; defaults to "drive" where a mode is required.
	mode: modeSchema.optional(),
});

export type RoutingToolInput = z.infer<typeof routingToolInputSchema>;

function trimPlace(place: PlaceInput): PlaceInput {
	return typeof place === "string" ? place.trim() : place;
}

export function sanitizeRoutingToolInput(
	input: RoutingToolInput,
): RoutingToolInput {
	return {
		action: input.action,
		...(input.query ? { query: input.query.trim() } : {}),
		...(input.near ? { near: input.near } : {}),
		...(input.limit !== undefined ? { limit: input.limit } : {}),
		...(input.origin !== undefined ? { origin: trimPlace(input.origin) } : {}),
		...(input.destination !== undefined
			? { destination: trimPlace(input.destination) }
			: {}),
		...(input.waypoints ? { waypoints: input.waypoints.map(trimPlace) } : {}),
		...(input.origins ? { origins: input.origins.map(trimPlace) } : {}),
		...(input.destinations
			? { destinations: input.destinations.map(trimPlace) }
			: {}),
		...(input.ranges_s ? { ranges_s: input.ranges_s } : {}),
		...(input.mode ? { mode: input.mode } : {}),
	};
}

// ── Model-facing payload ───────────────────────────────────────

export type RoutingToolModelPayload = {
	success: boolean;
	name: "map_route";
	sourceType: "tool";
	action: RoutingToolInput["action"];
	message: string;
	// Required OSM attribution — the model must surface this on user-facing
	// routing output. Present on every payload (a constant string).
	attribution: string;
	geocode?: { results: GeocodeMatch[] };
	route?: RouteData;
	matrix?: MatrixData;
	isochrone?: IsochroneData;
};

export type RoutingToolOutcome = {
	modelPayload: RoutingToolModelPayload;
	candidates: ToolEvidenceCandidate[];
};

function buildPayload(params: {
	success: boolean;
	action: RoutingToolInput["action"];
	message: string;
	geocode?: { results: GeocodeMatch[] };
	route?: RouteData;
	matrix?: MatrixData;
	isochrone?: IsochroneData;
	candidates?: ToolEvidenceCandidate[];
}): RoutingToolOutcome {
	return {
		modelPayload: {
			success: params.success,
			name: "map_route",
			sourceType: "tool",
			action: params.action,
			message: params.message,
			attribution: OSM_ATTRIBUTION,
			...(params.geocode !== undefined ? { geocode: params.geocode } : {}),
			...(params.route !== undefined ? { route: params.route } : {}),
			...(params.matrix !== undefined ? { matrix: params.matrix } : {}),
			...(params.isochrone !== undefined
				? { isochrone: params.isochrone }
				: {}),
		},
		candidates: params.candidates ?? [],
	};
}

function failure(
	action: RoutingToolInput["action"],
	message: string,
): RoutingToolOutcome {
	return buildPayload({ success: false, action, message });
}

function missingInput(
	action: RoutingToolInput["action"],
	message: string,
): RoutingToolOutcome {
	return failure(action, message);
}

const UNCONFIGURED_MESSAGE =
	"Routing is unavailable — the mapping service is not configured on this server. Say routing is unavailable rather than estimating a route.";

// Map a resolved place to a Sources-tab candidate so the user can see what a
// place string resolved to.
function placeCandidate(
	id: string,
	label: string,
	coord: LatLng,
): ToolEvidenceCandidate {
	return {
		id,
		title: label,
		snippet: `${coord.lat}, ${coord.lng}`,
		sourceType: "tool",
		metadata: { lat: coord.lat, lng: coord.lng },
	};
}

// Resolve a PlaceInput to coordinates, auto-geocoding a place-name string when
// a geocoder is configured. Returns a `reason` on failure so the caller can
// produce a precise, honest message (geocoder unavailable vs place not found).
type ResolveResult =
	| { ok: true; coord: LatLng; label: string; geocoded: boolean }
	| { ok: false; message: string };

async function resolvePlace(
	place: PlaceInput,
	provider: RoutingProvider,
): Promise<ResolveResult> {
	if (isLatLng(place)) {
		return {
			ok: true,
			coord: place,
			label: `${place.lat}, ${place.lng}`,
			geocoded: false,
		};
	}
	const query = place.trim();
	if (!query) {
		return { ok: false, message: "An empty place name can't be resolved." };
	}
	if (!provider.geocoderConfigured()) {
		return {
			ok: false,
			message: `Geocoding is unavailable, so "${query}" can't be resolved. Pass explicit {lat,lng} coordinates instead.`,
		};
	}
	const outcome = await provider.geocode({ query, limit: 1 });
	if (!outcome.ok) {
		if (outcome.reason === "not_found") {
			return {
				ok: false,
				message: `I couldn't find a place matching "${query}".`,
			};
		}
		if (outcome.reason === "geocoder_unconfigured") {
			return {
				ok: false,
				message: `Geocoding is unavailable, so "${query}" can't be resolved. Pass explicit {lat,lng} coordinates instead.`,
			};
		}
		return {
			ok: false,
			message: `I couldn't reach the geocoding service to resolve "${query}" right now.`,
		};
	}
	const first = outcome.data.results[0];
	if (!first) {
		return {
			ok: false,
			message: `I couldn't find a place matching "${query}".`,
		};
	}
	return {
		ok: true,
		coord: { lat: first.lat, lng: first.lng },
		label: first.name || query,
		geocoded: true,
	};
}

function formatDuration(seconds: number): string {
	const mins = Math.round(seconds / 60);
	if (mins < 60) return `${mins} min`;
	const hours = Math.floor(mins / 60);
	const rem = mins % 60;
	return rem > 0 ? `${hours} h ${rem} min` : `${hours} h`;
}

function formatDistance(meters: number): string {
	if (meters < 1000) return `${Math.round(meters)} m`;
	return `${(meters / 1000).toFixed(1)} km`;
}

// ── Runner ─────────────────────────────────────────────────────

export async function runRoutingTool(
	input: RoutingToolInput,
	deps: { provider: RoutingProvider },
): Promise<RoutingToolOutcome> {
	const { provider } = deps;
	const mode: RoutingMode = input.mode ?? "drive";

	// Geocode is the one action that works WITHOUT ORS routing (it only needs a
	// geocoder), so it is not gated on routingConfigured().
	if (input.action === "geocode") {
		if (!input.query) {
			return missingInput("geocode", "geocode requires a `query`.");
		}
		if (!provider.geocoderConfigured()) {
			return failure(
				"geocode",
				`Geocoding is unavailable — no geocoding service is configured on this server. Say geocoding is unavailable rather than guessing coordinates for "${input.query}".`,
			);
		}
		const outcome = await provider.geocode({
			query: input.query,
			...(input.near ? { near: input.near } : {}),
			...(input.limit ? { limit: input.limit } : {}),
		});
		if (!outcome.ok) {
			if (outcome.reason === "not_found") {
				return failure("geocode", `No place matched "${input.query}".`);
			}
			return failure(
				"geocode",
				`Geocoding failed for "${input.query}". Please try again in a moment.`,
			);
		}
		const results = outcome.data.results;
		const candidates = results.map((r, index) =>
			placeCandidate(`geocode:${index}`, r.name, { lat: r.lat, lng: r.lng }),
		);
		return buildPayload({
			success: true,
			action: "geocode",
			message: `Found ${results.length} place${results.length === 1 ? "" : "s"} for "${input.query}".`,
			geocode: { results },
			candidates,
		});
	}

	// route / matrix / isochrone all need ORS routing.
	if (!provider.routingConfigured()) {
		return failure(input.action, UNCONFIGURED_MESSAGE);
	}

	if (input.action === "route") {
		if (input.origin === undefined || input.destination === undefined) {
			return missingInput(
				"route",
				"route requires both `origin` and `destination`.",
			);
		}
		const origin = await resolvePlace(input.origin, provider);
		if (!origin.ok) return failure("route", origin.message);
		const destination = await resolvePlace(input.destination, provider);
		if (!destination.ok) return failure("route", destination.message);

		const waypoints: LatLng[] = [];
		for (const wp of input.waypoints ?? []) {
			const resolved = await resolvePlace(wp, provider);
			if (!resolved.ok) return failure("route", resolved.message);
			waypoints.push(resolved.coord);
		}

		const outcome = await provider.route({
			origin: origin.coord,
			destination: destination.coord,
			...(waypoints.length > 0 ? { waypoints } : {}),
			mode,
		});
		if (!outcome.ok) {
			return failure(
				"route",
				"I couldn't compute a route right now — the routing service is unavailable.",
			);
		}
		const data = outcome.data;
		const candidates = [
			placeCandidate("route:origin", origin.label, origin.coord),
			placeCandidate("route:destination", destination.label, destination.coord),
		];
		return buildPayload({
			success: true,
			action: "route",
			message: `${mode} route from ${origin.label} to ${destination.label}: ${formatDistance(data.distance_m)}, about ${formatDuration(data.duration_s)}.`,
			route: data,
			candidates,
		});
	}

	if (input.action === "matrix") {
		const rawOrigins = input.origins ?? [];
		const rawDestinations = input.destinations ?? [];
		if (rawOrigins.length === 0 || rawDestinations.length === 0) {
			return missingInput(
				"matrix",
				"matrix requires non-empty `origins` and `destinations`.",
			);
		}
		const origins: LatLng[] = [];
		for (const place of rawOrigins) {
			const resolved = await resolvePlace(place, provider);
			if (!resolved.ok) return failure("matrix", resolved.message);
			origins.push(resolved.coord);
		}
		const destinations: LatLng[] = [];
		for (const place of rawDestinations) {
			const resolved = await resolvePlace(place, provider);
			if (!resolved.ok) return failure("matrix", resolved.message);
			destinations.push(resolved.coord);
		}
		const outcome = await provider.matrix({ origins, destinations, mode });
		if (!outcome.ok) {
			return failure(
				"matrix",
				"I couldn't compute the distance/ETA matrix right now — the routing service is unavailable.",
			);
		}
		return buildPayload({
			success: true,
			action: "matrix",
			message: `Computed a ${origins.length}×${destinations.length} ${mode} distance/ETA matrix.`,
			matrix: outcome.data,
		});
	}

	// isochrone
	if (input.origin === undefined) {
		return missingInput("isochrone", "isochrone requires an `origin`.");
	}
	const rangesS = input.ranges_s ?? [];
	if (rangesS.length === 0) {
		return missingInput(
			"isochrone",
			"isochrone requires at least one value in `ranges_s` (seconds).",
		);
	}
	const origin = await resolvePlace(input.origin, provider);
	if (!origin.ok) return failure("isochrone", origin.message);
	const outcome = await provider.isochrone({
		origin: origin.coord,
		mode,
		rangesS,
	});
	if (!outcome.ok) {
		return failure(
			"isochrone",
			"I couldn't compute reachability right now — the routing service is unavailable.",
		);
	}
	return buildPayload({
		success: true,
		action: "isochrone",
		message: `Computed ${outcome.data.polygons.length} ${mode} reachability polygon${outcome.data.polygons.length === 1 ? "" : "s"} from ${origin.label}.`,
		isochrone: outcome.data,
		candidates: [
			placeCandidate("isochrone:origin", origin.label, origin.coord),
		],
	});
}
