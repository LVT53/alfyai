import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(async () => ({
		exaApiKey: "exa-key",
		braveSearchApiKey: "brave-key",
		webResearchExaSearchType: "auto",
		webResearchExaNumResults: 12,
		webResearchBraveNumResults: 10,
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
	exaApiKey: "exa-key",
	braveSearchApiKey: "brave-key",
	webResearchExaSearchType: "auto",
	webResearchExaNumResults: 12,
	webResearchBraveNumResults: 10,
	webResearchMaxSources: 6,
	webResearchHighlightChars: 500,
	webResearchContentChars: 2000,
	webResearchFreshnessHours: 24,
};

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

	it("infers specialized discovery request policy for technical, news, and regulatory queries", () => {
		expect(
			buildDiscoveryResearchRequest({
				query: "SvelteKit API documentation migration",
				maxSources: 4,
			}),
		).toMatchObject({
			mode: "quick",
			freshness: "auto",
			sourcePolicy: "technical",
			quoteRequired: false,
		});
		expect(
			buildDiscoveryResearchRequest({
				query: "latest election news today",
				maxSources: 4,
			}),
		).toMatchObject({
			mode: "quick",
			freshness: "live",
			sourcePolicy: "news",
			quoteRequired: false,
		});
		expect(
			buildDiscoveryResearchRequest({
				query: "current legal regulation for AI copyright compliance",
				maxSources: 4,
			}),
		).toMatchObject({
			mode: "exact",
			freshness: "live",
			sourcePolicy: "medical_legal_financial",
			quoteRequired: true,
		});
	});
});

