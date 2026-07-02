import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getConfig: vi.fn(),
	getSystemPrompt: vi.fn(),
	getProviderByName: vi.fn(),
	listEnabledProviderModels: vi.fn(),
}));

vi.mock("../config-store", () => ({
	getConfig: mocks.getConfig,
}));

vi.mock("../prompts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../prompts")>();
	return {
		...actual,
		getSystemPrompt: mocks.getSystemPrompt,
	};
});

vi.mock("./providers", () => ({
	getProviderByName: mocks.getProviderByName,
}));

vi.mock("./provider-models", () => ({
	listEnabledProviderModels: mocks.listEnabledProviderModels,
}));

import { sendJsonControlMessage } from "./normal-chat-control-model";

const model1 = {
	baseUrl: "https://openai-compatible.example/v1/chat/completions",
	apiKey: "model-1-secret",
	modelName: "gpt-4.1",
	displayName: "Model One",
	maxTokens: 8192,
	reasoningEffort: "high",
};

function mockConfig() {
	mocks.getConfig.mockReturnValue({
		requestTimeoutMs: 300_000,
		model1,
		model2: {
			baseUrl: "",
			apiKey: "",
			modelName: "",
			displayName: "Model Two",
			maxTokens: null,
			reasoningEffort: null,
		},
	});
}

