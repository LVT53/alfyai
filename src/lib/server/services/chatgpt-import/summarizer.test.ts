import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dbPath: string;

const { mockGenerateText, mockGetConfig, mockCreateOpenAICompatible } =
	vi.hoisted(() => {
		const mockModel = vi.fn();
		return {
			mockGenerateText: vi.fn(),
			mockGetConfig: vi.fn(() => ({
				requestTimeoutMs: 300000,
			})),
			mockCreateOpenAICompatible: vi.fn(() => mockModel),
		};
	});

vi.mock("ai", () => ({
	generateText: mockGenerateText,
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: mockCreateOpenAICompatible,
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: mockGetConfig,
}));

vi.mock("$lib/server/services/normal-chat-model", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("$lib/server/services/normal-chat-model")
		>();
	return {
		...actual,
		resolveNormalChatModelRunProvider: vi.fn(async () => ({
			name: "mock-model",
			displayName: "Mock Model",
			baseUrl: "http://localhost:30001/v1",
			modelName: "mock-model-1",
			apiKey: "",
			maxOutputTokens: 4096,
		})),
	};
});

vi.mock("$lib/server/services/openai-compatible-url", () => ({
	normalizeOpenAICompatibleBaseUrl: (url: string) => url,
}));

describe("summarizer — pure helpers", () => {
	it("estimateChars sums role + content + overhead", async () => {
		const { estimateChars } = await import("./summarizer");
		const messages = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there!" },
		];
		expect(estimateChars(messages)).toBe(35);
	});

	it("estimateTokens converts chars to tokens (~4 chars/token)", async () => {
		const { estimateTokens } = await import("./summarizer");
		expect(estimateTokens(400)).toBe(100);
		expect(estimateTokens(401)).toBe(101);
		expect(estimateTokens(0)).toBe(0);
	});

	it("chunkMessages returns single chunk for small input", async () => {
		const { chunkMessages } = await import("./summarizer");
		const messages = [
			{ role: "user", content: "Hi" },
			{ role: "assistant", content: "Hello" },
		];
		const chunks = chunkMessages(messages);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toEqual(messages);
	});

	it("chunkMessages splits when exceeding CHUNK_CHARS", async () => {
		const { chunkMessages } = await import("./summarizer");
		const bigContent = "x".repeat(150_000);
		const messages = [
			{ role: "user", content: bigContent },
			{ role: "user", content: bigContent },
			{ role: "assistant", content: "small" },
		];
		const chunks = chunkMessages(messages);
		expect(chunks.length).toBeGreaterThanOrEqual(2);
	});

	it("chunkMessages keeps message order across chunks", async () => {
		const { chunkMessages } = await import("./summarizer");
		const bigContent = "x".repeat(150_000);
		const messages = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: bigContent },
			{ role: "user", content: "last" },
		];
		const chunks = chunkMessages(messages);
		const allMessages = chunks.flat();
		expect(allMessages).toEqual(messages);
	});

	it("formatMessagesForPrompt joins messages with role prefix", async () => {
		const { formatMessagesForPrompt } = await import("./summarizer");
		const messages = [
			{ role: "user", content: "Q" },
			{ role: "assistant", content: "A" },
		];
		expect(formatMessagesForPrompt(messages)).toBe("user: Q\n\nassistant: A");
	});
});

describe("summarizer — summarizeConversation", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-summarizer-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		vi.clearAllMocks();

		mockGenerateText.mockResolvedValue({
			text: "This is a concise summary of the conversation.",
			reasoningText: undefined,
			response: { body: {} },
			output: undefined,
		});
	});

	afterEach(() => {
		try {
			unlinkSync(dbPath);
		} catch {
			/* best-effort cleanup */
		}
	});

	it("returns a summary for a small conversation", async () => {
		const { summarizeConversation } = await import("./summarizer");

		const messages = [
			{ role: "user", content: "What is TypeScript?" },
			{
				role: "assistant",
				content: "TypeScript is a typed superset of JavaScript.",
			},
		];

		const summary = await summarizeConversation(messages, "TS Chat");
		expect(summary).toBe("This is a concise summary of the conversation.");
		expect(mockGenerateText).toHaveBeenCalledTimes(1);
	});

	it("throws for empty messages", async () => {
		const { summarizeConversation } = await import("./summarizer");
		await expect(summarizeConversation([], "Empty")).rejects.toThrow(
			"Cannot summarize empty conversation",
		);
	});

	it("uses chunking for long conversations", async () => {
		const { summarizeConversation } = await import("./summarizer");

		const bigMsg = "x".repeat(10_000);
		const messages: { role: string; content: string }[] = [];
		for (let i = 0; i < 90; i++) {
			messages.push({
				role: i % 2 === 0 ? "user" : "assistant",
				content: bigMsg,
			});
		}

		await summarizeConversation(messages, "Long Chat");

		expect(mockGenerateText.mock.calls.length).toBeGreaterThan(1);
	});

	it("propagates generateText errors", async () => {
		mockGenerateText.mockRejectedValueOnce(new Error("Model unavailable"));

		const { summarizeConversation } = await import("./summarizer");

		const messages = [{ role: "user", content: "Hello" }];

		await expect(summarizeConversation(messages, "Error Chat")).rejects.toThrow(
			"Model unavailable",
		);
	});
});
