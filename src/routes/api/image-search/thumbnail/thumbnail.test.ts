import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/image-search", () => ({
	fetchBraveThumbnail: vi.fn(),
}));

import { fetchBraveThumbnail } from "$lib/server/services/image-search";
import {
	noteToolEntrySources,
	resetUrlProvenanceForTests,
} from "$lib/server/services/url-provenance";
import {
	BRAVE_THUMBNAIL_HOST,
	IMAGE_THUMBNAIL_ROUTE,
	imageThumbnailRouteUrl,
} from "$lib/shared/url-provenance";
import { GET } from "./+server";

// The chat shows an image_search picture as Brave's 500 px thumbnail, fetched by
// THIS server and handed to the page from its own origin, so the page itself
// never calls a host a search result named (docs/plans/exfil-channels). The route
// is a narrow door: only an address a search returned to this user, and only on
// Brave's image proxy. What the fetch itself refuses (a redirect, a long wait, a
// large body, anything but a raster image) is `fetchBraveThumbnail`'s, held by its
// own tests in image-search.test.ts; the fetch is mocked here, so nothing in this
// file can reach the network.

const THUMB = `https://${BRAVE_THUMBNAIL_HOST}/Zq3s9x/rs:fit:500:0:0:0/g:ce/aHR0cHM6Ly9leGFtcGxlLmNvbS9jYXQuanBn`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const fetchThumbnailMock = vi.mocked(fetchBraveThumbnail);
type ThumbnailEvent = Parameters<typeof GET>[0];

function eventFor(
	address: string | null,
	user: { id: string } | null = { id: "user-1" },
): ThumbnailEvent {
	const query = address === null ? "" : `?url=${encodeURIComponent(address)}`;
	const url = `http://localhost/api/image-search/thumbnail${query}`;
	return {
		url: new URL(url),
		request: new Request(url),
		locals: { user },
	} as unknown as ThumbnailEvent;
}

function listThumbnail(userId = "user-1", thumbnail = THUMB) {
	noteToolEntrySources(userId, {
		name: "image_search",
		input: { query: "cat" },
		status: "done",
		candidates: [
			{
				id: "c1",
				title: "Cat",
				url: "https://example.com/cat.jpg",
				sourceType: "web",
				metadata: { thumbnail },
			},
		],
	});
}

