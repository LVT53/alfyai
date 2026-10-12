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

// The route that serves a thumbnail is held to these limits by its own tests
// (api/image-search/thumbnail); these pin the fetch itself, which the route
// leaves to this function.
describe("fetchBraveThumbnail", () => {
	const fetchMock = vi.fn();
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

	beforeEach(() => {
		fetchMock.mockReset();
		fetchMock.mockImplementation(
			async () =>
				new Response(new Uint8Array(PNG), {
					status: 200,
					headers: { "content-type": "image/png" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("fetches Brave's address without a redirect, a cookie or a fragment, and returns the bytes and type", async () => {
		const result = await fetchBraveThumbnail(`${THUMB}#ignored`);

		expect(result).toEqual({ bytes: PNG, contentType: "image/png" });
		const [address, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(address).toBe(THUMB);
		expect(init.redirect).toBe("error");
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(init.credentials).toBeUndefined();
		expect(init.headers).not.toHaveProperty("cookie");
	});

	it("never fetches an address that is not on Brave's image proxy", async () => {
		for (const address of [
			"https://example.com/cat.jpg",
			"http://imgs.search.brave.com/sig/abc",
			"https://imgs.search.brave.com.evil.example/sig/abc",
			"not a url",
			"",
		]) {
			await expect(fetchBraveThumbnail(address)).resolves.toBeNull();
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("answers null, and nothing about why, when the fetch fails or the answer is not a small raster image", async () => {
		fetchMock.mockRejectedValueOnce(new Error(`failed ${THUMB}`));
		await expect(fetchBraveThumbnail(THUMB)).resolves.toBeNull();

		fetchMock.mockResolvedValueOnce(
			new Response("<svg onload=alert(1)>", {
				status: 200,
				headers: { "content-type": "image/svg+xml" },
			}),
		);
		await expect(fetchBraveThumbnail(THUMB)).resolves.toBeNull();

		fetchMock.mockResolvedValueOnce(
			new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
				status: 200,
				headers: { "content-type": "image/png" },
			}),
		);
		await expect(fetchBraveThumbnail(THUMB)).resolves.toBeNull();
	});
});
