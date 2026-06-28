import { describe, expect, it, vi } from "vitest";
import { createFixtureEventStreamResponseFromDataFrames as eventStreamResponse } from "../../../../../tests/fixtures/ai/openai-compatible-stream-fixtures";
import { replayMiMoReasoningContentInRequestBody } from "./mimo-reasoning-replay";
import { composeOpenAICompatibleProviderAdapterFetch } from "./openai-compatible-provider";

describe("MiMo reasoning content replay", () => {
	it("injects captured reasoning_content into assistant tool-call messages", () => {
		const body = {
			messages: [
				{ role: "user", content: "Look up the weather." },
				{
					role: "assistant",
					content: "",
					tool_calls: [
						{
							id: "call_weather",
							type: "function",
							function: { name: "get_weather", arguments: "{}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "call_weather", content: "Sunny" },
			],
		};

		const replayed = replayMiMoReasoningContentInRequestBody(body, {
			reasoningByToolCallId: new Map([
				[
					"call_weather",
					"The user needs weather, so I should call the weather tool.",
				],
			]),
		});

		expect(replayed).not.toBe(body);
		expect(replayed).toMatchObject({
			messages: expect.arrayContaining([
				expect.objectContaining({
					role: "assistant",
					reasoning_content:
						"The user needs weather, so I should call the weather tool.",
				}),
			]),
		});
	});

	it("does not inject when no captured reasoning matches the tool call", () => {
		const body = {
			messages: [
				{
					role: "assistant",
					tool_calls: [{ id: "call_weather" }],
				},
			],
		};

		expect(
			replayMiMoReasoningContentInRequestBody(body, {
				reasoningByToolCallId: new Map([["other_call", "Reasoning"]]),
			}),
		).toBe(body);
	});

	it("does not overwrite existing reasoning_content", () => {
		const body = {
			messages: [
				{
					role: "assistant",
					reasoning_content: "Existing reasoning",
					tool_calls: [{ id: "call_weather" }],
				},
			],
		};

		expect(
			replayMiMoReasoningContentInRequestBody(body, {
				reasoningByToolCallId: new Map([["call_weather", "New reasoning"]]),
			}),
		).toBe(body);
	});

	it("replays reasoning through the adapter-composed fetch only for MiMo profiles", async () => {
		const mimoRequests: unknown[] = [];
		const mimoFetch = composeOpenAICompatibleProviderAdapterFetch({
			provider: {
				name: "mimo",
				displayName: "Xiaomi MiMo",
				baseUrl: "https://api.xiaomimimo.example/v1",
				modelName: "mimo-v4-thinking",
			},
			fetch: vi.fn(async (_input, init) => {
				mimoRequests.push(parseJsonRequest(init?.body));
				return eventStreamResponse([
					{
						id: "mimo-chunk-1",
						object: "chat.completion.chunk",
						created: 1,
						model: "mimo-v4-thinking",
						choices: [
							{
								index: 0,
								delta: {
									reasoning_content: "MiMo should remember this. ",
									tool_calls: [
										{
											index: 0,
											id: 42,
											type: "function",
											function: { arguments: '{"title":' },
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					{
						id: "mimo-chunk-2",
						object: "chat.completion.chunk",
						created: 1,
						model: "mimo-v4-thinking",
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											type: "function",
											function: {
												name: "produce_file",
												arguments: '"Adapter report"}',
											},
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					"[DONE]",
				]);
			}),
		});

		await (
			await mimoFetch("https://provider.example/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({
					messages: [{ role: "user", content: "Create a report." }],
				}),
			})
		).text();
		await mimoFetch("https://provider.example/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				messages: [
					{
						role: "assistant",
						content: "",
						tool_calls: [
							{
								id: "call_compat_0",
								type: "function",
								function: {
									name: "produce_file",
									arguments: '{"title":"Adapter report"}',
								},
							},
						],
					},
					{
						role: "tool",
						tool_call_id: "call_compat_0",
						content: "Queued",
					},
				],
			}),
		});

		expect(findAssistantToolMessage(mimoRequests[1])).toMatchObject({
			reasoning_content: "MiMo should remember this.",
		});

		const nonMiMoRequests: unknown[] = [];
		const nonMiMoFetch = composeOpenAICompatibleProviderAdapterFetch({
			provider: {
				name: "deepseek",
				displayName: "DeepSeek",
				baseUrl: "https://api.deepseek.com/v1",
				modelName: "deepseek-v4-pro",
			},
			fetch: vi.fn(async (_input, init) => {
				nonMiMoRequests.push(parseJsonRequest(init?.body));
				return eventStreamResponse([
					{
						id: "non-mimo-chunk-1",
						object: "chat.completion.chunk",
						created: 1,
						model: "deepseek-v4-pro",
						choices: [
							{
								index: 0,
								delta: {
									reasoning_content: "DeepSeek reasoning stays stream-only. ",
									tool_calls: [
										{
											index: 0,
											id: "call_non_mimo",
											type: "function",
											function: {
												name: "produce_file",
												arguments: '{"title":"DeepSeek report"}',
											},
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					"[DONE]",
				]);
			}),
		});

		await (
			await nonMiMoFetch("https://provider.example/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({
					messages: [{ role: "user", content: "Create a report." }],
				}),
			})
		).text();
		await nonMiMoFetch("https://provider.example/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				messages: [
					{
						role: "assistant",
						content: "",
						tool_calls: [
							{
								id: "call_non_mimo",
								type: "function",
								function: {
									name: "produce_file",
									arguments: '{"title":"DeepSeek report"}',
								},
							},
						],
					},
					{
						role: "tool",
						tool_call_id: "call_non_mimo",
						content: "Queued",
					},
				],
			}),
		});

		expect(findAssistantToolMessage(nonMiMoRequests[1])).not.toHaveProperty(
			"reasoning_content",
		);
	});
});

function parseJsonRequest(body: BodyInit | null | undefined): unknown {
	if (typeof body !== "string") return null;
	return JSON.parse(body);
}

function findAssistantToolMessage(body: unknown): unknown {
	const messages = isRecord(body) ? body.messages : undefined;
	if (!Array.isArray(messages)) return null;
	return messages.find(
		(message) =>
			isRecord(message) &&
			message.role === "assistant" &&
			Array.isArray(message.tool_calls),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
