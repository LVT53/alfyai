import { describe, expect, it, vi } from "vitest";

import { fetchUrlViaParallel } from "./fetch-url";

const config = { parallelApiKey: "test-key" };

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

// Canned /v1/extract payload: one result with excerpts, one with only
// full_content and no excerpts.
function extractResponse(): Response {
	return jsonResponse({
		extract_id: "ex-1",
		results: [
			{
				url: "https://example.com/a",
				title: "Page A",
				publish_date: "2026-02-03",
				excerpts: ["A excerpt one", "A excerpt two"],
				full_content: "full content of page A",
			},
			{
				url: "https://example.com/b",
				title: "Page B",
				publish_date: null,
				excerpts: [],
				full_content: "B full content ".repeat(100),
			},
		],
		errors: [],
		warnings: [],
		usage: {},
	});
}

describe("fetchUrlViaParallel", () => {
	it("maps each extract result to a GroundedWebSource", async () => {
		const fetchMock = vi.fn(async () => extractResponse());

		const result = await fetchUrlViaParallel(
			{ urls: ["https://example.com/a", "https://example.com/b"] },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		expect(result.sources).toHaveLength(2);

		const [a, b] = result.sources;
		expect(a).toMatchObject({
			id: "e0",
			title: "Page A",
			url: "https://example.com/a",
			provider: "parallel",
			authorityClass: "standard",
			authorityScore: 60,
			snippet: "A excerpt one",
			highlights: ["A excerpt one", "A excerpt two"],
			providerRank: 0,
			publishedAt: "2026-02-03",
			updatedAt: null,
		});

		// Second result has no excerpts: snippet falls back to sliced full_content.
		expect(b.id).toBe("e1");
		expect(b.providerRank).toBe(1);
		expect(b.publishedAt).toBeNull();
		expect(b.snippet).toBe("B full content ".repeat(100).slice(0, 300));
		expect(b.highlights).toEqual([]);
	});

	it("emits one evidence per excerpt with descending scores", async () => {
		const fetchMock = vi.fn(async () => extractResponse());

		const result = await fetchUrlViaParallel(
			{ urls: ["https://example.com/a", "https://example.com/b"] },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		const fromA = result.evidence.filter((e) => e.sourceId === "e0");
		expect(fromA).toHaveLength(2);
		expect(fromA[0]).toMatchObject({
			id: "e0q0",
			sourceId: "e0",
			title: "Page A",
			url: "https://example.com/a",
			provider: "parallel",
			quote: "A excerpt one",
		});
		expect(fromA[1].id).toBe("e0q1");
		expect(fromA[1].quote).toBe("A excerpt two");

		// Scores strictly descending across the whole evidence array.
		for (let i = 1; i < result.evidence.length; i++) {
			expect(result.evidence[i].score).toBeLessThan(
				result.evidence[i - 1].score,
			);
		}
	});

	it("emits one evidence from full_content when a result has no excerpts", async () => {
		const fetchMock = vi.fn(async () => extractResponse());

		const result = await fetchUrlViaParallel(
			{ urls: ["https://example.com/a", "https://example.com/b"] },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		const fromB = result.evidence.filter((e) => e.sourceId === "e1");
		expect(fromB).toHaveLength(1);
		expect(fromB[0].id).toBe("e1q0");
		expect(fromB[0].quote).toBe("B full content ".repeat(100).slice(0, 900));
	});

	it("caps total evidence at 12 quotes across pages", async () => {
		// Two pages with 8 excerpts each = 16 total, exceeding the MAX_EVIDENCE cap.
		const manyExcerptsResponse = jsonResponse({
			extract_id: "ex-cap",
			results: [
				{
					url: "https://example.com/a",
					title: "Page A",
					publish_date: null,
					excerpts: Array.from({ length: 8 }, (_, i) => `A excerpt ${i}`),
					full_content: "full A",
				},
				{
					url: "https://example.com/b",
					title: "Page B",
					publish_date: null,
					excerpts: Array.from({ length: 8 }, (_, i) => `B excerpt ${i}`),
					full_content: "full B",
				},
			],
			errors: [],
			warnings: [],
			usage: {},
		});
		const fetchMock = vi.fn(async () => manyExcerptsResponse);

		const result = await fetchUrlViaParallel(
			{ urls: ["https://example.com/a", "https://example.com/b"] },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		expect(result.evidence).toHaveLength(12);
		// Scores remain strictly descending even at the cap.
		for (let i = 1; i < result.evidence.length; i++) {
			expect(result.evidence[i].score).toBeLessThan(
				result.evidence[i - 1].score,
			);
		}
	});

	it("produces a non-empty answer brief and query metadata", async () => {
		const fetchMock = vi.fn(async () => extractResponse());

		const result = await fetchUrlViaParallel(
			{ urls: ["https://example.com/a", "https://example.com/b"] },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		expect(result.answerBrief.markdown.length).toBeGreaterThan(0);
		expect(result.answerBrief.markdown).toContain("Page A");
		expect(result.answerBrief.markdown).toContain("https://example.com/a");
		expect(result.answerBrief.instructions).toEqual([
			"Answer only from these fetched pages.",
			"Cite claims with the returned page URLs.",
		]);
		expect(result.query).toBe("https://example.com/a, https://example.com/b");
		expect(result.queries).toEqual([
			{ query: "https://example.com/a" },
			{ query: "https://example.com/b" },
		]);
	});

	it("reports fetch diagnostics", async () => {
		const fetchMock = vi.fn(async () => extractResponse());

		const result = await fetchUrlViaParallel(
			{ urls: ["https://example.com/a", "https://example.com/b"] },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		expect(result.diagnostics.mode).toBe("fetch");
		expect(result.diagnostics.openedPageCount).toBe(2);
		expect(result.diagnostics.fetchedSourceCount).toBe(2);
		expect(result.diagnostics.selectedSourceCount).toBe(2);
		expect(result.diagnostics.pageExtraction.attemptedCount).toBe(2);
		expect(result.diagnostics.pageExtraction.succeededCount).toBe(2);
		expect(result.diagnostics.pageExtraction.failedCount).toBe(0);
	});

	it("returns an empty result with empty markdown when there are no results", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));

		const result = await fetchUrlViaParallel(
			{ urls: ["https://example.com/a"] },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		expect(result.sources).toEqual([]);
		expect(result.evidence).toEqual([]);
		expect(result.answerBrief.markdown).toBe("");
		expect(result.diagnostics.openedPageCount).toBe(1);
		expect(result.diagnostics.pageExtraction.failedCount).toBe(1);
	});

	it("uses the default objective when none is supplied", async () => {
		let body: { objective: string; urls: string[] } | undefined;
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				body = JSON.parse(init?.body as string);
				return extractResponse();
			},
		);

		await fetchUrlViaParallel(
			{ urls: ["https://example.com/a"] },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		expect(body?.objective).toBe(
			"Extract the key facts, details, and specifications from these pages.",
		);
	});

	it("forwards the abort signal to fetch", async () => {
		let capturedInit: RequestInit | undefined;
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				capturedInit = init;
				return extractResponse();
			},
		);
		const controller = new AbortController();

		await fetchUrlViaParallel(
			{ urls: ["https://example.com/a"] },
			{
				fetch: fetchMock as unknown as typeof fetch,
				config,
				signal: controller.signal,
			},
		);

		expect(capturedInit?.signal).toBe(controller.signal);
	});
});
