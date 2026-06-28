import { describe, expect, it } from "vitest";
import {
	buildNormalChatModelRunCompatibilityProviderOptions,
	isMiMoProvider,
	type NormalChatModelRunCompatibilityProvider,
	type OpenAICompatibleProviderFamily,
	resolveOpenAICompatibleProviderAdapterProfile,
	transformNormalChatModelRunRequestBody,
} from "./provider-compatibility";

const mimoProvider: NormalChatModelRunCompatibilityProvider = {
	name: "xiaomi_mimo",
	displayName: "Xiaomi MiMo",
	baseUrl: "https://api.xiaomimimo.com/v1",
	modelName: "mimo-v2.5-pro",
};

describe("Xiaomi MiMo provider compatibility", () => {
	it("uses max_completion_tokens instead of max_tokens", () => {
		const transformed = transformNormalChatModelRunRequestBody(
			{
				model: "mimo-v2.5-pro",
				messages: [{ role: "user", content: "Hello" }],
				max_tokens: 4096,
			},
			mimoProvider,
		);

		expect(transformed).toMatchObject({
			model: "mimo-v2.5-pro",
			max_completion_tokens: 4096,
		});
		expect(transformed).not.toHaveProperty("max_tokens");
	});

	it("detects MiMo from model name even when provider metadata is generic", () => {
		const transformed = transformNormalChatModelRunRequestBody(
			{
				model: "mimo-v2.5-pro",
				messages: [{ role: "user", content: "Hello" }],
				max_tokens: 1024,
			},
			{
				name: "model1",
				displayName: "Primary Model",
				baseUrl: "https://gateway.example.test/v1",
				modelName: "mimo-v2.5-pro",
			},
		);

		expect(transformed).toMatchObject({ max_completion_tokens: 1024 });
		expect(transformed).not.toHaveProperty("max_tokens");
	});

	it("detects MiMo V2.5 Pro UltraSpeed from the model name", () => {
		const provider = {
			name: "model1",
			displayName: "Primary Model",
			baseUrl: "https://gateway.example.test/v1",
			modelName: "mimo-v2.5-pro-ultraspeed",
		};

		expect(isMiMoProvider(provider)).toBe(true);
		expect(
			transformNormalChatModelRunRequestBody(
				{
					model: "mimo-v2.5-pro-ultraspeed",
					messages: [{ role: "user", content: "Hello" }],
					max_tokens: 131_072,
				},
				provider,
			),
		).toMatchObject({ max_completion_tokens: 131_072 });
	});

	it("leaves MiMo reasoning controls under model/UI configuration", () => {
		const options = buildNormalChatModelRunCompatibilityProviderOptions(
			{
				...mimoProvider,
				reasoningEffort: "high",
				thinkingType: "enabled",
			},
			"on",
		);

		expect(options).toEqual({
			reasoningEffort: "high",
			thinking: { type: "enabled" },
		});
	});

	it("does not rewrite max_tokens for otherwise generic providers", () => {
		const transformed = transformNormalChatModelRunRequestBody(
			{
				model: "generic-chat-model",
				messages: [{ role: "user", content: "Hello" }],
				max_tokens: 512,
			},
			{
				name: "generic",
				displayName: "Generic",
				baseUrl: "https://gateway.example.test/v1",
				modelName: "generic-chat-model",
			},
		);

		expect(transformed).toMatchObject({ max_tokens: 512 });
		expect(transformed).not.toHaveProperty("max_completion_tokens");
	});
});

