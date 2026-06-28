import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { normalizeOpenAICompatibleBaseUrl } from "../openai-compatible-url";
import { createMiMoReasoningReplayFetch } from "./mimo-reasoning-replay";
import { createOpenAICompatibleStreamNormalizingFetch } from "./openai-compatible-stream-normalizer";
import {
	type NormalChatModelRunCompatibilityProvider,
	type OpenAICompatibleProviderAdapterProfile,
	resolveOpenAICompatibleProviderAdapterProfile,
} from "./provider-compatibility";

export type NormalChatOpenAICompatibleProviderConfig =
	NormalChatModelRunCompatibilityProvider & {
		apiKey?: string;
	};

export function composeOpenAICompatibleProviderAdapterFetch(params: {
	provider: NormalChatOpenAICompatibleProviderConfig;
	adapterProfile?: Pick<
		OpenAICompatibleProviderAdapterProfile,
		"replaysReasoningContentForToolCalls"
	>;
	fetch?: typeof fetch;
	normalizeStreaming?: boolean;
}): typeof fetch {
	const adapterProfile =
		params.adapterProfile ??
		resolveOpenAICompatibleProviderAdapterProfile(params.provider);
	let adapterFetch = params.fetch;

	if (params.normalizeStreaming !== false) {
		adapterFetch = createOpenAICompatibleStreamNormalizingFetch(adapterFetch);
	}

	if (adapterProfile.replaysReasoningContentForToolCalls) {
		adapterFetch = createMiMoReasoningReplayFetch({ fetch: adapterFetch });
	}

	return adapterFetch ?? fetch;
}

export function createOpenAICompatibleProviderForNormalChatModelRun(params: {
	provider: NormalChatOpenAICompatibleProviderConfig;
	fetch?: typeof fetch;
	includeUsage?: boolean;
	supportsStructuredOutputs?: boolean;
	normalizeStreaming?: boolean;
	transformRequestBody?: (
		body: Record<string, unknown>,
	) => Record<string, unknown>;
}) {
	const provider = { ...params.provider };
	const adapterProfile =
		resolveOpenAICompatibleProviderAdapterProfile(provider);
	const compatibilityFetch = composeOpenAICompatibleProviderAdapterFetch({
		provider,
		adapterProfile,
		fetch: params.fetch,
		normalizeStreaming: params.normalizeStreaming,
	});

	return createOpenAICompatible({
		name: provider.name,
		apiKey: provider.apiKey,
		baseURL: normalizeOpenAICompatibleBaseUrl(provider.baseUrl),
		includeUsage: params.includeUsage,
		supportsStructuredOutputs: params.supportsStructuredOutputs,
		transformRequestBody: (body) => {
			const transformed = adapterProfile.transformRequestBody(body, provider);
			return params.transformRequestBody
				? params.transformRequestBody(transformed)
				: transformed;
		},
		fetch: compatibilityFetch,
	});
}
