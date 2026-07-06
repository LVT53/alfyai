import {
	type BudgetedAttachmentContext,
	compactContextSections,
	dedupeById,
	extractSerializedAttachmentBody,
	type PromptContextSection,
	type PromptContextSectionSelection,
	rerankHistoricalSections,
	selectRecentRoleTurns,
	serializeBudgetedAttachments,
	serializeBudgetedRoleTurns,
	serializeWorkingSetArtifacts,
	truncateToTokenBudget,
} from "$lib/server/utils/prompt-context";
import { clipText } from "$lib/server/utils/text";
import {
	detectTopicShift,
	shouldSuppressCarryover,
} from "$lib/server/utils/topic-shift-detector";
import type {
	Artifact,
	ContextDebugState,
	ConversationContextStatus,
	ForkContextProvenanceSummary,
	HonchoContextInfo,
	HonchoContextSnapshot,
	LinkedContextSource,
	MemoryLayer,
} from "$lib/types";
import { estimateTokenCount } from "$lib/utils/tokens";
import { getConfig } from "../../config-store";
import {
	hasMeaningfulAttachmentText,
	logAttachmentTrace,
	summarizeAttachmentTraceText,
} from "../attachment-trace";
import {
	type ContextCompressionSnapshot,
	listContextCompressionSourceMessages,
} from "../context-compression";
import { getConversationForkOrigin } from "../conversation-forks";
import { getConversationSummary } from "../conversation-summaries";
import type { PromptContextMessage } from "../honcho";
import {
	AttachmentReadinessError,
	findRelevantKnowledgeArtifacts,
	getArtifactsForUser,
	getCompactionUiThreshold,
	getMaxModelContext,
	getTargetConstructedContext,
	listConversationSourceArtifactIds,
	listConversationSourceArtifactNames,
	resolvePromptAttachmentArtifacts,
	selectWorkingSetArtifactsForPrompt,
	updateConversationContextStatus,
	WORKING_SET_DOCUMENT_TOKEN_BUDGET,
	WORKING_SET_OUTPUT_TOKEN_BUDGET,
	WORKING_SET_PROMPT_TOKEN_BUDGET,
} from "../knowledge";
import { listConversationLinkedContextSources } from "../linked-context-sources";
import {
	type ActiveMemoryProfileContext,
	formatActiveMemoryProfileContextForPrompt,
	getActiveMemoryProfileContext,
	type MemoryProfileScope,
} from "../memory-profile/active-context";
import { recordMemoryReworkTelemetry } from "../memory-profile/telemetry";
import { listMessages } from "../messages";
import {
	getConversationProjectId,
	getConversationProjectLabel,
} from "../projects";
import {
	formatTaskStateForPrompt,
	getContextDebugState,
	getProjectReferenceContext,
	getPromptArtifactSnippets,
	type ProjectFolderSiblingPromotionContext,
	type ProjectReferenceContext,
	prepareTaskContext,
	selectProjectFolderSiblingPromotion,
} from "../task-state";
import { embedTexts } from "../tei-embedder";
import { canUseTeiReranker, rerankItems } from "../tei-reranker";
import { resolveWorkingDocumentSelection } from "../working-document-selection";
import {
	type DocumentContextDepthBudget,
	type DocumentContextIntent,
	deriveBaselineMemoryProfileBudget,
	deriveCurrentTurnAttachmentBudget,
	deriveDocumentContextDepthBudget,
	deriveExplicitSourceSetBudget,
	deriveModelContextBudget,
	deriveSessionHistoryBudget,
} from "./context-budget";
import type {
	ContextTraceSource,
	LegacyContextTraceSectionInput,
} from "./context-trace";

const HONCHO_LIVE_CONTEXT_TOKENS = 2_000;
const ATTACHMENT_PROMPT_TOKEN_BUDGET = 6_000;
const ATTACHMENT_TASK_PER_ATTACHMENT_TOKEN_BUDGET = 2_400;
const ATTACHMENT_EXCERPT_PER_ATTACHMENT_TOKEN_BUDGET = 600;
const RECENT_TURN_COUNT = 3;
const MIN_RELEVANT_KNOWLEDGE_ARTIFACTS = 6;
const MAX_RELEVANT_KNOWLEDGE_ARTIFACTS = 64;
const RELEVANT_KNOWLEDGE_ARTIFACT_TARGET_TOKEN_STEP = 32_768;
const PROJECT_FOLDER_PROMPT_LABEL_MAX_CHARS = 160;
const DOCUMENT_TASK_INTENT_RE =
	/\b(summarize|summarise|summary|compare|extract|review|check|rewrite|revise|edit|analyze|analyse|translate|convert|outline)\b|what\s+does\s+(it|this|that|the\s+[\w\s-]{0,80}?(document|doc|file|pdf|policy|report|brief))\s+say\s+about|(?:összefoglal[\p{L}]*|foglal[\p{L}]*\s+össze|összegez[\p{L}]*|elemez[\p{L}]*|ellenőriz[\p{L}]*|ellenoriz[\p{L}]*|nézd\s+át|nezd\s+at|javíts[\p{L}]*|javits[\p{L}]*|írd\s+át|ird\s+at|szerkeszd|fordíts[\p{L}]*|fordits[\p{L}]*|hasonlíts[\p{L}]*|hasonlits[\p{L}]*|alakíts[\p{L}]*\s+át|alakits[\p{L}]*\s+at|exportál[\p{L}]*|exportal[\p{L}]*|készíts[\p{L}]*|keszits[\p{L}]*|mit\s+mond|mi\s+szerepel|mi\s+van\s+benne)/iu;
const DOCUMENT_ANSWER_INTENT_RE =
	/\b(according to|based on|from the|from this|from that|what|when|where|who|why|how|which)\b|(?:mire|miért|hogyan|mikor|hol|kit|kinek)\b/iu;
const DOCUMENT_REFERENCE_RE =
	/\b(attachment|attached|source|document|doc|file|pdf|policy|report|brief|workspace|this|that|it)\b|(?:dokumentum[\p{L}]*|doksi[\p{L}]*|fájl[\p{L}]*|fajl[\p{L}]*|csatolmány[\p{L}]*|csatolmany[\p{L}]*|melléklet[\p{L}]*|melleklet[\p{L}]*|forrás[\p{L}]*|forras[\p{L}]*|ez|ezt|ebből|ebbol|abban|benne|itt|ott)|\/document\b/iu;
const DEEP_CONTEXT_INTENT_RE =
	/\b(attachment|attached|source|sources|document|doc|file|pdf|policy|report|brief|workspace|evidence|cite|citation|according to|based on|summarize|summarise|summary|compare|extract|review|check|rewrite|revise|edit|analyze|analyse|translate|convert|outline|project|task|plan|decision|decisions|remember|memory|earlier|previous|before|continue)\b|(?:dokumentum[\p{L}]*|doksi[\p{L}]*|fájl[\p{L}]*|fajl[\p{L}]*|csatolmány[\p{L}]*|csatolmany[\p{L}]*|melléklet[\p{L}]*|melleklet[\p{L}]*|forrás[\p{L}]*|forras[\p{L}]*|bizonyíték[\p{L}]*|bizonyitek[\p{L}]*|idéz[\p{L}]*|idez[\p{L}]*|összefoglal[\p{L}]*|foglal[\p{L}]*\s+össze|összegez[\p{L}]*|hasonlíts[\p{L}]*|hasonlits[\p{L}]*|elemez[\p{L}]*|ellenőriz[\p{L}]*|ellenoriz[\p{L}]*|javíts[\p{L}]*|javits[\p{L}]*|írd\s+át|ird\s+at|fordíts[\p{L}]*|fordits[\p{L}]*|projekt[\p{L}]*|feladat[\p{L}]*|terv[\p{L}]*|döntés[\p{L}]*|dontes[\p{L}]*|emléksz[\p{L}]*|emleksz[\p{L}]*|korábbi|korabbi|előző|elozo|folytasd)/iu;
const META_CONTEXT_INTENT_RE =
	/\b(context|current\s+(query|question|message|turn|prompt)|chat\s+context|conversation\s+context)\b/iu;
const EVIDENCE_ANSWER_INTENT_RE =
	/\b(what|which|who|when|where|why|how)\b[\s\S]{0,120}\b(predicts?|causes?|drivers?|factors?|reasons?|risks?|trouble|indicates?|signals?|patterns?)\b/iu;
