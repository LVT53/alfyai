// Shared TypeScript types and interfaces used across client and server

export type UserRole = "user" | "admin";

export type Theme = "system" | "light" | "dark";
export type UiLanguage = "en" | "hu";

export type ModelId = "model1" | "model2" | `provider:${string}`;
export type UserModelPreference = ModelId | null;
export type ReasoningDepth = "off" | "auto" | "max";
export type ThinkingMode = "auto" | "on" | "off";
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
export type ResponseActivityKind =
	| "depth"
	| "deliberation"
	| "context"
	| "tool"
	| "source"
	| "drafting"
	| "fallback"
	| "file";
export type ResponseActivityStatus = "running" | "done" | "error";
export type ResponseActivitySourceType = "web" | "document" | "memory" | "tool";
const NORMAL_CHAT_CONTEXT_PREPARATION_ACTIVITY_CLASSES = [
	"planning",
	"context-retrieval",
	"attachment-processing",
	"prompt-assembly",
	"context-compression",
	"web-grounding",
	"budgeting",
] as const;
export type NormalChatContextPreparationActivityClass =
	(typeof NORMAL_CHAT_CONTEXT_PREPARATION_ACTIVITY_CLASSES)[number];

export function isNormalChatContextPreparationActivityClass(
	value: unknown,
): value is NormalChatContextPreparationActivityClass {
	return (
		typeof value === "string" &&
		NORMAL_CHAT_CONTEXT_PREPARATION_ACTIVITY_CLASSES.includes(
			value as NormalChatContextPreparationActivityClass,
		)
	);
}

export interface ResponseActivityEntry {
	id: string;
	kind: ResponseActivityKind;
	status: ResponseActivityStatus;
	label?: string;
	detail?: string;
	callId?: string;
	toolName?: string;
	sourceType?: ResponseActivitySourceType;
	contextPreparationClass?: NormalChatContextPreparationActivityClass;
	title?: string;
	url?: string;
	count?: number;
	passIndex?: number;
	passTotal?: number;
	passKind?: string;
	occurredAt?: number;
}

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

export function isProviderModelId(
	modelId: string,
): modelId is `provider:${string}` {
	return modelId.startsWith("provider:");
}

export function getProviderIdFromModelId(modelId: ModelId): string | null {
	if (!modelId.startsWith("provider:")) return null;
	const parts = modelId.split(":");
	// Format: provider:<provider-uuid>:<model-uuid>
	if (parts.length >= 3) return parts[2]; // model UUID
	if (parts.length === 2) return parts[1]; // legacy provider ID
	return null;
}

export function getProviderProviderIdFromModelId(
	modelId: ModelId,
): string | null {
	if (!modelId.startsWith("provider:")) return null;
	const parts = modelId.split(":");
	// Format: provider:<provider-uuid>:<model-uuid>
	if (parts.length >= 3) return parts[1]; // provider UUID
	if (parts.length === 2) return parts[1]; // legacy provider ID
	return null;
}

export interface UserPreferences {
	preferredModel: UserModelPreference;
	effectiveModel: ModelId;
	systemDefaultModel: ModelId;
	theme: Theme;
	titleLanguage: "auto" | "en" | "hu";
	uiLanguage: UiLanguage;
	avatarId: number | null;
	preferredPersonalityId: string | null;
	sidebarProjectsExpanded: boolean;
	sidebarChatsExpanded: boolean;
	memoryEnabled: boolean;
}

export interface UserSettings {
	id: string;
	email: string;
	name: string | null;
	role: UserRole;
	preferences: UserPreferences;
	profilePicture: string | null;
}

export interface AdminManagedUserSummary {
	id: string;
	email: string;
	name: string | null;
	role: UserRole;
	createdAt: number;
	updatedAt: number;
	conversationCount: number;
	messageCount: number;
	promptTokens: number;
	cachedInputTokens: number;
	cacheHitTokens: number;
	cacheMissTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	totalTokenCount: number;
	favoriteModel: string | null;
	activeSessionCount: number;
	lastActiveAt: number | null;
}

// User interface: id, email, displayName
export interface User {
	id: string;
	email: string;
	displayName: string;
}

// SessionUser interface: id, email, displayName (for event.locals)
export interface SessionUser {
	id: string;
	email: string;
	displayName: string;
	role: UserRole;
	avatarId: number | null;
	profilePicture: string | null;
	titleLanguage: "auto" | "en" | "hu";
	uiLanguage: UiLanguage;
}

// Project interface: a named folder grouping conversations
export interface Project {
	id: string;
	name: string;
	color?: string | null;
	sortOrder: number;
	createdAt: number; // Unix timestamp
	updatedAt: number; // Unix timestamp
}

// Conversation interface: id, title, createdAt, updatedAt (Unix timestamps)
export interface Conversation {
	id: string;
	title: string;
	projectId?: string | null;
	status?: "open" | "sealed";
	sealedAt?: number | null;
	sidebarPinned: boolean;
	sidebarSortOrder: number | null;
	// Incognito: this conversation is excluded from the memory pipeline both
	// ways — nothing is learned from it and no memory/project context is
	// injected into its prompts. Optional in the type (older payloads omit it);
	// always present at runtime from toConversation(), defaulting to false.
	memoryIncognito?: boolean;
	createdAt: number; // Unix timestamp
	updatedAt: number; // Unix timestamp
}

export interface ConversationForkOrigin {
	forkConversationId: string;
	sourceConversationId: string;
	sourceAssistantMessageId: string;
	sourceConversationIdAvailable: boolean;
	sourceAssistantMessageIdAvailable: boolean;
	copiedForkPointMessageId: string;
	sourceTitle: string;
	forkSequence: number;
	createdAt: number;
}

