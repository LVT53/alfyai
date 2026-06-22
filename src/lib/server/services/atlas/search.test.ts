import { afterEach, describe, expect, it, vi } from "vitest";
import type { AtlasSearchSource } from "./search";

describe("sanitizeSearchSnippet", () => {
	it("strips Hungarian language filter echo from snippet start", async () => {
		const { sanitizeSearchSnippet } = await import("./search");
		const result = sanitizeSearchSnippet(
			"Nem tartalmazza: English | Tartalmaznia kell: technical | Best self-hosted embedding models for enterprise search",
		);
		expect(result).toBe(
			"Best self-hosted embedding models for enterprise search",
		);
	});

	it("strips English language filter echo from snippet start", async () => {
		const { sanitizeSearchSnippet } = await import("./search");
		const result = sanitizeSearchSnippet(
			"Excluding: English | Must include: technical | Best self-hosted embedding models",
		);
		expect(result).toBe("Best self-hosted embedding models");
	});

	it("strips abbreviated Hungarian month date prefix (jan.)", async () => {
		const { sanitizeSearchSnippet } = await import("./search");
		const result = sanitizeSearchSnippet(
			"2024. jan. 26. · What is retrieval augmented generation",
		);
		expect(result).toBe("What is retrieval augmented generation");
	});

	it("strips abbreviated Hungarian month date prefix (dec.)", async () => {
		const { sanitizeSearchSnippet } = await import("./search");
		const result = sanitizeSearchSnippet(
			"2023. dec. 05. · A complete guide to RAG pipelines",
		);
		expect(result).toBe("A complete guide to RAG pipelines");
	});

	it("strips full Hungarian month name date prefix (január)", async () => {
		const { sanitizeSearchSnippet } = await import("./search");
		const result = sanitizeSearchSnippet(
			"2024. január 26. · What is retrieval augmented generation",
		);
		expect(result).toBe("What is retrieval augmented generation");
	});

	it("strips full Hungarian month name date prefix (szeptember)", async () => {
		const { sanitizeSearchSnippet } = await import("./search");
		const result = sanitizeSearchSnippet(
			"2024. szeptember 15. · Introduction to vector databases",
		);
		expect(result).toBe("Introduction to vector databases");
	});

	it("strips SearXNG metadata keyword Naptár at snippet start", async () => {
		const { sanitizeSearchSnippet } = await import("./search");
		const result = sanitizeSearchSnippet(
			"Naptár · 2024. jan. 26. · Event details for AI conference",
		);
		expect(result).toBe("Event details for AI conference");
	});

	it("strips SearXNG metadata keyword Keresés at snippet start", async () => {
		const { sanitizeSearchSnippet } = await import("./search");
		const result = sanitizeSearchSnippet("Keresés · keresési javaslatok");
		expect(result).toBe("keresési javaslatok");
	});

	it("strips SearXNG metadata keyword Beállítások at snippet start", async () => {
		const { sanitizeSearchSnippet } = await import("./search");
		const result = sanitizeSearchSnippet("Beállítások · rendszerkonfiguráció");
		expect(result).toBe("rendszerkonfiguráció");
	});

	it("strips YouTube channel prefix at snippet start", async () => {
		const { sanitizeSearchSnippet } = await import("./search");
		const result = sanitizeSearchSnippet(
			"YouTube · TechChannel · How vector databases work",
		);
		expect(result).toBe("TechChannel · How vector databases work");
	});

	it("preserves legitimate Hungarian content", async () => {
		const { sanitizeSearchSnippet } = await import("./search");
		const result = sanitizeSearchSnippet(
			"A mesterséges intelligencia forradalmasítja a keresést",
		);
		expect(result).toBe(
			"A mesterséges intelligencia forradalmasítja a keresést",
		);
	});

	it("returns empty string when snippet is only language filter artifact", async () => {
		const { sanitizeSearchSnippet } = await import("./search");
		const result = sanitizeSearchSnippet(
			"Nem tartalmazza: English | Tartalmaznia kell: technical |   ",
		);
		expect(result).toBe("");
	});

	it("handles empty and whitespace-only input", async () => {
		const { sanitizeSearchSnippet } = await import("./search");
		expect(sanitizeSearchSnippet("")).toBe("");
		expect(sanitizeSearchSnippet("   ")).toBe("");
	});

	it("strips language filter echo then date prefix in sequence", async () => {
		const { sanitizeSearchSnippet } = await import("./search");
		const result = sanitizeSearchSnippet(
			"Nem tartalmazza: English | Tartalmaznia kell: technical | 2024. jan. 26. · Actual relevant content here",
		);
		expect(result).toBe("Actual relevant content here");
	});
});

