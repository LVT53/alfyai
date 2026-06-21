import { afterEach, describe, expect, it, vi } from "vitest";
import type { AtlasSearchSource } from "./search";

describe("Atlas search stage", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("requires SearXNG configuration", async () => {
		const { runAtlasSearchStage } = await import("./search");

		const result = await runAtlasSearchStage({
			queries: ["enterprise search"],
			config: { searxngBaseUrl: "" },
			search: vi.fn(),
		});

		expect(result).toMatchObject({
			sources: [],
			limitation: {
				code: "atlas_searxng_required",
			},
		});
	});

	it("uses bounded batch concurrency and stops when more than half a batch fails", async () => {
		const { runAtlasSearchStage } = await import("./search");
		let active = 0;
		let maxActive = 0;
		const search = vi.fn(async (query: string) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await Promise.resolve();
			active -= 1;
			if (query !== "q1") {
				throw new Error(`failed ${query}`);
			}
			return [
				{
					id: "source-q1",
					title: "Source q1",
					url: "https://example.com/q1",
					snippet: "snippet",
				},
			];
		});

		const result = await runAtlasSearchStage({
			queries: ["q1", "q2", "q3", "q4"],
			config: {
				searxngBaseUrl: "http://searxng.local",
				concurrency: 3,
				interBatchDelayMs: 0,
				initialRetryBackoffMs: 0,
				maxRetryBackoffMs: 0,
				maxAttempts: 1,
			},
			search,
		});

		expect(maxActive).toBeLessThanOrEqual(3);
		expect(search).toHaveBeenCalledTimes(3);
		expect(result.sources).toHaveLength(1);
		expect(result.limitation).toMatchObject({
			code: "atlas_search_batch_failure_limit",
			failedQueries: ["q2", "q3"],
		});
	});

	it("rejects adult sources, deduplicates URLs, and converges broad results to an accepted source cap", async () => {
		const { runAtlasSearchStage } = await import("./search");
		const result = await runAtlasSearchStage({
			queries: ["enterprise search", "retrieval evaluation"],
			config: {
				searxngBaseUrl: "http://searxng.local",
				concurrency: 2,
				interBatchDelayMs: 0,
				maxAttempts: 1,
			},
			search: vi.fn(async (query: string) => [
				{
					id: `${query}-1`,
					title: "Official retrieval evaluation guide",
					url: "https://example.com/retrieval",
					snippet: "Evaluation methods for search relevance.",
				},
				{
					id: `${query}-duplicate`,
					title: "Duplicate retrieval guide",
					url: "https://example.com/retrieval#section",
					snippet: "Same page with a fragment.",
				},
				{
					id: `${query}-adult`,
					title: "Porn video search result",
					url: "https://adult.example/video",
					snippet: "Explicit adult material.",
				},
				...Array.from({ length: 20 }, (_value, index) => ({
					id: `${query}-source-${index}`,
					title: `Breadth source ${index}`,
					url: `https://source-${query.replace(/\s+/g, "-")}-${index}.example/report`,
					snippet: `Breadth source ${index} about ${query}.`,
				})),
			]),
		});

		expect(result.sources.length).toBeLessThanOrEqual(18);
		expect(
			result.sources.some((source) => /porn|adult/i.test(source.title)),
		).toBe(false);
		expect(
			result.sources.filter((source) =>
				source.url.startsWith("https://example.com/retrieval"),
			),
		).toHaveLength(1);
		expect(result.rejectedSources.length).toBeGreaterThan(0);
	});

	it("uses the configured accepted source cap for profile-specific convergence", async () => {
		const { runAtlasSearchStage } = await import("./search");

		const result = await runAtlasSearchStage({
			queries: ["routing docs"],
			config: {
				searxngBaseUrl: "http://searxng.local",
				concurrency: 1,
				interBatchDelayMs: 0,
				maxAcceptedSources: 3,
				maxAttempts: 1,
			},
			search: vi.fn(async () =>
				Array.from({ length: 8 }, (_value, index) => ({
					id: `source-${index}`,
					title: `Source ${index}`,
					url: `https://example.com/source-${index}`,
					snippet: `Source ${index} about routing docs.`,
				})),
			),
		});

		expect(result.sources).toHaveLength(3);
		expect(
			result.rejectedSources.filter(
				(source) => source.rejectionReason === "source_cap",
			),
		).toHaveLength(5);
	});

	it("enriches accepted converged sources with fetched page excerpts", async () => {
		const { runAtlasSearchStage } = await import("./search");
		const fetchPage = vi.fn(async (source: AtlasSearchSource) => ({
			...source,
			snippet: `${source.snippet}\n\nFetched page excerpt: Detailed evidence from the opened page.`,
		}));

		const result = await runAtlasSearchStage({
			queries: ["retrieval evaluation"],
			config: {
				searxngBaseUrl: "http://searxng.local",
				concurrency: 2,
				interBatchDelayMs: 0,
				maxAttempts: 1,
			},
			search: vi.fn(async () => [
				{
					id: "web-1",
					title: "Retrieval evaluation guide",
					url: "https://example.com/retrieval",
					snippet: "Search-result summary.",
				},
			]),
			fetchPage,
		});

		expect(fetchPage).toHaveBeenCalledWith(
			expect.objectContaining({ url: "https://example.com/retrieval" }),
		);
		expect(result.sources[0].snippet).toContain("Fetched page excerpt");
	});

	it("normalizes SearXNG image results, filters unsafe or non-HTTPS images, and de-duplicates image URLs", async () => {
		const { runAtlasImageSearchStage } = await import("./search");
		const fetchMock = vi.fn(async (url: URL | string) => {
			const requestUrl = new URL(String(url));
			expect(requestUrl.pathname).toBe("/search");
			expect(requestUrl.searchParams.get("format")).toBe("json");
			expect(requestUrl.searchParams.get("categories")).toBe("images");
			expect(requestUrl.searchParams.get("safesearch")).toBe("1");
			expect(requestUrl.searchParams.get("image_proxy")).toBe("0");
			return new Response(
				JSON.stringify({
					results: [
						{
							title: "Enterprise architecture diagram",
							content: "Enterprise architecture diagram caption",
							img_src: "https://cdn.example.com/architecture.png",
							thumbnail_src: "https://cdn.example.com/architecture-thumb.png",
							url: "https://example.com/report",
							source: "Example Research",
							resolution: "1024 x 768",
						},
						{
							title: "Algolia devicon logo",
							content: "Algolia logo icon",
							img_src:
								"https://cdn.jsdelivr.net/gh/devicons/devicon/icons/algolia/algolia-original.svg",
							url: "https://github.com/devicons/devicon",
							source: "Devicon",
							resolution: "512 x 512",
						},
						{
							title: "Generic SaaS illustration",
							content: "Unrelated product screenshot",
							img_src: "https://cdn.example.com/unrelated-product.png",
							url: "https://example.com/unrelated-product",
							source: "Example Images",
							resolution: "1200 x 900",
						},
						{
							title: "Generic cover artwork",
							content: "Stock product illustration",
							img_src:
								"https://cdn.example.com/enterprise-architecture-cover.png",
							url: "https://example.com/stock-artwork",
							source: "Example Images",
							resolution: "1200 x 900",
						},
						{
							title: "Duplicate diagram",
							img_src: "https://cdn.example.com/architecture.png",
							url: "https://example.com/duplicate",
						},
						{
							title: "HTTP image is not embeddable",
							img_src: "http://cdn.example.com/insecure.png",
							url: "https://example.com/insecure",
						},
						{
							title: "Porn result",
							img_src: "https://cdn.example.com/adult.png",
							url: "https://example.com/adult",
						},
					],
				}),
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await runAtlasImageSearchStage({
			queries: ["enterprise architecture"],
			config: {
				searxngBaseUrl: "http://searxng.local",
				concurrency: 1,
				interBatchDelayMs: 0,
				maxImageCandidates: 3,
				maxAttempts: 1,
			},
		});

		expect(result.imageLimitation).toBeNull();
		expect(result.imageCandidates).toEqual([
			expect.objectContaining({
				query: "enterprise architecture",
				title: "Enterprise architecture diagram",
				imageUrl: "https://cdn.example.com/architecture.png",
				sourcePageUrl: "https://example.com/report",
				sourceTitle: "Example Research",
				thumbnailUrl: "https://cdn.example.com/architecture-thumb.png",
				width: 1024,
				height: 768,
				caption: "Enterprise architecture diagram caption",
			}),
		]);
	});

	it("keeps image search failures non-fatal", async () => {
		const { runAtlasImageSearchStage } = await import("./search");

		const result = await runAtlasImageSearchStage({
			queries: ["enterprise architecture"],
			config: {
				searxngBaseUrl: "http://searxng.local",
				concurrency: 1,
				interBatchDelayMs: 0,
				maxAttempts: 1,
			},
			searchImages: vi.fn(async () => {
				throw new Error("image endpoint unavailable");
			}),
		});

		expect(result.imageCandidates).toEqual([]);
		expect(result.imageLimitation).toMatchObject({
			code: "atlas_image_search_partial_failure",
			failedQueries: ["enterprise architecture"],
		});
	});
});
