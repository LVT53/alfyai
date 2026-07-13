import { describe, expect, it, vi } from "vitest";

import { researchWebViaParallel } from "./research";

const config = { parallelApiKey: "test-key" };

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const twoResultBody = {
	search_id: "s-1",
	session_id: "sess-1",
	results: [
		{
			url: "https://example.com/a",
			title: "Result A",
			publish_date: "2026-01-01",
			excerpts: ["A excerpt one", "A excerpt two", "A excerpt three"],
		},
		{
			url: "https://example.com/b",
			title: "Result B",
			publish_date: null,
			excerpts: ["B excerpt one"],
		},
	],
};

describe("researchWebViaParallel", () => {
	it("maps Parallel search results into the frozen GroundedWebResult shape", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(twoResultBody));

		const result = await researchWebViaParallel(
			{ query: "widget price" },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.query).toBe("widget price");
		expect(result.queries).toEqual([{ query: "widget price" }]);

		// Sources mapped one-per-result.
		expect(result.sources).toHaveLength(2);
		expect(result.sources[0]).toEqual({
			id: "p0",
			title: "Result A",
			url: "https://example.com/a",
			provider: "parallel",
			authorityClass: "standard",
			authorityScore: 50,
			snippet: "A excerpt one",
			highlights: ["A excerpt one", "A excerpt two", "A excerpt three"],
			providerRank: 0,
			publishedAt: "2026-01-01",
			updatedAt: null,
		});
		expect(result.sources[1]).toMatchObject({
			id: "p1",
			url: "https://example.com/b",
			snippet: "B excerpt one",
			highlights: ["B excerpt one"],
			providerRank: 1,
			publishedAt: null,
		});
	});

	it("emits one evidence per excerpt linked by sourceId with descending scores", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(twoResultBody));

		const result = await researchWebViaParallel(
			{ query: "widget price" },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		// 3 excerpts (source 0) + 1 excerpt (source 1) = 4 evidence.
		expect(result.evidence).toHaveLength(4);
		expect(result.evidence[0]).toMatchObject({
			id: "p0e0",
			sourceId: "p0",
			title: "Result A",
			url: "https://example.com/a",
			provider: "parallel",
			quote: "A excerpt one",
		});
		expect(result.evidence[3]).toMatchObject({
			id: "p1e0",
			sourceId: "p1",
			quote: "B excerpt one",
		});
		// Scores strictly descending across the flattened evidence list.
		for (let i = 1; i < result.evidence.length; i++) {
			expect(result.evidence[i].score).toBeLessThan(
				result.evidence[i - 1].score,
			);
		}
	});

	it("caps total evidence at 12", async () => {
		const results = Array.from({ length: 5 }, (_, i) => ({
			url: `https://example.com/${i}`,
			title: `Result ${i}`,
			publish_date: null,
			excerpts: Array.from({ length: 4 }, (_, j) => `r${i} excerpt ${j}`),
		}));
		const fetchMock = vi.fn(async () => jsonResponse({ results }));

		const result = await researchWebViaParallel(
			{ query: "many" },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		// 5 * 4 = 20 candidate excerpts, capped to 12.
		expect(result.evidence).toHaveLength(12);
		expect(result.sources).toHaveLength(5);
	});

	it("synthesizes a non-empty answer brief containing source URLs", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(twoResultBody));

		const result = await researchWebViaParallel(
			{ query: "widget price" },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		expect(result.answerBrief.markdown).not.toBe("");
		expect(result.answerBrief.markdown).toContain("https://example.com/a");
		expect(result.answerBrief.markdown).toContain("Result A");
		expect(result.answerBrief.instructions).toEqual([
			"Answer only from these sources.",
			"Cite claims with the returned source URLs.",
			"Do not cite URLs outside this list.",
		]);
	});

	it("reports diagnostics counts from the mapped results", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(twoResultBody));

		const result = await researchWebViaParallel(
			{ query: "widget price" },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		expect(result.diagnostics.mode).toBe("turbo");
		expect(result.diagnostics.provider).toBe("parallel");
		expect(result.diagnostics.plannedQueryCount).toBe(1);
		expect(result.diagnostics.fetchedSourceCount).toBe(2);
		expect(result.diagnostics.fusedSourceCount).toBe(2);
		expect(result.diagnostics.selectedSourceCount).toBe(2);
		expect(result.diagnostics.evidenceCandidateCount).toBe(4);
		expect(typeof result.diagnostics.searchLatencyMs).toBe("number");
		expect(result.diagnostics.searchLatencyMs).toBeGreaterThanOrEqual(0);
	});

	it("returns empty sources/evidence and empty markdown on zero results", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));

		const result = await researchWebViaParallel(
			{ query: "nothing here" },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		expect(result.sources).toEqual([]);
		expect(result.evidence).toEqual([]);
		expect(result.answerBrief.markdown).toBe("");
		expect(result.diagnostics.fetchedSourceCount).toBe(0);
		expect(result.diagnostics.evidenceCandidateCount).toBe(0);
	});

	it("forwards the model-supplied objective and searchQueries to the search body", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				capturedBody = JSON.parse(init?.body as string);
				return jsonResponse(twoResultBody);
			},
		);

		await researchWebViaParallel(
			{
				query: "widget price",
				objective: "Find the current retail price of the widget in 2026",
				searchQueries: ["widget price 2026", "widget retail cost"],
			},
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		expect(capturedBody?.objective).toBe(
			"Find the current retail price of the widget in 2026",
		);
		expect(capturedBody?.search_queries).toEqual([
			"widget price 2026",
			"widget retail cost",
		]);
		expect(capturedBody?.mode).toBe("turbo");
	});

	it("falls back to the raw query for objective and search_queries when omitted", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				capturedBody = JSON.parse(init?.body as string);
				return jsonResponse(twoResultBody);
			},
		);

		await researchWebViaParallel(
			{ query: "widget price" },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		expect(capturedBody?.objective).toBe("widget price");
		expect(capturedBody?.search_queries).toEqual(["widget price"]);
		expect(capturedBody?.session_id).toBeUndefined();
		expect(capturedBody?.advanced_settings).toBeUndefined();
	});

	it("also falls back when searchQueries is an empty array", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				capturedBody = JSON.parse(init?.body as string);
				return jsonResponse(twoResultBody);
			},
		);

		await researchWebViaParallel(
			{ query: "widget price", searchQueries: [] },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		expect(capturedBody?.search_queries).toEqual(["widget price"]);
	});

	it("threads sessionId and excerptMaxChars from opts into the search body", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				capturedBody = JSON.parse(init?.body as string);
				return jsonResponse(twoResultBody);
			},
		);

		await researchWebViaParallel(
			{ query: "widget price" },
			{ fetch: fetchMock as unknown as typeof fetch, config },
			{ sessionId: "conversation-42", excerptMaxChars: 2000 },
		);

		expect(capturedBody?.session_id).toBe("conversation-42");
		expect(capturedBody?.advanced_settings).toEqual({
			excerpt_settings: { max_chars_per_result: 2000 },
		});
	});

	it("propagates an aborted fetch rejection", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchMock = vi.fn(async (_input: RequestInfo | URL) => {
			throw new DOMException("The operation was aborted.", "AbortError");
		});

		await expect(
			researchWebViaParallel(
				{ query: "widget price" },
				{
					fetch: fetchMock as unknown as typeof fetch,
					config,
					signal: controller.signal,
				},
			),
		).rejects.toThrow(/abort/i);
	});
});
