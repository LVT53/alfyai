import { describe, expect, it, vi } from "vitest";

import { createOrsProvider } from "./ors-provider";

function jsonResponse(body: unknown, init?: { status?: number }): Response {
	return new Response(JSON.stringify(body), {
		status: init?.status ?? 200,
		headers: { "content-type": "application/json" },
	});
}

const ORS_BASE = "http://ors.local/ors";
const GEOCODER_BASE = "http://nominatim.local";

describe("createOrsProvider", () => {
	describe("configuration flags", () => {
		it("reports routing unconfigured when ORS_BASE_URL is empty", () => {
			const provider = createOrsProvider(
				{ orsBaseUrl: "", geocoderBaseUrl: GEOCODER_BASE },
				{ fetch: vi.fn() },
			);
			expect(provider.routingConfigured()).toBe(false);
			expect(provider.geocoderConfigured()).toBe(true);
		});

		it("reports geocoder unconfigured when GEOCODER_BASE_URL is empty", () => {
			const provider = createOrsProvider(
				{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: "" },
				{ fetch: vi.fn() },
			);
			expect(provider.routingConfigured()).toBe(true);
			expect(provider.geocoderConfigured()).toBe(false);
		});
	});

	describe("route", () => {
		it("maps an ORS directions response into a structured route with [lng,lat] request order", async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				jsonResponse({
					routes: [
						{
							summary: { distance: 12345.6, duration: 987.6 },
							segments: [
								{
									distance: 12345.6,
									duration: 987.6,
									steps: [
										{
											distance: 100,
											duration: 20,
											instruction: "Head north",
											name: "Main St",
										},
									],
								},
							],
							geometry: "abc_polyline",
						},
					],
				}),
			);
			const provider = createOrsProvider(
				{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: GEOCODER_BASE },
				{ fetch: fetchMock },
			);

			const outcome = await provider.route({
				origin: { lat: 52.5, lng: 13.4 },
				destination: { lat: 48.85, lng: 2.35 },
				mode: "drive",
			});

			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.data).toMatchObject({
				distance_m: 12345.6,
				duration_s: 987.6,
				polyline: "abc_polyline",
				coords: {
					origin: { lat: 52.5, lng: 13.4 },
					destination: { lat: 48.85, lng: 2.35 },
				},
				legs: [
					{
						distance_m: 12345.6,
						duration_s: 987.6,
						steps: [
							{
								distance_m: 100,
								duration_s: 20,
								instruction: "Head north",
								name: "Main St",
							},
						],
					},
				],
			});

			// driving-car profile + [lng,lat] coordinate order in the request body.
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe(`${ORS_BASE}/v2/directions/driving-car`);
			const sentBody = JSON.parse((init as RequestInit).body as string);
			expect(sentBody).toEqual({
				coordinates: [
					[13.4, 52.5],
					[2.35, 48.85],
				],
			});
		});

		it("threads waypoints between origin and destination and selects the mode profile", async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				jsonResponse({
					routes: [{ summary: { distance: 1, duration: 1 }, segments: [] }],
				}),
			);
			const provider = createOrsProvider(
				{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: GEOCODER_BASE },
				{ fetch: fetchMock },
			);

			await provider.route({
				origin: { lat: 1, lng: 2 },
				destination: { lat: 5, lng: 6 },
				waypoints: [{ lat: 3, lng: 4 }],
				mode: "bike",
			});

			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe(`${ORS_BASE}/v2/directions/cycling-regular`);
			const sentBody = JSON.parse((init as RequestInit).body as string);
			expect(sentBody.coordinates).toEqual([
				[2, 1],
				[4, 3],
				[6, 5],
			]);
		});

		it("degrades to unconfigured without fetching when ORS_BASE_URL is empty", async () => {
			const fetchMock = vi.fn();
			const provider = createOrsProvider(
				{ orsBaseUrl: "", geocoderBaseUrl: GEOCODER_BASE },
				{ fetch: fetchMock },
			);

			const outcome = await provider.route({
				origin: { lat: 1, lng: 2 },
				destination: { lat: 3, lng: 4 },
				mode: "drive",
			});

			expect(outcome).toEqual({
				ok: false,
				reason: "unconfigured",
				message: expect.any(String),
			});
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("maps a non-2xx ORS response to a provider_error (never a fabricated route)", async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValue(new Response("boom", { status: 500 }));
			const provider = createOrsProvider(
				{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: GEOCODER_BASE },
				{ fetch: fetchMock },
			);

			const outcome = await provider.route({
				origin: { lat: 1, lng: 2 },
				destination: { lat: 3, lng: 4 },
				mode: "drive",
			});

			expect(outcome.ok).toBe(false);
			if (outcome.ok) return;
			expect(outcome.reason).toBe("provider_error");
		});

		it("maps a thrown fetch (network/timeout) to a provider_error", async () => {
			const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
			const provider = createOrsProvider(
				{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: GEOCODER_BASE },
				{ fetch: fetchMock },
			);

			const outcome = await provider.route({
				origin: { lat: 1, lng: 2 },
				destination: { lat: 3, lng: 4 },
				mode: "drive",
			});

			expect(outcome).toMatchObject({ ok: false, reason: "provider_error" });
		});
	});

	describe("matrix", () => {
		it("builds sources/destinations indices and maps durations/distances", async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				jsonResponse({
					durations: [
						[0, 60],
						[60, 0],
					],
					distances: [
						[0, 1000],
						[1000, 0],
					],
				}),
			);
			const provider = createOrsProvider(
				{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: GEOCODER_BASE },
				{ fetch: fetchMock },
			);

			const outcome = await provider.matrix({
				origins: [
					{ lat: 1, lng: 1 },
					{ lat: 2, lng: 2 },
				],
				destinations: [
					{ lat: 3, lng: 3 },
					{ lat: 4, lng: 4 },
				],
				mode: "walk",
			});

			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.data).toEqual({
				durations_s: [
					[0, 60],
					[60, 0],
				],
				distances_m: [
					[0, 1000],
					[1000, 0],
				],
			});

			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe(`${ORS_BASE}/v2/matrix/foot-walking`);
			const sentBody = JSON.parse((init as RequestInit).body as string);
			expect(sentBody).toEqual({
				locations: [
					[1, 1],
					[2, 2],
					[3, 3],
					[4, 4],
				],
				sources: [0, 1],
				destinations: [2, 3],
				metrics: ["distance", "duration"],
			});
		});
	});

	describe("isochrone", () => {
		it("maps ORS isochrone features into range_s + geojson polygons", async () => {
			const geom = { type: "Polygon", coordinates: [[[0, 0]]] };
			const fetchMock = vi.fn().mockResolvedValue(
				jsonResponse({
					features: [{ properties: { value: 300 }, geometry: geom }],
				}),
			);
			const provider = createOrsProvider(
				{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: GEOCODER_BASE },
				{ fetch: fetchMock },
			);

			const outcome = await provider.isochrone({
				origin: { lat: 10, lng: 20 },
				mode: "drive",
				rangesS: [300],
			});

			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.data).toEqual({
				origin: { lat: 10, lng: 20 },
				polygons: [{ range_s: 300, geojson: geom }],
			});

			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe(`${ORS_BASE}/v2/isochrones/driving-car`);
			const sentBody = JSON.parse((init as RequestInit).body as string);
			expect(sentBody).toEqual({
				locations: [[20, 10]],
				range: [300],
				range_type: "time",
			});
		});
	});

	describe("geocode (Nominatim)", () => {
		it("maps a Nominatim jsonv2 array into matches (lat/lon strings → numbers, importance → confidence)", async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				jsonResponse([
					{
						lat: "52.516",
						lon: "13.377",
						display_name: "Brandenburger Tor, Berlin, Germany",
						name: "Brandenburger Tor",
						type: "attraction",
						class: "tourism",
						importance: 0.7,
					},
				]),
			);
			const provider = createOrsProvider(
				{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: GEOCODER_BASE },
				{ fetch: fetchMock },
			);

			const outcome = await provider.geocode({ query: "Brandenburger Tor" });

			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.data.results).toEqual([
				{
					name: "Brandenburger Tor, Berlin, Germany",
					lat: 52.516,
					lng: 13.377,
					type: "attraction",
					confidence: 0.7,
				},
			]);

			// Nominatim /search endpoint + jsonv2 + encoded query + no addressdetails.
			const [url, init] = fetchMock.mock.calls[0];
			expect(String(url)).toContain(`${GEOCODER_BASE}/search?`);
			expect(String(url)).toContain("q=Brandenburger+Tor");
			expect(String(url)).toContain("format=jsonv2");
			expect(String(url)).toContain("addressdetails=0");
			// Nominatim's usage policy asks callers to identify themselves.
			const headers = (init as RequestInit).headers as Record<string, string>;
			expect(headers["user-agent"]).toBeTruthy();
		});

		it("falls back to `name` without display_name and omits confidence without importance", async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValue(
					jsonResponse([
						{ lat: "1.5", lon: "2.5", name: "Cafe", type: "cafe" },
					]),
				);
			const provider = createOrsProvider(
				{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: GEOCODER_BASE },
				{ fetch: fetchMock },
			);

			const outcome = await provider.geocode({ query: "cafe" });

			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.data.results).toEqual([
				{ name: "Cafe", lat: 1.5, lng: 2.5, type: "cafe" },
			]);
		});

		it("biases with viewbox + bounded=1 when `near` is provided", async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValue(
					jsonResponse([{ lat: "2", lon: "1", display_name: "Cafe" }]),
				);
			const provider = createOrsProvider(
				{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: GEOCODER_BASE },
				{ fetch: fetchMock },
			);

			await provider.geocode({ query: "cafe", near: { lat: 52.5, lng: 13.4 } });

			const [url] = fetchMock.mock.calls[0];
			const parsed = new URL(String(url));
			expect(parsed.searchParams.get("bounded")).toBe("1");
			const viewbox = parsed.searchParams
				.get("viewbox")
				?.split(",")
				.map(Number);
			expect(viewbox).toHaveLength(4);
			if (!viewbox) return;
			// viewbox = <minLon>,<minLat>,<maxLon>,<maxLat> straddling the near point.
			const [minLon, minLat, maxLon, maxLat] = viewbox;
			expect(minLon).toBeLessThan(13.4);
			expect(maxLon).toBeGreaterThan(13.4);
			expect(minLat).toBeLessThan(52.5);
			expect(maxLat).toBeGreaterThan(52.5);
		});

		it("returns geocoder_unconfigured (no fetch) when GEOCODER_BASE_URL is empty", async () => {
			const fetchMock = vi.fn();
			const provider = createOrsProvider(
				{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: "" },
				{ fetch: fetchMock },
			);

			const outcome = await provider.geocode({ query: "anywhere" });

			expect(outcome).toEqual({
				ok: false,
				reason: "geocoder_unconfigured",
				message: expect.any(String),
			});
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("returns not_found when Nominatim yields an empty array", async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
			const provider = createOrsProvider(
				{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: GEOCODER_BASE },
				{ fetch: fetchMock },
			);

			const outcome = await provider.geocode({ query: "nowhere-xyz" });

			expect(outcome).toMatchObject({ ok: false, reason: "not_found" });
		});

		it("maps a non-2xx geocoder response to a provider_error (never fabricated)", async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValue(new Response("boom", { status: 500 }));
			const provider = createOrsProvider(
				{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: GEOCODER_BASE },
				{ fetch: fetchMock },
			);

			const outcome = await provider.geocode({ query: "Berlin" });

			expect(outcome).toMatchObject({ ok: false, reason: "provider_error" });
		});
	});
});

