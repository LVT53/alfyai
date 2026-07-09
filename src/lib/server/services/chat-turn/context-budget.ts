import {
	DEFAULT_COMPACTION_UI_THRESHOLD_RATIO,
	DEFAULT_MAX_MODEL_CONTEXT_TOKENS,
	DEFAULT_TARGET_CONSTRUCTED_CONTEXT_RATIO,
	MIN_MODEL_CONTEXT_TOKENS,
	normalizeModelContextLimit,
	normalizeModelContextTokens,
} from "$lib/model-context-defaults";

export type ModelContextBudgetInput = {
	maxModelContext: number | null | undefined;
	targetConstructedContext?: number | null;
	compactionUiThreshold?: number | null;
	maxTokens?: number | null;
	systemPromptTokens?: number;
	currentMessageTokens?: number;
	overheadReserveTokens?: number;
};

export type ModelContextBudget = {
	maxModelContext: number;
	usableModelContext: number;
	targetConstructedContext: number;
	compactionUiThreshold: number;
	outputReserve: number;
	configuredMaxTokens: number | null;
	effectiveMaxTokens: number | null;
	outputReserveClamped: boolean;
	reservedBudget: number;
	coreBudget: number;
	supportBudget: number;
	awarenessBudget: number;
};

export type CurrentTurnAttachmentBudgetInput = {
	contextBudget: Pick<
		ModelContextBudget,
		"coreBudget" | "targetConstructedContext"
	>;
	attachmentCount: number;
	minTotalBudget?: number;
	minPerAttachmentBudget?: number;
};

export type CurrentTurnAttachmentBudget = {
	totalBudget: number;
	taskPerAttachmentBudget: number;
	excerptPerAttachmentBudget: number;
};

export type ExplicitSourceSetBudgetInput = {
	contextBudget: Pick<
		ModelContextBudget,
		"supportBudget" | "targetConstructedContext"
	>;
	sourceCount: number;
	minTotalBudget?: number;
	minPerSourceBudget?: number;
};

export type ExplicitSourceSetBudget = {
	totalBudget: number;
	perSourceBudget: number;
};

export type DocumentContextIntent = "reference" | "answer" | "task" | "direct";

export type DocumentContextDepth = "reference" | "excerpt" | "task";

export type DocumentContextDepthBudgetInput = {
	contextBudget: Pick<
		ModelContextBudget,
		"supportBudget" | "coreBudget" | "targetConstructedContext"
	>;
	documentCount: number;
	intent: DocumentContextIntent;
	minPerDocumentBudget?: number;
};

export type DocumentContextDepthBudget = {
	depth: DocumentContextDepth;
	totalBudget: number;
	perArtifactLimit: number;
	perArtifactCharBudget: number;
	useFullContent: boolean;
	partial: boolean;
};

export type SessionHistoryBudgetInput = {
	contextBudget: Pick<ModelContextBudget, "targetConstructedContext">;
	minTotalBudget?: number;
	minRecentTurnCount?: number;
};

export type SessionHistoryBudget = {
	totalBudget: number;
	recentTurnCount: number;
};

export type BaselineMemoryProfileBudgetInput = {
	contextBudget: Pick<ModelContextBudget, "targetConstructedContext">;
	minTotalBudget?: number;
	maxTotalBudget?: number;
};

export type BaselineMemoryProfileBudget = {
	totalBudget: number;
};

// Issue 8.1 — proactive in-chat connector context (calendar/email). Mirrors
// BaselineMemoryProfileBudgetInput/Budget's shape exactly, but with a
// deliberately smaller ratio/floor/ceiling: this block is a live,
// ephemeral "you have a 3pm meeting" nudge, not a durable memory
// projection, so it should stay small and be the first thing trimmed under
// pressure relative to core/session context.
export type ProactiveConnectorContextBudgetInput = {
	contextBudget: Pick<ModelContextBudget, "targetConstructedContext">;
	minTotalBudget?: number;
	maxTotalBudget?: number;
};

export type ProactiveConnectorContextBudget = {
	totalBudget: number;
};

