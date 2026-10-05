import {
	type NormalChatModelRunCompatibilityProvider,
	resolveOpenAICompatibleProviderAdapterProfile,
} from "./provider-compatibility";

/**
 * The sampling of one model request: the call options an AI SDK `generateText`
 * / `streamText` is given.
 */
export type ModelCallSampling = {
	temperature: number | undefined;
	topP: number | undefined;
};

export type ModelCallSamplingOptions = {
	/**
	 * The temperature of an answer only a MACHINE reads (a JSON classification,
	 * a digest the model itself re-reads): it wins over the family's, and the
	 * family's top_p/top_k still go along. Never set for an answer a person
	 * reads: those take the whole family profile, temperature included.
	 */
	machineReadTemperature?: number;
	/**
	 * What a family WITHOUT a sampling profile has always sent on this path
	 * (omit to send nothing, as the chat turn does). The family's own profile
	 * wins whenever it has one.
	 */
	profilelessTemperature?: number;
};

/**
 * The ONE way a model call gets its sampling, the chat turn's own run and every
 * internal call (thought-step status lines, rail summary, titles, summaries,
 * the memory judge, Apps, `@Alfy` replies, ...) alike. The values are the
 * provider family's `defaultSampling` (provider-compatibility.ts), declared
 * once: a Qwen checkpoint ships generation_config temperature 1.0, at which
 * short snippets a person reads come out garbled.
 *
 * `top_k` is deliberately not here: the AI SDK's openai-compatible provider has
 * no call option for it, so `createOpenAICompatibleProviderForNormalChatModelRun`
 * injects it into the request body from the same profile (`transformRequestBody`)
 * for every request built through it. Never write a number for any of the three
 * outside the family adapter.
 */
export function resolveModelCallSampling(
	provider: NormalChatModelRunCompatibilityProvider,
	options: ModelCallSamplingOptions = {},
): ModelCallSampling {
	const profile =
		resolveOpenAICompatibleProviderAdapterProfile(provider).defaultSampling;
	return {
		temperature:
			options.machineReadTemperature ??
			profile?.temperature ??
			options.profilelessTemperature,
		topP: profile?.topP,
	};
}
