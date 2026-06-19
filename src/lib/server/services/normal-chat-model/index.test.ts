import { tool } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createModelCapabilitySet } from "$lib/model-capabilities";

const mocks = vi.hoisted(() => ({
	decryptApiKey: vi.fn(),
	getProviderWithSecrets: vi.fn(),
	getProviderByName: vi.fn(),
	getProviderModel: vi.fn(),
	listEnabledProviderModels: vi.fn(),
}));

vi.mock("../providers", () => ({
	getProviderByName: mocks.getProviderByName,
	getProviderWithSecrets: mocks.getProviderWithSecrets,
	decryptApiKey: mocks.decryptApiKey,
}));

vi.mock("../provider-models", () => ({
	getProviderModel: mocks.getProviderModel,
	listEnabledProviderModels: mocks.listEnabledProviderModels,
}));

import {
	buildNormalChatModelRunProviderOptions,
	mapNormalChatModelRunUsageToProviderSnapshot,
	resolveNormalChatModelRunProvider,
	runPlainNormalChatModelRun,
	runStreamingNormalChatModelRun,
} from "./index";

type ChatCompletionMessage = {
	role: "assistant";
	content?: string | Array<{ type: string; text: string }> | null;
	tool_calls?: unknown;
	reasoning_content?: string;
};

type RunPlainNormalChatModelRunArgs = Parameters<
	typeof runPlainNormalChatModelRun
>[0];
type ChatRunMessage = RunPlainNormalChatModelRunArgs["messages"][number];
type FetchMock = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
type StreamRunArgs = Parameters<typeof runStreamingNormalChatModelRun>[0];
type StreamUsage = {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
};

const produceFileSchema = z.object({
	title: z.string(),
});

const doneToolSchema = z.object({
	summary: z.string(),
});

function userTextMessage(content: string): ChatRunMessage {
	return {
		role: "user",
		content: [{ type: "text", text: content }],
	} as ChatRunMessage;
}

function createProduceFileTool(
	execute: (
		input: { title: string },
		context?: { toolCallId?: string },
	) => unknown = vi.fn(),
) {
	return tool({
		description: "Queue a file production job.",
		inputSchema: produceFileSchema,
		execute,
	});
}

function createDoneTool() {
	return tool({
		description: "Finish the assistant response.",
		inputSchema: doneToolSchema,
	});
}

function createProviderModelRow(params: {
	id: string;
	providerId?: string;
	name: string;
	displayName: string;
	fallbackProviderModelId?: string | null;
	capabilitiesJson?: string;
}) {
	return {
		id: params.id,
		providerId: params.providerId ?? "provider-1",
		name: params.name,
		displayName: params.displayName,
		iconAssetId: null,
		fallbackProviderModelId: params.fallbackProviderModelId ?? null,
		maxModelContext: null,
		compactionUiThreshold: null,
		targetConstructedContext: null,
		maxMessageLength: null,
		maxTokens: 4096,
		reasoningEffort: null,
		thinkingType: null,
		capabilitiesJson:
			params.capabilitiesJson ??
			JSON.stringify({
				chat: true,
				streaming: true,
				tools: false,
				structuredOutput: false,
				reasoningControls: false,
				usageReporting: false,
				fileMessageParts: false,
				imageMessageParts: false,
				modelsEndpoint: false,
			}),
		inputUsdMicrosPer1m: 1,
		cachedInputUsdMicrosPer1m: 1,
		cacheHitUsdMicrosPer1m: 1,
		cacheMissUsdMicrosPer1m: 1,
		outputUsdMicrosPer1m: 1,
		enabled: true,
		sortOrder: 0,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}

function parseRequestBody(fetchMock: FetchMock, callIndex = 0) {
	return JSON.parse(String(fetchMock.mock.calls[callIndex]?.[1]?.body));
}

function createStreamChunk(input: {
	id?: string;
	model?: string;
	created?: number;
	content?: string;
	reasoningContent?: string;
	toolCalls?: Array<{
		id: string;
		name: string;
		arguments: string;
	}>;
	finishReason?: string | null;
	usage?: StreamUsage;
}) {
	const {
		id = "chatcmpl-1",
		model = "stream-model",
		created = 1_717_171_717,
	} = input;
	const message: {
		content?: string;
		reasoning_content?: string;
		tool_calls?: Array<{
			index: number;
			id: string;
			type: "function";
			function: {
				name: string;
				arguments: string;
			};
		}>;
	} = {};

	if (input.content !== undefined) {
		message.content = input.content;
	}

	if (input.reasoningContent !== undefined) {
		message.reasoning_content = input.reasoningContent;
	}

	if (input.toolCalls && input.toolCalls.length > 0) {
		message.tool_calls = input.toolCalls.map((toolCall, index) => ({
			index,
			type: "function",
			id: toolCall.id,
			function: {
				name: toolCall.name,
				arguments: toolCall.arguments,
			},
		}));
	}

	return {
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [
			{
				index: 0,
				delta: message,
				finish_reason: input.finishReason ?? null,
			},
		],
		...(input.usage ? { usage: input.usage } : {}),
	};
}

function createStreamResponse(
	chunks: Parameters<typeof createStreamChunk>[0][],
) {
	return new Response(
		[
			...chunks.flatMap((chunk) => [
				`data: ${JSON.stringify(createStreamChunk(chunk))}`,
				"",
			]),
			"data: [DONE]",
			"",
		].join("\n"),
		{
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
		},
	);
}

async function collectStreamingEvents(args: StreamRunArgs) {
	const events = [];
	for await (const event of runStreamingNormalChatModelRun(args)) {
		events.push(event);
	}
	return events;
}

function createMockChatCompletionResponse({
	message,
	model = "provider-returned-model",
	responseId = "chatcmpl-1",
	created = 1_717_171_717,
	finishReason = "stop",
	usage = {
		prompt_tokens: 11,
		completion_tokens: 7,
		total_tokens: 18,
	},
	status = 200,
	errorMessage,
}: {
	message: ChatCompletionMessage;
	model?: string;
	responseId?: string;
	created?: number;
	finishReason?: string;
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	} | null;
	status?: number;
	errorMessage?: { message: string; type: string };
}) {
	const payload = errorMessage
		? { error: errorMessage }
		: {
				id: responseId,
				model,
				created,
				choices: [
					{
						index: 0,
						message,
						finish_reason: finishReason,
					},
				],
				...(usage === null ? {} : { usage }),
			};
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			"Content-Type": errorMessage ? "application/json" : "application/json",
		},
	});
}

