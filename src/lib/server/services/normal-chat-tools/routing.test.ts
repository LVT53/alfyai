import { describe, expect, it, vi } from "vitest";
import type {
	GeocodeOutcome,
	IsochroneOutcome,
	MatrixOutcome,
	RouteOutcome,
	RoutingProvider,
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
