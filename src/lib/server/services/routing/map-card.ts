// Builds the compact `ToolCallMapData` payload attached to a `map_route`
// ToolCallEntry so the client can render an inline map card without ever
// re-fetching the route. This is UI-only data — it never rides the
// model-facing payload — so it is built here, next to the routing provider
// types, and threaded onto the tool-call entry by routing.ts/index.ts.
//
// Budget: kept under MAP_CARD_MAX_BYTES per call by
// decoding the provider's encoded polyline once and then Douglas-Peucker
// simplifying it, escalating the simplification tolerance until the
// serialized object fits — never truncating markers/summary, which are tiny.

import type {
	ToolCallMapData,
	ToolCallMapDeparture,
	ToolCallMapMarker,
	ToolCallMapTransitLeg,
} from "$lib/server/services/messages-types";
import { buildRouteSteps, routeVia } from "./directions";
import { OSM_ATTRIBUTION, type RouteData, type RoutingMode } from "./types";

// The whole persisted card: geometry, markers, summary AND (since the
// step-by-step directions landed) the manoeuvre list or the itinerary's legs.
// 12 KB is the owner's ceiling for that combined payload; the polyline is what
// gives way when the rest of the card grows, since a slightly coarser line is
// invisible while a missing direction is not.
export const MAP_CARD_MAX_BYTES = 12 * 1024;

// Ceiling on how many decoded points are carried into simplification. A route
// denser than this holds far more detail than the card can draw, so the
// path is downsampled uniformly to this budget (see downsamplePath) rather
// than cut short — the drawn line must still reach the destination.
const MAX_SOURCE_POINTS = 20_000;
const MAX_POLYLINE_POINTS = 300;

// ── Encoded polyline decode (Google/ORS algorithm, precision 5) ────────────
// ORS's default route geometry is the standard encoded-polyline format:
// signed values delta-encoded against the previous point, each scaled by
// 1e5 and varint/zigzag packed into printable ASCII. Decoding yields
// [lat, lng] pairs in the same order the string encodes them (lat first).
//
// `dimensions` is 3 for a geometry requested WITH elevation (ORS packs the
// altitude as a third delta on every point); the altitude is consumed and
// discarded — decoding it as 2D would silently read it as the next point's
// latitude and draw a route through the sea.
export function decodePolyline(
	encoded: string,
	precision = 5,
	dimensions: 2 | 3 = 2,
): [number, number][] {
	const factor = 10 ** precision;
	const points: [number, number][] = [];
	let index = 0;
	let lat = 0;
	let lng = 0;
	const len = encoded.length;

	// Decodes the whole string: work is linear in `encoded.length`, and the
	// point budget is applied afterwards by downsamplePath, which keeps the
	// route's full extent instead of dropping its tail.
	while (index < len) {
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

		// The altitude delta is read purely to keep the stream aligned — the
		// card draws no elevation, so the value itself is thrown away.
		if (dimensions === 3) {
			shift = 0;
			do {
				if (index >= len) return points;
				byte = encoded.charCodeAt(index++) - 63;
				shift += 5;
			} while (byte >= 0x20);
		}

		points.push([lat / factor, lng / factor]);
	}
	return points;
}

// ── Uniform downsampling ───────────────────────────────────────────────────

// Reduces a path to at most `maxPoints` by sampling it at an even stride,
// always keeping the first and last point. This is the point budget's only
// enforcement before simplification: unlike truncating the tail, it preserves
// the route's full origin-to-destination extent, just at coarser resolution.
export function downsamplePath(
	points: [number, number][],
	maxPoints: number,
): [number, number][] {
	return downsampleIndices(points.length, maxPoints).map(
		(index) => points[index],
	);
}