describe("createOrsProvider — ORS error classification", () => {
	function orsError(code: number, message: string): Response {
		return jsonResponse({ error: { code, message } }, { status: 404 });
	}

	it("maps a 'point not found' (xx10) error to out_of_coverage, never provider_error", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				orsError(
					2010,
					"Could not find routable point within a radius of 2000.0 meters of specified coordinate 0: -6.2474000 53.4269000.",
				),
			);
		const provider = createOrsProvider(
			{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: GEOCODER_BASE },
			{ fetch: fetchMock },
		);
		const outcome = await provider.route({
			origin: { lat: 53.4269, lng: -6.2474 },
			destination: { lat: 53.42829, lng: -6.24278 },
			mode: "walk",
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe("out_of_coverage");
		expect(outcome.message).toContain("routable point");
	});

	it("maps a 'route could not be found' (xx09) error to no_route", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				orsError(
					2009,
					"Route could not be found - Unable to find a route between points 1 (19.04 47.49) and 2 (19.05 47.50).",
				),
			);
		const provider = createOrsProvider(
			{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: GEOCODER_BASE },
			{ fetch: fetchMock },
		);
		const outcome = await provider.route({
			origin: { lat: 47.49, lng: 19.04 },
			destination: { lat: 47.5, lng: 19.05 },
			mode: "drive",
		});
		expect(outcome).toMatchObject({ ok: false, reason: "no_route" });
	});

	it("classifies matrix (6xxx) and isochrone (3xxx) point-not-found codes the same way", async () => {
		const provider = createOrsProvider(
			{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: GEOCODER_BASE },
			{
				fetch: vi
					.fn()
					.mockResolvedValueOnce(orsError(6010, "Point not found"))
					.mockResolvedValueOnce(orsError(3010, "Point not found")),
			},
		);
		const matrix = await provider.matrix({
			origins: [{ lat: 1, lng: 2 }],
			destinations: [{ lat: 3, lng: 4 }],
			mode: "drive",
		});
		expect(matrix).toMatchObject({ ok: false, reason: "out_of_coverage" });
		const iso = await provider.isochrone({
			origin: { lat: 1, lng: 2 },
			mode: "drive",
			rangesS: [300],
		});
		expect(iso).toMatchObject({ ok: false, reason: "out_of_coverage" });
	});

	it("keeps other ORS error codes and non-JSON bodies as provider_error", async () => {
		const provider = createOrsProvider(
			{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: GEOCODER_BASE },
			{
				fetch: vi
					.fn()
					.mockResolvedValueOnce(orsError(2004, "Request exceeds limits"))
					.mockResolvedValueOnce(
						new Response("<html>502</html>", { status: 502 }),
					),
			},
		);
		const first = await provider.route({
			origin: { lat: 1, lng: 2 },
			destination: { lat: 3, lng: 4 },
			mode: "drive",
		});
		expect(first).toMatchObject({ ok: false, reason: "provider_error" });
		const second = await provider.route({
			origin: { lat: 1, lng: 2 },
			destination: { lat: 3, lng: 4 },
			mode: "drive",
		});
		expect(second).toMatchObject({ ok: false, reason: "provider_error" });
	});

	it("exposes the configured coverage label (trimmed) and empty when unset", () => {
		const withLabel = createOrsProvider(
			{ orsBaseUrl: ORS_BASE, coverageLabel: "  Hungary " },
			{ fetch: vi.fn() },
		);
		expect(withLabel.coverageLabel?.()).toBe("Hungary");
		const without = createOrsProvider(
			{ orsBaseUrl: ORS_BASE },
			{ fetch: vi.fn() },
		);
		expect(without.coverageLabel?.()).toBe("");
	});
});

