import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({ parallelApiKey: "test-key" })),
}));

import { getConfig } from "$lib/server/config-store";
import {
	fetchPublisherThumbnail,
	ImageSearchNotConfiguredError,
	searchImages,
} from "./image-search";

const THUMB = "https://images.example.com/cat.png";

describe("searchImages", () => {
	const fetchMock = vi.fn<typeof fetch>();
	const signal = new AbortController().signal;
	const result = {
		title: "A cat",
		image_url: "https://cdn.example/cat.jpg",
		source_page_url: "https://page.example/cats",
		width: 1200,
		height: 800,
	};

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sends complementary local and international terms together in one Fast request", async () => {
		fetchMock.mockResolvedValue(Response.json({ results: [result] }));
		vi.mocked(getConfig).mockReturnValueOnce({
			parallelApiKey: "key",
			parallelBaseUrl: "https://test.example/",
		} as never);
		const input = {
			query: "Lánchíd",
			additionalQueries: ["Lánchíd", "Chain Bridge aerial photo"],
			objective: "Show the full span.",
		};
		const images = await searchImages(input, signal);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, options] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://test.example/v1/images/search");
		expect(options).toMatchObject({
			method: "POST",
			signal,
			redirect: "error",
			headers: { "x-api-key": "key" },
		});
		expect(JSON.parse(String(options?.body))).toEqual({
			search_queries: ["Lánchíd", "Chain Bridge aerial photo"],
			objective: "Show the full span.",
			mode: "fast",
			advanced_settings: { max_results: 5 },
		});
		expect(images).toEqual([
			{
				provider: "parallel",
				url: result.image_url,
				thumbnail: result.image_url,
				source: "page.example",
				sourcePageUrl: result.source_page_url,
				title: result.title,
				width: 1200,
				height: 800,
			},
		]);
	});

	it("accepts one query and drops malformed or unsafe provider addresses", async () => {
		fetchMock.mockResolvedValue(
			Response.json({
				results: [
					null,
					{ ...result, image_url: "data:image/png,xx" },
					{ ...result, source_page_url: "javascript:alert(1)" },
					result,
				],
			}),
		);
		expect(await searchImages({ query: "cat" }, signal)).toHaveLength(1);
		const [url, options] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.parallel.ai/v1/images/search");
		expect(JSON.parse(String(options?.body))).toEqual({
			search_queries: ["cat"],
			mode: "fast",
			advanced_settings: { max_results: 5 },
		});
	});

	it("preserves a long legacy query as the objective and counts Unicode code points", async () => {
		const localTerms = "Lánchíd Budapesten ".repeat(11).slice(0, 199);
		const primary = `${localTerms}🌉 naplementekor`;
		fetchMock.mockResolvedValue(Response.json({ results: [] }));
		await searchImages({ query: primary }, signal);
		const [, options] = fetchMock.mock.calls[0] ?? [];
		expect(JSON.parse(String(options?.body))).toMatchObject({
			search_queries: [`${localTerms}🌉`],
			objective: primary,
		});
	});

	it("drops local hosts and preserves an HTTP publisher source as a clickable link", async () => {
		fetchMock.mockResolvedValue(
			Response.json({
				results: [
					{ ...result, image_url: "https://127.0.0.1/original" },
					{ ...result, source_page_url: "https://intranet/doc" },
					{
						...result,
						image_url: "http://cdn.example/cat.jpg",
						source_page_url: "http://page.example/cat",
					},
				],
			}),
		);
		const images = await searchImages({ query: "cat" }, signal);
		expect(images).toHaveLength(1);
		expect(images[0]).toMatchObject({
			url: "http://cdn.example/cat.jpg",
			sourcePageUrl: "http://page.example/cat",
		});
		expect(images[0]).not.toHaveProperty("thumbnail");
	});

	it("cancels an outstanding provider request with the tool signal", async () => {
		const controller = new AbortController();
		fetchMock.mockImplementation(
			(_url, options) =>
				new Promise((_resolve, reject) => {
					const pending = options?.signal;
					pending?.addEventListener("abort", () => reject(pending.reason), {
						once: true,
					});
				}),
		);
		const search = searchImages({ query: "cat" }, controller.signal);
		const reason = new Error("stopped");
		controller.abort(reason);
		await expect(search).rejects.toBe(reason);
	});

	it("requires a Parallel key", async () => {
		vi.mocked(getConfig).mockReturnValueOnce({ parallelApiKey: "" } as never);
		await expect(searchImages({ query: "cat" }, signal)).rejects.toBeInstanceOf(
			ImageSearchNotConfiguredError,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("releases an error body and preserves the provider status if cancellation fails", async () => {
		const cancel = vi
			.fn()
			.mockRejectedValue(new Error("private provider detail"));
		fetchMock.mockResolvedValue(
			new Response(new ReadableStream({ cancel }), { status: 429 }),
		);
		await expect(searchImages({ query: "cat" }, signal)).rejects.toMatchObject({
			status: 429,
			message: "Parallel image search failed: 429",
		});
		expect(cancel).toHaveBeenCalledTimes(1);
	});
});

describe("fetchPublisherThumbnail", () => {
	const fetchMock = vi.fn();
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
	const fetchThumbnail = (address: string) =>
		fetchPublisherThumbnail(address, {
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

	it("accepts an otherwise-valid raster whose input exactly reaches the cap", async () => {
		const { default: sharp } = await import("sharp");
		const png = await sharp({
			create: { width: 1, height: 1, channels: 3, background: "red" },
		})
			.png()
			.toBuffer();
		const exact = new Uint8Array(2 * 1024 * 1024);
		exact.set(png);
		fetchMock.mockImplementationOnce(async () => imageResponse(exact));
		expect((await fetchThumbnail(THUMB))?.contentType).toBe("image/webp");
	});
});
