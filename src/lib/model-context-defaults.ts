export const DEFAULT_MAX_MODEL_CONTEXT_TOKENS = 262_144;
export const MIN_MODEL_CONTEXT_TOKENS = 1_000;
export const DEFAULT_TARGET_CONSTRUCTED_CONTEXT_RATIO = 0.9;
export const DEFAULT_COMPACTION_UI_THRESHOLD_RATIO = 0.8;

export type ModelContextLimitsInput = {
	maxModelContext: number | null | undefined;
	targetConstructedContext?: number | null;
	compactionUiThreshold?: number | null;
	fallbackMaxModelContext?: number;
};

export type ModelContextLimits = {
	maxModelContext: number;
	targetConstructedContext: number;
	compactionUiThreshold: number;
};

export function normalizeModelContextTokens(
	value: number | null | undefined,
	fallback = DEFAULT_MAX_MODEL_CONTEXT_TOKENS,
	minimum = MIN_MODEL_CONTEXT_TOKENS,
): number {
	const normalized =
		typeof value === "number" && Number.isFinite(value) && value >= 1
			? Math.floor(value)
			: Math.floor(fallback);
	return Math.max(minimum, normalized);
}

export function normalizeModelContextLimit(
	value: number | null | undefined,
	derivedValue: number,
	maxModelContext: number,
): number {
	const normalized =
		typeof value === "number" && Number.isFinite(value) && value >= 1
			? Math.floor(value)
			: derivedValue;
	return Math.max(1, Math.min(normalized, maxModelContext));
}

export function deriveDefaultCompactionUiThreshold(
	maxModelContext: number,
): number {
	return Math.max(
		1,
		Math.min(
			maxModelContext - 1,
			Math.floor(maxModelContext * DEFAULT_COMPACTION_UI_THRESHOLD_RATIO),
		),
	);
}

export function deriveDefaultTargetConstructedContext(
	maxModelContext: number,
): number {
	return Math.max(
		1,
		Math.min(
			maxModelContext - 1,
			Math.floor(maxModelContext * DEFAULT_TARGET_CONSTRUCTED_CONTEXT_RATIO),
		),
	);
}

export function deriveModelContextLimits(
	input: ModelContextLimitsInput,
): ModelContextLimits {
	const maxModelContext = normalizeModelContextTokens(
		input.maxModelContext,
		input.fallbackMaxModelContext ?? DEFAULT_MAX_MODEL_CONTEXT_TOKENS,
	);

	return {
		maxModelContext,
		targetConstructedContext: normalizeModelContextLimit(
			input.targetConstructedContext,
			deriveDefaultTargetConstructedContext(maxModelContext),
			maxModelContext,
		),
		compactionUiThreshold: normalizeModelContextLimit(
			input.compactionUiThreshold,
			deriveDefaultCompactionUiThreshold(maxModelContext),
			maxModelContext,
		),
	};
}
