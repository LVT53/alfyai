import { tool } from "ai";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runStreamingNormalChatModelRun } from "$lib/server/services/normal-chat-model";
import {
	AI_SMOKE_ABORT_DELAY_MS,
	AI_SMOKE_API_KEY,
	AI_SMOKE_MODEL_ID,
	AI_SMOKE_PLAIN_TEXT,
	AI_SMOKE_REASONING_TEXT,
	AI_SMOKE_SCENARIOS,
	AI_SMOKE_SLOW_CHUNK_DELAY_MS,
	AI_SMOKE_STREAM_REASONING_TEXT,
	AI_SMOKE_STREAM_TEXT,
	AI_SMOKE_TOOL_FINAL_TEXT,
	AI_SMOKE_TOOL_NAME,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";

const provider = createOpenAICompatibleProviderHarness();

describe("fake OpenAI-compatible provider lifecycle", () => {
	it("rejects promptly when the provider cannot bind a local port", async () => {
		const blockedProvider = createOpenAICompatibleProviderHarness({
			host: "203.0.113.1",
		});

		await expect(blockedProvider.start()).rejects.toThrow(
			"Fake OpenAI-compatible provider failed to listen",
		);
	});
});

describe("fake OpenAI-compatible provider harness", () => {
	afterAll(async () => {
		await provider.stop();
	});

	beforeEach(async () => {
		await provider.start();
		await provider.reset();
	});

	it("serves models, plain chat completions, request capture, and reset over public endpoints", async () => {
		const models = await fetch(`${provider.baseURL}/models`, {
			headers: { Authorization: `Bearer ${AI_SMOKE_API_KEY}` },
		});

		expect(models.status).toBe(200);
		await expect(models.json()).resolves.toMatchObject({
			object: "list",
			data: [{ id: AI_SMOKE_MODEL_ID, object: "model" }],
		});

		const completion = await fetch(`${provider.baseURL}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AI_SMOKE_API_KEY}`,
				"Content-Type": "application/json",
				"x-ai-smoke-scenario": AI_SMOKE_SCENARIOS.text,
			},
			body: JSON.stringify({
				model: AI_SMOKE_MODEL_ID,
				messages: [{ role: "user", content: "Say hello deterministically." }],
			}),
		});

		expect(completion.status).toBe(200);
		await expect(completion.json()).resolves.toMatchObject({
			object: "chat.completion",
			model: AI_SMOKE_MODEL_ID,
			choices: [
				{
					message: {
						role: "assistant",
						content: "Plain fake provider response.",
					},
					finish_reason: "stop",
				},
			],
		});

		const captured = await fetch(`${provider.origin}/__ai-smoke/requests`);
		await expect(captured.json()).resolves.toMatchObject({
			requests: [
				{
					method: "GET",
					path: "/v1/models",
					authorization: "Bearer [redacted]",
				},
				{
					method: "POST",
					path: "/v1/chat/completions",
					authorization: "Bearer [redacted]",
					scenario: "text",
					body: {
						model: AI_SMOKE_MODEL_ID,
						messages: [
							{ role: "user", content: "Say hello deterministically." },
						],
					},
				},
			],
		});

		const reset = await fetch(`${provider.origin}/__ai-smoke/reset`, {
			method: "POST",
		});
		expect(reset.status).toBe(204);

		const afterReset = await fetch(`${provider.origin}/__ai-smoke/requests`);
		await expect(afterReset.json()).resolves.toEqual({ requests: [] });
	});

	it("serves an OpenAI-compatible rate limit response for the rate-limit scenario", async () => {
		const completion = await fetch(`${provider.baseURL}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AI_SMOKE_API_KEY}`,
				"Content-Type": "application/json",
				"x-ai-smoke-scenario": AI_SMOKE_SCENARIOS.rateLimit,
			},
			body: JSON.stringify({
				model: AI_SMOKE_MODEL_ID,
				messages: [
					{ role: "user", content: "Trigger a deterministic rate limit." },
				],
			}),
		});

		expect(completion.status).toBe(429);
		await expect(completion.json()).resolves.toEqual({
			error: {
				message: "Fake provider rate limit exceeded.",
				type: "rate_limit_error",
				code: "rate_limit_exceeded",
			},
		});
	});

	it("serves an OpenAI-compatible server error response for the server-error scenario", async () => {
		const completion = await fetch(`${provider.baseURL}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AI_SMOKE_API_KEY}`,
				"Content-Type": "application/json",
				"x-ai-smoke-scenario": AI_SMOKE_SCENARIOS.serverError,
			},
			body: JSON.stringify({
				model: AI_SMOKE_MODEL_ID,
				messages: [
					{ role: "user", content: "Trigger a deterministic server error." },
				],
			}),
		});

		expect(completion.status).toBe(500);
		await expect(completion.json()).resolves.toEqual({
			error: {
				message: "Fake provider internal server error.",
				type: "server_error",
				code: "internal_server_error",
			},
		});
	});

	it("serves OpenAI-compatible chat completion chunks for streaming requests", async () => {
		const completion = await fetch(`${provider.baseURL}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AI_SMOKE_API_KEY}`,
				"Content-Type": "application/json",
				"x-ai-smoke-scenario": AI_SMOKE_SCENARIOS.streaming,
			},
			body: JSON.stringify({
				model: AI_SMOKE_MODEL_ID,
				stream: true,
				messages: [{ role: "user", content: "Stream deterministically." }],
			}),
		});

		expect(completion.status).toBe(200);
		expect(completion.headers.get("content-type")).toContain(
			"text/event-stream",
		);

		const frames = parseServerSentEventData(await completion.text());
		expect(frames.at(-1)).toBe("[DONE]");

		const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame));
		expect(chunks).toMatchObject([
			{
				id: "chatcmpl_fake_stream",
				object: "chat.completion.chunk",
				model: AI_SMOKE_MODEL_ID,
				choices: [
					{ index: 0, delta: { role: "assistant" }, finish_reason: null },
				],
			},
			{
				id: "chatcmpl_fake_stream",
				object: "chat.completion.chunk",
				model: AI_SMOKE_MODEL_ID,
				choices: [
					{
						index: 0,
						delta: { content: AI_SMOKE_STREAM_TEXT },
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl_fake_stream",
				object: "chat.completion.chunk",
				model: AI_SMOKE_MODEL_ID,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
		]);

		expect(provider.requests()).toMatchObject([
			{
				method: "POST",
				path: "/v1/chat/completions",
				authorization: "Bearer [redacted]",
				scenario: "streaming",
				body: {
					model: AI_SMOKE_MODEL_ID,
					stream: true,
					messages: [{ role: "user", content: "Stream deterministically." }],
				},
			},
		]);
	});

	it("serves deterministic reasoning chunks and captures AI SDK streaming options", async () => {
		const completion = await fetch(`${provider.baseURL}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AI_SMOKE_API_KEY}`,
				"Content-Type": "application/json",
				"x-ai-smoke-scenario": AI_SMOKE_SCENARIOS.reasoning,
			},
			body: JSON.stringify({
				model: AI_SMOKE_MODEL_ID,
				stream: true,
				stream_options: { include_usage: true },
				messages: [{ role: "user", content: "Reason deterministically." }],
			}),
		});

		expect(completion.status).toBe(200);
		const frames = parseServerSentEventData(await completion.text());
		expect(frames.at(-1)).toBe("[DONE]");

		const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame));
		expect(chunks).toMatchObject([
			{
				choices: [
					{
						delta: { reasoning_content: AI_SMOKE_STREAM_REASONING_TEXT },
						finish_reason: null,
					},
				],
			},
			{
				choices: [
					{
						delta: { content: AI_SMOKE_STREAM_TEXT },
						finish_reason: null,
					},
				],
			},
			{
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 12,
					completion_tokens: 5,
					total_tokens: 17,
				},
			},
		]);

		const plain = await fetch(`${provider.baseURL}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AI_SMOKE_API_KEY}`,
				"Content-Type": "application/json",
				"x-ai-smoke-scenario": AI_SMOKE_SCENARIOS.reasoning,
			},
			body: JSON.stringify({
				model: AI_SMOKE_MODEL_ID,
				messages: [{ role: "user", content: "Reason plainly." }],
			}),
		});

		expect(plain.status).toBe(200);
		await expect(plain.json()).resolves.toMatchObject({
			choices: [
				{
					message: {
						role: "assistant",
						content: AI_SMOKE_PLAIN_TEXT,
						reasoning_content: AI_SMOKE_REASONING_TEXT,
					},
				},
			],
		});

		expect(provider.requests()).toMatchObject([
			{
				body: {
					stream: true,
					stream_options: { include_usage: true },
				},
			},
			{
				body: {
					messages: [{ role: "user", content: "Reason plainly." }],
				},
			},
		]);
	});

	it("drives an AI SDK streaming tool roundtrip and captures the tool result request", async () => {
		const toolExecute = vi.fn(async ({ title }: { title: string }) => ({
			jobId: "fake-job-1",
			title,
		}));

		const events = [];
		for await (const event of runStreamingNormalChatModelRun({
			provider: {
				id: "provider-1",
				name: "fake-openai-compatible",
				displayName: "Fake OpenAI Compatible",
				baseUrl: provider.baseURL,
				modelName: AI_SMOKE_MODEL_ID,
				apiKey: AI_SMOKE_API_KEY,
			},
			headers: { "x-ai-smoke-scenario": AI_SMOKE_SCENARIOS.toolRoundtrip },
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Create a deterministic report." }],
				},
			],
			tools: {
				[AI_SMOKE_TOOL_NAME]: tool({
					description: "Return a deterministic fake job.",
					inputSchema: z.object({
						title: z.string(),
					}),
					execute: toolExecute,
				}),
			},
		})) {
			events.push(event);
		}

		expect(events).toContainEqual({
			type: "tool_call",
			callId: "call_fake_report_1",
			toolName: AI_SMOKE_TOOL_NAME,
			input: { title: "Deterministic fake report" },
		});
		expect(events).toContainEqual({
			type: "tool_result",
			callId: "call_fake_report_1",
			toolName: AI_SMOKE_TOOL_NAME,
			output: {
				jobId: "fake-job-1",
				title: "Deterministic fake report",
			},
		});
		expect(events).toContainEqual({
			type: "text_delta",
			text: AI_SMOKE_TOOL_FINAL_TEXT,
		});
		expect(toolExecute).toHaveBeenCalledWith(
			{ title: "Deterministic fake report" },
			expect.objectContaining({ toolCallId: "call_fake_report_1" }),
		);

		expect(provider.requests()).toMatchObject([
			{
				method: "POST",
				path: "/v1/chat/completions",
				body: {
					tools: [
						expect.objectContaining({
							type: "function",
							function: expect.objectContaining({ name: AI_SMOKE_TOOL_NAME }),
						}),
					],
				},
			},
			{
				method: "POST",
				path: "/v1/chat/completions",
				body: {
					messages: expect.arrayContaining([
						expect.objectContaining({
							role: "tool",
							tool_call_id: "call_fake_report_1",
							content: JSON.stringify({
								jobId: "fake-job-1",
								title: "Deterministic fake report",
							}),
						}),
					]),
				},
			},
		]);
	});

	it("normalizes streamed tool calls that omit provider tool call ids", async () => {
		const toolExecute = vi.fn(async ({ title }: { title: string }) => ({
			jobId: "fake-job-1",
			title,
		}));

		const events = [];
		for await (const event of runStreamingNormalChatModelRun({
			provider: {
				id: "provider-1",
				name: "fake-openai-compatible",
				displayName: "Fake OpenAI Compatible",
				baseUrl: provider.baseURL,
				modelName: AI_SMOKE_MODEL_ID,
				apiKey: AI_SMOKE_API_KEY,
			},
			headers: {
				"x-ai-smoke-scenario":
					AI_SMOKE_SCENARIOS.toolRoundtripMissingToolCallId,
			},
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Search with a local model." }],
				},
			],
			tools: {
				[AI_SMOKE_TOOL_NAME]: tool({
					description: "Return a deterministic fake job.",
					inputSchema: z.object({
						title: z.string(),
					}),
					execute: toolExecute,
				}),
			},
		})) {
			events.push(event);
		}

		expect(events).toContainEqual({
			type: "tool_call",
			callId: "call_compat_0",
			toolName: AI_SMOKE_TOOL_NAME,
			input: { title: "Deterministic fake report" },
		});
		expect(events).toContainEqual({
			type: "tool_result",
			callId: "call_compat_0",
			toolName: AI_SMOKE_TOOL_NAME,
			output: {
				jobId: "fake-job-1",
				title: "Deterministic fake report",
			},
		});
		expect(events).toContainEqual({
			type: "text_delta",
			text: AI_SMOKE_TOOL_FINAL_TEXT,
		});
		expect(events).not.toContainEqual({
			type: "error",
			error: "Expected 'id' to be a string.",
		});
		expect(toolExecute).toHaveBeenCalledWith(
			{ title: "Deterministic fake report" },
			expect.objectContaining({ toolCallId: "call_compat_0" }),
		);

		expect(provider.requests()).toMatchObject([
			{
				method: "POST",
				path: "/v1/chat/completions",
				body: {
					tools: [
						expect.objectContaining({
							type: "function",
							function: expect.objectContaining({ name: AI_SMOKE_TOOL_NAME }),
						}),
					],
				},
			},
			{
				method: "POST",
				path: "/v1/chat/completions",
				body: {
					messages: expect.arrayContaining([
						expect.objectContaining({
							role: "tool",
							tool_call_id: "call_compat_0",
						}),
					]),
				},
			},
		]);
	});

	it("serves slow streaming chunks with deterministic timing", async () => {
		const startedAt = Date.now();
		const completion = await fetch(`${provider.baseURL}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AI_SMOKE_API_KEY}`,
				"Content-Type": "application/json",
				"x-ai-smoke-scenario": AI_SMOKE_SCENARIOS.slowChunks,
			},
			body: JSON.stringify({
				model: AI_SMOKE_MODEL_ID,
				stream: true,
				messages: [{ role: "user", content: "Stream slowly." }],
			}),
		});

		expect(completion.status).toBe(200);
		const frames = parseServerSentEventData(await completion.text());
		const elapsedMs = Date.now() - startedAt;

		expect(elapsedMs).toBeGreaterThanOrEqual(AI_SMOKE_SLOW_CHUNK_DELAY_MS);
		expect(frames.at(-1)).toBe("[DONE]");
		expect(
			frames
				.slice(0, -1)
				.map((frame) => JSON.parse(frame))
				.flatMap((chunk) =>
					chunk.choices.map(
						(choice: { delta?: { content?: string } }) =>
							choice.delta?.content ?? "",
					),
				)
				.join(""),
		).toBe(AI_SMOKE_STREAM_TEXT);
	});

	it("serves deterministic empty plain and streaming output", async () => {
		const plain = await fetch(`${provider.baseURL}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AI_SMOKE_API_KEY}`,
				"Content-Type": "application/json",
				"x-ai-smoke-scenario": AI_SMOKE_SCENARIOS.emptyOutput,
			},
			body: JSON.stringify({
				model: AI_SMOKE_MODEL_ID,
				messages: [{ role: "user", content: "Return empty output." }],
			}),
		});

		expect(plain.status).toBe(200);
		await expect(plain.json()).resolves.toMatchObject({
			choices: [
				{
					message: { role: "assistant", content: "" },
					finish_reason: "stop",
				},
			],
		});

		const stream = await fetch(`${provider.baseURL}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AI_SMOKE_API_KEY}`,
				"Content-Type": "application/json",
				"x-ai-smoke-scenario": AI_SMOKE_SCENARIOS.emptyOutput,
			},
			body: JSON.stringify({
				model: AI_SMOKE_MODEL_ID,
				stream: true,
				messages: [{ role: "user", content: "Stream empty output." }],
			}),
		});

		expect(stream.status).toBe(200);
		const frames = parseServerSentEventData(await stream.text());
		expect(frames.at(-1)).toBe("[DONE]");
		expect(
			frames
				.slice(0, -1)
				.map((frame) => JSON.parse(frame))
				.flatMap((chunk) =>
					chunk.choices.map(
						(choice: { delta?: { content?: string } }) =>
							choice.delta?.content ?? "",
					),
				)
				.join(""),
		).toBe("");
	});

	it("keeps the timeout-abort scenario open until the client aborts and records it", async () => {
		const abortController = new AbortController();
		const completion = await fetch(`${provider.baseURL}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AI_SMOKE_API_KEY}`,
				"Content-Type": "application/json",
				"x-ai-smoke-scenario": AI_SMOKE_SCENARIOS.timeoutAbort,
			},
			body: JSON.stringify({
				model: AI_SMOKE_MODEL_ID,
				stream: true,
				messages: [{ role: "user", content: "Hold the stream open." }],
			}),
			signal: abortController.signal,
		});

		expect(completion.status).toBe(200);
		const readBody = completion.text();
		setTimeout(() => abortController.abort(), AI_SMOKE_ABORT_DELAY_MS);

		await expect(readBody).rejects.toMatchObject({ name: "AbortError" });
		await delay(AI_SMOKE_ABORT_DELAY_MS);

		expect(provider.requests()).toMatchObject([
			{
				method: "POST",
				path: "/v1/chat/completions",
				aborted: true,
			},
		]);
	});
});

function parseServerSentEventData(rawEventStream: string): string[] {
	return rawEventStream
		.split("\n\n")
		.flatMap((event) =>
			event
				.split("\n")
				.filter((line) => line.startsWith("data: "))
				.map((line) => line.slice("data: ".length)),
		)
		.filter(Boolean);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
