import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRuntimeConfig } = vi.hoisted(() => ({
	mockRuntimeConfig: {
		teiEmbedderUrl: "",
		teiEmbedderApiKey: "",
		teiEmbedderModel: "",
		teiEmbedderBatchSize: 32,
		teiRerankerUrl: "http://localhost:8082",
		teiRerankerApiKey: "",
		teiRerankerModel: "bge-reranker-v2-m3",
		teiRerankerMaxTexts: 3,
		teiTimeoutMs: 5000,
	},
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: () => mockRuntimeConfig,
}));

vi.stubGlobal("fetch", vi.fn());

function firstFetchRequest(): RequestInit | undefined {
	const firstCall = vi.mocked(fetch).mock.calls[0];
	expect(firstCall).toBeDefined();
	if (!firstCall) throw new Error("Expected fetch to be called");
	return firstCall[1];
}

describe("tei-reranker service", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockRuntimeConfig.teiRerankerUrl = "http://localhost:8082";
		mockRuntimeConfig.teiRerankerApiKey = "";
		mockRuntimeConfig.teiRerankerModel = "bge-reranker-v2-m3";
		mockRuntimeConfig.teiRerankerMaxTexts = 3;
		mockRuntimeConfig.teiTimeoutMs = 5000;
	});

	it("returns null without calling fetch when the reranker is not configured", async () => {
		mockRuntimeConfig.teiRerankerUrl = "";

		const { rerankTexts, canUseTeiReranker } = await import("./tei-reranker");
		const result = await rerankTexts({ query: "alpha", texts: ["a", "b"] });

		expect(canUseTeiReranker()).toBe(false);
		expect(result).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("posts to /rerank, respects max text limits, and parses sorted_results", async () => {
		mockRuntimeConfig.teiRerankerApiKey = "secret";
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				JSON.stringify({
					sorted_results: [
						{ index: 1, score: 0.95, text: "beta" },
						{ index: 0, score: 0.75, text: "alpha" },
					],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const { rerankTexts } = await import("./tei-reranker");
		const result = await rerankTexts({
			query: "best option",
			texts: ["alpha", "beta", "gamma", "delta"],
			truncate: false,
			returnText: true,
		});

		expect(result).toEqual([
			{ index: 1, score: 0.95, text: "beta" },
			{ index: 0, score: 0.75, text: "alpha" },
		]);
		expect(fetch).toHaveBeenCalledWith(
			"http://localhost:8082/rerank",
			expect.objectContaining({
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer secret",
				},
			}),
		);

		const request = firstFetchRequest();
		expect(JSON.parse(String(request?.body))).toEqual({
			query: "best option",
			texts: ["alpha", "beta", "gamma"],
			truncate: false,
			return_text: true,
			raw_scores: false,
		});
	});

	it("clamps explicit text limits to the configured TEI reranker maximum", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{ index: 2, score: 0.9 },
						{ index: 0, score: 0.3 },
					],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const { rerankTexts } = await import("./tei-reranker");
		await rerankTexts({
			query: "rank",
			texts: ["a", "b", "c", "d", "e"],
			maxTexts: 5,
		});

		const request = firstFetchRequest();
		expect(JSON.parse(String(request?.body)).texts).toEqual(["a", "b", "c"]);
	});

	it("accepts the results response shape and sorts by score descending", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{ index: 2, score: 0.1 },
						{ index: 0, score: 0.9 },
						{ index: 1, score: 0.4 },
					],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const { rerankTexts } = await import("./tei-reranker");
		const result = await rerankTexts({ query: "rank", texts: ["a", "b", "c"] });

		expect(result).toEqual([
			{ index: 0, score: 0.9 },
			{ index: 1, score: 0.4 },
			{ index: 2, score: 0.1 },
		]);
	});

	it("maps reranked results back onto the original items with confidence", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{ index: 1, score: 0.92 },
						{ index: 0, score: 0.44 },
					],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const { rerankItems } = await import("./tei-reranker");
		const result = await rerankItems({
			query: "best item",
			items: [
				{ id: "a", text: "alpha" },
				{ id: "b", text: "beta" },
			],
			getText: (item) => item.text,
		});

		expect(result).toEqual({
			items: [
				{ item: { id: "b", text: "beta" }, index: 1, score: 0.92 },
				{ item: { id: "a", text: "alpha" }, index: 0, score: 0.44 },
			],
			confidence: 92,
		});
	});

	it("reports rerank diagnostics for limited inputs and confidence", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{ index: 0, score: 0.88 },
						{ index: 1, score: 0.25 },
					],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const diagnostics = vi.fn();
		const { rerankItems } = await import("./tei-reranker");
		await rerankItems({
			query: "best item",
			items: [
				{ text: "alpha" },
				{ text: "beta" },
				{ text: "gamma" },
				{ text: "delta" },
			],
			getText: (item) => item.text,
			maxTexts: 2,
			onDiagnostics: diagnostics,
		});

		expect(diagnostics).toHaveBeenCalledWith(
			expect.objectContaining({
				queryLength: "best item".length,
				inputCount: 4,
				limitedCount: 2,
				outputCount: 2,
				fallbackReason: null,
				confidence: 88,
			}),
		);
	});

	it("clamps rerankItems explicit limits before calling TEI", async () => {
		mockRuntimeConfig.teiRerankerMaxTexts = 2;
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{ index: 1, score: 0.91 },
						{ index: 0, score: 0.45 },
					],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const diagnostics = vi.fn();
		const { rerankItems } = await import("./tei-reranker");
		await rerankItems({
			query: "best item",
			items: [{ text: "alpha" }, { text: "beta" }, { text: "gamma" }],
			getText: (item) => item.text,
			maxTexts: 3,
			onDiagnostics: diagnostics,
		});

		const request = firstFetchRequest();
		expect(JSON.parse(String(request?.body)).texts).toEqual(["alpha", "beta"]);
		expect(diagnostics).toHaveBeenCalledWith(
			expect.objectContaining({
				inputCount: 3,
				limitedCount: 2,
			}),
		);
	});
});
