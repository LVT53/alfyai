import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGenerateText, mockOutputJson } = vi.hoisted(() => {
	const mockGenerateText = vi.fn();
	const mockOutputJson = vi.fn(() => ({ _tag: "output_json" }));
	return { mockGenerateText, mockOutputJson };
});

vi.mock("ai", () => ({
	generateText: mockGenerateText,
	Output: { json: mockOutputJson },
	APICallError: {
		isInstance: (error: unknown): error is Error =>
			error instanceof Error && error.name === "APICallError",
	},
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: vi.fn(() => (modelName: string) => ({
		_modelName: modelName,
		_providerName: "context-summarizer",
	})),
}));

const mockGetConfig = vi.fn();
vi.mock("$lib/server/config-store", () => ({
	getConfig: mockGetConfig,
}));

vi.mock("$lib/server/services/openai-compatible-url", () => ({
	normalizeOpenAICompatibleBaseUrl: vi.fn((url: string) => url),
}));

describe("parseJsonFromModel", () => {
	it("parses valid JSON from plain text", async () => {
		const { parseJsonFromModel } = await import("./control-model");
		const result = parseJsonFromModel('{"key": "value", "num": 42}');
		expect(result).toEqual({ key: "value", num: 42 });
	});

	it("parses valid JSON from markdown fenced code block", async () => {
		const { parseJsonFromModel } = await import("./control-model");
		const result = parseJsonFromModel('```json\n{"key": "value"}\n```');
		expect(result).toEqual({ key: "value" });
	});

	it("parses valid JSON from non-json markdown fence", async () => {
		const { parseJsonFromModel } = await import("./control-model");
		const result = parseJsonFromModel('```\n{"key": "value"}\n```');
		expect(result).toEqual({ key: "value" });
	});

	it("parses JSON with surrounding whitespace", async () => {
		const { parseJsonFromModel } = await import("./control-model");
		const result = parseJsonFromModel('  \n  {"key": "value"}\n  ');
		expect(result).toEqual({ key: "value" });
	});

	it("returns null for invalid JSON", async () => {
		const { parseJsonFromModel } = await import("./control-model");
		const result = parseJsonFromModel("not json at all");
		expect(result).toBeNull();
	});

	it("returns null for empty string", async () => {
		const { parseJsonFromModel } = await import("./control-model");
		const result = parseJsonFromModel("");
		expect(result).toBeNull();
	});

	it("returns null for non-object JSON (string)", async () => {
		const { parseJsonFromModel } = await import("./control-model");
		const result = parseJsonFromModel('"just a string"');
		expect(result).toBeNull();
	});

	it("returns null for non-object JSON (number)", async () => {
		const { parseJsonFromModel } = await import("./control-model");
		const result = parseJsonFromModel("42");
		expect(result).toBeNull();
	});

	it('returns arrays as valid objects (typeof [] === "object" in JS)', async () => {
		const { parseJsonFromModel } = await import("./control-model");
		const result = parseJsonFromModel("[1, 2, 3]");
		expect(result).toEqual([1, 2, 3]);
	});

	it("returns null for null JSON", async () => {
		const { parseJsonFromModel } = await import("./control-model");
		const result = parseJsonFromModel("null");
		expect(result).toBeNull();
	});

	it("handles array in fenced block (returns parsed array)", async () => {
		const { parseJsonFromModel } = await import("./control-model");
		const result = parseJsonFromModel('```json\n[{"id": "a"}]\n```');
		expect(result).toEqual([{ id: "a" }]);
	});
});

describe("canUseContextSummarizer", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns false when no URL configured", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "",
			contextSummarizerModel: "some-model",
		});
		const { canUseContextSummarizer } = await import("./control-model");
		expect(canUseContextSummarizer()).toBe(false);
	});

	it("returns false when URL has no protocol", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "localhost:8080",
			contextSummarizerModel: "some-model",
		});
		const { canUseContextSummarizer } = await import("./control-model");
		expect(canUseContextSummarizer()).toBe(false);
	});

	it("returns false when no model configured", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "http://localhost:8080/v1",
			contextSummarizerModel: "",
		});
		const { canUseContextSummarizer } = await import("./control-model");
		expect(canUseContextSummarizer()).toBe(false);
	});

	it("returns true when URL and model are configured", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "http://localhost:8080/v1",
			contextSummarizerModel: "some-model",
		});
		const { canUseContextSummarizer } = await import("./control-model");
		expect(canUseContextSummarizer()).toBe(true);
	});
});