// The same choice expressed as the INDICES kept, so a caller that has to map
// something else onto the reduced path (a step's way-point span, say) can
// follow which original point became which drawn one.
export function downsampleIndices(length: number, maxPoints: number): number[] {
	if (length === 0) return [];
	const last = length - 1;
	if (maxPoints < 2) return length <= 2 ? range(length) : [0, last];
	if (length <= maxPoints) return range(length);

	const result: number[] = [0];
	// `length > maxPoints` makes step > 1, so Math.round is strictly
	// increasing and every interior index lands in (0, last) — no duplicates
	// and no accidental early copy of the endpoint.
	const step = last / (maxPoints - 1);
	for (let i = 1; i < maxPoints - 1; i++) {
		result.push(Math.round(i * step));
	}
	result.push(last);
	return result;
}

function range(length: number): number[] {
	const result: number[] = [];
	for (let i = 0; i < length; i++) result.push(i);
	return result;
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
	return simplifyIndices(points, tolerance).map((index) => points[index]);
}

// Douglas-Peucker expressed as the indices kept (see downsampleIndices for
// why the index form exists).
export function simplifyIndices(
	points: [number, number][],
	tolerance: number,
): number[] {
	if (points.length <= 2 || tolerance <= 0) return range(points.length);
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

	const result: number[] = [];
	for (let i = 0; i < points.length; i++) {
		if (keep[i]) result.push(i);
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
// Returns the drawn points AND which index of `raw` each of them came from,
// so a caller can re-point a step's way-point span at the simplified line.
type FittedPolyline = { points: [number, number][]; kept: number[] };

function fitPolylineToBudget(
	raw: [number, number][],
	overheadBytes: number,
): FittedPolyline {
	if (raw.length === 0) return { points: raw, kept: [] };
	const budget = Math.max(0, MAP_CARD_MAX_BYTES - overheadBytes);
	// Degree tolerance ladder: starts at "no simplification", then grows
	// geometrically. 1e-5 deg ≈ 1.1m, so this ranges from sub-meter to ~1.1km.
	const steps = [
		0, 0.00001, 0.00002, 0.00005, 0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005,
		0.01, 0.02, 0.05,
	];
	let keptIndices = range(raw.length);
	let simplified = roundPath(raw);
	for (const tolerance of steps) {
		keptIndices = simplifyIndices(raw, tolerance);
		simplified = roundPath(keptIndices.map((index) => raw[index]));
		if (
			simplified.length <= MAX_POLYLINE_POINTS &&
			Buffer.byteLength(JSON.stringify(simplified)) <= budget
		) {
			return { points: simplified, kept: keptIndices };
		}
	}
	// Still too big (pathological input) — hard-decimate evenly as a last
	// resort, keeping first/last points.
	let decimated = keptIndices;
	let stride = 2;
	while (
		decimated.length > 2 &&
		(decimated.length > MAX_POLYLINE_POINTS ||
			Buffer.byteLength(
				JSON.stringify(roundPath(decimated.map((index) => raw[index]))),
			) > budget)
	) {
		decimated = keptIndices.filter(
			(_, i) => i % stride === 0 || i === keptIndices.length - 1,
		);
		stride += 1;
		if (stride > 200) break; // safety valve
	}
	return {
		points: roundPath(decimated.map((index) => raw[index])),
		kept: decimated,
	};
}

// ── Public builder ──────────────────────────────────────────────────────────

// Shared tail of both builders: choose the drawn path, compute bounds, fit the
// polyline to the byte budget around whatever else the card carries, and drop
// the line entirely rather than persist an oversized blob. It also hands back
// which index of `rawPath` each drawn point came from — what both builders
// need to re-point a step's or a leg's highlight span at the simplified line.
function assembleWithIndices(
	skeleton: Omit<ToolCallMapData, "polyline">,
	rawPath: [number, number][],
): { map: ToolCallMapData; kept: number[] } {
	const overheadBytes = Buffer.byteLength(JSON.stringify(skeleton));
	const fitted = fitPolylineToBudget(rawPath, overheadBytes);
	const polyline = fitted.points;
	const map: ToolCallMapData = { ...skeleton, polyline };
	if (Buffer.byteLength(JSON.stringify(map)) > MAP_CARD_MAX_BYTES) {
		// Keep the endpoints rather than the first two points, so even this
		// degenerate line still spans origin to destination.
		const lastIndex = polyline.length - 1;
		const ends: [number, number][] =
			polyline.length > 1 ? [polyline[0], polyline[lastIndex]] : polyline;
		return {
			map: { ...skeleton, polyline: ends },
			kept:
				fitted.kept.length > 1
					? [fitted.kept[0], fitted.kept[fitted.kept.length - 1]]
					: fitted.kept,
		};
	}
	return { map, kept: fitted.kept };
}

// Re-points an index into the ORIGINAL decoded geometry at the nearest point
// that survived downsampling + simplification. `kept` is ascending, so a
// binary search finds the neighbour; the caller gets a usable highlight span
// instead of an index that no longer means anything.
export function remapIndex(kept: number[], index: number): number | undefined {
	if (kept.length === 0) return undefined;
	let low = 0;
	let high = kept.length - 1;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (kept[mid] < index) low = mid + 1;
		else high = mid;
	}
	// `low` is the first kept index >= `index`; the one before it may be closer.
	if (
		low > 0 &&
		Math.abs(kept[low - 1] - index) <= Math.abs(kept[low] - index)
	) {
		return low - 1;
	}
	return low;
}

// The map card for a `transit` / `timetable` result. The drawn line is the
// itinerary's own geometry (ORS returns a whole-journey polyline for a PT
// route, same encoding as a road route), and the leg list rides alongside it
// so the chat body can print "bus 39A 08:31 → 08:47" above the map.
export function buildTransitMapCardData(params: {
	polyline?: string;
	origin: { lat: number; lng: number };
	destination: { lat: number; lng: number };
	originLabel: string;
	destinationLabel: string;
	durationS: number;
	distanceM: number;
	transfers: number;
	legs?: ToolCallMapTransitLeg[];
	departures?: ToolCallMapDeparture[];
	// A mixed-mode `journey` draws the same timeline; only the mode word and
	// the extra geometry differ, so it shares this builder.
	mode?: "transit" | "journey";
	// Already-local clock times for the summary line, and the calendar date the
	// journey runs on ("2026-09-09").
	departAt?: string;
	arriveAt?: string;
	departDate?: string;
	arriveBy?: string;
	// Pre-decoded geometry, used by a journey whose line is stitched together
	// from several legs rather than carried as one encoded string.
	points?: [number, number][];
}): ToolCallMapData {
	const sourcePoints =
		params.points ??
		(params.polyline ? decodePolyline(params.polyline) : ([] as never[]));
	const sourceIndices = downsampleIndices(
		sourcePoints.length,
		MAX_SOURCE_POINTS,
	);
	const decoded = sourceIndices.map((index) => sourcePoints[index]);
	const markers: ToolCallMapMarker[] = [
		{
			lat: params.origin.lat,
			lng: params.origin.lng,
			label: params.originLabel,
			kind: "origin",
		},
		{
			lat: params.destination.lat,
			lng: params.destination.lng,
			label: params.destinationLabel,
			kind: "destination",
		},
	];
	const rawPath: [number, number][] =
		decoded.length >= 2
			? decoded
			: [
					[params.origin.lat, params.origin.lng],
					[params.destination.lat, params.destination.lng],
				];
	const bounds = computeBounds([
		...rawPath,
		...markers.map((marker): [number, number] => [marker.lat, marker.lng]),
	]);
	const skeleton: Omit<ToolCallMapData, "polyline"> = {
		bounds,
		markers,
		distanceM: Math.round(params.distanceM),
		durationS: Math.round(params.durationS),
		mode: params.mode ?? "transit",
		originLabel: params.originLabel,
		destinationLabel: params.destinationLabel,
		transfers: params.transfers,
		...(params.legs && params.legs.length > 0
			? { transitLegs: params.legs }
			: {}),
		...(params.departures && params.departures.length > 0
			? { departures: params.departures }
			: {}),
		...(params.departAt ? { departAt: params.departAt } : {}),
		...(params.arriveAt ? { arriveAt: params.arriveAt } : {}),
		...(params.departDate ? { departDate: params.departDate } : {}),
		...(params.arriveBy ? { arriveBy: params.arriveBy } : {}),
		attribution: OSM_ATTRIBUTION,
	};
	const { map, kept } = assembleWithIndices(skeleton, rawPath);
	// A journey's legs carry a span in the STITCHED geometry; the drawn line is
	// a simplified subset of it, so the spans follow the same re-pointing the
	// road steps get (and are dropped when there is no real geometry).
	if (map.transitLegs) {
		const usable = decoded.length >= 2;
		map.transitLegs = map.transitLegs.map((leg) => {
			if (!leg.pointRange || !usable) {
				const { pointRange: _dropped, ...rest } = leg;
				return rest;
			}
			const start = remapIndex(
				kept,
				remapIndex(sourceIndices, leg.pointRange[0]) ?? 0,
			);
			const end = remapIndex(
				kept,
				remapIndex(sourceIndices, leg.pointRange[1]) ?? 0,
			);
			if (start === undefined || end === undefined) {
				const { pointRange: _dropped, ...rest } = leg;
				return rest;
			}
			return { ...leg, pointRange: [start, end] as [number, number] };
		});
	}
	return map;
}

export function buildRouteMapCardData(params: {
	route: RouteData;
	originLabel: string;
	destinationLabel: string;
	mode: RoutingMode;
}): ToolCallMapData | undefined {
	const { route, originLabel, destinationLabel, mode } = params;
	const decodedAll = route.polyline
		? decodePolyline(route.polyline, 5, route.polylineDimensions ?? 2)
		: [];
	// Which ORS geometry index each carried point came from — the first half of
	// the chain that keeps a step's way-point span pointing at the right stretch
	// of the drawn line.
	const sourceIndices = downsampleIndices(decodedAll.length, MAX_SOURCE_POINTS);
	const decoded = sourceIndices.map((index) => decodedAll[index]);

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

	const steps = buildRouteSteps(route);
	const via = routeVia(route);
	const skeleton: Omit<ToolCallMapData, "polyline"> = {
		bounds,
		markers,
		distanceM: Math.round(route.distance_m),
		durationS: Math.round(route.duration_s),
		mode,
		originLabel,
		destinationLabel,
		...(steps.length > 0 ? { steps } : {}),
		...(via ? { via } : {}),
		...(route.ascent_m !== undefined
			? { ascentM: Math.round(route.ascent_m) }
			: {}),
		...(route.descent_m !== undefined
			? { descentM: Math.round(route.descent_m) }
			: {}),
		attribution: OSM_ATTRIBUTION,
	};
	// Final guard inside assembleWithIndices: if something upstream still
	// overshoots the budget, the polyline is reduced to its endpoints rather
	// than persisted oversized — the card still renders markers.
	const { map, kept } = assembleWithIndices(skeleton, rawPath);
	// A step's way-point span indexes the ORS geometry; the card's polyline is
	// a simplified subset of it, so the spans are re-pointed at the drawn line
	// (and dropped outright when there is no geometry to point at) — a stale
	// index would highlight the wrong stretch of road.
	if (map.steps) {
		const usable = decoded.length >= 2;
		map.steps = map.steps.map((step) => {
			if (!step.wayPointRange || !usable) {
				const { wayPointRange: _dropped, ...rest } = step;
				return rest;
			}
			const start = remapIndex(
				kept,
				remapIndex(sourceIndices, step.wayPointRange[0]) ?? 0,
			);
			const end = remapIndex(
				kept,
				remapIndex(sourceIndices, step.wayPointRange[1]) ?? 0,
			);
			if (start === undefined || end === undefined) {
				const { wayPointRange: _dropped, ...rest } = step;
				return rest;
			}
			return { ...step, wayPointRange: [start, end] as [number, number] };
		});
	}
	return map;
}