export interface ConversationForkChildSummary {
	conversationId: string;
	title: string;
	forkSequence: number;
	createdAt: number;
}

export interface MessageSourceForks {
	count: number;
	forks: ConversationForkChildSummary[];
}

export interface ConversationForkListSummary {
	sourceTitle: string;
	forkSequence: number;
	sourceConversationId: string;
	sourceConversationIdAvailable: boolean;
}

export interface ForkCopyMetadata {
	sourceMessageId: string;
	sourceConversationId: string;
	sourceRole: MessageRole;
	sourceCreatedAt: string;
}

// Generated file from chat (AI-generated files)
export interface ChatGeneratedFile {
	id: string;
	conversationId: string;
	assistantMessageId?: string | null;
	artifactId?: string | null;
	documentFamilyId?: string | null;
	documentFamilyStatus?: WorkingDocumentFamilyStatus | null;
	documentLabel?: string | null;
	documentRole?: string | null;
	versionNumber?: number | null;
	originConversationId?: string | null;
	originAssistantMessageId?: string | null;
	sourceChatFileId?: string | null;
	filename: string;
	mimeType: string | null;
	sizeBytes: number;
	createdAt: number;
}

export type FileProductionJobStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled";

export interface FileProductionJobFile {
	id: string;
	filename: string;
	mimeType: string | null;
	sizeBytes: number;
	downloadUrl: string;
	previewUrl: string | null;
	artifactId?: string | null;
	documentFamilyId?: string | null;
	documentFamilyStatus?: WorkingDocumentFamilyStatus | null;
	documentLabel?: string | null;
	documentRole?: string | null;
	versionNumber?: number | null;
	originConversationId?: string | null;
	originAssistantMessageId?: string | null;
	sourceChatFileId?: string | null;
}

export interface FileProductionJob {
	id: string;
	conversationId: string;
	assistantMessageId?: string | null;
	title: string;
	status: FileProductionJobStatus;
	stage?: string | null;
	createdAt: number;
	updatedAt: number;
	files: FileProductionJobFile[];
	warnings: string[];
	dismissed: boolean;
	error?: {
		code: string;
		message: string;
		retryable: boolean;
	} | null;
}

// Issue 7.5 — inline write-confirm card. Mirrors the shape returned by
// GET /api/conversations/[id]/pending-writes (see
// src/lib/server/services/connections/write-guard.ts's WritePreview for the
// server-side source of truth this is kept in sync with) and by
// $lib/client/api/connection-writes.ts's confirm/cancel calls.
export type PendingWriteStatus =
	| "pending"
	| "executing"
	| "executed"
	| "cancelled"
	| "failed";

export interface WritePreview {
	title: string;
	detail: string;
	reversible: boolean;
	destructive: boolean;
	withinAllowlist: boolean | null;
	warnings: string[];
}

export interface PendingWrite {
	id: string;
	conversationId: string | null;
	assistantMessageId: string | null;
	status: PendingWriteStatus;
	preview: WritePreview;
	provider: string;
	createdAt: number;
	etag?: string | null;
}

export type AtlasProfile = "overview" | "in-depth" | "exhaustive";
export type AtlasAction = "create" | "continue" | "fork" | "revise";
export type AtlasJobStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled";

export interface AtlasAvailability {
	enabled: boolean;
	configured: boolean;
	reasonCode?: "disabled" | "missing_searxng" | null;
	reason?: string | null;
}

export interface AtlasJobCard {
	id: string;
	conversationId: string;
	assistantMessageId?: string | null;
	action: AtlasAction;
	parentAtlasJobId?: string | null;
	profile: AtlasProfile;
	title: string;
	status: AtlasJobStatus;
	stage?: string | null;
	progress: {
		percent: number;
		stage: string;
		details: {
			queries: string[];
			roundKind?: "initial" | "gap-fill";
			focus?: string[];
		};
	};
	sourceCounts: {
		local: number;
		web: number;
		accepted: number;
		rejected: number;
	};
	usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		costUsdMicros: number;
	};
	outputs: {
		fileProductionJobId?: string | null;
		htmlChatGeneratedFileId?: string | null;
		pdfChatGeneratedFileId?: string | null;
		markdownChatGeneratedFileId?: string | null;
	};
	error?: {
		code: string;
		message: string;
		retryable: boolean;
	} | null;
	createdAt: number;
	updatedAt: number;
	completedAt?: number | null;
}

export type DocumentWorkspaceSource =
	| "chat_generated_file"
	| "knowledge_artifact";

export interface DocumentWorkspaceItem {
	id: string;
	source: DocumentWorkspaceSource;
	filename: string;
	title: string;
	documentFamilyId?: string | null;
	documentFamilyStatus?: WorkingDocumentFamilyStatus | null;
	documentLabel?: string | null;
	documentRole?: string | null;
	versionNumber?: number | null;
	originConversationId?: string | null;
	originAssistantMessageId?: string | null;
	sourceChatFileId?: string | null;
	mimeType: string | null;
	previewUrl?: string | null;
	artifactId?: string | null;
	conversationId?: string | null;
	downloadUrl?: string | null;
}

