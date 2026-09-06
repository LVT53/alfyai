import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MAP_TILE_MAX_ZOOM,
	pruneTileCache,
	readCachedTile,
	sanitizeTileCoords,
	tileFilePath,
	writeCachedTile,
} from "./tile-cache";

describe("sanitizeTileCoords", () => {
	it("accepts a valid z/x/y triple", () => {
		expect(sanitizeTileCoords({ z: "10", x: "5", y: "3" })).toEqual({
			z: 10,
			x: 5,
			y: 3,
		});
	});

	it("accepts the boundary z=0 tile (the only valid x/y is 0)", () => {
		expect(sanitizeTileCoords({ z: "0", x: "0", y: "0" })).toEqual({
			z: 0,
			x: 0,
			y: 0,
		});
	});

	it("rejects a zoom above the configured max", () => {
		expect(
			sanitizeTileCoords({ z: String(MAP_TILE_MAX_ZOOM + 1), x: "0", y: "0" }),
		).toBeNull();
	});

	it("rejects a negative zoom", () => {
		expect(sanitizeTileCoords({ z: "-1", x: "0", y: "0" })).toBeNull();
	});

	it("rejects x/y outside the 2^z grid for the given zoom", () => {
		// z=2 => valid indices are 0..3
		expect(sanitizeTileCoords({ z: "2", x: "4", y: "0" })).toBeNull();
		expect(sanitizeTileCoords({ z: "2", x: "0", y: "4" })).toBeNull();
		expect(sanitizeTileCoords({ z: "2", x: "3", y: "3" })).toEqual({
			z: 2,
			x: 3,
			y: 3,
		});
	});

	it("rejects path-traversal and non-numeric segments", () => {
		expect(sanitizeTileCoords({ z: "1", x: "..", y: "0" })).toBeNull();
		expect(sanitizeTileCoords({ z: "1", x: "0/../../etc", y: "0" })).toBeNull();
		expect(sanitizeTileCoords({ z: "1", x: "0", y: "0.png" })).toBeNull();
		expect(sanitizeTileCoords({ z: "abc", x: "0", y: "0" })).toBeNull();
	});

	it("rejects signed/decimal/whitespace-padded numbers", () => {
		expect(sanitizeTileCoords({ z: "1", x: "+1", y: "0" })).toBeNull();
		expect(sanitizeTileCoords({ z: "1", x: "1.5", y: "0" })).toBeNull();
		expect(sanitizeTileCoords({ z: "1", x: " 1", y: "0" })).toBeNull();
	});
});

describe("tile disk cache", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "alfyai-map-tiles-test-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("round-trips a tile through write and read", async () => {
		const coords = { z: 5, x: 3, y: 2 };
		const bytes = new Uint8Array([1, 2, 3, 4]);
		await writeCachedTile(dir, coords, bytes);
		const read = await readCachedTile(dir, coords);
		expect(read).not.toBeNull();
		expect(Array.from(read ?? [])).toEqual([1, 2, 3, 4]);
	});

	it("stores the tile at z/x/y.png under the cache dir", async () => {
		const coords = { z: 7, x: 11, y: 13 };
		await writeCachedTile(dir, coords, new Uint8Array([9]));
		const expectedPath = tileFilePath(dir, coords);
		expect(expectedPath).toBe(join(dir, "7", "11", "13.png"));
		const stats = await stat(expectedPath);
		expect(stats.isFile()).toBe(true);
	});

	it("returns null (a cache miss) for a tile never written", async () => {
		const result = await readCachedTile(dir, { z: 1, x: 0, y: 0 });
		expect(result).toBeNull();
	});

	it("treats an expired tile as a miss without deleting it", async () => {
		const coords = { z: 2, x: 1, y: 1 };
		await writeCachedTile(dir, coords, new Uint8Array([5]));
		const filePath = tileFilePath(dir, coords);
		const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40 days ago
		await utimes(filePath, old, old);

		const result = await readCachedTile(dir, coords, 30 * 24 * 60 * 60 * 1000);
		expect(result).toBeNull();
		// Still on disk — readCachedTile itself never deletes; pruning does.
		await expect(readFile(filePath)).resolves.toBeInstanceOf(Buffer);
	});

	it("never partially exposes a tile being written (temp file + rename)", async () => {
		const coords = { z: 3, x: 2, y: 1 };
		await writeCachedTile(dir, coords, new Uint8Array([1, 2, 3]));
		// No stray .tmp files should remain after a successful write.
		const dirPath = join(dir, "3", "2");
		const entries = await import("node:fs/promises").then((m) =>
			m.readdir(dirPath),
		);
		expect(entries.every((name) => !name.endsWith(".tmp"))).toBe(true);
	});
});

describe("pruneTileCache", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "alfyai-map-tiles-prune-test-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("does nothing on a directory that doesn't exist yet", async () => {
		await rm(dir, { recursive: true, force: true });
		const result = await pruneTileCache(dir, {
			maxBytes: 10,
			maxAgeMs: 1000,
		});
		expect(result).toEqual({ deletedFiles: 0, freedBytes: 0 });
	});

	it("deletes tiles older than maxAgeMs and keeps fresh ones", async () => {
		const oldCoords = { z: 1, x: 0, y: 0 };
		const freshCoords = { z: 1, x: 0, y: 1 };
		await writeCachedTile(dir, oldCoords, new Uint8Array([1]));
		await writeCachedTile(dir, freshCoords, new Uint8Array([2]));
		const oldPath = tileFilePath(dir, oldCoords);
		const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
		await utimes(oldPath, old, old);

		const result = await pruneTileCache(dir, {
			maxBytes: Number.POSITIVE_INFINITY,
			maxAgeMs: 30 * 24 * 60 * 60 * 1000,
		});
		expect(result.deletedFiles).toBe(1);
		expect(await readCachedTile(dir, oldCoords)).toBeNull();
		expect(await readCachedTile(dir, freshCoords)).not.toBeNull();
	});

	it("evicts oldest-first once the cache exceeds the byte budget", async () => {
		const coordsA = { z: 1, x: 0, y: 0 };
		const coordsB = { z: 1, x: 0, y: 1 };
		const coordsC = { z: 1, x: 1, y: 0 };
		await writeCachedTile(dir, coordsA, new Uint8Array(10));
		await writeCachedTile(dir, coordsB, new Uint8Array(10));
		await writeCachedTile(dir, coordsC, new Uint8Array(10));
		// Make A oldest, then B, then C newest.
		const now = Date.now();
		await utimes(
			tileFilePath(dir, coordsA),
			new Date(now - 3000),
			new Date(now - 3000),
		);
		await utimes(
			tileFilePath(dir, coordsB),
			new Date(now - 2000),
			new Date(now - 2000),
		);
		await utimes(
			tileFilePath(dir, coordsC),
			new Date(now - 1000),
			new Date(now - 1000),
		);

		// Budget only fits one 10-byte tile.
		const result = await pruneTileCache(dir, {
			maxBytes: 15,
			maxAgeMs: Number.POSITIVE_INFINITY,
		});
		expect(result.deletedFiles).toBe(2);
		expect(await readCachedTile(dir, coordsA)).toBeNull();
		expect(await readCachedTile(dir, coordsB)).toBeNull();
		expect(await readCachedTile(dir, coordsC)).not.toBeNull();
	});
});