describe("Normal Chat Model Run provider resolution", () => {
	beforeEach(() => {
		mocks.getProviderByName.mockReset();
		mocks.listEnabledProviderModels.mockReset();
		mocks.getProviderWithSecrets.mockReset();
		mocks.getProviderModel.mockReset();
		mocks.decryptApiKey.mockReset();
		mocks.getProviderByName.mockResolvedValue(null);
	});

	it("resolves built-in model IDs from runtime config", async () => {
		await expect(
			resolveNormalChatModelRunProvider("model1", {
				model1: {
					baseUrl: "https://openai-compatible.example/v1/chat/completions",
					apiKey: "model-1-secret",
					modelName: "gpt-4.1",
					displayName: "Model One",
					maxTokens: 1234,
					reasoningEffort: "high",
					thinkingType: null,
				},
				model2: {
					baseUrl: "https://unused.example/v1",
					apiKey: "unused",
					modelName: "unused",
					displayName: "Unused",
					maxTokens: null,
					reasoningEffort: null,
					thinkingType: null,
				},
			}),
		).resolves.toEqual({
			id: "model1",
			modelId: "model1",
			name: "model1",
			displayName: "Model One",
			baseUrl: "https://openai-compatible.example/v1",
			modelName: "gpt-4.1",
			apiKey: "model-1-secret",
			maxOutputTokens: 1234,
			reasoningEffort: "high",
		});
		expect(mocks.getProviderWithSecrets).not.toHaveBeenCalled();
	});

	it("resolves an enabled OpenAI-compatible provider with a normalized base URL", async () => {
		mocks.listEnabledProviderModels.mockResolvedValue([
			{
				id: "model-a",
				name: "accounts/fireworks/models/kimi-k2p6",
				maxTokens: 4096,
				reasoningEffort: "medium",
				thinkingType: "enabled",
			},
		]);
		mocks.decryptApiKey.mockReturnValue("plain-secret");
		mocks.getProviderWithSecrets.mockImplementation(async (providerId) => {
			if (providerId !== "provider-1") return null;
			return {
				id: "provider-1",
				name: "fireworks",
				displayName: "Fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1/chat/completions",
				apiKeyEncrypted: "encrypted-secret",
				apiKeyIv: "secret-iv",
				enabled: true,
			};
		});

		await expect(
			resolveNormalChatModelRunProvider("provider:provider-1"),
		).resolves.toEqual({
			id: "provider-1",
			modelId: "provider:provider-1",
			name: "fireworks",
			displayName: "Fireworks",
			iconUrl: null,
			baseUrl: "https://api.fireworks.ai/inference/v1",
			modelName: "accounts/fireworks/models/kimi-k2p6",
			apiKey: "plain-secret",
			maxOutputTokens: 4096,
			reasoningEffort: "medium",
			thinkingType: "enabled",
		});
		expect(mocks.decryptApiKey).toHaveBeenCalledWith(
			"encrypted-secret",
			"secret-iv",
		);
		expect(mocks.getProviderWithSecrets).toHaveBeenCalledWith("provider-1");
		expect(mocks.getProviderByName).not.toHaveBeenCalledWith(
			"provider:provider-1",
		);
	});

	it("resolves a composite provider model ID to the selected provider model row", async () => {
		mocks.listEnabledProviderModels.mockResolvedValue([
			{
				id: "model-a",
				name: "accounts/fireworks/models/other",
				displayName: "Other Model",
				maxTokens: 2048,
				reasoningEffort: null,
				thinkingType: null,
			},
			{
				id: "model-b",
				name: "qwen3-6-35b",
				displayName: "Qwen 3.6 35B",
				maxTokens: 24576,
				reasoningEffort: null,
				thinkingType: null,
			},
		]);
		mocks.decryptApiKey.mockReturnValue("plain-secret");
		mocks.getProviderWithSecrets.mockResolvedValue({
			id: "provider-1",
			name: "model2",
			displayName: "AlfyAI 5000",
			baseUrl: "http://192.168.1.96:30000/v1",
			apiKeyEncrypted: "legacy-local-token",
			apiKeyIv: "",
			enabled: true,
		});

		await expect(
			resolveNormalChatModelRunProvider("provider:provider-1:model-b"),
		).resolves.toMatchObject({
			id: "provider-1",
			modelId: "provider:provider-1:model-b",
			name: "model2",
			displayName: "Qwen 3.6 35B",
			baseUrl: "http://192.168.1.96:30000/v1",
			modelName: "qwen3-6-35b",
			apiKey: "plain-secret",
			maxOutputTokens: 24576,
		});
		expect(mocks.getProviderByName).not.toHaveBeenCalled();
		expect(mocks.decryptApiKey).toHaveBeenCalledWith("legacy-local-token", "");
	});

	it("does not fall back to runtime config when a DB-backed built-in provider secret is invalid", async () => {
		mocks.getProviderByName.mockResolvedValue({
			id: "provider-1",
			name: "model1",
			displayName: "Primary",
			baseUrl: "https://primary.example/v1",
			enabled: true,
		});
		mocks.listEnabledProviderModels.mockResolvedValue([
			{
				id: "model-a",
				name: "deepseek-v4-pro",
				displayName: "DeepSeek V4 Pro",
				maxTokens: 8192,
				reasoningEffort: null,
				thinkingType: null,
			},
		]);
		mocks.getProviderWithSecrets.mockResolvedValue({
			id: "provider-1",
			name: "model1",
			displayName: "Primary",
			baseUrl: "https://primary.example/v1",
			apiKeyEncrypted: "bad-secret",
			apiKeyIv: "iv",
			enabled: true,
		});
		mocks.decryptApiKey.mockImplementation(() => {
			throw new Error("bad decrypt");
		});

		await expect(
			resolveNormalChatModelRunProvider("model1", {
				model1: {
					baseUrl: "https://fallback.example/v1",
					apiKey: "fallback-secret",
					modelName: "fallback-model",
					displayName: "Fallback Model",
					maxTokens: 4096,
					reasoningEffort: null,
					thinkingType: null,
				},
				model2: {
					baseUrl: "https://unused.example/v1",
					apiKey: "unused",
					modelName: "unused",
					displayName: "Unused",
					maxTokens: null,
					reasoningEffort: null,
					thinkingType: null,
				},
			}),
		).rejects.toThrow("bad decrypt");
	});

	it("surfaces composite provider secret failures instead of reporting a generic missing provider", async () => {
		mocks.listEnabledProviderModels.mockResolvedValue([
			{
				id: "deepseek-model",
				name: "deepseek-v4-pro",
				displayName: "DeepSeek V4 Pro",
				maxTokens: 8192,
				reasoningEffort: "high",
				thinkingType: null,
			},
		]);
		mocks.getProviderWithSecrets.mockResolvedValue({
			id: "deepseek-provider",
			name: "deepseek",
			displayName: "DeepSeek",
			baseUrl: "https://api.deepseek.com/v1",
			apiKeyEncrypted: "bad-secret",
			apiKeyIv: "iv",
			enabled: true,
		});
		mocks.decryptApiKey.mockImplementation(() => {
			throw new Error("bad decrypt");
		});

		await expect(
			resolveNormalChatModelRunProvider(
				"provider:deepseek-provider:deepseek-model",
			),
		).rejects.toThrow("bad decrypt");
		expect(mocks.getProviderByName).not.toHaveBeenCalled();
	});

	it("projects provider model runtime context defaults into the model-run provider", async () => {
		mocks.getProviderByName.mockResolvedValue({
			id: "provider-1",
			name: "fireworks",
			displayName: "Fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			enabled: true,
		});
		mocks.listEnabledProviderModels.mockResolvedValue([
			{
				name: "accounts/fireworks/models/kimi-k2p6",
				maxModelContext: 200_000,
				maxTokens: 4096,
				reasoningEffort: null,
				thinkingType: null,
			},
		]);
		mocks.decryptApiKey.mockReturnValue("plain-secret");
		mocks.getProviderWithSecrets.mockResolvedValue({
			id: "provider-1",
			name: "fireworks",
			displayName: "Fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			apiKeyEncrypted: "encrypted-secret",
			apiKeyIv: "secret-iv",
			enabled: true,
		});

		await expect(
			resolveNormalChatModelRunProvider("provider:provider-1"),
		).resolves.toMatchObject({
			maxOutputTokens: 4096,
			maxModelContext: 200_000,
			compactionUiThreshold: 160_000,
			targetConstructedContext: 180_000,
		});
	});

	it("carries provider capability evidence into the model-run provider", async () => {
		const capabilities = createModelCapabilitySet({
			tools: {
				state: "not_detected",
				source: "manual_override",
				supported: false,
			},
			reasoningControls: {
				state: "detected",
				source: "probe",
			},
		});
		mocks.getProviderByName.mockResolvedValue({
			id: "provider-1",
			name: "fireworks",
			displayName: "Fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			enabled: true,
		});
		mocks.listEnabledProviderModels.mockResolvedValue([
			{
				name: "accounts/fireworks/models/kimi-k2p6",
				maxTokens: null,
				reasoningEffort: "medium",
				capabilitiesJson: JSON.stringify(capabilities),
			},
		]);
		mocks.decryptApiKey.mockReturnValue("plain-secret");
		mocks.getProviderWithSecrets.mockResolvedValue({
			id: "provider-1",
			name: "fireworks",
			displayName: "Fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			apiKeyEncrypted: "encrypted-secret",
			apiKeyIv: "secret-iv",
			enabled: true,
		});

		await expect(
			resolveNormalChatModelRunProvider("provider:provider-1"),
		).resolves.toMatchObject({
			id: "provider-1",
			capabilities,
		});
	});
});

describe("Normal Chat Model Run provider options", () => {
	it("uses configured reasoning effort for auto/on and disables known thinking models for off", () => {
		const provider = {
			id: "provider-1",
			name: "fireworks",
			displayName: "Fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			modelName: "accounts/fireworks/models/kimi-k2p6",
			apiKey: "plain-secret",
			reasoningEffort: "high" as const,
		};

		expect(buildNormalChatModelRunProviderOptions(provider, "auto")).toEqual({
			fireworks: { reasoningEffort: "high" },
		});
		expect(buildNormalChatModelRunProviderOptions(provider, "on")).toEqual({
			fireworks: { reasoningEffort: "high" },
		});
		expect(buildNormalChatModelRunProviderOptions(provider, "off")).toEqual({
			fireworks: { thinking: { type: "disabled" } },
		});
	});

	it("suppresses reasoning options when capability evidence says reasoning controls are unsupported", () => {
		const provider = {
			id: "provider-1",
			name: "fireworks",
			displayName: "Fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			modelName: "accounts/fireworks/models/kimi-k2p6",
			apiKey: "plain-secret",
			reasoningEffort: "high" as const,
			capabilities: createModelCapabilitySet({
				reasoningControls: {
					state: "not_detected",
					source: "probe",
					detail: "Provider rejected reasoning_effort",
				},
			}),
		};

		expect(buildNormalChatModelRunProviderOptions(provider, "on")).toBe(
			undefined,
		);
	});

	it("uses Qwen thinking request options instead of reasoning effort", () => {
		const provider = {
			id: "provider-1",
			name: "dashscope",
			displayName: "Qwen Cloud",
			baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
			modelName: "qwen3.6-plus",
			apiKey: "plain-secret",
			reasoningEffort: "high" as const,
		};

		expect(buildNormalChatModelRunProviderOptions(provider, "on")).toEqual({
			dashscope: {
				enable_thinking: true,
				preserve_thinking: true,
			},
		});
		expect(buildNormalChatModelRunProviderOptions(provider, "off")).toEqual({
			dashscope: {
				enable_thinking: false,
			},
		});
	});
});

