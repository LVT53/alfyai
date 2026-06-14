import type { ModelId } from "./types";

export type DeepResearchDepth = "focused" | "standard" | "max";

export type DeepResearchDepthBudget = {
	sourceReviewCeiling: number;
	meaningfulPassFloor: number;
	meaningfulPassCeiling: number;
	repairPassCeiling: number;
	sourceProcessingConcurrency: number;
	modelReasoningConcurrency: number;
};

export type DeepResearchDepthBudgetPolicy = Record<
	DeepResearchDepth,
	DeepResearchDepthBudget
>;

export type DeepResearchModelRole =
	| "plan_generation"
	| "plan_revision"
	| "source_review"
	| "research_task"
	| "synthesis"
	| "citation_audit"
	| "report_writing";

export type DeepResearchModelSelections = Record<
	DeepResearchModelRole,
	ModelId
>;

export type DeepResearchModelRoleDefinition = {
	id: DeepResearchModelRole;
	configKey:
		| "DEEP_RESEARCH_PLAN_MODEL"
		| "DEEP_RESEARCH_PLAN_REVISION_MODEL"
		| "DEEP_RESEARCH_SOURCE_REVIEW_MODEL"
		| "DEEP_RESEARCH_RESEARCH_TASK_MODEL"
		| "DEEP_RESEARCH_SYNTHESIS_MODEL"
		| "DEEP_RESEARCH_CITATION_AUDIT_MODEL"
		| "DEEP_RESEARCH_REPORT_MODEL";
	labelKey: string;
};

export const DEFAULT_DEEP_RESEARCH_MODEL_ID: ModelId = "model1";

export const DEFAULT_DEEP_RESEARCH_DEPTH_BUDGETS: DeepResearchDepthBudgetPolicy =
	{
		focused: {
			sourceReviewCeiling: 24,
			meaningfulPassFloor: 2,
			meaningfulPassCeiling: 3,
			repairPassCeiling: 1,
			sourceProcessingConcurrency: 6,
			modelReasoningConcurrency: 2,
		},
		standard: {
			sourceReviewCeiling: 75,
			meaningfulPassFloor: 3,
			meaningfulPassCeiling: 5,
			repairPassCeiling: 2,
			sourceProcessingConcurrency: 12,
			modelReasoningConcurrency: 4,
		},
		max: {
			sourceReviewCeiling: 200,
			meaningfulPassFloor: 5,
			meaningfulPassCeiling: 8,
			repairPassCeiling: 3,
			sourceProcessingConcurrency: 24,
			modelReasoningConcurrency: 8,
		},
	};

export const DEEP_RESEARCH_MODEL_ROLES = [
	{
		id: "plan_generation",
		configKey: "DEEP_RESEARCH_PLAN_MODEL",
		labelKey: "admin.deepResearchModel.planGeneration",
	},
	{
		id: "plan_revision",
		configKey: "DEEP_RESEARCH_PLAN_REVISION_MODEL",
		labelKey: "admin.deepResearchModel.planRevision",
	},
	{
		id: "source_review",
		configKey: "DEEP_RESEARCH_SOURCE_REVIEW_MODEL",
		labelKey: "admin.deepResearchModel.sourceReview",
	},
	{
		id: "research_task",
		configKey: "DEEP_RESEARCH_RESEARCH_TASK_MODEL",
		labelKey: "admin.deepResearchModel.researchTask",
	},
	{
		id: "synthesis",
		configKey: "DEEP_RESEARCH_SYNTHESIS_MODEL",
		labelKey: "admin.deepResearchModel.synthesis",
	},
	{
		id: "citation_audit",
		configKey: "DEEP_RESEARCH_CITATION_AUDIT_MODEL",
		labelKey: "admin.deepResearchModel.citationAudit",
	},
	{
		id: "report_writing",
		configKey: "DEEP_RESEARCH_REPORT_MODEL",
		labelKey: "admin.deepResearchModel.reportWriting",
	},
] as const satisfies readonly DeepResearchModelRoleDefinition[];

export function defaultDeepResearchModelSelections(): DeepResearchModelSelections {
	return Object.fromEntries(
		DEEP_RESEARCH_MODEL_ROLES.map((role) => [
			role.id,
			DEFAULT_DEEP_RESEARCH_MODEL_ID,
		]),
	) as DeepResearchModelSelections;
}

export function normalizeConfiguredModelId(value: unknown): ModelId {
	if (value === "model1" || value === "model2") return value;
	if (typeof value === "string" && value.startsWith("provider:")) {
		return value as ModelId;
	}
	return DEFAULT_DEEP_RESEARCH_MODEL_ID;
}

export function normalizeDeepResearchDepthBudgetPolicy(
	value: unknown,
): DeepResearchDepthBudgetPolicy {
	const input = value && typeof value === "object" ? value : {};
	return {
		focused: normalizeDepthBudget(
			readDepthBudget(input, "focused"),
			DEFAULT_DEEP_RESEARCH_DEPTH_BUDGETS.focused,
		),
		standard: normalizeDepthBudget(
			readDepthBudget(input, "standard"),
			DEFAULT_DEEP_RESEARCH_DEPTH_BUDGETS.standard,
		),
		max: normalizeDepthBudget(
			readDepthBudget(input, "max"),
			DEFAULT_DEEP_RESEARCH_DEPTH_BUDGETS.max,
		),
	};
}

function readDepthBudget(
	value: object,
	depth: DeepResearchDepth,
): Partial<DeepResearchDepthBudget> {
	const record = value as Record<string, unknown>;
	const budget = record[depth];
	return budget && typeof budget === "object"
		? (budget as Partial<DeepResearchDepthBudget>)
		: {};
}

function normalizeDepthBudget(
	value: Partial<DeepResearchDepthBudget>,
	fallback: DeepResearchDepthBudget,
): DeepResearchDepthBudget {
	const meaningfulPassFloor = readPositiveInteger(
		value.meaningfulPassFloor,
		fallback.meaningfulPassFloor,
	);
	const meaningfulPassCeiling = Math.max(
		meaningfulPassFloor,
		readPositiveInteger(
			value.meaningfulPassCeiling,
			fallback.meaningfulPassCeiling,
		),
	);
	return {
		sourceReviewCeiling: readPositiveInteger(
			value.sourceReviewCeiling,
			fallback.sourceReviewCeiling,
		),
		meaningfulPassFloor,
		meaningfulPassCeiling,
		repairPassCeiling: readNonNegativeInteger(
			value.repairPassCeiling,
			fallback.repairPassCeiling,
		),
		sourceProcessingConcurrency: readPositiveInteger(
			value.sourceProcessingConcurrency,
			fallback.sourceProcessingConcurrency,
		),
		modelReasoningConcurrency: readPositiveInteger(
			value.modelReasoningConcurrency,
			fallback.modelReasoningConcurrency,
		),
	};
}

function readPositiveInteger(value: unknown, fallback: number): number {
	const parsed = readInteger(value);
	return parsed === null ? fallback : Math.max(1, parsed);
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
	const parsed = readInteger(value);
	return parsed === null ? fallback : Math.max(0, parsed);
}

function readInteger(value: unknown): number | null {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number.parseInt(value, 10)
				: Number.NaN;
	if (!Number.isFinite(parsed)) return null;
	return Math.floor(parsed);
}