const RESERVED_CONTEXT_RATIO = 0.1;
const CORE_CONTEXT_RATIO = 0.5;
const SUPPORT_CONTEXT_RATIO = 0.35;
const DOCUMENT_REFERENCE_TOTAL_RATIO = 0.18;
const DOCUMENT_EXCERPT_TOTAL_RATIO = 0.45;
const DOCUMENT_TASK_TOTAL_RATIO = 0.85;
const DOCUMENT_DIRECT_CORE_RATIO = 0.65;
const DOCUMENT_REFERENCE_MAX_PER_ARTIFACT_CHARS = 1_400;
const DOCUMENT_EXCERPT_MIN_PER_ARTIFACT_CHARS = 4_000;
const DOCUMENT_EXCERPT_MAX_PER_ARTIFACT_CHARS = 18_000;
const DOCUMENT_TASK_MIN_PER_ARTIFACT_CHARS = 12_000;
const DOCUMENT_TASK_MAX_PER_ARTIFACT_CHARS = 100_000;
const DOCUMENT_FULL_CONTENT_MIN_CHARS = 20_000;
const SESSION_HISTORY_TARGET_CONTEXT_RATIO = 0.65;
const SESSION_HISTORY_TURN_TOKEN_TARGET = 4_000;
const SESSION_HISTORY_MAX_RECENT_TURNS = 32;
const BASELINE_MEMORY_PROFILE_TARGET_CONTEXT_RATIO = 0.02;
const BASELINE_MEMORY_PROFILE_MIN_TOTAL_BUDGET = 8_000;
const BASELINE_MEMORY_PROFILE_MAX_TOTAL_BUDGET = 32_000;
// Deliberately smaller than the baseline-memory-profile constants above — a
// handful of event/unread lines needs far less room than a memory
// projection.
const PROACTIVE_CONNECTOR_CONTEXT_TARGET_CONTEXT_RATIO = 0.004;
const PROACTIVE_CONNECTOR_CONTEXT_MIN_TOTAL_BUDGET = 300;
const PROACTIVE_CONNECTOR_CONTEXT_MAX_TOTAL_BUDGET = 1_200;

export function deriveModelContextBudget(
	input: ModelContextBudgetInput,
): ModelContextBudget {
	const maxModelContext = normalizePositiveInteger(
		input.maxModelContext,
		DEFAULT_MAX_MODEL_CONTEXT_TOKENS,
	);
	const configuredMaxTokens =
		input.maxTokens == null ? null : Math.max(1, Math.floor(input.maxTokens));
	const explicitTargetConstructedContext =
		typeof input.targetConstructedContext === "number" &&
		Number.isFinite(input.targetConstructedContext) &&
		input.targetConstructedContext >= 1
			? normalizeOptionalLimit(
					input.targetConstructedContext,
					Math.floor(
						maxModelContext * DEFAULT_TARGET_CONSTRUCTED_CONTEXT_RATIO,
					),
					maxModelContext,
				)
			: null;
	const requiredInputReserve =
		Math.max(0, Math.floor(input.systemPromptTokens ?? 0)) +
		Math.max(0, Math.floor(input.currentMessageTokens ?? 0)) +
		Math.max(0, Math.floor(input.overheadReserveTokens ?? 0));
	const maxReserveForRequiredInput = Math.max(
		1,
		maxModelContext - requiredInputReserve,
	);
	const maxReserveForTargetContext =
		explicitTargetConstructedContext === null
			? maxModelContext
			: Math.max(1, maxModelContext - explicitTargetConstructedContext);
	const effectiveMaxTokens =
		configuredMaxTokens == null
			? null
			: Math.min(
					configuredMaxTokens,
					maxReserveForRequiredInput,
					maxReserveForTargetContext,
				);
	const outputReserve = effectiveMaxTokens ?? 0;
	const usableModelContext = Math.max(1, maxModelContext - outputReserve);
	const targetConstructedContext = normalizeOptionalLimit(
		explicitTargetConstructedContext,
		Math.floor(usableModelContext * DEFAULT_TARGET_CONSTRUCTED_CONTEXT_RATIO),
		usableModelContext,
	);
	const compactionUiThreshold = normalizeOptionalLimit(
		input.compactionUiThreshold,
		Math.floor(usableModelContext * DEFAULT_COMPACTION_UI_THRESHOLD_RATIO),
		usableModelContext,
	);
	const reservedBudget = Math.floor(
		targetConstructedContext * RESERVED_CONTEXT_RATIO,
	);
	const allocatableBudget = Math.max(
		0,
		targetConstructedContext - reservedBudget,
	);
	const coreBudget = Math.floor(allocatableBudget * CORE_CONTEXT_RATIO);
	const supportBudget = Math.floor(allocatableBudget * SUPPORT_CONTEXT_RATIO);
	const awarenessBudget = Math.max(
		0,
		allocatableBudget - coreBudget - supportBudget,
	);

	return {
		maxModelContext,
		usableModelContext,
		targetConstructedContext,
		compactionUiThreshold,
		outputReserve,
		configuredMaxTokens,
		effectiveMaxTokens,
		outputReserveClamped:
			configuredMaxTokens !== null &&
			effectiveMaxTokens !== configuredMaxTokens,
		reservedBudget,
		coreBudget,
		supportBudget,
		awarenessBudget,
	};
}