describe("Normal Chat JSON control model sender", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSystemPrompt.mockReturnValue("Control task. Return only JSON.");
		mocks.getProviderByName.mockResolvedValue(null);
		mocks.listEnabledProviderModels.mockResolvedValue([]);
		mockConfig();
	});

	it("sends schema-guided JSON through the selected OpenAI-compatible normal-chat provider", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					JSON.stringify({
						id: "chatcmpl-1",
						model: "provider-returned-model",
						created: 1_717_171_717,
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: JSON.stringify({ ok: true }),
								},
								finish_reason: "stop",
							},
						],
						usage: {
							prompt_tokens: 11,
							completion_tokens: 7,
							total_tokens: 18,
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		);

		const result = await sendJsonControlMessage("Return JSON", "model1", {
			systemPrompt: "context-compression",
			thinkingMode: "on",
			maxTokens: 8192,
			temperature: 0.2,
			fetch,
			jsonSchema: {
				name: "control_result",
				strict: true,
				schema: {
					type: "object",
					properties: { ok: { type: "boolean" } },
					required: ["ok"],
					additionalProperties: false,
				},
			},
		});

		expect(result).toEqual({
			text: JSON.stringify({ ok: true }),
			rawResponse: expect.objectContaining({
				model: "provider-returned-model",
			}),
			modelId: "model1",
			modelDisplayName: "Model One",
		});
		expect(fetch).toHaveBeenCalledWith(
			"https://openai-compatible.example/v1/chat/completions",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					authorization: "Bearer model-1-secret",
					"content-type": "application/json",
				}),
			}),
		);
		const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
		expect(body).toMatchObject({
			model: "gpt-4.1",
			temperature: 0.2,
			max_tokens: 8192,
			reasoning_effort: "high",
			response_format: {
				type: "json_schema",
				json_schema: {
					name: "control_result",
					strict: true,
					schema: {
						type: "object",
						properties: { ok: { type: "boolean" } },
						required: ["ok"],
						additionalProperties: false,
					},
				},
			},
		});
		expect(body.messages).toEqual([
			expect.objectContaining({
				role: "system",
				content: expect.stringContaining("Control task. Return only JSON."),
			}),
			{ role: "user", content: "Return JSON" },
		]);
	});

	it("falls back to plain JSON output when a provider rejects strict JSON schema response format", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: {
							message: "This response_format type is unavailable now",
							type: "invalid_request_error",
							code: "invalid_request_error",
						},
					}),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						id: "chatcmpl-2",
						model: "provider-returned-model",
						created: 1_717_171_718,
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: JSON.stringify({ ok: true }),
								},
								finish_reason: "stop",
							},
						],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);

		const result = await sendJsonControlMessage("Return JSON", "model1", {
			systemPrompt: "context-compression",
			thinkingMode: "off",
			fetch,
			jsonSchema: {
				name: "control_result",
				strict: true,
				schema: {
					type: "object",
					properties: { ok: { type: "boolean" } },
					required: ["ok"],
					additionalProperties: false,
				},
			},
		});

		expect(result.text).toBe(JSON.stringify({ ok: true }));
		expect(fetch).toHaveBeenCalledTimes(2);
		const strictBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
		const fallbackBody = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
		expect(strictBody.response_format).toMatchObject({
			type: "json_schema",
		});
		expect(fallbackBody.response_format).toMatchObject({
			type: "json_object",
		});
		expect(fallbackBody).not.toHaveProperty("strictJsonSchema");
	});

	it("preserves Qwen thinking controls when adding schema-guided JSON options", async () => {
		mocks.getConfig.mockReturnValue({
			requestTimeoutMs: 300_000,
			model1: {
				baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
				apiKey: "qwen-secret",
				modelName: "qwen3.6-plus",
				displayName: "Qwen Cloud",
				maxTokens: 8192,
				reasoningEffort: "high",
				thinkingType: null,
			},
			model2: {
				baseUrl: "",
				apiKey: "",
				modelName: "",
				displayName: "Model Two",
				maxTokens: null,
				reasoningEffort: null,
				thinkingType: null,
			},
		});
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					JSON.stringify({
						id: "chatcmpl-1",
						model: "qwen3.6-plus",
						created: 1_717_171_717,
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: JSON.stringify({ ok: true }),
								},
								finish_reason: "stop",
							},
						],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		);

		await sendJsonControlMessage("Return JSON", "model1", {
			systemPrompt: "context-compression",
			thinkingMode: "on",
			fetch,
			jsonSchema: {
				name: "control_result",
				strict: true,
				schema: {
					type: "object",
					properties: { ok: { type: "boolean" } },
					required: ["ok"],
					additionalProperties: false,
				},
			},
		});

		const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
		expect(body.enable_thinking).toBe(true);
		expect(body.preserve_thinking).toBe(true);
		expect(body).not.toHaveProperty("reasoning_effort");
		expect(body.response_format).toEqual({
			type: "json_schema",
			json_schema: {
				name: "control_result",
				strict: true,
				schema: {
					type: "object",
					properties: { ok: { type: "boolean" } },
					required: ["ok"],
					additionalProperties: false,
				},
			},
		});
	});

	it("preserves Kimi thinking controls when thinking is disabled", async () => {
		mocks.getConfig.mockReturnValue({
			requestTimeoutMs: 300_000,
			model1: {
				baseUrl: "https://api.moonshot.ai/v1",
				apiKey: "kimi-secret",
				modelName: "kimi-k2.6",
				displayName: "Kimi",
				maxTokens: 8192,
				reasoningEffort: "medium",
				thinkingType: "enabled",
			},
			model2: {
				baseUrl: "",
				apiKey: "",
				modelName: "",
				displayName: "Model Two",
				maxTokens: null,
				reasoningEffort: null,
				thinkingType: null,
			},
		});
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					JSON.stringify({
						id: "chatcmpl-1",
						model: "kimi-k2.6",
						created: 1_717_171_717,
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: JSON.stringify({ ok: true }),
								},
								finish_reason: "stop",
							},
						],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		);

		await sendJsonControlMessage("Return JSON", "model1", {
			systemPrompt: "context-compression",
			thinkingMode: "off",
			fetch,
		});

		const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body).not.toHaveProperty("reasoning_effort");
		expect(body).not.toHaveProperty("reasoningEffort");
	});

	it("uses json_object mode when skipStructuredOutputs is true", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					JSON.stringify({
						id: "chatcmpl-1",
						model: "provider-returned-model",
						created: 1_717_171_717,
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: JSON.stringify({ ok: true }),
								},
								finish_reason: "stop",
							},
						],
						usage: {
							prompt_tokens: 11,
							completion_tokens: 7,
							total_tokens: 18,
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		);

		await sendJsonControlMessage("Return JSON", "model1", {
			systemPrompt: "context-compression",
			thinkingMode: "off",
			fetch,
			skipStructuredOutputs: true,
			jsonSchema: {
				name: "control_result",
				strict: true,
				schema: {
					type: "object",
					properties: { ok: { type: "boolean" } },
					required: ["ok"],
					additionalProperties: false,
				},
			},
		});

		const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
		expect(body.response_format).toMatchObject({
			type: "json_object",
		});
		expect(body).not.toHaveProperty("strictJsonSchema");
	});

	it("returns model text when JSON mode finishes before parsed output is available", async () => {
		const partialJson = JSON.stringify({ ok: true });
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					JSON.stringify({
						id: "chatcmpl-1",
						model: "provider-returned-model",
						created: 1_717_171_717,
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: partialJson,
								},
								finish_reason: "length",
							},
						],
						usage: {
							prompt_tokens: 11,
							completion_tokens: 7,
							total_tokens: 18,
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		);

		await expect(
			sendJsonControlMessage("Return JSON", "model1", {
				systemPrompt: "context-compression",
				thinkingMode: "off",
				fetch,
				skipStructuredOutputs: true,
				jsonSchema: {
					name: "control_result",
					strict: true,
					schema: {
						type: "object",
						properties: { ok: { type: "boolean" } },
						required: ["ok"],
						additionalProperties: false,
					},
				},
			}),
		).resolves.toEqual(
			expect.objectContaining({
				text: partialJson,
				rawResponse: expect.objectContaining({
					choices: [
						expect.objectContaining({
							finish_reason: "length",
						}),
					],
				}),
			}),
		);
	});

	it("can opt into reasoning fallback for schema-guided JSON control responses", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					JSON.stringify({
						id: "chatcmpl-1",
						model: "provider-returned-model",
						created: 1_717_171_717,
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: "",
									reasoning: JSON.stringify({ ok: true }),
								},
								finish_reason: "stop",
							},
						],
						usage: {
							prompt_tokens: 11,
							completion_tokens: 7,
							total_tokens: 18,
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		);

		await expect(
			sendJsonControlMessage("Return JSON", "model1", {
				systemPrompt: "context-compression",
				thinkingMode: "on",
				fetch,
				allowReasoningFallback: true,
				jsonSchema: {
					name: "control_result",
					schema: {
						type: "object",
						properties: { ok: { type: "boolean" } },
						required: ["ok"],
					},
				},
			}),
		).resolves.toEqual(
			expect.objectContaining({
				text: JSON.stringify({ ok: true }),
				rawResponse: expect.objectContaining({
					model: "provider-returned-model",
				}),
			}),
		);
	});
});