describe("sanitizeSourceTitle (applied to search titles)", () => {
	it("sanitizeSourceTitle strips - YouTube suffix", async () => {
		const { sanitizeSourceTitle } = await import("./renderer-output");
		const result = sanitizeSourceTitle(
			"Heat Pump Vs. Furnace - Which is BETTER? - YouTube",
		);
		expect(result).toBe("Heat Pump Vs. Furnace - Which is BETTER?");
	});

	it("sanitizeSourceTitle strips Reddit verification suffix", async () => {
		const { sanitizeSourceTitle } = await import("./renderer-output");
		const result = sanitizeSourceTitle("Reddit - Please wait for verification");
		expect(result).toBe("Reddit");
	});

	it("sanitizeSourceTitle strips platform | suffix", async () => {
		const { sanitizeSourceTitle } = await import("./renderer-output");
		expect(sanitizeSourceTitle("Cool content | Instagram")).toBe(
			"Cool content",
		);
	});

	it("sanitizeSourceTitle strips Hungarian date prefix", async () => {
		const { sanitizeSourceTitle } = await import("./renderer-output");
		const result = sanitizeSourceTitle(
			"2024. jan. 26. · Actual relevant content",
		);
		expect(result).toBe("Actual relevant content");
	});

	it("sanitizeSourceTitle preserves legitimate platform names in titles", async () => {
		const { sanitizeSourceTitle } = await import("./renderer-output");
		expect(sanitizeSourceTitle("YouTube: Best Embedding Models")).toBe(
			"YouTube: Best Embedding Models",
		);
	});

	it("sanitizeSourceTitle handles empty input", async () => {
		const { sanitizeSourceTitle } = await import("./renderer-output");
		expect(sanitizeSourceTitle("")).toBe("");
	});
});

