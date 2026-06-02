import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../env", () => ({
	getDatabasePath: () => "./data/test.db",
	config: {
		titleGenUrl: "http://localhost:30001/v1",
		titleGenApiKey: "",
		titleGenModel: "nemotron-nano",
		titleGenSystemPromptEn: "",
		titleGenSystemPromptHu: "",
		titleGenSystemPromptCodeAppendixEn: "",
		titleGenSystemPromptCodeAppendixHu: "",
		requestTimeoutMs: 5000,
		maxMessageLength: 10000,
		sessionSecret: "test-secret",
		databasePath: "./data/test.db",
	},
}));

import { generateTitle } from "./title-generator";

describe("generateTitle", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("generates title from user message + assistant response", async () => {
		const mockFetch = vi.mocked(fetch);
		const mockResponse = new Response(
			JSON.stringify({
				choices: [
					{
						message: {
							content: '  "A Great Conversation Title"  ',
						},
					},
				],
			}),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
		mockFetch.mockResolvedValue(mockResponse);

		const title = await generateTitle(
			"Hello",
			"Hi there! How can I help you today?",
		);
		expect(title).toBe("A Great Conversation Title");
		const callArgs = mockFetch.mock.calls[0]?.[1];
		const body = JSON.parse(
			typeof callArgs?.body === "string" ? callArgs.body : "{}",
		);
		expect(
			body.messages.some(
				(message: { role: string }) => message.role === "system",
			),
		).toBe(false);
		expect(body.max_tokens).toBe(120);
		expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(body.extra_body).toEqual({
			chat_template_kwargs: { enable_thinking: false },
		});
		expect(mockFetch).toHaveBeenCalledWith(
			expect.stringContaining("/chat/completions"),
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: expect.stringContaining("User: Hello"),
			}),
		);
	});

	it("sends bearer auth when a title gen api key is configured", async () => {
		vi.doMock("../env", () => ({
			getDatabasePath: () => "./data/test.db",
			config: {
				titleGenUrl: "http://localhost:30001/v1",
				titleGenApiKey: "secret-key",
				titleGenModel: "nemotron-nano",
				titleGenSystemPromptEn: "Write titles only.",
				titleGenSystemPromptHu: "",
				titleGenSystemPromptCodeAppendixEn: "",
				titleGenSystemPromptCodeAppendixHu: "",
				requestTimeoutMs: 5000,
				maxMessageLength: 10000,
				sessionSecret: "test-secret",
				databasePath: "./data/test.db",
			},
		}));

		vi.resetModules();
		const { generateTitle: generateTitleWithAuth } = await import(
			"./title-generator"
		);
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [{ message: { content: "Secure Title" } }],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		await generateTitleWithAuth("User", "Assistant");

		expect(mockFetch).toHaveBeenCalledWith(
			expect.stringContaining("/chat/completions"),
			expect.objectContaining({
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer secret-key",
				},
			}),
		);
	});

	it("truncates assistant response to 200 chars", async () => {
		const longResponse = "x".repeat(300);
		const mockFetch = vi.mocked(fetch);
		const mockResponse = new Response(
			JSON.stringify({
				choices: [
					{
						message: {
							content: "Title",
						},
					},
				],
			}),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
		mockFetch.mockResolvedValue(mockResponse);

		await generateTitle("User message", longResponse);
		const callArgs = mockFetch.mock.calls[0][1];
		const body = JSON.parse(
			typeof callArgs.body === "string" ? callArgs.body : "",
		);
		const lastMessage = body.messages[body.messages.length - 1];
		expect(lastMessage.content).toContain(`Assistant: ${"x".repeat(200)}`);
		expect(lastMessage.content).not.toContain("x".repeat(201));
	});

	it("removes surrounding quotes from generated title", async () => {
		const mockFetch = vi.mocked(fetch);
		const mockResponse = new Response(
			JSON.stringify({
				choices: [
					{
						message: {
							content: '"Quoted Title"',
						},
					},
				],
			}),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
		mockFetch.mockResolvedValue(mockResponse);

		const title = await generateTitle("User", "Assistant");
		expect(title).toBe("Quoted Title");
	});

	it("falls back to user message when content is null (ignores reasoning)", async () => {
		const mockFetch = vi.mocked(fetch);
		const mockResponse = new Response(
			JSON.stringify({
				choices: [
					{
						message: {
							content: null,
							reasoning:
								"Reasoning content that should never be used as a title",
						},
					},
				],
			}),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
		mockFetch.mockResolvedValue(mockResponse);

		await expect(
			generateTitle("User asks about deployment", "Assistant"),
		).resolves.toBe("User asks about deployment");
	});

	it("falls back to user message when content is leaked thinking process", async () => {
		const thinkingTitles = [
			'Here\'s a thinking process: 1. **Analyze User Input:** - User says: "Hello!"',
			"Here's a thinking process: 1. **Identify the topic** 2. **Summarize**",
			"Let me think about this: the user is asking about Python",
			"Let me work through this step by step",
			"Okay, let me think about how to summarize this conversation",
			"Let me break this down into parts and analyze",
			'The user is asking "How do I test Firepass?" and the assistant response is very brief. I need to determine a concise title for this internal workflow.',
		];

		for (const thinkingTitle of thinkingTitles) {
			const mockFetch = vi.mocked(fetch);
			const mockResponse = new Response(
				JSON.stringify({
					choices: [{ message: { content: thinkingTitle } }],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
			mockFetch.mockResolvedValue(mockResponse);

			await expect(
				generateTitle("User message here", "Assistant"),
			).resolves.toBe("User message here");
		}
	});

	it("handles title generation service being unreachable (throws)", async () => {
		const mockFetch = vi.mocked(fetch);
		const mockResponse = new Response(
			JSON.stringify({ error: "Internal Server Error" }),
			{
				status: 500,
				statusText: "Internal Server Error",
			},
		);
		mockFetch.mockResolvedValue(mockResponse);

		await expect(generateTitle("User", "Assistant")).rejects.toThrow(
			"Title generation failed: 500",
		);
	});

	it("retries with a strict OpenAI-compatible body when extended title fields are rejected", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: "unsupported field" }), {
					status: 400,
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						choices: [{ message: { content: "Firepass Smoke Testing" } }],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);

		await expect(
			generateTitle("How do I test Firepass?", "Use local smoke tests."),
		).resolves.toBe("Firepass Smoke Testing");

		expect(mockFetch).toHaveBeenCalledTimes(2);
		const firstBody = JSON.parse(
			typeof mockFetch.mock.calls[0]?.[1]?.body === "string"
				? mockFetch.mock.calls[0][1].body
				: "{}",
		);
		const secondBody = JSON.parse(
			typeof mockFetch.mock.calls[1]?.[1]?.body === "string"
				? mockFetch.mock.calls[1][1].body
				: "{}",
		);
		expect(firstBody.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(firstBody.extra_body).toEqual({
			chat_template_kwargs: { enable_thinking: false },
		});
		expect(secondBody).not.toHaveProperty("chat_template_kwargs");
		expect(secondBody).not.toHaveProperty("extra_body");
		expect(secondBody.model).toBe("nemotron-nano");
		expect(secondBody.max_tokens).toBe(120);
	});

	it("falls back to the user message when the model returns no title", async () => {
		const mockFetch = vi.mocked(fetch);
		const mockResponse = new Response(
			JSON.stringify({
				choices: [
					{
						message: {
							content: "",
						},
					},
				],
			}),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
		mockFetch.mockResolvedValue(mockResponse);

		await expect(
			generateTitle("User asks for server deployment help", "Assistant"),
		).resolves.toBe("User asks for server deployment help");
	});

	it("uses the latest user-message language even if the assistant text is Hungarian", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [{ message: { content: "English Debug Summary" } }],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		await generateTitle(
			"Please summarize what this file is about in English.",
			"A feltöltött fájl magyar nyelvű.",
		);

		const callArgs = mockFetch.mock.calls[0]?.[1];
		const body = JSON.parse(
			typeof callArgs?.body === "string" ? callArgs.body : "{}",
		);
		expect(
			body.messages.some(
				(message: { role: string }) => message.role === "system",
			),
		).toBe(false);
	});

	it("falls back to the user message when the model returns a title in the wrong language", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [{ message: { content: "Magyar cím" } }],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		await expect(
			generateTitle(
				"Please explain the attached deployment notes in English",
				"Rendben.",
			),
		).resolves.toBe("Please explain the attached deployment notes in English");
	});

	it("uses the configured language-specific title generation system prompt when present", async () => {
		vi.doMock("../env", () => ({
			getDatabasePath: () => "./data/test.db",
			config: {
				titleGenUrl: "http://localhost:30001/v1",
				titleGenApiKey: "",
				titleGenModel: "nemotron-nano",
				titleGenSystemPromptEn: "Return terse, descriptive titles only.",
				titleGenSystemPromptHu: "Adj vissza rovid cimket.",
				titleGenSystemPromptCodeAppendixEn:
					"Mention the language or framework when known.",
				titleGenSystemPromptCodeAppendixHu: "Emlitsd a technológiát ha ismert.",
				requestTimeoutMs: 5000,
				maxMessageLength: 10000,
				sessionSecret: "test-secret",
				databasePath: "./data/test.db",
			},
		}));

		vi.resetModules();
		const { generateTitle: generateTitleWithConfiguredPrompt } = await import(
			"./title-generator"
		);
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [{ message: { content: "Configured Prompt Title" } }],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		await generateTitleWithConfiguredPrompt(
			"How do I fix this JavaScript error?",
			"Assistant",
		);

		const callArgs = mockFetch.mock.calls[0]?.[1];
		const body = JSON.parse(
			typeof callArgs?.body === "string" ? callArgs.body : "{}",
		);
		expect(body.messages[0]).toEqual({
			role: "system",
			content:
				"Return terse, descriptive titles only.\nMention the language or framework when known.",
		});
	});
});