export function deriveDocumentContextDepthBudget(
	input: DocumentContextDepthBudgetInput,
): DocumentContextDepthBudget {
	const documentCount = Math.max(1, Math.floor(input.documentCount));
	const minPerDocumentBudget = Math.max(
		80,
		Math.floor(input.minPerDocumentBudget ?? 80),
	);
	const depth = resolveDocumentDepth(input.intent);
	const budgetRatio =
		depth === "reference"
			? DOCUMENT_REFERENCE_TOTAL_RATIO
			: depth === "excerpt"
				? DOCUMENT_EXCERPT_TOTAL_RATIO
				: DOCUMENT_TASK_TOTAL_RATIO;
	const supportScaledBudget = Math.floor(
		input.contextBudget.supportBudget * budgetRatio,
	);
	const directCoreBudget =
		input.intent === "direct"
			? Math.floor(input.contextBudget.coreBudget * DOCUMENT_DIRECT_CORE_RATIO)
			: 0;
	const totalBudget = Math.min(
		input.contextBudget.targetConstructedContext,
		Math.max(
			minPerDocumentBudget * documentCount,
			supportScaledBudget,
			directCoreBudget,
		),
	);
	const fairShareBudget = Math.max(
		minPerDocumentBudget,
		Math.floor(totalBudget / documentCount),
	);
	const perArtifactCharBudget =
		depth === "reference"
			? Math.min(
					DOCUMENT_REFERENCE_MAX_PER_ARTIFACT_CHARS,
					Math.max(minPerDocumentBudget, fairShareBudget),
				)
			: depth === "excerpt"
				? Math.min(
						DOCUMENT_EXCERPT_MAX_PER_ARTIFACT_CHARS,
						Math.max(DOCUMENT_EXCERPT_MIN_PER_ARTIFACT_CHARS, fairShareBudget),
					)
				: Math.min(
						DOCUMENT_TASK_MAX_PER_ARTIFACT_CHARS,
						Math.max(DOCUMENT_TASK_MIN_PER_ARTIFACT_CHARS, fairShareBudget),
					);

	return {
		depth,
		totalBudget,
		perArtifactLimit: depth === "reference" ? 2 : depth === "excerpt" ? 4 : 8,
		perArtifactCharBudget,
		useFullContent:
			depth === "task" &&
			perArtifactCharBudget >= DOCUMENT_FULL_CONTENT_MIN_CHARS,
		partial:
			depth === "task" &&
			perArtifactCharBudget < DOCUMENT_TASK_MAX_PER_ARTIFACT_CHARS,
	};
}

export function deriveCurrentTurnAttachmentBudget(
	input: CurrentTurnAttachmentBudgetInput,
): CurrentTurnAttachmentBudget {
	const attachmentCount = Math.max(1, Math.floor(input.attachmentCount));
	const minTotalBudget = Math.max(0, Math.floor(input.minTotalBudget ?? 0));
	const minPerAttachmentBudget = Math.max(
		80,
		Math.floor(input.minPerAttachmentBudget ?? 80),
	);
	const modelScaledBudget = Math.max(
		minTotalBudget,
		Math.floor(input.contextBudget.coreBudget * 0.9),
	);
	const totalBudget = Math.min(
		input.contextBudget.targetConstructedContext,
		modelScaledBudget,
	);
	const perAttachmentBudget = Math.max(
		minPerAttachmentBudget,
		Math.floor(totalBudget / attachmentCount),
	);

	return {
		totalBudget,
		taskPerAttachmentBudget: perAttachmentBudget,
		excerptPerAttachmentBudget: perAttachmentBudget,
	};
}