describe("Normal Chat Model Run usage mapping", () => {
	it("maps AI SDK usage into provider usage snapshots when any token count is present", () => {
		expect(
			mapNormalChatModelRunUsageToProviderSnapshot({
				inputTokens: 11,
				outputTokens: 7,
				totalTokens: 18,
			}),
		).toEqual({
			promptTokens: 11,
			completionTokens: 7,
			totalTokens: 18,
			source: "provider",
		});
	});

	it("returns null when AI SDK usage has no token counts", () => {
		expect(
			mapNormalChatModelRunUsageToProviderSnapshot({
				inputTokens: undefined,
				outputTokens: undefined,
				totalTokens: undefined,
			}),
		).toBeNull();
	});
});

describe("Plain Normal Chat Model Run", () => {
	it("rejects tool-required plain runs before the provider call when tools are unsupported", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();

		await expect(
			runPlainNormalChatModelRun({
				provider: {
					id: "provider-1",
					name: "fireworks",
					displayName: "Fireworks",
					baseUrl: "https://api.fireworks.ai/inference/v1",
					modelName: "accounts/fireworks/models/kimi-k2p6",
					apiKey: "plain-secret",
					capabilities: createModelCapabilitySet({
						tools: {
							state: "not_detected",
							source: "probe",
							detail: "Provider rejected a tool probe",
						},
					}),
				},
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "Create a report file" }],
					},
				],
				tools: {
					produce_file: createProduceFileTool(),
				},
				fetch,
			}),
		).rejects.toThrow(
			"Normal Chat Model Run provider does not support required tools",
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("maps generated text, usage, and model metadata from an OpenAI-compatible response", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			createMockChatCompletionResponse({
				message: { role: "assistant", content: "Plain answer" },
				usage: {
					prompt_tokens: 11,
					completion_tokens: 7,
					total_tokens: 18,
				},
			}),
		);

		const result = await runPlainNormalChatModelRun({
			provider: {
				id: "provider-1",
				name: "fireworks",
				displayName: "Fireworks",
				baseUrl: "https://api.fireworks.ai/inference",
				modelName: "accounts/fireworks/models/kimi-k2p6",
				apiKey: "plain-secret",
				maxOutputTokens: 2048,
			},
			messages: [userTextMessage("Hello")],
			fetch,
		});

		expect(result).toEqual({
			text: "Plain answer",
			finishReason: "stop",
			usage: {
				inputTokens: 11,
				outputTokens: 7,
				totalTokens: 18,
			},
			model: {
				modelId: "provider-1",
				providerId: "provider-1",
				providerName: "fireworks",
				displayName: "Fireworks",
				requestedModelName: "accounts/fireworks/models/kimi-k2p6",
				responseModelName: "provider-returned-model",
			},
		});
		expect(fetch).toHaveBeenCalledWith(
			"https://api.fireworks.ai/inference/v1/chat/completions",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					authorization: "Bearer plain-secret",
					"content-type": "application/json",
				}),
			}),
		);
	});

	it("serializes generic reasoning effort to the outbound OpenAI-compatible body", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			createMockChatCompletionResponse({
				message: {
					role: "assistant",
					content: "Plain answer",
				},
				usage: null,
			}),
		);
		const provider = {
			id: "provider-1",
			name: "customhost",
			displayName: "Custom Host",
			baseUrl: "https://openai-compatible.example/v1",
			modelName: "gpt-oss-120b",
			apiKey: "plain-secret",
			reasoningEffort: "high" as const,
		};

		await runPlainNormalChatModelRun({
			provider,
			messages: [userTextMessage("Hello")],
			providerOptions: buildNormalChatModelRunProviderOptions(provider, "on"),
			fetch,
		});

		const body = parseRequestBody(fetch);
		expect(body.reasoning_effort).toBe("high");
		expect(body).not.toHaveProperty("reasoningEffort");
		expect(body).not.toHaveProperty("thinking");
	});

	it("serializes Kimi thinking and reasoning effort to the outbound body", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			createMockChatCompletionResponse({
				message: {
					role: "assistant",
					content: "Plain answer",
				},
				usage: null,
			}),
		);
		const provider = {
			id: "provider-1",
			name: "moonshot",
			displayName: "Kimi",
			baseUrl: "https://api.moonshot.ai/v1",
			modelName: "kimi-k2.6",
			apiKey: "plain-secret",
			reasoningEffort: "medium" as const,
			thinkingType: "enabled" as const,
		};

		await runPlainNormalChatModelRun({
			provider,
			messages: [userTextMessage("Hello")],
			providerOptions: buildNormalChatModelRunProviderOptions(provider, "on"),
			fetch,
		});

		const body = parseRequestBody(fetch);
		expect(body.reasoning_effort).toBe("medium");
		expect(body.thinking).toEqual({ type: "enabled", keep: "all" });
		expect(body).not.toHaveProperty("reasoningEffort");
	});

	it("serializes Qwen thinking options without reasoning effort", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			createMockChatCompletionResponse({
				message: {
					role: "assistant",
					content: "Plain answer",
				},
				usage: null,
			}),
		);
		const provider = {
			id: "provider-1",
			name: "dashscope",
			displayName: "Qwen Cloud",
			baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
			modelName: "qwen3.6-plus",
			apiKey: "plain-secret",
			reasoningEffort: "high" as const,
		};

		await runPlainNormalChatModelRun({
			provider,
			messages: [userTextMessage("Hello")],
			providerOptions: buildNormalChatModelRunProviderOptions(provider, "on"),
			fetch,
		});

		const body = parseRequestBody(fetch);
		expect(body.enable_thinking).toBe(true);
		expect(body.preserve_thinking).toBe(true);
		expect(body).not.toHaveProperty("reasoning_effort");
		expect(body).not.toHaveProperty("reasoningEffort");
	});

	it("does not retry plain chat calls by default", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							message: "rate limited",
							type: "rate_limit_error",
						},
					}),
					{
						status: 429,
						headers: { "Content-Type": "application/json" },
					},
				),
		);

		await expect(
			runPlainNormalChatModelRun({
				provider: {
					id: "provider-1",
					name: "fireworks",
					displayName: "Fireworks",
					baseUrl: "https://api.fireworks.ai/inference/v1",
					modelName: "accounts/fireworks/models/kimi-k2p6",
					apiKey: "plain-secret",
				},
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "Hello" }],
					},
				],
				fetch,
			}),
		).rejects.toBeInstanceOf(Error);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("retries a plain chat call on the configured timeout failover target", async () => {
		mocks.getProviderByName.mockResolvedValue(null);
		mocks.getProviderWithSecrets.mockResolvedValue(null);
		mocks.listEnabledProviderModels.mockResolvedValue([]);
		const timeoutError = Object.assign(
			new Error("Provider request timed out"),
			{
				name: "TimeoutError",
			},
		);
		const fetch = vi
			.fn()
			.mockRejectedValueOnce(timeoutError)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						id: "chatcmpl-2",
						model: "provider-returned-model-2",
						created: 1_717_171_718,
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: "Fallback answer",
								},
								finish_reason: "stop",
							},
						],
						usage: {
							prompt_tokens: 12,
							completion_tokens: 4,
							total_tokens: 16,
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);

		const result = await runPlainNormalChatModelRun({
			provider: {
				id: "model1",
				name: "model1",
				displayName: "Model One",
				baseUrl: "https://model-one.example/v1",
				modelName: "model-one",
				apiKey: "model-one-secret",
			},
			modelId: "model1",
			runtimeConfig: {
				requestTimeoutMs: 30_000,
				modelTimeoutFailoverEnabled: true,
				modelTimeoutFailoverTargetModel: "model2",
				modelTimeoutFailoverTimeoutMs: 1_000,
				model2Enabled: true,
				model1: {
					baseUrl: "https://model-one.example/v1",
					apiKey: "model-one-secret",
					modelName: "model-one",
					displayName: "Model One",
					systemPrompt: "",
					maxTokens: null,
					reasoningEffort: null,
					thinkingType: null,
				},
				model2: {
					baseUrl: "https://model-two.example/v1",
					apiKey: "model-two-secret",
					modelName: "model-two",
					displayName: "Model Two",
					systemPrompt: "",
					maxTokens: null,
					reasoningEffort: null,
					thinkingType: null,
				},
			} as never,
			messages: [userTextMessage("Hello")],
			fetch,
			maxRetries: 0,
		});

		expect(result.text).toBe("Fallback answer");
		expect(result.model).toMatchObject({
			providerId: "model2",
			displayName: "Model Two",
			requestedModelName: "model-two",
			responseModelName: "provider-returned-model-2",
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[0]?.[0]).toBe(
			"https://model-one.example/v1/chat/completions",
		);
		expect(fetch.mock.calls[1]?.[0]).toBe(
			"https://model-two.example/v1/chat/completions",
		);
	});

	it("retries a plain chat call on a provider-model timeout failover target", async () => {
		mocks.getProviderByName.mockResolvedValue(null);
		mocks.getProviderWithSecrets.mockImplementation(async (providerId) => {
			if (providerId !== "provider-1") return null;
			return {
				id: "provider-1",
				name: "fireworks",
				displayName: "Fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1/chat/completions",
				apiKeyEncrypted: "encrypted-secret",
				apiKeyIv: "secret-iv",
				enabled: true,
			};
		});
		mocks.getProviderModel.mockImplementation(async (id: string) => {
			if (id === "model-a") {
				return createProviderModelRow({
					id: "model-a",
					name: "accounts/fireworks/models/kimi-k2p6",
					displayName: "Kimi K2",
				});
			}
			return null;
		});
		mocks.listEnabledProviderModels.mockResolvedValue([
			{
				id: "model-a",
				name: "accounts/fireworks/models/kimi-k2p6",
				displayName: "Kimi K2",
				maxTokens: null,
				reasoningEffort: null,
				thinkingType: null,
			},
		]);
		mocks.decryptApiKey.mockReturnValue("plain-secret");
		const timeoutError = Object.assign(
			new Error("Provider request timed out"),
			{
				name: "TimeoutError",
			},
		);
		const fetch = vi
			.fn()
			.mockRejectedValueOnce(timeoutError)
			.mockResolvedValueOnce(
				createMockChatCompletionResponse({
					responseId: "chatcmpl-provider-fallback",
					message: {
						role: "assistant",
						content: "Provider fallback answer",
					},
					created: 1_717_171_718,
					usage: null,
				}),
			);

		const result = await runPlainNormalChatModelRun({
			provider: {
				id: "model1",
				name: "model1",
				displayName: "Model One",
				baseUrl: "https://model-one.example/v1",
				modelName: "model-one",
				apiKey: "model-one-secret",
			},
			modelId: "model1",
			runtimeConfig: {
				requestTimeoutMs: 30_000,
				modelTimeoutFailoverEnabled: true,
				modelTimeoutFailoverTargetModel: "provider:provider-1:model-a",
				modelTimeoutFailoverTimeoutMs: 1_000,
				model2Enabled: true,
				model1: {
					baseUrl: "https://model-one.example/v1",
					apiKey: "model-one-secret",
					modelName: "model-one",
					displayName: "Model One",
					systemPrompt: "",
					maxTokens: null,
					reasoningEffort: null,
					thinkingType: null,
				},
				model2: {
					baseUrl: "https://unused.example/v1",
					apiKey: "unused",
					modelName: "unused",
					displayName: "Unused",
					systemPrompt: "",
					maxTokens: null,
					reasoningEffort: null,
					thinkingType: null,
				},
			} as never,
			messages: [userTextMessage("Hello")],
			fetch,
			maxRetries: 0,
		});

		expect(result.text).toBe("Provider fallback answer");
		expect(result.model).toMatchObject({
			modelId: "provider:provider-1:model-a",
			providerId: "provider-1",
			displayName: "Kimi K2",
			requestedModelName: "accounts/fireworks/models/kimi-k2p6",
			responseModelName: "provider-returned-model",
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[1]?.[0]).toBe(
			"https://api.fireworks.ai/inference/v1/chat/completions",
		);
		const fallbackBody = parseRequestBody(fetch, 1);
		expect(fallbackBody.model).toBe("accounts/fireworks/models/kimi-k2p6");
		expect(mocks.getProviderWithSecrets).toHaveBeenCalledWith("provider-1");
		expect(mocks.getProviderByName).not.toHaveBeenCalledWith(
			"provider:provider-1",
		);
	});

	it("does not retry a plain chat call for a permanent unavailable error", async () => {
		mocks.getProviderByName.mockResolvedValue(null);
		mocks.getProviderWithSecrets.mockResolvedValue({
			id: "provider-1",
			name: "fireworks",
			displayName: "Fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1/chat/completions",
			apiKeyEncrypted: "encrypted-secret",
			apiKeyIv: "secret-iv",
			enabled: true,
		});
		mocks.getProviderModel.mockImplementation(async (id: string) => {
			if (id === "model-a") {
				return createProviderModelRow({
					id: "model-a",
					name: "accounts/fireworks/models/kimi-k2p6",
					displayName: "Kimi K2",
				});
			}
			return null;
		});
		const unavailableError = new Error("model unavailable");
		const fetch = vi.fn().mockRejectedValueOnce(unavailableError);

		await expect(
			runPlainNormalChatModelRun({
				provider: {
					id: "model1",
					name: "model1",
					displayName: "Model One",
					baseUrl: "https://model-one.example/v1",
					modelName: "model-one",
					apiKey: "model-one-secret",
				},
				modelId: "model1",
				runtimeConfig: {
					requestTimeoutMs: 30_000,
					modelTimeoutFailoverEnabled: true,
					modelTimeoutFailoverTargetModel: "provider:provider-1:model-a",
					modelTimeoutFailoverTimeoutMs: 1_000,
					model2Enabled: true,
					model1: {
						baseUrl: "https://model-one.example/v1",
						apiKey: "model-one-secret",
						modelName: "model-one",
						displayName: "Model One",
						systemPrompt: "",
						maxTokens: null,
						reasoningEffort: null,
						thinkingType: null,
					},
					model2: {
						baseUrl: "https://unused.example/v1",
						apiKey: "unused",
						modelName: "unused",
						displayName: "Unused",
						systemPrompt: "",
						maxTokens: null,
						reasoningEffort: null,
						thinkingType: null,
					},
				} as never,
				messages: [userTextMessage("Hello")],
				fetch,
				maxRetries: 0,
			}),
		).rejects.toThrow("model unavailable");

		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("uses the source provider model fallback once and does not chain to the global target", async () => {
		mocks.getProviderByName.mockResolvedValue(null);
		mocks.getProviderWithSecrets.mockImplementation(async (providerId) => {
			if (providerId !== "provider-1") return null;
			return {
				id: "provider-1",
				name: "fireworks",
				displayName: "Fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1/chat/completions",
				apiKeyEncrypted: "encrypted-secret",
				apiKeyIv: "secret-iv",
				enabled: true,
			};
		});
		mocks.getProviderModel.mockImplementation(async (id: string) => {
			if (id === "source-model") {
				return createProviderModelRow({
					id: "source-model",
					name: "source-model",
					displayName: "Source Model",
					fallbackProviderModelId: "fallback-model",
				});
			}
			if (id === "fallback-model") {
				return createProviderModelRow({
					id: "fallback-model",
					name: "fallback-model",
					displayName: "Fallback Model",
				});
			}
			return null;
		});
		mocks.listEnabledProviderModels.mockResolvedValue([
			{
				id: "source-model",
				name: "accounts/fireworks/models/source-model",
				displayName: "Source Model",
				maxTokens: 4096,
				reasoningEffort: null,
				thinkingType: null,
			},
			{
				id: "fallback-model",
				name: "accounts/fireworks/models/fallback-model",
				displayName: "Fallback Model",
				maxTokens: 4096,
				reasoningEffort: null,
				thinkingType: null,
			},
			{
				id: "global-model",
				name: "accounts/fireworks/models/global-model",
				displayName: "Global Model",
				maxTokens: 4096,
				reasoningEffort: null,
				thinkingType: null,
			},
		]);
		mocks.decryptApiKey.mockReturnValue("plain-secret");
		const rateLimitError = Object.assign(new Error("Too many requests"), {
			statusCode: 429,
		});
		const fetch = vi
			.fn()
			.mockRejectedValueOnce(rateLimitError)
			.mockResolvedValueOnce(
				createMockChatCompletionResponse({
					responseId: "chatcmpl-provider-fallback",
					message: {
						role: "assistant",
						content: "Fallback answer",
					},
					created: 1_717_171_719,
					usage: null,
				}),
			);

		const result = await runPlainNormalChatModelRun({
			provider: {
				id: "provider-1",
				modelId: "provider:provider-1:source-model",
				name: "fireworks",
				displayName: "Source Model",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				modelName: "accounts/fireworks/models/source-model",
				apiKey: "model-secret",
			},
			modelId: "provider:provider-1:source-model",
			runtimeConfig: {
				requestTimeoutMs: 30_000,
				modelTimeoutFailoverEnabled: true,
				modelTimeoutFailoverTargetModel: "provider:provider-1:global-model",
				modelTimeoutFailoverTimeoutMs: 1_000,
				model2Enabled: true,
				model1: {
					baseUrl: "https://model-one.example/v1",
					apiKey: "model-one-secret",
					modelName: "model-one",
					displayName: "Model One",
					systemPrompt: "",
					maxTokens: null,
					reasoningEffort: null,
					thinkingType: null,
				},
				model2: {
					baseUrl: "https://model-two.example/v1",
					apiKey: "model-two-secret",
					modelName: "model-two",
					displayName: "Model Two",
					systemPrompt: "",
					maxTokens: null,
					reasoningEffort: null,
					thinkingType: null,
				},
			} as never,
			messages: [userTextMessage("Hello")],
			fetch,
			maxRetries: 0,
		});

		expect(result.text).toBe("Fallback answer");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[0]?.[0]).toBe(
			"https://api.fireworks.ai/inference/v1/chat/completions",
		);
		expect(fetch.mock.calls[1]?.[0]).toBe(
			"https://api.fireworks.ai/inference/v1/chat/completions",
		);
		expect(parseRequestBody(fetch, 1).model).toBe(
			"accounts/fireworks/models/fallback-model",
		);
		expect(result.model).toMatchObject({
			modelId: "provider:provider-1:fallback-model",
			providerId: "provider-1",
			displayName: "Fallback Model",
			requestedModelName: "accounts/fireworks/models/fallback-model",
			responseModelName: "provider-returned-model",
		});
	});

	it("uses a compatible cross-provider provider-model fallback once", async () => {
		mocks.getProviderByName.mockResolvedValue(null);
		mocks.getProviderWithSecrets.mockImplementation(async (providerId) => {
			if (providerId === "provider-1") {
				return {
					id: "provider-1",
					name: "source-provider",
					displayName: "Source Provider",
					baseUrl: "https://source.example/v1/chat/completions",
					apiKeyEncrypted: "encrypted-source",
					apiKeyIv: "source-iv",
					enabled: true,
				};
			}
			if (providerId === "provider-2") {
				return {
					id: "provider-2",
					name: "fallback-provider",
					displayName: "Fallback Provider",
					baseUrl: "https://fallback.example/v1/chat/completions",
					apiKeyEncrypted: "encrypted-fallback",
					apiKeyIv: "fallback-iv",
					enabled: true,
				};
			}
			return null;
		});
		mocks.getProviderModel.mockImplementation(async (id: string) => {
			if (id === "source-model") {
				return createProviderModelRow({
					id: "source-model",
					providerId: "provider-1",
					name: "source-model",
					displayName: "Source Model",
					fallbackProviderModelId: "fallback-model",
					capabilitiesJson: JSON.stringify({
						chat: true,
						streaming: true,
						tools: true,
						structuredOutput: true,
						reasoningControls: false,
						usageReporting: false,
						fileMessageParts: false,
						imageMessageParts: false,
						modelsEndpoint: false,
					}),
				});
			}
			if (id === "fallback-model") {
				return createProviderModelRow({
					id: "fallback-model",
					providerId: "provider-2",
					name: "fallback-model",
					displayName: "Fallback Model",
					capabilitiesJson: JSON.stringify({
						chat: true,
						streaming: true,
						tools: true,
						structuredOutput: true,
						reasoningControls: false,
						usageReporting: false,
						fileMessageParts: false,
						imageMessageParts: false,
						modelsEndpoint: false,
					}),
				});
			}
			return null;
		});
		mocks.listEnabledProviderModels.mockImplementation(
			async (providerId: string) => {
				if (providerId === "provider-1") {
					return [
						{
							id: "source-model",
							name: "source-model",
							displayName: "Source Model",
							maxTokens: 4096,
							reasoningEffort: null,
							thinkingType: null,
						},
					];
				}
				if (providerId === "provider-2") {
					return [
						{
							id: "fallback-model",
							name: "fallback-model",
							displayName: "Fallback Model",
							maxTokens: 4096,
							reasoningEffort: null,
							thinkingType: null,
						},
					];
				}
				return [];
			},
		);
		mocks.decryptApiKey.mockImplementation((encrypted: string) => {
			if (encrypted === "encrypted-source") return "source-secret";
			if (encrypted === "encrypted-fallback") return "fallback-secret";
			return "plain-secret";
		});
		const rateLimitError = Object.assign(new Error("Too many requests"), {
			statusCode: 429,
		});
		const fetch = vi
			.fn()
			.mockRejectedValueOnce(rateLimitError)
			.mockResolvedValueOnce(
				createMockChatCompletionResponse({
					responseId: "chatcmpl-provider-fallback",
					message: {
						role: "assistant",
						content: "Cross-provider fallback answer",
					},
					created: 1_717_171_720,
					usage: null,
				}),
			);

		const result = await runPlainNormalChatModelRun({
			provider: {
				id: "provider-1",
				modelId: "provider:provider-1:source-model",
				name: "source-provider",
				displayName: "Source Model",
				baseUrl: "https://source.example/v1",
				modelName: "source-model",
				apiKey: "source-secret",
			},
			modelId: "provider:provider-1:source-model",
			runtimeConfig: {
				requestTimeoutMs: 30_000,
				modelTimeoutFailoverEnabled: true,
				modelTimeoutFailoverTargetModel: "model2",
				modelTimeoutFailoverTimeoutMs: 1_000,
				model2Enabled: true,
				model1: {
					baseUrl: "https://model-one.example/v1",
					apiKey: "model-one-secret",
					modelName: "model-one",
					displayName: "Model One",
					systemPrompt: "",
					maxTokens: null,
					reasoningEffort: null,
					thinkingType: null,
				},
				model2: {
					baseUrl: "https://model-two.example/v1",
					apiKey: "model-two-secret",
					modelName: "model-two",
					displayName: "Model Two",
					systemPrompt: "",
					maxTokens: null,
					reasoningEffort: null,
					thinkingType: null,
				},
			} as never,
			messages: [userTextMessage("Hello")],
			fetch,
			maxRetries: 0,
		});

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(parseRequestBody(fetch, 1).model).toBe("fallback-model");
		expect(result.model).toMatchObject({
			modelId: "provider:provider-2:fallback-model",
			providerId: "provider-2",
			displayName: "Fallback Model",
			requestedModelName: "fallback-model",
			responseModelName: "provider-returned-model",
		});
	});

	it("retries a plain chat call once without tools when the provider rejects tools", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: {
							message: "tools are not supported by this model",
							type: "invalid_request_error",
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
									content: "Plain fallback answer",
								},
								finish_reason: "stop",
							},
						],
						usage: {
							prompt_tokens: 12,
							completion_tokens: 4,
							total_tokens: 16,
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);

		const result = await runPlainNormalChatModelRun({
			provider: {
				id: "provider-1",
				name: "fireworks",
				displayName: "Fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				modelName: "accounts/fireworks/models/kimi-k2p6",
				apiKey: "plain-secret",
			},
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Hello" }],
				},
			],
			tools: {
				produce_file: createProduceFileTool(),
			},
			fetch,
		});

		expect(result.text).toBe("Plain fallback answer");
		expect(fetch).toHaveBeenCalledTimes(2);

		const firstBody = parseRequestBody(fetch);
		expect(firstBody.tools).toEqual([
			expect.objectContaining({
				type: "function",
				function: expect.objectContaining({ name: "produce_file" }),
			}),
		]);

		const fallbackBody = parseRequestBody(fetch, 1);
		expect(fallbackBody).not.toHaveProperty("tools");
	});

	it("sends named tool choice for required plain tool runs", async () => {
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
									content: "Queued the report.",
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

		await runPlainNormalChatModelRun({
			provider: {
				id: "provider-1",
				name: "fireworks",
				displayName: "Fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				modelName: "accounts/fireworks/models/kimi-k2p6",
				apiKey: "plain-secret",
			},
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Create a PDF report" }],
				},
			],
			tools: {
				produce_file: createProduceFileTool(),
			},
			toolChoice: { type: "tool", toolName: "produce_file" },
			fetch,
		});

		const body = parseRequestBody(fetch);
		expect(body.tool_choice).toEqual({
			type: "function",
			function: { name: "produce_file" },
		});
	});

	it("disables Qwen thinking when preserving a forced named tool choice", async () => {
		const qwenProvider = {
			id: "provider-1",
			name: "dashscope",
			displayName: "Qwen Cloud",
			baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
			modelName: "qwen3.6-plus",
			apiKey: "plain-secret",
			reasoningEffort: "high" as const,
		};
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
									content: "Queued the report.",
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

		await runPlainNormalChatModelRun({
			provider: qwenProvider,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Create a PDF report" }],
				},
			],
			providerOptions: buildNormalChatModelRunProviderOptions(
				qwenProvider,
				"on",
			),
			tools: {
				produce_file: createProduceFileTool(),
			},
			toolChoice: { type: "tool", toolName: "produce_file" },
			fetch,
		});

		const body = parseRequestBody(fetch);
		expect(body.tool_choice).toEqual({
			type: "function",
			function: { name: "produce_file" },
		});
		expect(body.enable_thinking).toBe(false);
		expect(body).not.toHaveProperty("preserve_thinking");
		expect(body).not.toHaveProperty("reasoning_effort");
	});

	it("adapts DeepSeek thinking tool requests before sending them to the provider", async () => {
		const deepSeekProvider = {
			id: "provider-1",
			name: "deepseek",
			displayName: "DeepSeek",
			baseUrl: "https://api.deepseek.com/v1",
			modelName: "deepseek-v4-pro",
			apiKey: "plain-secret",
			reasoningEffort: "high" as const,
			thinkingType: "enabled" as const,
		};
		const toolExecute = vi.fn(async () => ({
			jobId: "job-1",
			title: "Quarterly report",
		}));
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
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
									content: null,
									reasoning_content: "I should create the requested file.",
									tool_calls: [
										{
											id: "call-1",
											type: "function",
											function: {
												name: "produce_file",
												arguments: JSON.stringify({
													title: "Quarterly report",
												}),
											},
										},
									],
								},
								finish_reason: "tool_calls",
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
									content: "Queued the report.",
								},
								finish_reason: "stop",
							},
						],
						usage: {
							prompt_tokens: 12,
							completion_tokens: 4,
							total_tokens: 16,
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);

		await runPlainNormalChatModelRun({
			provider: deepSeekProvider,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Create a PDF report" }],
				},
			],
			providerOptions: buildNormalChatModelRunProviderOptions(
				deepSeekProvider,
				"on",
			),
			tools: {
				produce_file: createProduceFileTool(toolExecute),
			},
			toolChoice: { type: "tool", toolName: "produce_file" },
			fetch,
		});

		const firstBody = parseRequestBody(fetch);
		expect(firstBody.thinking).toEqual({ type: "enabled" });
		expect(firstBody.reasoning_effort).toBe("high");
		expect(firstBody).not.toHaveProperty("tool_choice");

		const secondBody = parseRequestBody(fetch, 1);
		expect(secondBody.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "assistant",
					content: "",
					reasoning_content: "I should create the requested file.",
					tool_calls: [
						expect.objectContaining({
							id: "call-1",
							type: "function",
							function: expect.objectContaining({
								name: "produce_file",
							}),
						}),
					],
				}),
			]),
		);
	});

	it("does not retry required tool-choice runs without tools", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							message: "tool_choice is not supported by this model",
							type: "invalid_request_error",
						},
					}),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				),
		);

		await expect(
			runPlainNormalChatModelRun({
				provider: {
					id: "provider-1",
					name: "fireworks",
					displayName: "Fireworks",
					baseUrl: "https://api.fireworks.ai/inference/v1",
					modelName: "accounts/fireworks/models/kimi-k2p6",
					apiKey: "plain-secret",
				},
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "Create a PDF report" }],
					},
				],
				tools: {
					produce_file: createProduceFileTool(),
				},
				toolChoice: { type: "tool", toolName: "produce_file" },
				fetch,
			}),
		).rejects.toBeInstanceOf(Error);

		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("does not drop tools as a fallback when capability evidence says tools are supported", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							message: "tools are not supported by this model",
							type: "invalid_request_error",
						},
					}),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				),
		);

		await expect(
			runPlainNormalChatModelRun({
				provider: {
					id: "provider-1",
					name: "fireworks",
					displayName: "Fireworks",
					baseUrl: "https://api.fireworks.ai/inference/v1",
					modelName: "accounts/fireworks/models/kimi-k2p6",
					apiKey: "plain-secret",
					capabilities: createModelCapabilitySet({
						tools: {
							state: "detected",
							source: "probe",
						},
					}),
				},
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "Hello" }],
					},
				],
				tools: {
					produce_file: createProduceFileTool(),
				},
				fetch,
			}),
		).rejects.toBeInstanceOf(Error);

		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it.each([
		{
			name: "generic 400",
			status: 400,
			message: "max_tokens must be greater than zero",
		},
		{
			name: "rate limit",
			status: 429,
			message: "tools are not supported during provider overload",
		},
		{
			name: "server error",
			status: 500,
			message: "tools are not supported during provider failure",
		},
	])("does not retry without tools for $name errors", async (errorCase) => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							message: errorCase.message,
							type: "invalid_request_error",
						},
					}),
					{
						status: errorCase.status,
						headers: { "Content-Type": "application/json" },
					},
				),
		);

		await expect(
			runPlainNormalChatModelRun({
				provider: {
					id: "provider-1",
					name: "fireworks",
					displayName: "Fireworks",
					baseUrl: "https://api.fireworks.ai/inference/v1",
					modelName: "accounts/fireworks/models/kimi-k2p6",
					apiKey: "plain-secret",
				},
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "Hello" }],
					},
				],
				tools: {
					produce_file: createProduceFileTool(),
				},
				fetch,
			}),
		).rejects.toBeInstanceOf(Error);

		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("uses call-specific max output tokens for a plain chat run", async () => {
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
									content: "Plain answer",
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

		await runPlainNormalChatModelRun({
			provider: {
				id: "provider-1",
				name: "fireworks",
				displayName: "Fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				modelName: "accounts/fireworks/models/kimi-k2p6",
				apiKey: "plain-secret",
				maxOutputTokens: 2048,
			},
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Hello" }],
				},
			],
			maxOutputTokens: 777,
			fetch,
		});

		const body = parseRequestBody(fetch);
		expect(body.max_tokens).toBe(777);
	});

	it("executes provided tools and continues the plain chat run across model steps", async () => {
		const toolExecute = vi.fn(async ({ title }: { title: string }) => ({
			jobId: "job-1",
			title,
		}));
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
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
									content: null,
									tool_calls: [
										{
											id: "call-1",
											type: "function",
											function: {
												name: "produce_file",
												arguments: JSON.stringify({
													title: "Quarterly report",
												}),
											},
										},
									],
								},
								finish_reason: "tool_calls",
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
									content: "Queued the report.",
								},
								finish_reason: "stop",
							},
						],
						usage: {
							prompt_tokens: 13,
							completion_tokens: 5,
							total_tokens: 18,
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);

		const result = await runPlainNormalChatModelRun({
			provider: {
				id: "provider-1",
				name: "fireworks",
				displayName: "Fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				modelName: "accounts/fireworks/models/kimi-k2p6",
				apiKey: "plain-secret",
				capabilities: createModelCapabilitySet({
					tools: {
						state: "detected",
						source: "probe",
					},
				}),
			},
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Create a report file" }],
				},
			],
			tools: {
				produce_file: createProduceFileTool(toolExecute),
			},
			fetch,
		});

		expect(result.text).toBe("Queued the report.");
		expect(toolExecute).toHaveBeenCalledWith(
			{ title: "Quarterly report" },
			expect.objectContaining({ toolCallId: "call-1" }),
		);
		expect(fetch).toHaveBeenCalledTimes(2);

		const firstBody = parseRequestBody(fetch);
		expect(firstBody.tools).toEqual([
			expect.objectContaining({
				type: "function",
				function: expect.objectContaining({ name: "produce_file" }),
			}),
		]);

		const secondBody = parseRequestBody(fetch, 1);
		expect(secondBody.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "tool",
					tool_call_id: "call-1",
				}),
			]),
		);
	});

	it("uses a done tool summary as the plain assistant text", async () => {
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
									content: null,
									tool_calls: [
										{
											id: "call-done",
											type: "function",
											function: {
												name: "done",
												arguments: JSON.stringify({
													summary: "Finished.",
												}),
											},
										},
									],
								},
								finish_reason: "tool_calls",
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

		const result = await runPlainNormalChatModelRun({
			provider: {
				id: "provider-1",
				name: "fireworks",
				displayName: "Fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				modelName: "accounts/fireworks/models/kimi-k2p6",
				apiKey: "plain-secret",
			},
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Wrap this up" }],
				},
			],
			tools: {
				done: createDoneTool(),
			},
			fetch,
			maxRetries: 0,
		});

		expect(result.text).toBe("Finished.");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

