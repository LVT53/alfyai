import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/env", () => ({
	config: {
		mapTilesDir: "/tmp/does-not-matter",
		mapTileUpstreamBaseUrl: "https://tile.openstreetmap.org",
		mapTileContact: "",
	},
}));

vi.mock("$lib/server/services/map-tiles/tile-cache", () => ({
	MAP_TILE_CACHE_MAX_AGE_MS: 1000,
	MAP_TILE_CACHE_MAX_BYTES: 1000,
	readCachedTile: vi.fn(),
	writeCachedTile: vi.fn(),
	pruneTileCache: vi.fn(),
	sanitizeTileCoords: vi.fn(),
	shouldPruneOpportunistically: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	pruneTileCache,
	readCachedTile,
	sanitizeTileCoords,
	shouldPruneOpportunistically,
	writeCachedTile,
} from "$lib/server/services/map-tiles/tile-cache";
import { GET } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockReadCachedTile = readCachedTile as ReturnType<typeof vi.fn>;
const mockWriteCachedTile = writeCachedTile as ReturnType<typeof vi.fn>;
const mockSanitizeTileCoords = sanitizeTileCoords as ReturnType<typeof vi.fn>;
const mockShouldPrune = shouldPruneOpportunistically as ReturnType<
	typeof vi.fn
>;
const mockPruneTileCache = pruneTileCache as ReturnType<typeof vi.fn>;

type TileEvent = Parameters<typeof GET>[0];

function makeEvent(params: { z: string; x: string; y: string }) {
	return {
		request: new Request(
			`http://localhost/api/map-tiles/${params.z}/${params.x}/${params.y}`,
		),
		locals: { user: { id: "user-1" } },
		params,
		url: new URL(
			`http://localhost/api/map-tiles/${params.z}/${params.x}/${params.y}`,
		),
		route: { id: "/api/map-tiles/[z]/[x]/[y]" },
	} as unknown as TileEvent;
}

describe("GET /api/map-tiles/[z]/[x]/[y]", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockShouldPrune.mockReturnValue(false);
		mockPruneTileCache.mockResolvedValue({ deletedFiles: 0, freedBytes: 0 });
		mockWriteCachedTile.mockResolvedValue(undefined);
		vi.stubGlobal("fetch", vi.fn());
	});

	it("requires auth", async () => {
		mockSanitizeTileCoords.mockReturnValue({ z: 1, x: 0, y: 0 });
		mockReadCachedTile.mockResolvedValue(new Uint8Array([1]));
		await GET(makeEvent({ z: "1", x: "0", y: "0.png" }));
		expect(mockRequireAuth).toHaveBeenCalledTimes(1);
	});

	it("rejects a y segment without the .png suffix", async () => {
		await expect(
			GET(makeEvent({ z: "1", x: "0", y: "0" })),
		).rejects.toMatchObject({
			status: 400,
		});
		expect(mockSanitizeTileCoords).not.toHaveBeenCalled();
	});

	it("rejects coordinates sanitizeTileCoords refuses (path traversal, out of range, etc.)", async () => {
		mockSanitizeTileCoords.mockReturnValue(null);
		await expect(
			GET(makeEvent({ z: "99", x: "0", y: "0.png" })),
		).rejects.toMatchObject({ status: 400 });
		expect(mockSanitizeTileCoords).toHaveBeenCalledWith({
			z: "99",
			x: "0",
			y: "0",
		});
	});

	it("serves a cached tile without touching the network", async () => {
		mockSanitizeTileCoords.mockReturnValue({ z: 5, x: 3, y: 2 });
		mockReadCachedTile.mockResolvedValue(new Uint8Array([7, 7, 7]));

		const response = await GET(makeEvent({ z: "5", x: "3", y: "2.png" }));

		expect(response.headers.get("Content-Type")).toBe("image/png");
		expect(response.headers.get("X-Tile-Cache")).toBe("hit");
		expect(fetch).not.toHaveBeenCalled();
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect(Array.from(bytes)).toEqual([7, 7, 7]);
	});

	it("fetches from upstream with an identifying User-Agent on a cache miss, then caches it", async () => {
		mockSanitizeTileCoords.mockReturnValue({ z: 5, x: 3, y: 2 });
		mockReadCachedTile.mockResolvedValue(null);
		const upstreamBytes = new Uint8Array([9, 9]);
		(fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			new Response(upstreamBytes, {
				status: 200,
				headers: { "Content-Type": "image/png" },
			}),
		);

		const response = await GET(makeEvent({ z: "5", x: "3", y: "2.png" }));

		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(url).toBe("https://tile.openstreetmap.org/5/3/2.png");
		expect(init.headers["User-Agent"]).toContain("AlfyAI");
		expect(response.headers.get("X-Tile-Cache")).toBe("miss");
		expect(mockWriteCachedTile).toHaveBeenCalledTimes(1);
		const [, , writtenBytes] = mockWriteCachedTile.mock.calls[0];
		expect(Array.from(writtenBytes as Uint8Array)).toEqual([9, 9]);
	});

	// `fetch` follows redirects, so a hijacked or misconfigured upstream can
	// answer 200 with an HTML page (a captive portal, an error page, an ISP
	// interstitial). Writing that into the 30-day disk cache and re-serving it
	// under a hardcoded "Content-Type: image/png" would pin attacker-chosen
	// bytes at a tile URL for every user of this deployment.
	it("refuses a 200 upstream response that is not an image, and does not cache it", async () => {
		mockSanitizeTileCoords.mockReturnValue({ z: 5, x: 3, y: 2 });
		mockReadCachedTile.mockResolvedValue(null);
		(fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			new Response("<html>Sign in to continue</html>", {
				status: 200,
				headers: { "Content-Type": "text/html" },
			}),
		);

		await expect(
			GET(makeEvent({ z: "5", x: "3", y: "2.png" })),
		).rejects.toMatchObject({ status: 502 });
		expect(mockWriteCachedTile).not.toHaveBeenCalled();
	});

	it("accepts an upstream image response whose Content-Type carries parameters", async () => {
		mockSanitizeTileCoords.mockReturnValue({ z: 5, x: 3, y: 2 });
		mockReadCachedTile.mockResolvedValue(null);
		(fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			new Response(new Uint8Array([1, 2]), {
				status: 200,
				headers: { "Content-Type": "image/png; charset=binary" },
			}),
		);

		const response = await GET(makeEvent({ z: "5", x: "3", y: "2.png" }));

		expect(response.headers.get("X-Tile-Cache")).toBe("miss");
		expect(mockWriteCachedTile).toHaveBeenCalledTimes(1);
	});

	it("sets nosniff on served tiles", async () => {
		mockSanitizeTileCoords.mockReturnValue({ z: 5, x: 3, y: 2 });
		mockReadCachedTile.mockResolvedValue(new Uint8Array([7]));

		const response = await GET(makeEvent({ z: "5", x: "3", y: "2.png" }));

		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	it("passes through a 404 from upstream instead of caching or erroring loudly", async () => {
		mockSanitizeTileCoords.mockReturnValue({ z: 5, x: 3, y: 2 });
		mockReadCachedTile.mockResolvedValue(null);
		(fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			new Response(null, { status: 404 }),
		);

		await expect(
			GET(makeEvent({ z: "5", x: "3", y: "2.png" })),
		).rejects.toMatchObject({ status: 404 });
		expect(mockWriteCachedTile).not.toHaveBeenCalled();
	});

	it("surfaces a non-404 upstream failure as a 502 without caching", async () => {
		mockSanitizeTileCoords.mockReturnValue({ z: 5, x: 3, y: 2 });
		mockReadCachedTile.mockResolvedValue(null);
		(fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			new Response(null, { status: 500 }),
		);

		await expect(
			GET(makeEvent({ z: "5", x: "3", y: "2.png" })),
		).rejects.toMatchObject({ status: 502 });
		expect(mockWriteCachedTile).not.toHaveBeenCalled();
	});

	it("surfaces a network error reaching upstream as a 502", async () => {
		mockSanitizeTileCoords.mockReturnValue({ z: 5, x: 3, y: 2 });
		mockReadCachedTile.mockResolvedValue(null);
		(fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("ECONNRESET"),
		);

		await expect(
			GET(makeEvent({ z: "5", x: "3", y: "2.png" })),
		).rejects.toMatchObject({ status: 502 });
	});

	it("opportunistically prunes the cache after a miss when sampled", async () => {
		mockSanitizeTileCoords.mockReturnValue({ z: 5, x: 3, y: 2 });
		mockReadCachedTile.mockResolvedValue(null);
		mockShouldPrune.mockReturnValue(true);
		(fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			new Response(new Uint8Array([1]), {
				status: 200,
				headers: { "Content-Type": "image/png" },
			}),
		);

		await GET(makeEvent({ z: "5", x: "3", y: "2.png" }));

		expect(mockPruneTileCache).toHaveBeenCalledTimes(1);
	});
});
