// Disk cache for the map_route inline card's tile proxy
// (GET /api/map-tiles/[z]/[x]/[y]). There is no self-hosted tile server, so
// the route (src/routes/api/map-tiles/[z]/[x]/[y]/+server.ts) proxies OSM's
// standard raster tiles and this module is the caching half: sanitizing the
// requested coordinates (path-traversal / range guard), reading/writing the
// on-disk cache, and pruning it to stay within OSM's tile usage policy
// (cache, don't hammer the tile server) and a hard 2GB/30-day budget.
//
// Swapping to a self-hosted tile server later only needs the upstream base
// URL changed (config.mapTileUpstreamBaseUrl) — this cache and the route
// handler are server-agnostic.

import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

// Standard XYZ raster tiles top out well before z20 in practice; OSM's own
// tile server serves up to z19. Capping here rejects an absurd zoom before it
// ever reaches a filesystem path or an upstream request.
export const MAP_TILE_MAX_ZOOM = 19;
export const MAP_TILE_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
export const MAP_TILE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type TileCoords = { z: number; x: number; y: number };

function parseStrictNonNegativeInt(value: string): number | null {
	// Digits only — rejects "..", "-1", "1e5", whitespace, and anything else
	// that isn't a plain decimal integer, so a sanitized coordinate can never
	// carry a path-traversal segment into tileFilePath.
	if (!/^\d+$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

// Validates z/x/y route params (raw strings from the URL) into safe integer
// tile coordinates. Rejects: non-digit input (path traversal, decimals,
// signs), a zoom outside [0, MAP_TILE_MAX_ZOOM], and an x/y outside the
// valid range for that zoom (a standard XYZ tile grid is 2^z tiles per axis).
export function sanitizeTileCoords(params: {
	z: string;
	x: string;
	y: string;
}): TileCoords | null {
	const z = parseStrictNonNegativeInt(params.z);
	if (z === null || z < 0 || z > MAP_TILE_MAX_ZOOM) return null;
	const x = parseStrictNonNegativeInt(params.x);
	const y = parseStrictNonNegativeInt(params.y);
	if (x === null || y === null) return null;
	const maxIndex = 2 ** z - 1;
	if (x < 0 || x > maxIndex) return null;
	if (y < 0 || y > maxIndex) return null;
	return { z, x, y };
}

export function tileFilePath(cacheDir: string, coords: TileCoords): string {
	return join(cacheDir, String(coords.z), String(coords.x), `${coords.y}.png`);
}

// Returns the cached tile bytes, or null on a cache miss (including an
// expired entry — the caller re-fetches from upstream and overwrites it).
export async function readCachedTile(
	cacheDir: string,
	coords: TileCoords,
	maxAgeMs = MAP_TILE_CACHE_MAX_AGE_MS,
): Promise<Buffer | null> {
	const filePath = tileFilePath(cacheDir, coords);
	try {
		const stats = await stat(filePath);
		if (Date.now() - stats.mtimeMs > maxAgeMs) return null;
		return await readFile(filePath);
	} catch {
		return null;
	}
}

// Writes via a temp file + rename so a concurrent reader never observes a
// partially-written tile.
export async function writeCachedTile(
	cacheDir: string,
	coords: TileCoords,
	data: Uint8Array,
): Promise<void> {
	const filePath = tileFilePath(cacheDir, coords);
	await mkdir(join(cacheDir, String(coords.z), String(coords.x)), {
		recursive: true,
	});
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmpPath, data);
	await rename(tmpPath, filePath);
}

type TileCacheEntry = { path: string; size: number; mtimeMs: number };

// Lists a directory's entry NAMES only (never Dirent objects — @types/node's
// readdir overloads make the withFileTypes Dirent<T> generic awkward to
// annotate across a try/catch reassignment) plus a cheap isDirectory flag via
// a follow-up stat, since all we need from each entry here is its name and
// whether to recurse into it.
async function listDirNames(
	dirPath: string,
): Promise<Array<{ name: string; isDirectory: boolean }>> {
	let names: string[];
	try {
		names = await readdir(dirPath);
	} catch {
		return [];
	}
	const out: Array<{ name: string; isDirectory: boolean }> = [];
	for (const name of names) {
		try {
			const stats = await stat(join(dirPath, name));
			out.push({ name, isDirectory: stats.isDirectory() });
		} catch {
			// Raced with a concurrent delete — skip it.
		}
	}
	return out;
}

async function collectTileFiles(cacheDir: string): Promise<TileCacheEntry[]> {
	const out: TileCacheEntry[] = [];
	for (const zEntry of await listDirNames(cacheDir)) {
		if (!zEntry.isDirectory) continue;
		const zDir = join(cacheDir, zEntry.name);
		for (const xEntry of await listDirNames(zDir)) {
			if (!xEntry.isDirectory) continue;
			const xDir = join(zDir, xEntry.name);
			for (const yEntry of await listDirNames(xDir)) {
				if (yEntry.isDirectory || !yEntry.name.endsWith(".png")) continue;
				const filePath = join(xDir, yEntry.name);
				try {
					const stats = await stat(filePath);
					out.push({
						path: filePath,
						size: stats.size,
						mtimeMs: stats.mtimeMs,
					});
				} catch {
					// Raced with a concurrent delete — skip it.
				}
			}
		}
	}
	return out;
}

// Evicts (1) every tile older than maxAgeMs, then (2) the oldest remaining
// tiles (by mtime) until the total cache size is back under maxBytes. Cheap
// to call, but a full directory walk — callers should sample this (e.g. a
// small % of requests) rather than run it on every request.
export async function pruneTileCache(
	cacheDir: string,
	options: { maxBytes?: number; maxAgeMs?: number } = {},
): Promise<{ deletedFiles: number; freedBytes: number }> {
	const maxBytes = options.maxBytes ?? MAP_TILE_CACHE_MAX_BYTES;
	const maxAgeMs = options.maxAgeMs ?? MAP_TILE_CACHE_MAX_AGE_MS;
	const entries = await collectTileFiles(cacheDir);
	const now = Date.now();
	let deletedFiles = 0;
	let freedBytes = 0;
	const survivors: TileCacheEntry[] = [];
	for (const entry of entries) {
		if (now - entry.mtimeMs > maxAgeMs) {
			await rm(entry.path, { force: true });
			deletedFiles += 1;
			freedBytes += entry.size;
		} else {
			survivors.push(entry);
		}
	}
	let totalBytes = survivors.reduce((sum, entry) => sum + entry.size, 0);
	if (totalBytes > maxBytes) {
		survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
		for (const entry of survivors) {
			if (totalBytes <= maxBytes) break;
			await rm(entry.path, { force: true });
			totalBytes -= entry.size;
			deletedFiles += 1;
			freedBytes += entry.size;
		}
	}
	return { deletedFiles, freedBytes };
}

// Cheap sampling gate so the route handler doesn't walk the whole cache
// directory on every single tile request.
export function shouldPruneOpportunistically(sampleRate = 0.01): boolean {
	return Math.random() < sampleRate;
}
