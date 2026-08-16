import type { ModelId } from "$lib/model-types";
import type { ReasoningDepth, ThinkingMode } from "$lib/reasoning-depth-types";
import type { ProviderUsageSnapshot } from "$lib/server/services/analytics";
import type {
	AtlasAction,
	AtlasProfile,
} from "$lib/server/services/atlas/public-types";
import type { LegacyContextTraceSectionInput } from "$lib/server/services/chat-turn/context-trace";
import type { DepthMetadata } from "$lib/server/services/chat-turn/depth-metadata-types";
import type {
	ContextDebugState,
	ConversationContextStatus,
} from "$lib/server/services/knowledge/context-types";
import type { LinkedContextSource } from "$lib/server/services/linked-context-sources";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import type { PendingSkillSelection } from "$lib/server/services/skills/types";
import type { TaskState } from "$lib/server/services/task-state/types";
import type { WebCitationAudit } from "$lib/server/services/web-citation-audit";

export type ChatTurnRoute = "send" | "stream";

// The turn kinds that actually exist (F1) — reused as the discriminant for
// Normal Chat Turn Completion (chat-turn/finalize.ts) so completion logging
// derives its display prefix from the same "send" | "stream" concept the
// request-parsing route already uses, instead of threading a caller-chosen
// logPrefix string through the module.
export function turnLogPrefix(kind: ChatTurnRoute): "[SEND]" | "[STREAM]" {
	return kind === "stream" ? "[STREAM]" : "[SEND]";
}

export type {
	AtlasAction,
	AtlasProfile,
} from "$lib/server/services/atlas/public-types";

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
	reasoningDepth: ReasoningDepth;
	thinkingMode: ThinkingMode;
	forceWebSearch: boolean;
	// Issue 7.2 — per-turn connection capability selection from the composer.
	// undefined = the client didn't send a selection (older client, or none
	// made yet): the model-run resolver falls back to the defaultOn set.
	// A defined array (including []) is a fail-closed request to narrow the
	// server's served-capabilities set to this list — see
	// resolveActiveCapabilities in connections/resolve.ts.
	enabledConnectionCapabilities?: string[];
	skipPersistUserMessage: boolean;
	attachmentTraceId?: string;
	atlasMode: boolean;
	atlasProfile: AtlasProfile | null;
	atlasAction: AtlasAction;
	parentAtlasId: string | null;
	clientAtlasTurnId: string | null;
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

declare const admittedChatTurnBrand: unique symbol;

export type AdmittedChatTurn = ParsedChatTurnRequest & {
	readonly [admittedChatTurnBrand]: "admitted-chat-turn";
};

export type ChatTurnAdmissionResult =
	| { ok: true; value: AdmittedChatTurn }
	| { ok: false; error: ChatTurnRequestError };

export type ChatTurnPreparationResult =
	| { ok: true; value: PreflightedChatTurn }
	| { ok: false; error: ChatTurnRequestError };

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
	// ADR-0042 amendment — server stream-timeline marks (ms elapsed since turn
	// start, server-side only). Optional/absent when the turn never reached
	// that phase (no reasoning, stopped early, etc).
	firstByteMs?: number;
	firstThinkingMs?: number;
	firstTokenMs?: number;
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
	userMessageId?: string | null;
	assistantMessageId: string;
	analytics?: AssistantAnalytics | null;
};

export type PersistAssistantTurnStateResult = {
	activeWorkingSet: WorkingSetItem[] | undefined;
	taskState: TaskState | null | undefined;
	contextDebug: ContextDebugState | null | undefined;
	workCapsule: WorkCapsuleSummary;
};

export type PersistAssistantEvidenceParams = {
	turnKind: ChatTurnRoute;
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
	turnKind: ChatTurnRoute;
	userId: string;
	conversationId: string;
	upstreamMessage: string;
	userMessage: string;
	userMessageId?: string | null;
	assistantResponse: string;
	assistantMirrorContent?: string;
	assistantMessageId?: string | null;
	workCapsule?: WorkCapsuleSummary;
	maintenanceReason: "chat_send" | "chat_stream";
	startedResetGeneration?: number;
	skipAssistantProseMemoryIntake?: boolean;
};
