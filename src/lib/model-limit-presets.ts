export interface ModelLimitPreset {
	maxModelContext: number;
	maxMessageLength: number;
}

const APPROX_CHARS_PER_CONTEXT_TOKEN = 4;

export function deriveMaxMessageLengthFromContextTokens(tokens: number): number {
	return Math.max(1, Math.floor(tokens * APPROX_CHARS_PER_CONTEXT_TOKEN));
}

const FIREWORKS_LIMIT_PRESETS: Array<{
	match: readonly string[];
	limits: ModelLimitPreset;
}> = [
	{
		match: ["kimi-k2p6-turbo", "kimi-k2.6-turbo", "kimi-k2p6", "kimi-k2.6"],
		limits: {
			maxModelContext: 262_144,
			maxMessageLength: deriveMaxMessageLengthFromContextTokens(262_144),
		},
	},
	{
		match: ["deepseek-v4", "deepseek-v4-pro", "deepseek-v4-flash"],
		limits: {
			maxModelContext: 1_048_576,
			maxMessageLength: deriveMaxMessageLengthFromContextTokens(1_048_576),
		},
	},
	{
		match: ["minimax-m2p7", "minimax-m2.7"],
		limits: {
			maxModelContext: 196_608,
			maxMessageLength: deriveMaxMessageLengthFromContextTokens(196_608),
		},
	},
];

export function getKnownModelLimitPreset(
	modelName: string | null | undefined,
): ModelLimitPreset | null {
	const normalized = modelName?.trim().toLowerCase();
	if (!normalized) return null;

	for (const preset of FIREWORKS_LIMIT_PRESETS) {
		if (preset.match.some((marker) => normalized.includes(marker))) {
			return preset.limits;
		}
	}

	return null;
}
