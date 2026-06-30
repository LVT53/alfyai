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

describe("provider family compatibility policy", () => {
	const gatewayProvider = (
		modelName: string,
		overrides: Partial<NormalChatModelRunCompatibilityProvider> = {},
	): NormalChatModelRunCompatibilityProvider => ({
		name: "fireworks",
		displayName: "Fireworks AI",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		modelName,
		...overrides,
	});

	it.each([
		{ family: "deepseek", modelName: "deepseek-v4-pro" },
		{ family: "mimo", modelName: "mimo-v2.5-pro" },
		{ family: "kimi", modelName: "kimi-k2.7-code" },
		{ family: "glm", modelName: "glm-5.2[1m]" },
		{ family: "qwen", modelName: "qwen3.7-max" },
		{ family: "mistral", modelName: "mistral-medium-3-5" },
		{
			family: "nvidia_nemotron",
			modelName: "nvidia/nemotron-3-ultra-550b-a55b",
		},
		{ family: "minimax", modelName: "MiniMax-M2.7-highspeed" },
		{ family: "gemma", modelName: "google/gemma-4-31B-it" },
		{ family: "gpt_oss", modelName: "openai/gpt-oss-120b" },
	] satisfies Array<{
		family: OpenAICompatibleProviderFamily;
		modelName: string;
	}>)("resolves $family from official model id $modelName", (testCase) => {
		expect(
			resolveOpenAICompatibleProviderAdapterProfile(
				gatewayProvider(testCase.modelName, {
					name: "gateway",
					displayName: "Gateway",
					baseUrl: "https://gateway.example.test/v1",
				}),
			).family,
		).toBe(testCase.family);
	});

	it.each([
		{ family: "kimi", alias: "kimi-k2.6" },
		{ family: "mistral", alias: "mistral-large-latest" },
		{ family: "minimax", alias: "MiniMax-M3" },
		{ family: "gemma", alias: "google/gemma-4-31b-it" },
		{ family: "gpt_oss", alias: "gpt-oss:20b" },
	] satisfies Array<{
		family: OpenAICompatibleProviderFamily;
		alias: string;
	}>)("resolves $family from admin model alias $alias", (testCase) => {
		const provider = gatewayProvider("accounts/fireworks/models/custom-model", {
			modelAliases: [testCase.alias],
		});

		expect(resolveOpenAICompatibleProviderAdapterProfile(provider).family).toBe(
			testCase.family,
		);
		expect(provider.modelName).toBe("accounts/fireworks/models/custom-model");
	});

	it("does not infer a family from a broad Fireworks gateway URL alone", () => {
		expect(
			resolveOpenAICompatibleProviderAdapterProfile(
				gatewayProvider("accounts/fireworks/models/llama-v3p1-405b"),
			).family,
		).toBe("generic");
	});

	it.each([
		{
			family: "kimi",
			provider: gatewayProvider("kimi-k2.6", {
				baseUrl: "https://api.moonshot.ai/v1",
			}),
			rewrites: true,
		},
		{
			family: "mimo",
			provider: gatewayProvider("mimo-v2.5", {
				baseUrl: "https://api.xiaomimimo.com/v1",
			}),
			rewrites: true,
		},
		{
			family: "minimax",
			provider: gatewayProvider("MiniMax-M3", {
				baseUrl: "https://api.minimax.io/v1",
			}),
			rewrites: true,
		},
		{
			family: "mistral",
			provider: gatewayProvider("mistral-small-latest", {
				baseUrl: "https://api.mistral.ai/v1",
			}),
			rewrites: false,
		},
		{
			family: "deepseek",
			provider: gatewayProvider("deepseek-v4-flash", {
				baseUrl: "https://api.deepseek.com/v1",
			}),
			rewrites: false,
		},
		{
			family: "glm",
			provider: gatewayProvider("glm-5.2", {
				baseUrl: "https://api.z.ai/api/paas/v4",
			}),
			rewrites: false,
		},
		{
			family: "qwen",
			provider: gatewayProvider("qwen3.6-plus", {
				baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			}),
			rewrites: false,
		},
		{
			family: "nvidia_nemotron",
			provider: gatewayProvider("nvidia/nemotron-3-super-120b-a12b", {
				baseUrl: "https://integrate.api.nvidia.com/v1",
			}),
			rewrites: false,
		},
		{
			family: "gemma",
			provider: gatewayProvider("google/gemma-4-31b-it", {
				baseUrl: "https://integrate.api.nvidia.com/v1",
			}),
			rewrites: false,
		},
		{
			family: "gpt_oss",
			provider: gatewayProvider("openai/gpt-oss-20b", {
				baseUrl: "https://integrate.api.nvidia.com/v1",
			}),
			rewrites: false,
		},
	] satisfies Array<{
		family: OpenAICompatibleProviderFamily;
		provider: NormalChatModelRunCompatibilityProvider;
		rewrites: boolean;
	}>)("applies the documented token field policy for $family", (testCase) => {
		const transformed = transformNormalChatModelRunRequestBody(
			{
				model: testCase.provider.modelName,
				messages: [{ role: "user", content: "Hello" }],
				max_tokens: 2048,
			},
			testCase.provider,
		);

		if (testCase.rewrites) {
			expect(transformed).toMatchObject({ max_completion_tokens: 2048 });
			expect(transformed).not.toHaveProperty("max_tokens");
		} else {
			expect(transformed).toMatchObject({ max_tokens: 2048 });
			expect(transformed).not.toHaveProperty("max_completion_tokens");
		}
	});

	it("keeps DeepSeek V4 tool_choice while thinking is enabled", () => {
		const transformed = transformNormalChatModelRunRequestBody(
			{
				model: "deepseek-v4-pro",
				messages: [{ role: "user", content: "Search" }],
				thinking: { type: "enabled" },
				tool_choice: { type: "function", function: { name: "search" } },
				tools: [{ type: "function", function: { name: "search" } }],
			},
			gatewayProvider("deepseek-v4-pro", {
				baseUrl: "https://api.deepseek.com/v1",
			}),
		);

		expect(transformed).toMatchObject({
			thinking: { type: "enabled" },
			tool_choice: { type: "function", function: { name: "search" } },
		});
	});

	it("does not send disabled thinking to Kimi K2.7 Code when the UI asks for off mode", () => {
		const provider = gatewayProvider("kimi-k2.7-code", {
			baseUrl: "https://api.moonshot.ai/v1",
		});

		expect(
			buildNormalChatModelRunCompatibilityProviderOptions(provider, "off"),
		).toEqual({ thinking: { type: "enabled", keep: "all" } });
		expect(
			transformNormalChatModelRunRequestBody(
				{
					model: "kimi-k2.7-code",
					messages: [{ role: "user", content: "Hello" }],
					thinking: { type: "disabled" },
				},
				provider,
			),
		).toMatchObject({ thinking: { type: "enabled", keep: "all" } });
	});

	it("applies Kimi K2.7 Code always-thinking policy through model aliases", () => {
		const provider = gatewayProvider("accounts/fireworks/models/kimi-code", {
			modelAliases: ["kimi-k2.7-code"],
		});

		expect(
			buildNormalChatModelRunCompatibilityProviderOptions(provider, "off"),
		).toEqual({ thinking: { type: "enabled", keep: "all" } });
		expect(
			transformNormalChatModelRunRequestBody(
				{
					model: provider.modelName,
					messages: [{ role: "user", content: "Hello" }],
					thinking: { type: "disabled" },
				},
				provider,
			),
		).toMatchObject({ thinking: { type: "enabled", keep: "all" } });
	});

	it("normalizes MiMo tool_choice to auto when callers request a named tool", () => {
		const transformed = transformNormalChatModelRunRequestBody(
			{
				model: "mimo-v2.5-pro",
				messages: [{ role: "user", content: "Use search" }],
				tool_choice: { type: "function", function: { name: "search" } },
				tools: [{ type: "function", function: { name: "search" } }],
			},
			gatewayProvider("mimo-v2.5-pro", {
				baseUrl: "https://api.xiaomimimo.com/v1",
			}),
		);

		expect(transformed.tool_choice).toBe("auto");
	});

	it("adds GLM streamed-tool controls and keeps only auto tool_choice", () => {
		const transformed = transformNormalChatModelRunRequestBody(
			{
				model: "glm-5.2",
				messages: [{ role: "user", content: "Use search" }],
				stream: true,
				tool_choice: "required",
				tools: [{ type: "function", function: { name: "search" } }],
			},
			gatewayProvider("glm-5.2", {
				baseUrl: "https://api.z.ai/api/paas/v4",
			}),
		);

		expect(transformed).toMatchObject({
			tool_choice: "auto",
			tool_stream: true,
		});
	});

	it("adds MiniMax reasoning split while preserving adaptive thinking by omission", () => {
		const provider = gatewayProvider("MiniMax-M3", {
			baseUrl: "https://api.minimax.io/v1",
		});

		expect(
			buildNormalChatModelRunCompatibilityProviderOptions(provider, "auto"),
		).toEqual({});
		expect(
			transformNormalChatModelRunRequestBody(
				{
					model: "MiniMax-M3",
					messages: [{ role: "user", content: "Hello" }],
					max_tokens: 1024,
				},
				provider,
			),
		).toMatchObject({
			max_completion_tokens: 1024,
			reasoning_split: true,
		});
	});

	it("keeps MiniMax M3 off-mode thinking explicit through model aliases", () => {
		const provider = gatewayProvider("accounts/fireworks/models/minimax", {
			modelAliases: ["MiniMax-M3"],
		});

		expect(
			buildNormalChatModelRunCompatibilityProviderOptions(provider, "off"),
		).toEqual({ thinking: { type: "disabled" } });
		expect(
			transformNormalChatModelRunRequestBody(
				{
					model: provider.modelName,
					messages: [{ role: "user", content: "Hello" }],
					thinking: { type: "disabled" },
				},
				provider,
			),
		).toMatchObject({
			thinking: { type: "disabled" },
			reasoning_split: true,
		});
	});

	it.each([
		{
			modelName: "nvidia/nemotron-3-nano-30b-a3b",
			baseUrl: "https://integrate.api.nvidia.com/v1",
		},
		{
			modelName: "google/gemma-4-31b-it",
			baseUrl: "https://integrate.api.nvidia.com/v1",
		},
	])("translates thinking objects to NVIDIA chat template kwargs for $modelName", (testCase) => {
		const transformed = transformNormalChatModelRunRequestBody(
			{
				model: testCase.modelName,
				messages: [{ role: "user", content: "Hello" }],
				thinking: { type: "enabled" },
			},
			gatewayProvider(testCase.modelName, {
				baseUrl: testCase.baseUrl,
			}),
		);

		expect(transformed).toMatchObject({
			chat_template_kwargs: { enable_thinking: true },
		});
		expect(transformed).not.toHaveProperty("thinking");
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

	it.each([
		{ family: "deepseek", modelName: "deepseek_v4_chat" },
		{ family: "kimi", modelName: "kimi_k2.1" },
		{ family: "glm", modelName: "glm5-plus" },
		{ family: "qwen", modelName: "qwen3-max" },
	] satisfies Array<{
		family: OpenAICompatibleProviderFamily;
		modelName: string;
	}>)("resolves compact generic-gateway model id $modelName as $family", (testCase) => {
		expect(
			resolveOpenAICompatibleProviderAdapterProfile({
				name: "gateway-primary",
				displayName: "Primary Gateway",
				baseUrl: "https://gateway.example.test/openai/v1",
				modelName: testCase.modelName,
			}).family,
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
			promptCacheKey: "fireworks-cache-key",
			promptCacheIsolationKey: "tenant-cache-isolation",
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
				absent: ["max_tokens", "prompt_cache_key"],
			},
			{
				provider: {
					name: "fireworks",
					displayName: "Fireworks",
					baseUrl: "https://api.fireworks.ai/inference/v1",
					modelName: "accounts/fireworks/models/kimi-k2p6",
				},
				expected: {
					max_completion_tokens: 512,
					prompt_cache_key: "fireworks-cache-key",
					prompt_cache_isolation_key: "tenant-cache-isolation",
				},
				absent: ["max_tokens", "promptCacheKey", "promptCacheIsolationKey"],
			},
			{
				provider: {
					name: "deepseek",
					displayName: "DeepSeek",
					baseUrl: "https://api.deepseek.com/v1",
					modelName: "deepseek-v4-chat",
				},
				expected: {
					max_tokens: 512,
					tool_choice: { type: "function", function: { name: "search" } },
				},
				absent: ["max_completion_tokens"],
			},
			{
				provider: {
					name: "moonshot",
					displayName: "Kimi",
					baseUrl: "https://api.moonshot.ai/v1",
					modelName: "kimi-k2",
				},
				expected: { max_completion_tokens: 512 },
				absent: ["tool_choice", "max_tokens"],
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
