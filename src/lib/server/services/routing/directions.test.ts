import { describe, expect, it } from "vitest";
import {
	buildRouteSteps,
	capSteps,
	MAX_CARD_STEPS,
	MAX_INSTRUCTION_CHARS,
	MAX_NARRATION_STEPS,
	maneuverFromOrsType,
	narrateSteps,
	routeVia,
} from "./directions";
import type { RouteData, RouteStep } from "./types";

function route(steps: RouteStep[]): RouteData {
	return {
		distance_m: 1000,
		duration_s: 600,
		legs: [{ distance_m: 1000, duration_s: 600, steps }],
		coords: {
			origin: { lat: 51.9, lng: -8.47 },
			destination: { lat: 51.7, lng: -8.52 },
		},
	};
}

describe("maneuverFromOrsType", () => {
	it("maps every ORS instruction code onto the card's vocabulary", () => {
		expect(maneuverFromOrsType(0)).toBe("left");
		expect(maneuverFromOrsType(1)).toBe("right");
		expect(maneuverFromOrsType(2)).toBe("sharp-left");
		expect(maneuverFromOrsType(3)).toBe("sharp-right");
		expect(maneuverFromOrsType(4)).toBe("slight-left");
		expect(maneuverFromOrsType(5)).toBe("slight-right");
		expect(maneuverFromOrsType(6)).toBe("straight");
		expect(maneuverFromOrsType(7)).toBe("roundabout");
		expect(maneuverFromOrsType(8)).toBe("exit-roundabout");
		expect(maneuverFromOrsType(9)).toBe("u-turn");
		expect(maneuverFromOrsType(10)).toBe("arrive");
		expect(maneuverFromOrsType(11)).toBe("depart");
		expect(maneuverFromOrsType(12)).toBe("keep-left");
		expect(maneuverFromOrsType(13)).toBe("keep-right");
	});

	it("falls back to `other` for an unknown or missing code", () => {
		expect(maneuverFromOrsType(99)).toBe("other");
		expect(maneuverFromOrsType(undefined)).toBe("other");
	});
});

describe("buildRouteSteps", () => {
	it("carries the instruction, manoeuvre, distance and way-point span", () => {
		const steps = buildRouteSteps(
			route([
				{
					distance_m: 350.4,
					duration_s: 60.2,
					instruction: "Head south on Grand Parade",
					name: "Grand Parade",
					type: 11,
					way_points: [0, 12],
				},
			]),
		);
		expect(steps).toEqual([
			{
				instruction: "Head south on Grand Parade",
				maneuver: "depart",
				distanceM: 350,
				durationS: 60,
				wayPointRange: [0, 12],
			},
		]);
	});

	it("keeps the road name as subtext only when the instruction omits it", () => {
		const steps = buildRouteSteps(
			route([
				{
					distance_m: 10,
					duration_s: 10,
					instruction: "Turn left",
					name: "R600",
					type: 0,
				},
			]),
		);
		expect(steps[0].name).toBe("R600");
	});

	it("drops ORS's unnamed-road placeholder and steps with no instruction", () => {
		const steps = buildRouteSteps(
			route([
				{ distance_m: 5, duration_s: 5, instruction: "Continue", name: "-" },
				{ distance_m: 5, duration_s: 5, name: "Something" },
			]),
		);
		expect(steps).toHaveLength(1);
		expect(steps[0].name).toBeUndefined();
	});

	it("trims a runaway instruction to the persisted ceiling", () => {
		const steps = buildRouteSteps(
			route([{ distance_m: 5, duration_s: 5, instruction: "x".repeat(400) }]),
		);
		expect(steps[0].instruction).toHaveLength(MAX_INSTRUCTION_CHARS);
		expect(steps[0].instruction.endsWith("…")).toBe(true);
	});
});

describe("capSteps", () => {
	it("keeps the arrival when a long route is trimmed", () => {
		const many = Array.from({ length: 120 }, (_, index) => ({
			instruction: `step ${index}`,
			maneuver: index === 119 ? ("arrive" as const) : ("straight" as const),
			distanceM: 100,
			durationS: 60,
		}));
		const capped = capSteps(many);
		expect(capped).toHaveLength(MAX_CARD_STEPS);
		expect(capped[capped.length - 1].maneuver).toBe("arrive");
		expect(capped[capped.length - 1].instruction).toBe("step 119");
	});

	it("leaves a short list alone", () => {
		const short = [
			{
				instruction: "go",
				maneuver: "straight" as const,
				distanceM: 1,
				durationS: 1,
			},
		];
		expect(capSteps(short)).toBe(short);
	});
});

describe("routeVia", () => {
	it("picks the road the route spends the most distance on", () => {
		const via = routeVia(
			route([
				{ distance_m: 600, duration_s: 60, instruction: "a", name: "N71" },
				{ distance_m: 17_000, duration_s: 900, instruction: "b", name: "R600" },
				{ distance_m: 300, duration_s: 30, instruction: "c", name: "-" },
			]),
		);
		expect(via).toBe("R600");
	});

	it("is undefined when no step names a road", () => {
		expect(
			routeVia(route([{ distance_m: 10, duration_s: 5, instruction: "go" }])),
		).toBeUndefined();
	});
});

describe("narrateSteps", () => {
	it("caps the model's copy and keeps the arrival", () => {
		const many = Array.from({ length: 40 }, (_, index) => ({
			instruction: `step ${index}`,
			maneuver: "straight" as const,
			distanceM: 1500,
			durationS: 60,
		}));
		const narrated = narrateSteps(many);
		expect(narrated).toHaveLength(MAX_NARRATION_STEPS);
		expect(narrated[narrated.length - 1].instruction).toBe("step 39");
		expect(narrated[0].distance).toBe("1.5 km");
	});
});
