import { describe, expect, it, vi } from "vitest";

import type {
	EnsureRegionOutcome,
	RoutingRegionManager,
} from "./region-manager";
import {
	createRegionalRoutingProvider,
	regionOutcomeToFailure,
} from "./regional-provider";
import type { RoutingProvider } from "./types";

function fakeRegionRow(
	id: string,
	name: string,
	transit: { transitStatus?: string; timezone?: string | null } = {},
) {
	return {
		id,
		name,
		slug: id,
		pbfUrl: `https://example.invalid/${id}.osm.pbf`,
		status: "ready",
		managed: true,
		baseUrl: `http://127.0.0.1:8300/ors`,
		hostPort: 8300,
		containerName: `alfyai-ors-${id}`,
		pbfSizeBytes: 1,
		geocoderStatus: "none",
		extractSource: null,
		attempts: 0,
		nextAttemptAt: null,
		resident: false,
		gtfsUrl: null,
		gtfsFeeds: null,
		transitBuiltAt: null,
		gtfsSizeBytes: null,
		gtfsDownloadedAt: null,
		transitStatus: transit.transitStatus ?? "none",
		timezone: transit.timezone ?? null,
		error: null,
		requestedBy: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
		lastUsedAt: null,
		readyAt: null,
	};
}

function fakeProvider(label: string): RoutingProvider & {
	label: string;
	transit: ReturnType<typeof vi.fn>;
	transitSchedule: ReturnType<typeof vi.fn>;
} {
	return {
		label,
		routingConfigured: () => true,
		geocoderConfigured: () => true,
		geocode: vi.fn().mockResolvedValue({ ok: true, data: { results: [] } }),
		route: vi.fn().mockResolvedValue({
			ok: true,
			data: {
				distance_m: 1,
				duration_s: 1,
				legs: [],
				coords: { origin: { lat: 0, lng: 0 }, destination: { lat: 1, lng: 1 } },
			},
		}),
		matrix: vi.fn().mockResolvedValue({
			ok: true,
			data: { durations_s: [], distances_m: [] },
		}),
		isochrone: vi.fn().mockResolvedValue({
			ok: true,
			data: { origin: { lat: 0, lng: 0 }, polygons: [] },
		}),
		transit: vi.fn().mockResolvedValue({
			ok: true,
			data: {
				itineraries: [
					{ duration_s: 600, distance_m: 1000, transfers: 0, legs: [] },
				],
				coords: {
					origin: { lat: 0, lng: 0 },
					destination: { lat: 1, lng: 1 },
				},
				query: {},
			},
		}),
		transitSchedule: vi.fn().mockResolvedValue({
			ok: true,
			data: {
				itineraries: [],
				coords: {
					origin: { lat: 0, lng: 0 },
					destination: { lat: 1, lng: 1 },
				},
				query: { schedule: true },
			},
		}),
	};
}

function fakeManager(outcome: EnsureRegionOutcome): RoutingRegionManager & {
	ensure: ReturnType<typeof vi.fn>;
} {
	const ensure = vi.fn().mockResolvedValue(outcome);
	return {
		ensure,
		ensureRegionForPoints: ensure,
		listRegions: vi.fn().mockResolvedValue([]),
		listReadyRegions: vi.fn().mockResolvedValue([]),
		listTransitReadyRegions: vi.fn().mockResolvedValue([]),
		refreshTransit: vi.fn(),
		retryTransitFeed: vi.fn(),
		describeTransitFeeds: vi.fn().mockReturnValue([]),
		runTransitMaintenance: vi.fn().mockResolvedValue([]),
		requestRegion: vi.fn(),
		retryRegion: vi.fn(),
		setResident: vi.fn(),
		removeRegion: vi.fn(),
		runIdleSweep: vi.fn(),
		resumePendingJobs: vi.fn(),
		kickJobs: vi.fn(),
		drain: vi.fn(),
	};
}

