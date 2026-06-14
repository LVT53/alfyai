import type { DeepResearchSourceQualitySignals } from "$lib/types";
import type { ResearchPlan } from "./planning";
import { scoreSourceQualitySignals } from "./source-quality";
import type {
	ResearchSourceCounts,
	ResearchTimelineKind,
	ResearchTimelineStage,
} from "./timeline";

export type ResearchCoverageStatus = "sufficient" | "insufficient";

export type ReviewedCoverageSource = {
	id: string;
	canonicalUrl?: string;
	url?: string;
	title: string;
	reviewedAt?: string;
	publishedAt?: string | null;
	supportedKeyQuestions: string[];
	keyFindings: string[];
	qualityScore?: number;
	sourceQualitySignals?: DeepResearchSourceQualitySignals | null;
	topicRelevant?: boolean;
	comparedEntity?: string | null;
	comparisonAxis?: string | null;
};

export type ResearchBudgetRemaining = {
	sourceReviews: number;
	synthesisPasses: number;
};

export type CoverageGap = {
	keyQuestion: string;
	comparedEntity?: string | null;
	comparisonAxis?: string | null;
	reason:
		| "insufficient_reviewed_sources"
		| "insufficient_source_diversity"
		| "stale_evidence"
		| "unresolved_conflict"
		| "low_source_quality"
		| "insufficient_supported_claims";
	reviewedSourceCount: number;
	recommendedNextAction: string;
	detail?: string;
};

export type ReportLimitation = {
	keyQuestion: string;
	comparedEntity?: string | null;
	comparisonAxis?: string | null;
	limitation: string;
	reviewedSourceCount: number;
};

export type CoverageTimelineSummary = {
	stage: ResearchTimelineStage;
	kind: ResearchTimelineKind;
	messageKey: string;
	messageParams: Record<string, string | number | boolean | null>;
	sourceCounts: ResearchSourceCounts;
	assumptions: string[];
	warnings: string[];
	summary: string;
};

export type ResearchCoverageAssessment = {
	jobId: string;
	conversationId: string;
	status: ResearchCoverageStatus;
	canContinue: boolean;
	continuationRecommendation: string | null;
	coverageGaps: CoverageGap[];
	reportLimitations: ReportLimitation[];
	budget: ResearchCoverageBudgetState;
	remainingBudget: ResearchBudgetRemaining;
	timelineSummary: CoverageTimelineSummary;
};

export type AssessResearchCoverageInput = {
	jobId: string;
	conversationId: string;
	plan: ResearchPlan;
	reviewedSources: ReviewedCoverageSource[];
	evidenceNotes?: CoverageEvidenceNote[];
	synthesisClaims?: CoverageSynthesisClaim[];
	remainingBudget: ResearchBudgetRemaining;
	signals?: ResearchCoverageSignals;
};

export type CoverageEvidenceNote = {
	id: string;
	supportedKeyQuestion?: string | null;
	findingText: string;
	sourceQualitySignals?: DeepResearchSourceQualitySignals | null;
};

export type CoverageSynthesisClaim = {
	id: string;
	planQuestion?: string | null;
	statement: string;
	central: boolean;
	status: "accepted" | "limited" | "rejected" | "needs-repair";
	statusReason?: string | null;
	competingClaimGroupId?: string | null;
	evidenceLinks: CoverageClaimEvidenceLink[];
};

export type CoverageClaimEvidenceLink = {
	evidenceNoteId: string;
	relation: "support" | "qualification" | "contradiction";
	material?: boolean;
};

export type ResearchCoverageSignals = {
	minimumDistinctSourceDomains?: number;
	minimumAverageQualityScore?: number;
	freshnessRequired?: boolean;
	freshAfter?: string;
	unresolvedConflicts?: ResearchCoverageConflictSignal[];
};

export type ResearchCoverageConflictSignal = {
	keyQuestion: string;
	description: string;
};

export type ResearchCoverageBudgetState = {
	selectedDepth: ResearchPlan["depth"];
	sourceReviewCeiling: number;
	reviewedSourceCount: number;
	remainingSourceReviews: number;
	synthesisPassCeiling: number;
	remainingSynthesisPasses: number;
	exhausted: boolean;
};

