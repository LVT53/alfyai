import type {
	DepthAppliedProfile,
	DepthMetadata,
	DepthOutcome,
	ReasoningDepth,
	UiLanguage,
} from "$lib/types";
import {
	type DepthClarificationClassifierDecision,
	evaluateDepthClarificationGate,
} from "./depth-clarification";

export type ReasoningDepthEvaluationDimension =
	| "wrongTargetAvoidance"
	| "unnecessaryQuestionRate"
	| "localizedWording"
	| "carryForward"
	| "metadataClassification"
	| "qualityVsCost"
	| "latencyClass"
	| "passCount"
	| "toolCallBudget"
	| "dynamicAddedUsefulDimensions"
	| "kimiLocalLiveAvailability";

export type ReasoningDepthEvaluationDimensionResult = {
	passed: boolean;
	reasons: string[];
	score?: number;
};

export type ReasoningDepthEvaluationResult = {
	fixtureId: string;
	accepted: boolean;
	dimensions: Record<
		ReasoningDepthEvaluationDimension,
		ReasoningDepthEvaluationDimensionResult
	>;
};

export type ReasoningDepthEvaluationReport = {
	accepted: boolean;
	fixtureResults: ReasoningDepthEvaluationResult[];
	summary: {
		unnecessaryQuestionRate: number;
		wrongTargetAvoidanceRate: number;
		localLiveEvaluationAvailable: boolean;
		localLiveEvaluationAttempted: boolean;
		kimiEvaluationAvailable: boolean;
		kimiEvaluationAttempted: boolean;
	};
};

export type ReasoningDepthEvaluationFixture =
	| ReasoningDepthClarificationEvaluationFixture
	| ReasoningDepthCarryForwardEvaluationFixture
	| ReasoningDepthMetadataClassificationEvaluationFixture
	| ReasoningDepthDynamicDeliberationEvaluationFixture;

export type ReasoningDepthEvaluationLiveAvailability = {
	apiAvailable: boolean;
	uiAvailable: boolean;
	attemptedModelIds?: string[];
	configuredModels?: ReasoningDepthEvaluationConfiguredModel[];
};

export type ReasoningDepthEvaluationConfiguredModel = {
	id: string;
	name?: string | null;
	displayName?: string | null;
};

export type ReasoningDepthClarificationEvaluationFixture = {
	id: string;
	title: string;
	kind: "depth_clarification";
	message: string;
	language: UiLanguage;
	depthMetadata: DepthMetadata;
	expectedAction: "ask" | "proceed" | "proceed_with_assumption";
	classifierDecision?: DepthClarificationClassifierDecision;
};

export type ReasoningDepthCarryForwardEvaluationFixture = {
	id: string;
	title: string;
	kind: "carry_forward";
	requestedDepth: ReasoningDepth;
	previousDepthMetadata: DepthMetadata;
	expectedAppliedProfile: DepthAppliedProfile;
};

export type ReasoningDepthMetadataClassificationEvaluationFixture = {
	id: string;
	title: string;
	kind: "metadata_classification";
	depthMetadata: DepthMetadata;
	expectedOutcome: DepthOutcome;
};

export type ReasoningDepthDynamicDeliberationEvaluationFixture = {
	id: string;
	title: string;
	kind: "dynamic_deliberation";
	standardPlan: ReasoningDepthEvaluatedDeliberationPlan;
	currentBaselinePlan: ReasoningDepthEvaluatedDeliberationPlan;
	dynamicPlan: ReasoningDepthEvaluatedDeliberationPlan;
	minimumQualityGain?: number;
	maximumCostMultiplier?: number;
};

export type ReasoningDepthEvaluatedDeliberationPlan = {
	label: string;
	quality: ReasoningDepthDeliberationQualitySignals;
	cost: ReasoningDepthDeliberationCostSignals;
	addedUsefulDimensions?: string[];
};

export type ReasoningDepthDeliberationQualitySignals = {
	grounding: number;
	contextAwareness: number;
	contradictionHandling: number;
	formatDiscipline: number;
	hungarianParity: number;
};

export type ReasoningDepthDeliberationCostSignals = {
	latencyClass: "low" | "medium" | "high" | "very_high";
	passCount: number;
	toolCallBudget: number;
};

