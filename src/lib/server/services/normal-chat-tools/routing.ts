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
import type {
	ToolCallMapData,
	ToolCallMapStep,
	ToolCallMapTransitLeg,
} from "$lib/server/services/messages-types";
import {
	buildRouteSteps,
	narrateSteps,
	routeVia,
	type StepNarration,
} from "$lib/server/services/routing/directions";
import {
	formatLocalClock,
	formatLocalDateTime,
	toRegionLocalDateTime,
	transitModeLabel,
} from "$lib/server/services/routing/gtfs-feeds";
import {
	chainJourneyLegs,
	type JourneyLegMode,
	type PlannedJourneyLeg,
	planJourney,
	type ResolvedJourneyLeg,
} from "$lib/server/services/routing/journey";
import {
	buildRouteMapCardData,
	buildTransitMapCardData,
	decodePolyline,
} from "$lib/server/services/routing/map-card";
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
	type TransitData,
	type TransitItinerary,
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

// A time the model may pass for a transit query. Kept as a loose string here
// (a full local date-time, an absolute ISO instant, or a bare "HH:MM") and
// normalized against the REGION's timezone in the provider — the tool has no
// business guessing which timezone "08:30" is in.
const timeSchema = z.string().min(1).max(40);

// Bounds on the timetable window so one call cannot ask ORS to simulate a
// whole day of departures.
const MAX_TIMETABLE_WINDOW_MINUTES = 720;
const MAX_TIMETABLE_ROWS = 12;
const MAX_WALK_MINUTES = 120;

// A mixed-mode journey is a handful of legs, not an itinerary planner: six
// covers "bike, train, tram, walk" with room to spare, and every leg costs at
// least one upstream call.
const MAX_JOURNEY_LEGS = 6;

const journeyLegSchema = z
	.object({
		mode: z.enum(["drive", "walk", "bike", "transit"]),
		from: placeSchema.optional(),
		to: placeSchema.optional(),
	})
	.strict();

export const routingToolInputSchema = z.object({
	action: z.enum([
		"geocode",
		"route",
		"matrix",
		"isochrone",
		"transit",
		"timetable",
		"journey",
	]),
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
	// transit / timetable
	departure: timeSchema.optional(),
	arrive_by: timeSchema.optional(),
	max_walk_minutes: z
		.number()
		.int()
		.positive()
		.max(MAX_WALK_MINUTES)
		.optional(),
	from: timeSchema.optional(),
	window_minutes: z
		.number()
		.int()
		.positive()
		.max(MAX_TIMETABLE_WINDOW_MINUTES)
		.optional(),
	rows: z.number().int().positive().max(MAX_TIMETABLE_ROWS).optional(),
	// journey: the modes in order, with only the places where they change.
	legs: z
		.array(journeyLegSchema)
		.min(1)
		.max(MAX_JOURNEY_LEGS, {
			error: `journey supports at most ${MAX_JOURNEY_LEGS} legs`,
		})
		.optional(),
	// shared travel mode; defaults to "drive" where a mode is required.
	mode: modeSchema.optional(),
});

export type RoutingToolInput = z.infer<typeof routingToolInputSchema>;