export function assessResearchCoverage(
	input: AssessResearchCoverageInput,
): ResearchCoverageAssessment {
	const gaps = input.plan.keyQuestions
		.flatMap((keyQuestion) =>
			assessKeyQuestionCoverage({
				plan: input.plan,
				keyQuestion,
				supportingSources: findSupportingSources(
					input.reviewedSources,
					keyQuestion,
				),
				evidenceNotes: input.evidenceNotes,
				synthesisClaims: input.synthesisClaims,
				signals: input.signals ?? {},
			}),
		)
		.concat(assessComparisonCoverage(input.plan, input.reviewedSources));

	const status: ResearchCoverageStatus =
		gaps.length === 0 ? "sufficient" : "insufficient";
	const remainingBudget = normalizeRemainingBudget(input.remainingBudget);
	const budget = buildBudgetState({
		plan: input.plan,
		reviewedSourceCount: input.reviewedSources.length,
		remainingBudget,
	});
	const canContinue = status === "insufficient" && !budget.exhausted;
	const reportLimitations =
		status === "insufficient" && !canContinue
			? gaps.map(buildReportLimitation)
			: [];
	const coverageGaps = canContinue ? gaps : [];

	return {
		jobId: input.jobId,
		conversationId: input.conversationId,
		status,
		canContinue,
		continuationRecommendation: buildContinuationRecommendation(
			gaps.length,
			canContinue,
		),
		coverageGaps,
		reportLimitations,
		budget,
		remainingBudget,
		timelineSummary: buildCoverageTimelineSummary({
			status,
			reviewedSourceCount: input.reviewedSources.length,
			gapCount: coverageGaps.length,
			limitationCount: reportLimitations.length,
		}),
	};
}

function assessKeyQuestionCoverage(input: {
	plan: ResearchPlan;
	keyQuestion: string;
	supportingSources: ReviewedCoverageSource[];
	evidenceNotes?: CoverageEvidenceNote[];
	synthesisClaims?: CoverageSynthesisClaim[];
	signals: ResearchCoverageSignals;
}): CoverageGap[] {
	const gaps: CoverageGap[] = [];
	const minimumSources = minimumReviewedSources(input.plan);

	if (input.supportingSources.length < minimumSources) {
		gaps.push({
			keyQuestion: input.keyQuestion,
			reason: "insufficient_reviewed_sources",
			reviewedSourceCount: input.supportingSources.length,
			recommendedNextAction: `Review additional sources for: ${input.keyQuestion}`,
		});
		return gaps;
	}

	const minimumDistinctDomains =
		input.signals.minimumDistinctSourceDomains ??
		minimumDistinctSourceDomains(input.plan);
	const distinctDomains = countDistinctSourceDomains(input.supportingSources);
	if (distinctDomains < minimumDistinctDomains) {
		gaps.push({
			keyQuestion: input.keyQuestion,
			reason: "insufficient_source_diversity",
			reviewedSourceCount: input.supportingSources.length,
			recommendedNextAction: `Review sources from ${minimumDistinctDomains - distinctDomains} more independent domain${minimumDistinctDomains - distinctDomains === 1 ? "" : "s"} for: ${input.keyQuestion}`,
			detail: `${distinctDomains} distinct source domain${distinctDomains === 1 ? "" : "s"} currently support this question.`,
		});
	}

	if (
		needsFreshEvidence(input.plan, input.keyQuestion, input.signals) &&
		!hasFreshSource(input.supportingSources, input.signals.freshAfter)
	) {
		gaps.push({
			keyQuestion: input.keyQuestion,
			reason: "stale_evidence",
			reviewedSourceCount: input.supportingSources.length,
			recommendedNextAction: `Find fresher evidence for: ${input.keyQuestion}`,
		});
	}

	const unresolvedConflict = input.signals.unresolvedConflicts?.find(
		(conflict) =>
			normalizeQuestion(conflict.keyQuestion) ===
			normalizeQuestion(input.keyQuestion),
	);
	if (unresolvedConflict) {
		gaps.push({
			keyQuestion: input.keyQuestion,
			reason: "unresolved_conflict",
			reviewedSourceCount: input.supportingSources.length,
			recommendedNextAction: `Resolve conflicting evidence for: ${input.keyQuestion}`,
			detail: sanitizeUserVisibleText(unresolvedConflict.description),
		});
	}

	const minimumAverageQualityScore = input.signals.minimumAverageQualityScore;
	if (
		minimumAverageQualityScore !== undefined &&
		averageQualityScore(input.supportingSources) < minimumAverageQualityScore
	) {
		gaps.push({
			keyQuestion: input.keyQuestion,
			reason: "low_source_quality",
			reviewedSourceCount: input.supportingSources.length,
			recommendedNextAction: `Review higher-quality sources for: ${input.keyQuestion}`,
		});
	}

	if (input.synthesisClaims) {
		const claimGap = assessClaimReadinessForQuestion({
			keyQuestion: input.keyQuestion,
			reviewedSourceCount: input.supportingSources.length,
			evidenceNotes: input.evidenceNotes ?? [],
			synthesisClaims: input.synthesisClaims,
		});
		if (claimGap) gaps.push(claimGap);
	}

	return gaps;
}

