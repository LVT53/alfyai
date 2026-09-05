// Geofabrik region catalogue for on-demand routing coverage.
//
// Geofabrik publishes `index-v1.json`: one GeoJSON feature per downloadable
// OSM extract (continent → country → state …) with the extract's polygon and
// its `*-latest.osm.pbf` URL. We use it to answer "which extract covers this
// coordinate?" so the region manager can download and build exactly the
// region a route needs, instead of shipping one fixed extract.
//
// Region choice is deliberately COUNTRY-FIRST: the shallowest non-continent
// region containing the point is preferred (a country), falling back to
// deeper sub-regions (states) only when the country extract exceeds the
// configured size cap. Continents are never chosen — they are tens of GB and
// take days to build.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LatLng } from "./types";

export const GEOFABRIK_INDEX_URL =
	"https://download.geofabrik.de/index-v1.json";
const DEFAULT_INDEX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// GeoJSON position [lng, lat]. A polygon is a list of rings (first = outer,
// rest = holes); a MultiPolygon is a list of polygons.
type Position = [number, number];
type PolygonCoords = Position[][];
type MultiPolygonCoords = PolygonCoords[];

export type GeofabrikRegion = {
	id: string;
	name: string;
	parent?: string;
	pbfUrl: string;
	// Always normalized to MultiPolygon coordinates.
	polygons: MultiPolygonCoords;
	// Cached lng/lat bounding box for a cheap pre-check.
	bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number };
};

export type GeofabrikIndex = {
	fetchedAt: number;
	regions: GeofabrikRegion[];
	byId: Map<string, GeofabrikRegion>;
};

type RawFeature = {
	type?: string;
	properties?: {
		id?: unknown;
		name?: unknown;
		parent?: unknown;
		urls?: { pbf?: unknown };
	};
	geometry?: { type?: string; coordinates?: unknown };
};

function isPosition(value: unknown): value is Position {
	return (
		Array.isArray(value) &&
		value.length >= 2 &&
		typeof value[0] === "number" &&
		typeof value[1] === "number"
	);
}

function normalizeGeometry(
	geometry: RawFeature["geometry"],
): MultiPolygonCoords | null {
	if (!geometry || !Array.isArray(geometry.coordinates)) return null;
	if (geometry.type === "Polygon") {
		const rings = geometry.coordinates as unknown[];
		if (!rings.every((ring) => Array.isArray(ring) && ring.every(isPosition))) {
			return null;
		}
		return [rings as PolygonCoords];
	}
	if (geometry.type === "MultiPolygon") {
		const polygons = geometry.coordinates as unknown[];
		const ok = polygons.every(
			(polygon) =>
				Array.isArray(polygon) &&
				polygon.every((ring) => Array.isArray(ring) && ring.every(isPosition)),
		);
		return ok ? (polygons as MultiPolygonCoords) : null;
	}
	return null;
}

function computeBbox(polygons: MultiPolygonCoords): GeofabrikRegion["bbox"] {
	let minLng = Number.POSITIVE_INFINITY;
	let minLat = Number.POSITIVE_INFINITY;
	let maxLng = Number.NEGATIVE_INFINITY;
	let maxLat = Number.NEGATIVE_INFINITY;
	for (const polygon of polygons) {
		for (const [lng, lat] of polygon[0] ?? []) {
			if (lng < minLng) minLng = lng;
			if (lng > maxLng) maxLng = lng;
			if (lat < minLat) minLat = lat;
			if (lat > maxLat) maxLat = lat;
		}
	}
	return { minLng, minLat, maxLng, maxLat };
}

// Parse the raw index JSON into a lookup structure. Malformed features are
// skipped rather than failing the whole catalogue.
export function parseGeofabrikIndex(
	raw: unknown,
	fetchedAt = Date.now(),
): GeofabrikIndex {
	const features =
		raw &&
		typeof raw === "object" &&
		Array.isArray((raw as { features?: unknown }).features)
			? ((raw as { features: RawFeature[] }).features ?? [])
			: [];
	const regions: GeofabrikRegion[] = [];
	for (const feature of features) {
		const props = feature.properties ?? {};
		const id = typeof props.id === "string" ? props.id : null;
		const name = typeof props.name === "string" ? props.name : id;
		const pbfUrl = typeof props.urls?.pbf === "string" ? props.urls.pbf : null;
		const polygons = normalizeGeometry(feature.geometry);
		if (!id || !name || !pbfUrl || !polygons || polygons.length === 0) continue;
		regions.push({
			id,
			name,
			...(typeof props.parent === "string" ? { parent: props.parent } : {}),
			pbfUrl,
			polygons,
			bbox: computeBbox(polygons),
		});
	}
	return {
		fetchedAt,
		regions,
		byId: new Map(regions.map((region) => [region.id, region])),
	};
}