const REFINEMENT_FOLLOWUP_INTENT_RE =
	/\b(shorten|shorter|condense|trim|tighten|longer|expand|polish|improve|refine|update|fix|correct|adjust|change|simplify|clarify|concise)\b|(?:rövidebb|rovidebb|hosszabb|tömöríts[\p{L}]*|tomorits[\p{L}]*|pontosíts[\p{L}]*|pontosit[\p{L}]*)/iu;
const SHALLOW_CONTEXT_MAX_MESSAGE_CHARS = 280;

export type ContextSelectionCandidate = {
	title: string;
	body: string;
	source: ContextTraceSource;
	layer?: MemoryLayer;
	protected?: boolean;
	budgetPriority?: "core" | "support" | "awareness";
	itemIds?: string[];
	itemTitles?: string[];
	signalReasons?: string[];
};

export type SelectedPromptContext = {
	inputValue: string;
	compactionApplied: boolean;
	compactionMode: ReturnType<typeof compactContextSections>["compactionMode"];
	layersUsed: MemoryLayer[];
	estimatedTokens: number;
	contextTraceSections: LegacyContextTraceSectionInput[];
	sectionSelections: PromptContextSectionSelection[];
};

export type ConstructedContextReuseData = {
	relevantArtifacts: Artifact[];
	preparedContext: Awaited<ReturnType<typeof prepareTaskContext>>;
	artifactSnippets: Map<string, string>;
};

type ContextLatencyTier = "shallow" | "deep";

type ContextLatencyTierResolution = {
	tier: ContextLatencyTier;
	reasons: string[];
};

function summarizeActiveMemoryProfileTelemetry(
	context: ActiveMemoryProfileContext,
): {
	categoryCounts: Record<string, number>;
	scopeCounts: Record<string, number>;
} {
	const categoryCounts: Record<string, number> = {};
	const scopeCounts: Record<string, number> = {};
	for (const item of context.items) {
		categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1;
		scopeCounts[item.scope.type] = (scopeCounts[item.scope.type] ?? 0) + 1;
	}
	return { categoryCounts, scopeCounts };
}

async function recordPromptMemoryTelemetry(params: {
	userId: string;
	eventName: string;
	reason: string;
	status: string;
	count: number;
	metadata?: Record<string, unknown>;
}): Promise<void> {
	try {
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "prompt_use",
			eventName: params.eventName,
			reason: params.reason,
			status: params.status,
			count: params.count,
			metadata: params.metadata,
		});
	} catch {
		// Prompt assembly should not fail because telemetry is unavailable.
	}
}

async function buildActiveMemoryProfilePromptSection(params: {
	userId: string;
	conversationId: string;
	applicableScopes?: MemoryProfileScope[];
	modelContextBudget: ReturnType<typeof deriveModelContextBudget>;
}): Promise<PromptContextSection | null> {
	let context: ActiveMemoryProfileContext;
	try {
		context = await getActiveMemoryProfileContext({
			userId: params.userId,
			applicableScopes:
				params.applicableScopes ??
				buildApplicableMemoryProfileScopes({
					conversationId: params.conversationId,
				}),
		});
	} catch {
		await recordPromptMemoryTelemetry({
			userId: params.userId,
			eventName: "active_memory_profile_blocked",
			reason: "active_profile_context_error",
			status: "blocked",
			count: 0,
		});
		return null;
	}

	if (context.items.length === 0) {
		await recordPromptMemoryTelemetry({
			userId: params.userId,
			eventName: "active_memory_profile_empty",
			reason: "no_active_projection_items",
			status: "empty",
			count: 0,
			metadata: {
				projectionRevision: context.projectionRevision,
				resetGeneration: context.resetGeneration,
			},
		});
		return null;
	}

	const baselineMemoryProfileBudget = deriveBaselineMemoryProfileBudget({
		contextBudget: params.modelContextBudget,
	});
	const formattedContext = formatActiveMemoryProfileContextForPrompt(context, {
		maxTokens: baselineMemoryProfileBudget.totalBudget,
	});
	const body = formattedContext.content;
	if (!body) {
		await recordPromptMemoryTelemetry({
			userId: params.userId,
			eventName: "active_memory_profile_empty",
			reason: "active_profile_budget_too_small",
			status: "empty",
			count: 0,
			metadata: {
				projectionRevision: context.projectionRevision,
				resetGeneration: context.resetGeneration,
				totalItemCount: context.items.length,
			},
		});
		return null;
	}
	await recordPromptMemoryTelemetry({
		userId: params.userId,
		eventName: "active_memory_profile_included",
		reason: "active_projection_items",
		status: "included",
		count: formattedContext.includedCount,
		metadata: {
			projectionRevision: context.projectionRevision,
			resetGeneration: context.resetGeneration,
			totalItemCount: context.items.length,
			omittedItemCount: formattedContext.omittedCount,
			estimatedTokens: formattedContext.estimatedTokens,
			...summarizeActiveMemoryProfileTelemetry(context),
		},
	});

	return {
		title: "Baseline Memory Profile",
		body,
		layer: "session",
		protected: true,
		llmCompactible: true,
	};
}

function buildApplicableMemoryProfileScopes(params: {
	conversationId: string;
	projectId?: string | null;
	documentArtifactIds?: Iterable<string | null | undefined>;
}): MemoryProfileScope[] {
	const scopes: MemoryProfileScope[] = [];
	const seen = new Set<string>();
	const add = (scope: Exclude<MemoryProfileScope, { type: "global" }>) => {
		const id = scope.id.trim();
		if (!id) return;
		const key = `${scope.type}:${id}`;
		if (seen.has(key)) return;
		seen.add(key);
		scopes.push({ type: scope.type, id });
	};

	add({ type: "project", id: params.projectId ?? "" });
	add({ type: "conversation", id: params.conversationId });
	for (const documentArtifactId of params.documentArtifactIds ?? []) {
		add({ type: "document", id: documentArtifactId ?? "" });
	}

	return scopes;
}

export function deriveRelevantKnowledgeArtifactLimit(
	targetConstructedContext: number,
): number {
	if (
		!Number.isFinite(targetConstructedContext) ||
		targetConstructedContext <= 0
	) {
		return MIN_RELEVANT_KNOWLEDGE_ARTIFACTS;
	}
	return Math.max(
		MIN_RELEVANT_KNOWLEDGE_ARTIFACTS,
		Math.min(
			MAX_RELEVANT_KNOWLEDGE_ARTIFACTS,
			Math.ceil(
				targetConstructedContext /
					RELEVANT_KNOWLEDGE_ARTIFACT_TARGET_TOKEN_STEP,
			),
		),
	);
}

function inferContextTraceSourceForSection(
	section: Pick<PromptContextSection, "title" | "layer">,
): ContextTraceSource {
	const normalizedTitle = section.title.toLowerCase();
	if (normalizedTitle.includes("attachment")) return "attachment";
	if (
		normalizedTitle.includes("user memory") ||
		normalizedTitle.includes("baseline memory profile")
	) {
		return "memory";
	}
	if (normalizedTitle.includes("session")) return "session";
	if (normalizedTitle.includes("task")) return "task_state";
	if (normalizedTitle.includes("evidence") || section.layer === "working_set") {
		return "working_set";
	}
	if (section.layer === "documents") return "document";
	if (section.layer === "task_state") return "task_state";
	if (section.layer === "session") return "session";
	return "session";
}

function buildDocumentContextSignalReasons(params: {
	intent: DocumentContextIntent;
	budget: DocumentContextDepthBudget;
}): string[] {
	return [
		`document_context_depth:${params.budget.depth}`,
		`document_context_intent:${params.intent}`,
		`document_context_per_artifact_chars:${params.budget.perArtifactCharBudget}`,
		params.budget.partial ? "document_context_partial:true" : null,
	].filter((value): value is string => Boolean(value));
}

