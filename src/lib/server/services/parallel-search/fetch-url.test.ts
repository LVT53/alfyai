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
			// full_content is the primary snippet source now (detailed page body).
			snippet: "full content of page A",
			highlights: ["A excerpt one", "A excerpt two"],
			providerRank: 0,
			publishedAt: "2026-02-03",
			updatedAt: null,
		});

		// Second result has no excerpts: snippet still comes from full_content.
		expect(b.id).toBe("e1");
		expect(b.providerRank).toBe(1);
		expect(b.publishedAt).toBeNull();
		expect(b.snippet).toBe("B full content ".repeat(100).slice(0, 300));
		expect(b.highlights).toEqual([]);
	});

	it("emits a full_content quote plus one evidence per excerpt with descending scores", async () => {
		const fetchMock = vi.fn(async () => extractResponse());

		const result = await fetchUrlViaParallel(
			{ urls: ["https://example.com/a", "https://example.com/b"] },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		const fromA = result.evidence.filter((e) => e.sourceId === "e0");
		// full_content quote (primary) followed by the two targeted excerpts.
		expect(fromA).toHaveLength(3);
		expect(fromA[0]).toMatchObject({
			id: "e0q0",
			sourceId: "e0",
			title: "Page A",
			url: "https://example.com/a",
			provider: "parallel",
			quote: "full content of page A",
		});
		expect(fromA[1]).toMatchObject({ id: "e0q1", quote: "A excerpt one" });
		expect(fromA[2]).toMatchObject({ id: "e0q2", quote: "A excerpt two" });

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

	it("emits each page's full_content body into the answer brief", async () => {
		const fetchMock = vi.fn(async () => extractResponse());

		const result = await fetchUrlViaParallel(
			{ urls: ["https://example.com/a", "https://example.com/b"] },
			{ fetch: fetchMock as unknown as typeof fetch, config },
		);

		// The FULL page bodies flow through the brief (both small, under budget),
		// not just the ~300/900-char citation snippets.
		expect(result.answerBrief.markdown).toContain("full content of page A");
		expect(result.answerBrief.markdown).toContain(
			"B full content ".repeat(100),
		);
		// Excerpts remain as a short lead-in above the body.
		expect(result.answerBrief.markdown).toContain("A excerpt one");
	});

	it("bounds each page's full_content body to floor(maxCharsTotal / pageCount)", async () => {
		const bigResponse = jsonResponse({
			extract_id: "ex-big",
			results: [
				{
					url: "https://example.com/a",
					title: "Page A",
					publish_date: null,
					excerpts: [],
					full_content: "A".repeat(5000),
				},
				{
					url: "https://example.com/b",
					title: "Page B",
					publish_date: null,
					excerpts: [],
					full_content: "B".repeat(5000),
				},
			],
			errors: [],
			warnings: [],
			usage: {},
		});
		const fetchMock = vi.fn(async () => bigResponse);

		const result = await fetchUrlViaParallel(
			{ urls: ["https://example.com/a", "https://example.com/b"] },
			{ fetch: fetchMock as unknown as typeof fetch, config },
			// 2 pages, 4000-char total budget -> 2000 chars/page.
			{ maxCharsTotal: 4000 },
		);

		// Each 5000-char body is truncated to its 2000-char budget + ellipsis.
		expect(result.answerBrief.markdown).toContain(`${"A".repeat(2000)}…`);
		expect(result.answerBrief.markdown).toContain(`${"B".repeat(2000)}…`);
		// The over-budget tail did NOT survive.
		expect(result.answerBrief.markdown).not.toContain("A".repeat(2001));
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

	it("requests detailed full_content on every extract call", async () => {
		let body: { advanced_settings?: { full_content?: boolean } } | undefined;
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

		expect(body?.advanced_settings?.full_content).toBe(true);
	});

	it("passes sessionId, maxCharsTotal, and searchQueries through to extract", async () => {
		let body:
			| {
					session_id?: string;
					max_chars_total?: number;
					search_queries?: string[];
					advanced_settings?: { full_content?: boolean };
			  }
			| undefined;
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				body = JSON.parse(init?.body as string);
				return extractResponse();
			},
		);

		await fetchUrlViaParallel(
			{ urls: ["https://example.com/a"] },
			{ fetch: fetchMock as unknown as typeof fetch, config },
			{
				sessionId: "conversation-9",
				maxCharsTotal: 100_000,
				searchQueries: ["price", "specs"],
			},
		);

		expect(body?.session_id).toBe("conversation-9");
		expect(body?.max_chars_total).toBe(100_000);
		expect(body?.search_queries).toEqual(["price", "specs"]);
		expect(body?.advanced_settings?.full_content).toBe(true);
	});

	it("omits sessionId and maxCharsTotal when no opts are supplied", async () => {
		let body: { session_id?: string; max_chars_total?: number } | undefined;
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

		expect(body?.session_id).toBeUndefined();
		expect(body?.max_chars_total).toBeUndefined();
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
