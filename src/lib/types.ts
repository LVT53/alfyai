// Shared TypeScript types and interfaces used across client and server

export type UserRole = "user" | "admin";

export type Theme = "system" | "light" | "dark";
export type UiLanguage = "en" | "hu";

export type ModelId = "model1" | "model2" | `provider:${string}`;
export type ThinkingMode = "auto" | "on" | "off";

export function isProviderModelId(
	modelId: string,
): modelId is `provider:${string}` {
	return modelId.startsWith("provider:");
}

export function getProviderIdFromModelId(modelId: ModelId): string | null {
	if (modelId.startsWith("provider:")) {
		return modelId.slice(9);
	}
	return null;
}

export interface UserPreferences {
	preferredModel: ModelId;
	theme: Theme;
	titleLanguage: "auto" | "en" | "hu";
	uiLanguage: UiLanguage;
	avatarId: number | null;
	preferredPersonalityId: string | null;
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

// Conversation interface: id (Langflow session_id), title, createdAt, updatedAt (Unix timestamps)
export interface Conversation {
	id: string; // Langflow session_id
	title: string;
	projectId?: string | null;
	status?: "open" | "sealed";
	sealedAt?: number | null;
	createdAt: number; // Unix timestamp
	updatedAt: number; // Unix timestamp
}

export type DeepResearchDepth = "focused" | "standard" | "max";

export type DeepResearchPlanStatus = "awaiting_approval" | "approved";

export type DeepResearchReportIntent =
	| "comparison"
	| "recommendation"
	| "investigation"
	| "market_scan"
	| "product_scan"
	| "limitation_focused";

export interface DeepResearchBudget {
	sourceReviewCeiling: number;
	synthesisPassCeiling: number;
	meaningfulPassFloor?: number;
	meaningfulPassCeiling?: number;
	repairPassCeiling?: number;
	sourceProcessingConcurrency?: number;
	modelReasoningConcurrency?: number;
}

export type DeepResearchJobStatus =
	| "awaiting_plan"
	| "awaiting_approval"
	| "approved"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export interface DeepResearchEffortEstimate {
	selectedDepth: DeepResearchDepth;
	expectedTimeBand: string;
	sourceReviewCeiling: number;
	relativeCostWarning: string;
	passBudget?: string;
	repairPassBudget?: string;
}

export interface DeepResearchPlanRaw {
	goal: string;
	depth: DeepResearchDepth;
	reportIntent: DeepResearchReportIntent;
	researchBudget: DeepResearchBudget;
	keyQuestions: string[];
	sourceScope: {
		includePublicWeb: boolean;
		planningContextDisclosure: string | null;
		includedSources?: DeepResearchPlanIncludedSource[];
	};
	reportShape: string[];
	constraints: string[];
	deliverables: string[];
}

export interface DeepResearchPlanIncludedSource {
	type: "attached_file" | "knowledge_artifact";
	artifactId: string;
	title?: string;
	summary: string;
}

export interface DeepResearchPlanSummary {
	id?: string;
	jobId?: string;
	version: number;
	status?: DeepResearchPlanStatus;
	rawPlan?: DeepResearchPlanRaw;
	renderedPlan: string;
	contextDisclosure?: string | null;
	effortEstimate: DeepResearchEffortEstimate;
	createdAt?: number;
	updatedAt?: number;
}

export interface DeepResearchSourceCounts {
	discovered: number;
	reviewed: number;
	cited: number;
}

export type DeepResearchSourceStatus = "discovered" | "reviewed" | "cited";

export type DeepResearchSourceType =
	| "official_vendor"
	| "official_government"
	| "academic"
	| "independent_analysis"
	| "news"
	| "forum"
	| "vendor_marketing"
	| "unknown";

export type DeepResearchSourceIndependence =
	| "primary"
	| "independent"
	| "affiliated"
	| "community"
	| "unknown";

export type DeepResearchSourceFreshness =
	| "current"
	| "recent"
	| "dated"
	| "stale"
	| "undated"
	| "unknown";

export type DeepResearchSourceDirectness =
	| "direct"
	| "indirect"
	| "anecdotal"
	| "unknown";

export type DeepResearchExtractionConfidence = "high" | "medium" | "low";

export type DeepResearchClaimFit =
	| "strong"
	| "partial"
	| "weak"
	| "mismatch"
	| "unknown";

export type DeepResearchClaimType =
	| "official_specification"
	| "price_availability"
	| "reliability_experience"
	| "high_stakes"
	| "general";

export interface DeepResearchSourceQualitySignals {
	sourceType: DeepResearchSourceType;
	independence: DeepResearchSourceIndependence;
	freshness: DeepResearchSourceFreshness;
	directness: DeepResearchSourceDirectness;
	extractionConfidence: DeepResearchExtractionConfidence;
	claimFit: DeepResearchClaimFit;
}

export interface DeepResearchSourceAuthoritySummary {
	label: string;
	score: number;
	reasons: string[];
}

export interface DeepResearchSource {
	id: string;
	jobId: string;
	conversationId: string;
	userId?: string;
	status: DeepResearchSourceStatus;
	url: string;
	faviconUrl?: string | null;
	title?: string | null;
	provider: string;
	snippet?: string | null;
	sourceText?: string | null;
	reviewedNote?: string | null;
	citationNote?: string | null;
	relevanceScore?: number | null;
	rejectedReason?: string | null;
	topicRelevant?: boolean | null;
	topicRelevanceReason?: string | null;
	supportedKeyQuestions?: string[];
	intendedComparedEntity?: string | null;
	intendedComparisonAxis?: string | null;
	comparedEntity?: string | null;
	comparisonAxis?: string | null;
	extractedClaims?: string[];
	sourceQualitySignals?: DeepResearchSourceQualitySignals | null;
	sourceAuthoritySummary?: DeepResearchSourceAuthoritySummary | null;
	openedContentLength?: number;
	discoveredAt: string;
	reviewedAt: string | null;
	citedAt: string | null;
	createdAt?: string;
	updatedAt?: string;
}

export type DeepResearchTaskStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "skipped"
	| "cancelled";

export type DeepResearchTaskAssignmentType =
	| "coverage_gap"
	| "key_question"
	| "source_group"
	| "synthesis";

export type DeepResearchTaskFailureKind = "transient" | "permanent";

export interface DeepResearchTaskOutput {
	summary: string;
	findings?: string[];
	sourceIds?: string[];
	supportedKeyQuestion?: string | null;
	comparedEntity?: string | null;
	comparisonAxis?: string | null;
}

export interface DeepResearchTask {
	id: string;
	jobId: string;
	conversationId: string;
	userId?: string;
	passNumber: number;
	passOrder: number;
	status: DeepResearchTaskStatus;
	assignmentType: DeepResearchTaskAssignmentType;
	coverageGapId?: string | null;
	keyQuestion?: string | null;
	assignment: string;
	required: boolean;
	critical: boolean;
	claimToken?: string | null;
	output?: DeepResearchTaskOutput | null;
	failureKind?: DeepResearchTaskFailureKind | null;
	failureReason?: string | null;
	createdAt: string;
	updatedAt: string;
	claimedAt?: string | null;
	completedAt?: string | null;
	failedAt?: string | null;
	skippedAt?: string | null;
}

export type DeepResearchPassLifecycleState = "running" | "decided";

export type DeepResearchPassDecision =
	| "continue_research"
	| "synthesize_report"
	| "publish_report"
	| "publish_evidence_limitation_memo";

export type DeepResearchCoverageGapLifecycleState =
	| "open"
	| "in_progress"
	| "resolved"
	| "inherited";

export type DeepResearchCoverageGapSeverity =
	| "critical"
	| "important"
	| "minor";

export interface DeepResearchPassCheckpoint {
	id: string;
	jobId: string;
	conversationId: string;
	userId?: string;
	passNumber: number;
	lifecycleState: DeepResearchPassLifecycleState;
	searchIntent: string;
	reviewedSourceIds: string[];
	coverageResult?: Record<string, unknown> | null;
	coverageGapIds: string[];
	usageSummary?: Record<string, unknown> | null;
	nextDecision?: DeepResearchPassDecision | null;
	decisionSummary?: string | null;
	terminalDecision: boolean;
	startedAt: string;
	completedAt?: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface DeepResearchCoverageGap {
	id: string;
	jobId: string;
	conversationId: string;
	userId?: string;
	passCheckpointId: string;
	lifecycleState: DeepResearchCoverageGapLifecycleState;
	severity: DeepResearchCoverageGapSeverity;
	reason: string;
	keyQuestion?: string | null;
	comparedEntity?: string | null;
	comparisonAxis?: string | null;
	recommendedNextAction: string;
	detail?: string | null;
	reviewedSourceCount: number;
	resolvedByEvidence?: Record<string, unknown> | null;
	resolvedByClaims?: Record<string, unknown> | null;
	resolvedByLimitations?: Record<string, unknown> | null;
	resolutionSummary?: string | null;
	inheritedFromGapId?: string | null;
	createdAt: string;
	updatedAt: string;
	resolvedAt?: string | null;
}

export interface DeepResearchEvidenceNote {
	id: string;
	jobId: string;
	conversationId: string;
	userId?: string;
	passCheckpointId: string;
	passNumber: number;
	sourceId?: string | null;
	taskId?: string | null;
	supportedKeyQuestion?: string | null;
	comparedEntity?: string | null;
	comparisonAxis?: string | null;
	findingText: string;
	sourceSupport: Record<string, unknown>;
	sourceQualitySignals?: DeepResearchSourceQualitySignals | null;
	sourceAuthoritySummary?: DeepResearchSourceAuthoritySummary | null;
	createdAt: string;
	updatedAt: string;
}

export type DeepResearchSynthesisClaimStatus =
	| "accepted"
	| "limited"
	| "rejected"
	| "needs-repair";

export type DeepResearchClaimEvidenceRelation =
	| "support"
	| "qualification"
	| "contradiction";

export interface DeepResearchClaimEvidenceLink {
	id: string;
	claimId: string;
	evidenceNoteId: string;
	jobId: string;
	conversationId: string;
	userId?: string;
	relation: DeepResearchClaimEvidenceRelation;
	rationale?: string | null;
	material: boolean;
	createdAt: string;
}

export interface DeepResearchSynthesisClaim {
	id: string;
	jobId: string;
	conversationId: string;
	userId?: string;
	passCheckpointId?: string | null;
	synthesisPass?: string | null;
	planQuestion?: string | null;
	reportSection?: string | null;
	statement: string;
	claimType?: DeepResearchClaimType | null;
	central: boolean;
	status: DeepResearchSynthesisClaimStatus;
	statusReason?: string | null;
	competingClaimGroupId?: string | null;
	evidenceLinks: DeepResearchClaimEvidenceLink[];
	createdAt: string;
	updatedAt: string;
}

export type DeepResearchCitationAuditVerdictStatus =
	| "supported"
	| "partially_supported"
	| "unsupported"
	| "contradicted"
	| "needs_repair";

export interface DeepResearchCitationAuditVerdict {
	id: string;
	jobId: string;
	conversationId: string;
	userId?: string;
	claimId: string;
	verdict: DeepResearchCitationAuditVerdictStatus;
	evidenceNoteIds: string[];
	reason: string;
	createdAt: string;
	updatedAt: string;
}

export type DeepResearchResumePointBoundary =
	| "running_pass"
	| "research_task"
	| "synthesis"
	| "citation_audit"
	| "repair"
	| "report_assembly";

export type DeepResearchResumePointStatus =
	| "running"
	| "completed"
	| "failed"
	| "stale";

export interface DeepResearchResumePoint {
	id: string;
	jobId: string;
	conversationId: string;
	userId?: string;
	boundary: DeepResearchResumePointBoundary;
	resumeKey: string;
	status: DeepResearchResumePointStatus;
	stage: string;
	passNumber?: number | null;
	taskId?: string | null;
	payload?: Record<string, unknown> | null;
	result?: Record<string, unknown> | null;
	startedAt: string;
	completedAt?: string | null;
	expiresAt?: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface DeepResearchTimelineEvent {
	id: string;
	jobId?: string;
	conversationId?: string;
	taskId?: string | null;
	stage: string;
	kind: string;
	occurredAt: string;
	messageKey: string;
	messageParams: Record<string, string | number | boolean | null>;
	sourceCounts: DeepResearchSourceCounts;
	assumptions: string[];
	warnings: string[];
	summary: string;
	createdAt?: string;
}

export interface DeepResearchUsageSummary {
	totalCostUsdMicros: number;
	totalTokens: number;
	byModel: Array<{
		modelId: string;
		modelDisplayName: string | null;
		providerId: string | null;
		providerDisplayName: string | null;
		costUsdMicros: number;
		totalTokens: number;
		operationCount: number;
	}>;
}

export interface DeepResearchRuntimeEstimate {
	label: string;
	source: "fallback" | "calibrated";
	actualRuntimeMs?: number;
}

export type DeepResearchMemoRecoveryActionKind =
	| "revise_plan"
	| "add_sources"
	| "choose_deeper_depth"
	| "targeted_follow_up";

export interface DeepResearchMemoRecoveryAction {
	kind: DeepResearchMemoRecoveryActionKind;
	label: string;
	description: string;
}

export interface DeepResearchEvidenceLimitationMemo {
	title: string;
	reviewedScope: {
		discoveredCount: number;
		reviewedCount: number;
		topicRelevantCount: number;
		rejectedOrOffTopicCount: number;
	};
	limitations: string[];
	nextResearchDirection: string;
	recoveryActions: DeepResearchMemoRecoveryAction[];
}

export interface DeepResearchJob {
	id: string;
	conversationId: string;
	triggerMessageId: string | null;
	depth: DeepResearchDepth;
	status: DeepResearchJobStatus;
	stage: string | null;
	title: string;
	userRequest?: string;
	reportArtifactId?: string | null;
	plan?: DeepResearchPlanSummary | null;
	currentPlan?: DeepResearchPlanSummary | null;
	timeline?: DeepResearchTimelineEvent[];
	passCheckpoints?: DeepResearchPassCheckpoint[];
	coverageGaps?: DeepResearchCoverageGap[];
	evidenceNotes?: DeepResearchEvidenceNote[];
	synthesisClaims?: DeepResearchSynthesisClaim[];
	resumePoints?: DeepResearchResumePoint[];
	sourceCounts?: DeepResearchSourceCounts;
	sources?: DeepResearchSource[];
	evidenceLimitationMemo?: DeepResearchEvidenceLimitationMemo | null;
	usageSummary?: DeepResearchUsageSummary;
	runtimeEstimate?: DeepResearchRuntimeEstimate;
	createdAt: number;
	updatedAt: number;
	completedAt?: number | null;
	cancelledAt?: number | null;
}

export interface DeepResearchReportActionResult {
	sourceJobId: string;
	reportArtifactId: string;
	conversation: Conversation;
	messageId?: string;
	seedMessage?: string;
	researchLanguage?: "en" | "hu";
}

export interface DeepResearchResearchFurtherActionResult
	extends DeepResearchReportActionResult {
	job: DeepResearchJob;
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

export type FileProductionJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

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
	error?: {
		code: string;
		message: string;
		retryable: boolean;
	} | null;
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
	deepResearchJobs?: DeepResearchJob[];
	totalCostUsdMicros?: number;
	totalTokens?: number;
}

// ConversationListItem interface: id, title, updatedAt
export interface ConversationListItem {
	id: string;
	title: string;
	updatedAt: number; // Unix timestamp
	projectId?: string | null;
}

// MessageRole type: 'user' | 'assistant'
export type MessageRole = "user" | "assistant";

export type EvidenceSourceType = "web" | "document" | "memory" | "tool";

export interface ToolEvidenceCandidate {
	id: string;
	title: string;
	url?: string | null;
	snippet?: string | null;
	sourceType: EvidenceSourceType;
}

export interface ToolCallEntry {
	name: string;
	input: Record<string, unknown>;
	status: "running" | "done";
	outputSummary?: string | null;
	sourceType?: EvidenceSourceType | null;
	candidates?: ToolEvidenceCandidate[];
}

export type ThinkingSegment =
	| { type: "text"; content: string }
	| {
			type: "tool_call";
			name: string;
			input: Record<string, unknown>;
			status: "running" | "done";
			outputSummary?: string | null;
			sourceType?: EvidenceSourceType | null;
			candidates?: ToolEvidenceCandidate[];
	  };

export type MessageEvidenceStatus = "selected" | "rejected" | "reference";

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
	// Total generation duration in milliseconds (assistant messages only)
	generationDurationMs?: number;
	// Estimated cost in USD for this response (from usage_events, assistant messages only)
	costUsd?: number;
	evidenceSummary?: MessageEvidenceSummary;
	webCitationAudit?: WebCitationAudit;
	evidencePending?: boolean;
	honchoContext?: HonchoContextInfo;
}

export type ArtifactType =
	| "source_document"
	| "normalized_document"
	| "generated_output"
	| "work_capsule";

export type ArtifactRetrievalClass =
	| "durable"
	| "ephemeral_followup"
	| "archived_duplicate";

export type ArtifactLinkType =
	| "attached_to_conversation"
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
	displayArtifactId: string;
	promptArtifactId: string | null;
	familyArtifactIds: string[];
	name: string;
	mimeType: string | null;
	sizeBytes: number | null;
	conversationId: string | null;
	summary: string | null;
	normalizedAvailable: boolean;
	documentOrigin?: "uploaded" | "generated";
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

export interface PendingAttachment {
	artifact: ArtifactSummary;
	promptReady: boolean;
	promptArtifactId?: string | null;
	readinessError?: string | null;
}

export interface ConversationDraft {
	conversationId: string;
	draftText: string;
	selectedAttachmentIds: string[];
	selectedAttachments: PendingAttachment[];
	updatedAt: number;
}

export interface KnowledgeUploadResponse {
	artifact: ArtifactSummary;
	normalizedArtifact: ArtifactSummary | null;
	reusedExistingArtifact: boolean;
	honcho: {
		uploaded: boolean;
		mode: "native" | "normalized" | "none";
	};
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
	| "persona_cluster"
	| "task_state";

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
	| "working_set"
	| "task_evidence"
	| "pinned"
	| "excluded"
	| "memory"
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

export type HonchoContextSource = "live" | "snapshot" | "persisted_fallback";

export type HonchoFallbackReason =
	| "timeout"
	| "queue_timeout"
	| "context_error"
	| "empty_live_context";

export interface HonchoContextInfo {
	source: HonchoContextSource;
	waitedMs: number;
	queuePendingWorkUnits: number;
	queueInProgressWorkUnits: number;
	fallbackReason: HonchoFallbackReason | null;
	snapshotCreatedAt: number | null;
}

export interface HonchoSnapshotMessage {
	role: MessageRole;
	content: string;
	createdAt: number;
}

export interface HonchoContextSnapshot {
	createdAt: number;
	summary: string | null;
	messages: HonchoSnapshotMessage[];
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
	honcho?: HonchoContextInfo | null;
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
	| "document";
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
	| "document_superseded";

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

export type KnowledgeMemoryOverviewSource =
	| "honcho_live"
	| "honcho_scoped"
	| "honcho_cache"
	| "persona_fallback"
	| null;

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
	overviewSource: KnowledgeMemoryOverviewSource;
	overviewStatus: KnowledgeMemoryOverviewStatus;
	overviewUpdatedAt: number | null;
	overviewLastAttemptAt: number | null;
	durablePersonaCount: number;
}

export interface KnowledgeMemoryPayload {
	personaMemories: PersonaMemoryItem[];
	activeConstraints?: PersonaMemoryItem[];
	currentProjectContext?: PersonaMemoryItem[];
	taskMemories: TaskMemoryItem[];
	focusContinuities: FocusContinuityItem[];
	summary: KnowledgeMemorySummary;
}

export interface KnowledgeMemoryOverviewPayload {
	summary: KnowledgeMemorySummary;
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

// Langflow types
export interface LangflowMessage {
	text: string;
}

export interface LangflowRunRequest {
	input_value: string;
	input_type: string;
	output_type: string;
	session_id?: string;
	background_color?: string;
	background_icon?: string;
}

export interface LangflowRunResponse {
	outputs: Array<{
		outputs: Array<{
			results: {
				message?: LangflowMessage;
				[key: string]: any;
			};
			[key: string]: any;
		}>;
		[key: string]: any;
	}>;
}

// Webhook types
export interface WebhookSentencePayload {
	session_id: string;
	sentence?: string;
	index: number;
	is_final: boolean;
}