function buildContextSelectionCandidates(params: {
	sections: PromptContextSection[];
	attachmentContext?: BudgetedAttachmentContext | null;
	carriedForwardAttachmentContext?: BudgetedAttachmentContext | null;
	projectFolderSiblingPromotion?: ProjectFolderSiblingPromotionContext | null;
	documentContextIntent?: DocumentContextIntent;
	documentDepthBudget?: DocumentContextDepthBudget | null;
	linkedSourceItems?: Array<{
		id: string;
		title: string;
	}>;
	evidenceItems?: Array<{
		id: string;
		title: string;
		pinned: boolean;
	}>;
}): ContextSelectionCandidate[] {
	const documentContextSignalReasons =
		params.documentDepthBudget && params.documentContextIntent
			? buildDocumentContextSignalReasons({
					intent: params.documentContextIntent,
					budget: params.documentDepthBudget,
				})
			: [];
	return params.sections.map((section) => {
		const isAttachmentSection = section.title === "Current Attachments";
		const isCarriedForwardAttachmentSection =
			section.title === "Attached Sources";
		const isLinkedSourceSection = section.title === "Linked Sources";
		const isEvidenceSection = section.title === "Retrieved Evidence";
		const isProjectFolderSiblingSection =
			section.title === "Project Folder Sibling Context";
		const attachmentItems = isAttachmentSection
			? (params.attachmentContext?.items ?? [])
			: isCarriedForwardAttachmentSection
				? (params.carriedForwardAttachmentContext?.items ?? [])
				: [];
		const linkedSourceItems = isLinkedSourceSection
			? (params.linkedSourceItems ?? [])
			: [];
		const evidenceItems = isEvidenceSection ? (params.evidenceItems ?? []) : [];
		const promotedSibling = isProjectFolderSiblingSection
			? params.projectFolderSiblingPromotion
			: null;
		return {
			title: section.title,
			body: section.body,
			source: promotedSibling
				? "memory"
				: inferContextTraceSourceForSection(section),
			layer: section.layer,
			protected: section.protected,
			itemIds: isEvidenceSection
				? evidenceItems.map((item) => item.id)
				: isLinkedSourceSection
					? linkedSourceItems.map((item) => item.id)
					: promotedSibling
						? [`conversation:${promotedSibling.conversationId}`]
						: attachmentItems.map((item) => item.id),
			itemTitles: isEvidenceSection
				? evidenceItems.map((item) => item.title)
				: isLinkedSourceSection
					? linkedSourceItems.map((item) => item.title)
					: promotedSibling
						? [promotedSibling.title]
						: attachmentItems.map((item) => item.title),
			signalReasons:
				isAttachmentSection && params.attachmentContext
					? [
							`attachment_context:${params.attachmentContext.mode}`,
							...documentContextSignalReasons,
						]
					: isCarriedForwardAttachmentSection &&
							params.carriedForwardAttachmentContext
						? [
								`attachment_context:${params.carriedForwardAttachmentContext.mode}`,
								"attached_sources:carried_forward",
								...documentContextSignalReasons,
							]
						: isLinkedSourceSection
							? [
									"linked_context_source:direct",
									...documentContextSignalReasons,
								]
							: isEvidenceSection && evidenceItems.some((item) => item.pinned)
								? [
										"pinned_evidence",
										"working_set_context:budgeted",
										...documentContextSignalReasons,
									]
								: isEvidenceSection
									? documentContextSignalReasons
									: section.title === "Honcho Session Context"
										? ["recent_turn_context:budgeted"]
										: section.title === "Context Compression Snapshot"
											? ["context_compression_snapshot:valid"]
											: section.title === "Baseline Memory Profile"
												? ["active_memory_profile:projection"]
												: promotedSibling
													? [
															"project_folder_sibling:query_match",
															`project_folder_sibling_score:${promotedSibling.score}`,
														]
													: [],
		};
	});
}

function buildCurrentAttachmentSnippetMap(params: {
	artifacts: Artifact[];
	snippets: Map<string, string>;
}): Map<string, string> {
	const next = new Map(params.snippets);
	for (const artifact of params.artifacts) {
		if (artifact.contentText?.trim()) {
			next.delete(artifact.id);
		}
	}
	return next;
}

async function resolveLinkedSourcePromptArtifacts(params: {
	userId: string;
	linkedSources: LinkedContextSource[];
}): Promise<Artifact[]> {
	const orderedPromptIds = params.linkedSources
		.map((source) => source.promptArtifactId ?? source.displayArtifactId)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
	if (orderedPromptIds.length === 0) return [];

	const artifacts = await getArtifactsForUser(
		params.userId,
		Array.from(new Set(orderedPromptIds)),
	);
	const artifactsById = new Map(
		artifacts.map((artifact) => [artifact.id, artifact]),
	);
	const resolved: Artifact[] = [];
	const seen = new Set<string>();

	for (const source of params.linkedSources) {
		const promptArtifactId =
			source.promptArtifactId ?? source.displayArtifactId;
		const artifact = artifactsById.get(promptArtifactId);
		if (!artifact || seen.has(artifact.id)) continue;
		seen.add(artifact.id);
		resolved.push({
			...artifact,
			name: source.name.trim() || artifact.name,
		});
	}

	return resolved;
}

function buildProjectFolderPromptSection(
	label: string | null,
): PromptContextSection | null {
	const trimmed = label?.trim();
	if (!trimmed) return null;

	const boundedLabel =
		trimmed.length > PROJECT_FOLDER_PROMPT_LABEL_MAX_CHARS
			? `${trimmed.slice(0, PROJECT_FOLDER_PROMPT_LABEL_MAX_CHARS).trimEnd()}...`
			: trimmed;

	return {
		title: "Project Folder",
		body: `Project Folder label: ${JSON.stringify(boundedLabel)}`,
		layer: "session",
		protected: true,
	};
}

function inferDocumentContextIntent(params: {
	message: string;
	documentFocused: boolean;
	hasCurrentAttachments: boolean;
	hasCarriedForwardAttachments: boolean;
	hasActiveDocument: boolean;
	hasLinkedSources: boolean;
}): DocumentContextIntent {
	const message = params.message.trim();
	const hasTaskIntent = DOCUMENT_TASK_INTENT_RE.test(message);
	const hasAnswerIntent = DOCUMENT_ANSWER_INTENT_RE.test(message);
	const hasDocumentReference = DOCUMENT_REFERENCE_RE.test(message);
	if (params.hasLinkedSources) {
		return "direct";
	}
	const explicitDocumentSelection =
		params.hasCurrentAttachments ||
		params.hasActiveDocument ||
		/\/document\b/i.test(message) ||
		(params.documentFocused && hasDocumentReference) ||
		(params.hasCarriedForwardAttachments && hasDocumentReference);

	if (explicitDocumentSelection && (hasTaskIntent || hasDocumentReference)) {
		return "direct";
	}
	if (hasTaskIntent || (params.documentFocused && hasDocumentReference)) {
		return "task";
	}
	if (hasAnswerIntent) {
		return "answer";
	}
	return "reference";
}

function buildProjectAwarenessPromptSection(
	context: ProjectReferenceContext | null,
): PromptContextSection | null {
	if (!context || context.entries.length === 0) return null;

	const entryBlocks = context.entries.map((entry) =>
		[
			`- Title: ${JSON.stringify(entry.title)}`,
			entry.objective
				? `  Objective: ${JSON.stringify(entry.objective)}`
				: "  Objective: unavailable from existing task summaries.",
			entry.summary
				? `  Summary/Checkpoint: ${JSON.stringify(entry.summary)}`
				: "  Summary/Checkpoint: unavailable from existing task summaries.",
		].join("\n"),
	);
	const omittedLine =
		context.omittedSiblingCount > 0
			? `Omitted: ${context.omittedSiblingCount} more ${
					context.source === "project_folder" ? "sibling" : "linked"
				} conversation${
					context.omittedSiblingCount === 1 ? "" : "s"
				} due to the ${
					context.source === "project_folder" ? "folder" : "continuity"
				} awareness cap.`
			: null;
	const isFolder = context.source === "project_folder";

	return {
		title: isFolder
			? "Project Folder Awareness"
			: "Project Continuity Awareness",
		body: [
			isFolder
				? "Other conversations in this Project Folder, excluding the current conversation. Use as lightweight orientation, not source evidence."
				: "Inferred from memory project/task continuity for unorganized conversations. This is lower authority than an explicit Project Folder and should be used only as lightweight orientation, not source evidence.",
			isFolder
				? null
				: `Memory Project: ${JSON.stringify(context.projectName)}`,
			...entryBlocks,
			omittedLine,
		]
			.filter((value): value is string => Boolean(value))
			.join("\n\n"),
		layer: "task_state",
		protected: false,
		llmCompactible: true,
	};
}

