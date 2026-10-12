import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({ braveSearchApiKey: "brave-key" })),
}));

import { fetchBraveThumbnail, searchImages } from "./image-search";

// Brave's image search puts the resized copy at `thumbnail.src` (the response
// schema has no `thumbnail.url`), the picture's own address at `properties.url`
// and the page it sits on at `url`. The code used to read `thumbnail.url`, so a
// result never had a thumbnail, and the chat could not show a search picture at
// all once the page stopped loading remote images (docs/plans/exfil-channels).

const THUMB =
	"https://imgs.search.brave.com/Zq3s9x/rs:fit:500:0:0:0/g:ce/aHR0cHM6Ly9leGFtcGxlLmNvbS9jYXQuanBn";

const braveResult = {
	type: "image_result",
	title: "A cat",
	url: "https://page.example/cats",
	source: "page.example",
	page_fetched: "2026-01-01T00:00:00Z",
	thumbnail: { src: THUMB, width: 500, height: 333 },
	properties: {
		url: "https://pics.example/cat.jpg",
		placeholder: "https://imgs.search.brave.com/placeholder",
		width: 1200,
		height: 800,
	},
	meta_url: { hostname: "page.example" },
	confidence: "high",
};

describe("searchImages", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("reads the thumbnail from `thumbnail.src` and the picture from `properties.url`", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ results: [braveResult] }), { status: 200 }),
		);

		const results = await searchImages("cat");

		expect(results).toEqual([
			{
				url: "https://pics.example/cat.jpg",
				title: "A cat",
				source: "https://page.example/cats",
				thumbnail: THUMB,
				width: 1200,
				height: 800,
			},
		]);
	});

	it("leaves the thumbnail out when the result has none, rather than inventing one", async () => {
		const { thumbnail: _omitted, ...withoutThumbnail } = braveResult;
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						withoutThumbnail,
						{ ...braveResult, thumbnail: { src: "" } },
						{ ...braveResult, thumbnail: { src: 42 } },
						{ ...braveResult, thumbnail: { url: THUMB } },
					],
				}),
				{ status: 200 },
			),
		);

		const results = await searchImages("cat");

		expect(results).toHaveLength(4);
		for (const result of results) expect(result.thumbnail).toBeUndefined();
	});

	it("falls back to the page address when a result has no picture address", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [{ ...braveResult, properties: { width: 10, height: 10 } }],
				}),
				{ status: 200 },
			),
		);

		const [result] = await searchImages("cat");

		expect(result?.url).toBe("https://page.example/cats");
	});

	it("sends the key to Brave, not anywhere else", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ results: [] }), { status: 200 }),
		);

		await searchImages("golden retriever");

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toMatch(
			/^https:\/\/api\.search\.brave\.com\/res\/v1\/images\/search\?/,
		);
		expect(new URL(String(url)).searchParams.get("q")).toBe("golden retriever");
		expect((init as RequestInit).headers).toMatchObject({
			"X-Subscription-Token": "brave-key",
		});
	});
});