describe("regionOutcomeToFailure", () => {
	it("maps each non-ready outcome to an honest reason", () => {
		const row = fakeRegionRow(
			"ireland-and-northern-ireland",
			"Ireland and Northern Ireland",
		);
		expect(
			regionOutcomeToFailure({ kind: "ready", region: row, baseUrl: "x" }),
		).toBeNull();
		expect(
			regionOutcomeToFailure({
				kind: "preparing",
				region: row,
				status: "building",
			}),
		).toMatchObject({ reason: "region_preparing" });
		expect(
			regionOutcomeToFailure({
				kind: "preparing",
				region: row,
				status: "building",
			})?.message,
		).toContain("Ireland and Northern Ireland");
		expect(
			regionOutcomeToFailure({
				kind: "multi_region",
				regions: ["Hungary", "Austria"],
			}),
		).toMatchObject({ reason: "multi_region" });
		expect(regionOutcomeToFailure({ kind: "unknown_region" })).toMatchObject({
			reason: "out_of_coverage",
		});
		expect(
			regionOutcomeToFailure({
				kind: "too_large",
				regions: ["Germany"],
				maxPbfBytes: 1048576,
			}),
		).toMatchObject({ reason: "region_unavailable" });
		expect(
			regionOutcomeToFailure({ kind: "error", region: row, message: "boom" })
				?.message,
		).toContain("boom");
	});
});

