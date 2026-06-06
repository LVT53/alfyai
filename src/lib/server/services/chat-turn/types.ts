import type { ProviderUsageSnapshot } from "$lib/server/services/analytics";
import type { LegacyContextTraceSectionInput } from "$lib/server/services/chat-turn/context-trace";
import type {
	ContextDebugState,
	ConversationContextStatus,
	DeepResearchDepth,
	HonchoContextInfo,
	HonchoContextSnapshot,
	LinkedContextSource,
	ModelId,
	PendingSkillSelection,
	ReasoningDepth,
	DepthMetadata,
	TaskState,
	ThinkingMode,
	ToolCallEntry,
	WebCitationAudit,
} from "$lib/types";

export type ChatTurnRoute = "send" | "stream";

export type ChatTurnRequestError = {
	status: number;
	error: string;
	code?: string;
	attachmentIds?: string[];
};

export type ParsedChatTurnRequest = {
	conversationId: string;
	normalizedMessage: string;
	streamId?: string;
	reconnectToStreamId?: string;
	modelId: ModelId | undefined;
	modelDisplayName: string;
	providerDisplayName?: string;
	attachmentIds: string[];
	linkedSources: LinkedContextSource[];
	pendingSkill: PendingSkillSelection | null;
	activeDocumentArtifactId?: string;
	personalityProfileId?: string;
	deepResearchDepth?: DeepResearchDepth;
	reasoningDepth: ReasoningDepth;
	thinkingMode: ThinkingMode;
	forceWebSearch: boolean;
	skipPersistUserMessage: boolean;
	attachmentTraceId?: string;
};

export interface SkillPromptLinkedSource {
	displayArtifactId: string;
	promptArtifactId: string | null;
	familyArtifactIds: string[];
	name: string;
	type: "document";
	mimeType?: string | null;
	documentOrigin?: LinkedContextSource["documentOrigin"];
}

export interface SkillPromptResource {
	id: string;
	title: string;
	kind: "guidance" | "domain_template";
	summary: string;
	whenToUse: string;
	content: string;
	inclusionReason: "always" | "matched_request";
}

export interface SkillPromptContext {
	source: "pending_skill" | "active_session";
	sessionId?: string;
	sessionStatus?: "active" | "paused";
	skillId: string;
	skillOwnership: "user" | "system";
	skillKind: "user_skill" | "skill_pack" | "skill_variant";
	skillDisplayName: string;
	skillDescription: string;
	skillInstructions: string;
	durationPolicy: "next_message" | "session";
	questionPolicy: "none" | "ask_when_needed";
	notesPolicy: "none" | "create_private_notes";
	sourceScope: "current_conversation" | "selected_sources_only";
	skillVersion: number;
	packSkillId?: string | null;
	packSkillVersion?: number | null;
	variantSkillId?: string | null;
	variantSkillVersion?: number | null;
	effectiveInstructionsHash?: string | null;
	skillResources?: SkillPromptResource[];
	linkedSources: SkillPromptLinkedSource[];
}

export type PreflightedChatTurn = ParsedChatTurnRequest & {
	depthMetadata: DepthMetadata;
	skillPromptContext?: SkillPromptContext | null;
};
export type ChatTurnPreflight = PreflightedChatTurn;

export type WorkingSetItem = {
	id: string;
	type: string;
	name: string;
	mimeType: string | null;
	sizeBytes: number | null;
	conversationId: string | null;
	summary: string | null;
	createdAt: number;
	updatedAt: number;
};

export type WorkCapsuleSummary =
	| {
			workflowSummary: string | null;
			taskSummary: string | null;
			artifact: { name: string };
	  }
	| null
	| undefined;

export type AssistantAnalytics = {
	model: string;
	modelDisplayName?: string | null;
	promptTokens?: number;
	completionTokens?: number;
	reasoningTokens?: number;
	generationTimeMs?: number;
	providerUsage?: ProviderUsageSnapshot | null;
};

export type PersistAssistantTurnStateParams = {
	userId: string;
	conversationId: string;
	normalizedMessage: string;
	assistantResponse: string;
	attachmentIds: string[];
	activeDocumentArtifactId?: string;
	contextStatus?: ConversationContextStatus | null;
	initialTaskState?: TaskState | null;
	initialContextDebug?: ContextDebugState | null;
	honchoContext?: HonchoContextInfo | null;
	honchoSnapshot?: HonchoContextSnapshot | null;
	userMessageId?: string | null;
	assistantMessageId: string;
	analytics?: AssistantAnalytics | null;
	continuitySource: "send" | "stream";
};

export type PersistAssistantTurnStateResult = {
	activeWorkingSet: WorkingSetItem[] | undefined;
	taskState: TaskState | null | undefined;
	contextDebug: ContextDebugState | null | undefined;
	workCapsule: WorkCapsuleSummary;
};

export type PersistAssistantEvidenceParams = {
	logPrefix: "[SEND]" | "[STREAM]";
	userId: string;
	conversationId: string;
	assistantMessageId: string;
	normalizedMessage: string;
	assistantResponse: string;
	attachmentIds: string[];
	taskState?: TaskState | null;
	contextStatus?: ConversationContextStatus | null;
	contextDebug?: ContextDebugState | null;
	initialTaskState?: TaskState | null;
	initialContextDebug?: ContextDebugState | null;
	contextTraceSections?: LegacyContextTraceSectionInput[];
	toolCalls?: ToolCallEntry[];
	webCitationAudit?: WebCitationAudit | null;
};

export type RunPostTurnTasksParams = {
	logPrefix: "[SEND]" | "[STREAM]";
	userId: string;
	conversationId: string;
	upstreamMessage: string;
	userMessage: string;
	assistantResponse: string;
	assistantMirrorContent?: string;
	workCapsule?: WorkCapsuleSummary;
	maintenanceReason: "chat_send" | "chat_stream";
};
