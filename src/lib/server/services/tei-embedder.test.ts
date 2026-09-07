import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRuntimeConfig } = vi.hoisted(() => ({
	mockRuntimeConfig: {
		teiEmbedderUrl: "http://localhost:8081",
		teiEmbedderApiKey: "",
		teiEmbedderModel: "bge-m3",
		teiEmbedderBatchSize: 32,
		teiRerankerUrl: "",
		teiRerankerApiKey: "",
		teiRerankerModel: "",
		teiRerankerMaxTexts: 32,
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

describe("tei-embedder service", () => {
	beforeEach(async () => {
		vi.resetAllMocks();
		mockRuntimeConfig.teiEmbedderUrl = "http://localhost:8081";
		mockRuntimeConfig.teiEmbedderApiKey = "";
		mockRuntimeConfig.teiEmbedderModel = "bge-m3";
		mockRuntimeConfig.teiEmbedderBatchSize = 32;
		mockRuntimeConfig.teiTimeoutMs = 5000;
		const { resetLearnedTeiBatchLimitForTests } = await import(
			"./tei-embedder"
		);
		resetLearnedTeiBatchLimitForTests();
	});

	function embedResponse(count: number, offset = 0): Response {
		return new Response(
			JSON.stringify(Array.from({ length: count }, (_, i) => [offset + i, 0])),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}

	function requestInputs(callIndex: number): string[] {
		const call = vi.mocked(fetch).mock.calls[callIndex];
		if (!call) throw new Error(`Expected fetch call ${callIndex}`);
		return JSON.parse(String(call[1]?.body)).inputs;
	}

	it("chunks 13 inputs into requests of 8 and 5 at the configured batch size", async () => {
		mockRuntimeConfig.teiEmbedderBatchSize = 8;
		vi.mocked(fetch)
			.mockResolvedValueOnce(embedResponse(8))
			.mockResolvedValueOnce(embedResponse(5, 8));

		const { embedTexts } = await import("./tei-embedder");
		const texts = Array.from({ length: 13 }, (_, i) => `t${i}`);
		const result = await embedTexts(texts);

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(requestInputs(0)).toEqual(texts.slice(0, 8));
		expect(requestInputs(1)).toEqual(texts.slice(8));
		expect(result).toHaveLength(13);
		expect(result?.[12]).toEqual([12, 0]);
	});

	it("learns a lower server batch limit from the 422 and retries with it", async () => {
		mockRuntimeConfig.teiEmbedderBatchSize = 32;
		vi.mocked(fetch)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: "batch size 13 > maximum allowed batch size 8",
						error_type: "Validation",
					}),
					{ status: 422, statusText: "Unprocessable Entity" },
				),
			)
			.mockResolvedValueOnce(embedResponse(8))
			.mockResolvedValueOnce(embedResponse(5, 8));
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const { embedTexts, getTeiEmbedderBatchSize } = await import(
			"./tei-embedder"
		);
		const texts = Array.from({ length: 13 }, (_, i) => `t${i}`);
		const result = await embedTexts(texts);

		expect(fetch).toHaveBeenCalledTimes(3);
		expect(requestInputs(0)).toHaveLength(13);
		expect(requestInputs(1)).toEqual(texts.slice(0, 8));
		expect(requestInputs(2)).toEqual(texts.slice(8));
		expect(result).toHaveLength(13);
		// The learned limit now caps later calls without another 422.
		expect(getTeiEmbedderBatchSize()).toBe(8);
	});

	it("rethrows a 422 that does not name a batch limit", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "bad input" }), {
				status: 422,
				statusText: "Unprocessable Entity",
			}),
		);

		const { embedTexts } = await import("./tei-embedder");
		await expect(embedTexts(["a", "b"])).rejects.toThrow(
			"TEI request failed: 422",
		);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("returns null without calling fetch when the embedder is not configured", async () => {
		mockRuntimeConfig.teiEmbedderUrl = "";

		const { embedTexts, canUseTeiEmbedder } = await import("./tei-embedder");
		const result = await embedTexts(["alpha"]);

		expect(canUseTeiEmbedder()).toBe(false);
		expect(result).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("posts batched inputs to /embed and parses embeddings objects", async () => {
		mockRuntimeConfig.teiEmbedderApiKey = "secret";
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				JSON.stringify({
					embeddings: [
						[0.1, 0.2],
						[0.3, 0.4],
					],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const { embedTexts } = await import("./tei-embedder");
		const result = await embedTexts(["alpha", "beta"], {
			normalize: false,
			truncate: false,
		});

		expect(result).toEqual([
			[0.1, 0.2],
			[0.3, 0.4],
		]);
		expect(fetch).toHaveBeenCalledWith(
			"http://localhost:8081/embed",
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
			inputs: ["alpha", "beta"],
			normalize: false,
			truncate: false,
		});
	});

	it("normalizes a single-vector array response into a matrix", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(JSON.stringify([0.5, 0.6, 0.7]), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const { embedText } = await import("./tei-embedder");
		const result = await embedText("single");

		expect(result).toEqual([0.5, 0.6, 0.7]);
	});

	it("passes an embedding prompt name when requested", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(JSON.stringify([[0.1, 0.2]]), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const { embedText } = await import("./tei-embedder");
		await embedText("semantic query", { promptName: "query" });

		const request = firstFetchRequest();
		expect(JSON.parse(String(request?.body))).toEqual({
			inputs: ["semantic query"],
			normalize: true,
			truncate: true,
			prompt_name: "query",
		});
	});
});