describe("createRegionalRoutingProvider", () => {
	it("routes through the provider bound to the region's base URL when ready", async () => {
		const row = fakeRegionRow("hungary", "Hungary");
		const manager = fakeManager({
			kind: "ready",
			region: row,
			baseUrl: "http://127.0.0.1:8088/ors",
		});
		const created: string[] = [];
		const regionProvider = fakeProvider("region");
		const provider = createRegionalRoutingProvider({
			manager,
			onDemandEnabled: true,
			readyRegionNames: ["Hungary"],
			geocoder: fakeProvider("geocoder"),
			createProvider: (baseUrl) => {
				created.push(baseUrl);
				return regionProvider;
			},
		});
		const outcome = await provider.route({
			origin: { lat: 47.5, lng: 19.04 },
			destination: { lat: 47.51, lng: 19.05 },
			waypoints: [{ lat: 47.505, lng: 19.045 }],
			mode: "drive",
		});
		expect(outcome.ok).toBe(true);
		expect(created).toEqual(["http://127.0.0.1:8088/ors"]);
		// origin, waypoint, destination all go into the region resolution.
		expect(manager.ensure.mock.calls[0][0]).toHaveLength(3);
		expect(regionProvider.route).toHaveBeenCalledTimes(1);
	});

	it("returns region_preparing without calling any ORS when the region is building", async () => {
		const row = fakeRegionRow(
			"ireland-and-northern-ireland",
			"Ireland and Northern Ireland",
		);
		const manager = fakeManager({
			kind: "preparing",
			region: row,
			status: "downloading",
		});
		const createProvider = vi.fn();
		const provider = createRegionalRoutingProvider({
			manager,
			onDemandEnabled: true,
			geocoder: fakeProvider("geocoder"),
			createProvider,
		});
		const outcome = await provider.matrix({
			origins: [{ lat: 53.4, lng: -6.2 }],
			destinations: [{ lat: 53.3, lng: -6.3 }],
			mode: "walk",
		});
		expect(outcome).toMatchObject({ ok: false, reason: "region_preparing" });
		expect(createProvider).not.toHaveBeenCalled();
	});

	describe("public transport", () => {
		const BUDAPEST = { lat: 47.4979, lng: 19.0402 };
		const DEBRECEN = { lat: 47.53, lng: 21.63 };
		// 2026-07-01T10:00:00Z — Budapest is UTC+2 in July.
		const NOW = new Date("2026-07-01T10:00:00Z").getTime();

		function transitProvider(row: ReturnType<typeof fakeRegionRow>) {
			const regionProvider = fakeProvider("region");
			const provider = createRegionalRoutingProvider({
				manager: fakeManager({
					kind: "ready",
					region: row,
					baseUrl: "http://127.0.0.1:8300/ors",
				}),
				onDemandEnabled: true,
				readyRegionNames: ["Hungary"],
				transitRegionNames: ["Hungary"],
				geocoder: fakeProvider("geocoder"),
				createProvider: () => regionProvider,
				now: () => NOW,
			});
			return { provider, regionProvider };
		}

		it("defaults the departure to NOW in the region's timezone", async () => {
			const row = fakeRegionRow("hungary", "Hungary", {
				transitStatus: "ready",
				timezone: "Europe/Budapest",
			});
			const { provider, regionProvider } = transitProvider(row);
			const outcome = await provider.transit?.({
				origin: BUDAPEST,
				destination: DEBRECEN,
			});
			expect(outcome?.ok).toBe(true);
			expect(regionProvider.transit).toHaveBeenCalledWith(
				expect.objectContaining({ departure: "2026-07-01T12:00:00" }),
			);
			// The region's timezone rides back out so callers can print clocks.
			if (outcome?.ok) expect(outcome.data.timezone).toBe("Europe/Budapest");
		});

		it("normalizes a bare clock time onto the region's today", async () => {
			const row = fakeRegionRow("hungary", "Hungary", {
				transitStatus: "ready",
				timezone: "Europe/Budapest",
			});
			const { provider, regionProvider } = transitProvider(row);
			await provider.transit?.({
				origin: BUDAPEST,
				destination: DEBRECEN,
				departure: "07:45",
			});
			expect(regionProvider.transit).toHaveBeenCalledWith(
				expect.objectContaining({ departure: "2026-07-01T07:45:00" }),
			);
		});

		it("sends only `arrival` for an arrive-by query", async () => {
			const row = fakeRegionRow("hungary", "Hungary", {
				transitStatus: "ready",
				timezone: "Europe/Budapest",
			});
			const { provider, regionProvider } = transitProvider(row);
			await provider.transit?.({
				origin: BUDAPEST,
				destination: DEBRECEN,
				departure: "07:45",
				arrival: "09:30",
			});
			const call = regionProvider.transit.mock.calls[0][0];
			expect(call.arrival).toBe("2026-07-01T09:30:00");
			expect(call.departure).toBeUndefined();
		});

		it("refuses a transit query for a region whose timetable graph is not ready", async () => {
			for (const [status, phrase] of [
				["none", "No public transport timetable is loaded"],
				["building", "still being built"],
				["queued", "still being built"],
				["error", "could not be built"],
			] as const) {
				const row = fakeRegionRow("hungary", "Hungary", {
					transitStatus: status,
				});
				const { provider, regionProvider } = transitProvider(row);
				const outcome = await provider.transit?.({
					origin: BUDAPEST,
					destination: DEBRECEN,
				});
				expect(outcome).toMatchObject({
					ok: false,
					reason: "transit_unavailable",
				});
				expect(outcome?.ok === false && outcome.message).toContain(phrase);
				// The per-region ORS is never called for a region with no PT graph.
				expect(regionProvider.transit).not.toHaveBeenCalled();
			}
		});

		it("passes the schedule window through and names the timetable coverage", async () => {
			const row = fakeRegionRow("hungary", "Hungary", {
				transitStatus: "ready",
				timezone: "Europe/Budapest",
			});
			const { provider, regionProvider } = transitProvider(row);
			await provider.transitSchedule?.({
				origin: BUDAPEST,
				destination: DEBRECEN,
				windowMinutes: 90,
				rows: 3,
			});
			expect(regionProvider.transitSchedule).toHaveBeenCalledWith(
				expect.objectContaining({ windowMinutes: 90, rows: 3 }),
			);
			expect(provider.transitCoverageLabel?.()).toBe("Hungary");
		});

		it("still reports region_preparing when the ROAD graph is not ready", async () => {
			const row = fakeRegionRow("hungary", "Hungary", {
				transitStatus: "ready",
			});
			const provider = createRegionalRoutingProvider({
				manager: fakeManager({
					kind: "preparing",
					region: row,
					status: "building",
				}),
				onDemandEnabled: true,
				geocoder: fakeProvider("geocoder"),
				createProvider: () => fakeProvider("region"),
			});
			const outcome = await provider.transit?.({
				origin: BUDAPEST,
				destination: DEBRECEN,
			});
			expect(outcome).toMatchObject({ ok: false, reason: "region_preparing" });
		});
	});

	it("delegates geocoding to the shared geocoder and describes coverage", async () => {
		const geocoder = fakeProvider("geocoder");
		const provider = createRegionalRoutingProvider({
			manager: fakeManager({ kind: "unknown_region" }),
			onDemandEnabled: true,
			readyRegionNames: ["Hungary", "Ireland and Northern Ireland"],
			geocoder,
			createProvider: () => fakeProvider("region"),
		});
		await provider.geocode({ query: "Budapest" });
		expect(geocoder.geocode).toHaveBeenCalled();
		expect(provider.coverageLabel?.()).toContain(
			"Hungary, Ireland and Northern Ireland",
		);
		expect(provider.coverageLabel?.()).toContain("on demand");
		expect(provider.routingConfigured()).toBe(true);
		const iso = await provider.isochrone({
			origin: { lat: 30, lng: -40 },
			mode: "drive",
			rangesS: [300],
		});
		expect(iso).toMatchObject({ ok: false, reason: "out_of_coverage" });
	});
});
