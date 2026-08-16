// The applied-reasoning-depth diagnostics tree produced by the chat-turn
// depth pipeline (depth-metadata.ts, depth-selection.ts,
// depth-clarification.ts, reasoning-depth-effort.ts) and projected onto a
// persisted/streamed message for display. Consumed type-only by client
// code (streaming.ts, ResponseAuditDetails.svelte) — relocated out of the
// former src/lib/types.ts god-module (architecture-deepening T1); this
// file carries no behavior change, only a new home. The small
// ReasoningDepth/ThinkingMode core those client sites also need as a
// runtime value lives separately at src/lib/reasoning-depth-types.ts.

import type { ReasoningDepth, ThinkingMode } from "$lib/reasoning-depth-types";
import type { UiLanguage } from "$lib/server/services/auth-types";

export type DepthAppliedProfile = "off" | "standard" | "extended" | "maximum";
export type DepthGroundingNeed = "none" | "possible" | "useful" | "required";
export type DepthContextBreadth = "narrow" | "normal" | "broad";
export type DepthOutputRoom = "concise" | "normal" | "expanded";
export type DepthToolUse = "none" | "normal" | "source_heavy";
export type DepthOutcome =
	| "normal_response"
	| "clarification_requested"
	| "proceeded_with_assumption";
export type DepthClarificationOutcome = "ask" | "proceed_with_assumption";
export type DepthClarificationReason =
	| "multiple_plausible_targets"
	| "user_requested_assumption"
	| "classifier";

export interface DepthSelectionSignals {
	groundingNeed?: DepthGroundingNeed;
	contextBreadth?: DepthContextBreadth;
	outputRoom?: DepthOutputRoom;
	toolUse?: DepthToolUse;
}

export interface DepthAppliedEffortMetadata {
	dimensions: string[];
	providerReasoning?: {
		thinkingMode: ThinkingMode;
		reasoningEffort?: string;
		supported: boolean;
		constrained: boolean;
	};
	outputTokens?: {
		configuredMaxTokens: number | null;
		targetMaxTokens: number | null;
		effectiveMaxTokens?: number | null;
		outputReserve?: number;
		clamped: boolean;
	};
	context?: {
		maxModelContext: number;
		configuredTargetConstructedContext: number;
		targetConstructedContext: number;
		clamped: boolean;
	};
	tools?: {
		maxToolSteps: number;
		maxWebSources: number;
		sourceExpansion: boolean;
	};
	grounding?: {
		guidance: "minimal" | "standard" | "careful" | "strict";
		externalEvidence: "none" | "useful" | "required";
		forceWebSearch: boolean;
	};
	constraints?: string[];
	clamps?: string[];
}

export interface DepthSelectionTimingMetadata {
	totalMs: number;
	recentMessagesMs?: number;
	classificationContextMs?: number;
	classifierModelResolutionMs?: number;
	controlModelClassifierMs?: number;
	classifierAttempts: number;
	classifierSource: string;
	appliedProfile: DepthAppliedProfile;
	fallbackReason?: string;
}

export interface DepthMetadata {
	requested: ReasoningDepth;
	appliedProfile: DepthAppliedProfile;
	fallback: boolean;
	fallbackReason?: string;
	constraintNote?: string;
	classifierSource?: string;
	classifierModelSource?: string;
	classifierModelId?: string;
	classifierModelDisplayName?: string;
	classifierModelFallbackReason?: string;
	configuredClassifierModelId?: string;
	modelId?: string;
	modelDisplayName?: string;
	providerDisplayName?: string;
	signals?: DepthSelectionSignals;
	timing?: DepthSelectionTimingMetadata;
	appliedEffort?: DepthAppliedEffortMetadata;
	outcome?: DepthOutcome;
	clarification?: {
		outcome: DepthClarificationOutcome;
		reason: DepthClarificationReason;
		language: UiLanguage;
		classifierSource?: string;
		question?: string;
		assumption?: string;
	};
}
