import { isModelCapabilityUnsupported } from "$lib/model-capabilities";
import type { PromptContextLimits } from "$lib/server/services/normal-chat-context";
import {
	buildNormalChatModelRunProviderOptions,
	type NormalChatModelRunProvider,
} from "$lib/server/services/normal-chat-model";
import type {
	DepthAppliedEffortMetadata,
	DepthAppliedProfile,
	DepthMetadata,
	DepthSelectionSignals,
	ThinkingMode,
} from "$lib/types";

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

export type ReasoningDepthEffort = {
	depthMetadata: DepthMetadata;
	contextLimits: PromptContextLimits;
	modelMaxOutputTokens: number | null;
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

const PROFILE_OUTPUT_RATIO: Record<DepthAppliedProfile, number> = {
	off: 0.45,
	standard: 0.7,
	extended: 0.9,
	maximum: 1,
};

const PROFILE_CONTEXT_RATIO: Record<DepthAppliedProfile, number> = {
	off: 0.55,
	standard: 0.7,
	extended: 0.9,
	maximum: 1,
};

const PROFILE_TOOL_STEPS: Record<DepthAppliedProfile, number> = {
	off: 8,
	standard: 14,
	extended: 18,
	maximum: 24,
};

const BASE_WEB_SOURCE_BUDGET: Record<DepthAppliedProfile, number> = {
	off: 4,
	standard: 6,
	extended: 6,
	maximum: 6,
};

export function resolveReasoningDepthEffort(params: {
	depthMetadata: DepthMetadata;
	provider: NormalChatModelRunProvider;
	baseContextLimits: PromptContextLimits;
	configuredMaxOutputTokens?: number | null;
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
	const modelMaxOutputTokens = resolveModelMaxOutputTokens({
		profile,
		signals,
		configuredMaxOutputTokens: params.configuredMaxOutputTokens,
	});
	const contextLimits = resolveContextLimits({
		profile,
		signals,
		baseContextLimits: params.baseContextLimits,
	});
	const providerReasoning = resolveProviderReasoning({
		profile,
		provider: params.provider,
		constraints,
	});
	const dimensions = [
		"provider_reasoning",
		"output_room",
		"context_room",
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
				outputTokens: {
					configuredMaxTokens: normalizeConfiguredMaxTokens(
						params.configuredMaxOutputTokens,
					),
					targetMaxTokens: modelMaxOutputTokens,
					clamped: false,
				},
				context: {
					maxModelContext: params.baseContextLimits.maxModelContext,
					configuredTargetConstructedContext:
						params.baseContextLimits.targetConstructedContext,
					targetConstructedContext: contextLimits.targetConstructedContext,
					clamped:
						contextLimits.targetConstructedContext !==
						params.baseContextLimits.targetConstructedContext,
				},
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
		contextLimits,
		modelMaxOutputTokens,
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
	effort: Pick<ReasoningDepthEffort, "providerReasoning">,
): Record<string, Record<string, unknown>> | undefined {
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

export function withReasoningDepthPreparedBudget(
	effort: ReasoningDepthEffort,
	outputTokenBudget?: {
		effectiveMaxTokens: number | null;
		outputReserve: number;
		outputReserveClamped: boolean;
	},
): DepthMetadata {
	const appliedEffort = effort.depthMetadata.appliedEffort;
	if (!appliedEffort?.outputTokens || !outputTokenBudget) {
		return effort.depthMetadata;
	}
	const clamps = mergeUnique(
		appliedEffort.clamps,
		outputTokenBudget.outputReserveClamped
			? ["output_reserve_clamped_to_context"]
			: [],
	);
	const nextAppliedEffort: DepthAppliedEffortMetadata = {
		...appliedEffort,
		outputTokens: {
			...appliedEffort.outputTokens,
			effectiveMaxTokens: outputTokenBudget.effectiveMaxTokens,
			outputReserve: outputTokenBudget.outputReserve,
			clamped: outputTokenBudget.outputReserveClamped,
		},
		...(clamps.length > 0 ? { clamps } : {}),
	};
	return {
		...effort.depthMetadata,
		appliedEffort: nextAppliedEffort,
	};
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

function resolveModelMaxOutputTokens(params: {
	profile: DepthAppliedProfile;
	signals: DepthSelectionSignals;
	configuredMaxOutputTokens?: number | null;
}): number | null {
	const configured = normalizeConfiguredMaxTokens(
		params.configuredMaxOutputTokens,
	);
	if (configured === null) return null;
	const ratio = clampRatio(
		PROFILE_OUTPUT_RATIO[params.profile] +
			(params.signals.outputRoom === "expanded"
				? 0.1
				: params.signals.outputRoom === "concise"
					? -0.15
					: 0),
	);
	return Math.max(1, Math.min(configured, Math.floor(configured * ratio)));
}

function resolveContextLimits(params: {
	profile: DepthAppliedProfile;
	signals: DepthSelectionSignals;
	baseContextLimits: PromptContextLimits;
}): PromptContextLimits {
	const ratio = clampRatio(
		PROFILE_CONTEXT_RATIO[params.profile] +
			(params.signals.contextBreadth === "broad"
				? 0.1
				: params.signals.contextBreadth === "narrow"
					? -0.15
					: 0),
	);
	const targetConstructedContext = Math.max(
		1,
		Math.min(
			params.baseContextLimits.targetConstructedContext,
			Math.floor(params.baseContextLimits.targetConstructedContext * ratio),
		),
	);
	return {
		...params.baseContextLimits,
		targetConstructedContext,
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

function normalizeConfiguredMaxTokens(value: number | null | undefined) {
	return typeof value === "number" && Number.isFinite(value) && value >= 1
		? Math.floor(value)
		: null;
}

function clampRatio(value: number): number {
	return Math.max(0.1, Math.min(1, value));
}

function mergeUnique(
	existing: string[] | undefined,
	additions: string[],
): string[] {
	return Array.from(new Set([...(existing ?? []), ...additions]));
}
