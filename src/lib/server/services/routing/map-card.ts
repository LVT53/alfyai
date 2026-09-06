// Builds the compact `ToolCallMapData` payload attached to a `map_route`
// ToolCallEntry so the client can render an inline map card without ever
// re-fetching the route. This is UI-only data — it never rides the
// model-facing payload — so it is built here, next to the routing provider
// types, and threaded onto the tool-call entry by routing.ts/index.ts.
//
// Budget: kept well under 8 KB per call (see MAP_CARD_MAX_BYTES) by
// decoding the provider's encoded polyline once and then Douglas-Peucker
// simplifying it, escalating the simplification tolerance until the
// serialized object fits — never truncating markers/summary, which are tiny.

import type {
	ToolCallMapData,
	ToolCallMapMarker,
} from "$lib/server/services/messages-types";
import { OSM_ATTRIBUTION, type RouteData, type RoutingMode } from "./types";

export const MAP_CARD_MAX_BYTES = 8 * 1024;

// A polyline this short never needs simplifying and decoding a tiny path is
// cheap; this also bounds worst-case decode work for a malformed/huge string.
const MAX_DECODE_POINTS = 20_000;
const MAX_POLYLINE_POINTS = 300;

// ── Encoded polyline decode (Google/ORS algorithm, precision 5) ────────────
// ORS's default route geometry is the standard encoded-polyline format:
// signed values delta-encoded against the previous point, each scaled by
// 1e5 and varint/zigzag packed into printable ASCII. Decoding yields
// [lat, lng] pairs in the same order the string encodes them (lat first).
export function decodePolyline(
	encoded: string,
	precision = 5,
): [number, number][] {
	const factor = 10 ** precision;
	const points: [number, number][] = [];
	let index = 0;
	let lat = 0;
	let lng = 0;
	const len = encoded.length;

	while (index < len && points.length < MAX_DECODE_POINTS) {
		let result = 0;
		let shift = 0;
		let byte: number;
		do {
			if (index >= len) return points;
			byte = encoded.charCodeAt(index++) - 63;
			result |= (byte & 0x1f) << shift;
			shift += 5;
		} while (byte >= 0x20);
		const deltaLat = result & 1 ? ~(result >> 1) : result >> 1;
		lat += deltaLat;

		result = 0;
		shift = 0;
		do {
			if (index >= len) return points;
			byte = encoded.charCodeAt(index++) - 63;
			result |= (byte & 0x1f) << shift;
			shift += 5;
		} while (byte >= 0x20);
		const deltaLng = result & 1 ? ~(result >> 1) : result >> 1;
		lng += deltaLng;

		points.push([lat / factor, lng / factor]);
	}
	return points;
}

// ── Douglas-Peucker simplification ─────────────────────────────────────────

function perpendicularDistance(
	point: [number, number],
	lineStart: [number, number],
	lineEnd: [number, number],
): number {
	const [px, py] = point;
	const [x1, y1] = lineStart;
	const [x2, y2] = lineEnd;
	const dx = x2 - x1;
	const dy = y2 - y1;
	if (dx === 0 && dy === 0) {
		return Math.hypot(px - x1, py - y1);
	}
	const t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
	const clampedT = Math.max(0, Math.min(1, t));
	const nearestX = x1 + clampedT * dx;
	const nearestY = y1 + clampedT * dy;
	return Math.hypot(px - nearestX, py - nearestY);
}

// Simplifies a [lat,lng] path with Douglas-Peucker at the given tolerance
// (in the same degree units as the coordinates — small values, since a
// route spans at most a few degrees). Iterative stack-based to avoid deep
// recursion on a long path.
export function simplifyPath(
	points: [number, number][],
	tolerance: number,
): [number, number][] {
	if (points.length <= 2 || tolerance <= 0) return points;
	const keep = new Uint8Array(points.length);
	keep[0] = 1;
	keep[points.length - 1] = 1;
	const stack: [number, number][] = [[0, points.length - 1]];

	while (stack.length > 0) {
		const range = stack.pop();
		if (!range) break;
		const [start, end] = range;
		if (end <= start + 1) continue;
		let maxDist = -1;
		let maxIndex = -1;
		for (let i = start + 1; i < end; i++) {
			const dist = perpendicularDistance(points[i], points[start], points[end]);
			if (dist > maxDist) {
				maxDist = dist;
				maxIndex = i;
			}
		}
		if (maxDist > tolerance && maxIndex !== -1) {
			keep[maxIndex] = 1;
			stack.push([start, maxIndex]);
			stack.push([maxIndex, end]);
		}
	}

	const result: [number, number][] = [];
	for (let i = 0; i < points.length; i++) {
		if (keep[i]) result.push(points[i]);
	}
	return result;
}

// ── Bounds ──────────────────────────────────────────────────────────────────

