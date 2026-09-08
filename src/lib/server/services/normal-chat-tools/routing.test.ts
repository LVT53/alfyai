import { describe, expect, it, vi } from "vitest";
import type {
	GeocodeOutcome,
	IsochroneOutcome,
	MatrixOutcome,
	RouteOutcome,
	RoutingProvider,
	TransitOutcome,
} from "$lib/server/services/routing/types";
import { OSM_ATTRIBUTION } from "$lib/server/services/routing/types";
import {
	routingToolInputSchema,
	runRoutingTool,
	sanitizeRoutingToolInput,
} from "./routing";

// A fully controllable fake RoutingProvider (no network). Each method resolves
// whatever outcome the test queues; flags default to fully-configured.
function makeProvider(
	overrides: Partial<{
		routingConfigured: boolean;
		geocoderConfigured: boolean;
		geocode: GeocodeOutcome;
		route: RouteOutcome;
		matrix: MatrixOutcome;
		isochrone: IsochroneOutcome;
	}> = {},
): {
	provider: RoutingProvider;
	geocodeMock: ReturnType<typeof vi.fn>;
	routeMock: ReturnType<typeof vi.fn>;
	matrixMock: ReturnType<typeof vi.fn>;
	isochroneMock: ReturnType<typeof vi.fn>;
} {
	const geocodeMock = vi.fn().mockResolvedValue(
		overrides.geocode ?? {
			ok: true,
			data: {
				results: [
					{ name: "Resolved Place", lat: 52.5, lng: 13.4, confidence: 0.9 },
				],
			},
		},
	);
	const routeMock = vi.fn().mockResolvedValue(
		overrides.route ?? {
			ok: true,
			data: {
				distance_m: 1000,
				duration_s: 600,
				legs: [{ distance_m: 1000, duration_s: 600 }],
				polyline: "poly",
				coords: {
					origin: { lat: 52.5, lng: 13.4 },
					destination: { lat: 48.85, lng: 2.35 },
				},
			},
		},
	);
	const matrixMock = vi.fn().mockResolvedValue(
		overrides.matrix ?? {
			ok: true,
			data: {
				durations_s: [[0, 60]],
				distances_m: [[0, 1000]],
			},
		},
	);
	const isochroneMock = vi.fn().mockResolvedValue(
		overrides.isochrone ?? {
			ok: true,
			data: {
				origin: { lat: 52.5, lng: 13.4 },
				polygons: [{ range_s: 300, geojson: { type: "Polygon" } }],
			},
		},
	);
	const provider: RoutingProvider = {
		routingConfigured: () => overrides.routingConfigured ?? true,
		geocoderConfigured: () => overrides.geocoderConfigured ?? true,
		geocode: geocodeMock,
		route: routeMock,
		matrix: matrixMock,
		isochrone: isochroneMock,
	};
	return { provider, geocodeMock, routeMock, matrixMock, isochroneMock };
}

