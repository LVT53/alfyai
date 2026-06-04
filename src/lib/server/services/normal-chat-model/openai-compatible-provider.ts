import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { normalizeOpenAICompatibleBaseUrl } from "../openai-compatible-url";
import { createOpenAICompatibleStreamNormalizingFetch } from "./openai-compatible-stream-normalizer";
import {
	transformNormalChatModelRunRequestBody,
	type NormalChatModelRunCompatibilityProvider,
} from "./provider-compatibility";

export type NormalChatOpenAICompatibleProviderConfig =
	NormalChatModelRunCompatibilityProvider & {
		apiKey?: string;
	};

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
	const requestFetch =
		params.normalizeStreaming === false
			? params.fetch
			: createOpenAICompatibleStreamNormalizingFetch(params.fetch);

	return createOpenAICompatible({
		name: params.provider.name,
		apiKey: params.provider.apiKey,
		baseURL: normalizeOpenAICompatibleBaseUrl(params.provider.baseUrl),
		includeUsage: params.includeUsage,
		supportsStructuredOutputs: params.supportsStructuredOutputs,
		transformRequestBody: (body) => {
			const transformed = transformNormalChatModelRunRequestBody(
				body,
				params.provider,
			);
			return params.transformRequestBody
				? params.transformRequestBody(transformed)
				: transformed;
		},
		fetch: requestFetch,
	});
}