// ── Public transport ───────────────────────────────────────────
//
// The fixture below is built field-by-field from openrouteservice v9.10.0's
// own response classes (see the header comment in ors-provider.ts for the
// exact files): JSONIndividualRouteResponse for routes[] (geometry, summary,
// departure, arrival, legs), JSONSummary for the PT-only `transfers`, JSONLeg
// for every leg field, and JSONPtStop for every stop field. Nothing here is
// invented — including `route_type: -1` on the walk legs, which is what
// RouteLeg's non-PT branch assigns.
function ptFixtureRoute(overrides: Record<string, unknown> = {}) {
	return {
		summary: { distance: 5231.4, duration: 1620.0, transfers: 1 },
		geometry: "whole_journey_polyline",
		departure: "2026-09-08T08:25:00+02:00",
		arrival: "2026-09-08T08:52:00+02:00",
		legs: [
			{
				type: "walk",
				route_type: -1,
				distance: 245.0,
				duration: 196.2,
				departure: "2026-09-08T08:25:00+02:00",
				arrival: "2026-09-08T08:28:16+02:00",
				geometry: "walk_leg_polyline",
				instructions: [{ distance: 245, duration: 196.2, instruction: "Walk" }],
			},
			{
				type: "pt",
				departure_location: "Dossenheim, Süd Bstg G1",
				trip_headsign: "Bismarckplatz",
				route_long_name: "RNV Bus 39A",
				route_short_name: "39A",
				route_desc: "Bus",
				route_type: 3,
				distance: 4786.4,
				duration: 1140.0,
				departure: "2026-09-08T08:31:00+02:00",
				arrival: "2026-09-08T08:50:00+02:00",
				feed_id: "gtfs_0",
				trip_id: "vrn-19-39A-1-2",
				route_id: "vrn-19-39A-1",
				is_in_same_vehicle_as_previous: false,
				geometry: "pt_leg_polyline",
				stops: [
					{
						stop_id: "de:08221:1138:0:O",
						name: "Dossenheim, Süd Bstg G1",
						location: [8.6912542, 49.399979],
						departure_time: "2026-09-08T06:31:00Z",
						planned_departure_time: "2026-09-08T06:31:00Z",
					},
					{
						stop_id: "de:08221:1140:0:O",
						name: "Heidelberg, Alois-Link-Platz",
						location: [8.69512, 49.41],
						arrival_time: "2026-09-08T06:50:00Z",
						planned_arrival_time: "2026-09-08T06:50:00Z",
					},
				],
			},
			{
				type: "walk",
				route_type: -1,
				distance: 200.0,
				duration: 120.0,
				departure: "2026-09-08T08:50:00+02:00",
				arrival: "2026-09-08T08:52:00+02:00",
				geometry: "egress_polyline",
				instructions: [{ distance: 200, duration: 120, instruction: "Walk" }],
			},
		],
		...overrides,
	};
}

