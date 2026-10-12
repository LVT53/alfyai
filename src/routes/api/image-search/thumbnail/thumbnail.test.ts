import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	noteToolEntrySources,
	resetUrlProvenanceForTests,
} from "$lib/server/services/url-provenance";
import { GET } from "./+server";

// The chat shows an image_search picture as Brave's 500 px thumbnail, fetched by
// THIS server and handed to the page from its own origin, so the page itself
// never calls a host a search result named (docs/plans/exfil-channels). The route
// is a narrow door: only an address a search returned to this user, only Brave's
// image proxy, no redirects, a short wait, a small body, a real image.

const THUMB =
	"https://imgs.search.brave.com/Zq3s9x/rs:fit:500:0:0:0/g:ce/aHR0cHM6Ly9leGFtcGxlLmNvbS9jYXQuanBn";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

function imageResponse(
	body: Uint8Array | string = PNG,
	contentType: string | null = "image/png",
	init: ResponseInit = {},
): Response {
	return new Response(typeof body === "string" ? body : new Uint8Array(body), {
		status: 200,
		...init,
		headers: {
			...(contentType ? { "content-type": contentType } : {}),
			...(init.headers as Record<string, string> | undefined),
		},
	});
}

describe("GET /api/image-search/thumbnail", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		resetUrlProvenanceForTests();
		fetchMock.mockReset();
		fetchMock.mockImplementation(async () => imageResponse());
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	async function expectNotFound(response: Response) {
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("");
		expect(response.headers.get("cache-control")).toBe("no-store");
	}

	it("serves the thumbnail a search returned to this user, from this origin, as an inert image", async () => {
		listThumbnail();

		const response = await GET(eventFor(THUMB));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [address, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(address).toBe(THUMB);
		expect(init.redirect).toBe("error");
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(init).not.toHaveProperty("credentials", "include");
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

	it("serves each of the five raster types a thumbnail comes in, and says which it is", async () => {
		listThumbnail();
		for (const type of [
			"image/jpeg",
			"image/png",
			"image/webp",
			"image/gif",
			"image/avif",
		]) {
			fetchMock.mockImplementationOnce(async () =>
				imageResponse(PNG, `${type}; charset=binary`),
			);

			const response = await GET(eventFor(THUMB));

			expect(response.status, type).toBe(200);
			expect(response.headers.get("content-type"), type).toBe(type);
		}
	});

	it("never calls out for an address that is not on Brave's image proxy, even when a tool returned it", async () => {
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
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("never calls out for a Brave address no search returned to this user, whatever it wraps", async () => {
		listThumbnail();
		const forged = `${THUMB.slice(0, THUMB.lastIndexOf("/"))}/aHR0cHM6Ly9ldmlsLmV4YW1wbGUvP2Q9c2VjcmV0`;

		await expectNotFound(await GET(eventFor(forged)));
		await expectNotFound(await GET(eventFor(`${THUMB}?x=1`)));
		await expectNotFound(await GET(eventFor(`${THUMB}/`)));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("asks Brave for the address a search returned, whatever fragment the page adds", async () => {
		listThumbnail();

		const response = await GET(eventFor(`${THUMB}#ignored`));

		expect(response.status).toBe(200);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(THUMB);
	});

	it("does not serve a thumbnail another user's search returned", async () => {
		listThumbnail("user-2");

		await expectNotFound(await GET(eventFor(THUMB, { id: "user-1" })));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("is refused without a session", async () => {
		listThumbnail();

		await expect(GET(eventFor(THUMB, null))).rejects.toMatchObject({
			status: 401,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("serves only images: not SVG, not HTML, not a body with no type", async () => {
		listThumbnail();
		for (const type of [
			"image/svg+xml",
			"text/html",
			"application/octet-stream",
			"application/json",
			"image/x-icon",
			"image/bmp",
			"",
		]) {
			fetchMock.mockImplementationOnce(async () =>
				imageResponse("<svg onload=alert(1)>", type || null),
			);

			await expectNotFound(await GET(eventFor(THUMB)));
		}
	});

	it("serves nothing for an empty body or an upstream error", async () => {
		listThumbnail();
		fetchMock.mockImplementationOnce(async () =>
			imageResponse(new Uint8Array()),
		);
		await expectNotFound(await GET(eventFor(THUMB)));

		for (const status of [301, 403, 404, 500]) {
			fetchMock.mockImplementationOnce(
				async () => new Response("no", { status }),
			);
			await expectNotFound(await GET(eventFor(THUMB)));
		}
	});

	it("serves nothing when the upstream redirects, refuses, or takes too long", async () => {
		listThumbnail();
		for (const failure of [
			new TypeError("fetch failed", {
				cause: new Error("unexpected redirect"),
			}),
			Object.assign(new Error("The operation was aborted due to timeout"), {
				name: "TimeoutError",
			}),
			new Error("ECONNRESET"),
		]) {
			fetchMock.mockImplementationOnce(async () => {
				throw failure;
			});
			await expectNotFound(await GET(eventFor(THUMB)));
		}
	});

	it("refuses a body over 2 MB, whether or not it says how long it is", async () => {
		listThumbnail();
		const big = new Uint8Array(2 * 1024 * 1024 + 1);

		fetchMock.mockImplementationOnce(async () =>
			imageResponse(big, "image/png"),
		);
		await expectNotFound(await GET(eventFor(THUMB)));

		fetchMock.mockImplementationOnce(async () => {
			const response = imageResponse(PNG, "image/png", {
				headers: { "content-length": String(big.byteLength) },
			});
			return response;
		});
		await expectNotFound(await GET(eventFor(THUMB)));

		// A stream that never says its size and never ends is cut off at the cap.
		let sent = 0;
		fetchMock.mockImplementationOnce(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							sent += 64 * 1024;
							controller.enqueue(new Uint8Array(64 * 1024));
						},
					}),
					{ status: 200, headers: { "content-type": "image/png" } },
				),
		);
		await expectNotFound(await GET(eventFor(THUMB)));
		expect(sent).toBeLessThan(4 * 1024 * 1024);
	});

	it("serves a body exactly at the cap", async () => {
		listThumbnail();
		const exact = new Uint8Array(2 * 1024 * 1024);
		fetchMock.mockImplementationOnce(async () =>
			imageResponse(exact, "image/webp"),
		);

		const response = await GET(eventFor(THUMB));

		expect(response.status).toBe(200);
		expect((await response.arrayBuffer()).byteLength).toBe(exact.byteLength);
	});

	it("puts no address in any log line", async () => {
		const logs = [
			vi.spyOn(console, "log").mockImplementation(() => {}),
			vi.spyOn(console, "info").mockImplementation(() => {}),
			vi.spyOn(console, "warn").mockImplementation(() => {}),
			vi.spyOn(console, "error").mockImplementation(() => {}),
		];
		listThumbnail();
		fetchMock.mockImplementationOnce(async () => {
			throw new Error(`failed ${THUMB}`);
		});

		await GET(eventFor(THUMB));
		await GET(eventFor("https://evil.example/collect?d=secret"));

		for (const log of logs) {
			expect(JSON.stringify(log.mock.calls)).not.toContain("brave");
			expect(JSON.stringify(log.mock.calls)).not.toContain("evil");
		}
	});
});