// The fetch of Brave's thumbnail, held to the limits that make a fetched file
// safe to serve: no redirect, a short wait, a small body, raster images only
// (never SVG, which can carry script). Every test hands the function its own
// `fetch`: a test that stubbed the global instead would stop intercepting the
// day the default fetch changes, and would then reach the network.
describe("fetchBraveThumbnail", () => {
	const fetchMock = vi.fn();
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
	const fetchThumbnail = (address: string) =>
		fetchBraveThumbnail(address, {
			fetch: fetchMock as unknown as typeof globalThis.fetch,
		});

	function imageResponse(
		body: Uint8Array | string = PNG,
		contentType: string | null = "image/png",
		init: ResponseInit = {},
	): Response {
		return new Response(
			typeof body === "string" ? body : new Uint8Array(body),
			{
				status: 200,
				...init,
				headers: {
					...(contentType ? { "content-type": contentType } : {}),
					...(init.headers as Record<string, string> | undefined),
				},
			},
		);
	}

	beforeEach(() => {
		fetchMock.mockReset();
		fetchMock.mockImplementation(async () => imageResponse());
	});

	it("fetches Brave's address without a redirect, a cookie or a fragment, and returns the bytes and type", async () => {
		const result = await fetchThumbnail(`${THUMB}#ignored`);

		expect(result).toEqual({ bytes: PNG, contentType: "image/png" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [address, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(address).toBe(THUMB);
		expect(init.redirect).toBe("manual");
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(init.credentials).toBeUndefined();
		expect(init.headers).not.toHaveProperty("cookie");
	});

	it("never fetches an address that is not on Brave's image proxy", async () => {
		for (const address of [
			"https://example.com/cat.jpg",
			"https://evil.example/collect?d=secret",
			"http://imgs.search.brave.com/sig/abc",
			"https://imgs.search.brave.com:8443/sig/abc",
			"https://imgs.search.brave.com.evil.example/sig/abc",
			"https://user@imgs.search.brave.com/sig/abc",
			"javascript:alert(1)",
			"not a url",
			"",
		]) {
			await expect(fetchThumbnail(address)).resolves.toBeNull();
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns each of the five raster types a thumbnail comes in, with the parameters taken off the type", async () => {
		for (const type of [
			"image/jpeg",
			"image/png",
			"image/webp",
			"image/gif",
			"image/avif",
		]) {
			fetchMock.mockImplementationOnce(async () =>
				imageResponse(PNG, `${type.toUpperCase()}; charset=binary`),
			);

			await expect(fetchThumbnail(THUMB)).resolves.toEqual({
				bytes: PNG,
				contentType: type,
			});
		}
	});

	it("returns nothing for anything but a raster image: not SVG, not HTML, not a body with no type", async () => {
		for (const type of [
			"image/svg+xml",
			"text/html",
			"application/octet-stream",
			"application/json",
			"image/x-icon",
			"image/bmp",
			"image/tiff",
			"",
		]) {
			fetchMock.mockImplementationOnce(async () =>
				imageResponse("<svg onload=alert(1)>", type || null),
			);

			await expect(fetchThumbnail(THUMB), type).resolves.toBeNull();
		}
	});

	it("returns nothing for an empty body or an upstream that did not answer 200", async () => {
		fetchMock.mockImplementationOnce(async () =>
			imageResponse(new Uint8Array()),
		);
		await expect(fetchThumbnail(THUMB)).resolves.toBeNull();

		for (const status of [301, 403, 404, 500]) {
			fetchMock.mockImplementationOnce(
				async () => new Response("no", { status }),
			);
			await expect(fetchThumbnail(THUMB), String(status)).resolves.toBeNull();
		}
	});

	it("returns nothing, and says nothing about why, when the fetch fails, redirects or takes too long", async () => {
		for (const failure of [
			new TypeError("fetch failed", {
				cause: new Error("unexpected redirect"),
			}),
			Object.assign(new Error("The operation was aborted due to timeout"), {
				name: "TimeoutError",
			}),
			new Error(`ECONNRESET ${THUMB}`),
		]) {
			fetchMock.mockImplementationOnce(async () => {
				throw failure;
			});

			await expect(fetchThumbnail(THUMB)).resolves.toBeNull();
		}
	});

	it("does not follow a redirect it is answered with: the 3xx is a failure", async () => {
		fetchMock.mockImplementationOnce(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: "https://evil.example/collect?d=secret" },
				}),
		);

		await expect(fetchThumbnail(THUMB)).resolves.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("refuses a body over 2 MB, whether or not it says how long it is", async () => {
		const big = new Uint8Array(2 * 1024 * 1024 + 1);

		fetchMock.mockImplementationOnce(async () =>
			imageResponse(big, "image/png"),
		);
		await expect(fetchThumbnail(THUMB)).resolves.toBeNull();

		fetchMock.mockImplementationOnce(async () =>
			imageResponse(PNG, "image/png", {
				headers: { "content-length": String(big.byteLength) },
			}),
		);
		await expect(fetchThumbnail(THUMB)).resolves.toBeNull();

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
		await expect(fetchThumbnail(THUMB)).resolves.toBeNull();
		expect(sent).toBeLessThan(4 * 1024 * 1024);
	});

	it("returns a body exactly at the cap", async () => {
		const exact = new Uint8Array(2 * 1024 * 1024);
		fetchMock.mockImplementationOnce(async () =>
			imageResponse(exact, "image/webp"),
		);

		const result = await fetchThumbnail(THUMB);

		expect(result?.contentType).toBe("image/webp");
		expect(result?.bytes.byteLength).toBe(exact.byteLength);
	});
});