describe("createOrsProvider — public transport", () => {
	it("posts to the public-transport profile with ORS's own parameter names", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ routes: [ptFixtureRoute()] }));
		const provider = createOrsProvider(
			{ orsBaseUrl: ORS_BASE },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		await provider.transit?.({
			origin: { lat: 49.4, lng: 8.69 },
			destination: { lat: 49.41, lng: 8.695 },
			departure: "2026-09-08T08:25:00",
			walkingTimeMinutes: 20,
		});
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(`${ORS_BASE}/v2/directions/public-transport`);
		expect(JSON.parse(init.body)).toEqual({
			// ORS speaks [lng, lat].
			coordinates: [
				[8.69, 49.4],
				[8.695, 49.41],
			],
			instructions: true,
			geometry: true,
			walking_time: "PT20M",
			ignore_transfers: false,
			departure: "2026-09-08T08:25:00",
		});
	});

	it("sends `arrival` instead of `departure` for an arrive-by query", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ routes: [ptFixtureRoute()] }));
		const provider = createOrsProvider(
			{ orsBaseUrl: ORS_BASE },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		await provider.transit?.({
			origin: { lat: 1, lng: 2 },
			destination: { lat: 3, lng: 4 },
			departure: "2026-09-08T08:00:00",
			arrival: "2026-09-08T09:00:00",
		});
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.arrival).toBe("2026-09-08T09:00:00");
		expect(body.departure).toBeUndefined();
		// The default walking budget is sent explicitly, matching ORS's PT15M.
		expect(body.walking_time).toBe("PT15M");
	});

	it("parses ORS's legs, stops and transfers into a typed itinerary", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ routes: [ptFixtureRoute()] }));
		const provider = createOrsProvider(
			{ orsBaseUrl: ORS_BASE },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		const outcome = await provider.transit?.({
			origin: { lat: 49.4, lng: 8.69 },
			destination: { lat: 49.41, lng: 8.695 },
		});
		expect(outcome?.ok).toBe(true);
		if (!outcome?.ok) return;
		expect(outcome.data.itineraries).toHaveLength(1);
		const itinerary = outcome.data.itineraries[0];
		expect(itinerary).toMatchObject({
			departure: "2026-09-08T08:25:00+02:00",
			arrival: "2026-09-08T08:52:00+02:00",
			duration_s: 1620,
			distance_m: 5231.4,
			transfers: 1,
			polyline: "whole_journey_polyline",
		});
		expect(itinerary.legs.map((leg) => leg.type)).toEqual([
			"walk",
			"pt",
			"walk",
		]);
		expect(itinerary.legs[1]).toMatchObject({
			type: "pt",
			from: "Dossenheim, Süd Bstg G1",
			to: "Heidelberg, Alois-Link-Platz",
			line: "39A",
			lineLong: "RNV Bus 39A",
			headsign: "Bismarckplatz",
			routeType: 3,
			stopsCount: 2,
			distance_m: 4786.4,
			duration_s: 1140,
			sameVehicleAsPrevious: false,
			polyline: "pt_leg_polyline",
		});
		// route_type -1 (ORS's walk marker) never leaks out as a real GTFS type,
		// and a walk leg carries no line identity.
		expect(itinerary.legs[0].routeType).toBeUndefined();
		expect(itinerary.legs[0].line).toBeUndefined();
		expect(itinerary.legs[0].stopsCount).toBeUndefined();
		expect(outcome.data.query).toMatchObject({ walkingTimeMinutes: 15 });
	});

	it("derives the transfer count from the pt legs when ORS suppressed it", async () => {
		// JSONSummary suppresses `transfers` when it is -1.
		const route = ptFixtureRoute({ summary: { distance: 100, duration: 200 } });
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ routes: [route] }));
		const provider = createOrsProvider(
			{ orsBaseUrl: ORS_BASE },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		const outcome = await provider.transit?.({
			origin: { lat: 1, lng: 2 },
			destination: { lat: 3, lng: 4 },
		});
		expect(outcome?.ok).toBe(true);
		if (!outcome?.ok) return;
		// One pt leg → zero transfers.
		expect(outcome.data.itineraries[0].transfers).toBe(0);
	});

	it("sends the schedule parameters and parses every returned departure", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				routes: [
					ptFixtureRoute(),
					ptFixtureRoute({
						departure: "2026-09-08T08:45:00+02:00",
						arrival: "2026-09-08T09:12:00+02:00",
					}),
				],
			}),
		);
		const provider = createOrsProvider(
			{ orsBaseUrl: ORS_BASE },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		const outcome = await provider.transitSchedule?.({
			origin: { lat: 1, lng: 2 },
			destination: { lat: 3, lng: 4 },
			departure: "2026-09-08T08:00:00",
			windowMinutes: 90,
			rows: 4,
		});
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body).toMatchObject({
			schedule: true,
			schedule_duration: "PT90M",
			schedule_rows: 4,
			departure: "2026-09-08T08:00:00",
		});
		expect(outcome?.ok).toBe(true);
		if (!outcome?.ok) return;
		expect(outcome.data.itineraries).toHaveLength(2);
		expect(outcome.data.itineraries[1].departure).toBe(
			"2026-09-08T08:45:00+02:00",
		);
		expect(outcome.data.query.schedule).toBe(true);
	});

	it("defaults the schedule window to two hours and six rows", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ routes: [ptFixtureRoute()] }));
		const provider = createOrsProvider(
			{ orsBaseUrl: ORS_BASE },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		await provider.transitSchedule?.({
			origin: { lat: 1, lng: 2 },
			destination: { lat: 3, lng: 4 },
		});
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.schedule_duration).toBe("PT120M");
		expect(body.schedule_rows).toBe(6);
	});

	it("reports transit_unavailable when the engine has no public-transport profile", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(
				{
					error: {
						code: 2003,
						message:
							"Unable to find an appropriate routing profile for 'public-transport'.",
					},
				},
				{ status: 404 },
			),
		);
		const provider = createOrsProvider(
			{ orsBaseUrl: ORS_BASE },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		const outcome = await provider.transit?.({
			origin: { lat: 1, lng: 2 },
			destination: { lat: 3, lng: 4 },
		});
		expect(outcome).toMatchObject({ ok: false, reason: "transit_unavailable" });
	});

	it("keeps a coverage miss distinct from a missing timetable graph", async () => {
		// ORS answers 404 for a point it cannot snap (code 2010) as well as for
		// an unknown profile, so the error CODE, not the status, has to decide.
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				jsonResponse(
					{ error: { code: 2010, message: "Could not find routable point" } },
					{ status: 404 },
				),
			);
		const provider = createOrsProvider(
			{ orsBaseUrl: ORS_BASE },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		const outcome = await provider.transit?.({
			origin: { lat: 1, lng: 2 },
			destination: { lat: 3, lng: 4 },
		});
		expect(outcome).toMatchObject({ ok: false, reason: "out_of_coverage" });
	});

	it("reports an unroutable pair as no_route, not as a missing timetable", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				jsonResponse(
					{ error: { code: 2009, message: "Route could not be found" } },
					{ status: 404 },
				),
			);
		const provider = createOrsProvider(
			{ orsBaseUrl: ORS_BASE },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		const outcome = await provider.transit?.({
			origin: { lat: 1, lng: 2 },
			destination: { lat: 3, lng: 4 },
		});
		expect(outcome).toMatchObject({ ok: false, reason: "no_route" });
	});

	it("treats a bare 404 with no ORS error body as a missing profile", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("Not Found", { status: 404 }));
		const provider = createOrsProvider(
			{ orsBaseUrl: ORS_BASE },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		const outcome = await provider.transit?.({
			origin: { lat: 1, lng: 2 },
			destination: { lat: 3, lng: 4 },
		});
		expect(outcome).toMatchObject({ ok: false, reason: "transit_unavailable" });
	});

	it("says no journey was found rather than inventing an empty itinerary", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ routes: [] }));
		const provider = createOrsProvider(
			{ orsBaseUrl: ORS_BASE },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		const outcome = await provider.transit?.({
			origin: { lat: 1, lng: 2 },
			destination: { lat: 3, lng: 4 },
		});
		expect(outcome).toMatchObject({ ok: false, reason: "no_route" });
	});

	it("degrades to unconfigured with no ORS base URL", async () => {
		const provider = createOrsProvider(
			{ orsBaseUrl: "" },
			{ fetch: vi.fn() as unknown as typeof fetch },
		);
		const outcome = await provider.transit?.({
			origin: { lat: 1, lng: 2 },
			destination: { lat: 3, lng: 4 },
		});
		expect(outcome).toMatchObject({ ok: false, reason: "unconfigured" });
	});
});