describe("OpenAI-compatible provider adapter profiles", () => {
	const providers: Array<{
		family: OpenAICompatibleProviderFamily;
		provider: NormalChatModelRunCompatibilityProvider;
	}> = [
		{
			family: "openai",
			provider: {
				name: "openai",
				displayName: "OpenAI",
				baseUrl: "https://api.openai.com/v1",
				modelName: "gpt-5-mini",
			},
		},
		{
			family: "deepseek",
			provider: {
				name: "gateway-primary",
				displayName: "DeepSeek V4",
				baseUrl: "https://gateway.example.test/openai/v1",
				modelName: "deepseek-v4-chat",
			},
		},
		{
			family: "mimo",
			provider: {
				name: "xiaomi",
				displayName: "Xiaomi MiMo",
				baseUrl: "https://gateway.example.test/openai/v1",
				modelName: "mimo-v2.5-pro",
			},
		},
		{
			family: "kimi",
			provider: {
				name: "moonshot",
				displayName: "Kimi K2.1",
				baseUrl: "https://api.moonshot.ai/v1",
				modelName: "kimi-k2.1",
			},
		},
		{
			family: "glm",
			provider: {
				name: "zhipu",
				displayName: "GLM 5",
				baseUrl: "https://open.bigmodel.cn/api/paas/v4",
				modelName: "glm-5-plus",
			},
		},
		{
			family: "qwen",
			provider: {
				name: "dashscope",
				displayName: "Qwen 3",
				baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
				modelName: "qwen3-max",
			},
		},
		{
			family: "generic",
			provider: {
				name: "acme",
				displayName: "Acme Compatible",
				baseUrl: "https://models.example.test/v1",
				modelName: "general-chat",
			},
		},
	];

	it.each(
		providers,
	)("resolves $family through one adapter resolver", (testCase) => {
		expect(
			resolveOpenAICompatibleProviderAdapterProfile(testCase.provider).family,
		).toBe(testCase.family);
	});

	it.each(
		providers,
	)("exposes an error classifier through the resolved $family profile", (testCase) => {
		const profile = resolveOpenAICompatibleProviderAdapterProfile(
			testCase.provider,
		);

		expect(typeof profile.classifyProviderError).toBe("function");
		expect(profile.classifyProviderError({ providerSpecific: true })).toBe(
			"unknown",
		);
	});

	it.each(
		providers,
	)("classifies conservative OpenAI-compatible error payloads through the resolved $family profile", (testCase) => {
		const profile = resolveOpenAICompatibleProviderAdapterProfile(
			testCase.provider,
		);

		expect(
			profile.classifyProviderError({
				error: {
					type: "rate_limit_error",
					code: "rate_limit_exceeded",
					message: "Rate limit reached for this model.",
				},
			}),
		).toBe("retryable");
		expect(
			profile.classifyProviderError({
				error: {
					type: "authentication_error",
					code: "invalid_api_key",
					message: "Incorrect API key provided.",
				},
			}),
		).toBe("non_retryable");
		expect(
			profile.classifyProviderError({
				error: {
					type: "provider_specific_error",
					code: "provider_specific_code",
					message: "A provider-specific response.",
				},
			}),
		).toBe("unknown");
	});

	it("keeps existing provider option behavior on the resolved profiles", () => {
		const cases: Array<{
			provider: NormalChatModelRunCompatibilityProvider;
			expected: Record<string, unknown>;
		}> = [
			{
				provider: {
					name: "deepseek",
					displayName: "DeepSeek",
					baseUrl: "https://api.deepseek.com/v1",
					modelName: "deepseek-v4-chat",
					reasoningEffort: "high",
					thinkingType: "enabled",
				},
				expected: {
					reasoningEffort: "high",
					thinking: { type: "enabled" },
				},
			},
			{
				provider: {
					name: "moonshot",
					displayName: "Kimi",
					baseUrl: "https://api.moonshot.ai/v1",
					modelName: "kimi-k2",
					reasoningEffort: "medium",
					thinkingType: "enabled",
				},
				expected: {
					reasoningEffort: "medium",
					thinking: { type: "enabled", keep: "all" },
				},
			},
			{
				provider: {
					name: "dashscope",
					displayName: "Qwen",
					baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
					modelName: "qwen3-max",
					reasoningEffort: "high",
				},
				expected: {
					enable_thinking: true,
					preserve_thinking: true,
				},
			},
			{
				provider: {
					name: "zhipu",
					displayName: "GLM 5",
					baseUrl: "https://open.bigmodel.cn/api/paas/v4",
					modelName: "glm-5-plus",
					reasoningEffort: "low",
				},
				expected: {
					reasoningEffort: "low",
				},
			},
		];

		for (const testCase of cases) {
			const profile = resolveOpenAICompatibleProviderAdapterProfile(
				testCase.provider,
			);

			expect(profile.buildProviderOptions(testCase.provider, "on")).toEqual(
				testCase.expected,
			);
			expect(
				buildNormalChatModelRunCompatibilityProviderOptions(
					testCase.provider,
					"on",
				),
			).toEqual(testCase.expected);
		}
	});

	it("keeps provider request transforms on the resolved profiles", () => {
		const body = {
			model: "provider-model",
			messages: [
				{ role: "user", content: "Use the tool" },
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "call_1", type: "function" }],
				},
			],
			max_tokens: 512,
			tool_choice: { type: "function", function: { name: "search" } },
			thinking: { type: "enabled" },
			enable_thinking: true,
			preserve_thinking: true,
		};

		const cases: Array<{
			provider: NormalChatModelRunCompatibilityProvider;
			expected: Record<string, unknown>;
			absent: string[];
		}> = [
			{
				provider: {
					name: "openai",
					displayName: "OpenAI",
					baseUrl: "https://api.openai.com/v1",
					modelName: "gpt-5-mini",
				},
				expected: { max_completion_tokens: 512 },
				absent: ["max_tokens"],
			},
			{
				provider: {
					name: "deepseek",
					displayName: "DeepSeek",
					baseUrl: "https://api.deepseek.com/v1",
					modelName: "deepseek-v4-chat",
				},
				expected: { max_tokens: 512 },
				absent: ["tool_choice", "max_completion_tokens"],
			},
			{
				provider: {
					name: "moonshot",
					displayName: "Kimi",
					baseUrl: "https://api.moonshot.ai/v1",
					modelName: "kimi-k2",
				},
				expected: { max_tokens: 512 },
				absent: ["tool_choice", "max_completion_tokens"],
			},
			{
				provider: {
					name: "dashscope",
					displayName: "Qwen",
					baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
					modelName: "qwen3-max",
				},
				expected: { max_tokens: 512, enable_thinking: false },
				absent: ["preserve_thinking", "max_completion_tokens"],
			},
			{
				provider: {
					name: "zhipu",
					displayName: "GLM 5",
					baseUrl: "https://open.bigmodel.cn/api/paas/v4",
					modelName: "glm-5-plus",
				},
				expected: { max_tokens: 512 },
				absent: ["max_completion_tokens"],
			},
		];

		for (const testCase of cases) {
			const profile = resolveOpenAICompatibleProviderAdapterProfile(
				testCase.provider,
			);
			const transformed = profile.transformRequestBody(body, testCase.provider);

			expect(transformed).toMatchObject({
				...testCase.expected,
				messages: [
					{ role: "user", content: "Use the tool" },
					{
						role: "assistant",
						content: "",
						tool_calls: [{ id: "call_1", type: "function" }],
					},
				],
			});
			for (const key of testCase.absent) {
				expect(transformed).not.toHaveProperty(key);
			}
			expect(
				transformNormalChatModelRunRequestBody(body, testCase.provider),
			).toEqual(transformed);
		}
	});
});
