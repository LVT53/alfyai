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
	beforeEach(() => {
		vi.resetAllMocks();
		mockRuntimeConfig.teiEmbedderUrl = "http://localhost:8081";
		mockRuntimeConfig.teiEmbedderApiKey = "";
		mockRuntimeConfig.teiEmbedderModel = "bge-m3";
		mockRuntimeConfig.teiEmbedderBatchSize = 32;
		mockRuntimeConfig.teiTimeoutMs = 5000;
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