export async function evaluateReasoningDepthFixtures(params: {
	fixtures: ReasoningDepthEvaluationFixture[];
	liveEvaluation?: ReasoningDepthEvaluationLiveAvailability;
}): Promise<ReasoningDepthEvaluationReport> {
	const fixtureResults: ReasoningDepthEvaluationResult[] = [];
	const localLiveEvaluationAvailable =
		params.liveEvaluation?.apiAvailable === true ||
		params.liveEvaluation?.uiAvailable === true;
	const localLiveEvaluationAttempted =
		(params.liveEvaluation?.attemptedModelIds ?? []).length > 0;
	const kimiEvaluationAvailable = hasKimiConfiguredModel(
		params.liveEvaluation?.configuredModels ?? [],
	);
	const kimiEvaluationAttempted =
		kimiEvaluationAvailable &&
		localLiveEvaluationAvailable &&
		(params.liveEvaluation?.attemptedModelIds ?? []).some(isKimiModelName);
	let expectedAskCount = 0;
	let avoidedWrongTargetCount = 0;
	let expectedProceedCount = 0;
	let unnecessaryQuestionCount = 0;

	for (const fixture of params.fixtures) {
		const result = await evaluateFixture(fixture, {
			kimiEvaluationAvailable,
			kimiEvaluationAttempted,
		});
		fixtureResults.push(result);
		if (fixture.kind === "depth_clarification") {
			if (fixture.expectedAction === "ask") {
				expectedAskCount += 1;
				if (result.dimensions.wrongTargetAvoidance.passed) {
					avoidedWrongTargetCount += 1;
				}
			} else {
				expectedProceedCount += 1;
				if (!result.dimensions.unnecessaryQuestionRate.passed) {
					unnecessaryQuestionCount += 1;
				}
			}
		}
	}

	return {
		accepted: fixtureResults.every((result) => result.accepted),
		fixtureResults,
		summary: {
			unnecessaryQuestionRate:
				expectedProceedCount === 0
					? 0
					: unnecessaryQuestionCount / expectedProceedCount,
			wrongTargetAvoidanceRate:
				expectedAskCount === 0 ? 0 : avoidedWrongTargetCount / expectedAskCount,
			localLiveEvaluationAvailable,
			localLiveEvaluationAttempted,
			kimiEvaluationAvailable,
			kimiEvaluationAttempted,
		},
	};
}

async function evaluateFixture(
	fixture: ReasoningDepthEvaluationFixture,
	availability: {
		kimiEvaluationAvailable: boolean;
		kimiEvaluationAttempted: boolean;
	},
): Promise<ReasoningDepthEvaluationResult> {
	const dimensions = emptyDimensions();
	if (fixture.kind === "depth_clarification") {
		await evaluateClarificationFixture(fixture, dimensions);
	}
	if (fixture.kind === "carry_forward") {
		evaluateCarryForwardFixture(fixture, dimensions);
	}
	if (fixture.kind === "metadata_classification") {
		evaluateMetadataClassificationFixture(fixture, dimensions);
	}
	if (fixture.kind === "dynamic_deliberation") {
		evaluateDynamicDeliberationFixture(fixture, dimensions);
	}
	dimensions.kimiLocalLiveAvailability = evaluateKimiAvailability(availability);
	return {
		fixtureId: fixture.id,
		accepted: Object.values(dimensions).every((dimension) => dimension.passed),
		dimensions,
	};
}

async function evaluateClarificationFixture(
	fixture: ReasoningDepthClarificationEvaluationFixture,
	dimensions: Record<
		ReasoningDepthEvaluationDimension,
		ReasoningDepthEvaluationDimensionResult
	>,
): Promise<void> {
	const result = await evaluateDepthClarificationGate({
		message: fixture.message,
		depthMetadata: fixture.depthMetadata,
		language: fixture.language,
		classifier: async () =>
			fixture.classifierDecision ??
			defaultClassifierDecisionForEvaluation(fixture),
	});
	const observedAction =
		result.action === "bypass"
			? "proceed"
			: result.depthMetadata.clarification?.outcome ===
					"proceed_with_assumption"
				? "proceed_with_assumption"
				: result.action;

	if (fixture.expectedAction === "ask") {
		dimensions.wrongTargetAvoidance = passIf(observedAction === "ask", [
			`Expected ask but observed ${observedAction}.`,
		]);
	}
	if (fixture.expectedAction !== "ask") {
		dimensions.unnecessaryQuestionRate = passIf(observedAction !== "ask", [
			`Expected ${fixture.expectedAction} without an unnecessary question.`,
		]);
	}
	if (fixture.language === "hu") {
		const text =
			result.action === "ask" ? result.text : (result.assumptionPrefix ?? "");
		dimensions.localizedWording = passIf(
			containsHungarianSignal(text) && !/\bI can do that\b/i.test(text),
			["Expected localized Hungarian wording."],
		);
	}
	if (fixture.expectedAction === "proceed_with_assumption") {
		dimensions.metadataClassification = passIf(
			result.depthMetadata.outcome === "proceeded_with_assumption" &&
				result.depthMetadata.clarification?.outcome ===
					"proceed_with_assumption",
			["Expected proceed-with-assumption depth metadata."],
		);
	}
}