export interface ConversationDetail {
	conversation: Conversation;
	messages: ChatMessage[];
	forkOrigin?: ConversationForkOrigin | null;
	attachedArtifacts?: ArtifactSummary[];
	activeWorkingSet?: ArtifactSummary[];
	contextStatus?: ConversationContextStatus | null;
	contextSources?: ContextSourcesState | null;
	taskState?: TaskState | null;
	contextDebug?: ContextDebugState | null;
	draft?: ConversationDraft | null;
	bootstrap?: boolean;
	generatedFiles?: ChatGeneratedFile[];
	fileProductionJobs?: FileProductionJob[];
	atlasJobs?: AtlasJobCard[];
	atlasAvailability?: AtlasAvailability | null;
	contextCompressionSnapshots?: ContextCompressionMarker[];
	activeSkillSession?: SkillSession | null;
	totalCostUsdMicros?: number;
	totalTokens?: number;
	sidecarPending?: boolean;
}

export type ContextCompressionTrigger = "manual" | "automatic";
export type ContextCompressionStatus = "running" | "valid" | "failed";

export interface ContextCompressionMarker {
	id: string;
	trigger: ContextCompressionTrigger;
	status: ContextCompressionStatus;
	sourceEndMessageId: string;
	createdAt: number;
	updatedAt: number;
	estimatedTokens?: number;
	sourceTokenEstimate?: number;
	/**
	 * Bounded human-readable excerpt of the compaction summary (goal +
	 * currentState, optionally an important fact). Present only when the
	 * snapshot is `valid` and has summary fields. Capped (~400 chars).
	 */
	summaryExcerpt?: string;
	/**
	 * Authoritative count of compacted source messages, derived from
	 * `snapshot.sourceCoverage.messageIds.length`. Present only when the
	 * snapshot is `valid`.
	 */
	sourceMessageCount?: number;
}

// ConversationListItem interface: id, title, updatedAt
export interface ConversationListItem {
	id: string;
	title: string;
	updatedAt: number; // Unix timestamp
	projectId?: string | null;
	sidebarPinned: boolean;
	sidebarSortOrder: number | null;
	forkSummary?: ConversationForkListSummary;
	atlasBadge?: {
		jobId?: string;
		status: AtlasJobStatus;
		label?: string | null;
		completedAt?: number | null;
		updatedAt?: number;
	} | null;
}

// MessageRole type: 'user' | 'assistant'
export type MessageRole = "user" | "assistant";

export type EvidenceSourceType = "web" | "document" | "memory" | "tool";

export type MessageEvidenceStatus = "selected" | "rejected" | "reference";

export interface ToolEvidenceCandidate {
	id: string;
	title: string;
	url?: string | null;
	snippet?: string | null;
	sourceType: EvidenceSourceType;
	selected?: boolean;
	material?: boolean;
	status?: MessageEvidenceStatus;
	metadata?: Record<string, string | number | boolean | null>;
}

export interface ToolCallEntry {
	callId?: string;
	name: string;
	input: Record<string, unknown>;
	status: "running" | "done";
	outputSummary?: string | null;
	sourceType?: EvidenceSourceType | null;
	candidates?: ToolEvidenceCandidate[];
	metadata?: Record<string, string | number | boolean | null>;
}

export type ThinkingSegment =
	| { type: "text"; content: string }
	| {
			type: "status";
			id: string;
			label: string;
			status: ResponseActivityStatus;
			passIndex?: number;
			passTotal?: number;
			passKind?: string;
	  }
	| {
			type: "tool_call";
			callId?: string;
			name: string;
			input: Record<string, unknown>;
			status: "running" | "done";
			outputSummary?: string | null;
			sourceType?: EvidenceSourceType | null;
			candidates?: ToolEvidenceCandidate[];
			metadata?: Record<string, string | number | boolean | null>;
	  };

export type EvidenceChannel =
	| "attached"
	| "retrieved"
	| "tool"
	| "web"
	| "memory";

export interface MessageEvidenceItem {
	id: string;
	canonicalId?: string;
	title: string;
	sourceType: EvidenceSourceType;
	status: MessageEvidenceStatus;
	description?: string | null;
	url?: string | null;
	artifactId?: string | null;
	confidence?: number | null;
	reason?: string | null;
	currentTurnAttachment?: boolean;
	channels?: EvidenceChannel[];
	metadata?: Record<string, string | number | boolean | null>;
}

export interface MessageEvidenceGroup {
	sourceType: EvidenceSourceType;
	label: string;
	reranked: boolean;
	confidence?: number | null;
	items: MessageEvidenceItem[];
}

export interface MessageEvidenceSummary {
	structuredWebSearch: boolean;
	groups: MessageEvidenceGroup[];
}

export interface ForkEvidenceSnapshot {
	sourceMessageId: string;
	sourceConversationId: string;
	snapshotCreatedAt: string;
	evidenceSummary: MessageEvidenceSummary;
}

export type WebCitationAuditStatus =
	| "none"
	| "passed"
	| "missing_citations"
	| "unsupported_citations";

export type WebCitationMatchType = "exact" | "host" | "none";

export interface WebCitationAuditCitation {
	url: string;
	canonicalUrl: string;
	supported: boolean;
	matchType: WebCitationMatchType;
	matchedSourceId?: string | null;
	matchedSourceTitle?: string | null;
	matchedSourceUrl?: string | null;
}

export interface WebCitationAudit {
	status: WebCitationAuditStatus;
	retrievedSourceCount: number;
	citedUrlCount: number;
	supportedCitationCount: number;
	unsupportedCitationCount: number;
	noticeAppended?: boolean;
	citations: WebCitationAuditCitation[];
}

export type MessageEvidenceStatusState =
	| "pending"
	| "ready"
	| "failed"
	| "none";

export type SkillControlSessionTransition =
	| "active"
	| "awaiting_user"
	| "finished"
	| "failed_note"
	| "dismissed";

export type SkillDraftStatus = "proposed" | "saved" | "dismissed" | "published";

