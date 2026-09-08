import { describe, expect, it } from "vitest";
import {
	buildRouteMapCardData,
	buildTransitMapCardData,
	computeBounds,
	decodePolyline,
	downsamplePath,
	MAP_CARD_MAX_BYTES,
	simplifyPath,
} from "./map-card";
import type { RouteData } from "./types";

describe("decodePolyline", () => {
	it("decodes the canonical Google polyline algorithm example", () => {
		// https://developers.google.com/maps/documentation/utilities/polylinealgorithm
		const decoded = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
		expect(decoded).toHaveLength(3);
		expect(decoded[0][0]).toBeCloseTo(38.5, 5);
		expect(decoded[0][1]).toBeCloseTo(-120.2, 5);
		expect(decoded[1][0]).toBeCloseTo(40.7, 5);
		expect(decoded[1][1]).toBeCloseTo(-120.95, 5);
		expect(decoded[2][0]).toBeCloseTo(43.252, 5);
		expect(decoded[2][1]).toBeCloseTo(-126.453, 5);
	});

	it("returns an empty array for an empty string", () => {
		expect(decodePolyline("")).toEqual([]);
	});

	it("never throws on garbage input", () => {
		expect(() => decodePolyline("not a polyline!!! \u0000")).not.toThrow();
	});
});

describe("simplifyPath", () => {
	it("keeps every point when tolerance is 0", () => {
		const points: [number, number][] = [
			[0, 0],
			[0, 1],
			[0, 2],
		];
		expect(simplifyPath(points, 0)).toEqual(points);
	});

	it("drops a near-collinear midpoint at a coarse tolerance", () => {
		const points: [number, number][] = [
			[0, 0],
			[0.0001, 1], // tiny deviation off the straight line
			[0, 2],
		];
		const simplified = simplifyPath(points, 0.01);
		expect(simplified).toEqual([
			[0, 0],
			[0, 2],
		]);
	});

	it("keeps a genuine corner regardless of tolerance direction", () => {
		const points: [number, number][] = [
			[0, 0],
			[1, 0],
			[1, 1],
		];
		const simplified = simplifyPath(points, 0.0001);
		expect(simplified[0]).toEqual([0, 0]);
		expect(simplified[simplified.length - 1]).toEqual([1, 1]);
		expect(simplified).toContainEqual([1, 0]);
	});

	it("always keeps first and last points", () => {
		const points: [number, number][] = Array.from({ length: 50 }, (_, i) => [
			i * 0.001,
			Math.sin(i) * 0.0001,
		]);
		const simplified = simplifyPath(points, 1); // absurdly coarse
		expect(simplified[0]).toEqual(points[0]);
		expect(simplified[simplified.length - 1]).toEqual(
			points[points.length - 1],
		);
	});
});

describe("downsamplePath", () => {
	const path: [number, number][] = Array.from(
		{ length: 1000 },
		(_, i): [number, number] => [i / 100, -i / 100],
	);

	it("returns the path untouched when it already fits the budget", () => {
		expect(downsamplePath(path, 1000)).toEqual(path);
		expect(downsamplePath(path, 5000)).toEqual(path);
	});

	it("samples down to the budget, keeping the first and last points", () => {
		const sampled = downsamplePath(path, 101);
		expect(sampled).toHaveLength(101);
		expect(sampled[0]).toEqual(path[0]);
		expect(sampled[sampled.length - 1]).toEqual(path[path.length - 1]);
	});

	it("samples at a strictly increasing, evenly spaced stride", () => {
		const sampled = downsamplePath(path, 51);
		const indices = sampled.map((point) => path.indexOf(point));
		expect(indices).toEqual([...indices].sort((a, b) => a - b));
		expect(new Set(indices).size).toBe(indices.length);
		expect(indices.at(-1)).toBe(path.length - 1);
	});

	it("degrades to the two endpoints for a nonsensical budget", () => {
		expect(downsamplePath(path, 0)).toEqual([path[0], path[path.length - 1]]);
	});
});

describe("computeBounds", () => {
	it("computes the min/max envelope of a point set", () => {
		expect(
			computeBounds([
				[10, 20],
				[-5, 30],
				[8, -1],
			]),
		).toEqual({ minLat: -5, minLng: -1, maxLat: 10, maxLng: 30 });
	});

	it("returns a degenerate zero box for an empty set", () => {
		expect(computeBounds([])).toEqual({
			minLat: 0,
			minLng: 0,
			maxLat: 0,
			maxLng: 0,
		});
	});
});

function makeRoute(overrides: Partial<RouteData> = {}): RouteData {
	return {
		distance_m: 2100,
		duration_s: 1620,
		legs: [{ distance_m: 2100, duration_s: 1620 }],
		coords: {
			origin: { lat: 52.525, lng: 13.3694 },
			destination: { lat: 52.5163, lng: 13.3777 },
		},
		...overrides,
	};
}

