import { describe, expect, it, vi } from "vitest";
import {
	BIKE_TO_TRANSIT_BUFFER_MINUTES,
	chainJourneyLegs,
	DEFAULT_TRANSFER_BUFFER_MINUTES,
	planJourney,
	type ResolvedJourneyLeg,
	shiftLocal,
	transferBufferMinutes,
} from "./journey";
import type { RoutingProvider } from "./types";

const CORK = { lat: 51.897, lng: -8.47 };
const STATION = { lat: 51.902, lng: -8.45 };
const DUBLIN = { lat: 53.346, lng: -6.294 };
const TRINITY = { lat: 53.344, lng: -6.259 };

function leg(
	mode: ResolvedJourneyLeg["mode"],
	from = CORK,
	to = STATION,
	labels: [string, string] = ["A", "B"],
): ResolvedJourneyLeg {
	return { mode, from, to, fromLabel: labels[0], toLabel: labels[1] };
}

// A provider that answers with fixed durations, so the planner's arithmetic
// (and only its arithmetic) is what the assertions see.
function fakeProvider(options?: {
	routeSeconds?: number;
	transit?: { departure: string; arrival: string; durationS?: number };
	transitFails?: boolean;
}): {
	provider: RoutingProvider;
	routeMock: ReturnType<typeof vi.fn>;
	transitMock: ReturnType<typeof vi.fn>;
} {
	const routeSeconds = options?.routeSeconds ?? 16 * 60;
	const routeMock = vi.fn(async () => ({
		ok: true as const,
		data: {
			distance_m: 4100,
			duration_s: routeSeconds,
			legs: [],
			polyline: "",
			coords: { origin: CORK, destination: STATION },
		},
	}));
	const transitMock = vi.fn(async () =>
		options?.transitFails
			? {
					ok: false as const,
					reason: "no_route" as const,
					message: "No public transport journey was found.",
				}
			: {
					ok: true as const,
					data: {
						itineraries: [
							{
								departure:
									options?.transit?.departure ?? "2026-09-09T07:45:00Z",
								arrival: options?.transit?.arrival ?? "2026-09-09T10:22:00Z",
								duration_s: options?.transit?.durationS ?? 157 * 60,
								distance_m: 250_000,
								transfers: 0,
								legs: [],
							},
						],
						coords: { origin: STATION, destination: DUBLIN },
						timezone: "UTC",
						query: {},
					},
				},
	);
	const provider = {
		routingConfigured: () => true,
		geocoderConfigured: () => true,
		geocode: vi.fn(),
		route: routeMock,
		matrix: vi.fn(),
		isochrone: vi.fn(),
		transit: transitMock,
	} as unknown as RoutingProvider;
	return { provider, routeMock, transitMock };
}

describe("chainJourneyLegs", () => {
	it("chains consecutive legs so one leg's end opens the next", () => {
		const chained = chainJourneyLegs(
			[
				{ mode: "bike", to: "Cork Kent station" },
				{ mode: "transit", to: "Dublin Heuston" },
				{ mode: "walk" },
			],
			"Blackrock, Cork",
			"Trinity College Dublin",
		);
		expect(chained.ok).toBe(true);
		if (!chained.ok) return;
		expect(chained.legs).toEqual([
			{ mode: "bike", from: "Blackrock, Cork", to: "Cork Kent station" },
			{ mode: "transit", from: "Cork Kent station", to: "Dublin Heuston" },
			{ mode: "walk", from: "Dublin Heuston", to: "Trinity College Dublin" },
		]);
	});

	it("fills a missing end from the next leg's start", () => {
		const chained = chainJourneyLegs(
			[{ mode: "walk" }, { mode: "transit", from: "Kent station" }],
			"Home",
			"Heuston",
		);
		expect(chained.ok).toBe(true);
		if (!chained.ok) return;
		expect(chained.legs[0]).toEqual({
			mode: "walk",
			from: "Home",
			to: "Kent station",
		});
	});

	it("refuses a journey with no legs rather than inventing one", () => {
		expect(chainJourneyLegs([], "A", "B")).toEqual({
			ok: false,
			message: expect.stringContaining("at least one leg"),
		});
	});
});