export function computeBounds(
	points: Array<[number, number]>,
): ToolCallMapData["bounds"] {
	let minLat = Number.POSITIVE_INFINITY;
	let minLng = Number.POSITIVE_INFINITY;
	let maxLat = Number.NEGATIVE_INFINITY;
	let maxLng = Number.NEGATIVE_INFINITY;
	for (const [lat, lng] of points) {
		if (lat < minLat) minLat = lat;
		if (lat > maxLat) maxLat = lat;
		if (lng < minLng) minLng = lng;
		if (lng > maxLng) maxLng = lng;
	}
	if (!Number.isFinite(minLat)) {
		return { minLat: 0, minLng: 0, maxLat: 0, maxLng: 0 };
	}
	return { minLat, minLng, maxLat, maxLng };
}

function roundCoord(value: number): number {
	// 6 decimal places (~11cm) is already far finer than a rendered map needs;
	// keeps the JSON compact without visibly degrading the drawn line.
	return Math.round(value * 1e6) / 1e6;
}

function roundPath(points: [number, number][]): [number, number][] {
	return points.map(([lat, lng]) => [roundCoord(lat), roundCoord(lng)]);
}

// Escalates the Douglas-Peucker tolerance until the polyline (rounded to 6
// decimals) both fits the hard point cap and, combined with the rest of the
// map payload, fits under MAP_CARD_MAX_BYTES. `overheadBytes` is the
// serialized size of everything else in the map object (bounds/markers/
// summary), so the budget split is exact rather than a guess.
function fitPolylineToBudget(
	raw: [number, number][],
	overheadBytes: number,
): [number, number][] {
	if (raw.length === 0) return raw;
	const budget = Math.max(0, MAP_CARD_MAX_BYTES - overheadBytes);
	let tolerance = 0;
	// Degree tolerance ladder: starts at "no simplification", then grows
	// geometrically. 1e-5 deg ≈ 1.1m, so this ranges from sub-meter to ~1.1km.
	const steps = [
		0, 0.00001, 0.00002, 0.00005, 0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005,
		0.01, 0.02, 0.05,
	];
	let simplified = raw;
	for (const step of steps) {
		tolerance = step;
		simplified = roundPath(simplifyPath(raw, tolerance));
		if (
			simplified.length <= MAX_POLYLINE_POINTS &&
			Buffer.byteLength(JSON.stringify(simplified)) <= budget
		) {
			return simplified;
		}
	}
	// Still too big (pathological input) — hard-decimate evenly as a last
	// resort, keeping first/last points.
	let decimated = simplified;
	let stride = 2;
	while (
		decimated.length > 2 &&
		(decimated.length > MAX_POLYLINE_POINTS ||
			Buffer.byteLength(JSON.stringify(decimated)) > budget)
	) {
		decimated = simplified.filter(
			(_, i) => i % stride === 0 || i === simplified.length - 1,
		);
		stride += 1;
		if (stride > 200) break; // safety valve
	}
	return decimated;
}

// ── Public builder ──────────────────────────────────────────────────────────

export function buildRouteMapCardData(params: {
	route: RouteData;
	originLabel: string;
	destinationLabel: string;
	mode: RoutingMode;
}): ToolCallMapData | undefined {
	const { route, originLabel, destinationLabel, mode } = params;
	const decoded = route.polyline ? decodePolyline(route.polyline) : [];

	const markers: ToolCallMapMarker[] = [
		{
			lat: route.coords.origin.lat,
			lng: route.coords.origin.lng,
			label: originLabel,
			kind: "origin",
		},
		{
			lat: route.coords.destination.lat,
			lng: route.coords.destination.lng,
			label: destinationLabel,
			kind: "destination",
		},
		...(route.coords.waypoints ?? []).map(
			(wp): ToolCallMapMarker => ({
				lat: wp.lat,
				lng: wp.lng,
				kind: "waypoint" as const,
			}),
		),
	];

	// Fall back to the resolved endpoints when the provider returned no
	// geometry — the card still renders a straight line + markers rather
	// than nothing.
	const rawPath: [number, number][] =
		decoded.length >= 2
			? decoded
			: [
					[route.coords.origin.lat, route.coords.origin.lng],
					[route.coords.destination.lat, route.coords.destination.lng],
				];

	const boundsSource = [
		...rawPath,
		...markers.map((m): [number, number] => [m.lat, m.lng]),
	];
	const bounds = computeBounds(boundsSource);

	const skeleton: Omit<ToolCallMapData, "polyline"> = {
		bounds,
		markers,
		distanceM: Math.round(route.distance_m),
		durationS: Math.round(route.duration_s),
		mode,
		originLabel,
		destinationLabel,
		attribution: OSM_ATTRIBUTION,
	};
	const overheadBytes = Buffer.byteLength(JSON.stringify(skeleton));
	const polyline = fitPolylineToBudget(rawPath, overheadBytes);

	const map: ToolCallMapData = { ...skeleton, polyline };
	// Final guard: if something upstream still overshoots (shouldn't happen
	// given the budget split above), drop the polyline entirely rather than
	// persist an oversized blob — the card still renders markers.
	if (Buffer.byteLength(JSON.stringify(map)) > MAP_CARD_MAX_BYTES) {
		return { ...skeleton, polyline: polyline.slice(0, 2) };
	}
	return map;
}
