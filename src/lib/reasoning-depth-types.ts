// Reasoning-depth core: the user-facing `ReasoningDepth` dial ("off" |
// "auto" | "max") and the provider-facing `ThinkingMode` it maps to/from.
// Client- and server-shared — relocated out of the former
// src/lib/types.ts god-module (architecture-deepening T1); this file
// carries no behavior change, only a new home. The larger applied-depth
// diagnostics tree (DepthMetadata and friends) lives next to the chat-turn
// depth pipeline that produces it — see
// src/lib/server/services/chat-turn/depth-metadata-types.ts.

export type ReasoningDepth = "off" | "auto" | "max";
export type ThinkingMode = "auto" | "on" | "off";

export function isReasoningDepth(value: unknown): value is ReasoningDepth {
	return value === "off" || value === "auto" || value === "max";
}

export function reasoningDepthToThinkingMode(
	reasoningDepth: ReasoningDepth | undefined,
): ThinkingMode {
	switch (reasoningDepth) {
		case "off":
			return "off";
		case "max":
			return "on";
		default:
			return "auto";
	}
}

export function thinkingModeToReasoningDepth(
	thinkingMode: ThinkingMode | undefined,
): ReasoningDepth {
	switch (thinkingMode) {
		case "off":
			return "off";
		case "on":
			return "max";
		default:
			return "auto";
	}
}