describe("routingToolInputSchema", () => {
	it("accepts {lat,lng} coordinates for origin/destination", () => {
		const parsed = routingToolInputSchema.safeParse({
			action: "route",
			origin: { lat: 1, lng: 2 },
			destination: { lat: 3, lng: 4 },
			mode: "drive",
		});
		expect(parsed.success).toBe(true);
	});

	it("accepts a place-name string for origin/destination", () => {
		const parsed = routingToolInputSchema.safeParse({
			action: "route",
			origin: "Berlin",
			destination: "Paris",
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects an unknown mode", () => {
		const parsed = routingToolInputSchema.safeParse({
			action: "route",
			origin: "Berlin",
			destination: "Paris",
			mode: "teleport",
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects an unknown action", () => {
		const parsed = routingToolInputSchema.safeParse({ action: "fly" });
		expect(parsed.success).toBe(false);
	});

	it("sanitizes/trims place strings", () => {
		const sanitized = sanitizeRoutingToolInput({
			action: "route",
			origin: "  Berlin  ",
			destination: { lat: 3, lng: 4 },
		});
		expect(sanitized.origin).toBe("Berlin");
		expect(sanitized.destination).toEqual({ lat: 3, lng: 4 });
	});

	// ── Array-input caps (DoS guard) ───────────────────────────────
	// Place STRINGS are geocoded sequentially, so an unbounded matrix would
	// fire thousands of serial geocoder requests. The schema rejects over-cap
	// arrays at the seam (same path as the `mode`/`action` rejections above),
	// so the runner — and therefore the provider — is never reached.
	const place = (i: number) => ({ lat: 0, lng: i % 180 });
	const places = (n: number) => Array.from({ length: n }, (_, i) => place(i));

	it("rejects over-cap `origins` (> 25)", () => {
		const parsed = routingToolInputSchema.safeParse({
			action: "matrix",
			origins: places(26),
			destinations: [place(0)],
		});
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(parsed.error.issues[0]?.message.toLowerCase()).toContain("25");
		}
	});

	it("rejects over-cap `destinations` (> 25)", () => {
		const parsed = routingToolInputSchema.safeParse({
			action: "matrix",
			origins: [place(0)],
			destinations: places(26),
		});
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(parsed.error.issues[0]?.message.toLowerCase()).toContain("25");
		}
	});

	it("rejects over-cap `waypoints` (> 25)", () => {
		const parsed = routingToolInputSchema.safeParse({
			action: "route",
			origin: place(0),
			destination: place(1),
			waypoints: places(26),
		});
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(parsed.error.issues[0]?.message.toLowerCase()).toContain("25");
		}
	});

	it("accepts in-cap arrays (exactly 25 origins/destinations)", () => {
		const parsed = routingToolInputSchema.safeParse({
			action: "matrix",
			origins: places(25),
			destinations: places(25),
		});
		expect(parsed.success).toBe(true);
	});

	it("accepts in-cap waypoints (exactly 25)", () => {
		const parsed = routingToolInputSchema.safeParse({
			action: "route",
			origin: place(0),
			destination: place(1),
			waypoints: places(25),
		});
		expect(parsed.success).toBe(true);
	});

	// ── Coordinate range bounds (hygiene) ──────────────────────────
	// Reject out-of-range lat/lng at the seam instead of round-tripping to ORS
	// for a 400. NaN/Infinity are already rejected by Zod's z.number().
	it("rejects out-of-range lat (999)", () => {
		const parsed = routingToolInputSchema.safeParse({
			action: "route",
			origin: { lat: 999, lng: 0 },
			destination: { lat: 3, lng: 4 },
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects out-of-range lng (-5000)", () => {
		const parsed = routingToolInputSchema.safeParse({
			action: "route",
			origin: { lat: 0, lng: -5000 },
			destination: { lat: 3, lng: 4 },
		});
		expect(parsed.success).toBe(false);
	});

	it("accepts valid coords at the range boundary", () => {
		const parsed = routingToolInputSchema.safeParse({
			action: "route",
			origin: { lat: -90, lng: -180 },
			destination: { lat: 90, lng: 180 },
		});
		expect(parsed.success).toBe(true);
	});
});

describe("runRoutingTool — geocode", () => {
	it("returns structured geocode results and candidates", async () => {
		const { provider, geocodeMock } = makeProvider();
		const outcome = await runRoutingTool(
			{ action: "geocode", query: "Berlin" },
			{ provider },
		);
		expect(geocodeMock).toHaveBeenCalledWith({ query: "Berlin" });
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.geocode?.results[0]).toMatchObject({
			name: "Resolved Place",
			lat: 52.5,
			lng: 13.4,
		});
		expect(outcome.modelPayload.attribution).toBe(OSM_ATTRIBUTION);
		expect(outcome.candidates.length).toBe(1);
	});

	it("degrades clearly when the geocoder is not configured", async () => {
		const { provider, geocodeMock } = makeProvider({
			geocoderConfigured: false,
		});
		const outcome = await runRoutingTool(
			{ action: "geocode", query: "Berlin" },
			{ provider },
		);
		expect(geocodeMock).not.toHaveBeenCalled();
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message.toLowerCase()).toContain(
			"geocoding is unavailable",
		);
		expect(outcome.modelPayload.geocode).toBeUndefined();
	});
});

describe("runRoutingTool — route", () => {
	it("routes with explicit coordinates without geocoding", async () => {
		const { provider, geocodeMock, routeMock } = makeProvider();
		const outcome = await runRoutingTool(
			{
				action: "route",
				origin: { lat: 52.5, lng: 13.4 },
				destination: { lat: 48.85, lng: 2.35 },
				mode: "drive",
			},
			{ provider },
		);
		expect(geocodeMock).not.toHaveBeenCalled();
		expect(routeMock).toHaveBeenCalledWith({
			origin: { lat: 52.5, lng: 13.4 },
			destination: { lat: 48.85, lng: 2.35 },
			mode: "drive",
		});
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.route?.distance_m).toBe(1000);
		expect(outcome.modelPayload.attribution).toBe(OSM_ATTRIBUTION);
		// The inline map card data rides the outcome, never the model payload.
		expect(outcome.map).toBeDefined();
		expect(outcome.map?.distanceM).toBe(1000);
		expect(outcome.map?.mode).toBe("drive");
		expect(outcome.map?.markers).toEqual([
			{ lat: 52.5, lng: 13.4, label: "52.5, 13.4", kind: "origin" },
			{ lat: 48.85, lng: 2.35, label: "48.85, 2.35", kind: "destination" },
		]);
		expect(
			(outcome.modelPayload as Record<string, unknown>).map,
		).toBeUndefined();
	});

	it("omits map data for a failed route", async () => {
		const { provider } = makeProvider({
			route: { ok: false, reason: "no_route", message: "no path" },
		});
		const outcome = await runRoutingTool(
			{
				action: "route",
				origin: { lat: 52.5, lng: 13.4 },
				destination: { lat: 48.85, lng: 2.35 },
			},
			{ provider },
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.map).toBeUndefined();
	});

	it("auto-geocodes place-name strings before routing", async () => {
		const geocodeMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				data: { results: [{ name: "Berlin", lat: 52.5, lng: 13.4 }] },
			})
			.mockResolvedValueOnce({
				ok: true,
				data: { results: [{ name: "Paris", lat: 48.85, lng: 2.35 }] },
			});
		const routeMock = vi.fn().mockResolvedValue({
			ok: true,
			data: {
				distance_m: 1,
				duration_s: 1,
				legs: [],
				coords: {
					origin: { lat: 52.5, lng: 13.4 },
					destination: { lat: 48.85, lng: 2.35 },
				},
			},
		});
		const provider: RoutingProvider = {
			routingConfigured: () => true,
			geocoderConfigured: () => true,
			geocode: geocodeMock,
			route: routeMock,
			matrix: vi.fn(),
			isochrone: vi.fn(),
		};

		const outcome = await runRoutingTool(
			{ action: "route", origin: "Berlin", destination: "Paris", mode: "walk" },
			{ provider },
		);

		expect(geocodeMock).toHaveBeenCalledTimes(2);
		expect(routeMock).toHaveBeenCalledWith({
			origin: { lat: 52.5, lng: 13.4 },
			destination: { lat: 48.85, lng: 2.35 },
			mode: "walk",
		});
		expect(outcome.modelPayload.success).toBe(true);
	});

	it("tells the model to pass coordinates when a place string can't be geocoded (no geocoder)", async () => {
		const { provider, routeMock } = makeProvider({ geocoderConfigured: false });
		const outcome = await runRoutingTool(
			{ action: "route", origin: "Berlin", destination: "Paris" },
			{ provider },
		);
		expect(routeMock).not.toHaveBeenCalled();
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("{lat,lng}");
		expect(outcome.modelPayload.route).toBeUndefined();
	});

	it("returns 'routing unavailable' and never a fabricated route when ORS is unconfigured", async () => {
		const { provider, routeMock } = makeProvider({ routingConfigured: false });
		const outcome = await runRoutingTool(
			{
				action: "route",
				origin: { lat: 1, lng: 2 },
				destination: { lat: 3, lng: 4 },
			},
			{ provider },
		);
		expect(routeMock).not.toHaveBeenCalled();
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message.toLowerCase()).toContain(
			"routing is unavailable",
		);
		expect(outcome.modelPayload.route).toBeUndefined();
	});

	it("returns 'unavailable' (never fabricates) when the provider route call fails", async () => {
		const { provider } = makeProvider({
			route: {
				ok: false,
				reason: "provider_error",
				message: "ORS 500",
			},
		});
		const outcome = await runRoutingTool(
			{
				action: "route",
				origin: { lat: 1, lng: 2 },
				destination: { lat: 3, lng: 4 },
			},
			{ provider },
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.route).toBeUndefined();
		expect(outcome.modelPayload.message.toLowerCase()).toContain("unavailable");
	});
});

