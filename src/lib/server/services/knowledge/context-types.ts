// Conversation context status, Context Sources UI state, and the Context
// Debug panel contract — owned by knowledge/context.ts (relevant-artifact
// lookup, working-set/context status operations, context-related reads and
// writes used during chat). Relocated out of the former src/lib/types.ts
// god-module (architecture-deepening T1); this file carries no behavior
// change, only a new home.

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
	pinnedEvidence: ContextDebugEvidenceItem[];
	excludedEvidence: ContextDebugEvidenceItem[];
	forkProvenance?: ForkContextProvenanceSummary | null;
}