function assessClaimReadinessForQuestion(input: {
	keyQuestion: string;
	reviewedSourceCount: number;
	evidenceNotes: CoverageEvidenceNote[];
	synthesisClaims: CoverageSynthesisClaim[];
}): CoverageGap | null {
	const centralClaims = input.synthesisClaims.filter(
		(claim) =>
			claim.central &&
			normalizeQuestion(claim.planQuestion ?? "") ===
				normalizeQuestion(input.keyQuestion),
	);
	const conflictGap = assessMaterialClaimConflict({
		keyQuestion: input.keyQuestion,
		reviewedSourceCount: input.reviewedSourceCount,
		centralClaims,
	});
	if (conflictGap) return conflictGap;

	const acceptedSupportedClaims = centralClaims.filter((claim) =>
		isAcceptedSupportedClaim({
			claim,
			keyQuestion: input.keyQuestion,
			evidenceNotes: input.evidenceNotes,
		}),
	);
	if (acceptedSupportedClaims.length > 0) return null;

	const repairableCentralClaim = centralClaims.find((claim) =>
		["needs-repair", "rejected"].includes(claim.status),
	);
	return {
		keyQuestion: input.keyQuestion,
		reason: "insufficient_supported_claims",
		reviewedSourceCount: input.reviewedSourceCount,
		recommendedNextAction: repairableCentralClaim
			? `Repair or replace unsupported central Synthesis Claims for: ${input.keyQuestion}`
			: `Create a supported central Synthesis Claim for: ${input.keyQuestion}`,
		detail: repairableCentralClaim?.statusReason
			? `Claim Support Gate failed: ${sanitizeUserVisibleText(repairableCentralClaim.statusReason)}`
			: "No accepted central Synthesis Claim is ready for this approved key question.",
	};
}

function assessMaterialClaimConflict(input: {
	keyQuestion: string;
	reviewedSourceCount: number;
	centralClaims: CoverageSynthesisClaim[];
}): CoverageGap | null {
	const groups = new Map<string, CoverageSynthesisClaim[]>();
	for (const claim of input.centralClaims) {
		const groupId = normalizeOptionalText(claim.competingClaimGroupId);
		if (!groupId) continue;
		const claims = groups.get(groupId) ?? [];
		claims.push(claim);
		groups.set(groupId, claims);
	}

	for (const [groupId, claims] of groups) {
		if (claims.length < 2) continue;
		if (claims.some((claim) => claim.status === "needs-repair")) {
			return {
				keyQuestion: input.keyQuestion,
				reason: "unresolved_conflict",
				reviewedSourceCount: input.reviewedSourceCount,
				recommendedNextAction: `Resolve material Claim Conflicts for: ${input.keyQuestion}`,
				detail: `Competing Synthesis Claims in ${groupId} remain unresolved.`,
			};
		}
	}

	return null;
}

function isAcceptedSupportedClaim(input: {
	claim: CoverageSynthesisClaim;
	keyQuestion: string;
	evidenceNotes: CoverageEvidenceNote[];
}): boolean {
	if (input.claim.status !== "accepted") return false;
	if (
		input.claim.evidenceLinks.some(
			(link) => link.relation === "contradiction" && link.material,
		)
	) {
		return false;
	}
	const evidenceById = new Map(
		input.evidenceNotes.map((note) => [note.id, note]),
	);
	return input.claim.evidenceLinks
		.filter((link) => link.relation === "support")
		.some((link) => {
			const note = evidenceById.get(link.evidenceNoteId);
			return (
				note &&
				normalizeQuestion(note.supportedKeyQuestion ?? "") ===
					normalizeQuestion(input.keyQuestion)
			);
		});
}