describe("transferBufferMinutes", () => {
	it("allows longer when a bike leg ends at a service", () => {
		expect(transferBufferMinutes("bike", "transit")).toBe(
			BIKE_TO_TRANSIT_BUFFER_MINUTES,
		);
		expect(transferBufferMinutes("walk", "transit")).toBe(
			DEFAULT_TRANSFER_BUFFER_MINUTES,
		);
		expect(transferBufferMinutes("bike", "walk")).toBe(
			DEFAULT_TRANSFER_BUFFER_MINUTES,
		);
	});
});

describe("shiftLocal", () => {
	it("moves a local date-time by whole minutes, crossing midnight", () => {
		expect(shiftLocal("2026-09-09T07:22:00", 38)).toBe("2026-09-09T08:00:00");
		expect(shiftLocal("2026-09-09T00:05:00", -10)).toBe("2026-09-08T23:55:00");
	});
});

describe("planJourney — forwards", () => {
	it("chains the legs in order, leaving a transfer buffer between them", async () => {
		const { provider, transitMock } = fakeProvider({ routeSeconds: 16 * 60 });
		const outcome = await planJourney(
			{
				legs: [leg("bike"), leg("transit", STATION, DUBLIN)],
				departure: "2026-09-09T07:00:00",
			},
			{ provider },
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.plan.legs[0].departure).toBe("2026-09-09T07:00:00");
		expect(outcome.plan.legs[0].arrival).toBe("2026-09-09T07:16:00");
		// The bike leg ends at a service, so the next search starts 7 minutes
		// after it lands rather than the ordinary 5.
		expect(transitMock).toHaveBeenCalledWith(
			expect.objectContaining({ departure: "2026-09-09T07:23:00" }),
		);
		expect(outcome.plan.departure).toBe("2026-09-09T07:00:00");
		expect(outcome.plan.arrival).toBe("2026-09-09T10:22:00");
		expect(outcome.plan.plannedBackwards).toBe(false);
	});
});

describe("planJourney — backwards from an arrive-by time", () => {
	it("plans the last leg against the deadline and walks backwards", async () => {
		const { provider, routeMock, transitMock } = fakeProvider({
			routeSeconds: 8 * 60,
			transit: {
				departure: "2026-09-09T07:45:00Z",
				arrival: "2026-09-09T10:22:00Z",
			},
		});
		const outcome = await planJourney(
			{
				legs: [
					leg("bike", CORK, STATION),
					leg("transit", STATION, DUBLIN),
					leg("walk", DUBLIN, TRINITY),
				],
				arriveBy: "2026-09-09T11:00:00",
			},
			{ provider },
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		// Last leg first: the walk lands exactly on the deadline.
		const walk = outcome.plan.legs[2];
		expect(walk.arrival).toBe("2026-09-09T11:00:00");
		expect(walk.departure).toBe("2026-09-09T10:52:00");

		// The transit search is then given "arrive by the walk's departure,
		// minus the ordinary transfer buffer".
		expect(transitMock).toHaveBeenCalledWith(
			expect.objectContaining({ arrival: "2026-09-09T10:47:00" }),
		);

		// And the bike leg has to be in 7 minutes before the train leaves.
		const bike = outcome.plan.legs[0];
		expect(bike.arrival).toBe("2026-09-09T07:38:00");
		expect(bike.departure).toBe("2026-09-09T07:30:00");
		expect(outcome.plan.departure).toBe("2026-09-09T07:30:00");
		expect(outcome.plan.plannedBackwards).toBe(true);
		expect(routeMock).toHaveBeenCalledTimes(2);
	});

	it("names the leg that could not be planned instead of dropping it", async () => {
		const { provider } = fakeProvider({ transitFails: true });
		const outcome = await planJourney(
			{
				legs: [leg("bike"), leg("transit", STATION, DUBLIN)],
				arriveBy: "2026-09-09T11:00:00",
			},
			{ provider },
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.message).toContain("Leg 2 (transit");
		expect(outcome.message).toContain("No public transport journey");
	});

	it("refuses a transit leg when the provider has no timetables at all", async () => {
		const { provider } = fakeProvider();
		const withoutTransit = {
			...provider,
			transit: undefined,
		} as RoutingProvider;
		const outcome = await planJourney(
			{ legs: [leg("transit", STATION, DUBLIN)] },
			{ provider: withoutTransit },
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.message).toContain("not available on this server");
	});
});