describe("runRoutingTool — matrix", () => {
	it("resolves origins/destinations and maps the matrix", async () => {
		const { provider, matrixMock } = makeProvider();
		const outcome = await runRoutingTool(
			{
				action: "matrix",
				origins: [{ lat: 1, lng: 1 }],
				destinations: [{ lat: 2, lng: 2 }],
				mode: "bike",
			},
			{ provider },
		);
		expect(matrixMock).toHaveBeenCalledWith({
			origins: [{ lat: 1, lng: 1 }],
			destinations: [{ lat: 2, lng: 2 }],
			mode: "bike",
		});
		expect(outcome.modelPayload.matrix).toEqual({
			durations_s: [[0, 60]],
			distances_m: [[0, 1000]],
		});
		expect(outcome.modelPayload.attribution).toBe(OSM_ATTRIBUTION);
	});

	it("requires non-empty origins and destinations", async () => {
		const { provider, matrixMock } = makeProvider();
		const outcome = await runRoutingTool(
			{ action: "matrix", origins: [], destinations: [{ lat: 2, lng: 2 }] },
			{ provider },
		);
		expect(matrixMock).not.toHaveBeenCalled();
		expect(outcome.modelPayload.success).toBe(false);
	});
});

describe("runRoutingTool — isochrone", () => {
	it("maps isochrone polygons and carries attribution", async () => {
		const { provider, isochroneMock } = makeProvider();
		const outcome = await runRoutingTool(
			{
				action: "isochrone",
				origin: { lat: 52.5, lng: 13.4 },
				ranges_s: [300, 600],
				mode: "drive",
			},
			{ provider },
		);
		expect(isochroneMock).toHaveBeenCalledWith({
			origin: { lat: 52.5, lng: 13.4 },
			mode: "drive",
			rangesS: [300, 600],
		});
		expect(outcome.modelPayload.isochrone?.polygons[0]).toMatchObject({
			range_s: 300,
		});
		expect(outcome.modelPayload.attribution).toBe(OSM_ATTRIBUTION);
	});

	it("requires ranges_s", async () => {
		const { provider, isochroneMock } = makeProvider();
		const outcome = await runRoutingTool(
			{ action: "isochrone", origin: { lat: 52.5, lng: 13.4 } },
			{ provider },
		);
		expect(isochroneMock).not.toHaveBeenCalled();
		expect(outcome.modelPayload.success).toBe(false);
	});

	it("returns 'unavailable' when ORS is unconfigured, never fabricated polygons", async () => {
		const { provider, isochroneMock } = makeProvider({
			routingConfigured: false,
		});
		const outcome = await runRoutingTool(
			{
				action: "isochrone",
				origin: { lat: 52.5, lng: 13.4 },
				ranges_s: [300],
			},
			{ provider },
		);
		expect(isochroneMock).not.toHaveBeenCalled();
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.isochrone).toBeUndefined();
	});
});

