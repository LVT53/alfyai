import { describe, expect, it, vi } from "vitest";

import { createOrsProvider } from "./ors-provider";

function jsonResponse(body: unknown, init?: { status?: number }): Response {
	return new Response(JSON.stringify(body), {
		status: init?.status ?? 200,
		headers: { "content-type": "application/json" },
	});
}

const ORS_BASE = "http://ors.local/ors";
const GEOCODER_BASE = "http://photon.local";

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

	describe("geocode (Photon)", () => {
		it("maps Photon GeoJSON features into geocode matches with lat/lng from [lng,lat]", async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				jsonResponse({
					features: [
						{
							geometry: { coordinates: [13.377, 52.516] },
							properties: {
								name: "Brandenburg Gate",
								city: "Berlin",
								country: "Germany",
								type: "attraction",
							},
						},
					],
				}),
			);
			const provider = createOrsProvider(
				{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: GEOCODER_BASE },
				{ fetch: fetchMock },
			);

			const outcome = await provider.geocode({ query: "Brandenburg Gate" });

			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.data.results).toEqual([
				{
					name: "Brandenburg Gate, Berlin, Germany",
					lat: 52.516,
					lng: 13.377,
					type: "attraction",
				},
			]);

			const [url] = fetchMock.mock.calls[0];
			expect(String(url)).toContain(`${GEOCODER_BASE}/api?`);
			expect(String(url)).toContain("q=Brandenburg+Gate");
		});

		it("passes a `near` bias as lat/lon query params", async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				jsonResponse({
					features: [
						{
							geometry: { coordinates: [1, 2] },
							properties: { name: "Cafe" },
						},
					],
				}),
			);
			const provider = createOrsProvider(
				{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: GEOCODER_BASE },
				{ fetch: fetchMock },
			);

			await provider.geocode({
				query: "cafe",
				near: { lat: 52.5, lng: 13.4 },
			});

			const [url] = fetchMock.mock.calls[0];
			expect(String(url)).toContain("lat=52.5");
			expect(String(url)).toContain("lon=13.4");
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

		it("returns not_found when the geocoder yields no features", async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValue(jsonResponse({ features: [] }));
			const provider = createOrsProvider(
				{ orsBaseUrl: ORS_BASE, geocoderBaseUrl: GEOCODER_BASE },
				{ fetch: fetchMock },
			);

			const outcome = await provider.geocode({ query: "nowhere-xyz" });

			expect(outcome).toMatchObject({ ok: false, reason: "not_found" });
		});
	});
});