function findSupportingSources(
	sources: ReviewedCoverageSource[],
	keyQuestion: string,
): ReviewedCoverageSource[] {
	return sources.filter(
		(source) =>
			source.topicRelevant !== false &&
			source.supportedKeyQuestions.some(
				(supportedQuestion) =>
					normalizeQuestion(supportedQuestion) ===
					normalizeQuestion(keyQuestion),
			),
	);
}

function assessComparisonCoverage(
	plan: ResearchPlan,
	reviewedSources: ReviewedCoverageSource[],
): CoverageGap[] {
	if (
		plan.reportIntent !== "comparison" ||
		!plan.comparedEntities?.length ||
		!plan.comparisonAxes?.length
	) {
		return [];
	}

	const gaps: CoverageGap[] = [];
	for (const axis of plan.comparisonAxes) {
		for (const entity of plan.comparedEntities) {
			const supportingSources = reviewedSources.filter(
				(source) =>
					source.topicRelevant !== false &&
					normalizeComparisonTerm(source.comparedEntity) ===
						normalizeComparisonTerm(entity) &&
					normalizeComparisonTerm(source.comparisonAxis) ===
						normalizeComparisonTerm(axis),
			);
			if (supportingSources.length > 0) continue;
			gaps.push({
				keyQuestion: findKeyQuestionForComparisonAxis(plan, axis),
				comparedEntity: entity,
				comparisonAxis: axis,
				reason: "insufficient_reviewed_sources",
				reviewedSourceCount: 0,
				recommendedNextAction: `Review topic-relevant sources for ${entity} on ${axis}.`,
			});
		}
	}

	return gaps;
}

function minimumReviewedSources(plan: ResearchPlan): number {
	if (plan.depth === "focused") return 1;
	if (plan.depth === "max") return 3;
	return 2;
}

function minimumDistinctSourceDomains(plan: ResearchPlan): number {
	if (plan.depth === "focused") return 1;
	return 2;
}

function countDistinctSourceDomains(sources: ReviewedCoverageSource[]): number {
	const domains = new Set<string>();
	for (const source of sources) {
		const url = source.canonicalUrl ?? source.url;
		if (!url) continue;
		try {
			domains.add(new URL(url).hostname.toLowerCase());
		} catch {
			domains.add(url.toLowerCase());
		}
	}
	return domains.size;
}

function needsFreshEvidence(
	plan: ResearchPlan,
	keyQuestion: string,
	signals: ResearchCoverageSignals,
): boolean {
	if (signals.freshnessRequired !== undefined) return signals.freshnessRequired;
	const text = `${plan.goal} ${keyQuestion}`.toLowerCase();
	return /\b(current|latest|recent|today|202[0-9])\b/.test(text);
}

function hasFreshSource(
	sources: ReviewedCoverageSource[],
	freshAfter?: string,
): boolean {
	if (!freshAfter) {
		return sources.some((source) => Boolean(source.publishedAt));
	}
	const cutoff = new Date(freshAfter).getTime();
	return sources.some((source) => {
		if (!source.publishedAt) return false;
		return new Date(source.publishedAt).getTime() >= cutoff;
	});
}

function averageQualityScore(sources: ReviewedCoverageSource[]): number {
	if (sources.length === 0) return 0;
	const total = sources.reduce(
		(sum, source) => sum + sourceQualityScore(source),
		0,
	);
	return total / sources.length;
}

function sourceQualityScore(source: ReviewedCoverageSource): number {
	if (source.sourceQualitySignals) {
		return scoreSourceQualitySignals(source.sourceQualitySignals);
	}
	return source.qualityScore ?? 1;
}

function buildBudgetState(input: {
	plan: ResearchPlan;
	reviewedSourceCount: number;
	remainingBudget: ResearchBudgetRemaining;
}): ResearchCoverageBudgetState {
	return {
		selectedDepth: input.plan.depth,
		sourceReviewCeiling: input.plan.researchBudget.sourceReviewCeiling,
		reviewedSourceCount: input.reviewedSourceCount,
		remainingSourceReviews: input.remainingBudget.sourceReviews,
		synthesisPassCeiling: input.plan.researchBudget.synthesisPassCeiling,
		remainingSynthesisPasses: input.remainingBudget.synthesisPasses,
		exhausted:
			input.remainingBudget.sourceReviews === 0 &&
			input.remainingBudget.synthesisPasses === 0,
	};
}

