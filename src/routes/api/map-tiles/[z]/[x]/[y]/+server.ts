// Tile proxy for the inline map_route card (MapRouteCard.svelte via MapLibre
// GL). There is no self-hosted tile server yet, so this fetches OSM's
// standard raster tiles, caches them on disk (2GB/30-day cap — see
// tile-cache.ts), and serves the cached copy on repeat requests. Swapping to
// a self-hosted tile server later is a one-line change: point
// config.mapTileUpstreamBaseUrl at it instead of tile.openstreetmap.org.
//
// Respects OSM's tile usage policy: no bulk prefetching (this only ever
// fetches tiles a viewer's map actually requested), a caching layer so
// repeat views don't re-hit the upstream, and an identifying User-Agent
// with an optional contact. Attribution is rendered by the map card itself
// (MapRouteCard.svelte), not by this route.

import { error } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { config } from "$lib/server/env";
import {
	MAP_TILE_CACHE_MAX_AGE_MS,
	MAP_TILE_CACHE_MAX_BYTES,
	pruneTileCache,
	readCachedTile,
	sanitizeTileCoords,
	shouldPruneOpportunistically,
	writeCachedTile,
} from "$lib/server/services/map-tiles/tile-cache";
import type { RequestHandler } from "./$types";

// The URL's last segment is "<y>.png" as one literal path piece (no slash
// separates the coordinate from the extension), so `params.y` arrives as
// e.g. "512.png" and is split here rather than via a second route segment.
const Y_SEGMENT_RE = /^(\d+)\.png$/;

function buildUserAgent(): string {
	const contact = config.mapTileContact.trim();
	return contact ? `AlfyAI (contact: ${contact})` : "AlfyAI";
}

export const GET: RequestHandler = async (event) => {
	requireAuth(event);

	const yMatch = Y_SEGMENT_RE.exec(event.params.y ?? "");
	if (!yMatch) {
		throw error(400, "Invalid tile path");
	}
	const coords = sanitizeTileCoords({
		z: event.params.z ?? "",
		x: event.params.x ?? "",
		y: yMatch[1],
	});
	if (!coords) {
		throw error(400, "Invalid tile coordinates");
	}

	const cacheDir = config.mapTilesDir;
	const cached = await readCachedTile(cacheDir, coords);
	if (cached) {
		// A fresh Uint8Array (not narrowed from the `Buffer | null` return type)
		// — TS's control-flow narrowing of a generic Buffer<ArrayBufferLike>
		// return type otherwise fails to structurally match Response's
		// BodyInit even though a directly-inlined `readFile()` result does.
		return new Response(new Uint8Array(cached), {
			headers: {
				"Content-Type": "image/png",
				"Cache-Control": "public, max-age=86400",
				"X-Tile-Cache": "hit",
			},
		});
	}

	const upstreamBase = config.mapTileUpstreamBaseUrl.replace(/\/+$/, "");
	const upstreamUrl = `${upstreamBase}/${coords.z}/${coords.x}/${coords.y}.png`;

	let upstreamResponse: Response;
	try {
		upstreamResponse = await fetch(upstreamUrl, {
			headers: { "User-Agent": buildUserAgent() },
		});
	} catch {
		throw error(502, "Tile upstream unreachable");
	}

	if (upstreamResponse.status === 404) {
		// Passthrough: an out-of-coverage / not-yet-rendered tile is a normal
		// 404 from the upstream, not a server error — never cache a miss.
		throw error(404, "Tile not found");
	}
	if (!upstreamResponse.ok) {
		throw error(502, "Tile upstream error");
	}

	const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
	// Cache best-effort: a disk write failure must not fail the response the
	// viewer is waiting on.
	await writeCachedTile(cacheDir, coords, buffer).catch(() => {});
	if (shouldPruneOpportunistically()) {
		void pruneTileCache(cacheDir, {
			maxBytes: MAP_TILE_CACHE_MAX_BYTES,
			maxAgeMs: MAP_TILE_CACHE_MAX_AGE_MS,
		}).catch(() => {});
	}

	return new Response(buffer, {
		headers: {
			"Content-Type": "image/png",
			"Cache-Control": "public, max-age=86400",
			"X-Tile-Cache": "miss",
		},
	});
};
