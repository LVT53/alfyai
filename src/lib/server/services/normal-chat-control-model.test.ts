import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getConfig: vi.fn(),
	getSystemPrompt: vi.fn(),
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
		mockConfig();
	});

	it("sends schema-guided JSON through the selected OpenAI-compatible normal-chat provider", async () => {
		const fetch = vi.fn(
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

	it("can opt into reasoning fallback for schema-guided JSON control responses", async () => {
		const fetch = vi.fn(
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