function normalizeRemainingBudget(
	remainingBudget: ResearchBudgetRemaining,
): ResearchBudgetRemaining {
	return {
		sourceReviews: Math.max(0, Math.floor(remainingBudget.sourceReviews)),
		synthesisPasses: Math.max(0, Math.floor(remainingBudget.synthesisPasses)),
	};
}

function buildCoverageTimelineSummary(input: {
	status: ResearchCoverageStatus;
	reviewedSourceCount: number;
	gapCount: number;
	limitationCount: number;
}): CoverageTimelineSummary {
	const sufficient = input.status === "sufficient";
	const limited = input.limitationCount > 0;
	return {
		stage: "coverage_assessment",
		kind: "coverage_assessed",
		messageKey: getCoverageTimelineMessageKey({ sufficient, limited }),
		messageParams: {
			reviewedSources: input.reviewedSourceCount,
			coverageGaps: input.gapCount,
			reportLimitations: input.limitationCount,
		},
		sourceCounts: {
			discovered: 0,
			reviewed: input.reviewedSourceCount,
			cited: 0,
		},
		assumptions: [],
		warnings: limited
			? [
					"Depth budget exhausted; unresolved coverage gaps must be disclosed as report limitations.",
				]
			: [],
		summary: getCoverageSummary({ sufficient, limited }),
	};
}

function buildReportLimitation(gap: CoverageGap): ReportLimitation {
	const limitation: ReportLimitation = {
		keyQuestion: gap.keyQuestion,
		limitation:
			gap.reason === "insufficient_reviewed_sources"
				? buildInsufficientReviewedSourcesLimitation(gap)
				: `Depth budget is exhausted before this coverage issue could be resolved: ${humanizeCoverageGapReason(gap.reason)}.`,
		reviewedSourceCount: gap.reviewedSourceCount,
	};
	if (gap.comparedEntity) limitation.comparedEntity = gap.comparedEntity;
	if (gap.comparisonAxis) limitation.comparisonAxis = gap.comparisonAxis;
	return limitation;
}

function buildInsufficientReviewedSourcesLimitation(gap: CoverageGap): string {
	if (gap.comparedEntity && gap.comparisonAxis) {
		return `Depth budget is exhausted before enough reviewed evidence could support ${gap.comparedEntity} on ${gap.comparisonAxis}.`;
	}
	return "Depth budget is exhausted before enough reviewed evidence could support this key question.";
}

function getCoverageTimelineMessageKey(input: {
	sufficient: boolean;
	limited: boolean;
}): string {
	if (input.sufficient) return "deepResearch.timeline.coverageSufficient";
	if (input.limited) return "deepResearch.timeline.coverageLimited";
	return "deepResearch.timeline.coverageInsufficient";
}

function getCoverageSummary(input: {
	sufficient: boolean;
	limited: boolean;
}): string {
	if (input.sufficient) {
		return "Reviewed evidence covers the approved Research Plan key questions.";
	}
	if (input.limited) {
		return "Depth budget is exhausted; incomplete coverage will be disclosed as report limitations.";
	}
	return "Coverage gaps remain before report synthesis.";
}

function buildContinuationRecommendation(
	gapCount: number,
	canContinue: boolean,
): string | null {
	if (!canContinue) return null;
	return `Continue source review against ${gapCount} Coverage Gap${
		gapCount === 1 ? "" : "s"
	}.`;
}

function normalizeQuestion(question: string): string {
	return question.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeComparisonTerm(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function findKeyQuestionForComparisonAxis(
	plan: ResearchPlan,
	axis: string,
): string {
	const normalizedAxis = normalizeComparisonTerm(axis);
	return (
		plan.keyQuestions.find((question) =>
			normalizeComparisonTerm(question).includes(normalizedAxis),
		) ??
		plan.keyQuestions[0] ??
		plan.goal
	);
}

function normalizeOptionalText(text: string | null | undefined): string | null {
	const normalized = text?.replace(/\s+/g, " ").trim();
	return normalized ? normalized : null;
}

function humanizeCoverageGapReason(reason: CoverageGap["reason"]): string {
	return reason.replaceAll("_", " ");
}

function sanitizeUserVisibleText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
