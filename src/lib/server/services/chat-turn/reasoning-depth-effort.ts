import { isModelCapabilityUnsupported } from "$lib/model-capabilities";
import type { ThinkingMode } from "$lib/reasoning-depth-types";
import type {
	DepthAppliedProfile,
	DepthMetadata,
	DepthSelectionSignals,
} from "$lib/server/services/chat-turn/depth-metadata-types";
import {
	buildNormalChatModelRunProviderOptions,
	type NormalChatModelRunProvider,
} from "$lib/server/services/normal-chat-model";

type ReasoningEffort = NonNullable<
	NormalChatModelRunProvider["reasoningEffort"]
>;

export type ReasoningDepthExternalEvidence = "none" | "useful" | "required";
export type ReasoningDepthGroundingGuidance =
	| "minimal"
	| "standard"
	| "careful"
	| "strict";

export type ReasoningDepthProviderReasoning = {
	thinkingMode: ThinkingMode;
	reasoningEffort?: ReasoningEffort;
	constrained: boolean;
	supported: boolean;
};

export type ReasoningDepthWebSourceBudget = {
	maxSources: number;
	sourceExpansion: boolean;
};

// A depth profile controls exactly two things: how hard the provider reasons
// (thinking mode / reasoning effort) and how much tool work the turn may do
// (tool steps + web-source budget, plus the grounding guidance that shapes
// it). It deliberately does NOT touch the constructed-context target or the
// output-token reserve — those are fixed per model (resolvePromptContextLimits
// / modelConfig.maxTokens, subject only to the hard clamps in
// normal-chat-context.ts and context-budget.ts) and identical across all four
// profiles.
export type ReasoningDepthEffort = {
	depthMetadata: DepthMetadata;
	providerReasoning: ReasoningDepthProviderReasoning;
	maxToolSteps: number;
	webSourceBudget: ReasoningDepthWebSourceBudget;
	grounding: {
		guidance: ReasoningDepthGroundingGuidance;
		externalEvidence: ReasoningDepthExternalEvidence;
		forceWebSearch: boolean;
	};
	constraints: string[];
	clamps: string[];
};

const REASONING_EFFORT_ORDER: ReasoningEffort[] = [
	"low",
	"medium",
	"high",
	"max",
	"xhigh",
];

// ADR-0061: "quick" (applied profile "off") only turns model reasoning off —
// it must not cut tool or web-source budgets, so its numbers match
// "standard" (the profile "thorough" applies) exactly. "extended" and
// "maximum" are unreachable from the current toggle (no request maps to
// them any more) but stay defined since DepthAppliedProfile and old
// persisted messages still reference them.
const PROFILE_TOOL_STEPS: Record<DepthAppliedProfile, number> = {
	off: 14,
	standard: 14,
	extended: 18,
	maximum: 24,
};

const BASE_WEB_SOURCE_BUDGET: Record<DepthAppliedProfile, number> = {
	off: 6,
	standard: 6,
	extended: 6,
	maximum: 6,
};

export function resolveReasoningDepthEffort(params: {
	depthMetadata: DepthMetadata;
	provider: NormalChatModelRunProvider;
	forceWebSearch?: boolean;
}): ReasoningDepthEffort {
	const profile = params.depthMetadata.appliedProfile;
	const signals = params.depthMetadata.signals ?? {};
	const constraints: string[] = [];
	const clamps: string[] = [];
	const externalEvidence = resolveExternalEvidence({
		signals,
		forceWebSearch: params.forceWebSearch === true,
	});
	const groundingGuidance = resolveGroundingGuidance(profile, externalEvidence);
	const sourceExpansion =
		(profile === "extended" || profile === "maximum") &&
		externalEvidence !== "none";
	const webSourceBudget = resolveWebSourceBudget(profile, sourceExpansion);
	const maxToolSteps = PROFILE_TOOL_STEPS[profile] + (sourceExpansion ? 4 : 0);
	const providerReasoning = resolveProviderReasoning({
		profile,
		provider: params.provider,
		constraints,
	});
	const dimensions = [
		"provider_reasoning",
		"grounding_guidance",
		"tool_steps",
		"source_budget",
	];

	return {
		depthMetadata: {
			...params.depthMetadata,
			appliedEffort: {
				dimensions,
				providerReasoning,
				tools: {
					maxToolSteps,
					maxWebSources: webSourceBudget.maxSources,
					sourceExpansion: webSourceBudget.sourceExpansion,
				},
				grounding: {
					guidance: groundingGuidance,
					externalEvidence,
					forceWebSearch: params.forceWebSearch === true,
				},
				...(constraints.length > 0 ? { constraints } : {}),
				...(clamps.length > 0 ? { clamps } : {}),
			},
		},
		providerReasoning,
		maxToolSteps,
		webSourceBudget,
		grounding: {
			guidance: groundingGuidance,
			externalEvidence,
			forceWebSearch: params.forceWebSearch === true,
		},
		constraints,
		clamps,
	};
}