function buildProjectFolderSiblingPromptSection(
	promotion: ProjectFolderSiblingPromotionContext | null,
): PromptContextSection | null {
	if (!promotion) return null;

	const messageLines = promotion.messages.map((message) => {
		const role = message.role === "assistant" ? "assistant" : "user";
		return `${role}: ${clipText(message.content, 900)}`;
	});
	const omittedLine =
		promotion.omittedMessageCount > 0
			? `Omitted recent turns: ${promotion.omittedMessageCount}`
			: null;

	return {
		title: "Project Folder Sibling Context",
		body: [
			"Promoted sibling conversation from the same Project Folder because the current query matched that sibling work.",
			`Project Folder: ${JSON.stringify(promotion.projectName)}`,
			`Title: ${JSON.stringify(promotion.title)}`,
			promotion.objective
				? `Objective: ${JSON.stringify(promotion.objective)}`
				: null,
			promotion.summary
				? `Summary/Checkpoint: ${JSON.stringify(promotion.summary)}`
				: null,
			`Match score: ${promotion.score}`,
			promotion.matchedTerms.length > 0
				? `Matched terms: ${promotion.matchedTerms.join(", ")}`
				: null,
			messageLines.length > 0
				? ["Recent bounded turns:", ...messageLines].join("\n")
				: null,
			omittedLine,
		]
			.filter((value): value is string => Boolean(value))
			.join("\n\n"),
		layer: "task_state",
		protected: false,
		llmCompactible: true,
	};
}

function toTraceInclusionLevel(
	selection: PromptContextSectionSelection,
): LegacyContextTraceSectionInput["inclusionLevel"] {
	if (selection.inclusionLevel === "omitted") return "omitted";
	return selection.trimmed ? "legacy_truncated" : "legacy_full";
}

function resolveBudgetPriority(
	candidate: ContextSelectionCandidate,
): "core" | "support" | "awareness" {
	if (candidate.budgetPriority) return candidate.budgetPriority;
	if (candidate.protected) return "core";
	if (
		candidate.source === "working_set" ||
		candidate.source === "generated_output" ||
		candidate.source === "document"
	) {
		return "support";
	}
	return "awareness";
}

export function selectPromptContext(params: {
	intro: string;
	message: string;
	candidates: ContextSelectionCandidate[];
	targetTokens: number;
	traceSignalReasons?: string[];
	initialCompactionMode?: Parameters<
		typeof compactContextSections
	>[0]["initialCompactionMode"];
}): SelectedPromptContext {
	const priorityOrder = { core: 0, support: 1, awareness: 2 } as const;
	const orderedCandidates = params.candidates
		.map((candidate, index) => ({ candidate, index }))
		.sort((left, right) => {
			const leftPriority = priorityOrder[resolveBudgetPriority(left.candidate)];
			const rightPriority =
				priorityOrder[resolveBudgetPriority(right.candidate)];
			if (leftPriority !== rightPriority) return leftPriority - rightPriority;
			return left.index - right.index;
		})
		.map(({ candidate }) => candidate);
	const sections: PromptContextSection[] = orderedCandidates.map(
		(candidate) => ({
			title: candidate.title,
			body: candidate.body,
			layer: candidate.layer,
			protected: candidate.protected,
		}),
	);
	const compacted = compactContextSections({
		intro: params.intro,
		message: params.message,
		sections,
		targetTokens: params.targetTokens,
		initialCompactionMode: params.initialCompactionMode,
	});
	const candidatesByTitle = new Map(
		orderedCandidates.map((candidate) => [candidate.title, candidate]),
	);
	const contextTraceSections: LegacyContextTraceSectionInput[] = [
		...compacted.sectionSelections.map((selection) => {
			const candidate = candidatesByTitle.get(selection.title);
			return {
				name: selection.title,
				source: candidate?.source ?? "session",
				body: selection.body,
				inclusionLevel: toTraceInclusionLevel(selection),
				itemIds: candidate?.itemIds ?? [],
				itemTitles: candidate?.itemTitles ?? [],
				signalReasons: candidate?.signalReasons ?? [],
				trimmed: selection.trimmed,
				protected: selection.protected,
			};
		}),
		{
			name: "Current User Message",
			source: "user",
			body: params.message,
			inclusionLevel: "legacy_full",
			signalReasons: [
				"current_user_message",
				...(params.traceSignalReasons ?? []),
			],
			trimmed: false,
			protected: false,
		},
	];

	return {
		inputValue: compacted.inputValue,
		compactionApplied: compacted.compactionApplied,
		compactionMode: compacted.compactionMode,
		layersUsed: compacted.layersUsed,
		estimatedTokens: compacted.estimatedTokens,
		contextTraceSections,
		sectionSelections: compacted.sectionSelections,
	};
}

async function loadContextCompressionPromptSnapshot(params: {
	conversationId: string;
	userId: string;
}): Promise<{ snapshot: ContextCompressionSnapshot; body: string } | null> {
	const {
		formatContextCompressionSnapshotForPrompt,
		getLatestValidContextCompressionSnapshot,
	} = await import("../context-compression");
	const snapshot = await getLatestValidContextCompressionSnapshot(params);
	if (!snapshot) return null;
	const body = formatContextCompressionSnapshotForPrompt(snapshot).trim();
	return body ? { snapshot, body } : null;
}

function selectRawSessionMessagesAfterCompressionSnapshot(params: {
	storedMessages: PromptContextMessage[];
	snapshot: ContextCompressionSnapshot | null;
}): PromptContextMessage[] {
	if (!params.snapshot) return params.storedMessages;
	const sourceEndMessageSequence = params.snapshot.sourceEndMessageSequence;
	return params.storedMessages.filter(
		(message) =>
			typeof message.messageSequence === "number" &&
			message.messageSequence > sourceEndMessageSequence,
	);
}

type SessionPromptContext = {
	sessionMessages: PromptContextMessage[];
	storedMessages: PromptContextMessage[];
	summary: string | null;
	honchoContext: HonchoContextInfo | null;
	honchoSnapshot: HonchoContextSnapshot | null;
};

/**
 * Load the local continuity context for a turn: the conversation's own stored
 * messages (with message sequences for compaction-aware filtering) plus its
 * maintained conversation summary. Replaces the former Honcho live/session
 * lookup; the turn path no longer touches Honcho, so the Honcho debug fields
 * are always null.
 */
async function loadSessionPromptContext(params: {
	userId: string;
	conversationId: string;
}): Promise<SessionPromptContext> {
	const [storedMessages, sourceMessages, summary] = await Promise.all([
		listMessages(params.conversationId).catch(() => []),
		listContextCompressionSourceMessages(params.conversationId).catch(() => []),
		getConversationSummary({
			userId: params.userId,
			conversationId: params.conversationId,
		}).catch(() => null),
	]);

	const sequenceByMessageId = new Map(
		sourceMessages.map((message) => [message.id, message.messageSequence]),
	);
	const promptMessages: PromptContextMessage[] = storedMessages
		.map((message) => ({
			id: message.id,
			role: message.role,
			content: message.content,
			createdAt: message.timestamp,
			messageSequence: sequenceByMessageId.get(message.id),
			forkCopy: message.forkCopy,
		}))
		.sort((a, b) => a.createdAt - b.createdAt);

	return {
		sessionMessages: promptMessages,
		storedMessages: promptMessages,
		summary: summary?.summary ?? null,
		honchoContext: null,
		honchoSnapshot: null,
	};
}

function summarizeForkContextProvenance(params: {
	messages: PromptContextMessage[];
	copiedForkPointMessageId?: string | null;
}): ForkContextProvenanceSummary | null {
	const inheritedMessages = params.messages.filter((message) =>
		getPromptMessageForkCopy(message),
	);
	if (inheritedMessages.length === 0) return null;

	const inheritedTurns = selectRecentRoleTurns(
		inheritedMessages,
		(message) => message.role,
		inheritedMessages.length,
	);
	return {
		inheritedMessageCount: inheritedMessages.length,
		inheritedTurnCount: inheritedTurns.length,
		forkLocalMessageCount: Math.max(
			0,
			params.messages.length - inheritedMessages.length,
		),
		sourceConversationIds: Array.from(
			new Set(
				inheritedMessages
					.map(
						(message) =>
							getPromptMessageForkCopy(message)?.sourceConversationId,
					)
					.filter((value): value is string => Boolean(value)),
			),
		),
		sourceMessageIds: Array.from(
			new Set(
				inheritedMessages
					.map((message) => getPromptMessageForkCopy(message)?.sourceMessageId)
					.filter((value): value is string => Boolean(value)),
			),
		),
		copiedForkPointMessageId: params.copiedForkPointMessageId ?? null,
	};
}

function serializePromptMessageContent(message: PromptContextMessage): string {
	const forkCopy = getPromptMessageForkCopy(message);
	if (!forkCopy) return message.content;
	return [
		`[Inherited copied turn from source conversation ${forkCopy.sourceConversationId}; source message ${forkCopy.sourceMessageId}]`,
		message.content,
	].join("\n");
}