describe("isUnusableAtlasSnippet", () => {
	it("rejects empty or whitespace-only snippets after sanitization", async () => {
		const { isUnusableAtlasSnippet } = await import("./search");
		expect(isUnusableAtlasSnippet("")).toBe(false);
		expect(isUnusableAtlasSnippet(null)).toBe(false);
		expect(isUnusableAtlasSnippet("Keresés · ")).toBe(true);
		expect(
			isUnusableAtlasSnippet(
				"Nem tartalmazza: English | Tartalmaznia kell: technical | ",
			),
		).toBe(true);
	});

	it("rejects snippets that are pure SearXNG UI metadata", async () => {
		const { isUnusableAtlasSnippet } = await import("./search");
		expect(isUnusableAtlasSnippet("Naptár")).toBe(true);
		expect(isUnusableAtlasSnippet("Keresés")).toBe(true);
		expect(isUnusableAtlasSnippet("Beállítások")).toBe(true);
	});

	it("rejects YouTube footer boilerplate with 2+ footer keywords", async () => {
		const { isUnusableAtlasSnippet } = await import("./search");
		expect(
			isUnusableAtlasSnippet(
				"Ismertető Sajtó Szerzői jog Kapcsolatfelvétel Alkotók Hirdetés Fejlesztők Feltételek Adatvédelem Irányelvek YouTube működése",
			),
		).toBe(true);
		expect(
			isUnusableAtlasSnippet("Policy & Safety How YouTube works Test new features"),
		).toBe(true);
	});

	it("rejects very short sanitized snippets (< 15 chars)", async () => {
		const { isUnusableAtlasSnippet } = await import("./search");
		expect(isUnusableAtlasSnippet("Short.")).toBe(true);
		expect(isUnusableAtlasSnippet("Log in")).toBe(true);
	});

	it("accepts normal-length snippets with substantive content", async () => {
		const { isUnusableAtlasSnippet } = await import("./search");
		expect(
			isUnusableAtlasSnippet(
				"Vector databases are essential for modern RAG pipelines, providing efficient similarity search over large document collections.",
			),
		).toBe(false);
		expect(
			isUnusableAtlasSnippet(
				"A comprehensive comparison of the best embedding models for enterprise search in 2026.",
			),
		).toBe(false);
	});

	it("accepts a single YouTube footer keyword mixed with real content", async () => {
		const { isUnusableAtlasSnippet } = await import("./search");
		expect(
			isUnusableAtlasSnippet(
				"This video demonstrates how to configure RAG pipelines for enterprise search. Adatvédelem considerations are discussed at 12:34.",
			),
		).toBe(false);
	});

	it("accepts social media snippets that are not pure boilerplate", async () => {
		const { isUnusableAtlasSnippet } = await import("./search");
		expect(isUnusableAtlasSnippet("View on Instagram")).toBe(false);
		expect(isUnusableAtlasSnippet("Log in to continue")).toBe(false);
		expect(
			isUnusableAtlasSnippet(
				"Reddit discussion: The best embedding models in 2026 include E5, BGE-M3, and Cohere Embed v4. Users report that BGE-M3 outperforms OpenAI on multilingual benchmarks.",
			),
		).toBe(false);
	});
});

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
					snippet: "Relevant search result about the query topic.",
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

	it("rejects sources with unusable snippets (YouTube footer, short text) before they consume acceptance slots", async () => {
		const { runAtlasSearchStage } = await import("./search");

		const result = await runAtlasSearchStage({
			queries: ["enterprise search"],
			config: {
				searxngBaseUrl: "http://searxng.local",
				concurrency: 1,
				interBatchDelayMs: 0,
				maxAcceptedSources: 3,
				maxAttempts: 1,
			},
			search: vi.fn(async () => [
				{
					id: "web-good-1",
					title: "Best embedding models 2026",
					url: "https://example.com/embeddings-2026",
					snippet:
						"A comprehensive comparison of the best embedding models for enterprise search in 2026 including E5, BGE-M3, and Cohere Embed v4 with detailed benchmarks.",
				},
				{
					id: "web-youtube-footer",
					title: "Embedding models video - YouTube",
					url: "https://youtube.com/watch?v=abc123",
					snippet:
						"Ismertető Sajtó Szerzői jog Kapcsolatfelvétel Alkotók Hirdetés Fejlesztők Feltételek Adatvédelem",
				},
				{
					id: "web-tiny",
					title: "Log in",
					url: "https://example.com/login",
					snippet: "Log in",
				},
				{
					id: "web-search-artifact",
					title: "Search results",
					url: "https://searxng.example/results",
					snippet:
						"Nem tartalmazza: English | Tartalmaznia kell: technical | ",
				},
				{
					id: "web-good-2",
					title: "RAG architecture guide",
					url: "https://example.com/rag-guide",
					snippet:
						"Retrieval Augmented Generation (RAG) architecture patterns for production systems including chunking strategies, embedding selection, and reranking pipelines.",
				},
			]),
		});

		expect(result.sources).toHaveLength(2);
		expect(result.sources.map((s) => s.id)).toEqual([
			"web-good-1",
			"web-good-2",
		]);
		expect(
			result.rejectedSources.filter(
				(s) => s.rejectionReason === "unusable_snippet",
			),
		).toHaveLength(3);
		expect(
			result.rejectedSources.filter(
				(s) => s.rejectionReason === "source_cap",
			),
		).toHaveLength(0);
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