export type SkillDraftDurationPolicy = "next_message" | "session";
export type SkillDraftQuestionPolicy = "none" | "ask_when_needed";
export type SkillDraftNotesPolicy = "none" | "create_private_notes";
export type SkillDraftSourceScope =
	| "current_conversation"
	| "selected_sources_only";

export interface SkillDraftProposal {
	id: string;
	status: SkillDraftStatus;
	displayName: string;
	description: string;
	instructions: string;
	activationExamples: string[];
	durationPolicy: SkillDraftDurationPolicy;
	questionPolicy: SkillDraftQuestionPolicy;
	notesPolicy: SkillDraftNotesPolicy;
	sourceScope: SkillDraftSourceScope;
	savedSkillId?: string;
	publishedSystemSkillId?: string;
	updatedAt?: number;
}

export type SkillControlOperation =
	| {
			operationId: string;
			kind: "session_transition";
			transition: SkillControlSessionTransition;
	  }
	| {
			operationId: string;
			kind: "note_intent";
			action: "create";
			title: string;
			body: string;
	  }
	| {
			operationId: string;
			kind: "note_intent";
			action: "replace" | "append";
			targetArtifactId: string;
			body: string;
	  }
	| {
			operationId: string;
			kind: "skill_draft";
			draft: SkillDraftProposal;
	  };

export interface SkillControlMessageMetadata {
	skillQuestion?: boolean;
	pendingSkillNoteIntents?: Extract<
		SkillControlOperation,
		{ kind: "note_intent" }
	>[];
	skillDrafts?: SkillDraftProposal[];
	skillControl?: {
		envelopeVersion: 1;
		operations: SkillControlOperation[];
		malformedEnvelopeCount: number;
	};
}

export type NormalChatRuntimePhase =
	| "idle"
	| "preparing"
	| "generating"
	| "finalizing"
	| "polling";

export interface ChatMessage {
	id: string;
	// Stable client-side identity used for keyed rendering so stream finalization
	// can swap in persisted IDs without remounting the message bubble.
	renderKey?: string;
	role: MessageRole;
	content: string;
	timestamp: number;
	attachments?: ChatAttachment[];
	isStreaming?: boolean;
	runtimePhase?: NormalChatRuntimePhase;
	thinking?: string;
	isThinkingStreaming?: boolean;
	thinkingTokenCount?: number;
	responseTokenCount?: number;
	totalTokenCount?: number;
	// Interleaved thinking text + tool call segments, built during streaming.
	// Not persisted to DB — falls back to flat `thinking` string on page reload.
	thinkingSegments?: ThinkingSegment[];
	// Display name of the model used for the response (assistant messages only)
	modelId?: ModelId;
	modelDisplayName?: string;
	providerDisplayName?: string;
	providerIconUrl?: string;
	// Total generation duration in milliseconds (assistant messages only)
	generationDurationMs?: number;
	// Estimated cost in USD for this response (from usage_events, assistant messages only)
	costUsd?: number;
	evidenceSummary?: MessageEvidenceSummary;
	webCitationAudit?: WebCitationAudit;
	evidencePending?: boolean;
	wasStopped?: boolean;
	depthMetadata?: DepthMetadata;
	responseActivity?: ResponseActivityEntry[];
	skillQuestion?: boolean;
	pendingSkillNoteIntents?: SkillControlMessageMetadata["pendingSkillNoteIntents"];
	skillDrafts?: SkillControlMessageMetadata["skillDrafts"];
	skillControl?: SkillControlMessageMetadata["skillControl"];
	forkCopy?: ForkCopyMetadata;
	forkEvidenceSnapshot?: ForkEvidenceSnapshot;
	sourceForks?: MessageSourceForks;
	importSource?: string;
}

export type ArtifactType =
	| "source_document"
	| "normalized_document"
	| "generated_output"
	| "skill_note"
	| "work_capsule";

export type ArtifactRetrievalClass =
	| "durable"
	| "ephemeral_followup"
	| "archived_duplicate";

export type ArtifactLinkType =
	| "attached_to_conversation"
	| "linked_context_source"
	| "derived_from"
	| "used_in_output"
	| "supersedes"
	| "captured_by_capsule";

export type MemoryLayer =
	| "session"
	| "capsule"
	| "documents"
	| "outputs"
	| "working_set"
	| "task_state";

export type TaskStateStatus = "active" | "candidate" | "revived" | "archived";

export type CompactionMode = "none" | "deterministic" | "llm_fallback";
export type RoutingStage =
	| "deterministic"
	| "semantic"
	| "evidence_rerank"
	| "verification_fallback";
export type VerificationStatus = "skipped" | "fallback" | "passed";
export type TaskEvidenceRole =
	| "selected"
	| "pinned"
	| "excluded"
	| "checkpoint_source";
export type TaskEvidenceOrigin = "system" | "user";
export type TaskCheckpointType = "micro" | "stable";
export type EvidencePreference = "auto" | "pinned" | "excluded";

export type WorkingSetState = "active" | "cooling";

export type WorkingSetReasonCode =
	| "attached_this_turn"
	| "active_document_focus"
	| "recent_user_correction"
	| "recently_refined_document_family"
	| "recent_refinement_behavior"
	| "recent_document_open"
	| "current_generated_document"
	| "recently_used_in_output"
	| "latest_generated_output"
	| "matched_current_turn"
	| "persisted_from_previous_turn"
	| "preferred_artifact";

export interface ChatAttachment {
	id: string;
	artifactId: string;
	name: string;
	type: ArtifactType;
	mimeType: string | null;
	sizeBytes: number | null;
	conversationId: string | null;
	messageId?: string | null;
	createdAt: number;
}