describe("requestContextSummarizer", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns null when summarizer is unavailable", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "",
			contextSummarizerModel: "",
		});
		const { requestContextSummarizer } = await import("./control-model");
		const result = await requestContextSummarizer({
			system: "You are helpful.",
			user: "Hello",
			maxTokens: 100,
		});
		expect(result).toBeNull();
		expect(mockGenerateText).not.toHaveBeenCalled();
	});

	it("uses top-level system param instead of system role in messages", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "http://localhost:8080/v1",
			contextSummarizerModel: "test-model",
			contextSummarizerApiKey: "",
		});
		mockGenerateText.mockResolvedValueOnce({ text: "Plain response text." });

		const { requestContextSummarizer } = await import("./control-model");
		await requestContextSummarizer({
			system: "You are helpful.",
			user: "Hello",
			maxTokens: 100,
		});

		const callArgs = mockGenerateText.mock.calls[0][0];
		expect(callArgs.system).toBe("You are helpful.");
		expect(callArgs.messages).toEqual([{ role: "user", content: "Hello" }]);
		expect(callArgs.allowSystemInMessages).toBeUndefined();
	});

	it("returns trimmed text on success", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "http://localhost:8080/v1",
			contextSummarizerModel: "test-model",
			contextSummarizerApiKey: "",
		});
		mockGenerateText.mockResolvedValueOnce({ text: "  trimmed text  " });

		const { requestContextSummarizer } = await import("./control-model");
		const result = await requestContextSummarizer({
			system: "You are helpful.",
			user: "Hello",
			maxTokens: 100,
		});

		expect(result).toBe("trimmed text");
	});

	it("returns null when generateText throws APICallError", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "http://localhost:8080/v1",
			contextSummarizerModel: "test-model",
			contextSummarizerApiKey: "",
		});
		const apiError = new Error("API Error");
		apiError.name = "APICallError";
		mockGenerateText.mockRejectedValueOnce(apiError);

		const { requestContextSummarizer } = await import("./control-model");
		const result = await requestContextSummarizer({
			system: "You are helpful.",
			user: "Hello",
			maxTokens: 100,
		});

		expect(result).toBeNull();
	});

	it("passes temperature to generateText when provided", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "http://localhost:8080/v1",
			contextSummarizerModel: "test-model",
			contextSummarizerApiKey: "",
		});
		mockGenerateText.mockResolvedValueOnce({ text: "ok" });

		const { requestContextSummarizer } = await import("./control-model");
		await requestContextSummarizer({
			system: "You are helpful.",
			user: "Hello",
			maxTokens: 100,
			temperature: 0.7,
		});

		const callArgs = mockGenerateText.mock.calls[0][0];
		expect(callArgs.temperature).toBe(0.7);
	});

	it("uses default temperature 0.1 when not provided", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "http://localhost:8080/v1",
			contextSummarizerModel: "test-model",
			contextSummarizerApiKey: "",
		});
		mockGenerateText.mockResolvedValueOnce({ text: "ok" });

		const { requestContextSummarizer } = await import("./control-model");
		await requestContextSummarizer({
			system: "You are helpful.",
			user: "Hello",
			maxTokens: 100,
		});

		const callArgs = mockGenerateText.mock.calls[0][0];
		expect(callArgs.temperature).toBe(0.1);
	});

	it("uses maxRetries: 0", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "http://localhost:8080/v1",
			contextSummarizerModel: "test-model",
			contextSummarizerApiKey: "",
		});
		mockGenerateText.mockResolvedValueOnce({ text: "ok" });

		const { requestContextSummarizer } = await import("./control-model");
		await requestContextSummarizer({
			system: "You are helpful.",
			user: "Hello",
			maxTokens: 100,
		});

		const callArgs = mockGenerateText.mock.calls[0][0];
		expect(callArgs.maxRetries).toBe(0);
	});

	it("passes maxOutputTokens to generateText", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "http://localhost:8080/v1",
			contextSummarizerModel: "test-model",
			contextSummarizerApiKey: "",
		});
		mockGenerateText.mockResolvedValueOnce({ text: "ok" });

		const { requestContextSummarizer } = await import("./control-model");
		await requestContextSummarizer({
			system: "You are helpful.",
			user: "Hello",
			maxTokens: 500,
		});

		const callArgs = mockGenerateText.mock.calls[0][0];
		expect(callArgs.maxOutputTokens).toBe(500);
	});
});

