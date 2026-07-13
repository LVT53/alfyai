import { describe, expect, it, vi } from "vitest";

import {
	type ParallelClientConfig,
	parallelExtract,
	parallelSearch,
} from "./client";

const config: ParallelClientConfig = { parallelApiKey: "test-key" };

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("parallelSearch", () => {
	it("posts to /v1/search with the api key header and parsed body", async () => {
		let capturedUrl: string | undefined;
		let capturedInit: RequestInit | undefined;
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				capturedUrl = input.toString();
				capturedInit = init;
				return jsonResponse({
					search_id: "s-1",
					session_id: "sess-1",
					results: [
						{
							url: "https://example.com/a",
							title: "A",
							publish_date: "2026-01-01",
							excerpts: ["one", "two"],
						},
					],
				});
			},
		);

		const results = await parallelSearch(
			{
				objective: "find the price",
				searchQueries: ["price of widget", "widget cost"],
			},
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(capturedUrl).toBe("https://api.parallel.ai/v1/search");
		expect(capturedInit?.method).toBe("POST");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe("test-key");
		expect(headers["content-type"]).toBe("application/json");

		const body = JSON.parse(capturedInit?.body as string);
		expect(body).toEqual({
			objective: "find the price",
			search_queries: ["price of widget", "widget cost"],
			mode: "turbo",
		});

		expect(results).toEqual([
			{
				url: "https://example.com/a",
				title: "A",
				publish_date: "2026-01-01",
				excerpts: ["one", "two"],
			},
		]);
	});

	it("defaults mode to turbo and accepts an explicit mode", async () => {
		const bodies: unknown[] = [];
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				bodies.push(JSON.parse(init?.body as string));
				return jsonResponse({ results: [] });
			},
		);

		await parallelSearch(
			{ objective: "o", searchQueries: ["q"] },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);
		await parallelSearch(
			{ objective: "o", searchQueries: ["q"], mode: "basic" },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		expect((bodies[0] as { mode: string }).mode).toBe("turbo");
		expect((bodies[1] as { mode: string }).mode).toBe("basic");
	});

	it("clamps search queries to five entries of at most 200 chars", async () => {
		let body: { search_queries: string[]; objective: string } | undefined;
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				body = JSON.parse(init?.body as string);
				return jsonResponse({ results: [] });
			},
		);

		await parallelSearch(
			{
				objective: "x".repeat(6000),
				searchQueries: ["a".repeat(300), "q2", "q3", "q4", "q5", "q6-dropped"],
			},
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		expect(body?.search_queries).toHaveLength(5);
		expect(body?.search_queries[0]).toHaveLength(200);
		expect(body?.search_queries).not.toContain("q6-dropped");
		expect(body?.objective).toHaveLength(5000);
	});

	it("throws on non-2xx responses including status and trimmed body", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response("boom failure detail", {
					status: 401,
					headers: { "Content-Type": "text/plain" },
				}),
		);

		await expect(
			parallelSearch(
				{ objective: "o", searchQueries: ["q"] },
				{ fetch: fetchMock as unknown as typeof fetch, config },
			),
		).rejects.toThrow(/401/);
		await expect(
			parallelSearch(
				{ objective: "o", searchQueries: ["q"] },
				{ fetch: fetchMock as unknown as typeof fetch, config },
			),
		).rejects.toThrow(/boom failure detail/);
	});

	it("targets a custom parallelBaseUrl when supplied (trailing slash trimmed)", async () => {
		let capturedUrl: string | undefined;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			capturedUrl = input.toString();
			return jsonResponse({ results: [] });
		});

		await parallelSearch(
			{ objective: "o", searchQueries: ["q"] },
			{
				fetch: fetchMock as unknown as typeof fetch,
				config: {
					parallelApiKey: "test-key",
					parallelBaseUrl: "http://127.0.0.1:4321/",
				},
			},
		);

		expect(capturedUrl).toBe("http://127.0.0.1:4321/v1/search");
	});

	it("forwards the abort signal to fetch", async () => {
		let capturedInit: RequestInit | undefined;
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				capturedInit = init;
				return jsonResponse({ results: [] });
			},
		);
		const controller = new AbortController();

		await parallelSearch(
			{ objective: "o", searchQueries: ["q"] },
			{
				fetch: fetchMock as unknown as typeof fetch,
				config,
				signal: controller.signal,
			},
		);

		expect(capturedInit?.signal).toBe(controller.signal);
	});
});