function evaluateCarryForwardFixture(
	fixture: ReasoningDepthCarryForwardEvaluationFixture,
	dimensions: Record<
		ReasoningDepthEvaluationDimension,
		ReasoningDepthEvaluationDimensionResult
	>,
): void {
	const carried = recognizeCarryForwardMetadata({
		requestedDepth: fixture.requestedDepth,
		previousDepthMetadata: fixture.previousDepthMetadata,
	});
	dimensions.carryForward = passIf(
		carried?.appliedProfile === fixture.expectedAppliedProfile,
		[
			`Expected carry-forward profile ${fixture.expectedAppliedProfile} but observed ${carried?.appliedProfile ?? "none"}.`,
		],
	);
}

function evaluateMetadataClassificationFixture(
	fixture: ReasoningDepthMetadataClassificationEvaluationFixture,
	dimensions: Record<
		ReasoningDepthEvaluationDimension,
		ReasoningDepthEvaluationDimensionResult
	>,
): void {
	const dimensionsList = fixture.depthMetadata.appliedEffort?.dimensions ?? [];
	dimensions.metadataClassification = passIf(
		fixture.depthMetadata.outcome === fixture.expectedOutcome &&
			!dimensionsList.includes("deliberation_passes"),
		[
			"Expected clarification metadata to stay distinct from completed high-cost deliberation.",
		],
	);
}

function evaluateDynamicDeliberationFixture(
	fixture: ReasoningDepthDynamicDeliberationEvaluationFixture,
	dimensions: Record<
		ReasoningDepthEvaluationDimension,
		ReasoningDepthEvaluationDimensionResult
	>,
): void {
	const minimumQualityGain = fixture.minimumQualityGain ?? 0.08;
	const maximumCostMultiplier = fixture.maximumCostMultiplier ?? 1.5;
	const standardQuality = qualityScore(fixture.standardPlan.quality);
	const baselineQuality = qualityScore(fixture.currentBaselinePlan.quality);
	const dynamicQuality = qualityScore(fixture.dynamicPlan.quality);
	const qualityGain = dynamicQuality - baselineQuality;
	const qualityGainOverStandard = dynamicQuality - standardQuality;
	const baselineCost = costScore(fixture.currentBaselinePlan.cost);
	const dynamicCost = costScore(fixture.dynamicPlan.cost);
	const costMultiplier =
		baselineCost <= 0 ? Number.POSITIVE_INFINITY : dynamicCost / baselineCost;

	dimensions.qualityVsCost = {
		passed:
			qualityGain >= minimumQualityGain &&
			costMultiplier <= maximumCostMultiplier,
		score: roundScore(qualityGain / Math.max(costMultiplier, 0.01)),
		reasons:
			qualityGain >= minimumQualityGain &&
			costMultiplier <= maximumCostMultiplier
				? [
						`Quality gain ${roundScore(qualityGain)} over baseline and ${roundScore(qualityGainOverStandard)} over standard clears threshold ${minimumQualityGain}; cost multiplier ${roundScore(costMultiplier)} stays within ${maximumCostMultiplier}.`,
					]
				: [
						`Quality gain ${roundScore(qualityGain)} over baseline, ${roundScore(qualityGainOverStandard)} over standard, or cost multiplier ${roundScore(costMultiplier)} missed thresholds.`,
					],
	};
	dimensions.latencyClass = passIf(
		latencyRank(fixture.dynamicPlan.cost.latencyClass) <=
			latencyRank(fixture.currentBaselinePlan.cost.latencyClass) + 1,
		[
			`Dynamic latency ${fixture.dynamicPlan.cost.latencyClass} is too high relative to baseline ${fixture.currentBaselinePlan.cost.latencyClass}.`,
		],
	);
	dimensions.passCount = passIf(fixture.dynamicPlan.cost.passCount <= 4, [
		`Dynamic pass count ${fixture.dynamicPlan.cost.passCount} exceeds the bounded maximum of 4.`,
	]);
	dimensions.toolCallBudget = passIf(
		fixture.dynamicPlan.cost.toolCallBudget <=
			fixture.currentBaselinePlan.cost.toolCallBudget * maximumCostMultiplier,
		[
			`Dynamic tool-call budget ${fixture.dynamicPlan.cost.toolCallBudget} exceeds the allowed cost multiplier.`,
		],
	);
	dimensions.dynamicAddedUsefulDimensions = passIf(
		(fixture.dynamicPlan.addedUsefulDimensions ?? []).length > 0,
		[
			"Expected dynamic planning to add at least one useful deliberation dimension.",
		],
	);
}

