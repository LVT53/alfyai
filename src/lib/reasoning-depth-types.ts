// Reasoning-depth core: the user-facing `ReasoningDepth` toggle ("thorough" |
// "quick") and the provider-facing `ThinkingMode` it maps to/from.
// Client- and server-shared — relocated out of the former
// src/lib/types.ts god-module (architecture-deepening T1); this file
// carries no behavior change, only a new home. The larger applied-depth
// diagnostics tree (DepthMetadata and friends) lives next to the chat-turn
// depth pipeline that produces it — see
// src/lib/server/services/chat-turn/depth-metadata-types.ts.
//
// ADR-0061 replaced the former three-value "off" | "auto" | "max" ladder
// (resolved through a keyword classifier into off/standard/extended/maximum
// applied profiles) with this single on/off thinking toggle. `thorough`
// (thinking on) is the default; `quick` only turns model reasoning off, it
// does not cut tool or web-source budgets. `parseReasoningDepth` still
// accepts the legacy wire values and the legacy `thinkingMode` field so old
// clients and previously persisted metadata keep parsing correctly.

export type ReasoningDepth = "thorough" | "quick";
export type ThinkingMode = "auto" | "on" | "off";

export function isReasoningDepth(value: unknown): value is ReasoningDepth {
	return value === "thorough" || value === "quick";
}

export function reasoningDepthToThinkingMode(
	reasoningDepth: ReasoningDepth | undefined,
): ThinkingMode {
	return reasoningDepth === "quick" ? "off" : "on";
}

export function thinkingModeToReasoningDepth(
	thinkingMode: ThinkingMode | undefined,
): ReasoningDepth {
	return thinkingMode === "off" ? "quick" : "thorough";
}

/**
 * Parses a `reasoningDepth` value coming off the wire (a request body, a
 * settings-store localStorage read, or persisted message metadata). Accepts
 * the current toggle values as-is, falls back to the legacy ladder values
 * ("off" -> quick, "auto" | "max" -> thorough), and — failing that — falls
 * back further to the legacy `thinkingMode` field.
 */
export function parseReasoningDepth(
	value: unknown,
	legacyThinkingMode?: unknown,
): ReasoningDepth {
	if (isReasoningDepth(value)) return value;
	if (value === "off") return "quick";
	if (value === "auto" || value === "max") return "thorough";
	return thinkingModeToReasoningDepth(
		parseLegacyThinkingMode(legacyThinkingMode),
	);
}

function parseLegacyThinkingMode(value: unknown): ThinkingMode {
	return value === "on" || value === "off" || value === "auto" ? value : "auto";
}