describe("parallelExtract", () => {
	it("posts to /v1/extract with the api key header and parsed body", async () => {
		let capturedUrl: string | undefined;
		let capturedInit: RequestInit | undefined;
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				capturedUrl = input.toString();
				capturedInit = init;
				return jsonResponse({
					extract_id: "e-1",
					results: [
						{
							url: "https://example.com/a",
							title: "A",
							publish_date: null,
							excerpts: ["chunk"],
							full_content: "the full content",
						},
					],
					errors: [],
					warnings: [],
					usage: {},
				});
			},
		);

		const results = await parallelExtract(
			{
				urls: ["https://example.com/a"],
				objective: "extract the details",
				searchQueries: ["details"],
				fullContent: true,
			},
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		expect(capturedUrl).toBe("https://api.parallel.ai/v1/extract");
		expect(capturedInit?.method).toBe("POST");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe("test-key");

		const body = JSON.parse(capturedInit?.body as string);
		expect(body).toEqual({
			urls: ["https://example.com/a"],
			objective: "extract the details",
			search_queries: ["details"],
			advanced_settings: { full_content: true },
		});

		expect(results).toEqual([
			{
				url: "https://example.com/a",
				title: "A",
				publish_date: null,
				excerpts: ["chunk"],
				full_content: "the full content",
			},
		]);
	});

	it("omits optional fields when not provided", async () => {
		let body: Record<string, unknown> | undefined;
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				body = JSON.parse(init?.body as string);
				return jsonResponse({ results: [] });
			},
		);

		await parallelExtract(
			{ urls: ["https://example.com/a"], objective: "o" },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		expect(body).toEqual({
			urls: ["https://example.com/a"],
			objective: "o",
		});
		expect(body).not.toHaveProperty("search_queries");
		expect(body).not.toHaveProperty("advanced_settings");
	});

	it("throws when given zero urls", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));

		await expect(
			parallelExtract(
				{ urls: [], objective: "o" },
				{ fetch: fetchMock as unknown as typeof fetch, config },
			),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("throws when given more than twenty urls", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));
		const urls = Array.from(
			{ length: 21 },
			(_, index) => `https://example.com/${index}`,
		);

		await expect(
			parallelExtract(
				{ urls, objective: "o" },
				{ fetch: fetchMock as unknown as typeof fetch, config },
			),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("targets a custom parallelBaseUrl when supplied (trailing slash trimmed)", async () => {
		let capturedUrl: string | undefined;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			capturedUrl = input.toString();
			return jsonResponse({ results: [] });
		});

		await parallelExtract(
			{ urls: ["https://example.com/a"], objective: "o" },
			{
				fetch: fetchMock as unknown as typeof fetch,
				config: {
					parallelApiKey: "test-key",
					parallelBaseUrl: "http://127.0.0.1:4321/",
				},
			},
		);

		expect(capturedUrl).toBe("http://127.0.0.1:4321/v1/extract");
	});

	it("throws on non-2xx responses including status and trimmed body", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response("extract exploded", {
					status: 500,
					headers: { "Content-Type": "text/plain" },
				}),
		);

		await expect(
			parallelExtract(
				{ urls: ["https://example.com/a"], objective: "o" },
				{ fetch: fetchMock as unknown as typeof fetch, config },
			),
		).rejects.toThrow(/500/);
		await expect(
			parallelExtract(
				{ urls: ["https://example.com/a"], objective: "o" },
				{ fetch: fetchMock as unknown as typeof fetch, config },
			),
		).rejects.toThrow(/extract exploded/);
	});

	it("forwards the abort signal to fetch", async () => {
		let capturedInit: RequestInit | undefined;
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				capturedInit = init;
				return jsonResponse({ results: [] });
			},
		);
		const controller = new AbortController();

		await parallelExtract(
			{ urls: ["https://example.com/a"], objective: "o" },
			{
				fetch: fetchMock as unknown as typeof fetch,
				config,
				signal: controller.signal,
			},
		);

		expect(capturedInit?.signal).toBe(controller.signal);
	});
});