describe("runRoutingTool — coverage-aware failures", () => {
	it("reports out_of_coverage as a coverage limit (with the region), not an outage, and forbids estimating", async () => {
		const { provider } = makeProvider({
			route: {
				ok: false,
				reason: "out_of_coverage",
				message:
					"Could not find routable point within a radius of 2000.0 meters of specified coordinate 0: -6.2474000 53.4269000.",
			},
		});
		provider.coverageLabel = () => "Hungary";
		const outcome = await runRoutingTool(
			{
				action: "route",
				origin: { lat: 53.4269, lng: -6.2474 },
				destination: { lat: 53.42829, lng: -6.24278 },
				mode: "walk",
			},
			{ provider },
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.route).toBeUndefined();
		const message = outcome.modelPayload.message;
		expect(message).toContain("outside the routing coverage");
		expect(message).toContain("covers Hungary only");
		expect(message).toContain("-6.2474000 53.4269000");
		expect(message.toLowerCase()).not.toContain("service is unavailable");
		expect(message).toContain("do NOT estimate");
	});

	it("reports no_route as 'no path found', never as unavailable", async () => {
		const { provider } = makeProvider({
			matrix: {
				ok: false,
				reason: "no_route",
				message: "Route could not be found",
			},
		});
		const outcome = await runRoutingTool(
			{
				action: "matrix",
				origins: [{ lat: 1, lng: 2 }],
				destinations: [{ lat: 3, lng: 4 }],
			},
			{ provider },
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain(
			"no path between those points",
		);
		expect(outcome.modelPayload.message.toLowerCase()).not.toContain(
			"unavailable",
		);
	});

	it("falls back to a generic coverage note when no label is configured", async () => {
		const { provider } = makeProvider({
			isochrone: {
				ok: false,
				reason: "out_of_coverage",
				message: "Point not found",
			},
		});
		const outcome = await runRoutingTool(
			{ action: "isochrone", origin: { lat: 1, lng: 2 }, ranges_s: [300] },
			{ provider },
		);
		expect(outcome.modelPayload.message).toContain("does not cover that area");
	});
});

// ── Public transport ───────────────────────────────────────────

// One journey: walk → bus 39A → walk, with the ISO instants ORS emits.
const TRANSIT_ITINERARY = {
	departure: "2026-09-08T08:25:00+02:00",
	arrival: "2026-09-08T08:52:00+02:00",
	duration_s: 1620,
	distance_m: 5231.4,
	transfers: 1,
	polyline: "journey_polyline",
	legs: [
		{
			type: "walk" as const,
			departure: "2026-09-08T08:25:00+02:00",
			arrival: "2026-09-08T08:28:00+02:00",
			distance_m: 245,
			duration_s: 196,
		},
		{
			type: "pt" as const,
			departure: "2026-09-08T08:31:00+02:00",
			arrival: "2026-09-08T08:50:00+02:00",
			from: "Dossenheim, Süd",
			to: "Heidelberg, Alois-Link-Platz",
			line: "39A",
			lineLong: "RNV Bus 39A",
			headsign: "Bismarckplatz",
			routeType: 3,
			stopsCount: 7,
			distance_m: 4786,
			duration_s: 1140,
		},
		{
			type: "walk" as const,
			departure: "2026-09-08T08:50:00+02:00",
			arrival: "2026-09-08T08:52:00+02:00",
			distance_m: 200,
			duration_s: 120,
		},
	],
};

function transitProvider(
	overrides: {
		transit?: TransitOutcome;
		transitSchedule?: TransitOutcome;
		omitTransit?: boolean;
		transitCoverageLabel?: string;
	} = {},
) {
	const { provider, geocodeMock } = makeProvider();
	const transitMock = vi.fn().mockResolvedValue(
		overrides.transit ?? {
			ok: true,
			data: {
				itineraries: [TRANSIT_ITINERARY],
				coords: {
					origin: { lat: 49.4, lng: 8.69 },
					destination: { lat: 49.41, lng: 8.695 },
				},
				timezone: "Europe/Berlin",
				query: { departure: "2026-09-08T08:25:00", walkingTimeMinutes: 15 },
			},
		},
	);
	const scheduleMock = vi.fn().mockResolvedValue(
		overrides.transitSchedule ?? {
			ok: true,
			data: {
				itineraries: [
					TRANSIT_ITINERARY,
					{
						...TRANSIT_ITINERARY,
						departure: "2026-09-08T08:45:00+02:00",
						arrival: "2026-09-08T09:12:00+02:00",
					},
				],
				coords: {
					origin: { lat: 49.4, lng: 8.69 },
					destination: { lat: 49.41, lng: 8.695 },
				},
				timezone: "Europe/Berlin",
				query: { schedule: true },
			},
		},
	);
	const withTransit: RoutingProvider = overrides.omitTransit
		? provider
		: {
				...provider,
				transit: transitMock,
				transitSchedule: scheduleMock,
				...(overrides.transitCoverageLabel !== undefined
					? { transitCoverageLabel: () => overrides.transitCoverageLabel ?? "" }
					: {}),
			};
	return { provider: withTransit, transitMock, scheduleMock, geocodeMock };
}

describe("routingToolInputSchema — transit actions", () => {
	it("accepts a transit journey with an arrive-by time and a walk budget", () => {
		expect(
			routingToolInputSchema.safeParse({
				action: "transit",
				origin: "Dossenheim",
				destination: { lat: 49.41, lng: 8.695 },
				arrive_by: "09:00",
				max_walk_minutes: 20,
			}).success,
		).toBe(true);
	});

	it("accepts a timetable request with a window and a row count", () => {
		expect(
			routingToolInputSchema.safeParse({
				action: "timetable",
				origin: "A",
				destination: "B",
				from: "2026-09-08T08:00",
				window_minutes: 180,
				rows: 6,
			}).success,
		).toBe(true);
	});

	it("rejects an out-of-range window, row count or walk budget", () => {
		for (const overrides of [
			{ window_minutes: 5000 },
			{ rows: 99 },
			{ max_walk_minutes: 999 },
			{ rows: 0 },
			{ window_minutes: -10 },
		]) {
			expect(
				routingToolInputSchema.safeParse({
					action: "timetable",
					origin: "A",
					destination: "B",
					...overrides,
				}).success,
			).toBe(false);
		}
	});

	it("keeps the transit fields through sanitization, trimmed", () => {
		expect(
			sanitizeRoutingToolInput({
				action: "transit",
				origin: "  A  ",
				destination: "B",
				departure: "  08:30 ",
				max_walk_minutes: 25,
			}),
		).toEqual({
			action: "transit",
			origin: "A",
			destination: "B",
			departure: "08:30",
			max_walk_minutes: 25,
		});
	});
});

describe("runRoutingTool — transit", () => {
	it("narrates the itinerary with local clock times, lines and transfers", async () => {
		const { provider, transitMock } = transitProvider();
		const outcome = await runRoutingTool(
			{
				action: "transit",
				origin: { lat: 49.4, lng: 8.69 },
				destination: { lat: 49.41, lng: 8.695 },
				departure: "08:20",
				max_walk_minutes: 20,
			},
			{ provider },
		);
		expect(outcome.modelPayload.success).toBe(true);
		expect(transitMock).toHaveBeenCalledWith(
			expect.objectContaining({
				departure: "08:20",
				walkingTimeMinutes: 20,
			}),
		);
		const transit = outcome.modelPayload.transit;
		expect(transit?.timezone).toBe("Europe/Berlin");
		expect(transit?.itineraries).toHaveLength(1);
		const itinerary = transit?.itineraries[0];
		expect(itinerary).toMatchObject({
			depart: "08:25",
			arrive: "08:52",
			minutes: 27,
			transfers: 1,
			// 196 s + 120 s of walking.
			walk_minutes: 5,
		});
		expect(itinerary?.legs[1]).toMatchObject({
			type: "pt",
			depart: "08:31",
			arrive: "08:50",
			line: "39A",
			headsign: "Bismarckplatz",
			vehicle: "bus",
			stops: 7,
			minutes: 19,
		});
		expect(itinerary?.legs[0]).toMatchObject({ type: "walk", walk_m: 245 });
		expect(outcome.modelPayload.message).toContain("08:25 → 08:52");
		expect(outcome.modelPayload.attribution).toBe(OSM_ATTRIBUTION);
	});

	it("sends arrive_by as an arrival, never alongside a departure", async () => {
		const { provider, transitMock } = transitProvider();
		await runRoutingTool(
			{
				action: "transit",
				origin: "A",
				destination: "B",
				departure: "08:00",
				arrive_by: "09:30",
			},
			{ provider },
		);
		const call = transitMock.mock.calls[0][0];
		expect(call.arrival).toBe("09:30");
		expect(call.departure).toBeUndefined();
	});

	it("builds a map card carrying the itinerary legs and the journey polyline", async () => {
		const { provider } = transitProvider();
		const outcome = await runRoutingTool(
			{
				action: "transit",
				origin: { lat: 49.4, lng: 8.69 },
				destination: { lat: 49.41, lng: 8.695 },
			},
			{ provider },
		);
		expect(outcome.map?.mode).toBe("transit");
		expect(outcome.map?.transfers).toBe(1);
		expect(outcome.map?.transitLegs).toHaveLength(3);
		expect(outcome.map?.transitLegs?.[1]).toMatchObject({
			type: "pt",
			line: "39A",
			depart: "08:31",
			arrive: "08:50",
			stops: 7,
		});
		expect(outcome.map?.departures).toBeUndefined();
		// The map data never rides the model payload.
		expect(
			(outcome.modelPayload as Record<string, unknown>).map,
		).toBeUndefined();
	});

	it("requires both endpoints", async () => {
		const { provider } = transitProvider();
		const outcome = await runRoutingTool(
			{ action: "transit", origin: "A" },
			{ provider },
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain(
			"`origin` and `destination`",
		);
	});

	it("says timetables are unavailable when the provider has no transit support", async () => {
		const { provider } = transitProvider({ omitTransit: true });
		const outcome = await runRoutingTool(
			{ action: "transit", origin: "A", destination: "B" },
			{ provider },
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain(
			"not available on this server",
		);
	});

	it("names the timetable coverage and forbids invented departures", async () => {
		const { provider } = transitProvider({
			transit: {
				ok: false,
				reason: "transit_unavailable",
				message: "No public transport timetable is loaded for Austria.",
			},
			transitCoverageLabel: "Hungary, Netherlands",
		});
		const outcome = await runRoutingTool(
			{ action: "transit", origin: "A", destination: "B" },
			{ provider },
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("Hungary, Netherlands");
		expect(outcome.modelPayload.message).toContain(
			"do NOT invent departure times",
		);
	});

	it("says so plainly when no timetable region is loaded at all", async () => {
		const { provider } = transitProvider({
			transit: {
				ok: false,
				reason: "transit_unavailable",
				message: "No public transport timetable is loaded.",
			},
			transitCoverageLabel: "",
		});
		const outcome = await runRoutingTool(
			{ action: "transit", origin: "A", destination: "B" },
			{ provider },
		);
		expect(outcome.modelPayload.message).toContain(
			"No public transport timetables are loaded on this server",
		);
	});
});

describe("runRoutingTool — timetable", () => {
	it("returns the next departures with local times and transfer counts", async () => {
		const { provider, scheduleMock } = transitProvider();
		const outcome = await runRoutingTool(
			{
				action: "timetable",
				origin: "Dossenheim",
				destination: "Heidelberg",
				from: "08:00",
				window_minutes: 90,
				rows: 4,
			},
			{ provider },
		);
		expect(scheduleMock).toHaveBeenCalledWith(
			expect.objectContaining({
				departure: "08:00",
				windowMinutes: 90,
				rows: 4,
			}),
		);
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.transit?.itineraries).toHaveLength(2);
		expect(outcome.modelPayload.message).toContain("Next 2 public transport");
		// The FIRST departure is drawn as the timeline; `departures` holds the
		// alternatives under it, so the 08:25 itinerary is not repeated there.
		expect(outcome.map?.departures).toEqual([
			{
				depart: "08:45",
				arrive: "09:12",
				minutes: 27,
				transfers: 1,
				line: "39A",
			},
		]);
		expect(outcome.map?.departAt).toBe("08:25");
		expect(
			outcome.map?.transitLegs?.find((leg) => leg.type === "pt"),
		).toMatchObject({ line: "39A" });
	});

	it("reports an empty timetable as a no-route failure, not as zero departures", async () => {
		const { provider } = transitProvider({
			transitSchedule: {
				ok: false,
				reason: "no_route",
				message: "No public transport journey was found.",
			},
		});
		const outcome = await runRoutingTool(
			{ action: "timetable", origin: "A", destination: "B" },
			{ provider },
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain(
			"no path between those points",
		);
	});
});

describe("runRoutingTool — route directions", () => {
	it("carries a compact manoeuvre list on the card and a summary for the model", async () => {
		const { provider } = makeProvider({
			route: {
				ok: true,
				data: {
					distance_m: 27_000,
					duration_s: 2040,
					legs: [
						{
							distance_m: 27_000,
							duration_s: 2040,
							steps: [
								{
									distance_m: 350,
									duration_s: 60,
									instruction: "Head south on Grand Parade",
									name: "Grand Parade",
									type: 11,
								},
								{
									distance_m: 17_000,
									duration_s: 900,
									instruction: "Turn left toward Kinsale",
									name: "R600",
									type: 0,
								},
								{
									distance_m: 0,
									duration_s: 0,
									instruction: "Arrive at Kinsale",
									type: 10,
								},
							],
						},
					],
					coords: {
						origin: { lat: 51.897, lng: -8.47 },
						destination: { lat: 51.706, lng: -8.522 },
					},
				},
			},
		});
		const outcome = await runRoutingTool(
			{
				action: "route",
				origin: { lat: 51.897, lng: -8.47 },
				destination: { lat: 51.706, lng: -8.522 },
			},
			{ provider },
		);
		expect(outcome.map?.steps).toHaveLength(3);
		expect(outcome.map?.steps?.[0]).toMatchObject({
			maneuver: "depart",
			distanceM: 350,
		});
		expect(outcome.map?.steps?.[2].maneuver).toBe("arrive");
		// The road the drive spends the most distance on becomes the "via".
		expect(outcome.map?.via).toBe("R600");
		expect(outcome.modelPayload.summary).toContain("via R600");
		// The model gets text, never the raw geometry.
		expect(outcome.modelPayload.route?.steps_total).toBe(3);
		expect(outcome.modelPayload.route?.steps[0]).toEqual({
			instruction: "Head south on Grand Parade",
			distance: "350 m",
		});
		expect(
			(outcome.modelPayload.route as unknown as Record<string, unknown>)
				.polyline,
		).toBeUndefined();
	});

	it("keeps the persisted card under the byte ceiling on a long route", async () => {
		const steps = Array.from({ length: 400 }, (_, index) => ({
			distance_m: 500,
			duration_s: 60,
			instruction: `Continue on a very long road name number ${index} for a while`,
			name: `Road ${index}`,
			type: 6,
			way_points: [index, index + 1] as [number, number],
		}));
		const { provider } = makeProvider({
			route: {
				ok: true,
				data: {
					distance_m: 200_000,
					duration_s: 24_000,
					legs: [{ distance_m: 200_000, duration_s: 24_000, steps }],
					coords: {
						origin: { lat: 51.897, lng: -8.47 },
						destination: { lat: 53.35, lng: -6.26 },
					},
				},
			},
		});
		const outcome = await runRoutingTool(
			{
				action: "route",
				origin: { lat: 51.897, lng: -8.47 },
				destination: { lat: 53.35, lng: -6.26 },
			},
			{ provider },
		);
		expect(outcome.map?.steps?.length).toBe(60);
		expect(Buffer.byteLength(JSON.stringify(outcome.map))).toBeLessThanOrEqual(
			12 * 1024,
		);
		expect(outcome.modelPayload.route?.steps.length).toBe(12);
		expect(outcome.modelPayload.route?.steps_total).toBe(60);
	});
});

describe("runRoutingTool — journey", () => {
	function journeyProvider() {
		const { provider, transitMock } = transitProvider();
		const routeMock = vi.fn().mockResolvedValue({
			ok: true,
			data: {
				distance_m: 4100,
				duration_s: 960,
				legs: [
					{
						distance_m: 4100,
						duration_s: 960,
						steps: [
							{
								distance_m: 2600,
								duration_s: 600,
								instruction: "Follow the greenway north-west",
								name: "Blackrock greenway",
								type: 6,
								way_points: [0, 5],
							},
						],
					},
				],
				coords: {
					origin: { lat: 51.897, lng: -8.47 },
					destination: { lat: 51.902, lng: -8.45 },
				},
			},
		});
		return {
			provider: { ...provider, route: routeMock } as RoutingProvider,
			routeMock,
			transitMock,
		};
	}

	it("plans a bike + train + walk journey backwards from an arrive-by time", async () => {
		const { provider, transitMock } = journeyProvider();
		const outcome = await runRoutingTool(
			{
				action: "journey",
				origin: { lat: 51.897, lng: -8.47 },
				destination: { lat: 53.344, lng: -6.259 },
				legs: [
					{ mode: "bike", to: { lat: 51.902, lng: -8.45 } },
					{ mode: "transit", to: { lat: 53.346, lng: -6.294 } },
					{ mode: "walk" },
				],
				arrive_by: "2026-09-08T09:30",
			},
			{ provider },
		);
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.journey?.planned_backwards).toBe(true);
		expect(outcome.modelPayload.journey?.legs.map((leg) => leg.mode)).toEqual([
			"bike",
			"transit",
			"walk",
		]);
		// The transit leg is asked to ARRIVE by the walk's departure minus the
		// ordinary 5-minute buffer, not to leave at a guessed time.
		expect(transitMock).toHaveBeenCalledWith(
			expect.objectContaining({ arrival: expect.stringContaining("T09:0") }),
		);
		expect(outcome.map?.mode).toBe("journey");
		expect(outcome.map?.arriveBy).toBe("09:30");
		// The timeline expands the transit leg into the services it contains.
		expect(outcome.map?.transitLegs?.map((leg) => leg.type)).toEqual([
			"bike",
			"walk",
			"pt",
			"walk",
			"walk",
		]);
		expect(outcome.map?.transitLegs?.[0].steps?.[0].instruction).toContain(
			"greenway",
		);
	});

	it("says which leg has no endpoint instead of guessing where the modes change", async () => {
		const { provider } = journeyProvider();
		const outcome = await runRoutingTool(
			{
				action: "journey",
				origin: "A",
				destination: "B",
				// Nothing says where the bike ride ends and the walk begins.
				legs: [{ mode: "bike" }, { mode: "walk" }],
			},
			{ provider },
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("leg 1 (bike) has no end");
	});

	it("requires legs", async () => {
		const { provider } = journeyProvider();
		const outcome = await runRoutingTool(
			{ action: "journey", origin: "A", destination: "B" },
			{ provider },
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("legs");
	});
});