function getPromptMessageForkCopy(message: PromptContextMessage) {
	return (
		message.forkCopy ??
		(
			message as PromptContextMessage & {
				fork_copy?: PromptContextMessage["forkCopy"];
			}
		).fork_copy ??
		null
	);
}

function resolveContextLatencyTier(params: {
	message: string;
	attachmentIds: string[];
	activeDocumentArtifactId?: string;
	reuseFrom?: ConstructedContextReuseData;
}): ContextLatencyTierResolution {
	const reasons: string[] = [];
	if (params.reuseFrom) reasons.push("reuse_context");
	if (params.attachmentIds.length > 0) reasons.push("current_attachment");
	if (params.activeDocumentArtifactId) reasons.push("active_document");
	const trimmedMessage = params.message.trim();
	if (trimmedMessage.length > SHALLOW_CONTEXT_MAX_MESSAGE_CHARS) {
		reasons.push("long_message");
	}
	if (
		DEEP_CONTEXT_INTENT_RE.test(trimmedMessage) ||
		META_CONTEXT_INTENT_RE.test(trimmedMessage) ||
		EVIDENCE_ANSWER_INTENT_RE.test(trimmedMessage) ||
		REFINEMENT_FOLLOWUP_INTENT_RE.test(trimmedMessage)
	) {
		reasons.push("context_sensitive_intent");
	}

	if (reasons.length > 0) {
		return { tier: "deep", reasons };
	}
	return { tier: "shallow", reasons: ["simple_turn"] };
}

function buildMinimalContextDebugState(params: {
	honchoContext: HonchoContextInfo | null;
	forkProvenance?: ForkContextProvenanceSummary | null;
}): ContextDebugState {
	return {
		activeTaskId: null,
		activeTaskObjective: null,
		taskLocked: false,
		routingStage: "deterministic",
		routingConfidence: 0,
		verificationStatus: "skipped",
		selectedEvidence: [],
		selectedEvidenceBySource: [],
		pinnedEvidence: [],
		excludedEvidence: [],
		honcho: params.honchoContext,
		forkProvenance: params.forkProvenance ?? null,
	};
}

async function buildShallowConstructedContext(params: {
	userId: string;
	conversationId: string;
	message: string;
	modelContextBudget: ReturnType<typeof deriveModelContextBudget>;
	sessionHistoryBudget: ReturnType<typeof deriveSessionHistoryBudget>;
	targetBudget: number;
	compactionThreshold: number;
	maxModelContext: number;
}): Promise<{
	inputValue: string;
	contextStatus: ConversationContextStatus;
	taskState: import("$lib/types").TaskState | null;
	contextDebug: ContextDebugState | null;
	honchoContext: HonchoContextInfo | null;
	honchoSnapshot: HonchoContextSnapshot | null;
	contextTraceSections: LegacyContextTraceSectionInput[];
	_reuseData?: ConstructedContextReuseData;
}> {
	const projectIdPromise = getConversationProjectId(
		params.userId,
		params.conversationId,
	).catch(() => null);
	const [
		sessionContext,
		contextCompressionPromptSnapshot,
		activeMemoryProfileSection,
	] = await Promise.all([
		loadSessionPromptContext({
			userId: params.userId,
			conversationId: params.conversationId,
		}),
		loadContextCompressionPromptSnapshot({
			userId: params.userId,
			conversationId: params.conversationId,
		}).catch(() => null),
		projectIdPromise.then((projectId) =>
			buildActiveMemoryProfilePromptSection({
				userId: params.userId,
				conversationId: params.conversationId,
				applicableScopes: buildApplicableMemoryProfileScopes({
					conversationId: params.conversationId,
					projectId,
				}),
				modelContextBudget: params.modelContextBudget,
			}),
		),
	]);
	const {
		sessionMessages,
		storedMessages,
		summary: sessionSummary,
		honchoContext,
		honchoSnapshot,
	} = sessionContext;
	const promptSessionMessages = contextCompressionPromptSnapshot
		? selectRawSessionMessagesAfterCompressionSnapshot({
				storedMessages,
				snapshot: contextCompressionPromptSnapshot.snapshot,
			})
		: sessionMessages;
	const forkProvenanceMessages =
		storedMessages.length > 0 ? storedMessages : sessionMessages;
	const hasForkCopyProvenance = forkProvenanceMessages.some((message) =>
		getPromptMessageForkCopy(message),
	);
	const forkOrigin = hasForkCopyProvenance
		? await getConversationForkOrigin(params.conversationId).catch(() => null)
		: null;
	const forkProvenance = summarizeForkContextProvenance({
		messages: forkProvenanceMessages,
		copiedForkPointMessageId: forkOrigin?.copiedForkPointMessageId ?? null,
	});
	const allTurns = selectRecentRoleTurns(
		promptSessionMessages,
		(message) => message.role,
		promptSessionMessages.length,
	);
	const sessionTurnContext = serializeBudgetedRoleTurns({
		turns: allTurns,
		resolveRole: (message) => message.role,
		resolveContent: serializePromptMessageContent,
		maxTokens: params.sessionHistoryBudget.totalBudget,
	});
	const sections: PromptContextSection[] = [];

	if (contextCompressionPromptSnapshot) {
		sections.push({
			title: "Context Compression Snapshot",
			body: contextCompressionPromptSnapshot.body,
			layer: "session",
			protected: true,
			llmCompactible: true,
		});
	}

	if (sessionSummary?.trim()) {
		sections.push({
			title: "Session Summary",
			body: truncateToTokenBudget(sessionSummary, 1600),
			layer: "session",
			llmCompactible: true,
		});
	}
	if (sessionTurnContext.body) {
		sections.push({
			title: "Honcho Session Context",
			body: sessionTurnContext.body,
			layer: "session",
			protected: true,
			llmCompactible: true,
		});
	}
	if (activeMemoryProfileSection) {
		sections.push(activeMemoryProfileSection);
	}

	const selectedPromptContext = selectPromptContext({
		intro: "Context from your recent conversation:",
		message: params.message,
		candidates: buildContextSelectionCandidates({ sections }),
		targetTokens: params.targetBudget,
		initialCompactionMode: "none",
		traceSignalReasons: [
			"context_latency_tier:shallow",
			"context_latency_reason:simple_turn",
		],
	});
	const status = await updateConversationContextStatus({
		conversationId: params.conversationId,
		userId: params.userId,
		estimatedTokens: selectedPromptContext.estimatedTokens,
		compactionApplied:
			selectedPromptContext.compactionApplied ||
			selectedPromptContext.compactionMode !== "none",
		contextLimits: {
			maxModelContext: params.maxModelContext,
			compactionUiThreshold: params.compactionThreshold,
			targetConstructedContext: params.targetBudget,
		},
		compactionMode: selectedPromptContext.compactionMode,
		routingStage: "deterministic",
		routingConfidence: 0,
		verificationStatus: "skipped",
		layersUsed: selectedPromptContext.layersUsed,
		workingSetCount: 0,
		workingSetArtifactIds: [],
		workingSetApplied: false,
		taskStateApplied: false,
		promptArtifactCount: 0,
		recentTurnCount: sessionTurnContext.includedTurnCount,
		summary: sessionSummary || null,
	});

	return {
		inputValue: selectedPromptContext.inputValue,
		contextStatus: status,
		taskState: null,
		contextDebug: buildMinimalContextDebugState({
			honchoContext,
			forkProvenance,
		}),
		honchoContext,
		honchoSnapshot,
		contextTraceSections: selectedPromptContext.contextTraceSections,
	};
}

