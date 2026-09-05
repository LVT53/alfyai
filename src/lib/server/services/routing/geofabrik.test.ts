import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	findRegionsForPoint,
	loadGeofabrikIndex,
	parseGeofabrikIndex,
	regionContainsPoint,
	regionDepth,
	regionSlug,
} from "./geofabrik";

const fixturePath = join(
	__dirname,
	"__fixtures__",
	"geofabrik-index.sample.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const index = parseGeofabrikIndex(fixture, 0);

const BUDAPEST = { lat: 47.4979, lng: 19.0402 };
const DUBLIN_AIRPORT = { lat: 53.4269, lng: -6.2474 };
const MUNICH = { lat: 48.1351, lng: 11.582 };
const MID_ATLANTIC = { lat: 30, lng: -40 };

describe("geofabrik index", () => {
	it("parses features into regions with bboxes and a by-id map", () => {
		expect(index.regions.length).toBe(8);
		const hungary = index.byId.get("hungary");
		expect(hungary?.name).toBe("Hungary");
		expect(hungary?.parent).toBe("europe");
		expect(hungary?.pbfUrl).toContain("hungary-latest.osm.pbf");
		expect(hungary?.bbox.minLng).toBeLessThan(19);
		expect(hungary?.bbox.maxLng).toBeGreaterThan(19);
	});

	it("skips malformed features instead of failing", () => {
		const parsed = parseGeofabrikIndex({
			features: [
				{ properties: { id: "x" } },
				{
					properties: { id: "y", name: "Y", urls: { pbf: "u" } },
					geometry: { type: "Point" },
				},
			],
		});
		expect(parsed.regions).toEqual([]);
	});

	it("does point-in-polygon on MultiPolygon geometry", () => {
		const hungary = index.byId.get("hungary");
		if (!hungary) throw new Error("fixture missing hungary");
		expect(regionContainsPoint(hungary, BUDAPEST)).toBe(true);
		expect(regionContainsPoint(hungary, DUBLIN_AIRPORT)).toBe(false);
	});

	it("computes depth from the parent chain", () => {
		expect(regionDepth(index, index.byId.get("europe") as never)).toBe(0);
		expect(regionDepth(index, index.byId.get("hungary") as never)).toBe(1);
		expect(regionDepth(index, index.byId.get("bayern") as never)).toBe(2);
	});

	it("orders matches country-first and never returns continents", () => {
		expect(findRegionsForPoint(index, BUDAPEST).map((r) => r.id)).toEqual([
			"hungary",
		]);
		const munich = findRegionsForPoint(index, MUNICH).map((r) => r.id);
		expect(munich[0]).toBe("germany");
		expect(munich).toContain("bayern");
		expect(munich).not.toContain("europe");
		// Same depth: the smaller extract wins the tie-break.
		const dublin = findRegionsForPoint(index, DUBLIN_AIRPORT).map((r) => r.id);
		expect(dublin).toEqual([
			"ireland-and-northern-ireland",
			"britain-and-ireland",
		]);
		expect(findRegionsForPoint(index, MID_ATLANTIC)).toEqual([]);
	});

	it("builds filesystem-safe slugs", () => {
		expect(regionSlug("ireland-and-northern-ireland")).toBe(
			"ireland-and-northern-ireland",
		);
		expect(regionSlug("Some/Odd Id!")).toBe("some-odd-id");
	});
});

describe("loadGeofabrikIndex", () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	it("fetches, caches on disk, and serves from cache while fresh", async () => {
		dir = mkdtempSync(join(tmpdir(), "alfyai-geofabrik-"));
		const cachePath = join(dir, "index.json");
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify(fixture), { status: 200 }),
			);
		let now = 1_000_000;
		const first = await loadGeofabrikIndex({
			fetch: fetchMock,
			cachePath,
			now: () => now,
		});
		expect(first.regions.length).toBe(8);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		now += 1000;
		const second = await loadGeofabrikIndex({
			fetch: fetchMock,
			cachePath,
			now: () => Date.now() + 1000,
		});
		expect(second.regions.length).toBe(8);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("falls back to the stale cache when the network fails", async () => {
		dir = mkdtempSync(join(tmpdir(), "alfyai-geofabrik-"));
		const cachePath = join(dir, "index.json");
		const okFetch = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify(fixture), { status: 200 }),
			);
		await loadGeofabrikIndex({ fetch: okFetch, cachePath });
		const failingFetch = vi.fn().mockRejectedValue(new Error("offline"));
		const stale = await loadGeofabrikIndex({
			fetch: failingFetch,
			cachePath,
			maxAgeMs: 0,
		});
		expect(stale.regions.length).toBe(8);
	});
});