describe("GET /api/image-search/thumbnail", () => {
	beforeEach(() => {
		resetUrlProvenanceForTests();
		fetchThumbnailMock.mockReset();
		fetchThumbnailMock.mockResolvedValue({
			bytes: PNG,
			contentType: "image/png",
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function expectNotFound(response: Response) {
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("");
		expect(response.headers.get("cache-control")).toBe("no-store");
	}

	it("is the route the shared contract names, asked the way the page asks it", async () => {
		// The page builds the address with `imageThumbnailRouteUrl` and the server
		// reads it here: the two must name the same route and the same parameter.
		expect(
			existsSync(
				resolve(process.cwd(), `src/routes${IMAGE_THUMBNAIL_ROUTE}/+server.ts`),
			),
		).toBe(true);
		listThumbnail();
		const asked = new URL(imageThumbnailRouteUrl(THUMB), "http://localhost");

		const response = await GET({
			url: asked,
			request: new Request(asked),
			locals: { user: { id: "user-1" } },
		} as unknown as ThumbnailEvent);

		expect(response.status).toBe(200);
		expect(fetchThumbnailMock).toHaveBeenCalledWith(THUMB);
	});

	it("serves the thumbnail a search returned to this user, from this origin, as an inert image", async () => {
		listThumbnail();

		const response = await GET(eventFor(THUMB));

		expect(fetchThumbnailMock).toHaveBeenCalledTimes(1);
		expect(fetchThumbnailMock).toHaveBeenCalledWith(THUMB);
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("cache-control")).toBe(
			"private, max-age=86400",
		);
		expect(response.headers.get("content-security-policy")).toBe(
			"default-src 'none'; sandbox",
		);
		expect(response.headers.get("cross-origin-resource-policy")).toBe(
			"same-origin",
		);
	});

	it("says which of the raster types it is serving", async () => {
		listThumbnail();
		for (const contentType of [
			"image/jpeg",
			"image/png",
			"image/webp",
			"image/gif",
			"image/avif",
		] as const) {
			fetchThumbnailMock.mockResolvedValueOnce({ bytes: PNG, contentType });

			const response = await GET(eventFor(THUMB));

			expect(response.headers.get("content-type"), contentType).toBe(
				contentType,
			);
		}
	});

	it("never asks for an address that is not on Brave's image proxy, even when a tool returned it", async () => {
		const others = [
			"https://example.com/cat.jpg",
			"https://evil.example/collect?d=secret",
			"http://imgs.search.brave.com/Zq3s9x/rs:fit:500:0:0:0/g:ce/abc",
			"https://imgs.search.brave.com:8443/Zq3s9x/abc",
			"https://imgs.search.brave.com.evil.example/Zq3s9x/abc",
			"https://user@imgs.search.brave.com/Zq3s9x/abc",
			"/api/image-search/thumbnail?url=x",
			"javascript:alert(1)",
			"",
		];
		for (const other of others) listThumbnail("user-1", other);

		for (const other of others) {
			await expectNotFound(await GET(eventFor(other)));
		}
		await expectNotFound(await GET(eventFor(null)));
		expect(fetchThumbnailMock).not.toHaveBeenCalled();
	});

	it("never asks for a Brave address no search returned to this user, whatever it wraps", async () => {
		listThumbnail();
		const forged = `${THUMB.slice(0, THUMB.lastIndexOf("/"))}/aHR0cHM6Ly9ldmlsLmV4YW1wbGUvP2Q9c2VjcmV0`;

		await expectNotFound(await GET(eventFor(forged)));
		await expectNotFound(await GET(eventFor(`${THUMB}?x=1`)));
		await expectNotFound(await GET(eventFor(`${THUMB}/`)));
		expect(fetchThumbnailMock).not.toHaveBeenCalled();
	});

	it("serves the address a search returned whatever fragment the page adds", async () => {
		listThumbnail();

		const response = await GET(eventFor(`${THUMB}#ignored`));

		expect(response.status).toBe(200);
		expect(fetchThumbnailMock).toHaveBeenCalledTimes(1);
	});

	it("does not serve a thumbnail another user's search returned", async () => {
		listThumbnail("user-2");

		await expectNotFound(await GET(eventFor(THUMB, { id: "user-1" })));
		expect(fetchThumbnailMock).not.toHaveBeenCalled();
	});

	it("is refused without a session", async () => {
		listThumbnail();

		await expect(GET(eventFor(THUMB, null))).rejects.toMatchObject({
			status: 401,
		});
		expect(fetchThumbnailMock).not.toHaveBeenCalled();
	});

	it("is a bare 404 when the fetch gave nothing to serve", async () => {
		listThumbnail();
		fetchThumbnailMock.mockResolvedValueOnce(null);

		await expectNotFound(await GET(eventFor(THUMB)));
	});

	it("is a bare 404, and logs no address, even if the fetch were ever to throw", async () => {
		const logs = [
			vi.spyOn(console, "log").mockImplementation(() => {}),
			vi.spyOn(console, "info").mockImplementation(() => {}),
			vi.spyOn(console, "warn").mockImplementation(() => {}),
			vi.spyOn(console, "error").mockImplementation(() => {}),
		];
		listThumbnail();
		fetchThumbnailMock.mockRejectedValueOnce(new Error(`failed ${THUMB}`));

		await expectNotFound(await GET(eventFor(THUMB)));
		await expectNotFound(
			await GET(eventFor("https://evil.example/collect?d=secret")),
		);

		for (const log of logs) {
			expect(JSON.stringify(log.mock.calls)).not.toContain("brave");
			expect(JSON.stringify(log.mock.calls)).not.toContain("evil");
		}
	});
});
