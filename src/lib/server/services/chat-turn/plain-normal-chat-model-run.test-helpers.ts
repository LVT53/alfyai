import type { RuntimeConfig } from "$lib/server/config-store";
import type { prepareOutboundChatContext } from "$lib/server/services/normal-chat-context";
import type {
	NormalChatModelRunProvider,
	runPlainNormalChatModelRun,
} from "$lib/server/services/normal-chat-model";
import type { PlainNormalChatSendModelParams } from "./plain-normal-chat-model-run";

type PreparedContext = Awaited<ReturnType<typeof prepareOutboundChatContext>>;
type ModelRunResult = Awaited<ReturnType<typeof runPlainNormalChatModelRun>>;

const baseRuntimeConfig = {
	requestTimeoutMs: 1_500,
	model1MaxModelContext: 10_000,
	model1TargetConstructedContext: 8_000,
	model1CompactionUiThreshold: 7_000,
	model1: {
		baseUrl: "https://openai-compatible.example/v1",
		apiKey: "model-1-secret",
		modelName: "gpt-4.1",
		displayName: "Model One",
		systemPrompt: "",
		maxTokens: 2_048,
		reasoningEffort: "high",
		thinkingType: null,
	},
	model2: {
		baseUrl: "https://unused.example/v1",
		apiKey: "",
		modelName: "unused",
		displayName: "Unused",
		systemPrompt: "",
		maxTokens: null,
		reasoningEffort: null,
		thinkingType: null,
	},
} as const satisfies Partial<RuntimeConfig>;

const basePreparedContext: PreparedContext = {
	inputValue: "Prepared user prompt",
	systemPrompt: "Prepared system prompt",
	contextStatus: undefined,
	taskState: null,
	contextDebug: null,
	contextTraceSections: [],
	contextLimits: {
		maxModelContext: 10_000,
		compactionUiThreshold: 7_000,
		targetConstructedContext: 8_000,
	},
};

const baseProvider: NormalChatModelRunProvider = {
	id: "model1",
	name: "model1",
	displayName: "Model One",
	baseUrl: "https://openai-compatible.example/v1",
	modelName: "gpt-4.1",
	apiKey: "model-1-secret",
	maxOutputTokens: 2_048,
	reasoningEffort: "high",
};

const baseModelRunResult: ModelRunResult = {
	text: "Answer",
	finishReason: "stop",
	usage: {
		inputTokens: undefined,
		outputTokens: undefined,
		totalTokens: undefined,
	},
	model: {
		modelId: "model1",
		providerId: "model1",
		providerName: "model1",
		displayName: "Model One",
		requestedModelName: "gpt-4.1",
		responseModelName: "gpt-4.1",
	},
};

export function createPlainNormalChatRuntimeConfig(
	overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
	return {
		...baseRuntimeConfig,
		...overrides,
		model1: {
			...baseRuntimeConfig.model1,
			...overrides.model1,
		},
		model2: {
			...baseRuntimeConfig.model2,
			...overrides.model2,
		},
	} as RuntimeConfig;
}

export function createPlainNormalChatSendModelParams(
	overrides: Partial<Omit<PlainNormalChatSendModelParams, "runtimeConfig">> & {
		runtimeConfig?: Partial<RuntimeConfig>;
	} = {},
): PlainNormalChatSendModelParams {
	const { runtimeConfig: runtimeConfigOverrides, ...rest } = overrides;

	return {
		userId: "user-1",
		runtimeConfig: createPlainNormalChatRuntimeConfig(runtimeConfigOverrides),
		message: "Hello",
		conversationId: "conv-1",
		modelId: "model1",
		...rest,
	};
}

export function createPlainNormalChatPreparedContext(
	overrides: Partial<PreparedContext> = {},
): PreparedContext {
	return {
		...basePreparedContext,
		...overrides,
	};
}

export function createPlainNormalChatProvider(
	overrides: Partial<NormalChatModelRunProvider> = {},
): NormalChatModelRunProvider {
	return {
		...baseProvider,
		...overrides,
	};
}

export function createPlainNormalChatModelRunResult(
	overrides: Partial<ModelRunResult> = {},
): ModelRunResult {
	return {
		...baseModelRunResult,
		...overrides,
		model: {
			...baseModelRunResult.model,
			...overrides.model,
		},
		usage: {
			...baseModelRunResult.usage,
			...overrides.usage,
		},
	};
}