describe("requestStructuredControlModel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns null when summarizer is unavailable", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "",
			contextSummarizerModel: "",
		});
		const { requestStructuredControlModel } = await import("./control-model");
		const result = await requestStructuredControlModel({
			system: "Return JSON.",
			user: "data",
			maxTokens: 100,
		});
		expect(result).toBeNull();
		expect(mockGenerateText).not.toHaveBeenCalled();
	});

	it("uses Output.json() for structured output", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "http://localhost:8080/v1",
			contextSummarizerModel: "test-model",
			contextSummarizerApiKey: "",
		});
		mockGenerateText.mockResolvedValueOnce({
			text: '{"key": "value"}',
			output: { key: "value" },
		});

		const { requestStructuredControlModel } = await import("./control-model");
		await requestStructuredControlModel({
			system: "Return JSON.",
			user: "data",
			maxTokens: 100,
		});

		const callArgs = mockGenerateText.mock.calls[0][0];
		expect(callArgs.output).toBeDefined();
		expect(callArgs.output._tag).toBe("output_json");
		expect(mockOutputJson).toHaveBeenCalled();
	});

	it("uses top-level system param instead of allowSystemInMessages", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "http://localhost:8080/v1",
			contextSummarizerModel: "test-model",
			contextSummarizerApiKey: "",
		});
		mockGenerateText.mockResolvedValueOnce({
			text: '{"key": "value"}',
			output: { key: "value" },
		});

		const { requestStructuredControlModel } = await import("./control-model");
		await requestStructuredControlModel({
			system: "Return JSON with projectId.",
			user: "data",
			maxTokens: 100,
		});

		const callArgs = mockGenerateText.mock.calls[0][0];
		expect(callArgs.system).toBe("Return JSON with projectId.");
		expect(callArgs.messages).toEqual([{ role: "user", content: "data" }]);
		expect(callArgs.allowSystemInMessages).toBeUndefined();
	});

	it("returns parsed output on success", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "http://localhost:8080/v1",
			contextSummarizerModel: "test-model",
			contextSummarizerApiKey: "",
		});
		mockGenerateText.mockResolvedValueOnce({
			text: '{"projectId": "proj-1", "confidence": 85}',
			output: { projectId: "proj-1", confidence: 85 },
		});

		const { requestStructuredControlModel } = await import("./control-model");
		const result = await requestStructuredControlModel<{
			projectId: string;
			confidence: number;
		}>({
			system: "Return JSON.",
			user: "data",
			maxTokens: 100,
		});

		expect(result).toEqual({ projectId: "proj-1", confidence: 85 });
	});

	it("returns null when output is null", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "http://localhost:8080/v1",
			contextSummarizerModel: "test-model",
			contextSummarizerApiKey: "",
		});
		mockGenerateText.mockResolvedValueOnce({
			text: "invalid response",
			output: null,
		});

		const { requestStructuredControlModel } = await import("./control-model");
		const result = await requestStructuredControlModel({
			system: "Return JSON.",
			user: "data",
			maxTokens: 100,
		});

		expect(result).toBeNull();
	});

	it("returns null when output is undefined", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "http://localhost:8080/v1",
			contextSummarizerModel: "test-model",
			contextSummarizerApiKey: "",
		});
		mockGenerateText.mockResolvedValueOnce({
			text: "invalid response",
			output: undefined,
		});

		const { requestStructuredControlModel } = await import("./control-model");
		const result = await requestStructuredControlModel({
			system: "Return JSON.",
			user: "data",
			maxTokens: 100,
		});

		expect(result).toBeNull();
	});

	it("returns null when output is a non-object (string)", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "http://localhost:8080/v1",
			contextSummarizerModel: "test-model",
			contextSummarizerApiKey: "",
		});
		mockGenerateText.mockResolvedValueOnce({
			text: '"just a string"',
			output: "just a string",
		});

		const { requestStructuredControlModel } = await import("./control-model");
		const result = await requestStructuredControlModel({
			system: "Return JSON.",
			user: "data",
			maxTokens: 100,
		});

		expect(result).toBeNull();
	});

	it("returns null on APICallError", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "http://localhost:8080/v1",
			contextSummarizerModel: "test-model",
			contextSummarizerApiKey: "",
		});
		const apiError = new Error("API Error");
		apiError.name = "APICallError";
		mockGenerateText.mockRejectedValueOnce(apiError);

		const { requestStructuredControlModel } = await import("./control-model");
		const result = await requestStructuredControlModel({
			system: "Return JSON.",
			user: "data",
			maxTokens: 100,
		});

		expect(result).toBeNull();
	});

	it("returns null on non-API errors", async () => {
		mockGetConfig.mockReturnValue({
			contextSummarizerUrl: "http://localhost:8080/v1",
			contextSummarizerModel: "test-model",
			contextSummarizerApiKey: "",
		});
		mockGenerateText.mockRejectedValueOnce(new Error("Network error"));

		const { requestStructuredControlModel } = await import("./control-model");
		const result = await requestStructuredControlModel({
			system: "Return JSON.",
			user: "data",
			maxTokens: 100,
		});

		expect(result).toBeNull();
	});
});