describe("Streaming Normal Chat Model Run", () => {
	it("rejects streaming runs before the provider call when streaming is unsupported", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();

		expect(() =>
			runStreamingNormalChatModelRun({
				provider: {
					id: "provider-1",
					name: "fireworks",
					displayName: "Fireworks",
					baseUrl: "https://api.fireworks.ai/inference/v1",
					modelName: "accounts/fireworks/models/kimi-k2p6",
					apiKey: "plain-secret",
					capabilities: createModelCapabilitySet({
						streaming: {
							state: "not_detected",
							source: "probe",
							detail: "Provider rejected a streaming probe",
						},
					}),
				},
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "Hello" }],
					},
				],
				fetch,
			}),
		).toThrow(
			"Normal Chat Model Run provider does not support required streaming",
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("emits neutral text, usage, and finish events from an OpenAI-compatible stream", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			createStreamResponse([
				{ content: "Plain " },
				{ content: "stream" },
				{
					finishReason: "stop",
					usage: {
						prompt_tokens: 5,
						completion_tokens: 2,
						total_tokens: 7,
					},
				},
			]),
		);

		const events = await collectStreamingEvents({
			provider: {
				id: "provider-1",
				name: "fireworks",
				displayName: "Fireworks",
				baseUrl: "https://api.fireworks.ai/inference",
				modelName: "accounts/fireworks/models/kimi-k2p6",
				apiKey: "plain-secret",
				maxOutputTokens: 2048,
			},
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Hello" }],
				},
			],
			fetch,
		});

		expect(events).toEqual([
			{ type: "text_delta", text: "Plain " },
			{ type: "text_delta", text: "stream" },
			{
				type: "usage",
				usage: {
					inputTokens: 5,
					outputTokens: 2,
					totalTokens: 7,
				},
			},
			{
				type: "finish",
				finishReason: "stop",
				rawFinishReason: "stop",
				model: {
					modelId: "provider-1",
					providerId: "provider-1",
					providerName: "fireworks",
					displayName: "Fireworks",
					requestedModelName: "accounts/fireworks/models/kimi-k2p6",
					responseModelName: "stream-model",
				},
			},
		]);
		expect(fetch).toHaveBeenCalledWith(
			"https://api.fireworks.ai/inference/v1/chat/completions",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					authorization: "Bearer plain-secret",
					"content-type": "application/json",
				}),
			}),
		);
	});

	it("emits neutral reasoning delta events when the provider streams reasoning", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			createStreamResponse([
				{ reasoningContent: "Thinking" },
				{ content: "Answer" },
				{
					finishReason: "stop",
					usage: {
						prompt_tokens: 5,
						completion_tokens: 2,
						total_tokens: 7,
					},
				},
			]),
		);

		const events = await collectStreamingEvents({
			provider: {
				id: "provider-1",
				name: "fireworks",
				displayName: "Fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				modelName: "accounts/fireworks/models/kimi-k2p6",
				apiKey: "plain-secret",
			},
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Hello" }],
				},
			],
			fetch,
		});

		expect(events).toContainEqual({
			type: "reasoning_delta",
			text: "Thinking",
		});
		expect(events).toContainEqual({ type: "text_delta", text: "Answer" });
	});

	it("does not request streaming usage when usage reporting is unsupported", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			createStreamResponse([{ content: "Answer" }, { finishReason: "stop" }]),
		);

		const events = await collectStreamingEvents({
			provider: {
				id: "provider-1",
				name: "fireworks",
				displayName: "Fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				modelName: "accounts/fireworks/models/kimi-k2p6",
				apiKey: "plain-secret",
				capabilities: createModelCapabilitySet({
					usageReporting: {
						state: "not_detected",
						source: "probe",
						detail: "Provider rejected stream_options.include_usage",
					},
				}),
			},
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Hello" }],
				},
			],
			fetch,
		});

		expect(events).toContainEqual({ type: "text_delta", text: "Answer" });
		const body = parseRequestBody(fetch);
		expect(body.stream_options).toBeUndefined();
	});

	it("does not retry streaming chat calls by default", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							message: "rate limited",
							type: "rate_limit_error",
						},
					}),
					{
						status: 429,
						headers: { "Content-Type": "application/json" },
					},
				),
		);

		const events = await collectStreamingEvents({
			provider: {
				id: "provider-1",
				name: "fireworks",
				displayName: "Fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				modelName: "accounts/fireworks/models/kimi-k2p6",
				apiKey: "plain-secret",
			},
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Hello" }],
				},
			],
			fetch,
		});

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(consoleError).not.toHaveBeenCalled();
		expect(events).toEqual([
			{ type: "error", error: expect.stringContaining("rate limited") },
		]);
		consoleError.mockRestore();
	});

	it("does not use provider-wide rate-limit fallback in Normal Chat", async () => {
		mocks.getProviderByName.mockResolvedValue(null);
		mocks.getProviderWithSecrets.mockResolvedValue({
			id: "provider-1",
			name: "fireworks",
			displayName: "Fireworks",
			enabled: true,
			rateLimitFallbackEnabled: true,
			rateLimitFallbackBaseUrl: "https://fallback.fireworks.example/v1",
			rateLimitFallbackModelName: "fallback-model",
			rateLimitFallbackApiKeyEncrypted: "encrypted-fallback",
			rateLimitFallbackApiKeyIv: "fallback-iv",
			rateLimitFallbackTimeoutMs: 12_000,
		});
		mocks.decryptApiKey.mockReturnValue("fallback-secret");
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: {
							message: "rate limited",
							type: "rate_limit_error",
						},
					}),
					{
						status: 429,
						headers: { "Content-Type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(
				createStreamResponse([
					{ model: "fallback-returned-model", content: "Fallback " },
					{ model: "fallback-returned-model", content: "stream" },
					{
						model: "fallback-returned-model",
						finishReason: "stop",
						usage: {
							prompt_tokens: 5,
							completion_tokens: 2,
							total_tokens: 7,
						},
					},
				]),
			);

		const events = await collectStreamingEvents({
			provider: {
				id: "provider-1",
				name: "fireworks",
				displayName: "Fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				modelName: "accounts/fireworks/models/kimi-k2p6",
				apiKey: "plain-secret",
			},
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Hello" }],
				},
			],
			fetch,
			maxRetries: 0,
		});

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(events).toEqual([
			{ type: "error", error: expect.stringContaining("rate limited") },
		]);
	});

	it("switches a streaming chat call to the configured timeout failover model", async () => {
		mocks.getProviderByName.mockResolvedValue(null);
		mocks.getProviderWithSecrets.mockResolvedValue(null);
		const timeoutError = Object.assign(new Error("provider timed out"), {
			name: "TimeoutError",
		});
		const fetch = vi
			.fn()
			.mockRejectedValueOnce(timeoutError)
			.mockResolvedValueOnce(
				createStreamResponse([
					{
						model: "provider-returned-model-2",
						content: "Model 2 answer",
					},
					{
						model: "provider-returned-model-2",
						finishReason: "stop",
						usage: {
							prompt_tokens: 6,
							completion_tokens: 3,
							total_tokens: 9,
						},
					},
				]),
			);

		const events = await collectStreamingEvents({
			provider: {
				id: "model1",
				name: "model1",
				displayName: "Model One",
				baseUrl: "https://model-one.example/v1",
				modelName: "model-one",
				apiKey: "model-one-secret",
			},
			modelId: "model1",
			runtimeConfig: {
				requestTimeoutMs: 30_000,
				modelTimeoutFailoverEnabled: true,
				modelTimeoutFailoverTargetModel: "model2",
				modelTimeoutFailoverTimeoutMs: 1_000,
				model2Enabled: true,
				model1: {
					baseUrl: "https://model-one.example/v1",
					apiKey: "model-one-secret",
					modelName: "model-one",
					displayName: "Model One",
					systemPrompt: "",
					maxTokens: null,
					reasoningEffort: null,
					thinkingType: null,
				},
				model2: {
					baseUrl: "https://model-two.example/v1",
					apiKey: "model-two-secret",
					modelName: "model-two",
					displayName: "Model Two",
					systemPrompt: "",
					maxTokens: null,
					reasoningEffort: null,
					thinkingType: null,
				},
			} as never,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Hello" }],
				},
			],
			fetch,
			maxRetries: 0,
		});

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[0]?.[0]).toBe(
			"https://model-one.example/v1/chat/completions",
		);
		expect(fetch.mock.calls[1]?.[0]).toBe(
			"https://model-two.example/v1/chat/completions",
		);
		expect(events).toContainEqual({
			type: "text_delta",
			text: "Model 2 answer",
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "finish",
				model: expect.objectContaining({
					providerId: "model2",
					displayName: "Model Two",
					requestedModelName: "model-two",
					responseModelName: "provider-returned-model-2",
				}),
			}),
		);
	});

	it("switches streaming providers when the first visible output timeout fires", async () => {
		mocks.getProviderByName.mockResolvedValue(null);
		mocks.getProviderWithSecrets.mockResolvedValue(null);
		const fetch = vi
			.fn()
			.mockImplementationOnce((_url: string, init?: RequestInit) => {
				const signal = init?.signal as AbortSignal | undefined;
				return new Promise<Response>((_resolve, reject) => {
					if (!signal) {
						reject(new Error("missing abort signal"));
						return;
					}
					signal.addEventListener(
						"abort",
						() => reject(signal.reason ?? new Error("aborted")),
						{ once: true },
					);
				});
			})
			.mockResolvedValueOnce(
				createStreamResponse([
					{
						model: "provider-returned-model-2",
						content: "Timed fallback",
					},
					{
						model: "provider-returned-model-2",
						finishReason: "stop",
						usage: {
							prompt_tokens: 6,
							completion_tokens: 3,
							total_tokens: 9,
						},
					},
				]),
			);

		const events = await collectStreamingEvents({
			provider: {
				id: "model1",
				name: "model1",
				displayName: "Model One",
				baseUrl: "https://model-one.example/v1",
				modelName: "model-one",
				apiKey: "model-one-secret",
			},
			modelId: "model1",
			runtimeConfig: {
				requestTimeoutMs: 30_000,
				modelTimeoutFailoverEnabled: true,
				modelTimeoutFailoverTargetModel: "model2",
				modelTimeoutFailoverTimeoutMs: 1_000,
				model2Enabled: true,
				model1: {
					baseUrl: "https://model-one.example/v1",
					apiKey: "model-one-secret",
					modelName: "model-one",
					displayName: "Model One",
					systemPrompt: "",
					maxTokens: null,
					reasoningEffort: null,
					thinkingType: null,
				},
				model2: {
					baseUrl: "https://model-two.example/v1",
					apiKey: "model-two-secret",
					modelName: "model-two",
					displayName: "Model Two",
					systemPrompt: "",
					maxTokens: null,
					reasoningEffort: null,
					thinkingType: null,
				},
			} as never,
			firstOutputTimeoutMs: 1,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Hello" }],
				},
			],
			fetch,
			maxRetries: 0,
		});

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[1]?.[0]).toBe(
			"https://model-two.example/v1/chat/completions",
		);
		expect(events).toContainEqual({
			type: "text_delta",
			text: "Timed fallback",
		});
	});

	it("does not switch providers after streaming tool output", async () => {
		mocks.getProviderByName.mockResolvedValue(null);
		mocks.getProviderWithSecrets.mockResolvedValue({
			id: "provider-1",
			name: "fireworks",
			displayName: "Fireworks",
			enabled: true,
			rateLimitFallbackEnabled: true,
			rateLimitFallbackBaseUrl: "https://fallback.fireworks.example/v1",
			rateLimitFallbackModelName: "fallback-model",
			rateLimitFallbackApiKeyEncrypted: "encrypted-fallback",
			rateLimitFallbackApiKeyIv: "fallback-iv",
			rateLimitFallbackTimeoutMs: 12_000,
		});
		mocks.decryptApiKey.mockReturnValue("fallback-secret");
		const toolExecute = vi.fn(async ({ title }: { title: string }) => ({
			jobId: "job-1",
			title,
		}));
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				createStreamResponse([
					{
						model: "stream-model",
						toolCalls: [
							{
								id: "call-1",
								name: "produce_file",
								arguments: JSON.stringify({ title: "Quarterly report" }),
							},
						],
					},
					{
						model: "stream-model",
						finishReason: "tool_calls",
						usage: {
							prompt_tokens: 11,
							completion_tokens: 7,
							total_tokens: 18,
						},
					},
				]),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: {
							message: "rate limited after tool output",
							type: "rate_limit_error",
						},
					}),
					{
						status: 429,
						headers: { "Content-Type": "application/json" },
					},
				),
			);

		const events = await collectStreamingEvents({
			provider: {
				id: "provider-1",
				name: "fireworks",
				displayName: "Fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				modelName: "accounts/fireworks/models/kimi-k2p6",
				apiKey: "plain-secret",
			},
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Create a report file" }],
				},
			],
			tools: {
				produce_file: createProduceFileTool(toolExecute),
			},
			fetch,
			maxRetries: 0,
		});
		expect(events).toContainEqual({
			type: "tool_result",
			callId: "call-1",
			toolName: "produce_file",
			output: { jobId: "job-1", title: "Quarterly report" },
		});
		expect(events).toContainEqual({
			type: "error",
			error: expect.stringContaining("rate limited after tool output"),
		});
	});

	it("executes provided tools and emits neutral tool events during a streaming chat run", async () => {
		const toolExecute = vi.fn(async ({ title }: { title: string }) => ({
			jobId: "job-1",
			title,
		}));
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				createStreamResponse([
					{
						model: "stream-model",
						toolCalls: [
							{
								id: "call-1",
								name: "produce_file",
								arguments: JSON.stringify({ title: "Quarterly report" }),
							},
						],
					},
					{
						model: "stream-model",
						finishReason: "tool_calls",
						usage: {
							prompt_tokens: 11,
							completion_tokens: 7,
							total_tokens: 18,
						},
					},
				]),
			)
			.mockResolvedValueOnce(
				createStreamResponse([
					{
						model: "stream-model",
						content: "Queued the report.",
					},
					{
						model: "stream-model",
						finishReason: "stop",
						usage: {
							prompt_tokens: 13,
							completion_tokens: 5,
							total_tokens: 18,
						},
					},
				]),
			);

		const events = await collectStreamingEvents({
			provider: {
				id: "provider-1",
				name: "fireworks",
				displayName: "Fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				modelName: "accounts/fireworks/models/kimi-k2p6",
				apiKey: "plain-secret",
			},
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Create a report file" }],
				},
			],
			tools: {
				produce_file: createProduceFileTool(toolExecute),
			},
			fetch,
		});

		expect(events).toContainEqual({
			type: "tool_call",
			callId: "call-1",
			toolName: "produce_file",
			input: { title: "Quarterly report" },
		});
		expect(events).toContainEqual({
			type: "tool_result",
			callId: "call-1",
			toolName: "produce_file",
			output: { jobId: "job-1", title: "Quarterly report" },
		});
		expect(events).toContainEqual({
			type: "text_delta",
			text: "Queued the report.",
		});
		expect(toolExecute).toHaveBeenCalledWith(
			{ title: "Quarterly report" },
			expect.objectContaining({ toolCallId: "call-1" }),
		);

		const firstBody = parseRequestBody(fetch);
		expect(firstBody.tools).toEqual([
			expect.objectContaining({
				type: "function",
				function: expect.objectContaining({ name: "produce_file" }),
			}),
		]);

		const secondBody = parseRequestBody(fetch, 1);
		expect(secondBody.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "tool",
					tool_call_id: "call-1",
				}),
			]),
		);
	});

	it("suppresses done tool summary text and neutral tool events in streaming runs", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			createStreamResponse([
				{
					toolCalls: [
						{
							id: "call-done",
							name: "done",
							arguments: JSON.stringify({ summary: "Finished." }),
						},
					],
				},
				{
					finishReason: "tool_calls",
					usage: {
						prompt_tokens: 11,
						completion_tokens: 7,
						total_tokens: 18,
					},
				},
			]),
		);

		const events = await collectStreamingEvents({
			provider: {
				id: "provider-1",
				name: "fireworks",
				displayName: "Fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				modelName: "accounts/fireworks/models/kimi-k2p6",
				apiKey: "plain-secret",
			},
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Wrap this up" }],
				},
			],
			tools: {
				done: createDoneTool(),
			},
			fetch,
			maxRetries: 0,
		});

		expect(events).not.toContainEqual({
			type: "text_delta",
			text: "Finished.",
		});
		expect(events).not.toContainEqual(
			expect.objectContaining({
				type: "tool_call",
				toolName: "done",
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "finish",
				finishReason: "tool-calls",
			}),
		);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("sends named tool choice for required streaming tool runs", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			createStreamResponse([{ content: "Answer" }, { finishReason: "stop" }]),
		);

		await collectStreamingEvents({
			provider: {
				id: "provider-1",
				name: "fireworks",
				displayName: "Fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				modelName: "accounts/fireworks/models/kimi-k2p6",
				apiKey: "plain-secret",
			},
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Create a PDF report" }],
				},
			],
			tools: {
				produce_file: createProduceFileTool(),
			},
			toolChoice: { type: "tool", toolName: "produce_file" },
			fetch,
		});

		const body = parseRequestBody(fetch);
		expect(body.tool_choice).toEqual({
			type: "function",
			function: { name: "produce_file" },
		});
	});
});
