import { fireEvent, render } from "@testing-library/svelte";
import { beforeEach, describe, expect, it } from "vitest";
import type {
	ToolCallMapData,
	ToolCallMapStep,
} from "$lib/server/services/messages-types";
import { uiLanguage } from "$lib/stores/settings";
import RouteItinerary from "./RouteItinerary.svelte";
import {
	glyphForVehicle,
	itineraryLineColor,
	maneuverGlyph,
} from "./route-itinerary-helpers";

function step(
	instruction: string,
	overrides: Partial<ToolCallMapStep> = {},
): ToolCallMapStep {
	return {
		instruction,
		maneuver: "straight",
		distanceM: 600,
		durationS: 120,
		...overrides,
	};
}

function card(overrides: Partial<ToolCallMapData> = {}): ToolCallMapData {
	return {
		bounds: { minLat: 51.7, minLng: -8.6, maxLat: 51.9, maxLng: -8.4 },
		attribution: "© OpenStreetMap contributors",
		...overrides,
	};
}

describe("RouteItinerary — road directions", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	const drive = card({
		mode: "drive",
		distanceM: 27_000,
		durationS: 2040,
		via: "R600",
		originLabel: "Cork",
		destinationLabel: "Kinsale",
		polyline: Array.from({ length: 20 }, (_, index): [number, number] => [
			51.9 - index * 0.01,
			-8.47,
		]),
		steps: [
			...Array.from({ length: 13 }, (_, index) =>
				step(`Step ${index + 1}`, { wayPointRange: [index, index + 1] }),
			),
			step("Arrive at Kinsale, Market Square", {
				maneuver: "arrive",
				distanceM: 0,
			}),
		],
	});

	it("prints the summary line and the mode strip with the route's mode filled", () => {
		const { getByTestId, container } = render(RouteItinerary, { map: drive });
		expect(getByTestId("itinerary-head").textContent).toContain("27.0 km");
		expect(getByTestId("itinerary-head").textContent).toContain("34 min");
		expect(container.textContent).toContain("via R600");
		const car = container.querySelector("[data-mode='car']");
		expect(car?.getAttribute("data-active")).toBe("true");
		expect(
			container
				.querySelector("[data-mode='bike']")
				?.getAttribute("data-active"),
		).toBe("false");
	});

	it("shows the first seven manoeuvres and reveals the rest on demand", async () => {
		const { getAllByTestId, getByTestId } = render(RouteItinerary, {
			map: drive,
		});
		expect(getAllByTestId("itinerary-step")).toHaveLength(7);
		const toggle = getByTestId("itinerary-show-all");
		expect(toggle.textContent).toContain("Show all 14 steps");
		await fireEvent.click(toggle);
		expect(getAllByTestId("itinerary-step")).toHaveLength(14);
		expect(getByTestId("itinerary-show-all").textContent).toContain(
			"Show fewer",
		);
	});

	it("carries a walking route's climb into the summary", () => {
		const { container } = render(RouteItinerary, {
			map: card({
				mode: "walk",
				distanceM: 2600,
				durationS: 1980,
				ascentM: 45,
			}),
		});
		expect(container.textContent).toContain("45 m climb");
		expect(
			container
				.querySelector("[data-mode='walk']")
				?.getAttribute("data-active"),
		).toBe("true");
	});
});

describe("RouteItinerary — transit timeline", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	const transit = card({
		mode: "transit",
		durationS: 11_460,
		transfers: 2,
		departAt: "07:05",
		arriveAt: "10:16",
		departDate: "2026-09-09",
		originLabel: "Budapest Keleti",
		destinationLabel: "Debrecen, Egyetem tér",
		transitLegs: [
			{
				type: "pt",
				line: "IC 75",
				vehicle: "train",
				headsign: "Miskolc",
				from: "Budapest-Keleti",
				to: "Füzesabony",
				depart: "07:05",
				arrive: "08:27",
				stops: 8,
				minutes: 82,
				platform: "6",
			},
			{
				type: "walk",
				from: "Füzesabony",
				to: "Füzesabony",
				depart: "08:27",
				arrive: "08:36",
				minutes: 9,
			},
			{
				type: "pt",
				line: "IC 51",
				vehicle: "train",
				from: "Füzesabony",
				to: "Debrecen",
				depart: "08:36",
				arrive: "09:55",
				stops: 4,
				minutes: 79,
			},
		],
		departures: [
			{ depart: "07:35", arrive: "10:46", minutes: 191, transfers: 2 },
		],
	});

	it("draws a row per leg plus the arrival, with line, platform and stops", () => {
		const { getAllByTestId, getByTestId } = render(RouteItinerary, {
			map: transit,
		});
		const rows = getAllByTestId("itinerary-leg");
		expect(rows).toHaveLength(4);
		const text = getByTestId("itinerary-timeline").textContent ?? "";
		expect(text).toContain("IC 75");
		expect(text).toContain("toward Miskolc");
		expect(text).toContain("platform 6");
		expect(text).toContain("8 stops");
		// A walk between two services with no ground to cover is a change.
		expect(text).toContain("Change");
		// The last row closes the journey at the destination.
		expect(rows[3].dataset.kind).toBe("last");
		expect(rows[3].textContent).toContain("Debrecen");
	});

	it("prints the clock span, the changes and the date in the summary", () => {
		const { getByTestId, container } = render(RouteItinerary, { map: transit });
		expect(getByTestId("itinerary-head").textContent).toContain(
			"07:05 → 10:16",
		);
		expect(container.textContent).toContain("2 changes");
		expect(container.textContent).toContain("Sep");
	});

	it("lists the alternative departures under the timeline", () => {
		const { getAllByTestId } = render(RouteItinerary, { map: transit });
		const alternatives = getAllByTestId("itinerary-departure");
		expect(alternatives).toHaveLength(1);
		expect(alternatives[0].textContent).toContain("07:35");
		expect(alternatives[0].textContent).toContain("2 changes");
	});
});

