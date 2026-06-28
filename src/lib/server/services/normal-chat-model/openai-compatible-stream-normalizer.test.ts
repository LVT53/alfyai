import { describe, expect, it, vi } from "vitest";
import {
	collectFixtureFinishReasons,
	collectFixtureReasoningDeltas,
	collectFixtureTextDeltas,
	collectFixtureToolCalls,
	collectFixtureUsage,
	collectFixtureUsageFrames,
	createFixtureEventStreamResponse,
	createFixtureEventStreamResponseFromDataFrames as eventStreamResponse,
	normalizerProviderStreamFixtureCatalog,
	parseFixtureEventStreamData,
	parseFixtureEventStreamJson,
	parseFixtureEventStreamData as parseServerSentEventData,
	providerStreamFixtures,
} from "../../../../../tests/fixtures/ai/openai-compatible-stream-fixtures";
import { createOpenAICompatibleStreamNormalizingFetch } from "./openai-compatible-stream-normalizer";

describe("OpenAI-compatible stream normalizer", () => {
	it("fixture harness preserves SSE framing across deterministic chunk boundaries", async () => {
		const response = createFixtureEventStreamResponse(
			providerStreamFixtures.deepseekV4ReasoningText,
			{
				chunkBoundaries: [1, 9, 27],
			},
		);

		expect(response.headers.get("content-type")).toContain("text/event-stream");
		await expect(response.text()).resolves.toBe(
			providerStreamFixtures.deepseekV4ReasoningText.expected.rawEventStream,
		);
		expect(
			parseFixtureEventStreamData(
				providerStreamFixtures.deepseekV4ReasoningText.expected.rawEventStream,
			),
		).toEqual(
			providerStreamFixtures.deepseekV4ReasoningText.expected.rawDataFrames,
		);
	});

	it.each(
		normalizerProviderStreamFixtureCatalog,
	)("normalizes provider fixture $id", async (fixture) => {
		const fetch = createOpenAICompatibleStreamNormalizingFetch(
			vi.fn(async () =>
				createFixtureEventStreamResponse(fixture, {
					chunkBoundaries: [2, 11, 37, 101],
				}),
			),
		);

		const response = await fetch(
			"https://provider.example/v1/chat/completions",
		);
		const rawEventStream = await response.text();
		const dataFrames = parseFixtureEventStreamData(rawEventStream);
		const frames = parseFixtureEventStreamJson(rawEventStream);

		expect(dataFrames.at(-1)).toBe("[DONE]");
		expect(collectFixtureTextDeltas(frames)).toEqual(
			fixture.expected.textDeltas,
		);
		expect(collectFixtureReasoningDeltas(frames)).toEqual(
			fixture.expected.reasoningDeltas,
		);
		expect(collectFixtureToolCalls(frames)).toEqual(
			fixture.expected.toolCalls.map(({ id, name, argumentsText }) => ({
				id,
				name,
				argumentsText,
			})),
		);
		expect(collectFixtureUsage(frames)).toEqual(fixture.expected.usage);
		if (fixture.expected.finishReason) {
			expect(collectFixtureFinishReasons(frames)).toContain(
				fixture.expected.finishReason,
			);
		}
	});

	it("fixtures model provider-specific usage frame topology", () => {
		for (const fixture of normalizerProviderStreamFixtureCatalog) {
			expect(
				collectFixtureUsageFrames(
					parseFixtureEventStreamJson(fixture.expected.rawEventStream),
				),
			).toEqual(fixture.expected.usageFrames);
		}

		expect(
			providerStreamFixtures.deepseekV4ReasoningText.expected.usageFrames,
		).toEqual([
			expect.objectContaining({ location: "top-level-empty-choices" }),
		]);
		expect(
			providerStreamFixtures.kimiK2SplitArguments.expected.usageFrames,
		).toEqual([expect.objectContaining({ location: "choice-finish" })]);
		expect(
			providerStreamFixtures.qwen3ReasoningUsage.expected.usageFrames[0]?.usage,
		).toMatchObject({
			prompt_tokens_details: { cached_tokens: 2 },
		});
		expect(
			providerStreamFixtures.qwen3ReasoningUsage.expected.usageFrames[0]?.usage,
		).not.toHaveProperty("prompt_cache_hit_tokens");
	});

	it("leaves non-streaming responses untouched", async () => {
		const fetch = createOpenAICompatibleStreamNormalizingFetch(
			vi.fn(
				async () =>
					new Response('{"choices":[{"message":{"content":"Plain answer"}}]}', {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			),
		);

		const response = await fetch(
			"https://provider.example/v1/chat/completions",
		);

		expect(response.headers.get("content-type")).toContain("application/json");
		await expect(response.text()).resolves.toBe(
			'{"choices":[{"message":{"content":"Plain answer"}}]}',
		);
	});

	it("delays incomplete tool-call deltas until the provider streams the function name", async () => {
		const fetch = createOpenAICompatibleStreamNormalizingFetch(
			vi.fn(async () =>
				eventStreamResponse([
					{
						id: "chunk-1",
						choices: [
							{
								index: 0,
								delta: {
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
						id: "chunk-1",
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
												arguments: '"Quarterly report"}',
											},
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					"[DONE]",
				]),
			),
		);

		const response = await fetch(
			"https://provider.example/v1/chat/completions",
		);
		const frames = parseServerSentEventData(await response.text());

		expect(frames).toHaveLength(2);
		expect(JSON.parse(frames[0] ?? "")).toMatchObject({
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index: 0,
								id: "call_compat_0",
								type: "function",
								function: {
									name: "produce_file",
									arguments: '{"title":"Quarterly report"}',
								},
							},
						],
					},
					finish_reason: null,
				},
			],
		});
		expect(frames[1]).toBe("[DONE]");
	});

	it("completes parameterless tool calls that stream an empty arguments string", async () => {
		const fetch = createOpenAICompatibleStreamNormalizingFetch(
			vi.fn(async () =>
				eventStreamResponse([
					{
						id: "chunk-1",
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call-provider-1",
											type: "function",
											function: {
												name: "memory_context",
												arguments: "",
											},
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					{
						id: "chunk-1",
						choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
					},
					"[DONE]",
				]),
			),
		);

		const response = await fetch(
			"https://provider.example/v1/chat/completions",
		);
		const frames = parseServerSentEventData(await response.text());
		const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame));

		expect(chunks).toHaveLength(3);
		expect(chunks[0]).toMatchObject({
			choices: [
				{
					delta: {
						tool_calls: [
							{
								id: "call-provider-1",
								function: { name: "memory_context", arguments: "" },
							},
						],
					},
				},
			],
		});
		expect(chunks[1]).toMatchObject({
			choices: [
				{
					delta: {
						tool_calls: [
							{
								id: "call-provider-1",
								function: { arguments: "{}" },
							},
						],
					},
				},
			],
		});
		expect(chunks[2]).toMatchObject({
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		});
		expect(frames.at(-1)).toBe("[DONE]");
	});

	it("does not treat an empty first argument delta as parameterless when later JSON arguments arrive", async () => {
		const fetch = createOpenAICompatibleStreamNormalizingFetch(
			vi.fn(async () =>
				eventStreamResponse([
					{
						id: "chunk-1",
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call-provider-1",
											type: "function",
											function: {
												name: "memory_context",
												arguments: "",
											},
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					{
						id: "chunk-1",
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call-provider-1",
											type: "function",
											function: {
												arguments: '{"query":"forecast"}',
											},
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					{
						id: "chunk-1",
						choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
					},
					"[DONE]",
				]),
			),
		);

		const response = await fetch(
			"https://provider.example/v1/chat/completions",
		);
		const frames = parseServerSentEventData(await response.text());
		const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame));

		expect(chunks).toHaveLength(3);
		expect(chunks[0].choices[0].delta.tool_calls[0].function.arguments).toBe(
			"",
		);
		expect(chunks[1].choices[0].delta.tool_calls[0].function.arguments).toBe(
			'{"query":"forecast"}',
		);
		expect(
			chunks.some(
				(chunk) =>
					chunk.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments ===
					"{}",
			),
		).toBe(false);
		expect(frames.at(-1)).toBe("[DONE]");
	});

	it("preserves ordinary stream chunks and valid tool-call fields", async () => {
		const fetch = createOpenAICompatibleStreamNormalizingFetch(
			vi.fn(async () =>
				eventStreamResponse([
					{
						id: "chunk-1",
						choices: [
							{
								index: 0,
								delta: { reasoning_content: "Thinking" },
								finish_reason: null,
							},
						],
					},
					{
						id: "chunk-1",
						choices: [
							{
								index: 0,
								delta: { content: "Answer" },
								finish_reason: null,
							},
						],
					},
					{
						id: "chunk-1",
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call-provider-1",
											type: "function",
											function: {
												name: "produce_file",
												arguments: '{"title":"Report"}',
											},
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					"[DONE]",
				]),
			),
		);

		const response = await fetch(
			"https://provider.example/v1/chat/completions",
		);
		const frames = parseServerSentEventData(await response.text());

		expect(JSON.parse(frames[0] ?? "")).toMatchObject({
			choices: [
				{
					delta: { reasoning_content: "Thinking" },
					finish_reason: null,
				},
			],
		});
		expect(JSON.parse(frames[1] ?? "")).toMatchObject({
			choices: [
				{
					delta: { content: "Answer" },
					finish_reason: null,
				},
			],
		});
		expect(JSON.parse(frames[2] ?? "")).toMatchObject({
			choices: [
				{
					delta: {
						tool_calls: [
							{
								index: 0,
								id: "call-provider-1",
								type: "function",
								function: {
									name: "produce_file",
									arguments: '{"title":"Report"}',
								},
							},
						],
					},
				},
			],
		});
		expect(frames.at(-1)).toBe("[DONE]");
	});
});
