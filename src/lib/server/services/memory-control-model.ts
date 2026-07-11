import type { ModelId } from "$lib/types";
import { type MemoryModelFeature, recordMemoryModelUsage } from "./memory-cost";
import {
	parseJsonWithEnvelopeExtraction,
	reasoningAwareMaxTokens,
} from "./memory-judge/schema";
import type {
	JsonControlMessageUsage,
	JsonControlResponseSchema,
} from "./normal-chat-control-model";

/**
 * The single "strict-JSON control-model call" recipe shared by every memory
 * feature (judge, reconcile/merge, persona summary, re-curation). Before this
 * adapter each site independently wired: pick the control model + call
 * `sendJsonControlMessage`, force `thinkingMode: "off"` (ADR-0045 — measured
 * ~7x faster at equal quality, and structured extraction never needs
 * chain-of-thought), size the completion budget with `reasoningAwareMaxTokens`
 * (so a reasoning model's CoT — which counts against max_tokens on the
 * OpenAI-compatible providers these run on — cannot exhaust the budget and
 * truncate the JSON), and record a cache-aware per-feature cost row. That is
 * one interface with four call sites; this module owns all of it so a feature
 * only supplies its prompt, schema, feature tag, and item-count hint.
 */
export type MemoryControlModelResult = {
	/** Raw model text (post reasoning-fallback), for callers with bespoke parsing. */
	text: string;
	/**
	 * The envelope object extracted via `parseJsonWithEnvelopeExtraction(text,
	 * envelopeKey)` when `envelopeKey` was supplied, else `null`. Reasoning models
	 * may wrap the JSON in chain-of-thought prose, so extraction relaxes WHERE the
	 * envelope may sit, not its shape — callers still validate it.
	 */
	data: unknown | null;
	usage?: JsonControlMessageUsage;
	modelId: ModelId;
	modelDisplayName: string;
};

export type CallMemoryControlModelParams = {
	userId: string;
	/** Cost-attribution tag; the recorded cost row is grouped by this feature. */
	feature: MemoryModelFeature;
	systemPrompt: string;
	userMessage: string;
	/** The feature's configured control model; `undefined` resolves to model1. */
	modelId: ModelId | undefined;
	jsonSchema?: JsonControlResponseSchema;
	/**
	 * Item count the completion budget scales with (segment length, candidate
	 * count, fact count, batch size). Fed to `reasoningAwareMaxTokens`.
	 */
	inputSizeHint: number;
	/**
	 * When set, `result.data` is the balanced JSON object containing this
	 * top-level key, recovered from any surrounding reasoning prose.
	 */
	envelopeKey?: string;
	/** Defaults to 0 (deterministic structured extraction). */
	temperature?: number;
	signal?: AbortSignal;
	fetch?: typeof fetch;
};

/**
 * Make one structured control-model call for a memory feature and record its
 * cost. Preserves each caller's model choice, token-budget input, and cost
 * feature attribution exactly — behavior-preserving de-duplication only.
 */
export async function callMemoryControlModel(
	params: CallMemoryControlModelParams,
): Promise<MemoryControlModelResult> {
	// Lazy import so the AI-SDK control-model stack (and its heavy provider
	// deps) is only pulled in when a memory feature actually calls the model —
	// mirrors each former call site, and keeps the module mockable at the same
	// path the feature suites already mock.
	const { sendJsonControlMessage } = await import(
		"./normal-chat-control-model"
	);
	const res = await sendJsonControlMessage(params.userMessage, params.modelId, {
		systemPrompt: params.systemPrompt,
		temperature: params.temperature ?? 0,
		// Structured extraction, not reasoning: chain-of-thought is same-quality
		// and far cheaper/faster here (ADR-0045). Never turned on on any path.
		thinkingMode: "off",
		// Reasoning-aware budget so a reasoning model cannot spend the whole
		// completion cap on CoT and emit an empty/truncated JSON channel.
		maxTokens: reasoningAwareMaxTokens(params.inputSizeHint),
		jsonSchema: params.jsonSchema,
		allowReasoningFallback: true,
		signal: params.signal,
		fetch: params.fetch,
	});
	// Cache-aware per-feature cost row (best-effort inside recordMemoryModelUsage).
	// `?? "model1"` matches the resolution sendJsonControlMessage applies to the
	// same id, so the cost row names the model actually invoked.
	await recordMemoryModelUsage({
		userId: params.userId,
		feature: params.feature,
		modelId: params.modelId ?? "model1",
		usage: res.usage,
	});
	const data =
		params.envelopeKey !== undefined
			? parseJsonWithEnvelopeExtraction(res.text, params.envelopeKey)
			: null;
	return {
		text: res.text,
		data,
		usage: res.usage,
		modelId: res.modelId,
		modelDisplayName: res.modelDisplayName,
	};
}