// What the model is shown for map_route. The zod schema above repeats the
// place union (name | {lat,lng}) five times with coordinate bounds, which the
// chat template renders in full; the model gets a plain-language copy and the
// zod schema still validates every call.
const PLACE_DOC = 'Place: a name string or {"lat":52.52,"lng":13.4}.';
export const routingToolModelSchema = {
	type: "object",
	properties: {
		action: {
			type: "string",
			enum: [
				"geocode",
				"route",
				"matrix",
				"isochrone",
				"transit",
				"timetable",
				"journey",
			],
		},
		query: { type: "string", description: "geocode: the place to look up" },
		near: {
			type: "object",
			properties: { lat: { type: "number" }, lng: { type: "number" } },
			description: "geocode: bias results near these coordinates",
		},
		limit: { type: "integer", maximum: 10 },
		origin: { description: `route/isochrone start. ${PLACE_DOC}` },
		destination: { description: `route end. ${PLACE_DOC}` },
		waypoints: {
			type: "array",
			maxItems: 25,
			items: { description: PLACE_DOC },
		},
		origins: { type: "array", maxItems: 25, items: { description: PLACE_DOC } },
		destinations: {
			type: "array",
			maxItems: 25,
			items: { description: PLACE_DOC },
		},
		ranges_s: {
			type: "array",
			items: { type: "number" },
			description: "isochrone: travel-time ranges in seconds",
		},
		departure: {
			type: "string",
			description:
				'transit: leave at this local time, e.g. "08:30" or "2026-09-08T08:30". Omit for "now".',
		},
		arrive_by: {
			type: "string",
			description:
				"transit: arrive by this local time instead of leaving at one",
		},
		max_walk_minutes: {
			type: "integer",
			maximum: MAX_WALK_MINUTES,
			description:
				"transit/timetable: longest walk to or from a stop (default 15)",
		},
		from: {
			type: "string",
			description: 'timetable: start of the window, local time (default "now")',
		},
		window_minutes: {
			type: "integer",
			maximum: MAX_TIMETABLE_WINDOW_MINUTES,
			description: "timetable: how far ahead to look (default 120)",
		},
		rows: {
			type: "integer",
			maximum: MAX_TIMETABLE_ROWS,
			description: "timetable: how many departures to return (default 6)",
		},
		legs: {
			type: "array",
			maxItems: MAX_JOURNEY_LEGS,
			items: {
				type: "object",
				properties: {
					mode: {
						type: "string",
						enum: ["drive", "walk", "bike", "transit"],
					},
					from: { description: PLACE_DOC },
					to: { description: PLACE_DOC },
				},
				required: ["mode"],
			},
			description:
				'journey: the modes in order. Consecutive legs chain, so only name a place where it changes: [{"mode":"bike","to":"Cork Kent station"},{"mode":"transit","to":"Dublin Heuston"},{"mode":"walk"}].',
		},
		mode: { type: "string", enum: ["drive", "walk", "bike"] },
	},
	required: ["action"],
} as const;

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
		...(input.departure ? { departure: input.departure.trim() } : {}),
		...(input.arrive_by ? { arrive_by: input.arrive_by.trim() } : {}),
		...(input.max_walk_minutes !== undefined
			? { max_walk_minutes: input.max_walk_minutes }
			: {}),
		...(input.from ? { from: input.from.trim() } : {}),
		...(input.window_minutes !== undefined
			? { window_minutes: input.window_minutes }
			: {}),
		...(input.rows !== undefined ? { rows: input.rows } : {}),
		...(input.legs
			? {
					legs: input.legs.map((leg) => ({
						mode: leg.mode,
						...(leg.from !== undefined ? { from: trimPlace(leg.from) } : {}),
						...(leg.to !== undefined ? { to: trimPlace(leg.to) } : {}),
					})),
				}
			: {}),
		...(input.mode ? { mode: input.mode } : {}),
	};
}

// ── Model-facing payload ───────────────────────────────────────

// The transit payload is deliberately NOT the raw provider shape: the model
// needs local clock times, line names and a walk budget, not ISO instants,
// stop ids and encoded polylines. Everything here is already in the region's
// local time.
export type TransitNarrationLeg = {
	type: "walk" | "pt";
	depart?: string;
	arrive?: string;
	minutes: number;
	from?: string;
	to?: string;
	line?: string;
	headsign?: string;
	vehicle?: string;
	stops?: number;
	walk_m?: number;
	platform?: string;
};

export type TransitNarrationItinerary = {
	depart?: string;
	arrive?: string;
	minutes: number;
	transfers: number;
	walk_minutes: number;
	legs: TransitNarrationLeg[];
};

export type TransitNarration = {
	// IANA timezone the clock times are in. Absent => server local time.
	timezone?: string;
	itineraries: TransitNarrationItinerary[];
};

// The road-route narration. Deliberately NOT the raw `RouteData`: that
// carries an encoded polyline and every manoeuvre with its geometry indices,
// none of which a model can say out loud, and all of which is replayed into
// the prompt on every later turn. What it gets instead is one summary line,
// the facts a person asks about, and a short manoeuvre list — the CARD draws
// the full directions, so the answer summarises rather than recites.
export type RouteNarration = {
	summary: string;
	distance_m: number;
	duration_s: number;
	via?: string;
	ascent_m?: number;
	// Up to MAX_NARRATION_STEPS entries; `steps_total` is how many the card
	// actually shows, so the model can say "14 steps" honestly.
	steps: StepNarration[];
	steps_total: number;
	coords: RouteData["coords"];
};