export async function buildConstructedContext(params: {
	userId: string;
	conversationId: string;
	message: string;
	attachmentIds?: string[];
	activeDocumentArtifactId?: string;
	attachmentTraceId?: string;
	modelId?: string;
	contextLimits?: {
		maxModelContext: number;
		compactionUiThreshold: number;
		targetConstructedContext: number;
	};
	reuseFrom?: ConstructedContextReuseData;
}): Promise<{
	inputValue: string;
	contextStatus: ConversationContextStatus;
	taskState: import("$lib/types").TaskState | null;
	contextDebug: ContextDebugState | null;
	honchoContext: HonchoContextInfo | null;
	honchoSnapshot: HonchoContextSnapshot | null;
	contextTraceSections: LegacyContextTraceSectionInput[];
	_reuseData?: ConstructedContextReuseData;
}> {
	const attachmentIds = params.attachmentIds ?? [];
	const targetBudget =
		params.contextLimits?.targetConstructedContext ??
		getTargetConstructedContext(params.modelId);
	const compactionThreshold =
		params.contextLimits?.compactionUiThreshold ??
		getCompactionUiThreshold(params.modelId);
	const maxModelContext =
		params.contextLimits?.maxModelContext ?? getMaxModelContext(params.modelId);
	const modelContextBudget = deriveModelContextBudget({
		maxModelContext,
		targetConstructedContext: targetBudget,
		compactionUiThreshold: compactionThreshold,
	});
	const sessionHistoryBudget = deriveSessionHistoryBudget({
		contextBudget: modelContextBudget,
		minTotalBudget: HONCHO_LIVE_CONTEXT_TOKENS,
		minRecentTurnCount: RECENT_TURN_COUNT,
	});
	const latencyTier = resolveContextLatencyTier({
		message: params.message,
		attachmentIds,
		activeDocumentArtifactId: params.activeDocumentArtifactId,
		reuseFrom: params.reuseFrom,
	});
	if (latencyTier.tier === "shallow") {
		return buildShallowConstructedContext({
			userId: params.userId,
			conversationId: params.conversationId,
			message: params.message,
			modelContextBudget,
			sessionHistoryBudget,
			targetBudget,
			compactionThreshold,
			maxModelContext,
		});
	}
	const [
		sessionContext,
		resolvedAttachments,
		conversationSourceArtifactIds,
		allSourceArtifactNames,
		linkedContextSources,
		workingSetArtifacts,
		projectFolderLabel,
		projectFolderReferenceContext,
		projectFolderSiblingPromotion,
		forkOrigin,
		contextCompressionPromptSnapshot,
		projectId,
	] = await Promise.all([
		loadSessionPromptContext({
			userId: params.userId,
			conversationId: params.conversationId,
		}),
		resolvePromptAttachmentArtifacts(params.userId, attachmentIds),
		listConversationSourceArtifactIds(
			params.userId,
			params.conversationId,
		).catch(() => []),
		listConversationSourceArtifactNames(
			params.userId,
			params.conversationId,
		).catch(() => []),
		listConversationLinkedContextSources({
			userId: params.userId,
			conversationId: params.conversationId,
		}).catch(() => []),
		selectWorkingSetArtifactsForPrompt(
			params.userId,
			params.conversationId,
			params.message,
			attachmentIds,
			params.activeDocumentArtifactId,
		).catch(() => []),
		getConversationProjectLabel(params.userId, params.conversationId).catch(
			() => null,
		),
		getProjectReferenceContext({
			userId: params.userId,
			conversationId: params.conversationId,
		}).catch(() => null),
		selectProjectFolderSiblingPromotion({
			userId: params.userId,
			conversationId: params.conversationId,
			query: params.message,
		}).catch(() => null),
		getConversationForkOrigin(params.conversationId).catch(() => null),
		loadContextCompressionPromptSnapshot({
			userId: params.userId,
			conversationId: params.conversationId,
		}).catch(() => null),
		getConversationProjectId(params.userId, params.conversationId).catch(
			() => null,
		),
	]);
	const {
		sessionMessages,
		storedMessages,
		summary: sessionSummary,
		honchoContext,
		honchoSnapshot,
	} = sessionContext;
	const promptSessionMessages = contextCompressionPromptSnapshot
		? selectRawSessionMessagesAfterCompressionSnapshot({
				storedMessages,
				snapshot: contextCompressionPromptSnapshot.snapshot,
			})
		: sessionMessages;
	const forkProvenanceMessages =
		storedMessages.length > 0 ? storedMessages : sessionMessages;
	const forkProvenance = summarizeForkContextProvenance({
		messages: forkProvenanceMessages,
		copiedForkPointMessageId: forkOrigin?.copiedForkPointMessageId ?? null,
	});
	const currentAttachments = resolvedAttachments.promptArtifacts;
	const currentAttachmentIds = new Set(
		currentAttachments.map((artifact) => artifact.id),
	);
	const requestedAttachmentIds = new Set(attachmentIds);
	const carriedForwardSourceIds = conversationSourceArtifactIds.filter(
		(artifactId) =>
			!requestedAttachmentIds.has(artifactId) &&
			!currentAttachmentIds.has(artifactId),
	);

	// Parallel: resolve linked sources and carried-forward attachments concurrently
	const [linkedSourceArtifacts, carriedForwardResolution] = await Promise.all([
		resolveLinkedSourcePromptArtifacts({
			userId: params.userId,
			linkedSources: linkedContextSources,
		}).catch(() => [] as Artifact[]),
		carriedForwardSourceIds.length > 0
			? resolvePromptAttachmentArtifacts(
					params.userId,
					carriedForwardSourceIds,
				).catch(() => ({
					displayArtifacts: [] as Artifact[],
					promptArtifacts: [] as Artifact[],
					items: [] as Array<{ id: string; requestedArtifactId: string }>,
					unresolvedItems: [] as Array<{ requestedArtifactId: string }>,
				}))
			: Promise.resolve(null),
	]);

	const resolvedCarriedForwardAttachments = (
		carriedForwardResolution?.promptArtifacts ?? []
	).filter((artifact) => !currentAttachmentIds.has(artifact.id));
	if (attachmentIds.length > 0 && getConfig().contextDiagnosticsDebug) {
		console.info("[CONTEXT] Attachment resolution", {
			conversationId: params.conversationId,
			requestedAttachmentIds: attachmentIds,
			displayArtifactCount: resolvedAttachments.displayArtifacts.length,
			promptArtifactCount: currentAttachments.length,
			unresolvedAttachmentIds: resolvedAttachments.unresolvedItems.map(
				(item) => item.requestedArtifactId,
			),
		});
	}
	if (resolvedAttachments.unresolvedItems.length > 0) {
		throw new AttachmentReadinessError(
			"One or more attached files could not be prepared for chat. Remove the file or upload a supported text-readable document.",
			resolvedAttachments.unresolvedItems.map(
				(item) => item.requestedArtifactId,
			),
		);
	}
	const retrievalSelection = resolveWorkingDocumentSelection({
		artifacts: dedupeById([
			...currentAttachments,
			...linkedSourceArtifacts,
			...workingSetArtifacts,
		]),
		message: params.message,
		attachmentIds,
		activeDocumentArtifactId: params.activeDocumentArtifactId,
		currentConversationId: params.conversationId,
	});

	let currentMessageEmbedding: number[] = [];
	let previousMessageEmbedding: number[] = [];
	const previousUserMessage = sessionMessages
		.slice()
		.reverse()
		.find((message) => message.role === "user")?.content;

	// Fire topic-shift embedding as a non-blocking background promise.
	// If TEI resolves before we need it, we get topic-shift detection for free.
	// If not, we skip it — fallback handles empty embeddings gracefully.
	let topicShiftResult: number[][] | null = null;
	if (previousUserMessage && params.message) {
		embedTexts([params.message, previousUserMessage])
			.then((r) => {
				topicShiftResult = r;
			})
			.catch(() => {});
	}

	// Yield a microtask tick so the .then() above can run if the promise
	// was already resolved (e.g. TEI cache hit or extremely fast embedder).
	await new Promise<void>((resolve) => setTimeout(resolve, 0));

	const topicShiftEmbeddings = topicShiftResult ?? [];
	if (topicShiftEmbeddings.length >= 2) {
		currentMessageEmbedding = topicShiftEmbeddings[0] ?? [];
		previousMessageEmbedding = topicShiftEmbeddings[1] ?? [];
	}

	const topicShift = detectTopicShift({
		currentMessageEmbedding,
		previousMessageEmbedding,
	});

	const topicShiftSuppressesCarryover = shouldSuppressCarryover({
		isShift: topicShift.isShift,
		hasExplicitResetSignal: retrievalSelection.retrieval.hasExplicitResetSignal,
		turnsSinceLastShift: 0,
	});
	const suppressCarryover =
		retrievalSelection.retrieval.suppressGeneratedCarryover ||
		topicShiftSuppressesCarryover;
	const carriedForwardAttachments = suppressCarryover
		? []
		: resolvedCarriedForwardAttachments;
	const allAttachmentContextIds = new Set([
		...attachmentIds,
		...currentAttachments.map((artifact) => artifact.id),
		...linkedSourceArtifacts.map((artifact) => artifact.id),
		...(suppressCarryover ? [] : carriedForwardSourceIds),
		...carriedForwardAttachments.map((artifact) => artifact.id),
	]);

	const relevantArtifacts = params.reuseFrom
		? params.reuseFrom.relevantArtifacts
		: await findRelevantKnowledgeArtifacts({
				userId: params.userId,
				query: params.message,
				excludeConversationId: params.conversationId,
				currentConversationId: params.conversationId,
				limit: deriveRelevantKnowledgeArtifactLimit(targetBudget),
				preferredArtifactId:
					retrievalSelection.retrieval.preferredArtifactId ?? undefined,
				preferredGeneratedFamilyId:
					retrievalSelection.retrieval.preferredGeneratedFamilyId,
				suppressGeneratedCarryover: suppressCarryover,
			}).catch(() => [] as Artifact[]);
	const contextSelection = resolveWorkingDocumentSelection({
		artifacts: dedupeById([
			...currentAttachments,
			...linkedSourceArtifacts,
			...workingSetArtifacts,
			...relevantArtifacts,
		]),
		message: params.message,
		attachmentIds,
		activeDocumentArtifactId: params.activeDocumentArtifactId,
		preferredGeneratedArtifactId:
			retrievalSelection.retrieval.preferredArtifactId,
		currentConversationId: params.conversationId,
	});
	const documentFocused = contextSelection.documentFocused;

	const preparedContext = params.reuseFrom
		? params.reuseFrom.preparedContext
		: await prepareTaskContext({
				userId: params.userId,
				conversationId: params.conversationId,
				message: params.message,
				attachmentIds,
				activeDocumentArtifactId: params.activeDocumentArtifactId,
				targetConstructedContext: targetBudget,
				currentAttachments,
				workingSetArtifacts,
				relevantArtifacts,
			}).catch(() => ({
				taskState: null as import("$lib/types").TaskState | null,
				routingStage: "deterministic" as const,
				routingConfidence: 0,
				verificationStatus: "fallback" as const,
				selectedArtifacts: dedupeById([
					...currentAttachments,
					...workingSetArtifacts,
				]),
				pinnedArtifactIds: [] as string[],
				excludedArtifactIds: [] as string[],
			}));
	const taskState = preparedContext.taskState;
	const selectedEvidence = preparedContext.selectedArtifacts.filter(
		(artifact) => !allAttachmentContextIds.has(artifact.id),
	);
	const pinnedArtifactIds = new Set(preparedContext.pinnedArtifactIds);

	const promptArtifacts = new Map<string, Artifact>();
	for (const artifact of [
		...currentAttachments,
		...linkedSourceArtifacts,
		...carriedForwardAttachments,
		...selectedEvidence,
	]) {
		promptArtifacts.set(artifact.id, artifact);
	}
	const documentContextIntent = inferDocumentContextIntent({
		message: params.message,
		documentFocused,
		hasCurrentAttachments: currentAttachments.length > 0,
		hasCarriedForwardAttachments: carriedForwardAttachments.length > 0,
		hasActiveDocument: Boolean(params.activeDocumentArtifactId),
		hasLinkedSources: linkedSourceArtifacts.length > 0,
	});
	const documentDepthBudget = deriveDocumentContextDepthBudget({
		contextBudget: modelContextBudget,
		documentCount: promptArtifacts.size,
		intent: documentContextIntent,
	});
	const [artifactSnippets, activeMemoryProfileSection] = await Promise.all([
		params.reuseFrom
			? Promise.resolve(params.reuseFrom.artifactSnippets)
			: getPromptArtifactSnippets({
					userId: params.userId,
					artifacts: Array.from(promptArtifacts.values()),
					query: params.message,
					perArtifactLimit: documentDepthBudget.perArtifactLimit,
					perArtifactCharBudget: documentDepthBudget.perArtifactCharBudget,
					totalCharBudget: documentDepthBudget.totalBudget,
					useFullContent: documentDepthBudget.useFullContent,
				}).catch(() => new Map<string, string>()),
		buildActiveMemoryProfilePromptSection({
			userId: params.userId,
			conversationId: params.conversationId,
			applicableScopes: buildApplicableMemoryProfileScopes({
				conversationId: params.conversationId,
				projectId,
				documentArtifactIds: [
					params.activeDocumentArtifactId,
					...promptArtifacts.keys(),
				],
			}),
			modelContextBudget,
		}),
	]);

	const allTurns = selectRecentRoleTurns(
		promptSessionMessages,
		(message) => message.role,
		promptSessionMessages.length,
	);

	const sessionTurnContext = serializeBudgetedRoleTurns({
		turns: allTurns,
		resolveRole: (message) => message.role,
		resolveContent: serializePromptMessageContent,
		maxTokens: sessionHistoryBudget.totalBudget,
	});
	const recentTurnCount = sessionTurnContext.includedTurnCount;
	const sections: PromptContextSection[] = [];
	const projectFolderSection =
		buildProjectFolderPromptSection(projectFolderLabel);
	const projectFolderAwarenessSection = buildProjectAwarenessPromptSection(
		projectFolderReferenceContext,
	);
	const projectFolderSiblingSection = buildProjectFolderSiblingPromptSection(
		projectFolderSiblingPromotion,
	);

	if (projectFolderSection) {
		sections.push(projectFolderSection);
	}
	if (projectFolderAwarenessSection) {
		sections.push(projectFolderAwarenessSection);
	}
	if (projectFolderSiblingSection) {
		sections.push(projectFolderSiblingSection);
	}

	if (taskState) {
		sections.push({
			title: "Task State",
			body: formatTaskStateForPrompt(taskState),
			layer: "task_state",
			protected: true,
		});
	}

	const attachmentContext =
		currentAttachments.length > 0
			? serializeBudgetedAttachments({
					artifacts: currentAttachments,
					snippets: buildCurrentAttachmentSnippetMap({
						artifacts: currentAttachments,
						snippets: artifactSnippets,
					}),
					message: params.message,
					...deriveCurrentTurnAttachmentBudget({
						contextBudget: modelContextBudget,
						attachmentCount: currentAttachments.length,
						minTotalBudget: ATTACHMENT_PROMPT_TOKEN_BUDGET,
						minPerAttachmentBudget: documentFocused
							? ATTACHMENT_TASK_PER_ATTACHMENT_TOKEN_BUDGET
							: ATTACHMENT_EXCERPT_PER_ATTACHMENT_TOKEN_BUDGET,
					}),
				})
			: null;
	const serializedCurrentAttachments = attachmentContext?.body ?? "";
	const serializedAttachmentBody = extractSerializedAttachmentBody(
		serializedCurrentAttachments,
	);

	if (currentAttachments.length > 0) {
		logAttachmentTrace("constructed_context", {
			traceId: params.attachmentTraceId ?? null,
			conversationId: params.conversationId,
			emitted: true,
			promptArtifactIds: currentAttachments.map((artifact) => artifact.id),
			promptArtifactNames: currentAttachments.map((artifact) => artifact.name),
			sectionTokenEstimate: estimateTokenCount(serializedCurrentAttachments),
			...summarizeAttachmentTraceText(serializedAttachmentBody, 420),
		});
		if (!hasMeaningfulAttachmentText(serializedAttachmentBody)) {
			throw new AttachmentReadinessError(
				"Attached file content was missing from the constructed context. Remove the file and upload it again before sending.",
				attachmentIds,
			);
		}
		sections.push({
			title: "Current Attachments",
			body: serializedCurrentAttachments,
			layer: "documents",
			protected: true,
		});
	}
	if (attachmentIds.length > 0) {
		if (getConfig().contextDiagnosticsDebug) {
			console.info("[CONTEXT] Attachment section emitted", {
				conversationId: params.conversationId,
				emitted: currentAttachments.length > 0,
				promptArtifactCount: currentAttachments.length,
			});
		}
		if (currentAttachments.length === 0) {
			logAttachmentTrace("constructed_context", {
				traceId: params.attachmentTraceId ?? null,
				conversationId: params.conversationId,
				emitted: false,
				promptArtifactIds: [],
				promptArtifactNames: [],
				sectionTokenEstimate: 0,
				contentLength: 0,
				contentPreview: null,
				contentHash: null,
			});
		}
	}

	const linkedSourceContext =
		linkedSourceArtifacts.length > 0
			? serializeWorkingSetArtifacts({
					artifacts: linkedSourceArtifacts,
					snippets: artifactSnippets,
					totalBudget: documentDepthBudget.totalBudget,
					documentBudget: documentDepthBudget.perArtifactCharBudget,
					outputBudget: documentDepthBudget.perArtifactCharBudget,
				})
			: "";
	if (linkedSourceContext.trim()) {
		sections.push({
			title: "Linked Sources",
			body: linkedSourceContext,
			layer: "documents",
			protected: true,
		});
	}

	const carriedForwardAttachmentContext =
		carriedForwardAttachments.length > 0
			? (() => {
					const carriedForwardBudget = deriveExplicitSourceSetBudget({
						contextBudget: modelContextBudget,
						sourceCount: carriedForwardAttachments.length,
						minTotalBudget: ATTACHMENT_PROMPT_TOKEN_BUDGET,
						minPerSourceBudget: documentFocused
							? ATTACHMENT_TASK_PER_ATTACHMENT_TOKEN_BUDGET
							: ATTACHMENT_EXCERPT_PER_ATTACHMENT_TOKEN_BUDGET,
					});
					return serializeBudgetedAttachments({
						artifacts: carriedForwardAttachments,
						snippets: buildCurrentAttachmentSnippetMap({
							artifacts: carriedForwardAttachments,
							snippets: artifactSnippets,
						}),
						message: params.message,
						totalBudget: carriedForwardBudget.totalBudget,
						taskPerAttachmentBudget: carriedForwardBudget.perSourceBudget,
						excerptPerAttachmentBudget: carriedForwardBudget.perSourceBudget,
					});
				})()
			: null;
	if (carriedForwardAttachmentContext?.body) {
		sections.push({
			title: "Attached Sources",
			body: carriedForwardAttachmentContext.body,
			layer: "documents",
			protected: true,
		});
	}

	const sourceArtifactNames = allSourceArtifactNames ?? [];
	if (sourceArtifactNames.length > 0) {
		const registryBody = sourceArtifactNames
			.map((f) => `- ${f.name}`)
			.join("\n");
		sections.push({
			title: "Conversation Files",
			body: registryBody,
			layer: "documents",
			protected: true,
		});
	}

	if (selectedEvidence.length > 0) {
		const evidenceBudget = deriveExplicitSourceSetBudget({
			contextBudget: modelContextBudget,
			sourceCount: selectedEvidence.length,
			minTotalBudget: WORKING_SET_PROMPT_TOKEN_BUDGET,
			minPerSourceBudget: Math.min(
				WORKING_SET_DOCUMENT_TOKEN_BUDGET,
				WORKING_SET_OUTPUT_TOKEN_BUDGET,
			),
		});
		const retrievedEvidenceBudget = Math.min(
			evidenceBudget.totalBudget,
			documentDepthBudget.totalBudget,
		);
		const retrievedEvidencePerSourceBudget = Math.min(
			evidenceBudget.perSourceBudget,
			documentDepthBudget.perArtifactCharBudget,
		);
		sections.push({
			title: "Retrieved Evidence",
			body: serializeWorkingSetArtifacts({
				artifacts: selectedEvidence,
				snippets: artifactSnippets,
				totalBudget: retrievedEvidenceBudget,
				documentBudget: retrievedEvidencePerSourceBudget,
				outputBudget: retrievedEvidencePerSourceBudget,
			}),
			layer: "working_set",
			protected: selectedEvidence.some((artifact) =>
				pinnedArtifactIds.has(artifact.id),
			),
		});
	}

	if (contextCompressionPromptSnapshot) {
		sections.push({
			title: "Context Compression Snapshot",
			body: contextCompressionPromptSnapshot.body,
			layer: "session",
			protected: true,
			llmCompactible: true,
		});
	}

	if (sessionSummary?.trim()) {
		sections.push({
			title: "Session Summary",
			body: truncateToTokenBudget(sessionSummary, 1600),
			layer: "session",
			llmCompactible: true,
		});
	}

	if (sessionTurnContext.body) {
		sections.push({
			title: "Honcho Session Context",
			body: sessionTurnContext.body,
			layer: "session",
			protected: true,
			llmCompactible: true,
		});
	}

	if (activeMemoryProfileSection) {
		sections.push(activeMemoryProfileSection);
	}

	const effectiveSections = [
		...(await rerankHistoricalSections({
			enabled: canUseTeiReranker(),
			message: params.message,
			taskObjective: taskState?.objective ?? null,
			sections,
			rerankSections: async ({ query, candidates }) => {
				const reranked = await rerankItems({
					query,
					items: candidates,
					getText: (section) =>
						[
							section.title,
							section.layer ? `Layer: ${section.layer}` : null,
							truncateToTokenBudget(section.body, 240),
						]
							.filter((value): value is string => Boolean(value))
							.join("\n\n"),
					maxTexts: Math.min(6, candidates.length),
				});
				if (!reranked || reranked.items.length === 0) {
					return null;
				}

				const keepCount = Math.max(
					2,
					Math.min(4, Math.ceil(candidates.length / 2)),
				);
				return {
					selectedTitles: reranked.items
						.slice(0, keepCount)
						.map(({ item }) => item.title),
					confidence: reranked.confidence,
				};
			},
			logPrefix: "[CONTEXT]",
		}).catch(() => sections)),
	];

	const intro = suppressCarryover
		? "You are receiving a compacted conversation context bundle. Use it as the working context for this turn."
		: "Context from your conversation history:";

	const selectedPromptContext = selectPromptContext({
		intro,
		message: params.message,
		candidates: buildContextSelectionCandidates({
			sections: effectiveSections,
			attachmentContext,
			carriedForwardAttachmentContext,
			projectFolderSiblingPromotion,
			documentContextIntent,
			documentDepthBudget,
			linkedSourceItems: linkedSourceArtifacts.map((artifact) => ({
				id: artifact.id,
				title: artifact.name,
			})),
			evidenceItems: selectedEvidence.map((artifact) => ({
				id: artifact.id,
				title: artifact.name,
				pinned: pinnedArtifactIds.has(artifact.id),
			})),
		}),
		targetTokens: targetBudget,
		initialCompactionMode: "none",
		traceSignalReasons: [
			"context_latency_tier:deep",
			...latencyTier.reasons.map(
				(reason) => `context_latency_reason:${reason}`,
			),
		],
	});

	const status = await updateConversationContextStatus({
		conversationId: params.conversationId,
		userId: params.userId,
		estimatedTokens: selectedPromptContext.estimatedTokens,
		compactionApplied:
			selectedPromptContext.compactionApplied ||
			selectedPromptContext.compactionMode !== "none",
		contextLimits: {
			maxModelContext,
			compactionUiThreshold: compactionThreshold,
			targetConstructedContext: targetBudget,
		},
		compactionMode: selectedPromptContext.compactionMode,
		routingStage: preparedContext.routingStage,
		routingConfidence: preparedContext.routingConfidence,
		verificationStatus: preparedContext.verificationStatus,
		layersUsed: selectedPromptContext.layersUsed,
		workingSetCount: selectedEvidence.length,
		workingSetArtifactIds: selectedEvidence.map((artifact) => artifact.id),
		workingSetApplied: selectedEvidence.length > 0,
		taskStateApplied: Boolean(taskState),
		promptArtifactCount: promptArtifacts.size,
		recentTurnCount,
		summary: sessionSummary || null,
	});

	return {
		inputValue: selectedPromptContext.inputValue,
		contextStatus: status,
		taskState,
		contextDebug: await getContextDebugState(
			params.userId,
			params.conversationId,
		)
			.then((debug) =>
				debug
					? {
							...debug,
							honcho: honchoContext,
							forkProvenance,
						}
					: ({
							activeTaskId: null,
							activeTaskObjective: null,
							taskLocked: false,
							routingStage: preparedContext.routingStage,
							routingConfidence: preparedContext.routingConfidence,
							verificationStatus: preparedContext.verificationStatus,
							selectedEvidence: [],
							selectedEvidenceBySource: [],
							pinnedEvidence: [],
							excludedEvidence: [],
							honcho: honchoContext,
							forkProvenance,
						} satisfies ContextDebugState),
			)
			.catch(() =>
				forkProvenance || honchoContext
					? ({
							activeTaskId: null,
							activeTaskObjective: null,
							taskLocked: false,
							routingStage: preparedContext.routingStage,
							routingConfidence: preparedContext.routingConfidence,
							verificationStatus: preparedContext.verificationStatus,
							selectedEvidence: [],
							selectedEvidenceBySource: [],
							pinnedEvidence: [],
							excludedEvidence: [],
							honcho: honchoContext,
							forkProvenance,
						} satisfies ContextDebugState)
					: null,
			),
		honchoContext,
		honchoSnapshot,
		contextTraceSections: selectedPromptContext.contextTraceSections,
		_reuseData: params.reuseFrom
			? undefined
			: { relevantArtifacts, preparedContext, artifactSnippets },
	};
}