describe("buildRouteMapCardData", () => {
	it("builds markers, bounds, and summary for a route with no polyline", () => {
		const map = buildRouteMapCardData({
			route: makeRoute(),
			originLabel: "Berlin Hbf",
			destinationLabel: "Brandenburg Gate",
			mode: "walk",
		});
		expect(map).toBeDefined();
		expect(map?.markers).toEqual([
			{ lat: 52.525, lng: 13.3694, label: "Berlin Hbf", kind: "origin" },
			{
				lat: 52.5163,
				lng: 13.3777,
				label: "Brandenburg Gate",
				kind: "destination",
			},
		]);
		// No provider geometry -> falls back to the straight origin/destination line.
		expect(map?.polyline).toEqual([
			[52.525, 13.3694],
			[52.5163, 13.3777],
		]);
		expect(map?.distanceM).toBe(2100);
		expect(map?.durationS).toBe(1620);
		expect(map?.mode).toBe("walk");
		expect(map?.originLabel).toBe("Berlin Hbf");
		expect(map?.destinationLabel).toBe("Brandenburg Gate");
		expect(map?.attribution).toBe("© OpenStreetMap contributors");
		expect(map?.bounds.minLat).toBeLessThanOrEqual(52.5163);
		expect(map?.bounds.maxLat).toBeGreaterThanOrEqual(52.525);
	});

	it("decodes and includes a provider polyline", () => {
		const map = buildRouteMapCardData({
			route: makeRoute({ polyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" }),
			originLabel: "A",
			destinationLabel: "B",
			mode: "drive",
		});
		expect(map?.polyline?.length).toBeGreaterThanOrEqual(2);
		expect(map?.polyline?.[0][0]).toBeCloseTo(38.5, 3);
	});

	it("includes waypoint markers", () => {
		const map = buildRouteMapCardData({
			route: makeRoute({
				coords: {
					origin: { lat: 0, lng: 0 },
					destination: { lat: 1, lng: 1 },
					waypoints: [{ lat: 0.5, lng: 0.5 }],
				},
			}),
			originLabel: "A",
			destinationLabel: "B",
			mode: "bike",
		});
		expect(map?.markers).toHaveLength(3);
		expect(map?.markers?.some((m) => m.kind === "waypoint")).toBe(true);
	});

	it("keeps the whole payload under the 8 KB budget for a very long, wiggly route", () => {
		// Build a long, jittery polyline (thousands of points) the way a
		// multi-kilometer driving route's geometry would look, and confirm
		// simplification brings the serialized map object under budget.
		const points: [number, number][] = [];
		let lat = 47.4979;
		let lng = 19.0402;
		for (let i = 0; i < 5000; i++) {
			lat += 0.00003 + Math.sin(i / 7) * 0.00002;
			lng += 0.00004 + Math.cos(i / 11) * 0.00002;
			points.push([lat, lng]);
		}
		// Encode with a minimal local encoder mirroring the algorithm, so this
		// test does not depend on any external polyline library.
		const encoded = encodePolylineForTest(points);
		const map = buildRouteMapCardData({
			route: makeRoute({
				distance_m: 250_000,
				duration_s: 14_400,
				polyline: encoded,
				coords: {
					origin: { lat: points[0][0], lng: points[0][1] },
					destination: {
						lat: points[points.length - 1][0],
						lng: points[points.length - 1][1],
					},
				},
			}),
			originLabel: "Budapest",
			destinationLabel: "Somewhere far",
			mode: "drive",
		});
		expect(map).toBeDefined();
		const size = Buffer.byteLength(JSON.stringify(map));
		expect(size).toBeLessThanOrEqual(MAP_CARD_MAX_BYTES);
		expect(map?.polyline?.length).toBeGreaterThan(1);
	});

	it("draws a 60k-point route end to end instead of truncating it mid-route", () => {
		const points = longRouteFixture(60_000);
		const destination = points[points.length - 1];
		const map = buildRouteMapCardData({
			route: makeRoute({
				distance_m: 1_400_000,
				duration_s: 54_000,
				polyline: encodePolylineForTest(points),
				coords: {
					origin: { lat: points[0][0], lng: points[0][1] },
					destination: { lat: destination[0], lng: destination[1] },
				},
			}),
			originLabel: "Budapest",
			destinationLabel: "Lisbon",
			mode: "drive",
		});

		const polyline = map?.polyline;
		expect(polyline).toBeDefined();
		if (!polyline) return;
		// The drawn line must start at the origin and finish at the
		// destination. Decoding used to stop at a fixed 20k points, which left
		// the card drawing only the first third of the route.
		expect(polyline[0][0]).toBeCloseTo(points[0][0], 4);
		expect(polyline[0][1]).toBeCloseTo(points[0][1], 4);
		const drawnEnd = polyline[polyline.length - 1];
		expect(drawnEnd[0]).toBeCloseTo(destination[0], 4);
		expect(drawnEnd[1]).toBeCloseTo(destination[1], 4);
	});

	it("keeps a 60k-point route under the 8 KB budget", () => {
		const points = longRouteFixture(60_000);
		const destination = points[points.length - 1];
		const map = buildRouteMapCardData({
			route: makeRoute({
				distance_m: 1_400_000,
				duration_s: 54_000,
				polyline: encodePolylineForTest(points),
				coords: {
					origin: { lat: points[0][0], lng: points[0][1] },
					destination: { lat: destination[0], lng: destination[1] },
				},
			}),
			originLabel: "Budapest",
			destinationLabel: "Lisbon",
			mode: "drive",
		});

		expect(Buffer.byteLength(JSON.stringify(map))).toBeLessThanOrEqual(
			MAP_CARD_MAX_BYTES,
		);
		expect(map?.polyline?.length).toBeGreaterThan(2);
	});
});

describe("buildTransitMapCardData", () => {
	const origin = { lat: 49.4, lng: 8.69 };
	const destination = { lat: 49.41, lng: 8.695 };

	it("draws the itinerary geometry and carries its legs", () => {
		const points: [number, number][] = [
			[49.4, 8.69],
			[49.405, 8.692],
			[49.41, 8.695],
		];
		const map = buildTransitMapCardData({
			polyline: encodePolylineForTest(points),
			origin,
			destination,
			originLabel: "Dossenheim",
			destinationLabel: "Heidelberg",
			durationS: 1620,
			distanceM: 5231.4,
			transfers: 1,
			legs: [
				{ type: "walk", minutes: 3 },
				{ type: "pt", line: "39A", minutes: 19, stops: 7 },
			],
		});
		expect(map.mode).toBe("transit");
		expect(map.transfers).toBe(1);
		expect(map.transitLegs).toHaveLength(2);
		expect(map.durationS).toBe(1620);
		expect(map.distanceM).toBe(5231);
		expect(map.polyline?.length).toBe(3);
		expect(map.markers?.map((marker) => marker.kind)).toEqual([
			"origin",
			"destination",
		]);
		expect(map.departures).toBeUndefined();
	});

	it("falls back to a straight origin→destination line with no geometry", () => {
		const map = buildTransitMapCardData({
			origin,
			destination,
			originLabel: "A",
			destinationLabel: "B",
			durationS: 600,
			distanceM: 1000,
			transfers: 0,
			departures: [{ depart: "08:25", minutes: 27, transfers: 0 }],
		});
		expect(map.polyline).toEqual([
			[origin.lat, origin.lng],
			[destination.lat, destination.lng],
		]);
		expect(map.departures).toHaveLength(1);
		expect(map.transitLegs).toBeUndefined();
	});

	it("keeps a long itinerary under the 8 KB card budget", () => {
		const points = longRouteFixture(20_000);
		const last = points[points.length - 1];
		const map = buildTransitMapCardData({
			polyline: encodePolylineForTest(points),
			origin: { lat: points[0][0], lng: points[0][1] },
			destination: { lat: last[0], lng: last[1] },
			originLabel: "Budapest",
			destinationLabel: "Lisbon",
			durationS: 54_000,
			distanceM: 1_400_000,
			transfers: 4,
			legs: Array.from({ length: 12 }, (_, index) => ({
				type: index % 2 === 0 ? ("walk" as const) : ("pt" as const),
				minutes: 20,
				line: `L${index}`,
			})),
		});
		expect(Buffer.byteLength(JSON.stringify(map))).toBeLessThanOrEqual(
			MAP_CARD_MAX_BYTES,
		);
		expect(map.polyline?.length).toBeGreaterThan(2);
	});
});

// A long cross-continent route: steady north-westward progress with
// route-scale meanders (motorway sweeps) on top of per-point jitter, so the
// shape genuinely needs many vertices and cannot be honestly drawn as a
// straight line between its endpoints.
function longRouteFixture(count: number): [number, number][] {
	const points: [number, number][] = [];
	for (let i = 0; i < count; i++) {
		const t = i / (count - 1);
		const lat =
			47.4979 +
			t * 4 +
			Math.cos(t * Math.PI * 14) * 0.4 +
			Math.sin(i / 7) * 0.0001;
		const lng =
			19.0402 -
			t * 12 +
			Math.sin(t * Math.PI * 18) * 0.5 +
			Math.cos(i / 11) * 0.0001;
		points.push([lat, lng]);
	}
	return points;
}

// Minimal encoder for test fixtures only (mirrors the standard algorithm
// decodePolyline above implements the inverse of).
// `elevations` (metres, one per point) produces the 3D geometry ORS returns
// when elevation is requested.
function encodePolylineForTest(
	points: [number, number][],
	elevations?: number[],
): string {
	let output = "";
	let prevLat = 0;
	let prevLng = 0;
	let prevEle = 0;
	const encodeValue = (value: number): string => {
		let v = value < 0 ? ~(value << 1) : value << 1;
		let chunk = "";
		while (v >= 0x20) {
			chunk += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
			v >>= 5;
		}
		chunk += String.fromCharCode(v + 63);
		return chunk;
	};
	points.forEach(([lat, lng], index) => {
		const latE5 = Math.round(lat * 1e5);
		const lngE5 = Math.round(lng * 1e5);
		output += encodeValue(latE5 - prevLat);
		output += encodeValue(lngE5 - prevLng);
		prevLat = latE5;
		prevLng = lngE5;
		if (elevations) {
			const eleE5 = Math.round((elevations[index] ?? 0) * 1e5);
			output += encodeValue(eleE5 - prevEle);
			prevEle = eleE5;
		}
	});
	return output;
}

describe("decodePolyline — elevation geometry", () => {
	it("consumes the third value per point instead of reading it as a latitude", () => {
		const points: [number, number][] = [
			[38.5, -120.2],
			[40.7, -120.95],
			[43.252, -126.453],
		];
		const flat = encodePolylineForTest(points);
		const withElevation = encodePolylineForTest(points, [100, 10, 250]);
		// A 2D read of the 3D string would drift immediately; a 3D read matches.
		expect(decodePolyline(withElevation, 5, 3)).toEqual(
			decodePolyline(flat, 5, 2),
		);
		expect(decodePolyline(withElevation, 5, 2)).not.toEqual(
			decodePolyline(flat, 5, 2),
		);
	});
});

describe("buildRouteMapCardData — directions", () => {
	it("re-points a step's way-point span at the simplified line", () => {
		// A dense zig-zag: simplification drops most of its points, so an
		// un-remapped span would point past the end of the drawn line.
		const points: [number, number][] = Array.from(
			{ length: 500 },
			(_, index): [number, number] => [
				51.9 + index * 0.0001,
				-8.47 + (index % 2 === 0 ? 0.00001 : -0.00001),
			],
		);
		const map = buildRouteMapCardData({
			route: {
				distance_m: 5000,
				duration_s: 600,
				polyline: encodePolylineForTest(points),
				legs: [
					{
						distance_m: 5000,
						duration_s: 600,
						steps: [
							{
								distance_m: 2500,
								duration_s: 300,
								instruction: "Head north",
								type: 11,
								way_points: [0, 250],
							},
							{
								distance_m: 2500,
								duration_s: 300,
								instruction: "Arrive",
								type: 10,
								way_points: [250, 499],
							},
						],
					},
				],
				coords: {
					origin: { lat: 51.9, lng: -8.47 },
					destination: { lat: 51.95, lng: -8.47 },
				},
			},
			originLabel: "A",
			destinationLabel: "B",
			mode: "drive",
		});
		const drawn = map?.polyline?.length ?? 0;
		expect(drawn).toBeGreaterThan(1);
		for (const step of map?.steps ?? []) {
			expect(step.wayPointRange?.[0]).toBeGreaterThanOrEqual(0);
			expect(step.wayPointRange?.[1]).toBeLessThan(drawn);
		}
		expect(map?.steps?.[1].wayPointRange?.[1]).toBe(drawn - 1);
	});

	it("drops the spans when the provider returned no geometry to point at", () => {
		const map = buildRouteMapCardData({
			route: {
				distance_m: 100,
				duration_s: 60,
				legs: [
					{
						distance_m: 100,
						duration_s: 60,
						steps: [
							{
								distance_m: 100,
								duration_s: 60,
								instruction: "Head north",
								way_points: [0, 3],
							},
						],
					},
				],
				coords: {
					origin: { lat: 51.9, lng: -8.47 },
					destination: { lat: 51.95, lng: -8.47 },
				},
			},
			originLabel: "A",
			destinationLabel: "B",
			mode: "walk",
		});
		expect(map?.steps?.[0].wayPointRange).toBeUndefined();
		expect(map?.steps?.[0].instruction).toBe("Head north");
	});

	it("carries the climb reported for a walking route", () => {
		const map = buildRouteMapCardData({
			route: {
				distance_m: 2600,
				duration_s: 1980,
				ascent_m: 45.4,
				descent_m: 12.2,
				legs: [],
				coords: {
					origin: { lat: 51.7, lng: -8.52 },
					destination: { lat: 51.7, lng: -8.5 },
				},
			},
			originLabel: "Kinsale harbour",
			destinationLabel: "Charles Fort",
			mode: "walk",
		});
		expect(map?.ascentM).toBe(45);
		expect(map?.descentM).toBe(12);
	});
});