// One leg of a mixed-mode journey, in the same text-friendly register.
export type JourneyNarrationLeg = {
	mode: JourneyLegMode;
	depart?: string;
	arrive?: string;
	minutes: number;
	from: string;
	to: string;
	distance_m: number;
	// Transit legs only: the lines actually taken.
	lines?: string[];
	// Road legs only: a few manoeuvres, same discipline as `route`.
	steps?: StepNarration[];
};

export type JourneyNarration = {
	summary: string;
	depart?: string;
	arrive?: string;
	minutes: number;
	transfers: number;
	planned_backwards: boolean;
	legs: JourneyNarrationLeg[];
	timezone?: string;
};

export type RoutingToolModelPayload = {
	success: boolean;
	name: "map_route";
	sourceType: "tool";
	action: RoutingToolInput["action"];
	message: string;
	// One line describing the result, identical to what the card's summary
	// says — present on every successful payload so the model always has a
	// sentence to build its answer on.
	summary?: string;
	// Required OSM attribution — the model must surface this on user-facing
	// routing output. Present on every payload (a constant string).
	attribution: string;
	geocode?: { results: GeocodeMatch[] };
	route?: RouteNarration;
	matrix?: MatrixData;
	isochrone?: IsochroneData;
	transit?: TransitNarration;
	journey?: JourneyNarration;
};

export type RoutingToolOutcome = {
	modelPayload: RoutingToolModelPayload;
	candidates: ToolEvidenceCandidate[];
	// Compact inline map card data (route action only) — never part of
	// modelPayload; see ToolCallMapData for the size discipline.
	map?: ToolCallMapData;
};