// Ray-casting point-in-ring test. `ring` is a closed or open list of
// [lng, lat] positions.
function pointInRing(point: LatLng, ring: Position[]): boolean {
	let inside = false;
	const x = point.lng;
	const y = point.lat;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];
		const intersects =
			yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
		if (intersects) inside = !inside;
	}
	return inside;
}

export function regionContainsPoint(
	region: GeofabrikRegion,
	point: LatLng,
): boolean {
	const { bbox } = region;
	if (
		point.lng < bbox.minLng ||
		point.lng > bbox.maxLng ||
		point.lat < bbox.minLat ||
		point.lat > bbox.maxLat
	) {
		return false;
	}
	for (const polygon of region.polygons) {
		const [outer, ...holes] = polygon;
		if (!outer || !pointInRing(point, outer)) continue;
		if (holes.some((hole) => pointInRing(point, hole))) continue;
		return true;
	}
	return false;
}

export function regionDepth(
	index: GeofabrikIndex,
	region: GeofabrikRegion,
): number {
	let depth = 0;
	let current: GeofabrikRegion | undefined = region;
	const seen = new Set<string>();
	while (current?.parent && !seen.has(current.id)) {
		seen.add(current.id);
		depth += 1;
		current = index.byId.get(current.parent);
	}
	return depth;
}

// All regions containing the point, ordered from the shallowest non-continent
// (country) to the deepest (state / sub-state). Continents (depth 0) are
// excluded. Ties at the same depth are broken by the smaller bounding box.
export function findRegionsForPoint(
	index: GeofabrikIndex,
	point: LatLng,
): GeofabrikRegion[] {
	const matches = index.regions.filter((region) =>
		regionContainsPoint(region, point),
	);
	const depths = new Map(
		matches.map((region) => [region.id, regionDepth(index, region)]),
	);
	return matches
		.filter((region) => (depths.get(region.id) ?? 0) > 0)
		.sort((a, b) => {
			const depthDelta = (depths.get(a.id) ?? 0) - (depths.get(b.id) ?? 0);
			if (depthDelta !== 0) return depthDelta;
			return bboxArea(a) - bboxArea(b);
		});
}

function bboxArea(region: GeofabrikRegion): number {
	const { bbox } = region;
	return (
		Math.max(0, bbox.maxLng - bbox.minLng) *
		Math.max(0, bbox.maxLat - bbox.minLat)
	);
}

// Fetch the index with an on-disk cache so a cold app start does not hit
// Geofabrik and a Geofabrik outage does not disable routing.
export async function loadGeofabrikIndex(params: {
	fetch: typeof fetch;
	cachePath: string;
	maxAgeMs?: number;
	indexUrl?: string;
	now?: () => number;
}): Promise<GeofabrikIndex> {
	const now = params.now ?? Date.now;
	const maxAgeMs = params.maxAgeMs ?? DEFAULT_INDEX_MAX_AGE_MS;
	const cached = await readCachedIndex(params.cachePath);
	if (cached && now() - cached.mtimeMs < maxAgeMs) {
		return parseGeofabrikIndex(cached.json, cached.mtimeMs);
	}
	try {
		const res = await params.fetch(params.indexUrl ?? GEOFABRIK_INDEX_URL, {
			headers: { accept: "application/json", "user-agent": "AlfyAI" },
		});
		if (!res.ok) throw new Error(`Geofabrik index fetch failed: ${res.status}`);
		const text = await res.text();
		const parsed = parseGeofabrikIndex(JSON.parse(text), now());
		if (parsed.regions.length === 0) {
			throw new Error("Geofabrik index contained no usable regions");
		}
		await mkdir(dirname(params.cachePath), { recursive: true });
		await writeFile(params.cachePath, text, "utf8");
		return parsed;
	} catch (error) {
		if (cached) {
			return parseGeofabrikIndex(cached.json, cached.mtimeMs);
		}
		throw error;
	}
}

async function readCachedIndex(
	cachePath: string,
): Promise<{ json: unknown; mtimeMs: number } | null> {
	try {
		const info = await stat(cachePath);
		const text = await readFile(cachePath, "utf8");
		return { json: JSON.parse(text), mtimeMs: info.mtimeMs };
	} catch {
		return null;
	}
}

// Filesystem-safe slug for a region id ("europe/germany/bayern" → "germany-bayern").
export function regionSlug(id: string): string {
	return id
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