export function deriveExplicitSourceSetBudget(
	input: ExplicitSourceSetBudgetInput,
): ExplicitSourceSetBudget {
	const sourceCount = Math.max(1, Math.floor(input.sourceCount));
	const minTotalBudget = Math.max(0, Math.floor(input.minTotalBudget ?? 0));
	const minPerSourceBudget = Math.max(
		80,
		Math.floor(input.minPerSourceBudget ?? 80),
	);
	const totalBudget = Math.min(
		input.contextBudget.targetConstructedContext,
		Math.max(
			minTotalBudget,
			Math.floor(input.contextBudget.supportBudget * 0.85),
		),
	);
	const perSourceBudget = Math.max(
		minPerSourceBudget,
		Math.floor(totalBudget / sourceCount),
	);
	return {
		totalBudget,
		perSourceBudget,
	};
}

export function deriveSessionHistoryBudget(
	input: SessionHistoryBudgetInput,
): SessionHistoryBudget {
	const minTotalBudget = Math.max(0, Math.floor(input.minTotalBudget ?? 0));
	const minRecentTurnCount = Math.max(
		1,
		Math.floor(input.minRecentTurnCount ?? 1),
	);
	const modelScaledBudget = Math.max(
		minTotalBudget,
		Math.floor(
			input.contextBudget.targetConstructedContext *
				SESSION_HISTORY_TARGET_CONTEXT_RATIO,
		),
	);
	const totalBudget = Math.min(
		input.contextBudget.targetConstructedContext,
		modelScaledBudget,
	);
	const recentTurnCount = Math.max(
		minRecentTurnCount,
		Math.min(
			SESSION_HISTORY_MAX_RECENT_TURNS,
			Math.floor(totalBudget / SESSION_HISTORY_TURN_TOKEN_TARGET),
		),
	);

	return {
		totalBudget,
		recentTurnCount,
	};
}

export function deriveBaselineMemoryProfileBudget(
	input: BaselineMemoryProfileBudgetInput,
): BaselineMemoryProfileBudget {
	const minTotalBudget = Math.max(
		0,
		Math.floor(
			input.minTotalBudget ?? BASELINE_MEMORY_PROFILE_MIN_TOTAL_BUDGET,
		),
	);
	const maxTotalBudget = Math.max(
		minTotalBudget,
		Math.floor(
			input.maxTotalBudget ?? BASELINE_MEMORY_PROFILE_MAX_TOTAL_BUDGET,
		),
	);
	const modelScaledBudget = Math.max(
		minTotalBudget,
		Math.floor(
			input.contextBudget.targetConstructedContext *
				BASELINE_MEMORY_PROFILE_TARGET_CONTEXT_RATIO,
		),
	);
	return {
		totalBudget: Math.min(modelScaledBudget, maxTotalBudget),
	};
}

// Issue 8.1 — token budget for the proactive_connector_context stage's
// injected "## Your calendar & mail (live)" block. Same shape/derivation
// posture as deriveBaselineMemoryProfileBudget above (model-scaled, clamped
// to a min/max floor/ceiling), just with a much smaller ceiling since this
// is a few lines of live event/unread summary, not a memory projection.
// truncateToTokenBudget applies this at the call site before the block is
// spliced into the outbound prompt; the global applyOutboundPromptBudget
// backstop still applies on top.
export function deriveProactiveConnectorContextBudget(
	input: ProactiveConnectorContextBudgetInput,
): ProactiveConnectorContextBudget {
	const minTotalBudget = Math.max(
		0,
		Math.floor(
			input.minTotalBudget ?? PROACTIVE_CONNECTOR_CONTEXT_MIN_TOTAL_BUDGET,
		),
	);
	const maxTotalBudget = Math.max(
		minTotalBudget,
		Math.floor(
			input.maxTotalBudget ?? PROACTIVE_CONNECTOR_CONTEXT_MAX_TOTAL_BUDGET,
		),
	);
	const modelScaledBudget = Math.max(
		minTotalBudget,
		Math.floor(
			input.contextBudget.targetConstructedContext *
				PROACTIVE_CONNECTOR_CONTEXT_TARGET_CONTEXT_RATIO,
		),
	);
	return {
		totalBudget: Math.min(modelScaledBudget, maxTotalBudget),
	};
}

function resolveDocumentDepth(
	intent: DocumentContextIntent,
): DocumentContextDepth {
	if (intent === "reference") return "reference";
	if (intent === "answer") return "excerpt";
	return "task";
}

function normalizePositiveInteger(
	value: number | null | undefined,
	fallback: number,
): number {
	return normalizeModelContextTokens(value, fallback, MIN_MODEL_CONTEXT_TOKENS);
}

function normalizeOptionalLimit(
	value: number | null | undefined,
	derivedValue: number,
	maxModelContext: number,
): number {
	return normalizeModelContextLimit(value, derivedValue, maxModelContext);
}