function buildPayload(params: {
	success: boolean;
	action: RoutingToolInput["action"];
	message: string;
	summary?: string;
	geocode?: { results: GeocodeMatch[] };
	route?: RouteNarration;
	matrix?: MatrixData;
	isochrone?: IsochroneData;
	transit?: TransitNarration;
	journey?: JourneyNarration;
	candidates?: ToolEvidenceCandidate[];
	map?: ToolCallMapData;
}): RoutingToolOutcome {
	return {
		modelPayload: {
			success: params.success,
			name: "map_route",
			sourceType: "tool",
			action: params.action,
			message: params.message,
			...(params.summary !== undefined ? { summary: params.summary } : {}),
			attribution: OSM_ATTRIBUTION,
			...(params.geocode !== undefined ? { geocode: params.geocode } : {}),
			...(params.route !== undefined ? { route: params.route } : {}),
			...(params.matrix !== undefined ? { matrix: params.matrix } : {}),
			...(params.isochrone !== undefined
				? { isochrone: params.isochrone }
				: {}),
			...(params.transit !== undefined ? { transit: params.transit } : {}),
			...(params.journey !== undefined ? { journey: params.journey } : {}),
		},
		candidates: params.candidates ?? [],
		...(params.map !== undefined ? { map: params.map } : {}),
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

// Turn a failed provider outcome into a message the model can relay honestly.
// A coverage miss is NOT an outage: the engine is up, it just has no map data
// for that point, so the model should say "outside the routing coverage
// (<region>)" rather than "the service is down" — and still never estimate.
function providerFailureMessage(
	what: string,
	outcome: { reason: string; message: string },
	provider: RoutingProvider,
): string {
	const coverage = provider.coverageLabel?.()?.trim();
	const coverageNote = coverage
		? ` The routing data on this server covers ${coverage} only.`
		: " The routing data on this server does not cover that area.";
	if (outcome.reason === "out_of_coverage") {
		return `I couldn't compute ${what}: at least one point is outside the routing coverage (${outcome.message}).${coverageNote} Say the location is outside the routing coverage; do NOT estimate a distance, ETA, or route from memory.`;
	}
	if (outcome.reason === "no_route") {
		return `I couldn't compute ${what}: the routing engine found no path between those points (${outcome.message}). Say no route could be found; do NOT estimate one from memory.`;
	}
	if (outcome.reason === "region_preparing") {
		return `I couldn't compute ${what} yet: ${outcome.message} Tell the user the routing data for that area is being prepared on this server and to ask again later; do NOT estimate a distance, ETA, or route from memory.`;
	}
	if (outcome.reason === "multi_region") {
		return `I couldn't compute ${what}: ${outcome.message} Say that cross-region routing is not supported here; do NOT estimate.`;
	}
	if (outcome.reason === "region_unavailable") {
		return `I couldn't compute ${what}: ${outcome.message} Say the location is outside the routing coverage; do NOT estimate.`;
	}
	if (outcome.reason === "transit_unavailable") {
		const transit = provider.transitCoverageLabel?.()?.trim();
		const where = transit
			? ` Public transport timetables on this server cover ${transit} only.`
			: " No public transport timetables are loaded on this server.";
		return `I couldn't look up ${what}: ${outcome.message}${where} Say public transport timetables are not available for that area; do NOT invent departure times, lines, or journey durations, and do not fall back to a driving or walking estimate unless the user asks for one.`;
	}
	return `I couldn't compute ${what} right now — the routing service is unavailable.`;
}

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

// ── Road-route narration ───────────────────────────────────────

// The one line the model builds its answer on, and the same facts the card
// prints above the map: how far, how long, along what, and how much climb.
export function routeSummary(route: RouteData, mode: RoutingMode): string {
	const via = routeVia(route);
	const parts = [
		`${formatDistance(route.distance_m)} · ${formatDuration(route.duration_s)}`,
	];
	if (via) parts.push(`via ${via}`);
	if (route.ascent_m !== undefined && route.ascent_m >= 1) {
		parts.push(`${Math.round(route.ascent_m)} m climb`);
	}
	return `${parts.join(" · ")} (${mode})`;
}

export function narrateRoute(
	route: RouteData,
	mode: RoutingMode,
	cardSteps: ToolCallMapStep[],
): RouteNarration {
	// The card is the source of truth for the step list — narrating a
	// DIFFERENT set of manoeuvres than the user is looking at is how a model
	// ends up describing a turn that is not on screen.
	const steps = cardSteps.length > 0 ? cardSteps : buildRouteSteps(route);
	const via = routeVia(route);
	return {
		summary: routeSummary(route, mode),
		distance_m: Math.round(route.distance_m),
		duration_s: Math.round(route.duration_s),
		...(via ? { via } : {}),
		...(route.ascent_m !== undefined
			? { ascent_m: Math.round(route.ascent_m) }
			: {}),
		steps: narrateSteps(steps),
		steps_total: steps.length,
		coords: route.coords,
	};
}

// ── Public-transport narration ─────────────────────────────────

function minutesOf(seconds: number): number {
	return Math.max(0, Math.round(seconds / 60));
}

// Total walking in an itinerary, which is the number people actually ask
// about ("how much walking?") and the one ORS does not report directly.
function walkMinutes(itinerary: TransitItinerary): number {
	return minutesOf(
		itinerary.legs
			.filter((leg) => leg.type === "walk")
			.reduce((total, leg) => total + leg.duration_s, 0),
	);
}

function narrateItinerary(
	itinerary: TransitItinerary,
	timezone: string | undefined,
): TransitNarrationItinerary {
	const legs: TransitNarrationLeg[] = itinerary.legs.map((leg) => {
		const entry: TransitNarrationLeg = {
			type: leg.type,
			minutes: minutesOf(leg.duration_s),
		};
		const depart = formatLocalClock(leg.departure, timezone);
		if (depart) entry.depart = depart;
		const arrive = formatLocalClock(leg.arrival, timezone);
		if (arrive) entry.arrive = arrive;
		if (leg.from) entry.from = leg.from;
		if (leg.to) entry.to = leg.to;
		if (leg.type === "pt") {
			if (leg.line) entry.line = leg.line;
			if (leg.headsign) entry.headsign = leg.headsign;
			const vehicle = transitModeLabel(leg.routeType);
			if (vehicle) entry.vehicle = vehicle;
			if (leg.stopsCount !== undefined) entry.stops = leg.stopsCount;
			if (leg.platform) entry.platform = leg.platform;
		} else if (leg.distance_m > 0) {
			entry.walk_m = Math.round(leg.distance_m);
		}
		return entry;
	});
	const narrated: TransitNarrationItinerary = {
		minutes: minutesOf(itinerary.duration_s),
		transfers: itinerary.transfers,
		walk_minutes: walkMinutes(itinerary),
		legs,
	};
	const depart = formatLocalClock(itinerary.departure, timezone);
	if (depart) narrated.depart = depart;
	const arrive = formatLocalClock(itinerary.arrival, timezone);
	if (arrive) narrated.arrive = arrive;
	return narrated;
}

function narrateTransit(data: TransitData): TransitNarration {
	const timezone = data.timezone;
	return {
		...(timezone ? { timezone } : {}),
		itineraries: data.itineraries.map((itinerary) =>
			narrateItinerary(itinerary, timezone),
		),
	};
}

// The first pt leg's line, used as the one-word identity of a departure row.
function firstLine(itinerary: TransitNarrationItinerary): string | undefined {
	return itinerary.legs.find((leg) => leg.type === "pt")?.line;
}

// How many "other departures" ride under the timeline. Three is what the card
// shows without turning into a timetable printout.
const MAX_ALTERNATIVE_DEPARTURES = 3;

// One narrated leg as the card draws it. The narration layer has already put
// the times in local clock form, so this is purely a field selection.
function transitCardLeg(leg: TransitNarrationLeg): ToolCallMapTransitLeg {
	return {
		type: leg.type,
		minutes: leg.minutes,
		...(leg.line ? { line: leg.line } : {}),
		...(leg.headsign ? { headsign: leg.headsign } : {}),
		...(leg.from ? { from: leg.from } : {}),
		...(leg.to ? { to: leg.to } : {}),
		...(leg.depart ? { depart: leg.depart } : {}),
		...(leg.arrive ? { arrive: leg.arrive } : {}),
		...(leg.stops !== undefined ? { stops: leg.stops } : {}),
		...(leg.vehicle ? { vehicle: leg.vehicle } : {}),
		...(leg.platform ? { platform: leg.platform } : {}),
		...(leg.walk_m !== undefined ? { distanceM: leg.walk_m } : {}),
	};
}

// The calendar date a journey runs on ("2026-09-09"), in the region's own
// timezone — the card prints it so "07:05" is never ambiguous about which day.
function journeyDate(
	iso: string | undefined,
	timezone: string | undefined,
): string | undefined {
	if (!iso) return undefined;
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return undefined;
	return formatLocalDateTime(date, timezone).slice(0, 10);
}

// ── Mixed-mode journeys ────────────────────────────────────────

// The clock half of a LOCAL date-time ("2026-09-09T07:22:00" → "07:22").
function clockOf(local: string): string {
	return local.slice(11, 16);
}

const JOURNEY_MODE_WORD: Record<JourneyLegMode, string> = {
	drive: "drive",
	walk: "walk",
	bike: "bike",
	transit: "transit",
};

// "Leave 07:22 → arrive 10:54 · 3 h 32 min · bike, train, walk" — the line the
// card prints and the model builds its answer around.
export function journeySummary(plan: {
	departure: string;
	arrival: string;
	durationS: number;
	legs: { mode: JourneyLegMode }[];
}): string {
	const modes: string[] = [];
	for (const leg of plan.legs) {
		const word = JOURNEY_MODE_WORD[leg.mode];
		if (!modes.includes(word)) modes.push(word);
	}
	return `${clockOf(plan.departure)} → ${clockOf(plan.arrival)} · ${formatDuration(plan.durationS)} · ${modes.join(", ")}`;
}

// Stitches the planned legs into ONE set of card legs plus the geometry the
// map draws. A transit leg is expanded into the services it actually contains
// (walk to the stop, the train, the change), so a mixed journey reads as one
// continuous timeline rather than an opaque "transit" block.
function journeyCardLegs(plan: {
	legs: PlannedJourneyLeg[];
	timezone?: string;
}): { legs: ToolCallMapTransitLeg[]; points: [number, number][] } {
	const points: [number, number][] = [];
	// Appends a decoded geometry and returns the span it occupies. Pushed in a
	// loop rather than with a spread, which blows the stack on a long route.
	function append(
		encoded: string | undefined,
		dimensions: 2 | 3,
	): [number, number] | undefined {
		if (!encoded) return undefined;
		const decoded = decodePolyline(encoded, 5, dimensions);
		if (decoded.length === 0) return undefined;
		const start = points.length;
		for (const point of decoded) points.push(point);
		return [start, points.length - 1];
	}

	const cardLegs: ToolCallMapTransitLeg[] = [];
	for (const leg of plan.legs) {
		if (leg.mode !== "transit") {
			const route = leg.route;
			const range = append(route?.polyline, route?.polylineDimensions ?? 2);
			// A journey's step list highlights per LEG, not per manoeuvre — the
			// spans would index the stitched geometry, not the leg's own — so the
			// way-point ranges are dropped here rather than left pointing at the
			// wrong stretch.
			const steps = route
				? buildRouteSteps(route).map(
						({ wayPointRange: _drop, ...rest }) => rest,
					)
				: [];
			cardLegs.push({
				type: leg.mode,
				minutes: Math.max(1, Math.round(leg.durationS / 60)),
				from: leg.fromLabel,
				to: leg.toLabel,
				depart: clockOf(leg.departure),
				arrive: clockOf(leg.arrival),
				distanceM: leg.distanceM,
				...(steps.length > 0 ? { steps } : {}),
				...(range ? { pointRange: range } : {}),
			});
			continue;
		}
		const itinerary = leg.itinerary;
		if (!itinerary) continue;
		const narrated = narrateItinerary(itinerary, plan.timezone);
		itinerary.legs.forEach((raw, index) => {
			const range = append(raw.polyline, 2);
			const card = transitCardLeg(narrated.legs[index]);
			cardLegs.push({
				...card,
				...(range ? { pointRange: range } : {}),
			});
		});
		// A PT itinerary usually carries only a whole-journey geometry; use it
		// when the individual legs had none, so the map still draws the ride.
		if (points.length === 0) append(itinerary.polyline, 2);
	}
	return { legs: cardLegs, points };
}

function narrateJourney(
	plan: {
		legs: PlannedJourneyLeg[];
		departure: string;
		arrival: string;
		durationS: number;
		transfers: number;
		timezone?: string;
		plannedBackwards: boolean;
	},
	summary: string,
): JourneyNarration {
	return {
		summary,
		depart: clockOf(plan.departure),
		arrive: clockOf(plan.arrival),
		minutes: minutesOf(plan.durationS),
		transfers: plan.transfers,
		planned_backwards: plan.plannedBackwards,
		...(plan.timezone ? { timezone: plan.timezone } : {}),
		legs: plan.legs.map((leg): JourneyNarrationLeg => {
			const lines = leg.itinerary?.legs
				.filter((sub) => sub.type === "pt" && sub.line)
				.map((sub) => sub.line as string);
			return {
				mode: leg.mode,
				depart: clockOf(leg.departure),
				arrive: clockOf(leg.arrival),
				minutes: minutesOf(leg.durationS),
				from: leg.fromLabel,
				to: leg.toLabel,
				distance_m: leg.distanceM,
				...(lines && lines.length > 0 ? { lines } : {}),
				...(leg.route
					? { steps: narrateSteps(buildRouteSteps(leg.route)) }
					: {}),
			};
		}),
	};
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
			summary: results[0]
				? `${results[0].name} (${results[0].lat}, ${results[0].lng})`
				: `No match for "${input.query}"`,
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
				providerFailureMessage("a route", outcome, provider),
			);
		}
		const data = outcome.data;
		const candidates = [
			placeCandidate("route:origin", origin.label, origin.coord),
			placeCandidate("route:destination", destination.label, destination.coord),
		];
		const map = buildRouteMapCardData({
			route: data,
			originLabel: origin.label,
			destinationLabel: destination.label,
			mode,
		});
		const summary = routeSummary(data, mode);
		return buildPayload({
			success: true,
			action: "route",
			message: `${mode} route from ${origin.label} to ${destination.label}: ${summary}`,
			summary,
			route: narrateRoute(data, mode, map?.steps ?? []),
			candidates,
			...(map ? { map } : {}),
		});
	}

	if (input.action === "journey") {
		if (input.origin === undefined || input.destination === undefined) {
			return missingInput(
				"journey",
				"journey requires `origin`, `destination` and `legs`.",
			);
		}
		const rawLegs = input.legs ?? [];
		if (rawLegs.length === 0) {
			return missingInput(
				"journey",
				"journey requires `legs` — the modes to use, in order.",
			);
		}
		const chained = chainJourneyLegs(rawLegs, input.origin, input.destination);
		if (!chained.ok) return missingInput("journey", chained.message);

		// A chained journey names the same place twice (one leg's end is the
		// next one's start), so each distinct place is geocoded ONCE.
		const resolvedPlaces = new Map<string, { coord: LatLng; label: string }>();
		const legs: ResolvedJourneyLeg[] = [];
		for (const leg of chained.legs) {
			const ends: { coord: LatLng; label: string }[] = [];
			for (const place of [leg.from, leg.to]) {
				const key =
					typeof place === "string" ? `s:${place}` : JSON.stringify(place);
				const cached = resolvedPlaces.get(key);
				if (cached) {
					ends.push(cached);
					continue;
				}
				const resolved = await resolvePlace(place, provider);
				if (!resolved.ok) return failure("journey", resolved.message);
				const entry = { coord: resolved.coord, label: resolved.label };
				resolvedPlaces.set(key, entry);
				ends.push(entry);
			}
			legs.push({
				mode: leg.mode,
				from: ends[0].coord,
				to: ends[1].coord,
				fromLabel: ends[0].label,
				toLabel: ends[1].label,
			});
		}

		const nowMs = Date.now();
		const departure = input.departure
			? toRegionLocalDateTime(input.departure, undefined, nowMs)
			: undefined;
		const arriveBy = input.arrive_by
			? toRegionLocalDateTime(input.arrive_by, undefined, nowMs)
			: undefined;
		if (input.departure && !departure) {
			return failure(
				"journey",
				`I couldn't read "${input.departure}" as a departure time. Use "HH:MM" or "YYYY-MM-DDTHH:MM".`,
			);
		}
		if (input.arrive_by && !arriveBy) {
			return failure(
				"journey",
				`I couldn't read "${input.arrive_by}" as an arrival time. Use "HH:MM" or "YYYY-MM-DDTHH:MM".`,
			);
		}

		const outcome = await planJourney(
			{
				legs,
				// "Be there by" is the stricter ask, so it wins over a departure —
				// the same precedence the transit action uses.
				...(arriveBy ? { arriveBy } : departure ? { departure } : {}),
			},
			{ provider },
		);
		if (!outcome.ok) return failure("journey", outcome.message);
		const plan = outcome.plan;
		const first = legs[0];
		const last = legs[legs.length - 1];
		const card = journeyCardLegs(plan);
		const summary = journeySummary(plan);
		const map = buildTransitMapCardData({
			points: card.points,
			origin: first.from,
			destination: last.to,
			originLabel: first.fromLabel,
			destinationLabel: last.toLabel,
			durationS: plan.durationS,
			distanceM: plan.distanceM,
			transfers: plan.transfers,
			legs: card.legs,
			mode: "journey",
			departAt: clockOf(plan.departure),
			arriveAt: clockOf(plan.arrival),
			departDate: plan.departure.slice(0, 10),
			...(arriveBy ? { arriveBy: clockOf(arriveBy) } : {}),
		});
		return buildPayload({
			success: true,
			action: "journey",
			message: `Journey from ${first.fromLabel} to ${last.toLabel}: ${summary}`,
			summary,
			journey: narrateJourney(plan, summary),
			candidates: [
				placeCandidate("journey:origin", first.fromLabel, first.from),
				placeCandidate("journey:destination", last.toLabel, last.to),
			],
			map,
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
				providerFailureMessage("the distance/ETA matrix", outcome, provider),
			);
		}
		return buildPayload({
			success: true,
			action: "matrix",
			message: `Computed a ${origins.length}×${destinations.length} ${mode} distance/ETA matrix.`,
			summary: `${origins.length}×${destinations.length} ${mode} matrix`,
			matrix: outcome.data,
		});
	}

	if (input.action === "transit" || input.action === "timetable") {
		const action = input.action;
		if (input.origin === undefined || input.destination === undefined) {
			return missingInput(
				action,
				`${action} requires both \`origin\` and \`destination\`.`,
			);
		}
		if (!provider.transit || !provider.transitSchedule) {
			return failure(
				action,
				"Public transport timetables are not available on this server. Say timetables are unavailable rather than inventing departures.",
			);
		}
		const origin = await resolvePlace(input.origin, provider);
		if (!origin.ok) return failure(action, origin.message);
		const destination = await resolvePlace(input.destination, provider);
		if (!destination.ok) return failure(action, destination.message);

		const base = {
			origin: origin.coord,
			destination: destination.coord,
			...(input.max_walk_minutes !== undefined
				? { walkingTimeMinutes: input.max_walk_minutes }
				: {}),
		};
		const outcome =
			action === "transit"
				? await provider.transit({
						...base,
						// `arrive_by` is the stricter ask, so it wins over `departure`.
						...(input.arrive_by
							? { arrival: input.arrive_by }
							: input.departure
								? { departure: input.departure }
								: {}),
					})
				: await provider.transitSchedule({
						...base,
						...(input.from ? { departure: input.from } : {}),
						...(input.window_minutes !== undefined
							? { windowMinutes: input.window_minutes }
							: {}),
						...(input.rows !== undefined ? { rows: input.rows } : {}),
					});
		if (!outcome.ok) {
			return failure(
				action,
				providerFailureMessage(
					action === "transit"
						? "a public transport journey"
						: "the next departures",
					outcome,
					provider,
				),
			);
		}
		const data = outcome.data;
		const narration = narrateTransit(data);
		const first = narration.itineraries[0];
		const firstItinerary = data.itineraries[0];
		const candidates = [
			placeCandidate("transit:origin", origin.label, origin.coord),
			placeCandidate(
				"transit:destination",
				destination.label,
				destination.coord,
			),
		];
		const map = buildTransitMapCardData({
			...(firstItinerary?.polyline
				? { polyline: firstItinerary.polyline }
				: {}),
			origin: origin.coord,
			destination: destination.coord,
			originLabel: origin.label,
			destinationLabel: destination.label,
			durationS: firstItinerary?.duration_s ?? 0,
			distanceM: firstItinerary?.distance_m ?? 0,
			transfers: first?.transfers ?? 0,
			// The itinerary is drawn as a timeline for BOTH actions: a timetable
			// answer is far more useful when the first departure is shown in
			// full and the rest read as alternatives under it.
			...(first ? { legs: first.legs.map(transitCardLeg) } : {}),
			...(first?.depart ? { departAt: first.depart } : {}),
			...(first?.arrive ? { arriveAt: first.arrive } : {}),
			...(journeyDate(firstItinerary?.departure, data.timezone)
				? {
						departDate: journeyDate(
							firstItinerary?.departure,
							data.timezone,
						) as string,
					}
				: {}),
			...(action === "timetable"
				? {
						// The first itinerary is the timeline above; these are the
						// ALTERNATIVES to it, capped so the card stays a card.
						departures: narration.itineraries
							.slice(1, 1 + MAX_ALTERNATIVE_DEPARTURES)
							.map((itinerary) => ({
								...(itinerary.depart ? { depart: itinerary.depart } : {}),
								...(itinerary.arrive ? { arrive: itinerary.arrive } : {}),
								minutes: itinerary.minutes,
								transfers: itinerary.transfers,
								...(firstLine(itinerary) ? { line: firstLine(itinerary) } : {}),
							})),
					}
				: {}),
		});

		const legSummary = first
			? `${first.depart ?? "?"} → ${first.arrive ?? "?"} · ${formatDuration((first.minutes ?? 0) * 60)} · ${first.transfers} change${first.transfers === 1 ? "" : "s"}`
			: "no itinerary";
		if (action === "timetable") {
			const count = narration.itineraries.length;
			return buildPayload({
				success: true,
				action,
				message: `Next ${count} public transport departure${count === 1 ? "" : "s"} from ${origin.label} to ${destination.label}${first?.depart ? `, starting ${first.depart}` : ""}.`,
				summary: legSummary,
				transit: narration,
				candidates,
				map,
			});
		}
		return buildPayload({
			success: true,
			action,
			message: `Public transport from ${origin.label} to ${destination.label}: ${legSummary}.`,
			summary: legSummary,
			transit: narration,
			candidates,
			map,
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
			providerFailureMessage("reachability", outcome, provider),
		);
	}
	return buildPayload({
		success: true,
		action: "isochrone",
		message: `Computed ${outcome.data.polygons.length} ${mode} reachability polygon${outcome.data.polygons.length === 1 ? "" : "s"} from ${origin.label}.`,
		summary: `${outcome.data.polygons.length} ${mode} reachability polygon${outcome.data.polygons.length === 1 ? "" : "s"} from ${origin.label}`,
		isochrone: outcome.data,
		candidates: [
			placeCandidate("isochrone:origin", origin.label, origin.coord),
		],
	});
}
