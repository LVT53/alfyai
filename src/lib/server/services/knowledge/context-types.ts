// Conversation context status and the Context Debug panel contract — owned by
// knowledge/context.ts (relevant-artifact lookup, working-set/context status
// operations, context-related reads and writes used during chat). Relocated
// out of the former src/lib/types.ts god-module (architecture-deepening T1);
// this file carries no behavior change, only a new home.

import type { ForkContextProvenanceSummary } from "$lib/server/services/conversation-forks";
import type {
	ArtifactType,
	MemoryLayer,
} from "$lib/server/services/knowledge/types";
import type { EvidenceSourceType } from "$lib/server/services/message-evidence";
import type {
	CompactionMode,
	RoutingStage,
	TaskEvidenceOrigin,
	TaskEvidenceRole,
	VerificationStatus,
} from "$lib/server/services/task-state/types";

export type ContextPromptTokensSource = "provider" | "estimated";

export interface ConversationContextStatus {
	conversationId: string;
	userId: string;
	// Pre-request packet estimate (user-message packet only); drives the
	// compaction logic together with targetTokens/thresholdTokens.
	estimatedTokens: number;
	// Best-known prompt size for the last completed turn against
	// maxContextTokens (the model's real context window). "provider" when the
	// provider reported input tokens, "estimated" otherwise.
	promptTokens: number;
	promptTokensSource: ContextPromptTokensSource;
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

export interface ContextDebugState {
	activeTaskId: string | null;
	activeTaskObjective: string | null;
	taskLocked: boolean;
	routingStage: RoutingStage;
	routingConfidence: number;
	verificationStatus: VerificationStatus;
	selectedEvidence: ContextDebugEvidenceItem[];
	selectedEvidenceBySource: ContextDebugEvidenceSummaryItem[];
	forkProvenance?: ForkContextProvenanceSummary | null;
}
