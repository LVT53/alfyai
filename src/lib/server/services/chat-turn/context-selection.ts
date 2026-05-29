import type { MemoryLayer } from "$lib/types";
import type {
	Artifact,
	ContextDebugState,
	ConversationContextStatus,
	ForkContextProvenanceSummary,
	HonchoContextInfo,
	HonchoContextSnapshot,
	LinkedContextSource,
} from "$lib/types";
import {
	compactContextSections,
	type BudgetedAttachmentContext,
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
import { estimateTokenCount } from "$lib/utils/tokens";
import { getConfig } from "../../config-store";
import {
	hasMeaningfulAttachmentText,
	logAttachmentTrace,
	summarizeAttachmentTraceText,
} from "../attachment-trace";
import type { ContextCompressionSnapshot } from "../context-compression";
import { getConversationForkOrigin } from "../conversation-forks";
import { loadHonchoPromptContext, type PromptContextMessage } from "../honcho";
import {
	AttachmentReadinessError,
	findRelevantKnowledgeArtifacts,
	getArtifactsForUser,
	getCompactionUiThreshold,
	getMaxModelContext,
	getTargetConstructedContext,
	listConversationSourceArtifactIds,
	resolvePromptAttachmentArtifacts,
	selectWorkingSetArtifactsForPrompt,
	updateConversationContextStatus,
	WORKING_SET_DOCUMENT_TOKEN_BUDGET,
	WORKING_SET_OUTPUT_TOKEN_BUDGET,
	WORKING_SET_PROMPT_TOKEN_BUDGET,
} from "../knowledge";
import { listConversationLinkedContextSources } from "../linked-context-sources";
import { getConversationProjectLabel } from "../projects";
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
	/\b(summarize|summarise|summary|compare|extract|review|check|rewrite|revise|edit|analyze|analyse|translate|convert|outline)\b|what\s+does\s+(it|this|that|the\s+[\w\s-]{0,80}?(document|doc|file|pdf|policy|report|brief))\s+say\s+about/i;
const DOCUMENT_ANSWER_INTENT_RE =
	/\b(according to|based on|from the|from this|from that|what|when|where|who|why|how|which)\b/i;
const DOCUMENT_REFERENCE_RE =
	/\b(attachment|attached|source|document|doc|file|pdf|policy|report|brief|workspace|this|that|it)\b|\/document\b/i;

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

export function deriveRelevantKnowledgeArtifactLimit(
	targetConstructedContext: number,
): number {
	if (!Number.isFinite(targetConstructedContext) || targetConstructedContext <= 0) {
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
			source: promotedSibling ? "memory" : inferContextTraceSourceForSection(section),
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
							? ["linked_context_source:direct", ...documentContextSignalReasons]
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
												? ["honcho_baseline_profile:live"]
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
	const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
	const resolved: Artifact[] = [];
	const seen = new Set<string>();

	for (const source of params.linkedSources) {
		const promptArtifactId = source.promptArtifactId ?? source.displayArtifactId;
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

function buildProjectFolderPromptSection(label: string | null): PromptContextSection | null {
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
		title: isFolder ? "Project Folder Awareness" : "Project Continuity Awareness",
		body: [
			isFolder
				? "Other conversations in this Project Folder, excluding the current conversation. Use as lightweight orientation, not source evidence."
				: "Inferred from memory project/task continuity for unorganized conversations. This is lower authority than an explicit Project Folder and should be used only as lightweight orientation, not source evidence.",
			isFolder ? null : `Memory Project: ${JSON.stringify(context.projectName)}`,
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
	initialCompactionMode?: Parameters<typeof compactContextSections>[0]["initialCompactionMode"];
}): SelectedPromptContext {
	const priorityOrder = { core: 0, support: 1, awareness: 2 } as const;
	const orderedCandidates = params.candidates
		.map((candidate, index) => ({ candidate, index }))
		.sort((left, right) => {
			const leftPriority = priorityOrder[resolveBudgetPriority(left.candidate)];
			const rightPriority = priorityOrder[resolveBudgetPriority(right.candidate)];
			if (leftPriority !== rightPriority) return leftPriority - rightPriority;
			return left.index - right.index;
		})
		.map(({ candidate }) => candidate);
	const sections: PromptContextSection[] = orderedCandidates.map((candidate) => ({
		title: candidate.title,
		body: candidate.body,
		layer: candidate.layer,
		protected: candidate.protected,
	}));
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
			signalReasons: ["current_user_message"],
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

function summarizeForkContextProvenance(params: {
	messages: PromptContextMessage[];
	copiedForkPointMessageId?: string | null;
}): ForkContextProvenanceSummary | null {
	const inheritedMessages = params.messages.filter((message) => message.forkCopy);
	if (inheritedMessages.length === 0) return null;

	const inheritedTurns = selectRecentRoleTurns(
		inheritedMessages,
		(message) => message.role,
		inheritedMessages.length,
	);
	return {
		inheritedMessageCount: inheritedMessages.length,
		inheritedTurnCount: inheritedTurns.length,
		forkLocalMessageCount: Math.max(0, params.messages.length - inheritedMessages.length),
		sourceConversationIds: Array.from(
			new Set(
				inheritedMessages
					.map((message) => message.forkCopy?.sourceConversationId)
					.filter((value): value is string => Boolean(value)),
			),
		),
		sourceMessageIds: Array.from(
			new Set(
				inheritedMessages
					.map((message) => message.forkCopy?.sourceMessageId)
					.filter((value): value is string => Boolean(value)),
			),
		),
		copiedForkPointMessageId: params.copiedForkPointMessageId ?? null,
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
}): Promise<{
	inputValue: string;
	contextStatus: ConversationContextStatus;
	taskState: import("$lib/types").TaskState | null;
	contextDebug: ContextDebugState | null;
	honchoContext: HonchoContextInfo | null;
	honchoSnapshot: HonchoContextSnapshot | null;
	contextTraceSections: LegacyContextTraceSectionInput[];
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
	const [
		sessionContext,
		resolvedAttachments,
		conversationSourceArtifactIds,
		linkedContextSources,
		workingSetArtifacts,
		projectFolderLabel,
		projectFolderReferenceContext,
		projectFolderSiblingPromotion,
		forkOrigin,
		contextCompressionPromptSnapshot,
	] = await Promise.all([
		loadHonchoPromptContext({
			userId: params.userId,
			conversationId: params.conversationId,
			message: params.message,
			liveContextTokens: sessionHistoryBudget.totalBudget,
		}),
		resolvePromptAttachmentArtifacts(params.userId, attachmentIds),
		listConversationSourceArtifactIds(params.userId, params.conversationId).catch(
			() => [],
		),
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
	]);
	const {
		sessionMessages,
		storedMessages,
		summary: sessionSummary,
		peerContext,
		honchoContext,
		honchoSnapshot,
	} = sessionContext;
	const promptSessionMessages = contextCompressionPromptSnapshot
		? selectRawSessionMessagesAfterCompressionSnapshot({
				storedMessages,
				snapshot: contextCompressionPromptSnapshot.snapshot,
			})
		: sessionMessages;
	const forkProvenance = summarizeForkContextProvenance({
		messages: sessionMessages,
		copiedForkPointMessageId: forkOrigin?.copiedForkPointMessageId ?? null,
	});
	const currentAttachments = resolvedAttachments.promptArtifacts;
	const linkedSourceArtifacts = await resolveLinkedSourcePromptArtifacts({
		userId: params.userId,
		linkedSources: linkedContextSources,
	}).catch(() => []);
	const currentAttachmentIds = new Set(currentAttachments.map((artifact) => artifact.id));
	const requestedAttachmentIds = new Set(attachmentIds);
	const carriedForwardSourceIds = conversationSourceArtifactIds.filter(
		(artifactId) =>
			!requestedAttachmentIds.has(artifactId) && !currentAttachmentIds.has(artifactId),
	);
	const carriedForwardResolution =
		carriedForwardSourceIds.length > 0
			? await resolvePromptAttachmentArtifacts(
					params.userId,
					carriedForwardSourceIds,
				).catch(() => ({
					displayArtifacts: [],
					promptArtifacts: [],
					items: [],
					unresolvedItems: [],
				}))
			: null;
	const resolvedCarriedForwardAttachments = (carriedForwardResolution?.promptArtifacts ?? [])
		.filter((artifact) => !currentAttachmentIds.has(artifact.id));
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
			resolvedAttachments.unresolvedItems.map((item) => item.requestedArtifactId),
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

	if (previousUserMessage && params.message) {
		try {
			const embeddingsPromise = embedTexts([params.message, previousUserMessage]);
			const timeoutPromise = new Promise<null>((resolve) =>
				setTimeout(() => resolve(null), 2000),
			);
			const embeddingsResult = await Promise.race([
				embeddingsPromise,
				timeoutPromise,
			]);
			if (embeddingsResult && embeddingsResult.length >= 2) {
				currentMessageEmbedding = embeddingsResult[0] ?? [];
				previousMessageEmbedding = embeddingsResult[1] ?? [];
			}
		} catch (error) {
			console.warn("[CONTEXT] Failed to generate topic shift embeddings:", error);
		}
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

	const relevantArtifacts = await findRelevantKnowledgeArtifacts({
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
	}).catch(() => []);
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

	const preparedContext = await prepareTaskContext({
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
		taskState: null,
		routingStage: "deterministic" as const,
		routingConfidence: 0,
		verificationStatus: "fallback" as const,
		selectedArtifacts: dedupeById([...currentAttachments, ...workingSetArtifacts]),
		pinnedArtifactIds: [],
		excludedArtifactIds: [],
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
	const artifactSnippets = await getPromptArtifactSnippets({
		userId: params.userId,
		artifacts: Array.from(promptArtifacts.values()),
		query: params.message,
		perArtifactLimit: documentDepthBudget.perArtifactLimit,
		perArtifactCharBudget: documentDepthBudget.perArtifactCharBudget,
		totalCharBudget: documentDepthBudget.totalBudget,
		useFullContent: documentDepthBudget.useFullContent,
	}).catch(() => new Map<string, string>());

	const allTurns = selectRecentRoleTurns(
		promptSessionMessages,
		(message) => message.role,
		promptSessionMessages.length,
	);

	const sessionTurnContext = serializeBudgetedRoleTurns({
		turns: allTurns,
		resolveRole: (message) => message.role,
		resolveContent: (message) =>
			message.forkCopy
				? [
						`[Inherited copied turn from source conversation ${message.forkCopy.sourceConversationId}; source message ${message.forkCopy.sourceMessageId}]`,
						message.content,
					].join("\n")
				: message.content,
		maxTokens: sessionHistoryBudget.totalBudget,
	});
	const recentTurnCount = sessionTurnContext.includedTurnCount;
	const sections: PromptContextSection[] = [];
	const projectFolderSection = buildProjectFolderPromptSection(projectFolderLabel);
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
			WORKING_SET_PROMPT_TOKEN_BUDGET,
		);
		const retrievedEvidencePerSourceBudget = Math.min(
			evidenceBudget.perSourceBudget,
			documentDepthBudget.perArtifactCharBudget,
			WORKING_SET_DOCUMENT_TOKEN_BUDGET,
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
			protected: selectedEvidence.some((artifact) => pinnedArtifactIds.has(artifact.id)),
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

	if (peerContext.trim()) {
		const baselineMemoryProfileBudget = deriveBaselineMemoryProfileBudget({
			contextBudget: modelContextBudget,
		});
		sections.push({
			title: "Baseline Memory Profile",
			body: truncateToTokenBudget(
				peerContext,
				baselineMemoryProfileBudget.totalBudget,
			),
			layer: "session",
			protected: true,
			llmCompactible: true,
		});
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

				const keepCount = Math.max(2, Math.min(4, Math.ceil(candidates.length / 2)));
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
		contextDebug: await getContextDebugState(params.userId, params.conversationId)
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
	};
}
