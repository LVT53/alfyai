import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wire-level coverage for the qwen-family sampling defaults fix.
//
// control-model.test.ts mocks `ai` and `@ai-sdk/openai-compatible` outright,
// which is right for testing call args but can't prove what actually lands
// in the outbound HTTP body. These tests instead let the real AI SDK +
// openai-compatible provider run against a stubbed global fetch — the same
// pattern normal-chat-control-model.test.ts and title-generator.test.ts use
// to prove qwen sampling defaults (temperature/topP/topK) actually reach the
// wire, not just a mocked call-args object.
// `vi.hoisted` (not a bare top-level `const`) because this file, like
// normal-chat-control-model.test.ts, does a static top-level import of the
// module under test right below — the `vi.mock` factory then runs during
// that import, before any later `const` would have initialized.
const mockGetConfig = vi.hoisted(() => vi.fn());
vi.mock("$lib/server/config-store", () => ({
	getConfig: mockGetConfig,
}));

import {
	requestContextSummarizer,
	requestStructuredControlModel,
} from "./control-model";

function jsonResponse(content: string) {
	return new Response(
		JSON.stringify({
			id: "chatcmpl-1",
			model: "provider-returned-model",
			created: 1_717_171_717,
			choices: [
				{
					index: 0,
					message: { role: "assistant", content },
					finish_reason: "stop",
				},
			],
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function requestBody(mockFetch: ReturnType<typeof vi.fn>) {
	const callArgs = mockFetch.mock.calls[0]?.[1] as { body?: unknown };
	return JSON.parse(typeof callArgs?.body === "string" ? callArgs.body : "{}");
}

describe("task-state control-model wire-level sampling", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe("requestContextSummarizer", () => {
		it("applies the qwen family's tuned temperature/topP/topK when the caller sets no temperature", async () => {
			mockGetConfig.mockReturnValue({
				contextSummarizerUrl: "http://192.168.1.96:30000/v1",
				contextSummarizerModel: "qwen3-6-27b",
				contextSummarizerApiKey: "",
			});
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(jsonResponse("Plain response text."));

			await requestContextSummarizer({
				system: "You are helpful.",
				user: "Hello",
				maxTokens: 100,
			});

			const body = requestBody(mockFetch);
			expect(body.temperature).toBe(0.6);
			expect(body.top_p).toBe(0.95);
			expect(body.top_k).toBe(20);
		});

		it("keeps an explicit caller temperature while still applying topP/topK", async () => {
			mockGetConfig.mockReturnValue({
				contextSummarizerUrl: "http://192.168.1.96:30000/v1",
				contextSummarizerModel: "qwen3-6-27b",
				contextSummarizerApiKey: "",
			});
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(jsonResponse("Plain response text."));

			await requestContextSummarizer({
				system: "You are helpful.",
				user: "Hello",
				maxTokens: 100,
				temperature: 0,
			});

			const body = requestBody(mockFetch);
			expect(body.temperature).toBe(0);
			expect(body.top_p).toBe(0.95);
			expect(body.top_k).toBe(20);
		});

		it("does not apply qwen sampling defaults to a non-qwen summarizer model", async () => {
			mockGetConfig.mockReturnValue({
				contextSummarizerUrl:
					"https://openai-compatible.example/v1/chat/completions",
				contextSummarizerModel: "gpt-4.1",
				contextSummarizerApiKey: "",
			});
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(jsonResponse("Plain response text."));

			await requestContextSummarizer({
				system: "You are helpful.",
				user: "Hello",
				maxTokens: 100,
			});

			const body = requestBody(mockFetch);
			expect(body.temperature).toBe(0.1);
			expect(body).not.toHaveProperty("top_p");
			expect(body).not.toHaveProperty("top_k");
		});
	});

	describe("requestStructuredControlModel", () => {
		it("applies the qwen family's tuned temperature/topP/topK when the caller sets no temperature", async () => {
			mockGetConfig.mockReturnValue({
				contextSummarizerUrl: "http://192.168.1.96:30000/v1",
				contextSummarizerModel: "qwen3-6-27b",
				contextSummarizerApiKey: "",
			});
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(jsonResponse('{"ok":true}'));

			await requestStructuredControlModel({
				system: "Return JSON.",
				user: "data",
				maxTokens: 100,
			});

			const body = requestBody(mockFetch);
			expect(body.temperature).toBe(0.6);
			expect(body.top_p).toBe(0.95);
			expect(body.top_k).toBe(20);
		});

		it("does not apply qwen sampling defaults to a non-qwen summarizer model", async () => {
			mockGetConfig.mockReturnValue({
				contextSummarizerUrl:
					"https://openai-compatible.example/v1/chat/completions",
				contextSummarizerModel: "gpt-4.1",
				contextSummarizerApiKey: "",
			});
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(jsonResponse('{"ok":true}'));

			await requestStructuredControlModel({
				system: "Return JSON.",
				user: "data",
				maxTokens: 100,
			});

			const body = requestBody(mockFetch);
			expect(body.temperature).toBe(0.1);
			expect(body).not.toHaveProperty("top_p");
			expect(body).not.toHaveProperty("top_k");
		});
	});
});