describe("RouteItinerary — mixed-mode journey", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	const journey = card({
		mode: "journey",
		durationS: 12_720,
		transfers: 0,
		departAt: "07:22",
		arriveAt: "10:54",
		arriveBy: "11:00",
		transitLegs: [
			{
				type: "bike",
				from: "Blackrock, Cork",
				to: "Cork Kent station",
				depart: "07:22",
				arrive: "07:38",
				minutes: 16,
				distanceM: 4100,
				steps: [step("Follow the Blackrock greenway north-west")],
			},
			{
				type: "pt",
				line: "IC",
				vehicle: "train",
				from: "Cork Kent",
				to: "Dublin Heuston",
				depart: "07:45",
				arrive: "10:22",
				minutes: 157,
			},
			{
				type: "walk",
				from: "Dublin Heuston",
				to: "Trinity College",
				depart: "10:44",
				arrive: "10:54",
				minutes: 10,
				distanceM: 650,
			},
		],
	});

	it("fills every mode it uses in the strip", () => {
		const { container } = render(RouteItinerary, { map: journey });
		for (const mode of ["bike", "walk", "transit"]) {
			expect(
				container
					.querySelector(`[data-mode='${mode}']`)
					?.getAttribute("data-active"),
			).toBe("true");
		}
		expect(
			container.querySelector("[data-mode='car']")?.getAttribute("data-active"),
		).toBe("false");
	});

	it("reads as one timeline and prints the self-powered leg's directions below it", () => {
		const { getAllByTestId, container } = render(RouteItinerary, {
			map: journey,
		});
		// Three legs, the arrival, and a row for the wait at the station —
		// without it the timeline would jump from 07:22 to 07:45 and lose the
		// moment the bike ride actually ends.
		const rows = getAllByTestId("itinerary-leg");
		expect(rows).toHaveLength(5);
		expect(rows[1].textContent).toContain("07:38");
		expect(rows[1].textContent).toContain("Change · 7 min");
		expect(container.textContent).toContain("Leave 07:22 → arrive 10:54");
		expect(container.textContent).toContain("arrive by 11:00");
		expect(container.textContent).toContain("Cycling directions");
		expect(getAllByTestId("itinerary-step")[0].textContent).toContain(
			"greenway",
		);
	});
});

describe("RouteItinerary — map highlighting", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	it("localizes the body with the UI language", () => {
		uiLanguage.set("hu");
		try {
			const { container } = render(RouteItinerary, {
				map: card({
					mode: "drive",
					distanceM: 1000,
					durationS: 600,
					steps: [step("Menj észak felé")],
				}),
			});
			expect(container.textContent).toContain("Útbaigazítás");
		} finally {
			uiLanguage.set("en");
		}
	});
});

describe("itineraryLineColor", () => {
	it("prefers the feed's own colour when it publishes one", () => {
		expect(itineraryLineColor("train", "IC 75", "1f4e9c")).toBe("#1f4e9c");
		expect(itineraryLineColor("train", "IC 75", "#1F4E9C")).toBe("#1F4E9C");
	});

	it("ignores a malformed feed colour rather than emitting broken CSS", () => {
		const derived = itineraryLineColor("train", "IC 75", "not-a-colour");
		expect(derived).toMatch(/^#[0-9a-f]{6}$/);
	});

	it("is deterministic per line and family", () => {
		expect(itineraryLineColor("tram", "1")).toBe(
			itineraryLineColor("tram", "1"),
		);
		expect(itineraryLineColor("bike", undefined)).toBe("#15803d");
	});
});

describe("glyphForVehicle / maneuverGlyph", () => {
	it("maps GTFS vehicle words onto the card's icon set", () => {
		expect(glyphForVehicle("tram")).toBe("tram");
		expect(glyphForVehicle("bus")).toBe("bus");
		expect(glyphForVehicle("coach")).toBe("bus");
		expect(glyphForVehicle("ferry")).toBe("ferry");
		// Anything rail-shaped, and anything unknown, gets the train glyph.
		expect(glyphForVehicle("funicular")).toBe("train");
		expect(glyphForVehicle(undefined)).toBe("train");
	});

	it("folds the manoeuvre vocabulary onto five arrows", () => {
		expect(maneuverGlyph("sharp-left")).toBe("left");
		expect(maneuverGlyph("keep-right")).toBe("right");
		expect(maneuverGlyph("exit-roundabout")).toBe("roundabout");
		expect(maneuverGlyph("arrive")).toBe("flag");
		expect(maneuverGlyph("depart")).toBe("straight");
		expect(maneuverGlyph("other")).toBe("straight");
	});
});