export interface ArtifactSummary {
	id: string;
	type: ArtifactType;
	retrievalClass: ArtifactRetrievalClass;
	name: string;
	mimeType: string | null;
	sizeBytes: number | null;
	conversationId: string | null;
	summary: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface KnowledgeDocumentItem {
	id: string;
	type?: ArtifactType;
	displayArtifactId: string;
	promptArtifactId: string | null;
	familyArtifactIds: string[];
	name: string;
	mimeType: string | null;
	sizeBytes: number | null;
	conversationId: string | null;
	summary: string | null;
	normalizedAvailable: boolean;
	documentOrigin?: "uploaded" | "generated" | "skill_note";
	documentFamilyId?: string | null;
	documentFamilyStatus?: WorkingDocumentFamilyStatus | null;
	documentLabel?: string | null;
	documentRole?: string | null;
	versionNumber?: number | null;
	isOriginal?: boolean | null;
	originConversationId?: string | null;
	originAssistantMessageId?: string | null;
	sourceChatFileId?: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface WorkingDocumentMetadata {
	documentFamilyId?: string | null;
	documentFamilyStatus?: WorkingDocumentFamilyStatus | null;
	documentLabel?: string | null;
	documentRole?: string | null;
	versionNumber?: number | null;
	supersedesArtifactId?: string | null;
	originConversationId?: string | null;
	originAssistantMessageId?: string | null;
	sourceChatFileId?: string | null;
}

export type WorkingDocumentFamilyStatus = "active" | "historical";

export type WorkspaceSearchMode = "default" | "query";

export type WorkspaceSearchConversationMatchType =
	| "recent"
	| "title"
	| "project"
	| "body";

export type WorkspaceSearchDocumentMatchType =
	| "recent"
	| "name"
	| "label"
	| "role"
	| "summary"
	| "content";

export interface WorkspaceSearchConversationResult {
	id: string;
	title: string;
	projectId: string | null;
	projectName: string | null;
	status: Conversation["status"];
	sealedAt: number | null;
	updatedAt: number;
	href: string;
	match: {
		type: WorkspaceSearchConversationMatchType;
		snippet: string | null;
		messageId: string | null;
		messageRole: string | null;
	};
}

export interface WorkspaceSearchDocumentResult {
	id: string;
	type?: ArtifactType;
	displayArtifactId: string;
	promptArtifactId: string | null;
	familyArtifactIds: string[];
	name: string;
	mimeType: string | null;
	sizeBytes: number | null;
	conversationId: string | null;
	summary: string | null;
	documentOrigin?: KnowledgeDocumentItem["documentOrigin"];
	documentFamilyId?: string | null;
	documentFamilyStatus?: WorkingDocumentFamilyStatus | null;
	documentLabel?: string | null;
	documentRole?: string | null;
	versionNumber?: number | null;
	originConversationId?: string | null;
	originAssistantMessageId?: string | null;
	sourceChatFileId?: string | null;
	updatedAt: number;
	href: string;
	sourceHref: string | null;
	match: {
		type: WorkspaceSearchDocumentMatchType;
		snippet: string | null;
	};
}

export interface WorkspaceSearchResponse {
	query: string;
	mode: WorkspaceSearchMode;
	conversations: WorkspaceSearchConversationResult[];
	documents: WorkspaceSearchDocumentResult[];
	documentOverflow: boolean;
	knowledgeHref: string | null;
}

export interface PendingAttachment {
	artifact: ArtifactSummary;
	promptReady: boolean;
	promptArtifactId?: string | null;
	readinessError?: string | null;
}

export interface LinkedContextSource {
	displayArtifactId: string;
	promptArtifactId: string | null;
	familyArtifactIds: string[];
	name: string;
	type: "document";
	mimeType?: string | null;
	documentOrigin?: KnowledgeDocumentItem["documentOrigin"];
}

export interface PendingSkillSelection {
	id: string;
	ownership: "user" | "system";
	skillKind?: "user_skill" | "skill_pack" | "skill_variant";
	displayName: string;
	baseSkillId?: string | null;
	baseSkillDisplayName?: string | null;
	unavailable?: boolean;
}

export type SkillSessionStatus = "active" | "paused" | "ended";
export type SkillSessionMilestoneKind =
	| "started"
	| "paused"
	| "ended"
	| "dismissed"
	| "unavailable"
	| "awaiting_user"
	| "failed_note";

export interface SkillSessionMilestone {
	id: string;
	sessionId: string;
	userId: string;
	conversationId: string;
	kind: SkillSessionMilestoneKind;
	messageKey: string;
	messageParams: Record<string, unknown>;
	createdAt: number;
}

export interface SkillSession {
	id: string;
	userId: string;
	conversationId: string;
	skillId: string;
	skillOwnership: "user" | "system";
	skillKind: "user_skill" | "skill_pack" | "skill_variant";
	status: SkillSessionStatus;
	pauseReason: string | null;
	endReason: string | null;
	skillDisplayName: string;
	skillDescription: string;
	activationExamples: string[];
	durationPolicy: "next_message" | "session";
	questionPolicy: "none" | "ask_when_needed";
	notesPolicy: "none" | "create_private_notes";
	sourceScope: "current_conversation" | "selected_sources_only";
	skillVersion: number;
	packSkillId: string | null;
	packSkillVersion: number | null;
	variantSkillId: string | null;
	variantSkillVersion: number | null;
	effectiveInstructionsHash: string | null;
	startedFrom: "pending_skill";
	startedAt: number;
	updatedAt: number;
	pausedAt: number | null;
	endedAt: number | null;
	milestones: SkillSessionMilestone[];
}

export interface SkillSessionInternal extends SkillSession {
	skillInstructions: string;
}

export interface ConversationDraft {
	conversationId: string;
	draftText: string;
	selectedAttachmentIds: string[];
	selectedAttachments: PendingAttachment[];
	selectedLinkedSources: LinkedContextSource[];
	pendingSkill: PendingSkillSelection | null;
	atlasMode?: boolean;
	atlasProfile?: AtlasProfile | null;
	clientAtlasTurnId?: string | null;
	updatedAt: number;
}

export interface KnowledgeUploadResponse {
	artifact: ArtifactSummary;
	normalizedArtifact: ArtifactSummary | null;
	reusedExistingArtifact: boolean;
	promptReady: boolean;
	promptArtifactId?: string | null;
	readinessError?: string | null;
	renameInfo?: {
		originalName: string;
		wasRenamed: boolean;
	};
}

export interface Artifact extends ArtifactSummary {
	userId: string;
	extension: string | null;
	storagePath: string | null;
	contentText: string | null;
	metadata: Record<string, unknown> | null;
}

export interface ArtifactChunk {
	id: string;
	artifactId: string;
	userId: string;
	conversationId: string | null;
	chunkIndex: number;
	contentText: string;
	tokenEstimate: number;
	createdAt: number;
	updatedAt: number;
}

export type SemanticEmbeddingSubjectType =
	| "artifact"
	| "imported_conversation"
	| "persona_cluster"
	| "task_state"
	| "memory_profile_item";

export interface SemanticEmbedding {
	id: string;
	userId: string;
	subjectType: SemanticEmbeddingSubjectType;
	subjectId: string;
	modelName: string;
	sourceTextHash: string;
	dimensions: number;
	embedding: number[];
	createdAt: number;
	updatedAt: number;
}

export interface TaskEvidenceLink {
	id: string;
	taskId: string;
	userId: string;
	conversationId: string;
	artifactId: string;
	chunkIndex: number | null;
	role: TaskEvidenceRole;
	origin: TaskEvidenceOrigin;
	confidence: number;
	reason: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface TaskCheckpoint {
	id: string;
	taskId: string;
	userId: string;
	conversationId: string;
	checkpointType: TaskCheckpointType;
	content: string;
	sourceTurnRange: string | null;
	sourceEvidenceIds: string[];
	verificationStatus: VerificationStatus;
	createdAt: number;
	updatedAt: number;
}

export interface ArtifactLink {
	id: string;
	userId: string;
	artifactId: string;
	relatedArtifactId: string | null;
	conversationId: string | null;
	messageId: string | null;
	linkType: ArtifactLinkType;
	createdAt: number;
}

export interface WorkCapsule {
	artifact: ArtifactSummary;
	conversationId: string | null;
	taskSummary: string | null;
	workflowSummary: string | null;
	keyConclusions: string[];
	reusablePatterns: string[];
	sourceArtifactCount: number;
	outputArtifactCount: number;
}

export interface ConversationWorkingSetItem {
	id: string;
	userId: string;
	conversationId: string;
	artifactId: string;
	artifactType: Exclude<ArtifactType, "work_capsule">;
	score: number;
	state: WorkingSetState;
	reasonCodes: WorkingSetReasonCode[];
	lastActivatedAt: number | null;
	lastUsedAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface ConversationContextStatus {
	conversationId: string;
	userId: string;
	estimatedTokens: number;
	maxContextTokens: number;
	thresholdTokens: number;
	targetTokens: number;
	compactionApplied: boolean;
	compactionMode: CompactionMode;
	routingStage: RoutingStage;
	routingConfidence: number;
	verificationStatus: VerificationStatus;
	layersUsed: MemoryLayer[];
	workingSetCount: number;
	workingSetArtifactIds: string[];
	workingSetApplied: boolean;
	taskStateApplied: boolean;
	promptArtifactCount: number;
	recentTurnCount: number;
	summary: string | null;
	updatedAt: number;
}

export type ContextSourceGroupKind =
	| "attachments"
	| "linked_source"
	| "working_set"
	| "task_evidence"
	| "pinned"
	| "excluded"
	| "memory"
	| "project_folder"
	| "project_continuity"
	| "conversation";

export type ContextSourceItemState =
	| "active"
	| "inferred"
	| "pinned"
	| "excluded";

export interface ContextSourceItem {
	id: string;
	title: string;
	state: ContextSourceItemState;
	sourceType: EvidenceSourceType | "attachment" | "conversation";
	artifactId?: string | null;
	artifactType?: ArtifactType | null;
	reason?: string | null;
	metadata?: Record<string, string | number | boolean | null>;
	reduced?: boolean;
	compacted?: boolean;
}

export interface ContextSourceGroup {
	kind: ContextSourceGroupKind;
	state: ContextSourceItemState;
	totalCount: number;
	items: ContextSourceItem[];
}

export interface ContextSourcesState {
	conversationId: string;
	userId: string;
	activeCount: number;
	inferredCount: number;
	selectedCount: number;
	pinnedCount: number;
	excludedCount: number;
	reduced: boolean;
	compacted: boolean;
	groups: ContextSourceGroup[];
	updatedAt: number;
}

export interface TaskState {
	taskId: string;
	userId: string;
	conversationId: string;
	status: TaskStateStatus;
	objective: string;
	confidence: number;
	locked: boolean;
	lastConfirmedTurnMessageId: string | null;
	constraints: string[];
	factsToPreserve: string[];
	decisions: string[];
	openQuestions: string[];
	activeArtifactIds: string[];
	nextSteps: string[];
	lastCheckpointAt: number | null;
	continuity?: TaskContinuitySummary | null;
	createdAt: number;
	updatedAt: number;
}

export interface ContextDebugEvidenceItem {
	artifactId: string;
	name: string;
	artifactType: ArtifactType;
	sourceType: EvidenceSourceType;
	role: TaskEvidenceRole;
	origin: TaskEvidenceOrigin;
	confidence: number;
	reason: string | null;
}

export interface ContextDebugEvidenceSummaryItem {
	sourceType: EvidenceSourceType;
	count: number;
}

export interface ForkContextProvenanceSummary {
	inheritedMessageCount: number;
	inheritedTurnCount: number;
	forkLocalMessageCount: number;
	sourceConversationIds: string[];
	sourceMessageIds: string[];
	copiedForkPointMessageId?: string | null;
}

export interface ContextDebugState {
	activeTaskId: string | null;
	activeTaskObjective: string | null;
	taskLocked: boolean;
	routingStage: RoutingStage;
	routingConfidence: number;
	verificationStatus: VerificationStatus;
	selectedEvidence: ContextDebugEvidenceItem[];
	selectedEvidenceBySource: ContextDebugEvidenceSummaryItem[];
	pinnedEvidence: ContextDebugEvidenceItem[];
	excludedEvidence: ContextDebugEvidenceItem[];
	forkProvenance?: ForkContextProvenanceSummary | null;
}

export type PersonaMemoryScope = "self" | "assistant_about_user";

export type PersonaMemoryClass =
	| "perishable_fact"
	| "short_term_constraint"
	| "active_project_context"
	| "situational_context"
	| "stable_preference"
	| "identity_profile"
	| "long_term_context";

export type PersonaMemoryState = "active" | "dormant" | "archived";
export type PersonaMemoryTemporalKind =
	| "deadline"
	| "availability"
	| "appointment"
	| "project_window"
	| "short_term_constraint";
export type PersonaMemoryTemporalFreshness =
	| "active"
	| "stale"
	| "expired"
	| "historical"
	| "unknown";
export type PersonaMemoryTopicStatus = "active" | "dormant" | "historical";
export type PersonaMemoryDomain = "persona" | "temporal" | "preference";
export type MemoryEventDomain =
	| "persona"
	| "temporal"
	| "preference"
	| "task"
	| "document"
	| "conversation";
export type MemoryEventType =
	| "persona_fact_updated"
	| "deadline_set"
	| "deadline_extended"
	| "deadline_completed"
	| "project_started"
	| "project_paused"
	| "project_resumed"
	| "preference_updated"
	| "document_opened"
	| "document_refined"
	| "document_superseded"
	| "conversation_fork_created";

export interface PersonaMemoryTemporalInfo {
	kind: PersonaMemoryTemporalKind;
	freshness: PersonaMemoryTemporalFreshness;
	observedAt: number;
	effectiveAt: number | null;
	expiresAt: number | null;
	relative: boolean;
	resolved: boolean;
}

export interface PersonaMemoryMemberItem {
	id: string;
	content: string;
	scope: PersonaMemoryScope;
	sessionId: string | null;
	conversationTitle: string | null;
	createdAt: number;
}

export interface PersonaMemoryItem {
	id: string;
	canonicalText: string;
	rawCanonicalText?: string;
	domain?: PersonaMemoryDomain;
	memoryClass: PersonaMemoryClass;
	state: PersonaMemoryState;
	salienceScore: number;
	sourceCount: number;
	conversationTitles: string[];
	firstSeenAt: number;
	lastSeenAt: number;
	pinned: boolean;
	temporal?: PersonaMemoryTemporalInfo | null;
	activeConstraint?: boolean;
	topicKey?: string | null;
	topicStatus?: PersonaMemoryTopicStatus | null;
	supersededById?: string | null;
	supersessionReason?: string | null;
	members: PersonaMemoryMemberItem[];
}

export interface MemoryEvent {
	id: string;
	eventKey: string;
	userId: string;
	conversationId: string | null;
	messageId: string | null;
	domain: MemoryEventDomain;
	eventType: MemoryEventType;
	subjectId: string | null;
	relatedId: string | null;
	observedAt: number;
	createdAt: number;
	payload: Record<string, unknown> | null;
}

export interface TaskMemoryItem {
	taskId: string;
	conversationId: string;
	conversationTitle: string | null;
	objective: string;
	status: TaskStateStatus;
	locked: boolean;
	updatedAt: number;
	lastCheckpointAt: number | null;
	checkpointSummary: string | null;
}

export type FocusContinuityStatus = "active" | "dormant" | "archived";

export interface FocusContinuityItem {
	continuityId: string;
	name: string;
	summary: string | null;
	status: FocusContinuityStatus;
	lastActiveAt: number | null;
	updatedAt: number;
	linkedTaskCount: number;
	conversationTitles: string[];
}

export interface TaskContinuitySummary {
	continuityId: string;
	name: string;
	summary: string | null;
	status: FocusContinuityStatus;
	linkedTaskCount: number;
	lastActiveAt: number | null;
	updatedAt: number;
}

export type KnowledgeMemoryOverviewSource = "persona_fallback" | null;

export type KnowledgeMemoryOverviewStatus =
	| "ready"
	| "refreshing"
	| "temporarily_unavailable"
	| "not_enough_durable_memory"
	| "disabled";

export interface KnowledgeMemorySummary {
	personaCount: number;
	taskCount: number;
	focusContinuityCount: number;
	activeConstraintCount?: number;
	currentProjectContextCount?: number;
	overview: string | null;
	overviewBullets: string[];
	overviewSource: KnowledgeMemoryOverviewSource;
	overviewStatus: KnowledgeMemoryOverviewStatus;
	overviewUpdatedAt: number | null;
	overviewLastAttemptAt: number | null;
	durablePersonaCount: number;
}

export type MemoryProfileCategory =
	| "about_you"
	| "preferences"
	| "goals_ongoing_work"
	| "constraints_boundaries";

export type MemoryProfileScope =
	| { type: "global" }
	| { type: "project"; id: string }
	| { type: "conversation"; id: string }
	| { type: "document"; id: string };

export interface MemoryProfilePublicItem {
	id: string;
	itemKey: string;
	category: MemoryProfileCategory;
	statement: string;
	scope: MemoryProfileScope;
	status: "active";
	revision: number;
	updatedAt: string;
	confidence?: "stated" | "inferred" | null;
	expiryClass?: "durable" | "time_bound" | null;
	expiresAt?: string | null;
	canEdit: boolean;
	canDelete: boolean;
	canSuppress: boolean;
}

export interface MemoryProfileSourceChip {
	id: string;
	sourceType: string;
	label: string;
	summary: string | null;
}

export interface MemoryProfilePublicItemDetail extends MemoryProfilePublicItem {
	sourceChips: MemoryProfileSourceChip[];
	whyRemembered: string | null;
}

export interface MemoryProfileReviewItem {
	id: string;
	subject: string;
	question: string;
	reason: string;
	canAccept: boolean;
	expiresAt?: string | null;
}

export interface MemoryProfilePublicPayload {
	resetGeneration: number;
	projectionRevision: number;
	categories: Array<{
		category: MemoryProfileCategory;
		items: MemoryProfilePublicItem[];
	}>;
	review: {
		items?: MemoryProfileReviewItem[];
		visibleItems: MemoryProfileReviewItem[];
		openCount: number;
		overflowCount: number;
	};
}

export type MemoryProfileActionPayload =
	| {
			target?: "profile_item";
			action: "delete";
			itemId: string;
			expectedProjectionRevision: number;
	  }
	| {
			target?: "profile_item";
			action: "suppress";
			itemId: string;
			expectedProjectionRevision: number;
	  }
	| {
			target?: "profile_item";
			action: "edit";
			itemId: string;
			statement: string;
			expectedProjectionRevision: number;
	  }
	| {
			target: "review_item";
			action: "accept";
			itemId: string;
			expectedProjectionRevision: number;
	  }
	| {
			target: "review_item";
			action: "suppress";
			itemId: string;
			expectedProjectionRevision: number;
	  }
	| {
			target: "review_item";
			action: "edit";
			itemId: string;
			statement: string;
			expectedProjectionRevision: number;
	  };

export interface MemoryPersonaSummaryPayload {
	summary: {
		text: string;
		links: Array<{ text: string; factIds: string[] }>;
		updatedAt: string;
	} | null;
}

export interface MemoryTimelineAction {
	type: "expired" | "renewed" | "superseded" | "merged";
	itemIds: string[];
	resultItemId?: string;
	// The current statement of resultItemId (the surviving/merged-into fact),
	// resolved at read time so the UI can show "superseded by / merged into X".
	resultStatement?: string;
	description: string;
	undo: Array<{
		itemId: string;
		prevStatus: string;
		prevStatement: string;
		prevExpiresAt?: string | null;
	}>;
}

export interface MemoryTimelineReport {
	id: string;
	status: string;
	summaryText: string;
	createdAt: string;
	actions: MemoryTimelineAction[];
}

export interface MemoryTimelinePayload {
	reports: MemoryTimelineReport[];
}

export type MemoryV2ActionPayload =
	| {
			kind: "profile_item";
			action: "correct";
			itemId: string;
			statement: string;
			expectedProjectionRevision: number;
	  }
	| {
			kind: "profile_item";
			action: "retire";
			itemId: string;
			expectedProjectionRevision: number;
	  }
	| {
			kind: "summary";
			action: "edit";
			text: string;
	  }
	| {
			kind: "consolidation";
			action: "undo";
			reportId: string;
			actionIndex: number;
	  };

export interface KnowledgeMemoryPayload {
	resetGeneration?: number;
	projectionRevision?: number;
	categories?: MemoryProfilePublicPayload["categories"];
	review?: MemoryProfilePublicPayload["review"];
	personaMemories?: PersonaMemoryItem[];
	activeConstraints?: PersonaMemoryItem[];
	currentProjectContext?: PersonaMemoryItem[];
	taskMemories?: TaskMemoryItem[];
	focusContinuities?: FocusContinuityItem[];
	summary?: KnowledgeMemorySummary;
}

export interface KnowledgeMemoryOverviewPayload {
	summary: KnowledgeMemorySummary;
	profile?: KnowledgeMemoryPayload;
	// The user's master memory toggle (users.memoryEnabled).
	memoryEnabled: boolean;
	// Whether the memory pipeline currently has queued/in-flight work for this
	// user, so the UI can show a compact "memory is processing" notice.
	processing: { active: boolean; pendingCount: number };
}

export type TaskSteeringAction =
	| "lock_task"
	| "unlock_task"
	| "start_new_task"
	| "set_artifact_preference"
	| "pin_artifact"
	| "unpin_artifact"
	| "exclude_artifact"
	| "include_artifact";

export interface TaskSteeringPayload {
	action: TaskSteeringAction;
	artifactId?: string;
	objective?: string;
	preference?: EvidencePreference;
}
