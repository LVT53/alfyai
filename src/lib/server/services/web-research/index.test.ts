import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(async () => ({
		searxngBaseUrl: "http://127.0.0.1:8080",
		braveSearchApiKey: "brave-key",
		webResearchSearxngNumResults: 12,
		webResearchSearxngLanguage: "en",
		webResearchSearxngSafesearch: 1,
		webResearchSearxngCategories: "general",
		webResearchMaxSources: 6,
		webResearchHighlightChars: 500,
		webResearchContentChars: 2000,
		webResearchFreshnessHours: 24,
	})),
}));

import {
	buildDiscoveryResearchRequest,
	classifySourceAuthority,
	planResearchQueries,
	type ResearchEvidence,
	type ResearchSource,
	researchWeb,
} from "./index";

const webConfig = {
	searxngBaseUrl: "http://127.0.0.1:8080",
	braveSearchApiKey: "brave-key",
	webResearchSearxngNumResults: 12,
	webResearchSearxngLanguage: "en",
	webResearchSearxngSafesearch: 1,
	webResearchSearxngCategories: "general",
	webResearchMaxSources: 6,
	webResearchHighlightChars: 500,
	webResearchContentChars: 2000,
	webResearchFreshnessHours: 24,
};

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function htmlResponse(value: string): Response {
	return new Response(value, {
		status: 200,
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

function searxngSearchResponse(
	results: Array<Record<string, unknown>>,
): Response {
	return jsonResponse({ results });
}

describe("web research planning", () => {
	it("plans broad, official, freshness, and exact query variants for volatile facts", () => {
		const queries = planResearchQueries(
			{ query: "latest Framework X Pro price", quoteRequired: true },
			new Date("2026-05-02T12:00:00.000Z"),
		);

		expect(queries).toEqual([
			{ query: "latest Framework X Pro price", purpose: "broad" },
			{
				query: "latest Framework X Pro price official store specifications",
				purpose: "official",
			},
			{
				query: "latest Framework X Pro price manufacturer price availability",
				purpose: "exact",
			},
			{ query: "latest Framework X Pro price 2026", purpose: "freshness" },
			{ query: '"latest Framework X Pro price"', purpose: "exact" },
			{
				query: "latest Framework X Pro price exact value source",
				purpose: "exact",
			},
		]);
	});

	it("plans source-policy variants for technical research", () => {
		const queries = planResearchQueries({
			query: "SvelteKit form actions error handling",
			mode: "research",
			sourcePolicy: "technical",
		});

		expect(queries).toEqual([
			{ query: "SvelteKit form actions error handling", purpose: "broad" },
			{
				query: "site:svelte.dev sveltekit form actions error handling",
				purpose: "official",
			},
			{
				query: "SvelteKit form actions error handling official documentation",
				purpose: "technical",
			},
			{
				query:
					"SvelteKit form actions error handling GitHub README release notes",
				purpose: "primary",
			},
		]);
	});

	it("plans a YouTube transcript query for product review research", () => {
		const queries = planResearchQueries({
			query: "Framework Laptop 16 review",
			mode: "research",
		});

		expect(queries).toEqual([
			{ query: "Framework Laptop 16 review", purpose: "broad" },
			{
				query: "site:frame.work framework laptop 16 review",
				purpose: "official",
			},
			{
				query: "Framework Laptop 16 review official store specifications",
				purpose: "official",
			},
			{
				query: "Framework Laptop 16 review YouTube review transcript",
				purpose: "primary",
			},
		]);
	});

	it("promotes official technical sources above generic pages", () => {
		expect(
			classifySourceAuthority(
				"https://docs.example.com/reference/search",
				"technical",
			),
		).toMatchObject({
			authorityClass: "primary",
			authorityScore: 90,
		});
		expect(
			classifySourceAuthority("https://reddit.com/r/example", "technical"),
		).toMatchObject({
			authorityClass: "low",
		});
		expect(
			classifySourceAuthority(
				"https://www.belastingdienst.nl/wps/wcm/connect/nl/zzp",
				"medical_legal_financial",
			),
		).toMatchObject({
			authorityClass: "official",
			authorityScore: 95,
		});
	});

	it("builds discovery requests with the normal web research inference semantics", () => {
		expect(
			buildDiscoveryResearchRequest({
				query: " current Framework X Pro price ",
				maxSources: 99,
			}),
		).toEqual({
			query: "current Framework X Pro price",
			mode: "exact",
			freshness: "live",
			sourcePolicy: "commerce",
			maxSources: 12,
			quoteRequired: true,
		});
	});
});

describe("researchWeb with SearXNG", () => {
	it("reports web research as disabled when SearXNG is not configured", async () => {
		const fetchMock = vi.fn();

		const result = await researchWeb(
			{
				query: "SvelteKit official documentation",
				mode: "quick",
				sourcePolicy: "technical",
				maxSources: 3,
			},
			{
				config: { ...webConfig, searxngBaseUrl: "" },
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
			},
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.sources).toHaveLength(0);
		expect(result.evidence).toHaveLength(0);
		expect(result.diagnostics.providers).toEqual({
			searxngConfigured: false,
		});
		expect(result.diagnostics.fallbackReasons).toContain(
			"web_research_not_configured",
		);
	});

	it("surfaces SearXNG JSON format errors with provider failure diagnostics", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ error: "format json is disabled" }, 403),
		);

		const result = await researchWeb(
			{
				query: "SvelteKit official documentation",
				mode: "quick",
				sourcePolicy: "technical",
				maxSources: 3,
			},
			{
				config: webConfig,
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
			},
		);

		expect(result.sources).toHaveLength(0);
		expect(result.diagnostics.providerCalls.length).toBeGreaterThan(0);
		expect(result.diagnostics.providerCalls.every((call) => call.error)).toBe(
			true,
		);
		expect(result.diagnostics.providerCalls[0]?.error).toContain(
			"settings.yml enables the json search format",
		);
		expect(result.diagnostics.fallbackReasons).toContain(
			"provider_search_failed",
		);
		expect(result.diagnostics.fallbackReasons).not.toContain(
			"no_search_results",
		);
	});

	it("queries SearXNG with JSON parameters, opens selected pages, and reranks evidence chunks", async () => {
		const searchUrls: URL[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.startsWith("http://127.0.0.1:8080/search?")) {
				searchUrls.push(new URL(url));
				return searxngSearchResponse([
					{
						title: "Framework X Pro - Official Store",
						url: "https://www.example.com/products/x-pro?utm_source=test",
						content: "Official listing for the Framework X Pro.",
						score: 0.82,
						publishedDate: "2026-05-01T08:00:00.000Z",
					},
					{
						title: "Framework X Pro price tracker",
						url: "https://prices.example.net/framework-x-pro",
						content: "A tracker mentions older third-party prices.",
						score: 0.4,
					},
					{
						title: "Framework X Pro - Official Store Duplicate",
						url: "https://example.com/products/x-pro",
						content: "Official duplicate without tracking parameters.",
						score: 0.3,
					},
				]);
			}
			if (url === "https://www.example.com/products/x-pro?utm_source=test") {
				return htmlResponse(`
					<html>
						<head><title>Framework X Pro Store</title></head>
						<body>
							<main>
								<p>Framework X Pro official product page.</p>
								<p>The current starting price is $799 before taxes and shipping.</p>
								<p>Configurations and availability may change by region.</p>
							</main>
						</body>
					</html>
				`);
			}
			if (url === "https://prices.example.net/framework-x-pro") {
				return htmlResponse(
					"<html><body>Third-party prices may lag behind the official store.</body></html>",
				);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});

		const rerank = vi.fn(
			async (params: {
				query: string;
				items: ResearchEvidence[];
				getText: (item: ResearchEvidence) => string;
			}) => ({
				items: params.items
					.map((item, index) => ({
						item,
						index,
						score: params.getText(item).includes("$799") ? 0.98 : 0.2,
					}))
					.sort((left, right) => right.score - left.score),
				confidence: 98,
			}),
		);

		const result = await researchWeb(
			{
				query: "current Framework X Pro price",
				mode: "exact",
				freshness: "live",
				sourcePolicy: "commerce",
				maxSources: 4,
				quoteRequired: true,
			},
			{
				config: webConfig,
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
				rerank,
			},
		);

		expect(searchUrls.length).toBeGreaterThan(0);
		expect(searchUrls[0]?.searchParams.get("format")).toBe("json");
		expect(searchUrls[0]?.searchParams.get("language")).toBe("en");
		expect(searchUrls[0]?.searchParams.get("safesearch")).toBe("1");
		expect(searchUrls[0]?.searchParams.get("categories")).toBe("general");
		expect(searchUrls[0]?.searchParams.get("time_range")).toBe("day");
		expect(result.sources.map((source) => source.canonicalUrl)).toEqual([
			"https://example.com/products/x-pro",
			"https://prices.example.net/framework-x-pro",
		]);
		expect(result.sources[0]?.title).toBe("Framework X Pro Store");
		expect(result.evidence[0]?.quote).toContain("$799");
		expect(result.answerBrief.markdown).toContain("Citation rules:");
		expect(result.answerBrief.sources[0]).toMatchObject({
			ref: "S1",
			provider: "searxng",
			authorityClass: "standard",
		});
		expect(result.diagnostics.openedPageCount).toBe(2);
		expect(result.diagnostics.reranked).toBe(true);
		expect(result.diagnostics.providers).toEqual({
			searxngConfigured: true,
		});
		expect(result.diagnostics.fetchedSourceCount).toBeGreaterThan(0);
		expect(result.diagnostics.fusedSourceCount).toBe(2);
		expect(result.diagnostics.selectedSourceCount).toBe(2);
		expect(result.diagnostics.evidenceCandidateCount).toBeGreaterThan(0);
		expect(result.diagnostics.exactEvidenceCandidateCount).toBeGreaterThan(0);
	});

	it("preserves extracted Markdown structure through the opened-page path", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.startsWith("http://127.0.0.1:8080/search?")) {
				return searxngSearchResponse([
					{
						title: "Clean Search Extraction",
						url: "https://docs.example.com/search-extraction",
						content: "Source-derived Markdown extraction guidance.",
						score: 0.9,
					},
				]);
			}
			if (url === "https://docs.example.com/search-extraction") {
				return htmlResponse(`
					<html>
						<head><title>Clean Search Extraction</title></head>
						<body>
							<nav>Home Pricing Sign in Support</nav>
							<article>
								<h1>Clean Search Extraction</h1>
								<p>Search quality improves when opened pages preserve source-derived Markdown for evidence review.</p>
								<p>This article intentionally contains enough body text for local extraction to preserve headings, tables, and code fences while excluding navigation boilerplate.</p>
								<table>
									<thead><tr><th>Layer</th><th>Role</th></tr></thead>
									<tbody><tr><td>SearXNG</td><td>Discovery</td></tr><tr><td>Readability</td><td>Extraction</td></tr></tbody>
								</table>
								<pre><code>const extractor = "readability";</code></pre>
							</article>
						</body>
					</html>
				`);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});

		const result = await researchWeb(
			{
				query: "Clean Search Extraction",
				mode: "research",
				sourcePolicy: "technical",
				maxSources: 1,
				quoteRequired: true,
			},
			{
				config: webConfig,
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
			},
		);

		expect(result.sources[0]?.markdown).toContain("\n\n| Layer | Role |");
		expect(result.sources[0]?.markdown).toContain("\n```");
		expect(result.sources[0]?.markdown).toContain(
			'const extractor = "readability";',
		);
		expect(result.sources[0]?.markdown).not.toContain("Home Pricing Sign in");
	});

	it("uses semantic source reranking before choosing pages to open", async () => {
		const relevantUrl = "https://case-study.example.org/form-action-fix";
		const openedUrls: string[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.startsWith("http://127.0.0.1:8080/search?")) {
				return searxngSearchResponse([
					{
						title: "Example Docs - General Routing",
						url: "https://docs.example.com/routing",
						content: "Official routing documentation with no form details.",
						score: 0.99,
					},
					{
						title: "Form Action Fix Case Study",
						url: relevantUrl,
						content:
							"Detailed report about nested submit failures in form actions.",
						score: 0.1,
					},
				]);
			}
			openedUrls.push(url);
			return htmlResponse(
				"The form action case study documents the exact nested submit failure and its fix.",
			);
		});

		const sourceRerank = vi.fn(
			async (params: {
				query: string;
				items: ResearchSource[];
				getText: (item: ResearchSource) => string;
			}) => ({
				items: params.items
					.map((item, index) => ({
						item,
						index,
						score: params.getText(item).includes("nested submit") ? 0.97 : 0.12,
					}))
					.sort((left, right) => right.score - left.score),
				confidence: 97,
			}),
		);

		const result = await researchWeb(
			{
				query: "SvelteKit form action nested submit failure",
				mode: "research",
				sourcePolicy: "technical",
				maxSources: 1,
			},
			{
				config: webConfig,
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
				sourceRerank,
				rerank: async (params) => ({
					items: params.items.map((item, index) => ({
						item,
						index,
						score: 1 - index / 100,
					})),
					confidence: 90,
				}),
			},
		);

		expect(sourceRerank).toHaveBeenCalled();
		expect(result.diagnostics.sourceReranked).toBe(true);
		expect(result.sources.map((source) => source.canonicalUrl)).toEqual([
			relevantUrl,
		]);
		expect(openedUrls).toEqual([relevantUrl]);
		expect(result.evidence[0]?.quote).toContain("nested submit failure");
	});

	it("treats user-provided URLs as mandatory opened sources without SearXNG", async () => {
		const directUrl = "https://shop.example.com/products/widget-pro";
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			expect(url).toBe(directUrl);
			return htmlResponse(`
				<html>
					<head><title>Widget Pro Store Page</title></head>
					<body>Widget Pro is currently listed at $249 on the store page.</body>
				</html>
			`);
		});

		const result = await researchWeb(
			{
				query: `What price is shown on ${directUrl}?`,
				maxSources: 1,
			},
			{
				config: { ...webConfig, searxngBaseUrl: "" },
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
				rerank: async (params) => ({
					items: params.items.map((item, index) => ({
						item,
						index,
						score: item.quote.includes("$249") ? 0.99 : 0.1,
					})),
					confidence: 99,
				}),
			},
		);

		expect(result.diagnostics.mode).toBe("exact");
		expect(result.diagnostics.directUrlCount).toBe(1);
		expect(result.diagnostics.openedPageCount).toBe(1);
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0]).toMatchObject({
			canonicalUrl: directUrl,
			title: "Widget Pro Store Page",
			provider: "direct",
		});
		expect(result.evidence[0]?.quote).toContain("$249");
		expect(result.diagnostics.fallbackReasons).not.toContain(
			"web_research_not_configured",
		);
	});

	it("keeps a substantial fetched-page excerpt for direct URL research", async () => {
		const directUrl = "https://docs.example.com/long-guide";
		const paragraphs = Array.from(
			{ length: 20 },
			(_, index) =>
				`<p>Section ${index + 1}: Widget deployment guidance with operational context and configuration notes for production teams.</p>`,
		);
		paragraphs.push(
			"<p>Section 21 retained detail: the rollback marker must remain available to the model after link fetching.</p>",
		);
		const fetchMock = vi.fn(async () =>
			htmlResponse(`
				<html>
					<head><title>Long Widget Guide</title></head>
					<body><article>${paragraphs.join("\n")}</article></body>
				</html>
			`),
		);

		const result = await researchWeb(
			{
				query: `Summarize the deployment guidance at ${directUrl}`,
				maxSources: 1,
			},
			{
				config: { ...webConfig, searxngBaseUrl: "" },
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
				rerank: async (params) => ({
					items: params.items.map((item, index) => ({
						item,
						index,
						score: index === 0 ? 0.99 : 0.1,
					})),
					confidence: 99,
				}),
			},
		);

		expect(result.diagnostics.openedPageCount).toBe(1);
		expect(result.answerBrief.markdown).toContain("Fetched page excerpts:");
		expect(result.answerBrief.markdown).toContain("Section 21 retained detail");
	});

	it("prefers readable page prose over leading code blocks from pasted URLs", async () => {
		const directUrl = "https://docs.example.com/tools";
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			expect(input.toString()).toBe(directUrl);
			return htmlResponse(`
				<html>
					<head><title>Tool Calling Docs</title></head>
					<body>
						<main>
							<pre><code>
								const random = () => Math.floor(Math.random() * 21) - 10;
								tool({ inputSchema, execute: async () => ({ value: 15 }) });
							</code></pre>
							<article>
								<h1>Tool Calling</h1>
								<p>Tool calling lets a model request a typed server-side function and then use the returned result in its final answer.</p>
								<p>The execute callback should return compact, citation-ready evidence rather than raw internal data.</p>
							</article>
						</main>
					</body>
				</html>
			`);
		});

		const result = await researchWeb(
			{
				query: `Summarize tool calling from ${directUrl}`,
				mode: "exact",
				sourcePolicy: "technical",
				maxSources: 1,
			},
			{
				config: { ...webConfig, searxngBaseUrl: "" },
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
			},
		);

		expect(result.diagnostics.openedPageCount).toBe(1);
		expect(result.evidence[0]?.quote).toContain(
			"Tool calling lets a model request a typed server-side function",
		);
		expect(result.evidence[0]?.quote).not.toContain("Math.random");
	});

	it("does not turn an unfetchable pasted URL into fake evidence", async () => {
		const directUrl = "https://shop.example.com/products/widget-pro";
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			expect(input.toString()).toBe(directUrl);
			return new Response("Forbidden", {
				status: 403,
				statusText: "Forbidden",
				headers: { "Content-Type": "text/plain" },
			});
		});

		const result = await researchWeb(
			{
				query: `What price is shown on ${directUrl}?`,
				maxSources: 1,
			},
			{
				config: { ...webConfig, searxngBaseUrl: "" },
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
			},
		);

		expect(result.diagnostics.directUrlCount).toBe(1);
		expect(result.diagnostics.openedPageCount).toBe(0);
		expect(result.diagnostics.fallbackReasons).toContain("page_open_failed");
		expect(result.diagnostics.fallbackReasons).toContain(
			"direct_url_open_failed",
		);
		expect(result.sources).toHaveLength(0);
		expect(result.evidence).toHaveLength(0);
		expect(result.answerBrief.markdown).toContain("Sources: none returned.");
		expect(result.answerBrief.markdown).toContain(
			"Evidence snippets: none returned.",
		);
		expect(result.answerBrief.markdown).not.toContain(
			"User-provided URL to inspect directly",
		);
	});

	it("blocks user-provided local network URLs before server-side fetch", async () => {
		const fetchMock = vi.fn(async () =>
			htmlResponse("<html><body>internal admin page</body></html>"),
		);

		const result = await researchWeb(
			{
				query: "Inspect http://127.0.0.1:8000/admin",
				maxSources: 1,
			},
			{
				config: { ...webConfig, searxngBaseUrl: "" },
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
			},
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.diagnostics.directUrlCount).toBe(0);
		expect(result.diagnostics.openedPageCount).toBe(0);
		expect(result.sources).toHaveLength(0);
	});

	it("falls back to SearXNG snippets when selected pages cannot be opened", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.startsWith("http://127.0.0.1:8080/search?")) {
				return searxngSearchResponse([
					{
						title: "Official API Docs",
						url: "https://docs.example.com/api",
						content:
							"The official API docs say timeout errors should be retried with exponential backoff.",
						score: 1,
					},
				]);
			}
			return new Response("gateway timeout", { status: 504 });
		});

		const result = await researchWeb(
			{
				query: "official API timeout retry guidance",
				mode: "research",
				sourcePolicy: "technical",
				maxSources: 1,
			},
			{
				config: webConfig,
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
			},
		);

		expect(result.diagnostics.openedPageCount).toBe(0);
		expect(result.diagnostics.fallbackReasons).toContain("page_open_failed");
		expect(result.evidence[0]?.quote).toContain("exponential backoff");
		expect(result.answerBrief.markdown).toContain("Official API Docs");
	});

	it("retries a SearXNG query without time_range when strict freshness returns no results", async () => {
		const searchUrls: URL[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.startsWith("http://127.0.0.1:8080/search?")) {
				const parsed = new URL(url);
				searchUrls.push(parsed);
				if (parsed.searchParams.has("time_range")) {
					return searxngSearchResponse([]);
				}
				return searxngSearchResponse([
					{
						title: "Official SvelteKit form actions",
						url: "https://svelte.dev/docs/kit/form-actions",
						content: "Official documentation for SvelteKit form actions.",
						score: 1,
					},
				]);
			}
			return htmlResponse(
				"<html><body>Official documentation for SvelteKit form actions.</body></html>",
			);
		});

		const result = await researchWeb(
			{
				query: "current SvelteKit form actions documentation",
				mode: "research",
				freshness: "recent",
				sourcePolicy: "technical",
				maxSources: 1,
			},
			{
				config: webConfig,
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
			},
		);

		expect(searchUrls.some((url) => url.searchParams.has("time_range"))).toBe(
			true,
		);
		expect(searchUrls.some((url) => !url.searchParams.has("time_range"))).toBe(
			true,
		);
		expect(result.sources[0]?.canonicalUrl).toBe(
			"https://svelte.dev/docs/kit/form-actions",
		);
		expect(result.diagnostics.fallbackReasons).not.toContain(
			"no_search_results",
		);
	});

	it("keeps explicit official-sources-only product follow-ups on official candidates", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.startsWith("http://127.0.0.1:8080/search?")) {
				return searxngSearchResponse([
					{
						title: "Unrelated AMD discussion",
						url: "https://github.com/example/amd-discussion",
						content:
							"High ranking but unrelated technical discussion about AMD hardware.",
						score: 10,
					},
					{
						title: "Framework Laptop 13 specs",
						url: "https://frame.work/laptop13?tab=specs",
						content:
							"Official Framework Laptop 13 page with price and processor options.",
						score: 0.4,
					},
					{
						title: "Framework Laptop 13 order page",
						url: "https://frame.work/laptop13",
						content:
							"Official Framework Laptop 13 order page with availability details.",
						score: 0.3,
					},
				]);
			}
			if (url.startsWith("https://frame.work/laptop13")) {
				return htmlResponse(
					"<html><body>Framework Laptop 13 official page. Starting at $849. Processor options include AMD Ryzen AI 300 Series.</body></html>",
				);
			}
			return htmlResponse(
				"<html><body>Unrelated AMD discussion with no Framework product details.</body></html>",
			);
		});

		const result = await researchWeb(
			{
				query:
					"For the Framework Laptop 13 AMD Ryzen AI 300, focus on official Framework sources only and verify price, processor options, display, and availability.",
				mode: "exact",
				sourcePolicy: "commerce",
				maxSources: 3,
				quoteRequired: true,
			},
			{
				config: webConfig,
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
			},
		);

		expect(
			result.sources.map((source) => new URL(source.url).hostname),
		).toEqual(["frame.work", "frame.work"]);
		expect(result.answerBrief.markdown).not.toContain("github.com");
	});

	it("filters explicit adult domains and snippets before sources reach the model", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.startsWith("http://127.0.0.1:8080/search?")) {
				return searxngSearchResponse([
					{
						title: "Blocked explicit result",
						url: "https://porn.example/search-result",
						content: "Explicit adult video result.",
						score: 10,
					},
					{
						title: "Safe official guidance",
						url: "https://docs.example.com/guidance",
						content: "Official guidance for the requested benign topic.",
						score: 1,
					},
				]);
			}
			return htmlResponse(
				"<html><body>Official guidance for the requested benign topic.</body></html>",
			);
		});

		const result = await researchWeb(
			{
				query: "benign official guidance",
				mode: "research",
				sourcePolicy: "technical",
				maxSources: 3,
			},
			{
				config: webConfig,
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
			},
		);

		expect(result.sources.map((source) => source.url)).toEqual([
			"https://docs.example.com/guidance",
		]);
		expect(result.answerBrief.markdown).not.toMatch(/porn|adult video/i);
	});

	it("extracts exact value quotes from deep opened page text before generic chunk caps", async () => {
		const productUrl = "https://store.example.com/products/laptop-ultra";
		const filler = Array.from(
			{ length: 8 },
			(_, index) =>
				`Background section ${index + 1}. ${"Warranty terms and generic product copy. ".repeat(32)}`,
		);
		const deepText = [
			...filler,
			"The current checkout price is $1,299 before taxes and shipping.",
		].join("\n\n");
		const rerankQuotes: string[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.startsWith("http://127.0.0.1:8080/search?")) {
				return searxngSearchResponse([
					{
						title: "Laptop Ultra Store",
						url: productUrl,
						content: "Official product page with a long configuration section.",
						score: 1,
					},
				]);
			}
			if (url === productUrl) {
				return htmlResponse(`<html><body>${deepText}</body></html>`);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});

		const result = await researchWeb(
			{
				query: "current Laptop Ultra price",
				mode: "exact",
				sourcePolicy: "commerce",
				maxSources: 1,
				quoteRequired: true,
			},
			{
				config: webConfig,
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
				rerank: async (params) => {
					rerankQuotes.push(...params.items.map((item) => item.quote));
					return {
						items: params.items
							.map((item, index) => ({
								item,
								index,
								score: item.quote.includes("$1,299") ? 0.99 : 0.1,
							}))
							.sort((left, right) => right.score - left.score),
						confidence: 99,
					};
				},
			},
		);

		expect(rerankQuotes.some((quote) => quote.includes("$1,299"))).toBe(true);
		expect(result.evidence[0]?.quote).toContain("$1,299");
		expect(result.answerBrief.markdown).toContain("$1,299");
		expect(result.diagnostics.contentCharBudget).toBe(12_000);
		expect(result.diagnostics.exactEvidenceCandidateCount).toBeGreaterThan(0);
	});

	it("enriches selected YouTube review results with transcript evidence", async () => {
		const videoId = "dQw4w9WgXcQ";
		const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
		const captionUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`;
		const playerResponse = {
			videoDetails: { title: "Framework Laptop 16 Long-Term Review" },
			captions: {
				playerCaptionsTracklistRenderer: {
					captionTracks: [
						{
							baseUrl: captionUrl,
							name: { simpleText: "English" },
							languageCode: "en",
							kind: "asr",
							isTranslatable: true,
						},
					],
					translationLanguages: [{ languageCode: "en" }],
				},
			},
		};

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.startsWith("http://127.0.0.1:8080/search?")) {
				return searxngSearchResponse([
					{
						title: "Framework Laptop 16 review video",
						url: videoUrl,
						content:
							"Long-term review video covering battery life and thermal behavior.",
						score: 1,
					},
				]);
			}
			if (
				url === videoUrl ||
				url.startsWith(`https://youtube.com/watch?v=${videoId}&`)
			) {
				return htmlResponse(
					`<html><body><script>var ytInitialPlayerResponse = ${JSON.stringify(
						playerResponse,
					)};</script></body></html>`,
				);
			}
			if (url.startsWith(captionUrl)) {
				return new Response(
					`<transcript>
						<text start="0" dur="5">Battery life reached nine hours in office use.</text>
						<text start="5" dur="5">The fans stayed quiet during light work.</text>
					</transcript>`,
					{ status: 200, headers: { "Content-Type": "text/xml" } },
				);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});

		const result = await researchWeb(
			{
				query: "Framework Laptop 16 review battery life",
				mode: "research",
				sourcePolicy: "commerce",
				maxSources: 2,
			},
			{
				config: webConfig,
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
			},
		);

		expect(result.diagnostics.youtubeTranscriptCandidateCount).toBe(1);
		expect(result.diagnostics.youtubeTranscriptFetchedCount).toBe(1);
		expect(result.sources[0]?.youtubeTranscript).toMatchObject({
			videoId,
			languageCode: "en",
			isGenerated: true,
		});
		expect(
			result.evidence.some((item) => item.quote.includes("nine hours")),
		).toBe(true);
	});
});