describe("researchWeb", () => {
	it("reports missing search providers instead of treating disabled search as no results", async () => {
		const fetchMock = vi.fn();

		const result = await researchWeb(
			{
				query: "SvelteKit official documentation",
				mode: "quick",
				sourcePolicy: "technical",
				maxSources: 3,
			},
			{
				config: { ...webConfig, exaApiKey: "", braveSearchApiKey: "" },
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
			},
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.sources).toHaveLength(0);
		expect(result.diagnostics.providers).toEqual({
			exaConfigured: false,
			braveConfigured: false,
		});
		expect(result.diagnostics.fallbackReasons).toContain(
			"web_research_not_configured",
		);
		expect(result.diagnostics.fallbackReasons).not.toContain(
			"no_search_results",
		);
	});

	it("reports provider failures instead of treating failed searches as no results", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({ error: "invalid Exa search configuration" }),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		});

		const result = await researchWeb(
			{
				query: "SvelteKit official documentation",
				mode: "quick",
				sourcePolicy: "technical",
				maxSources: 3,
			},
			{
				config: { ...webConfig, braveSearchApiKey: "" },
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
			},
		);

		expect(result.sources).toHaveLength(0);
		expect(result.diagnostics.providerCalls.length).toBeGreaterThan(0);
		expect(result.diagnostics.providerCalls.every((call) => call.error)).toBe(
			true,
		);
		expect(result.diagnostics.fallbackReasons).toContain(
			"provider_search_failed",
		);
		expect(result.diagnostics.fallbackReasons).not.toContain(
			"no_search_results",
		);
	});

	it("keeps provider failure context when another configured provider returns no results", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url === "https://api.exa.ai/search") {
				return new Response(
					JSON.stringify({ error: "temporary Exa provider failure" }),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.startsWith("https://api.search.brave.com/res/v1/web/search")) {
				return new Response(JSON.stringify({ web: { results: [] } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});

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
		expect(result.diagnostics.providerCalls.some((call) => call.error)).toBe(
			true,
		);
		expect(result.diagnostics.providerCalls.some((call) => !call.error)).toBe(
			true,
		);
		expect(result.diagnostics.fallbackReasons).toContain(
			"provider_search_failed",
		);
		expect(result.diagnostics.fallbackReasons).toContain("no_search_results");
	});

	it("fuses Exa and Brave results, opens selected pages, and reranks evidence chunks", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input.toString();
				if (url === "https://api.exa.ai/search") {
					return new Response(
						JSON.stringify({
							results: [
								{
									title: "Framework X Pro - Official Store",
									url: "https://www.example.com/products/x-pro?utm_source=test",
									summary: "Official listing for the Framework X Pro.",
									highlights: [
										"Framework X Pro starts at $799 from the official store.",
									],
									score: 0.82,
									publishedDate: "2026-05-01T08:00:00.000Z",
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url.startsWith("https://api.search.brave.com/res/v1/web/search")) {
					return new Response(
						JSON.stringify({
							web: {
								results: [
									{
										title: "Framework X Pro price tracker",
										url: "https://prices.example.net/framework-x-pro",
										description: "A tracker mentions older third-party prices.",
										extra_snippets: [
											"Third-party prices may lag behind the official store.",
										],
									},
									{
										title: "Framework X Pro - Official Store Duplicate",
										url: "https://example.com/products/x-pro",
										description:
											"Official duplicate without tracking parameters.",
									},
								],
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url === "https://api.exa.ai/contents") {
					const body = JSON.parse(String(init?.body));
					expect(body.urls).toContain(
						"https://www.example.com/products/x-pro?utm_source=test",
					);
					expect(body.maxAgeHours).toBe(0);
					return new Response(
						JSON.stringify({
							results: [
								{
									url: "https://example.com/products/x-pro",
									text: [
										"Framework X Pro official product page.",
										"The current starting price is $799 before taxes and shipping.",
										"Configurations and availability may change by region.",
									].join(" "),
									highlights: [
										"The current starting price is $799 before taxes and shipping.",
									],
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				throw new Error(`Unexpected fetch: ${url}`);
			},
		);

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

		expect(result.queries.map((entry) => entry.purpose)).toEqual([
			"broad",
			"official",
			"exact",
			"freshness",
			"exact",
			"exact",
		]);
		expect(result.sources.map((source) => source.canonicalUrl)).toEqual([
			"https://example.com/products/x-pro",
			"https://prices.example.net/framework-x-pro",
		]);
		expect(result.evidence[0]?.quote).toContain("$799");
		expect(result.answerBrief.markdown).toContain("Citation rules:");
		expect(result.answerBrief.markdown).toContain(
			"It is not a response-language instruction",
		);
		expect(result.answerBrief.markdown).toContain(
			"Do not cite URLs that are not listed",
		);
		expect(result.answerBrief.sources[0]).toMatchObject({
			ref: "S1",
			url: "https://www.example.com/products/x-pro?utm_source=test",
			authorityClass: "standard",
		});
		expect(result.answerBrief.evidence[0]).toMatchObject({
			ref: "E1",
			sourceRef: "S1",
		});
		expect(result.answerBrief.evidence[0]?.quote).toContain("$799");
		expect(result.diagnostics.openedPageCount).toBe(1);
		expect(result.diagnostics.reranked).toBe(true);
		expect(result.diagnostics.providers).toEqual({
			exaConfigured: true,
			braveConfigured: true,
		});
		expect(result.diagnostics.plannedQueryCount).toBe(6);
		expect(result.diagnostics.fetchedSourceCount).toBe(18);
		expect(result.diagnostics.fusedSourceCount).toBe(2);
		expect(result.diagnostics.selectedSourceCount).toBe(2);
		expect(result.diagnostics.evidenceCandidateCount).toBeGreaterThan(0);
		expect(result.diagnostics.exactEvidenceCandidateCount).toBeGreaterThan(0);
		expect(result.diagnostics.providerCalls).toHaveLength(12);
	});

	it("selects authoritative sources with host diversity before opening pages", async () => {
		const openedUrls: string[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input.toString();
				if (url === "https://api.exa.ai/search") {
					return new Response(
						JSON.stringify({
							results: [
								{
									title: "Example Docs - Routing",
									url: "https://docs.example.com/routing",
									summary: "Official routing documentation.",
									highlights: ["Routing docs for the framework."],
								},
								{
									title: "Example Docs - Loading",
									url: "https://docs.example.com/loading",
									summary: "Official loading documentation.",
									highlights: ["Loading docs for the framework."],
								},
								{
									title: "Example Docs - Actions",
									url: "https://docs.example.com/actions",
									summary: "Official action documentation.",
									highlights: ["Action docs for the framework."],
								},
								{
									title: "Example GitHub README",
									url: "https://github.com/example/framework",
									summary: "Primary README and release notes.",
									highlights: ["Release notes mention the routing change."],
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url === "https://api.exa.ai/contents") {
					const body = JSON.parse(String(init?.body));
					openedUrls.push(...body.urls);
					return new Response(
						JSON.stringify({
							results: body.urls.map((sourceUrl: string) => ({
								url: sourceUrl,
								text: `Fetched content for ${sourceUrl}. The source contains relevant implementation details.`,
								highlights: [`Relevant details from ${sourceUrl}.`],
							})),
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				throw new Error(`Unexpected fetch: ${url}`);
			},
		);

		const result = await researchWeb(
			{
				query: "Example framework routing change",
				mode: "research",
				sourcePolicy: "technical",
				maxSources: 3,
			},
			{
				config: { ...webConfig, braveSearchApiKey: "" },
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
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

		expect(result.sources.map((source) => source.canonicalUrl)).toEqual([
			"https://docs.example.com/routing",
			"https://docs.example.com/loading",
			"https://github.com/example/framework",
		]);
		expect(result.sources).not.toContainEqual(
			expect.objectContaining({
				canonicalUrl: "https://docs.example.com/actions",
			}),
		);
		expect(openedUrls).toContain("https://github.com/example/framework");
	});

	it("uses semantic source reranking before choosing pages to open", async () => {
		const relevantUrl = "https://case-study.example.org/form-action-fix";
		const openedUrls: string[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input.toString();
				if (url === "https://api.exa.ai/search") {
					return new Response(
						JSON.stringify({
							results: [
								{
									title: "Example Docs - General Routing",
									url: "https://docs.example.com/routing",
									summary:
										"Official routing documentation with no form details.",
									highlights: ["Routing docs for the framework."],
									score: 0.99,
								},
								{
									title: "Form Action Fix Case Study",
									url: relevantUrl,
									summary:
										"Detailed report about nested submit failures in form actions.",
									highlights: [
										"The nested submit failure is fixed by preserving the action payload.",
									],
									score: 0.1,
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url === "https://api.exa.ai/contents") {
					const body = JSON.parse(String(init?.body));
					openedUrls.push(...body.urls);
					return new Response(
						JSON.stringify({
							results: [
								{
									url: relevantUrl,
									text: "The form action case study documents the exact nested submit failure and its fix.",
									highlights: [
										"The form action case study documents the exact nested submit failure and its fix.",
									],
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				throw new Error(`Unexpected fetch: ${url}`);
			},
		);

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
				config: { ...webConfig, braveSearchApiKey: "" },
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

	it("treats user-provided URLs as mandatory opened sources", async () => {
		const directUrl = "https://shop.example.com/products/widget-pro";
		const openedUrls: string[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input.toString();
				if (url === "https://api.exa.ai/search") {
					return new Response(
						JSON.stringify({
							results: [
								{
									title: "Official Documentation",
									url: "https://docs.example.com/widget-pro",
									summary:
										"High-authority documentation, but not the requested page.",
									highlights: ["Documentation for Widget Pro."],
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url === "https://api.exa.ai/contents") {
					const body = JSON.parse(String(init?.body));
					openedUrls.push(...body.urls);
					return new Response(
						JSON.stringify({
							results: [
								{
									url: directUrl,
									title: "Widget Pro Store Page",
									text: "Widget Pro is currently listed at $249 on the store page.",
									highlights: [
										"Widget Pro is currently listed at $249 on the store page.",
									],
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				throw new Error(`Unexpected fetch: ${url}`);
			},
		);

		const result = await researchWeb(
			{
				query: `What price is shown on ${directUrl}?`,
				maxSources: 1,
			},
			{
				config: { ...webConfig, braveSearchApiKey: "" },
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
		expect(openedUrls).toEqual([directUrl]);
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0]).toMatchObject({
			canonicalUrl: directUrl,
			title: "Widget Pro Store Page",
		});
		expect(result.evidence[0]?.quote).toContain("$249");
		expect(result.answerBrief.markdown).toContain("Widget Pro Store Page");
		expect(result.answerBrief.markdown).toContain("$249");
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
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input.toString();
				if (url === "https://api.exa.ai/search") {
					return new Response(
						JSON.stringify({
							results: [
								{
									title: "Laptop Ultra Store",
									url: productUrl,
									summary:
										"Official product page with a long configuration section.",
									highlights: ["Laptop Ultra store listing."],
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url === "https://api.exa.ai/contents") {
					const body = JSON.parse(String(init?.body));
					expect(body.urls).toEqual([productUrl]);
					expect(body.text.maxCharacters).toBeGreaterThanOrEqual(12_000);
					return new Response(
						JSON.stringify({
							results: [
								{
									url: productUrl,
									title: "Laptop Ultra Store",
									text: deepText,
									highlights: [],
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				throw new Error(`Unexpected fetch: ${url}`);
			},
		);

		const result = await researchWeb(
			{
				query: "current Laptop Ultra price",
				mode: "exact",
				sourcePolicy: "commerce",
				maxSources: 1,
				quoteRequired: true,
			},
			{
				config: { ...webConfig, braveSearchApiKey: "" },
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
			if (url.startsWith("https://api.search.brave.com/res/v1/web/search")) {
				return new Response(
					JSON.stringify({
						web: {
							results: [
								{
									title: "Framework Laptop 16 Long-Term Review",
									url: videoUrl,
									description:
										"Video review covering battery life, fan noise, and buying advice.",
									extra_snippets: [
										"The review says battery life and repairability are the deciding factors.",
									],
								},
							],
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			if (url.startsWith("https://youtube.com/watch")) {
				return new Response(
					`<html><script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script></html>`,
					{ status: 200, headers: { "Content-Type": "text/html" } },
				);
			}

			if (url.startsWith(captionUrl)) {
				const transcriptRequest = new URL(url);
				expect(transcriptRequest.searchParams.get("fmt")).toBe("json3");
				return new Response(
					JSON.stringify({
						events: [
							{
								tStartMs: 0,
								dDurationMs: 4200,
								segs: [
									{
										utf8: "This is a hands-on review after three months with the Framework Laptop 16.",
									},
								],
							},
							{
								tStartMs: 4300,
								dDurationMs: 5000,
								segs: [
									{
										utf8: "Battery life lasted around eleven hours in mixed office work, while fan noise stayed low.",
									},
								],
							},
							{
								tStartMs: 9400,
								dDurationMs: 4300,
								segs: [
									{
										utf8: "The main reason to buy it is repairability, not the lowest price.",
									},
								],
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			throw new Error(`Unexpected fetch: ${url}`);
		});

		const result = await researchWeb(
			{
				query: "Framework Laptop 16 review",
				mode: "research",
				sourcePolicy: "commerce",
				maxSources: 1,
			},
			{
				config: { ...webConfig, exaApiKey: "" },
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
				rerank: async (params) => ({
					items: params.items
						.map((item, index) => ({
							item,
							index,
							score: item.quote.includes("eleven hours") ? 0.99 : 0.2,
						}))
						.sort((left, right) => right.score - left.score),
					confidence: 99,
				}),
			},
		);

		expect(result.queries.map((entry) => entry.query)).toContain(
			"Framework Laptop 16 review YouTube review transcript",
		);
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0]).toMatchObject({
			canonicalUrl: `https://youtube.com/watch?v=${videoId}`,
			title: "Framework Laptop 16 Long-Term Review",
			youtubeTranscript: {
				videoId,
				language: "English",
				languageCode: "en",
				isGenerated: true,
				isTranslated: false,
				snippetCount: 3,
			},
		});
		expect(result.evidence[0]?.quote).toContain("eleven hours");
		expect(result.answerBrief.markdown).toContain("Media: YouTube transcript");
		expect(result.diagnostics.youtubeTranscriptCandidateCount).toBe(1);
		expect(result.diagnostics.youtubeTranscriptFetchedCount).toBe(1);
		expect(result.diagnostics.youtubeTranscriptFailedCount).toBe(0);
		expect(result.diagnostics.fallbackReasons).not.toContain(
			"youtube_transcript_unavailable",
		);
	});

	it("keeps YouTube video sources when transcripts are unavailable", async () => {
		const videoId = "dQw4w9WgXcQ";
		const videoUrl = `https://youtu.be/${videoId}`;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.startsWith("https://youtube.com/watch")) {
				return new Response(
					`<html><script>var ytInitialPlayerResponse = ${JSON.stringify({
						videoDetails: { title: "Transcript Disabled Review" },
					})};</script></html>`,
					{ status: 200, headers: { "Content-Type": "text/html" } },
				);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});

		const result = await researchWeb(
			{
				query: `What does this review say? ${videoUrl}`,
				maxSources: 1,
			},
			{
				config: { ...webConfig, exaApiKey: "", braveSearchApiKey: "" },
				fetch: fetchMock,
				now: new Date("2026-05-02T12:00:00.000Z"),
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

		expect(result.sources).toHaveLength(1);
		expect(result.sources[0]?.canonicalUrl).toBe(
			`https://youtube.com/watch?v=${videoId}`,
		);
		expect(result.sources[0]?.youtubeTranscript).toBeUndefined();
		expect(result.diagnostics.youtubeTranscriptCandidateCount).toBe(1);
		expect(result.diagnostics.youtubeTranscriptFetchedCount).toBe(0);
		expect(result.diagnostics.youtubeTranscriptFailedCount).toBe(1);
		expect(result.diagnostics.youtubeTranscriptErrors[0]).toMatchObject({
			videoId,
			url: videoUrl,
			error: "transcript_unavailable",
		});
		expect(result.diagnostics.fallbackReasons).toContain(
			"youtube_transcript_unavailable",
		);
	});
});