export function buildReasoningDepthProviderOptions(
	provider: NormalChatModelRunProvider,
	effort: ReasoningDepthEffort,
): ReturnType<typeof buildNormalChatModelRunProviderOptions> {
	const effectiveProvider = {
		...provider,
		...(effort.providerReasoning.reasoningEffort
			? { reasoningEffort: effort.providerReasoning.reasoningEffort }
			: {}),
	};
	return buildNormalChatModelRunProviderOptions(
		effectiveProvider,
		effort.providerReasoning.thinkingMode,
	);
}

function resolveExternalEvidence(params: {
	signals: DepthSelectionSignals;
	forceWebSearch: boolean;
}): ReasoningDepthExternalEvidence {
	if (params.forceWebSearch) return "required";
	if (params.signals.groundingNeed === "required") return "required";
	if (
		params.signals.groundingNeed === "useful" ||
		params.signals.toolUse === "source_heavy"
	) {
		return "useful";
	}
	return "none";
}

function resolveGroundingGuidance(
	profile: DepthAppliedProfile,
	externalEvidence: ReasoningDepthExternalEvidence,
): ReasoningDepthGroundingGuidance {
	if (profile === "off") return "minimal";
	if (profile === "maximum" && externalEvidence === "required") {
		return "strict";
	}
	if (
		profile === "maximum" ||
		(profile === "extended" && externalEvidence !== "none")
	) {
		return "careful";
	}
	return "standard";
}

function resolveWebSourceBudget(
	profile: DepthAppliedProfile,
	sourceExpansion: boolean,
): ReasoningDepthWebSourceBudget {
	if (sourceExpansion && profile === "maximum") {
		return { maxSources: 12, sourceExpansion: true };
	}
	if (sourceExpansion && profile === "extended") {
		return { maxSources: 8, sourceExpansion: true };
	}
	return {
		maxSources: BASE_WEB_SOURCE_BUDGET[profile],
		sourceExpansion: false,
	};
}

function resolveProviderReasoning(params: {
	profile: DepthAppliedProfile;
	provider: NormalChatModelRunProvider;
	constraints: string[];
}): ReasoningDepthProviderReasoning {
	const supported = !isModelCapabilityUnsupported(
		params.provider.capabilities,
		"reasoningControls",
	);
	const thinkingMode = profileThinkingMode(params.profile);
	if (!supported) {
		params.constraints.push("provider_reasoning_controls_unsupported");
		return {
			thinkingMode,
			supported: false,
			constrained: true,
		};
	}
	if (params.profile === "off") {
		return {
			thinkingMode: "off",
			supported: true,
			constrained: false,
		};
	}

	const configured = params.provider.reasoningEffort;
	if (!configured) {
		return {
			thinkingMode,
			supported: true,
			constrained: false,
		};
	}

	const requested = requestedReasoningEffort(params.profile, configured);
	const configuredRank = reasoningEffortRank(configured);
	const requestedRank = reasoningEffortRank(requested);
	const profileMinimumRank =
		params.profile === "maximum" ? reasoningEffortRank("high") : requestedRank;
	if (requestedRank > configuredRank || profileMinimumRank > configuredRank) {
		params.constraints.push(
			`provider_reasoning_clamped_to_configured_${configured}`,
		);
		return {
			thinkingMode,
			reasoningEffort: configured,
			supported: true,
			constrained: true,
		};
	}

	return {
		thinkingMode,
		reasoningEffort: requested,
		supported: true,
		constrained: false,
	};
}

function profileThinkingMode(profile: DepthAppliedProfile): ThinkingMode {
	if (profile === "off") return "off";
	if (profile === "extended" || profile === "maximum") return "on";
	return "auto";
}

function requestedReasoningEffort(
	profile: DepthAppliedProfile,
	configured: ReasoningEffort,
): ReasoningEffort {
	if (profile === "standard") return "low";
	if (profile === "extended") return "medium";
	if (profile === "maximum") return configured;
	return "low";
}

function reasoningEffortRank(effort: ReasoningEffort): number {
	return Math.max(0, REASONING_EFFORT_ORDER.indexOf(effort));
}