function evaluateKimiAvailability(params: {
	kimiEvaluationAvailable: boolean;
	kimiEvaluationAttempted: boolean;
}): ReasoningDepthEvaluationDimensionResult {
	if (!params.kimiEvaluationAvailable) {
		return {
			passed: true,
			reasons: ["No configured KIMI or Moonshot model was detected."],
		};
	}
	return passIf(params.kimiEvaluationAttempted, [
		"Configured KIMI or Moonshot model was detected, but no local live evaluation attempt was reported.",
	]);
}

function recognizeCarryForwardMetadata(params: {
	requestedDepth: ReasoningDepth;
	previousDepthMetadata: DepthMetadata;
}): DepthMetadata | null {
	if (
		params.previousDepthMetadata.clarification?.outcome !== "ask" ||
		params.previousDepthMetadata.requested !== params.requestedDepth ||
		!(
			params.previousDepthMetadata.appliedProfile === "extended" ||
			params.previousDepthMetadata.appliedProfile === "maximum"
		)
	) {
		return null;
	}
	return {
		requested: params.requestedDepth,
		appliedProfile: params.previousDepthMetadata.appliedProfile,
		fallback: params.previousDepthMetadata.fallback,
		...(params.previousDepthMetadata.signals
			? { signals: { ...params.previousDepthMetadata.signals } }
			: {}),
	};
}

function qualityScore(
	signals: ReasoningDepthDeliberationQualitySignals,
): number {
	return average([
		signals.grounding,
		signals.contextAwareness,
		signals.contradictionHandling,
		signals.formatDiscipline,
		signals.hungarianParity,
	]);
}

function costScore(signals: ReasoningDepthDeliberationCostSignals): number {
	return (
		latencyRank(signals.latencyClass) +
		signals.passCount * 0.5 +
		signals.toolCallBudget / 14
	);
}

function latencyRank(
	value: ReasoningDepthDeliberationCostSignals["latencyClass"],
) {
	if (value === "low") return 1;
	if (value === "medium") return 2;
	if (value === "high") return 3;
	return 4;
}

function average(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundScore(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}

function hasKimiConfiguredModel(
	models: ReasoningDepthEvaluationConfiguredModel[],
): boolean {
	return models.some((model) =>
		[model.id, model.name, model.displayName].some((value) =>
			isKimiModelName(value ?? ""),
		),
	);
}

function isKimiModelName(value: string): boolean {
	return /\b(kimi|moonshot)\b/i.test(value) || /kimi|moonshot/i.test(value);
}

function defaultClassifierDecisionForEvaluation(
	fixture: ReasoningDepthClarificationEvaluationFixture,
): DepthClarificationClassifierDecision | null {
	if (fixture.expectedAction === "ask") {
		return {
			outcome: "ask",
			reason: "multiple_plausible_targets",
		};
	}
	return null;
}

function emptyDimensions(): Record<
	ReasoningDepthEvaluationDimension,
	ReasoningDepthEvaluationDimensionResult
> {
	return {
		wrongTargetAvoidance: notApplicable(),
		unnecessaryQuestionRate: notApplicable(),
		localizedWording: notApplicable(),
		carryForward: notApplicable(),
		metadataClassification: notApplicable(),
		qualityVsCost: notApplicable(),
		latencyClass: notApplicable(),
		passCount: notApplicable(),
		toolCallBudget: notApplicable(),
		dynamicAddedUsefulDimensions: notApplicable(),
		kimiLocalLiveAvailability: notApplicable(),
	};
}

function notApplicable(): ReasoningDepthEvaluationDimensionResult {
	return {
		passed: true,
		reasons: ["Not applicable for this fixture."],
	};
}

function passIf(
	condition: boolean,
	failureReasons: string[],
): ReasoningDepthEvaluationDimensionResult {
	return {
		passed: condition,
		reasons: condition ? [] : failureReasons,
	};
}

function containsHungarianSignal(value: string): boolean {
	return /[áéíóöőúüű]/i.test(value) || /\b(Melyik|Feltételezés)\b/i.test(value);
}
